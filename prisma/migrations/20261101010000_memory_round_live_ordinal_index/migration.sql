CREATE UNIQUE INDEX CONCURRENTLY "MemoryRecallRound_live_ordinal_key"
  ON "MemoryRecallRound" (
    "userId", "chatId", "branchGeneration", "sourceRevisionAtCreation",
    "projectionVersion", "sourceProjectionVersion", "roundOrdinal"
  ) WHERE state IN ('ACTIVE'::"MemoryHistoryItemState", 'SUPPRESSED'::"MemoryHistoryItemState");
