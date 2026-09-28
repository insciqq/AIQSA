ALTER TYPE "MemoryJobKind" ADD VALUE 'MEMORY_COMMAND';

CREATE TYPE "MemoryCommandStatus" AS ENUM ('PENDING', 'RUNNING', 'COMMITTED', 'REJECTED', 'AMBIGUOUS', 'FAILED', 'UNKNOWN', 'STALE');
CREATE TYPE "MemoryCommandOperation" AS ENUM ('UNKNOWN', 'SAVE', 'UPDATE', 'FORGET');

ALTER TABLE "MemoryJob"
  ADD COLUMN "commandSequence" INTEGER,
  ADD COLUMN "commandStatus" "MemoryCommandStatus",
  ADD COLUMN "commandOperation" "MemoryCommandOperation",
  ADD COLUMN "commandIntent" JSONB,
  ADD COLUMN "commandResult" JSONB;

CREATE UNIQUE INDEX "MemoryJob_userId_commandSequence_key" ON "MemoryJob" ("userId", "commandSequence");

-- Text comparison permits a single migration to add and constrain the enum
-- value without using that new enum value before its transaction commits.
ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_command_shape_check" CHECK (
  ("kind"::text = 'MEMORY_COMMAND'
    AND "commandSequence" IS NOT NULL AND "commandSequence" > 0
    AND "commandStatus" IS NOT NULL AND "commandOperation" IS NOT NULL
    AND "chatId" IS NOT NULL AND "sourceMessageId" IS NOT NULL)
  OR ("kind"::text <> 'MEMORY_COMMAND'
    AND num_nonnulls("commandSequence", "commandStatus", "commandOperation", "commandIntent", "commandResult") = 0)
);

CREATE INDEX "MemoryJob_command_pending_owner_idx" ON "MemoryJob" ("userId", "commandSequence")
  WHERE "commandSequence" IS NOT NULL AND "state" IN ('QUEUED', 'CLAIMED', 'RETRYABLE_FAILED', 'WAITING_FOR_CONFIGURATION');

CREATE FUNCTION aiqsa_memory_command_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."kind"::text = 'MEMORY_COMMAND' AND (
    NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."commandSequence" IS DISTINCT FROM OLD."commandSequence"
    OR NEW."chatId" IS DISTINCT FROM OLD."chatId"
    OR NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId"
    OR NEW."activeLeafMessageId" IS DISTINCT FROM OLD."activeLeafMessageId"
    OR NEW."sourceRevision" IS DISTINCT FROM OLD."sourceRevision"
    OR NEW."sourceHash" IS DISTINCT FROM OLD."sourceHash"
    OR NEW."branchGeneration" IS DISTINCT FROM OLD."branchGeneration"
    OR NEW."pipelineVersion" IS DISTINCT FROM OLD."pipelineVersion"
    OR NEW."idempotencyFingerprint" IS DISTINCT FROM OLD."idempotencyFingerprint"
  ) THEN
    RAISE EXCEPTION 'memory_command_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryJob_command_identity_guard"
BEFORE UPDATE ON "MemoryJob"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_command_identity_guard();
