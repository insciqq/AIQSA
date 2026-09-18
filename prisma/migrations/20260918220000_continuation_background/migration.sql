ALTER TABLE "ChatContinuation"
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "completedParts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "progressStage" VARCHAR(16) NOT NULL DEFAULT 'preparing',
  ADD CONSTRAINT "ChatContinuation_progress_check" CHECK (
    "completedParts" >= 0 AND "progressStage" IN ('preparing', 'summarizing', 'combining')
  );

CREATE TABLE "ChatContinuationStep" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "continuationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "summary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatContinuationStep_state_check" CHECK (
    "requestHash" ~ '^[a-f0-9]{64}$' AND (
      ("status" = 'complete' AND "summary" IS NOT NULL AND char_length("summary") BETWEEN 1 AND 8192) OR
      ("status" IN ('dispatched', 'failed', 'unknown') AND "summary" IS NULL)
    )
  ),
  CONSTRAINT "ChatContinuationStep_continuationId_fkey" FOREIGN KEY ("continuationId")
    REFERENCES "ChatContinuation"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ChatContinuationStep_continuationId_requestHash_key"
  ON "ChatContinuationStep"("continuationId", "requestHash");
