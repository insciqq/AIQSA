BEGIN;

-- The old path discarded answer text. Do not invent output or replay a
-- provider request whose accepted execution may already have happened.
CREATE TEMP TABLE legacy_grounded_runs ON COMMIT DROP AS
SELECT run."id", run."assistantMessageId"
FROM "ModelRun" run JOIN "Message" message ON message."id" = run."assistantMessageId"
WHERE message."groundedAt" IS NOT NULL
  AND run."status" NOT IN ('complete', 'cancelled');

UPDATE "ModelRun" SET
  "status" = 'error',
  "errorPayload" = '{"code":"run_interrupted","message":"This interrupted answer could not be recovered. Please retry.","recoveryTerminal":true}',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM legacy_grounded_runs);

UPDATE "Message" SET "status" = 'error',
  "errorMessage" = 'This interrupted answer could not be recovered. Please retry.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "assistantMessageId" FROM legacy_grounded_runs)
  AND "status" IN ('queued', 'streaming');

-- Removing provenance changes the canonical source hash for every retained
-- chat. Old checkpoints must request a full rebuild, never relabel old proof.
UPDATE "ChatMemoryDigest" SET "state" = 'INVALIDATED',
  "invalidatedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
WHERE "state" = 'ACTIVE';
UPDATE "MemoryToolEvent" SET "state" = 'INVALIDATED',
  "invalidatedAt" = CURRENT_TIMESTAMP
WHERE "state" = 'ACTIVE';
UPDATE "ChatMemoryCheckpoint" SET
  "pipelineVersion" = 'memory-history-rebuild-required-v5', "status" = 'STALE',
  "updatedAt" = CURRENT_TIMESTAMP;

SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "Message" DROP CONSTRAINT "Message_grounding_provenance_check";
DROP INDEX "Message_groundingProvider_groundedAt_idx";
ALTER TABLE "Message" DROP COLUMN "groundedAt", DROP COLUMN "groundingProvider",
  DROP COLUMN "groundingStrategy";
ALTER TABLE "ChatMemoryCheckpoint" ALTER COLUMN "pipelineVersion"
  SET DEFAULT 'memory-history-incremental-v8';

-- Extend the installed source guards without copying their invariant bodies.
DO $migration$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('aiqsa_memory_assert_digest_sources(text)'::regprocedure);
  IF position('memory-history-source-projection-v5' IN definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected Memory digest source projection';
  END IF;
  EXECUTE replace(definition, '''memory-history-source-projection-v5''',
    '''memory-history-source-projection-v6''');
  definition := pg_get_functiondef('aiqsa_memory_assert_tool_event_source(text,text)'::regprocedure);
  IF position('memory-history-incremental-v7' IN definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected Memory tool source pipeline';
  END IF;
  EXECUTE replace(definition, '''memory-history-incremental-v7''',
    '''memory-history-incremental-v8''');
END;
$migration$;
COMMIT;
