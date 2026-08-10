-- Install the Phase 3 chat source-state authority without scheduling source
-- work or changing the behavior of existing chats. MemoryChatMode was created
-- feature-dark by the Phase 1 foundation migration.
BEGIN;

ALTER TABLE "Chat"
  ADD COLUMN "memoryMode" "MemoryChatMode" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "memoryBranchGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "memorySourceRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "temporaryRetentionPolicyVersion" VARCHAR(64),
  ADD COLUMN "temporaryRetentionDeadline" TIMESTAMP(3);

ALTER TABLE "Chat"
  ADD CONSTRAINT "Chat_memory_state_check"
  CHECK (
    "memoryBranchGeneration" >= 0
    AND "memorySourceRevision" >= 0
    AND (
      (
        "memoryMode" IN ('NORMAL', 'EXCLUDED')
        AND "temporaryRetentionPolicyVersion" IS NULL
        AND "temporaryRetentionDeadline" IS NULL
      )
      OR
      (
        "memoryMode" = 'TEMPORARY'
        AND "temporaryRetentionPolicyVersion" IS NOT NULL
        AND "temporaryRetentionPolicyVersion" = 'temporary-24h-v1'
        AND "temporaryRetentionDeadline" IS NOT NULL
        AND "temporaryRetentionDeadline" > "createdAt"
      )
    )
  );

CREATE INDEX "Chat_memoryMode_temporaryRetentionDeadline_idx"
  ON "Chat"("memoryMode", "temporaryRetentionDeadline");

CREATE FUNCTION aiqsa_chat_memory_mode_guard() RETURNS trigger
LANGUAGE plpgsql AS $chat_memory_mode_guard$
BEGIN
  IF NEW."memoryMode" IS DISTINCT FROM OLD."memoryMode"
     AND (OLD."memoryMode" = 'TEMPORARY' OR NEW."memoryMode" = 'TEMPORARY') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary chat mode is immutable after admission';
  END IF;

  IF OLD."memoryMode" = 'TEMPORARY'
     AND NEW."temporaryRetentionPolicyVersion"
         IS DISTINCT FROM OLD."temporaryRetentionPolicyVersion" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary retention policy is immutable after admission';
  END IF;

  RETURN NEW;
END
$chat_memory_mode_guard$;

CREATE TRIGGER "Chat_memory_mode_guard"
BEFORE UPDATE ON "Chat"
FOR EACH ROW EXECUTE FUNCTION aiqsa_chat_memory_mode_guard();

-- Rollback guidance: stop application and Memory workers, drop the trigger and
-- function, then drop the index, check, and five Chat columns. Keep
-- MemoryChatMode because the Phase 1 foundation owns that shared enum. Any
-- TEMPORARY row must first be handled under its accepted deletion obligation;
-- never coerce it into a retained NORMAL chat for rollback.

COMMIT;
