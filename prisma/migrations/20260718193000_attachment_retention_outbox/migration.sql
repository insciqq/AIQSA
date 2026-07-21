-- Purpose-built durable outbox for private attachment object deletion.
-- Attachment rows are removed only in the same transaction that creates a job.
CREATE TABLE "AttachmentDeletionJob" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentDeletionJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttachmentDeletionJob_storageKey_key"
ON "AttachmentDeletionJob"("storageKey");

CREATE INDEX "AttachmentDeletionJob_claimedAt_createdAt_idx"
ON "AttachmentDeletionJob"("claimedAt", "createdAt");

CREATE INDEX "Attachment_storageKey_idx" ON "Attachment"("storageKey");

CREATE INDEX "AuthFlowToken_consumedAt_idx" ON "AuthFlowToken"("consumedAt");
