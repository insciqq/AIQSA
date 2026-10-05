-- History source purge and its audit select an owner's in-flight Memory
-- search receipts by state. Without this index that branch matches every
-- retained receipt of the owner, so the cited-chat index cannot narrow the
-- lookup. Built CONCURRENTLY as the only statement of this file so receipt
-- writers continue during the upgrade (Persistence, Migrations And Bootstrap).
CREATE INDEX CONCURRENTLY "MemoryHistoryRun_userId_state_idx"
  ON "MemoryHistoryRun"("userId", "state");
