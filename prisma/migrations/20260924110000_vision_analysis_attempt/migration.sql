ALTER TYPE "ProviderRunRole" ADD VALUE 'vision_analysis';

CREATE TABLE "VisionAnalysisAttempt" (
  "toolCallId" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "providerBindingKey" TEXT NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "images" JSONB NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'dispatched',
  "result" JSONB,
  "failureCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "VisionAnalysisAttempt_pkey" PRIMARY KEY ("toolCallId"),
  CONSTRAINT "VisionAnalysisAttempt_tool_fkey" FOREIGN KEY ("modelRunId", "toolCallId")
    REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "VisionAnalysisAttempt_binding_fkey" FOREIGN KEY ("modelRunId", "providerBindingKey")
    REFERENCES "ProviderRunBinding"("modelRunId", "bindingKey") ON DELETE NO ACTION ON UPDATE RESTRICT,
  CONSTRAINT "VisionAnalysisAttempt_binding_check" CHECK ("providerBindingKey" = 'vision_analysis'),
  CONSTRAINT "VisionAnalysisAttempt_state_check" CHECK ("state" IN ('dispatched', 'settled', 'ambiguous')),
  CONSTRAINT "VisionAnalysisAttempt_images_check" CHECK (jsonb_typeof("images") = 'array' AND jsonb_array_length("images") BETWEEN 1 AND 8),
  CONSTRAINT "VisionAnalysisAttempt_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "VisionAnalysisAttempt_modelRunId_createdAt_idx" ON "VisionAnalysisAttempt"("modelRunId", "createdAt");
CREATE UNIQUE INDEX "VisionAnalysisAttempt_modelRunId_toolCallId_key" ON "VisionAnalysisAttempt"("modelRunId", "toolCallId");
ALTER TABLE "UsageEvent" ADD COLUMN "visionAnalysis" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "visionAnalysisAttemptId" TEXT;
CREATE UNIQUE INDEX "UsageEvent_visionAnalysisAttemptId_key" ON "UsageEvent"("visionAnalysisAttemptId");
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_visionAnalysisAttemptId_fkey"
  FOREIGN KEY ("visionAnalysisAttemptId") REFERENCES "VisionAnalysisAttempt"("toolCallId") ON DELETE SET NULL ON UPDATE RESTRICT;
