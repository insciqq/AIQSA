-- Lookups of one Assistant's references use indexes instead of scanning chats
-- and runs: deletion (the chat count, the deleted marker update and both
-- ON DELETE SET NULL foreign keys) and the 30-day recent chat count.
BEGIN;

-- Most chats have no Assistant; every lookup compares assistantId for equality,
-- which implies IS NOT NULL, so the partial index serves all of them.
CREATE INDEX "Chat_assistantId_bound_idx" ON "Chat"("assistantId") WHERE "assistantId" IS NOT NULL;

-- The leading column keeps serving every lookup by assistantId alone.
DROP INDEX "ModelRun_assistantId_idx";
CREATE INDEX "ModelRun_assistantId_createdAt_idx" ON "ModelRun"("assistantId", "createdAt");

COMMIT;
