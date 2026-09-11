ALTER TABLE "MemoryJob" DROP CONSTRAINT "MemoryJob_shape_check";
ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_shape_check" CHECK (
  "attemptCount" >= 0 AND "memoryGenerationSnapshot" >= 0 AND "memoryRevisionSnapshot" >= 0
  AND (
    "chatId" IS NULL AND num_nonnulls("activeLeafMessageId", "branchGeneration", "sourceRevision") = 0
    OR num_nonnulls("chatId", "activeLeafMessageId", "branchGeneration", "sourceRevision", "sourceHash") = 5
      AND "branchGeneration" >= 0 AND "sourceRevision" >= 0
  )
  AND (
    state = 'CLAIMED'::"MemoryJobState"
      AND num_nonnulls("leaseToken", "leaseExpiresAt") = 2 AND "completedAt" IS NULL
    OR state IN ('QUEUED', 'WAITING_FOR_CONFIGURATION', 'WAITING_FOR_EGRESS_CONSENT', 'RETRYABLE_FAILED')
      AND num_nonnulls("leaseToken", "leaseExpiresAt", "completedAt") = 0
    OR state IN ('SUCCEEDED', 'TERMINAL_FAILED', 'STALE', 'CANCELLED')
      AND num_nonnulls("leaseToken", "leaseExpiresAt") = 0 AND "completedAt" IS NOT NULL
  )
  AND (state NOT IN ('WAITING_FOR_CONFIGURATION', 'WAITING_FOR_EGRESS_CONSENT') OR "nextAttemptAt" IS NULL)
);
