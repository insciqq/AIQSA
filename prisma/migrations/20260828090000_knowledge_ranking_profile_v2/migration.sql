-- Ranking profile v2 widens every automatic-search retrieval lane from the
-- historical 40 candidates to 64. Historical receipts are immutable and are
-- not rewritten; these guards admit only the current constants for new
-- focused/search checkpoints and for tool calls promoted to those names.
CREATE OR REPLACE FUNCTION aiqsa_guard_knowledge_basic_focused_run()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  checkpoint_arguments jsonb;
  checkpoint_name text;
BEGIN
  SELECT tool_call.arguments, tool_call."toolName"
  INTO checkpoint_arguments, checkpoint_name
  FROM "ModelRunToolCall" AS tool_call
  WHERE tool_call."modelRunId" = NEW."modelRunId"
    AND tool_call.id = NEW."modelRunToolCallId";

  IF checkpoint_name IN ('knowledge_focused_v1', 'search_knowledge') AND (
    NEW.operation IS DISTINCT FROM 'automatic_search'
    OR NEW.outcome NOT IN (
      'complete', 'base_empty', 'base_indexing', 'no_relevant_evidence'
    )
    OR char_length(btrim(NEW.query, E' \n')) NOT BETWEEN 1 AND 3000
    OR translate(NEW.query, chr(10), '') ~ '[[:cntrl:]]'
    OR NEW."candidateLimit" IS DISTINCT FROM 64
    OR NEW.fusion IS DISTINCT FROM 'weighted_rrf_v2'
    OR (
      checkpoint_name = 'knowledge_focused_v1'
      AND NEW."resultLimit" NOT IN (8, 16)
    )
    OR (
      checkpoint_name = 'search_knowledge'
      AND CASE
        WHEN NOT checkpoint_arguments ? 'sourceAliases'
          THEN NEW."resultLimit" IS DISTINCT FROM 8
        WHEN jsonb_typeof(checkpoint_arguments -> 'sourceAliases') IS DISTINCT FROM 'array'
          THEN true
        WHEN jsonb_array_length(checkpoint_arguments -> 'sourceAliases') > 32
          THEN true
        WHEN jsonb_array_length(checkpoint_arguments -> 'sourceAliases') = 0
          THEN NEW."resultLimit" NOT IN (8, 16)
        ELSE NEW."resultLimit" IS DISTINCT FROM 8
      END
    )
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
        OR knowledge_run.outcome NOT IN (
          'complete', 'base_empty', 'base_indexing', 'no_relevant_evidence'
        )
        OR char_length(btrim(knowledge_run.query, E' \n')) NOT BETWEEN 1 AND 3000
        OR translate(knowledge_run.query, chr(10), '') ~ '[[:cntrl:]]'
        OR knowledge_run."candidateLimit" IS DISTINCT FROM 64
        OR knowledge_run.fusion IS DISTINCT FROM 'weighted_rrf_v2'
        OR (
          NEW."toolName" = 'knowledge_focused_v1'
          AND knowledge_run."resultLimit" NOT IN (8, 16)
        )
        OR (
          NEW."toolName" = 'search_knowledge'
          AND CASE
            WHEN NOT NEW.arguments ? 'sourceAliases'
              THEN knowledge_run."resultLimit" IS DISTINCT FROM 8
            WHEN jsonb_typeof(NEW.arguments -> 'sourceAliases') IS DISTINCT FROM 'array'
              THEN true
            WHEN jsonb_array_length(NEW.arguments -> 'sourceAliases') > 32
              THEN true
            WHEN jsonb_array_length(NEW.arguments -> 'sourceAliases') = 0
              THEN knowledge_run."resultLimit" NOT IN (8, 16)
            ELSE knowledge_run."resultLimit" IS DISTINCT FROM 8
          END
        )
      )
  ) THEN
    RAISE EXCEPTION 'knowledge_basic_focused_run_contract_invalid';
  END IF;
  RETURN NEW;
END
$function$;
