CREATE FUNCTION "knowledge_document_context_valid"("contextValue" JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  candidate_id INTEGER;
  candidate_item JSONB;
  date_key TEXT;
  date_value TEXT;
  header_item JSONB;
  locator JSONB;
  locator_kind TEXT;
  nullable_key TEXT;
  observation_item JSONB;
  observation_reason_rank INTEGER;
  observation_reasons TEXT[] := ARRAY[]::TEXT[];
  origin JSONB;
  previous_candidate_id INTEGER;
  previous_observation_reason_rank INTEGER;
  previous_root_reason_rank INTEGER := 0;
  reason_item JSONB;
  reason_rank INTEGER;
  reason_text TEXT;
  root_reasons TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT "knowledge_jsonb_has_exact_keys"(
      "contextValue",
      ARRAY['ambiguityReasons', 'locator', 'observations', 'version']::TEXT[]
    )
    OR octet_length(convert_to("contextValue"::TEXT, 'UTF8')) > 262144
    OR "contextValue" -> 'version' IS DISTINCT FROM '1'::JSONB
    OR jsonb_typeof("contextValue" -> 'ambiguityReasons') IS DISTINCT FROM 'array'
    OR jsonb_array_length("contextValue" -> 'ambiguityReasons') > 16
    OR jsonb_typeof("contextValue" -> 'locator') IS DISTINCT FROM 'object'
    OR jsonb_typeof("contextValue" -> 'observations') IS DISTINCT FROM 'array'
    OR jsonb_array_length("contextValue" -> 'observations') > 256
  THEN
    RETURN false;
  END IF;

  FOR reason_item IN
    SELECT value FROM jsonb_array_elements("contextValue" -> 'ambiguityReasons')
  LOOP
    IF jsonb_typeof(reason_item) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    reason_text := reason_item #>> '{}';
    reason_rank := CASE reason_text
      WHEN 'ambiguous_date' THEN 1
      WHEN 'ambiguous_number' THEN 2
      WHEN 'ambiguous_role' THEN 3
      WHEN 'competing_pair' THEN 4
      WHEN 'conflicting_edge' THEN 5
      WHEN 'missing_header' THEN 6
      WHEN 'missing_pair' THEN 7
      WHEN 'unspecified_role' THEN 8
      ELSE NULL
    END;
    IF reason_rank IS NULL OR reason_rank <= previous_root_reason_rank THEN
      RETURN false;
    END IF;
    previous_root_reason_rank := reason_rank;
    root_reasons := array_append(root_reasons, reason_text);
  END LOOP;

  locator := "contextValue" -> 'locator';
  locator_kind := locator ->> 'kind';
  IF locator_kind IN ('table_row', 'table_row_projection') THEN
    IF NOT "knowledge_jsonb_has_exact_keys"(
        locator,
        CASE locator_kind
          WHEN 'table_row' THEN ARRAY[
            'blockId', 'headerLineage', 'kind', 'rowId', 'rowIndex', 'rowKind'
          ]::TEXT[]
          ELSE ARRAY[
            'blockId', 'columnEnd', 'columnStart', 'headerLineage', 'kind',
            'projectionCount', 'projectionIndex', 'rowId', 'rowIndex', 'rowKind'
          ]::TEXT[]
        END
      )
      OR jsonb_typeof(locator -> 'blockId') IS DISTINCT FROM 'string'
      OR char_length(locator ->> 'blockId') NOT BETWEEN 1 AND 512
      OR jsonb_typeof(locator -> 'rowId') IS DISTINCT FROM 'string'
      OR char_length(locator ->> 'rowId') NOT BETWEEN 1 AND 128
      OR locator ->> 'rowId' !~ '^ktr_[0-9a-f]{32}$'
      OR jsonb_typeof(locator -> 'rowIndex') IS DISTINCT FROM 'number'
      OR locator ->> 'rowIndex' !~ '^(?:0|[1-9][0-9]{0,3})$'
      OR (locator ->> 'rowIndex')::INTEGER > 2000
      OR jsonb_typeof(locator -> 'rowKind') IS DISTINCT FROM 'string'
      OR locator ->> 'rowKind' NOT IN ('data', 'header')
      OR jsonb_typeof(locator -> 'headerLineage') IS DISTINCT FROM 'array'
      OR jsonb_array_length(locator -> 'headerLineage') > 256
    THEN
      RETURN false;
    END IF;
    FOR header_item IN
      SELECT value FROM jsonb_array_elements(locator -> 'headerLineage')
    LOOP
      IF NOT "knowledge_jsonb_has_exact_keys"(
          header_item,
          ARRAY['columnEnd', 'columnStart', 'rowIndex', 'text']::TEXT[]
        )
        OR jsonb_typeof(header_item -> 'columnStart') IS DISTINCT FROM 'number'
        OR header_item ->> 'columnStart' !~ '^(?:0|[1-9][0-9]{0,2})$'
        OR (header_item ->> 'columnStart')::INTEGER > 199
        OR jsonb_typeof(header_item -> 'columnEnd') IS DISTINCT FROM 'number'
        OR header_item ->> 'columnEnd' !~ '^(?:0|[1-9][0-9]{0,2})$'
        OR (header_item ->> 'columnEnd')::INTEGER > 199
        OR (header_item ->> 'columnEnd')::INTEGER <
          (header_item ->> 'columnStart')::INTEGER
        OR jsonb_typeof(header_item -> 'rowIndex') IS DISTINCT FROM 'number'
        OR header_item ->> 'rowIndex' !~ '^(?:0|[1-9][0-9]{0,3})$'
        OR (header_item ->> 'rowIndex')::INTEGER > 2000
        OR jsonb_typeof(header_item -> 'text') IS DISTINCT FROM 'string'
        OR char_length(header_item ->> 'text') NOT BETWEEN 1 AND 1024
      THEN
        RETURN false;
      END IF;
    END LOOP;
    IF locator_kind = 'table_row_projection' AND (
      jsonb_typeof(locator -> 'columnStart') IS DISTINCT FROM 'number'
      OR locator ->> 'columnStart' !~ '^(?:0|[1-9][0-9]{0,2})$'
      OR (locator ->> 'columnStart')::INTEGER > 199
      OR jsonb_typeof(locator -> 'columnEnd') IS DISTINCT FROM 'number'
      OR locator ->> 'columnEnd' !~ '^(?:0|[1-9][0-9]{0,2})$'
      OR (locator ->> 'columnEnd')::INTEGER > 199
      OR (locator ->> 'columnEnd')::INTEGER < (locator ->> 'columnStart')::INTEGER
      OR jsonb_typeof(locator -> 'projectionCount') IS DISTINCT FROM 'number'
      OR locator ->> 'projectionCount' !~ '^[1-9][0-9]{0,2}$'
      OR (locator ->> 'projectionCount')::INTEGER > 8
      OR jsonb_typeof(locator -> 'projectionIndex') IS DISTINCT FROM 'number'
      OR locator ->> 'projectionIndex' !~ '^(?:0|[1-9][0-9]{0,2})$'
      OR (locator ->> 'projectionIndex')::INTEGER >=
        (locator ->> 'projectionCount')::INTEGER
    ) THEN
      RETURN false;
    END IF;
  ELSIF locator_kind = 'field_pair' THEN
    IF NOT "knowledge_jsonb_has_exact_keys"(
        locator,
        ARRAY['fieldGroupId', 'kind', 'labelCellId', 'valueCellId']::TEXT[]
      )
      OR jsonb_typeof(locator -> 'fieldGroupId') IS DISTINCT FROM 'string'
      OR char_length(locator ->> 'fieldGroupId') NOT BETWEEN 1 AND 512
      OR jsonb_typeof(locator -> 'labelCellId') IS DISTINCT FROM 'number'
      OR locator ->> 'labelCellId' !~ '^(?:0|[1-9][0-9]{0,6})$'
      OR (locator ->> 'labelCellId')::INTEGER > 1000000
      OR jsonb_typeof(locator -> 'valueCellId') IS DISTINCT FROM 'number'
      OR locator ->> 'valueCellId' !~ '^(?:0|[1-9][0-9]{0,6})$'
      OR (locator ->> 'valueCellId')::INTEGER > 1000000
      OR locator -> 'labelCellId' = locator -> 'valueCellId'
    THEN
      RETURN false;
    END IF;
  ELSIF locator_kind = 'field_ambiguous' THEN
    IF NOT "knowledge_jsonb_has_exact_keys"(
        locator,
        ARRAY['candidateCellIds', 'cellId', 'fieldGroupId', 'kind']::TEXT[]
      )
      OR jsonb_typeof(locator -> 'fieldGroupId') IS DISTINCT FROM 'string'
      OR char_length(locator ->> 'fieldGroupId') NOT BETWEEN 1 AND 512
      OR jsonb_typeof(locator -> 'cellId') IS DISTINCT FROM 'number'
      OR locator ->> 'cellId' !~ '^(?:0|[1-9][0-9]{0,6})$'
      OR (locator ->> 'cellId')::INTEGER > 1000000
      OR jsonb_typeof(locator -> 'candidateCellIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(locator -> 'candidateCellIds') > 256
    THEN
      RETURN false;
    END IF;
    previous_candidate_id := -1;
    FOR candidate_item IN
      SELECT value FROM jsonb_array_elements(locator -> 'candidateCellIds')
    LOOP
      IF jsonb_typeof(candidate_item) IS DISTINCT FROM 'number'
        OR candidate_item #>> '{}' !~ '^(?:0|[1-9][0-9]{0,6})$'
      THEN
        RETURN false;
      END IF;
      candidate_id := (candidate_item #>> '{}')::INTEGER;
      IF candidate_id > 1000000
        OR candidate_id = (locator ->> 'cellId')::INTEGER
        OR candidate_id <= previous_candidate_id
      THEN
        RETURN false;
      END IF;
      previous_candidate_id := candidate_id;
    END LOOP;
  ELSE
    RETURN false;
  END IF;

  FOR observation_item IN
    SELECT value FROM jsonb_array_elements("contextValue" -> 'observations')
  LOOP
    IF NOT "knowledge_jsonb_has_exact_keys"(
        observation_item,
        ARRAY[
          'ambiguityReasons', 'confidence', 'date', 'effectiveFrom', 'effectiveTo',
          'metric', 'normalizedValue', 'origin', 'rawValue', 'role', 'subject',
          'unit', 'valueKind'
        ]::TEXT[]
      )
      OR jsonb_typeof(observation_item -> 'ambiguityReasons') IS DISTINCT FROM 'array'
      OR jsonb_array_length(observation_item -> 'ambiguityReasons') > 16
      OR observation_item -> 'confidence' <> 'null'::JSONB AND (
        jsonb_typeof(observation_item -> 'confidence') IS DISTINCT FROM 'number'
        OR (observation_item ->> 'confidence')::NUMERIC NOT BETWEEN 0 AND 1
      )
      OR jsonb_typeof(observation_item -> 'rawValue') IS DISTINCT FROM 'string'
      OR char_length(observation_item ->> 'rawValue') NOT BETWEEN 1 AND 4096
      OR jsonb_typeof(observation_item -> 'role') IS DISTINCT FROM 'string'
      OR observation_item ->> 'role' NOT IN (
        'header', 'metadata', 'observation', 'reference', 'target', 'threshold'
      )
      OR jsonb_typeof(observation_item -> 'valueKind') IS DISTINCT FROM 'string'
      OR observation_item ->> 'valueKind' NOT IN (
        'date', 'number', 'number_range', 'text'
      )
    THEN
      RETURN false;
    END IF;

    FOREACH nullable_key IN ARRAY ARRAY['metric', 'normalizedValue', 'subject', 'unit']::TEXT[]
    LOOP
      IF observation_item -> nullable_key <> 'null'::JSONB AND (
        jsonb_typeof(observation_item -> nullable_key) IS DISTINCT FROM 'string'
        OR char_length(observation_item ->> nullable_key) NOT BETWEEN 1 AND
          CASE nullable_key WHEN 'normalizedValue' THEN 4096 WHEN 'unit' THEN 128 ELSE 1024 END
      ) THEN
        RETURN false;
      END IF;
    END LOOP;

    FOREACH date_key IN ARRAY ARRAY['date', 'effectiveFrom', 'effectiveTo']::TEXT[]
    LOOP
      IF observation_item -> date_key <> 'null'::JSONB THEN
        IF jsonb_typeof(observation_item -> date_key) IS DISTINCT FROM 'string'
          OR observation_item ->> date_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        THEN
          RETURN false;
        END IF;
        date_value := observation_item ->> date_key;
        IF substring(date_value FROM 1 FOR 4)::INTEGER NOT BETWEEN 1000 AND 9999
          OR make_date(
            substring(date_value FROM 1 FOR 4)::INTEGER,
            substring(date_value FROM 6 FOR 2)::INTEGER,
            substring(date_value FROM 9 FOR 2)::INTEGER
          )::TEXT IS DISTINCT FROM date_value
        THEN
          RETURN false;
        END IF;
      END IF;
    END LOOP;

    previous_observation_reason_rank := 0;
    FOR reason_item IN
      SELECT value FROM jsonb_array_elements(observation_item -> 'ambiguityReasons')
    LOOP
      IF jsonb_typeof(reason_item) IS DISTINCT FROM 'string' THEN
        RETURN false;
      END IF;
      reason_text := reason_item #>> '{}';
      observation_reason_rank := CASE reason_text
        WHEN 'ambiguous_date' THEN 1
        WHEN 'ambiguous_number' THEN 2
        WHEN 'ambiguous_role' THEN 3
        WHEN 'competing_pair' THEN 4
        WHEN 'conflicting_edge' THEN 5
        WHEN 'missing_header' THEN 6
        WHEN 'missing_pair' THEN 7
        WHEN 'unspecified_role' THEN 8
        ELSE NULL
      END;
      IF observation_reason_rank IS NULL
        OR observation_reason_rank <= previous_observation_reason_rank
      THEN
        RETURN false;
      END IF;
      previous_observation_reason_rank := observation_reason_rank;
      IF array_position(observation_reasons, reason_text) IS NULL THEN
        observation_reasons := array_append(observation_reasons, reason_text);
      END IF;
    END LOOP;

    origin := observation_item -> 'origin';
    IF origin ->> 'kind' = 'table_cell' THEN
      IF NOT "knowledge_jsonb_has_exact_keys"(
          origin,
          ARRAY['columnEnd', 'columnStart', 'kind']::TEXT[]
        )
        OR jsonb_typeof(origin -> 'columnStart') IS DISTINCT FROM 'number'
        OR origin ->> 'columnStart' !~ '^(?:0|[1-9][0-9]{0,2})$'
        OR (origin ->> 'columnStart')::INTEGER > 199
        OR jsonb_typeof(origin -> 'columnEnd') IS DISTINCT FROM 'number'
        OR origin ->> 'columnEnd' !~ '^(?:0|[1-9][0-9]{0,2})$'
        OR (origin ->> 'columnEnd')::INTEGER > 199
        OR (origin ->> 'columnEnd')::INTEGER < (origin ->> 'columnStart')::INTEGER
      THEN
        RETURN false;
      END IF;
    ELSIF origin ->> 'kind' = 'field_cell' THEN
      IF NOT "knowledge_jsonb_has_exact_keys"(
          origin,
          ARRAY['cellId', 'kind']::TEXT[]
        )
        OR jsonb_typeof(origin -> 'cellId') IS DISTINCT FROM 'number'
        OR origin ->> 'cellId' !~ '^(?:0|[1-9][0-9]{0,6})$'
        OR (origin ->> 'cellId')::INTEGER > 1000000
      THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;

  RETURN root_reasons <@ observation_reasons AND root_reasons @> observation_reasons;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION public.knowledge_read_receipt_canonical_locator(target JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE target ->> 'kind'
    WHEN 'evidence_handle' THEN target ->> 'handle'
    WHEN 'page' THEN 'page ' || (target ->> 'page')
    WHEN 'heading' THEN CASE
      WHEN jsonb_typeof(target -> 'headingPath') = 'array' THEN (
        SELECT CASE
          WHEN count(*) BETWEEN 1 AND 16
            AND bool_and(char_length(part) BETWEEN 1 AND 256)
            AND bool_and(part !~ '[[:cntrl:]]')
            AND bool_and(
              part = regexp_replace(
                normalize(btrim(part), NFKC),
                '[[:space:]]+',
                ' ',
                'g'
              )
            )
          THEN 'heading: ' || string_agg(part, ' › ' ORDER BY ordinal)
          ELSE NULL
        END
        FROM jsonb_array_elements_text(target -> 'headingPath')
          WITH ORDINALITY AS heading(part, ordinal)
      )
      ELSE NULL
    END
    WHEN 'section' THEN 'section:' || (target ->> 'sectionId')
    WHEN 'passage' THEN 'passage:' || (target ->> 'passageId')
    WHEN 'block' THEN 'block:' || (target ->> 'blockId')
    WHEN 'row' THEN 'row:' || (target ->> 'rowId')
    WHEN 'structured_range' THEN CASE
      WHEN (target ->> 'sheet') = normalize(btrim(target ->> 'sheet'), NFKC)
        AND (target ->> 'sheet') !~ '[[:cntrl:]]'
      THEN
        'range:' || chr(39) ||
        replace((target ->> 'sheet'), chr(39), chr(39) || chr(39)) ||
        chr(39) || '!' || (target ->> 'range')
      ELSE NULL
    END
    ELSE NULL
  END
$function$;

CREATE FUNCTION knowledge_read_source_receipt_valid_v2(
  query_value TEXT,
  receipt JSONB
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT (
    jsonb_typeof(receipt) = 'object'
    AND pg_column_size(receipt) <= 4096
    AND (
      receipt - ARRAY[
        'contractVersion', 'direction', 'embedding', 'locator', 'resolution',
        'resolvedSource', 'target', 'version', 'window'
      ]::text[]
    ) = '{}'::jsonb
    AND receipt -> 'version' = '1'::jsonb
    AND receipt -> 'contractVersion' = '1'::jsonb
    AND receipt ->> 'embedding' = 'forbidden'
    AND receipt ->> 'resolution' = 'exact'
    AND receipt ->> 'direction' IN ('after', 'around', 'before')
    AND jsonb_typeof(receipt -> 'locator') = 'string'
    AND char_length(receipt ->> 'locator') BETWEEN 1 AND 500
    AND receipt -> 'window' IN (
      '1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb,
      '5'::jsonb, '6'::jsonb, '7'::jsonb, '8'::jsonb
    )
    AND jsonb_typeof(receipt -> 'target') = 'object'
    AND receipt #>> '{target,kind}' IN (
      'block', 'evidence_handle', 'heading', 'page', 'passage', 'row', 'section',
      'structured_range'
    )
    AND CASE receipt #>> '{target,kind}'
      WHEN 'evidence_handle' THEN
        ((receipt -> 'target') - ARRAY['handle', 'kind']::text[]) = '{}'::jsonb
        AND receipt #>> '{target,handle}' ~
          '^K(?:(?:[1-9][0-9]{0,2}|1[0-9]{3}|20[0-3][0-9]|204[0-8])|(?:[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-6])\.[1-8])$'
      WHEN 'page' THEN
        ((receipt -> 'target') - ARRAY['kind', 'page']::text[]) = '{}'::jsonb
        AND jsonb_typeof(receipt #> '{target,page}') = 'number'
        AND receipt #>> '{target,page}' ~ '^[1-9][0-9]{0,5}$'
      WHEN 'heading' THEN
        ((receipt -> 'target') - ARRAY['headingPath', 'kind']::text[]) = '{}'::jsonb
        AND CASE
          WHEN jsonb_typeof(receipt #> '{target,headingPath}') = 'array'
            THEN jsonb_array_length(receipt #> '{target,headingPath}') BETWEEN 1 AND 16
              AND NOT jsonb_path_exists(
                receipt #> '{target,headingPath}',
                '$[*] ? (@.type() != "string")'
              )
          ELSE false
        END
      WHEN 'section' THEN
        ((receipt -> 'target') - ARRAY['kind', 'sectionId']::text[]) = '{}'::jsonb
        AND receipt #>> '{target,sectionId}' ~ '^kis_[0-9a-f]{40}$'
      WHEN 'passage' THEN
        ((receipt -> 'target') - ARRAY['kind', 'passageId']::text[]) = '{}'::jsonb
        AND receipt #>> '{target,passageId}' ~ '^kip_[0-9a-f]{40}$'
      WHEN 'block' THEN
        ((receipt -> 'target') - ARRAY['blockId', 'kind']::text[]) = '{}'::jsonb
        AND receipt #>> '{target,blockId}' ~ '^b_[0-9a-f]{24}_(0|[1-9][0-9]{0,5})$'
      WHEN 'row' THEN
        ((receipt -> 'target') - ARRAY['kind', 'rowId']::text[]) = '{}'::jsonb
        AND receipt #>> '{target,rowId}' ~ '^ktr_[0-9a-f]{32}$'
      WHEN 'structured_range' THEN
        ((receipt -> 'target') - ARRAY['kind', 'range', 'sheet']::text[]) = '{}'::jsonb
        AND jsonb_typeof(receipt #> '{target,sheet}') = 'string'
        AND char_length(receipt #>> '{target,sheet}') BETWEEN 1 AND 256
        AND jsonb_typeof(receipt #> '{target,range}') = 'string'
        AND receipt #>> '{target,range}' ~
          '^(?:[A-Z]|[A-R][A-Z]|S[A-R])(?:[1-9][0-9]{0,4}|100000)(?::(?:[A-Z]|[A-R][A-Z]|S[A-R])(?:[1-9][0-9]{0,4}|100000))?$'
      ELSE false
    END
    AND receipt ->> 'locator' =
      public.knowledge_read_receipt_canonical_locator(receipt -> 'target')
    AND jsonb_typeof(receipt -> 'resolvedSource') = 'object'
    AND (
      (receipt -> 'resolvedSource') - ARRAY[
        'sourceAlias', 'sourceArtifactId', 'sourceId', 'sourceName', 'sourceVersionId'
      ]::text[]
    ) = '{}'::jsonb
    AND query_value = receipt ->> 'locator'
    AND receipt #>> '{resolvedSource,sourceAlias}' ~ '^S[1-9][0-9]{0,2}$'
    AND jsonb_typeof(receipt #> '{resolvedSource,sourceArtifactId}') = 'string'
    AND char_length(receipt #>> '{resolvedSource,sourceArtifactId}') BETWEEN 1 AND 512
    AND jsonb_typeof(receipt #> '{resolvedSource,sourceId}') = 'string'
    AND char_length(receipt #>> '{resolvedSource,sourceId}') BETWEEN 1 AND 512
    AND jsonb_typeof(receipt #> '{resolvedSource,sourceName}') = 'string'
    AND char_length(receipt #>> '{resolvedSource,sourceName}') BETWEEN 1 AND 1024
    AND jsonb_typeof(receipt #> '{resolvedSource,sourceVersionId}') = 'string'
    AND char_length(receipt #>> '{resolvedSource,sourceVersionId}') BETWEEN 1 AND 512
  )
$function$;

ALTER TABLE "KnowledgeArtifactPassageIndex"
  ADD COLUMN "documentContext" JSONB;

ALTER TABLE "KnowledgeArtifactPassageIndex"
  ADD CONSTRAINT "KnowledgeArtifactPassageIndex_document_context_check" CHECK (
    "documentContext" IS NULL
    OR "knowledge_document_context_valid"("documentContext")
  ) NOT VALID;

ALTER TABLE "KnowledgeArtifactPassageIndex"
  VALIDATE CONSTRAINT "KnowledgeArtifactPassageIndex_document_context_check";

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_read_receipt_operation_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_read_receipt_operation_check" CHECK (
    "readReceipt" IS NULL
    OR (CASE "operation"
      WHEN 'read_source' THEN
        knowledge_read_source_receipt_valid_v2("query", "readReceipt")
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
