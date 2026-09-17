ALTER TABLE "MemoryJob"
  ADD COLUMN "recoveryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastRecoveryAt" TIMESTAMP(3),
  ADD COLUMN "recoveryErrorCode" VARCHAR(64),
  ADD COLUMN "progressAt" TIMESTAMP(3);

ALTER TABLE "MemoryDeletionOutbox" ADD COLUMN "progressAt" TIMESTAMP(3);
ALTER TABLE "MemoryWorkerHeartbeat" ADD COLUMN "ready" BOOLEAN NOT NULL DEFAULT true;

-- Old updatedAt values may be renewable lease heartbeats, not progress.
-- Only a settled outcome supplies reliable historical progress evidence.
UPDATE "MemoryJob" SET "progressAt" = "completedAt" WHERE "completedAt" IS NOT NULL;
UPDATE "MemoryDeletionOutbox" SET "progressAt" = "completedAt" WHERE "completedAt" IS NOT NULL;

ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_recovery_shape_check" CHECK (
  "recoveryCount" >= 0 AND (
    "recoveryCount" = 0 AND "lastRecoveryAt" IS NULL AND "recoveryErrorCode" IS NULL
    OR "recoveryCount" > 0 AND "lastRecoveryAt" IS NOT NULL AND "recoveryErrorCode" IS NOT NULL
  )
);
