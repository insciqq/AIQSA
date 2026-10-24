-- The native agent engine replaced the old run core (operator decision
-- 2026-10-23). Only the old core wrote Memory tool egress receipts; since 0.4.0
-- nothing writes them or reads them outside account deletion's counts, which
-- this release drops, so the table goes now with its two types. An account
-- deletion the previous release runs while Compose replaces it fails and is
-- retried by this release.
-- Receipts belonged to runs and their tool calls and leave nothing behind: no
-- other table or routine refers to them.
--
-- Dropping the table removes its foreign key triggers from `ModelRun` and
-- `ModelRunToolCall` under an exclusive lock, after locking the dropped table,
-- while a previous-release writer deleting a run locks the run before its
-- cascade reaches a receipt. Every lock is therefore taken up front, referenced
-- tables first, and a deadlock retries instead of failing the upgrade.
DO $migration$
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "ModelRun", "ModelRunToolCall", "MemoryToolEgressReceipt" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

DROP TABLE "MemoryToolEgressReceipt";

DROP TYPE "MemoryToolEgressMode";
DROP TYPE "MemoryToolEgressDispatchState";
