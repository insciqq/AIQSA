-- New answer-model Knowledge calls share the immutable receipt tables with
-- historical focused calls. A single run may now fan across the full admitted
-- profile set, so preserve every Base and embedding execution in the receipt.
ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_evidence_shape_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_evidence_shape_check" CHECK (
    jsonb_typeof("baseEvidence") = 'array'
    AND jsonb_array_length("baseEvidence") BETWEEN 1 AND 128
    AND jsonb_typeof("results") = 'array'
    AND jsonb_array_length("results") <= 100
    AND jsonb_typeof("embeddingUsage") = 'array'
    AND jsonb_array_length("embeddingUsage") <= 128
    AND octet_length("providerText") BETWEEN 1 AND 49152
  ) NOT VALID;

-- The fixed Basic retrieval constants apply equally to the historical
-- server-only checkpoint and the sole model-facing Knowledge tool.
CREATE OR REPLACE FUNCTION aiqsa_guard_knowledge_basic_focused_run()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  checkpoint_name text;
BEGIN
  SELECT tool_call."toolName"
  INTO checkpoint_name
  FROM "ModelRunToolCall" AS tool_call
  WHERE tool_call."modelRunId" = NEW."modelRunId"
    AND tool_call.id = NEW."modelRunToolCallId";

  IF checkpoint_name IN ('knowledge_focused_v1', 'search_knowledge') AND (
    NEW.operation IS DISTINCT FROM 'automatic_search'
    OR NEW.outcome NOT IN ('complete', 'base_empty', 'base_indexing')
    OR char_length(btrim(NEW.query, E' \n')) NOT BETWEEN 1 AND 3000
    OR translate(NEW.query, chr(10), '') ~ '[[:cntrl:]]'
    OR NEW."candidateLimit" IS DISTINCT FROM 40
    OR NEW."resultLimit" IS DISTINCT FROM 8
    OR NEW.fusion IS DISTINCT FROM 'weighted_rrf_v2'
  ) THEN
    RAISE EXCEPTION 'knowledge_basic_focused_run_contract_invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION aiqsa_guard_knowledge_basic_focused_tool_call()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."toolName" IN ('knowledge_focused_v1', 'search_knowledge') AND EXISTS (
    SELECT 1
    FROM "KnowledgeRun" AS knowledge_run
    WHERE knowledge_run."modelRunId" = NEW."modelRunId"
      AND knowledge_run."modelRunToolCallId" = NEW.id
      AND (
        knowledge_run.operation IS DISTINCT FROM 'automatic_search'
        OR knowledge_run.outcome NOT IN ('complete', 'base_empty', 'base_indexing')
        OR char_length(btrim(knowledge_run.query, E' \n')) NOT BETWEEN 1 AND 3000
        OR translate(knowledge_run.query, chr(10), '') ~ '[[:cntrl:]]'
        OR knowledge_run."candidateLimit" IS DISTINCT FROM 40
        OR knowledge_run."resultLimit" IS DISTINCT FROM 8
        OR knowledge_run.fusion IS DISTINCT FROM 'weighted_rrf_v2'
      )
  ) THEN
    RAISE EXCEPTION 'knowledge_basic_focused_run_contract_invalid';
  END IF;
  RETURN NEW;
END
$function$;
