BEGIN;

ALTER TABLE "MemoryDeletionOutbox"
  DROP CONSTRAINT "MemoryDeletionOutbox_shape_check",
  ADD CONSTRAINT "MemoryDeletionOutbox_shape_check"
    CHECK (
      "memoryGeneration" >= 0
      AND "attemptCount" >= 0
      AND (
        ("state" = 'RUNNING' AND num_nonnulls("leaseToken", "leaseExpiresAt") = 2 AND "completedAt" IS NULL)
        OR ("state" IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN') AND num_nonnulls("leaseToken", "leaseExpiresAt", "completedAt") = 0)
        OR ("state" = 'SUCCEEDED' AND num_nonnulls("leaseToken", "leaseExpiresAt") = 0 AND "completedAt" IS NOT NULL AND "lastAuditAt" IS NOT NULL)
        OR ("state" = 'CANCELLED' AND num_nonnulls("leaseToken", "leaseExpiresAt", "nextAttemptAt") = 0 AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
      )
    );

COMMIT;
