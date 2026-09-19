-- Only a complete, ordered decision cohort may remove selected passages.
-- Version 1 freezes the 0.1 usefulness floor with its accepted receipt.
CREATE FUNCTION knowledge_relevance_evidence_valid_v1(
  receipt JSONB, candidate_count INTEGER, selected_results JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
DECLARE
  chunk_count INTEGER;
  attempt_count INTEGER;
  expected_ids JSONB;
  result_ids JSONB;
BEGIN
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
    OR receipt - ARRAY['version', 'status', 'chunkIds', 'attemptIds', 'scores', 'failureCode', 'durationMs']::TEXT[] <> '{}'::JSONB
    OR NOT receipt ?& ARRAY['version', 'status', 'chunkIds', 'attemptIds', 'scores', 'failureCode', 'durationMs']::TEXT[]
    OR receipt -> 'version' IS DISTINCT FROM '1'::JSONB
    OR receipt ->> 'status' NOT IN ('complete', 'unavailable')
    OR jsonb_typeof(receipt -> 'chunkIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(receipt -> 'attemptIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(receipt -> 'scores') IS DISTINCT FROM 'array'
    OR jsonb_typeof(selected_results) IS DISTINCT FROM 'array'
    OR jsonb_typeof(receipt -> 'durationMs') IS DISTINCT FROM 'number'
    OR receipt ->> 'durationMs' !~ '^(0|[1-9][0-9]{0,6})$'
    OR (receipt ->> 'durationMs')::INTEGER > 3600000
  THEN RETURN false; END IF;
  IF receipt ->> 'status' IS NULL OR candidate_count IS NULL OR candidate_count < 0
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements((receipt -> 'chunkIds') || (receipt -> 'attemptIds')) item
      WHERE jsonb_typeof(item) <> 'string' OR char_length(item #>> '{}') NOT BETWEEN 1 AND 512
        OR (item #>> '{}') ~ '[[:space:][:cntrl:]]'
    )
  THEN RETURN false; END IF;
  chunk_count := jsonb_array_length(receipt -> 'chunkIds');
  attempt_count := jsonb_array_length(receipt -> 'attemptIds');
  IF chunk_count > 96 OR chunk_count > candidate_count OR attempt_count > chunk_count
    OR chunk_count <> (SELECT count(DISTINCT id) FROM jsonb_array_elements(receipt -> 'chunkIds') id)
    OR attempt_count <> (SELECT count(DISTINCT id) FROM jsonb_array_elements(receipt -> 'attemptIds') id)
  THEN RETURN false; END IF;
  IF receipt ->> 'status' = 'complete' THEN
    IF receipt -> 'failureCode' IS DISTINCT FROM 'null'::JSONB OR chunk_count = 0
      OR attempt_count <> chunk_count OR jsonb_array_length(receipt -> 'scores') <> chunk_count
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(receipt -> 'scores') score
        WHERE jsonb_typeof(score) <> 'number' OR (score #>> '{}')::NUMERIC NOT BETWEEN 0 AND 1)
    THEN RETURN false; END IF;
    SELECT COALESCE(jsonb_agg(chunk ORDER BY ordinal), '[]'::JSONB) INTO expected_ids
      FROM jsonb_array_elements(receipt -> 'chunkIds') WITH ORDINALITY items(chunk, ordinal)
      WHERE (receipt -> 'scores' ->> (ordinal::INTEGER - 1))::NUMERIC >= 0.1;
  ELSE
    IF jsonb_typeof(receipt -> 'failureCode') IS DISTINCT FROM 'string'
      OR receipt ->> 'failureCode' !~ '^[a-z][a-z0-9_]{0,127}$'
      OR receipt -> 'scores' <> '[]'::JSONB
    THEN RETURN false; END IF;
    expected_ids := receipt -> 'chunkIds';
  END IF;
  SELECT COALESCE(jsonb_agg(item -> 'chunkId' ORDER BY ordinal), '[]'::JSONB) INTO result_ids
    FROM jsonb_array_elements(selected_results) WITH ORDINALITY items(item, ordinal);
  RETURN expected_ids = result_ids;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$function$;

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_read_receipt_operation_check",
  ADD CONSTRAINT "KnowledgeRun_read_receipt_operation_check" CHECK (
    (
      operation IN ('structured_analysis', 'visual_analysis')
      AND (query <> 'deleted_knowledge_resource' OR "readReceipt" IS NULL)
    ) OR (
      operation NOT IN ('structured_analysis', 'visual_analysis')
      AND ("readReceipt" IS NULL OR (CASE operation
        WHEN 'automatic_search' THEN (
          jsonb_typeof("readReceipt") = 'object'
          AND pg_column_size("readReceipt") <= 262144
          AND "readReceipt" ?| ARRAY['rerankerBinding', 'relevance']::TEXT[]
          AND "readReceipt" - ARRAY['rerankerBinding', 'relevance']::TEXT[] = '{}'::JSONB
          AND (NOT "readReceipt" ? 'rerankerBinding'
            OR knowledge_reranker_binding_valid_v2("readReceipt" -> 'rerankerBinding'))
          AND (NOT "readReceipt" ? 'relevance'
            OR knowledge_relevance_evidence_valid_v1("readReceipt" -> 'relevance', "candidateCount", results))
        )
        WHEN 'read_source' THEN knowledge_read_source_receipt_valid_v2(query, "readReceipt")
        WHEN 'find_exact' THEN (
          knowledge_exact_receipt_valid(query, "readReceipt")
          AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "candidateCount" = jsonb_array_length("readReceipt" -> 'matches')
          AND jsonb_array_length(results) = jsonb_array_length("readReceipt" -> 'matches')
          AND fusion = 'none' AND "embeddingUsage" = '[]'::JSONB
        )
        WHEN 'discover_sources' THEN (
          knowledge_discovery_receipt_valid(query, "readReceipt")
          AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "candidateCount" = jsonb_array_length("readReceipt" -> 'sources')
          AND results = '[]'::JSONB AND fusion = 'none' AND "embeddingUsage" = '[]'::JSONB
        )
        ELSE false END) IS TRUE)
    )
  ) NOT VALID;
ALTER TABLE "KnowledgeRun" VALIDATE CONSTRAINT "KnowledgeRun_read_receipt_operation_check";

ALTER TABLE "KnowledgeRun" DROP CONSTRAINT "KnowledgeRun_negative_outcome_check";
ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_negative_outcome_check" CHECK (
  CASE "outcome"::TEXT
    WHEN 'base_empty' THEN "candidateCount" = 0
    WHEN 'no_relevant_evidence' THEN "candidateCount" = 0 OR (
      operation = 'automatic_search' AND results = '[]'::JSONB
      AND "readReceipt" #>> '{relevance,status}' = 'complete'
      AND knowledge_relevance_evidence_valid_v1("readReceipt" -> 'relevance', "candidateCount", results)
    ) IS TRUE
    WHEN 'zero_above_threshold' THEN CASE
      WHEN operation IN ('find_exact', 'discover_sources') THEN "candidateCount" = 0
      ELSE "candidateCount" > 0 END
    ELSE true END
) NOT VALID;
ALTER TABLE "KnowledgeRun" VALIDATE CONSTRAINT "KnowledgeRun_negative_outcome_check";
