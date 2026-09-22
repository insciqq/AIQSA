ALTER TABLE "AgentRunBinding"
  ADD COLUMN "generationAttemptId" TEXT,
  ADD COLUMN "generationToolsReleased" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "followupInterruptAt" TIMESTAMP(3);

ALTER TABLE "AgentProviderAttempt" ADD COLUMN "transportClosedAt" TIMESTAMP(3);
