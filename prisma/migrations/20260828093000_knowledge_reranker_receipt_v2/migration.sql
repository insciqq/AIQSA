-- Automatic-search receipts may now carry one strictly content-free hosted
-- reranker execution binding. Keep validation in PostgreSQL aligned with the
-- server decoder so direct writes cannot smuggle arbitrary receipt payloads.
CREATE FUNCTION knowledge_reranker_binding_valid_v2(binding JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_count NUMERIC;
  duration_value NUMERIC;
  element_text TEXT;
  element_value JSONB;
  field_name TEXT;
  ordered_count INTEGER;
  ordered_distinct_count INTEGER;
  ordered_value JSONB;
  output_count INTEGER;
  output_distinct_count INTEGER;
  output_value JSONB;
  pins_all_null BOOLEAN;
  pins_all_present BOOLEAN;
  ranking_profile_value NUMERIC;
  relevance_value JSONB;
  scored_count INTEGER := 0;
  status_value TEXT;
  usage_value JSONB;
BEGIN
  IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
    OR pg_column_size(binding) > 262144
    OR NOT binding ?& ARRAY[
      'adapterVersion', 'candidateFormatterVersion', 'connectionSnapshotId',
      'credentialSnapshotRef', 'durationMs', 'fallbackReason',
      'inputCandidateCount', 'orderedCandidateChunkIds', 'outputOrder',
      'policyVersion', 'provider', 'providerModelId', 'providerRequestId',
      'rankingProfileVersion', 'relevanceScores', 'status', 'timedOut',
      'upstreamModelId', 'usage', 'version'
    ]::TEXT[]
    OR binding - ARRAY[
      'adapterVersion', 'candidateFormatterVersion', 'connectionSnapshotId',
      'credentialSnapshotRef', 'durationMs', 'fallbackReason',
      'inputCandidateCount', 'orderedCandidateChunkIds', 'outputOrder',
      'policyVersion', 'provider', 'providerModelId', 'providerRequestId',
      'rankingProfileVersion', 'relevanceScores', 'status', 'timedOut',
      'upstreamModelId', 'usage', 'version'
    ]::TEXT[] <> '{}'::JSONB
    OR binding -> 'version' <> '2'::JSONB
  THEN
    RETURN false;
  END IF;

  status_value := binding ->> 'status';
  IF jsonb_typeof(binding -> 'status') IS DISTINCT FROM 'string'
    OR status_value NOT IN ('complete', 'degraded', 'disabled', 'partial')
    OR binding -> 'timedOut' NOT IN ('false'::JSONB, 'true'::JSONB)
  THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(binding -> 'durationMs') IS DISTINCT FROM 'number'
    OR binding ->> 'durationMs' !~ '^(0|[1-9][0-9]*)$'
  THEN
    RETURN false;
  END IF;
  duration_value := (binding ->> 'durationMs')::NUMERIC;
  IF duration_value > 3600000 THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(binding -> 'inputCandidateCount') IS DISTINCT FROM 'number'
    OR binding ->> 'inputCandidateCount' !~ '^(0|[1-9][0-9]*)$'
  THEN
    RETURN false;
  END IF;
  candidate_count := (binding ->> 'inputCandidateCount')::NUMERIC;
  IF candidate_count > 96 THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(binding -> 'rankingProfileVersion') IS DISTINCT FROM 'number'
    OR binding ->> 'rankingProfileVersion' !~ '^(0|[1-9][0-9]*)$'
  THEN
    RETURN false;
  END IF;
  ranking_profile_value := (binding ->> 'rankingProfileVersion')::NUMERIC;
  IF ranking_profile_value < 2 OR ranking_profile_value > 9007199254740991 THEN
    RETURN false;
  END IF;

  IF binding -> 'candidateFormatterVersion' <> 'null'::JSONB THEN
    IF jsonb_typeof(binding -> 'candidateFormatterVersion') IS DISTINCT FROM 'number'
      OR binding ->> 'candidateFormatterVersion' !~ '^[1-9][0-9]*$'
      OR (binding ->> 'candidateFormatterVersion')::NUMERIC > 9007199254740991
    THEN
      RETURN false;
    END IF;
  END IF;
  IF binding -> 'policyVersion' <> 'null'::JSONB THEN
    IF jsonb_typeof(binding -> 'policyVersion') IS DISTINCT FROM 'number'
      OR binding ->> 'policyVersion' !~ '^(0|[1-9][0-9]*)$'
      OR (binding ->> 'policyVersion')::NUMERIC > 9007199254740991
    THEN
      RETURN false;
    END IF;
  END IF;

  FOREACH field_name IN ARRAY ARRAY[
    'adapterVersion', 'connectionSnapshotId', 'credentialSnapshotRef',
    'provider', 'providerModelId', 'providerRequestId', 'upstreamModelId'
  ]::TEXT[] LOOP
    element_value := binding -> field_name;
    IF element_value <> 'null'::JSONB AND (
      jsonb_typeof(element_value) IS DISTINCT FROM 'string'
      OR char_length(binding ->> field_name) NOT BETWEEN 1 AND 512
      OR binding ->> field_name ~ '[[:cntrl:]]'
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF binding -> 'fallbackReason' <> 'null'::JSONB AND (
    jsonb_typeof(binding -> 'fallbackReason') IS DISTINCT FROM 'string'
    OR binding ->> 'fallbackReason' !~ '^[a-z][a-z0-9_]{0,127}$'
  ) THEN
    RETURN false;
  END IF;

  usage_value := binding -> 'usage';
  IF jsonb_typeof(usage_value) IS DISTINCT FROM 'object'
    OR NOT usage_value ?& ARRAY['searchUnits', 'totalTokens']::TEXT[]
    OR usage_value - ARRAY['searchUnits', 'totalTokens']::TEXT[] <> '{}'::JSONB
  THEN
    RETURN false;
  END IF;
  FOREACH field_name IN ARRAY ARRAY['searchUnits', 'totalTokens']::TEXT[] LOOP
    element_value := usage_value -> field_name;
    IF element_value <> 'null'::JSONB AND (
      jsonb_typeof(element_value) IS DISTINCT FROM 'number'
      OR usage_value ->> field_name !~ '^(0|[1-9][0-9]*)$'
      OR (usage_value ->> field_name)::NUMERIC > 9007199254740991
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  ordered_value := binding -> 'orderedCandidateChunkIds';
  IF jsonb_typeof(ordered_value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(ordered_value) > 96
  THEN
    RETURN false;
  END IF;
  FOR element_value IN SELECT value FROM jsonb_array_elements(ordered_value) AS item(value)
  LOOP
    IF jsonb_typeof(element_value) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    element_text := element_value #>> '{}';
    IF char_length(element_text) NOT BETWEEN 1 AND 512
      OR element_text ~ '[[:space:][:cntrl:]]'
    THEN
      RETURN false;
    END IF;
  END LOOP;
  SELECT count(*)::INTEGER, count(DISTINCT value)::INTEGER
  INTO ordered_count, ordered_distinct_count
  FROM jsonb_array_elements_text(ordered_value) AS item(value);
  IF ordered_count <> ordered_distinct_count THEN
    RETURN false;
  END IF;

  output_value := binding -> 'outputOrder';
  IF jsonb_typeof(output_value) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  FOR element_value IN SELECT value FROM jsonb_array_elements(output_value) AS item(value)
  LOOP
    IF jsonb_typeof(element_value) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    element_text := element_value #>> '{}';
    IF char_length(element_text) NOT BETWEEN 1 AND 512
      OR element_text ~ '[[:space:][:cntrl:]]'
    THEN
      RETURN false;
    END IF;
  END LOOP;
  SELECT count(*)::INTEGER, count(DISTINCT value)::INTEGER
  INTO output_count, output_distinct_count
  FROM jsonb_array_elements_text(output_value) AS item(value);
  IF output_count <> output_distinct_count OR output_count > 96 OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(output_value) AS output_item(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(ordered_value) AS ordered_item(value)
      WHERE ordered_item.value = output_item.value
    )
  ) THEN
    RETURN false;
  END IF;

  relevance_value := binding -> 'relevanceScores';
  IF jsonb_typeof(relevance_value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(relevance_value) <> output_count
  THEN
    RETURN false;
  END IF;
  FOR element_value IN SELECT value FROM jsonb_array_elements(relevance_value) AS item(value)
  LOOP
    IF element_value <> 'null'::JSONB THEN
      IF jsonb_typeof(element_value) IS DISTINCT FROM 'number' THEN
        RETURN false;
      END IF;
      scored_count := scored_count + 1;
    END IF;
  END LOOP;

  pins_all_null :=
    binding -> 'adapterVersion' = 'null'::JSONB
    AND binding -> 'candidateFormatterVersion' = 'null'::JSONB
    AND binding -> 'connectionSnapshotId' = 'null'::JSONB
    AND binding -> 'credentialSnapshotRef' = 'null'::JSONB
    AND binding -> 'policyVersion' = 'null'::JSONB
    AND binding -> 'providerModelId' = 'null'::JSONB
    AND binding -> 'upstreamModelId' = 'null'::JSONB;
  pins_all_present :=
    binding -> 'adapterVersion' <> 'null'::JSONB
    AND binding -> 'candidateFormatterVersion' <> 'null'::JSONB
    AND binding -> 'connectionSnapshotId' <> 'null'::JSONB
    AND binding -> 'credentialSnapshotRef' <> 'null'::JSONB
    AND binding -> 'policyVersion' <> 'null'::JSONB
    AND binding -> 'providerModelId' <> 'null'::JSONB
    AND binding -> 'upstreamModelId' <> 'null'::JSONB;

  IF status_value = 'disabled' THEN
    IF ordered_count <> 0 OR output_count <> 0 OR candidate_count <> 0
      OR scored_count <> 0 OR binding -> 'timedOut' <> 'false'::JSONB
      OR binding -> 'fallbackReason' <> 'null'::JSONB OR NOT pins_all_null
      OR binding -> 'provider' <> 'null'::JSONB
      OR binding -> 'providerRequestId' <> 'null'::JSONB
    THEN
      RETURN false;
    END IF;
  ELSIF status_value = 'degraded' THEN
    IF output_count <> 0 OR binding -> 'fallbackReason' = 'null'::JSONB
      OR (ordered_count <> 0 AND ordered_count <> candidate_count)
    THEN
      RETURN false;
    END IF;
  ELSE
    IF ordered_count <> candidate_count OR output_count <> ordered_count
      OR binding -> 'timedOut' <> 'false'::JSONB
      OR binding -> 'fallbackReason' <> 'null'::JSONB OR NOT pins_all_present
    THEN
      RETURN false;
    END IF;
    IF status_value = 'complete' THEN
      IF scored_count <> output_count
        AND NOT (scored_count = 0 AND candidate_count <= 1)
      THEN
        RETURN false;
      END IF;
    ELSIF scored_count >= output_count OR candidate_count < 2 THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END
$function$;

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_read_receipt_operation_check",
  ADD CONSTRAINT "KnowledgeRun_read_receipt_operation_check" CHECK (
    (
      operation IN ('structured_analysis', 'visual_analysis')
      AND (
        query <> 'deleted_knowledge_resource'
        OR "readReceipt" IS NULL
      )
    )
    OR (
      operation NOT IN ('structured_analysis', 'visual_analysis')
      AND (
        "readReceipt" IS NULL
        OR (CASE operation
          WHEN 'automatic_search' THEN (
            jsonb_typeof("readReceipt") = 'object'
            AND pg_column_size("readReceipt") <= 262144
            AND "readReceipt" ? 'rerankerBinding'
            AND "readReceipt" - ARRAY['rerankerBinding']::TEXT[] = '{}'::JSONB
            AND knowledge_reranker_binding_valid_v2("readReceipt" -> 'rerankerBinding')
          )
          WHEN 'read_source' THEN
            knowledge_read_source_receipt_valid_v2(query, "readReceipt")
          WHEN 'find_exact' THEN (
            knowledge_exact_receipt_valid(query, "readReceipt")
            AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
            AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
            AND "candidateCount" = jsonb_array_length("readReceipt" -> 'matches')
            AND jsonb_array_length(results) =
              jsonb_array_length("readReceipt" -> 'matches')
            AND fusion = 'none'
            AND "embeddingUsage" = '[]'::JSONB
          )
          WHEN 'discover_sources' THEN (
            knowledge_discovery_receipt_valid(query, "readReceipt")
            AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
            AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
            AND "candidateCount" = jsonb_array_length("readReceipt" -> 'sources')
            AND results = '[]'::JSONB
            AND fusion = 'none'
            AND "embeddingUsage" = '[]'::JSONB
          )
          ELSE false
        END) IS TRUE
      )
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_read_receipt_operation_check";
