ALTER TABLE "KnowledgeBudgetReservation"
  DROP CONSTRAINT "KnowledgeBudgetReservation_request_check";

ALTER TABLE "KnowledgeBudgetReservation"
  ADD CONSTRAINT "KnowledgeBudgetReservation_request_check" CHECK (
    "operationOrdinal" BETWEEN 1 AND 256
    AND "phaseOrdinal" BETWEEN 0 AND 63
    AND "subqueryOrdinal" BETWEEN 0 AND 127
    AND "operation" IN (
      'automatic_search',
      'discover_sources',
      'find_exact',
      'read_source',
      'search_knowledge',
      'structured_analysis',
      'visual_analysis'
    )
    AND "policyVersion" >= 1
    AND ((
      (
        "purgedAt" IS NULL
        AND "idempotencyKey" IS NOT NULL
        AND "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
        AND "operationRequestHash" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("operationRequest") = 'object'
        AND pg_column_size("operationRequest") <= 65536
        AND ("operationRequest" ->> 'version') = '2'
        AND ("operationRequest" ->> 'reservationId') = "id"
        AND ("operationRequest" ->> 'idempotencyKey') = "idempotencyKey"
        AND ("operationRequest" ->> 'operation') = "operation"
        AND ("operationRequest" ->> 'phaseOrdinal') = "phaseOrdinal"::text
        AND ("operationRequest" ->> 'subqueryOrdinal') = "subqueryOrdinal"::text
      )
      OR (
        "purgedAt" IS NOT NULL
        AND "purgedAt" >= "createdAt"
        AND "idempotencyKey" IS NULL
        AND "operationRequest" IS NULL
        AND "operationRequestHash" IS NULL
        AND "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL
        AND "dispatchAttemptKey" IS NULL
        AND "receiptHash" IS NULL
        AND "failureCode" IS NULL
      )
    )) IS TRUE
  ) NOT VALID;

ALTER TABLE "KnowledgeBudgetReservation"
  VALIDATE CONSTRAINT "KnowledgeBudgetReservation_request_check";

