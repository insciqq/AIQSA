-- Knowledge search infrastructure failures are durable, content-free
-- automatic-search receipts. Historical rows remain untouched.
ALTER TYPE "KnowledgeRunOutcome"
  ADD VALUE IF NOT EXISTS 'search_unavailable';

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_search_unavailable_shape_check" CHECK (
    outcome::text IS DISTINCT FROM 'search_unavailable'
    OR (
      operation IS NOT DISTINCT FROM 'automatic_search'
      AND query IS NOT DISTINCT FROM 'knowledge_search_unavailable'
      AND "candidateCount" IS NOT DISTINCT FROM 0
      AND "baseEvidence" IS NOT DISTINCT FROM '[]'::jsonb
      AND "budgetEvidence" IS NOT DISTINCT FROM '{}'::jsonb
      AND results IS NOT DISTINCT FROM '[]'::jsonb
      AND "providerText" IS NOT DISTINCT FROM
        'Knowledge search is temporarily unavailable. Do not infer or invent an answer from Knowledge.'
      AND jsonb_typeof("embeddingUsage") IS NOT DISTINCT FROM 'array'
      AND "lexicalBackendEvidence" IS NULL
      AND "readReceipt" IS NULL
      AND "failureCode" IS NOT NULL
      AND "failureCode" IN (
        'knowledge_search_backend_unavailable',
        'knowledge_search_projection_unavailable'
      )
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_search_unavailable_shape_check";

CREATE TABLE "KnowledgeSearchWorkerHeartbeat" (
  "id" varchar(64) NOT NULL,
  "instanceId" varchar(128) NOT NULL,
  "startedAt" timestamp(3) NOT NULL,
  "lastSeenAt" timestamp(3) NOT NULL,
  CONSTRAINT "KnowledgeSearchWorkerHeartbeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeSearchWorkerHeartbeat_singleton_check"
    CHECK ("id" = 'installation'),
  CONSTRAINT "KnowledgeSearchWorkerHeartbeat_clock_check"
    CHECK ("lastSeenAt" >= "startedAt")
);

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
    OR NEW.outcome::text NOT IN (
      'complete', 'base_empty', 'base_indexing', 'no_relevant_evidence',
      'search_unavailable'
    )
    OR char_length(btrim(NEW.query, E' \n')) NOT BETWEEN 1 AND 3000
    OR translate(NEW.query, chr(10), '') ~ '[[:cntrl:]]'
    OR NEW."candidateLimit" IS DISTINCT FROM 64
    OR NEW.fusion IS DISTINCT FROM 'weighted_rrf_v2'
    OR (
      NEW.outcome::text = 'search_unavailable'
      AND (
        NEW."candidateCount" IS DISTINCT FROM 0
        OR NEW.query IS DISTINCT FROM 'knowledge_search_unavailable'
        OR NEW."baseEvidence" IS DISTINCT FROM '[]'::jsonb
        OR NEW."budgetEvidence" IS DISTINCT FROM '{}'::jsonb
        OR NEW.results IS DISTINCT FROM '[]'::jsonb
        OR NEW."providerText" IS DISTINCT FROM
          'Knowledge search is temporarily unavailable. Do not infer or invent an answer from Knowledge.'
        OR jsonb_typeof(NEW."embeddingUsage") IS DISTINCT FROM 'array'
        OR NEW."lexicalBackendEvidence" IS NOT NULL
        OR NEW."readReceipt" IS NOT NULL
        OR NEW."failureCode" IS NULL
        OR NEW."failureCode" NOT IN (
          'knowledge_search_backend_unavailable',
          'knowledge_search_projection_unavailable'
        )
      )
    )
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
        OR knowledge_run.outcome::text NOT IN (
          'complete', 'base_empty', 'base_indexing', 'no_relevant_evidence',
          'search_unavailable'
        )
        OR char_length(btrim(knowledge_run.query, E' \n')) NOT BETWEEN 1 AND 3000
        OR translate(knowledge_run.query, chr(10), '') ~ '[[:cntrl:]]'
        OR knowledge_run."candidateLimit" IS DISTINCT FROM 64
        OR knowledge_run.fusion IS DISTINCT FROM 'weighted_rrf_v2'
        OR (
          knowledge_run.outcome::text = 'search_unavailable'
          AND (
            knowledge_run."candidateCount" IS DISTINCT FROM 0
            OR knowledge_run.query IS DISTINCT FROM 'knowledge_search_unavailable'
            OR knowledge_run."baseEvidence" IS DISTINCT FROM '[]'::jsonb
            OR knowledge_run."budgetEvidence" IS DISTINCT FROM '{}'::jsonb
            OR knowledge_run.results IS DISTINCT FROM '[]'::jsonb
            OR knowledge_run."providerText" IS DISTINCT FROM
              'Knowledge search is temporarily unavailable. Do not infer or invent an answer from Knowledge.'
            OR jsonb_typeof(knowledge_run."embeddingUsage") IS DISTINCT FROM 'array'
            OR knowledge_run."lexicalBackendEvidence" IS NOT NULL
            OR knowledge_run."readReceipt" IS NOT NULL
            OR knowledge_run."failureCode" IS NULL
            OR knowledge_run."failureCode" NOT IN (
              'knowledge_search_backend_unavailable',
              'knowledge_search_projection_unavailable'
            )
          )
        )
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
