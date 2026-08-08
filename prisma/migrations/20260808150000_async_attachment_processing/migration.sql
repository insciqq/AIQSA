-- Extend attachment lifecycle state without changing the meaning of legacy rows.
ALTER TYPE "AttachmentStatus" ADD VALUE IF NOT EXISTS 'processing' BEFORE 'ready';
ALTER TYPE "AttachmentStatus" ADD VALUE IF NOT EXISTS 'failed' AFTER 'ready';

ALTER TABLE "Attachment"
  ADD COLUMN "processingErrorCode" VARCHAR(64),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "AttachmentProcessingJob" (
  "id" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "claimToken" TEXT,
  "claimedAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AttachmentProcessingJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttachmentProcessingJob_attachmentId_key"
  ON "AttachmentProcessingJob"("attachmentId");
CREATE INDEX "AttachmentProcessingJob_nextAttemptAt_claimedAt_createdAt_idx"
  ON "AttachmentProcessingJob"("nextAttemptAt", "claimedAt", "createdAt");

ALTER TABLE "AttachmentProcessingJob"
  ADD CONSTRAINT "AttachmentProcessingJob_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