-- KnowledgeRun.readReceipt is the existing bounded JSON receipt slot. H3 uses
-- it for purpose-specific deterministic and analysis receipts; each branch is
-- tied back to the run's operation, result/count, and ranking columns.
CREATE FUNCTION "knowledge_jsonb_has_exact_keys"(value JSONB, required_keys TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  key_count INTEGER;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  SELECT count(*)::INTEGER INTO key_count FROM jsonb_object_keys(value);
  RETURN key_count = cardinality(required_keys)
    AND (value - required_keys) = '{}'::jsonb;
END
$function$;

CREATE FUNCTION "knowledge_exact_receipt_valid"("runQuery" TEXT, receipt JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  item JSONB;
  item_ordinal INTEGER;
  seen_ordinals INTEGER[] := ARRAY[]::INTEGER[];
BEGIN
  IF NOT "knowledge_jsonb_has_exact_keys"(receipt, ARRAY[
      'caseMode', 'cursor', 'field', 'limit', 'match', 'matches',
      'nextCursor', 'scannedBytes', 'scanTruncated', 'value', 'version'
    ]::text[])
    OR pg_column_size(receipt) > 32768
    OR receipt -> 'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(receipt -> 'caseMode') IS DISTINCT FROM 'string'
    OR receipt ->> 'caseMode' NOT IN ('insensitive', 'sensitive')
    OR jsonb_typeof(receipt -> 'field') IS DISTINCT FROM 'string'
    OR receipt ->> 'field' NOT IN ('any', 'body', 'filename', 'heading', 'tag', 'title')
    OR jsonb_typeof(receipt -> 'match') IS DISTINCT FROM 'string'
    OR receipt ->> 'match' NOT IN ('pattern', 'phrase', 'token')
    OR jsonb_typeof(receipt -> 'value') IS DISTINCT FROM 'string'
    OR char_length(receipt ->> 'value') NOT BETWEEN 1 AND 500
    OR "runQuery" IS DISTINCT FROM receipt ->> 'value'
    OR jsonb_typeof(receipt -> 'limit') IS DISTINCT FROM 'number'
    OR receipt ->> 'limit' !~ '^(?:[1-9]|[1-9][0-9]|100)$'
    OR jsonb_typeof(receipt -> 'scannedBytes') IS DISTINCT FROM 'number'
    OR receipt ->> 'scannedBytes' !~ '^(?:0|[1-9][0-9]{0,6})$'
    OR (receipt ->> 'scannedBytes')::INTEGER > 4194304
    OR jsonb_typeof(receipt -> 'scanTruncated') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(receipt -> 'matches') IS DISTINCT FROM 'array'
    OR jsonb_array_length(receipt -> 'matches') > 100
  THEN
    RETURN false;
  END IF;
  IF receipt -> 'cursor' <> 'null'::jsonb AND (
    jsonb_typeof(receipt -> 'cursor') IS DISTINCT FROM 'string'
    OR char_length(receipt ->> 'cursor') NOT BETWEEN 1 AND 64
    OR receipt ->> 'cursor' !~ '^[A-Za-z0-9_-]+$'
  ) THEN
    RETURN false;
  END IF;
  IF receipt -> 'nextCursor' <> 'null'::jsonb AND (
    jsonb_typeof(receipt -> 'nextCursor') IS DISTINCT FROM 'string'
    OR char_length(receipt ->> 'nextCursor') NOT BETWEEN 1 AND 64
    OR receipt ->> 'nextCursor' !~ '^[A-Za-z0-9_-]+$'
  ) THEN
    RETURN false;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(receipt -> 'matches') LOOP
    IF NOT "knowledge_jsonb_has_exact_keys"(
        item,
        ARRAY['field', 'resultOrdinal']::text[]
      )
      OR jsonb_typeof(item -> 'field') IS DISTINCT FROM 'string'
      OR item ->> 'field' NOT IN ('body', 'filename', 'heading', 'tag', 'title')
      OR jsonb_typeof(item -> 'resultOrdinal') IS DISTINCT FROM 'number'
      OR item ->> 'resultOrdinal' !~ '^(?:0|[1-9][0-9]?)$'
    THEN
      RETURN false;
    END IF;
    item_ordinal := (item ->> 'resultOrdinal')::INTEGER;
    IF item_ordinal <> cardinality(seen_ordinals)
      OR array_position(seen_ordinals, item_ordinal) IS NOT NULL
      OR (receipt ->> 'field' <> 'any' AND item ->> 'field' <> receipt ->> 'field')
    THEN
      RETURN false;
    END IF;
    seen_ordinals := array_append(seen_ordinals, item_ordinal);
  END LOOP;
  RETURN jsonb_array_length(receipt -> 'matches') <= (receipt ->> 'limit')::INTEGER;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

CREATE FUNCTION "knowledge_discovery_receipt_valid"("runQuery" TEXT, receipt JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  field_item JSONB;
  field_name TEXT;
  field_rank INTEGER;
  previous_rank INTEGER := 0;
  requested_fields TEXT[] := ARRAY[]::TEXT[];
  matched_fields TEXT[];
  source_item JSONB;
  source_aliases TEXT[] := ARRAY[]::TEXT[];
  source_version BIGINT;
BEGIN
  IF NOT "knowledge_jsonb_has_exact_keys"(receipt, ARRAY[
      'cursor', 'fields', 'limit', 'nextCursor', 'query', 'sources', 'version'
    ]::text[])
    OR pg_column_size(receipt) > 262144
    OR receipt -> 'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(receipt -> 'query') IS DISTINCT FROM 'string'
    OR char_length(receipt ->> 'query') NOT BETWEEN 2 AND 500
    OR "runQuery" IS DISTINCT FROM receipt ->> 'query'
    OR jsonb_typeof(receipt -> 'limit') IS DISTINCT FROM 'number'
    OR receipt ->> 'limit' !~ '^(?:[1-9]|[1-9][0-9]|100)$'
    OR jsonb_typeof(receipt -> 'fields') IS DISTINCT FROM 'array'
    OR jsonb_array_length(receipt -> 'fields') NOT BETWEEN 1 AND 5
    OR jsonb_typeof(receipt -> 'sources') IS DISTINCT FROM 'array'
    OR jsonb_array_length(receipt -> 'sources') > 100
  THEN
    RETURN false;
  END IF;
  IF receipt -> 'cursor' <> 'null'::jsonb AND (
    jsonb_typeof(receipt -> 'cursor') IS DISTINCT FROM 'string'
    OR char_length(receipt ->> 'cursor') NOT BETWEEN 1 AND 64
    OR receipt ->> 'cursor' !~ '^[A-Za-z0-9_-]+$'
  ) THEN
    RETURN false;
  END IF;
  IF receipt -> 'nextCursor' <> 'null'::jsonb AND (
    jsonb_typeof(receipt -> 'nextCursor') IS DISTINCT FROM 'string'
    OR char_length(receipt ->> 'nextCursor') NOT BETWEEN 1 AND 64
    OR receipt ->> 'nextCursor' !~ '^[A-Za-z0-9_-]+$'
  ) THEN
    RETURN false;
  END IF;
  FOR field_item IN SELECT value FROM jsonb_array_elements(receipt -> 'fields') LOOP
    IF jsonb_typeof(field_item) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    field_name := field_item #>> '{}';
    field_rank := CASE field_name
      WHEN 'filename' THEN 1
      WHEN 'heading' THEN 2
      WHEN 'source_name' THEN 3
      WHEN 'tag' THEN 4
      WHEN 'title' THEN 5
      ELSE 0
    END;
    IF field_rank <= previous_rank OR array_position(requested_fields, field_name) IS NOT NULL THEN
      RETURN false;
    END IF;
    previous_rank := field_rank;
    requested_fields := array_append(requested_fields, field_name);
  END LOOP;
  IF jsonb_array_length(receipt -> 'sources') > (receipt ->> 'limit')::INTEGER THEN
    RETURN false;
  END IF;
  FOR source_item IN SELECT value FROM jsonb_array_elements(receipt -> 'sources') LOOP
    IF NOT "knowledge_jsonb_has_exact_keys"(source_item, ARRAY[
        'ambiguous', 'fileName', 'matchedFields', 'readiness', 'sourceAlias',
        'sourceName', 'sourceVersionNumber'
      ]::text[])
      OR jsonb_typeof(source_item -> 'ambiguous') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(source_item -> 'fileName') IS DISTINCT FROM 'string'
      OR char_length(source_item ->> 'fileName') NOT BETWEEN 1 AND 1024
      OR jsonb_typeof(source_item -> 'sourceName') IS DISTINCT FROM 'string'
      OR char_length(source_item ->> 'sourceName') NOT BETWEEN 1 AND 1024
      OR jsonb_typeof(source_item -> 'sourceAlias') IS DISTINCT FROM 'string'
      OR source_item ->> 'sourceAlias' !~ '^S[1-9][0-9]{0,2}$'
      OR jsonb_typeof(source_item -> 'readiness') IS DISTINCT FROM 'string'
      OR source_item ->> 'readiness' IS DISTINCT FROM 'ready'
      OR jsonb_typeof(source_item -> 'sourceVersionNumber') IS DISTINCT FROM 'number'
      OR source_item ->> 'sourceVersionNumber' !~ '^[1-9][0-9]{0,9}$'
      OR jsonb_typeof(source_item -> 'matchedFields') IS DISTINCT FROM 'array'
      OR jsonb_array_length(source_item -> 'matchedFields') NOT BETWEEN 1 AND 5
    THEN
      RETURN false;
    END IF;
    source_version := (source_item ->> 'sourceVersionNumber')::BIGINT;
    IF source_version > 2147483647
      OR array_position(source_aliases, source_item ->> 'sourceAlias') IS NOT NULL
    THEN
      RETURN false;
    END IF;
    source_aliases := array_append(source_aliases, source_item ->> 'sourceAlias');
    matched_fields := ARRAY[]::TEXT[];
    previous_rank := 0;
    FOR field_item IN SELECT value FROM jsonb_array_elements(source_item -> 'matchedFields') LOOP
      IF jsonb_typeof(field_item) IS DISTINCT FROM 'string' THEN
        RETURN false;
      END IF;
      field_name := field_item #>> '{}';
      field_rank := CASE field_name
        WHEN 'filename' THEN 1
        WHEN 'heading' THEN 2
        WHEN 'source_name' THEN 3
        WHEN 'tag' THEN 4
        WHEN 'title' THEN 5
        ELSE 0
      END;
      IF field_rank <= previous_rank
        OR array_position(requested_fields, field_name) IS NULL
        OR array_position(matched_fields, field_name) IS NOT NULL
      THEN
        RETURN false;
      END IF;
      previous_rank := field_rank;
      matched_fields := array_append(matched_fields, field_name);
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

CREATE FUNCTION "knowledge_structured_receipt_valid"(receipt JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
BEGIN
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
    OR pg_column_size(receipt) > 4096
    OR receipt -> 'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(receipt -> 'status') IS DISTINCT FROM 'string'
  THEN
    RETURN false;
  END IF;
  CASE receipt ->> 'status'
    WHEN 'complete' THEN
      RETURN "knowledge_jsonb_has_exact_keys"(
        receipt,
        ARRAY['status', 'version']::text[]
      );
    WHEN 'needs_clarification' THEN
      RETURN "knowledge_jsonb_has_exact_keys"(
          receipt,
          ARRAY['question', 'status', 'version']::text[]
        )
        AND jsonb_typeof(receipt -> 'question') IS NOT DISTINCT FROM 'string'
        AND char_length(receipt ->> 'question') BETWEEN 1 AND 2000;
    ELSE
      RETURN false;
  END CASE;
END
$function$;

CREATE FUNCTION "knowledge_visual_receipt_valid"(receipt JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT
    "knowledge_jsonb_has_exact_keys"(
      receipt,
      ARRAY['status', 'version']::text[]
    )
    AND pg_column_size(receipt) <= 4096
    AND receipt -> 'version' IS NOT DISTINCT FROM '1'::jsonb
    AND jsonb_typeof(receipt -> 'status') IS NOT DISTINCT FROM 'string'
    AND receipt ->> 'status' IN ('available', 'unavailable')
$function$;

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_evidence_shape_check";

-- Privacy tombstoning clears the purpose receipt but preserves the immutable
-- operation, so exact/discovery limits and outcomes must remain operation-owned.
ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_evidence_shape_check" CHECK (
    jsonb_typeof("baseEvidence") = 'array'
    AND jsonb_array_length("baseEvidence") BETWEEN 1 AND 3
    AND jsonb_typeof("results") = 'array'
    AND jsonb_array_length("results") <= CASE
      WHEN "operation" IN ('find_exact', 'discover_sources') THEN 100
      ELSE 8
    END
    AND jsonb_typeof("embeddingUsage") = 'array'
    AND jsonb_array_length("embeddingUsage") <= 3
    AND octet_length("providerText") BETWEEN 1 AND 49152
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_evidence_shape_check";

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_limits_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_limits_check" CHECK (
    "invocationOrdinal" BETWEEN 1 AND 256
    AND "candidateLimit" BETWEEN 1 AND 100
    AND "resultLimit" BETWEEN 1 AND CASE
      WHEN "operation" IN ('find_exact', 'discover_sources') THEN 100
      ELSE 8
    END
    AND "candidateLimit" >= "resultLimit"
    AND "candidateCount" >= 0
    AND "threshold" BETWEEN 0::double precision AND 1::double precision
    AND "durationMs" >= 0
    AND CASE
      WHEN "operation" IN ('find_exact', 'discover_sources')
        THEN "fusion" = 'none' AND "threshold" = 0
      ELSE "fusion" IN ('rrf_k60', 'weighted_rrf_v2')
    END
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_limits_check";

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_negative_outcome_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_negative_outcome_check" CHECK (
    CASE "outcome"
      WHEN 'base_empty' THEN "candidateCount" = 0
      WHEN 'zero_above_threshold' THEN CASE
        WHEN "operation" IN ('find_exact', 'discover_sources')
          THEN "candidateCount" = 0
        ELSE "candidateCount" > 0
      END
      ELSE true
    END
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_negative_outcome_check";

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_outcome_shape_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_outcome_shape_check" CHECK (
    CASE
      WHEN "operation" = 'discover_sources' THEN
        jsonb_array_length("results") = 0
        AND CASE "outcome"
          WHEN 'complete' THEN "candidateCount" > 0
          WHEN 'zero_above_threshold' THEN "candidateCount" = 0
          ELSE true
        END
      WHEN "operation" = 'find_exact' THEN
        CASE "outcome"
          WHEN 'complete' THEN
            "candidateCount" > 0
            AND jsonb_array_length("results") BETWEEN 1 AND "resultLimit"
          ELSE jsonb_array_length("results") = 0
        END
      WHEN "outcome" = 'complete' THEN
        jsonb_array_length("results") BETWEEN 1 AND 8
      ELSE jsonb_array_length("results") = 0
    END
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_outcome_shape_check";

ALTER TABLE "KnowledgeRunEvidence"
  DROP CONSTRAINT "KnowledgeRunEvidence_result_ordinal_check";

ALTER TABLE "KnowledgeRunEvidence"
  ADD CONSTRAINT "KnowledgeRunEvidence_result_ordinal_check"
  CHECK ("resultOrdinal" BETWEEN 0 AND 99) NOT VALID;

ALTER TABLE "KnowledgeRunEvidence"
  VALIDATE CONSTRAINT "KnowledgeRunEvidence_result_ordinal_check";

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_read_receipt_operation_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_read_receipt_operation_check" CHECK (
    "readReceipt" IS NULL
    OR (CASE "operation"
      WHEN 'read_source' THEN (
        jsonb_typeof("readReceipt") = 'object'
        AND pg_column_size("readReceipt") <= 4096
        AND (
          "readReceipt" - ARRAY[
            'contractVersion', 'direction', 'embedding', 'locator', 'resolution',
            'resolvedSource', 'target', 'version', 'window'
          ]::text[]
        ) = '{}'::jsonb
        AND "readReceipt" -> 'version' = '1'::jsonb
        AND "readReceipt" -> 'contractVersion' = '1'::jsonb
        AND "readReceipt" ->> 'embedding' = 'forbidden'
        AND "readReceipt" ->> 'resolution' = 'exact'
        AND "readReceipt" ->> 'direction' IN ('after', 'around', 'before')
        AND jsonb_typeof("readReceipt" -> 'locator') = 'string'
        AND char_length("readReceipt" ->> 'locator') BETWEEN 1 AND 500
        AND "readReceipt" -> 'window' IN (
          '1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb,
          '5'::jsonb, '6'::jsonb, '7'::jsonb, '8'::jsonb
        )
        AND jsonb_typeof("readReceipt" -> 'target') = 'object'
        AND "readReceipt" #>> '{target,kind}' IN (
          'block', 'evidence_handle', 'heading', 'page', 'passage', 'section',
          'structured_range'
        )
        AND CASE "readReceipt" #>> '{target,kind}'
          WHEN 'evidence_handle' THEN
            (("readReceipt" -> 'target') - ARRAY['handle', 'kind']::text[]) = '{}'::jsonb
            AND "readReceipt" #>> '{target,handle}' ~
              '^K(?:(?:[1-9][0-9]{0,2}|1[0-9]{3}|20[0-3][0-9]|204[0-8])|(?:[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-6])\.[1-8])$'
          WHEN 'page' THEN
            (("readReceipt" -> 'target') - ARRAY['kind', 'page']::text[]) = '{}'::jsonb
            AND jsonb_typeof("readReceipt" #> '{target,page}') = 'number'
            AND "readReceipt" #>> '{target,page}' ~ '^[1-9][0-9]{0,5}$'
          WHEN 'heading' THEN
            (("readReceipt" -> 'target') - ARRAY['headingPath', 'kind']::text[]) = '{}'::jsonb
            AND CASE
              WHEN jsonb_typeof("readReceipt" #> '{target,headingPath}') = 'array'
                THEN jsonb_array_length("readReceipt" #> '{target,headingPath}') BETWEEN 1 AND 16
                  AND NOT jsonb_path_exists(
                    "readReceipt" #> '{target,headingPath}',
                    '$[*] ? (@.type() != "string")'
                  )
              ELSE false
            END
          WHEN 'section' THEN
            (("readReceipt" -> 'target') - ARRAY['kind', 'sectionId']::text[]) = '{}'::jsonb
            AND "readReceipt" #>> '{target,sectionId}' ~ '^kis_[0-9a-f]{40}$'
          WHEN 'passage' THEN
            (("readReceipt" -> 'target') - ARRAY['kind', 'passageId']::text[]) = '{}'::jsonb
            AND "readReceipt" #>> '{target,passageId}' ~ '^kip_[0-9a-f]{40}$'
          WHEN 'block' THEN
            (("readReceipt" -> 'target') - ARRAY['blockId', 'kind']::text[]) = '{}'::jsonb
            AND "readReceipt" #>> '{target,blockId}' ~ '^b_[0-9a-f]{24}_(0|[1-9][0-9]{0,5})$'
          WHEN 'structured_range' THEN
            (("readReceipt" -> 'target') - ARRAY['kind', 'range', 'sheet']::text[]) = '{}'::jsonb
            AND jsonb_typeof("readReceipt" #> '{target,sheet}') = 'string'
            AND char_length("readReceipt" #>> '{target,sheet}') BETWEEN 1 AND 256
            AND jsonb_typeof("readReceipt" #> '{target,range}') = 'string'
            AND "readReceipt" #>> '{target,range}' ~
              '^(?:[A-Z]|[A-R][A-Z]|S[A-R])(?:[1-9][0-9]{0,4}|100000)(?::(?:[A-Z]|[A-R][A-Z]|S[A-R])(?:[1-9][0-9]{0,4}|100000))?$'
          ELSE false
        END
        AND "readReceipt" ->> 'locator' =
          knowledge_read_receipt_canonical_locator("readReceipt" -> 'target')
        AND jsonb_typeof("readReceipt" -> 'resolvedSource') = 'object'
        AND (
          ("readReceipt" -> 'resolvedSource') - ARRAY[
            'sourceAlias', 'sourceArtifactId', 'sourceId', 'sourceName', 'sourceVersionId'
          ]::text[]
        ) = '{}'::jsonb
        AND "query" = "readReceipt" ->> 'locator'
        AND "readReceipt" #>> '{resolvedSource,sourceAlias}' ~ '^S[1-9][0-9]{0,2}$'
        AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceArtifactId}') = 'string'
        AND char_length("readReceipt" #>> '{resolvedSource,sourceArtifactId}') BETWEEN 1 AND 512
        AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceId}') = 'string'
        AND char_length("readReceipt" #>> '{resolvedSource,sourceId}') BETWEEN 1 AND 512
        AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceName}') = 'string'
        AND char_length("readReceipt" #>> '{resolvedSource,sourceName}') BETWEEN 1 AND 1024
        AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceVersionId}') = 'string'
        AND char_length("readReceipt" #>> '{resolvedSource,sourceVersionId}') BETWEEN 1 AND 512
      )
      WHEN 'find_exact' THEN (
        "knowledge_exact_receipt_valid"("query", "readReceipt")
        AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
        AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
        AND "candidateCount" = jsonb_array_length("readReceipt" -> 'matches')
        AND jsonb_array_length("results") = jsonb_array_length("readReceipt" -> 'matches')
        AND "fusion" = 'none'
        AND "threshold" = 0
        AND "embeddingUsage" = '[]'::jsonb
      )
      WHEN 'discover_sources' THEN (
        "knowledge_discovery_receipt_valid"("query", "readReceipt")
        AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
        AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
        AND "candidateCount" = jsonb_array_length("readReceipt" -> 'sources')
        AND "results" = '[]'::jsonb
        AND "fusion" = 'none'
        AND "threshold" = 0
        AND "embeddingUsage" = '[]'::jsonb
      )
      WHEN 'structured_analysis' THEN (
        "knowledge_structured_receipt_valid"("readReceipt")
        AND "fusion" = 'rrf_k60'
        AND "embeddingUsage" = '[]'::jsonb
        AND CASE "readReceipt" ->> 'status'
          WHEN 'complete' THEN
            "outcome" = 'complete'
            AND "candidateCount" = 1
            AND jsonb_array_length("results") = 1
            AND jsonb_typeof("results" #> '{0,structuredAnalysis}') = 'object'
          WHEN 'needs_clarification' THEN
            "outcome" = 'structured_clarification_required'
            AND "candidateCount" = 0
            AND "results" = '[]'::jsonb
          ELSE false
        END
      )
      WHEN 'visual_analysis' THEN (
        "knowledge_visual_receipt_valid"("readReceipt")
        AND "fusion" = 'rrf_k60'
        AND "embeddingUsage" = '[]'::jsonb
        AND "outcome" = 'complete'
        AND "candidateCount" = 1
        AND jsonb_array_length("results") = 1
        AND "results" #>> '{0,visualAnalysis,status}' = "readReceipt" ->> 'status'
      )
      WHEN 'automatic_search' THEN (
        (
          "knowledge_structured_receipt_valid"("readReceipt")
          AND "fusion" = 'rrf_k60'
          AND "embeddingUsage" = '[]'::jsonb
          AND CASE "readReceipt" ->> 'status'
            WHEN 'complete' THEN
              "outcome" = 'complete'
              AND "candidateCount" = 1
              AND jsonb_array_length("results") = 1
              AND jsonb_typeof("results" #> '{0,structuredAnalysis}') = 'object'
            WHEN 'needs_clarification' THEN
              "outcome" = 'structured_clarification_required'
              AND "candidateCount" = 0
              AND "results" = '[]'::jsonb
            ELSE false
          END
        ) OR (
          "knowledge_visual_receipt_valid"("readReceipt")
          AND "fusion" = 'rrf_k60'
          AND "embeddingUsage" = '[]'::jsonb
          AND "outcome" = 'complete'
          AND "candidateCount" = 1
          AND jsonb_array_length("results") = 1
          AND "results" #>> '{0,visualAnalysis,status}' = "readReceipt" ->> 'status'
        )
      )
      ELSE false
    END) IS TRUE
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_read_receipt_operation_check";
