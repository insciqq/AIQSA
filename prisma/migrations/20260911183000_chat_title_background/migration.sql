ALTER TABLE "Chat" ADD COLUMN "titleRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "ChatTitleGenerationStatus" AS ENUM ('pending', 'dispatched', 'settled', 'skipped', 'ambiguous');

CREATE TABLE "ChatTitleGeneration" (
    "runId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expectedTitle" TEXT NOT NULL,
    "titleRevision" INTEGER NOT NULL,
    "questionText" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "reasoningEffort" TEXT,
    "providerSnapshot" JSONB,
    "status" "ChatTitleGenerationStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "ChatTitleGeneration_pkey" PRIMARY KEY ("runId"),
    CONSTRAINT "ChatTitleGeneration_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "ChatTitleGeneration_userId_chatId_runId_fkey" FOREIGN KEY ("userId", "chatId", "runId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ChatTitleGeneration_chatId_key" ON "ChatTitleGeneration"("chatId");
CREATE UNIQUE INDEX "ChatTitleGeneration_userId_chatId_runId_key" ON "ChatTitleGeneration"("userId", "chatId", "runId");
CREATE INDEX "ChatTitleGeneration_status_createdAt_idx" ON "ChatTitleGeneration"("status", "createdAt");

ALTER TABLE "UsageEvent" ADD COLUMN "chatTitleGeneration" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "chatTitleGenerationId" TEXT;
CREATE UNIQUE INDEX "UsageEvent_chatTitleGenerationId_key" ON "UsageEvent"("chatTitleGenerationId");
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_chatTitleGenerationId_fkey" FOREIGN KEY ("chatTitleGenerationId") REFERENCES "ChatTitleGeneration"("runId") ON DELETE SET NULL ON UPDATE RESTRICT;

-- Purpose survives removal of the owning chat/run; a paid receipt is retained.
ALTER TABLE "UsageEvent" DROP CONSTRAINT "UsageEvent_knowledge_shape_check";
ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
    (NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL AND (
    (NOT "imageGeneration" AND "imageToolCallId" IS NULL AND (
    (NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL AND (
    (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL
    )
    OR (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NOT NULL
      AND "knowledgeIndexGenerationId" IS NOT NULL
      AND "knowledgeDocumentVersionId" IS NOT NULL
      AND "knowledgeBatchIndex" >= 0
      AND "knowledgePdfProcessingAttemptId" IS NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    OR (
      "memoryExecutionBindingId" IS NOT NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    OR (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NOT NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    )) OR (
      "chatPdfPreparation" AND "providerModelId" IS NOT NULL
      AND "memoryExecutionBindingId" IS NULL AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL AND "knowledgePdfProcessingAttemptId" IS NULL
    )
    )) OR (
      "imageGeneration" AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
      AND "providerModelId" IS NOT NULL AND "memoryExecutionBindingId" IS NULL
      AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL
    )
    )) OR (
      "chatTitleGeneration" AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
      AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
      AND "providerModelId" IS NOT NULL AND "memoryExecutionBindingId" IS NULL
      AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL AND "projectId" IS NULL
    )
  );

CREATE FUNCTION chat_title_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."chatTitleGeneration" IS DISTINCT FROM OLD."chatTitleGeneration" OR
    OLD."chatTitleGeneration" AND (
      ROW(NEW."userId", NEW."provider", NEW."modelId", NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId", OLD."provider", OLD."modelId", OLD."providerModelId") OR
      (NEW."chatTitleGenerationId" IS NOT NULL AND NEW."chatTitleGenerationId" IS DISTINCT FROM OLD."chatTitleGenerationId") OR
      (OLD."inputTokens" IS NOT NULL AND
        ROW(NEW."inputTokens", NEW."cachedInputTokens", NEW."cacheWriteInputTokens", NEW."outputTokens",
          NEW."reasoningTokens", NEW."totalTokens", NEW."estimatedCostMicros") IS DISTINCT FROM
        ROW(OLD."inputTokens", OLD."cachedInputTokens", OLD."cacheWriteInputTokens", OLD."outputTokens",
          OLD."reasoningTokens", OLD."totalTokens", OLD."estimatedCostMicros"))
    )
  ) THEN RAISE EXCEPTION 'chat_title_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."chatTitleGeneration" AND NOT EXISTS (
    SELECT 1 FROM "ChatTitleGeneration" title
    WHERE title."runId" = NEW."chatTitleGenerationId" AND title."runId" = NEW."modelRunId"
      AND title."status" = 'dispatched' AND title."userId" = NEW."userId" AND title."chatId" = NEW."chatId"
      AND title."providerSnapshot"->>'providerModelId' = NEW."providerModelId"
      AND title."providerSnapshot"->>'providerFamily' = NEW."provider"
      AND title."providerSnapshot"->'model'->>'upstreamModelId' = NEW."modelId"
  ) THEN RAISE EXCEPTION 'chat_title_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "UsageEvent_chat_title_guard" BEFORE INSERT OR UPDATE ON "UsageEvent"
  FOR EACH ROW EXECUTE FUNCTION chat_title_usage_guard();
