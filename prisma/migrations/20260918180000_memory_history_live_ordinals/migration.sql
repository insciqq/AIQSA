-- Historical projections retain their identities and references, but must not
-- reserve positions in the replacement projection. Keep live positions unique.
BEGIN;
DROP INDEX "MemoryRecallChunk_source_ordinal_key";
CREATE UNIQUE INDEX "MemoryRecallChunk_source_ordinal_key"
  ON "MemoryRecallChunk" (
    "userId", "chatId", "branchGeneration", "sourceRevisionAtCreation",
    "chunkingVersion", "sourceProjectionVersion", "chunkOrdinal"
  ) WHERE state IN ('ACTIVE'::"MemoryHistoryItemState", 'SUPPRESSED'::"MemoryHistoryItemState");
COMMIT;
