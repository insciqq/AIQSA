ALTER TYPE "ProviderRunRole" ADD VALUE 'image';
ALTER TYPE "ProviderModelClass" ADD VALUE 'image';
ALTER TYPE "AttachmentOrigin" ADD VALUE 'IMAGE_OUTPUT';

ALTER TABLE "SystemModelPolicy" ADD COLUMN "imageProviderModelId" TEXT,
  ADD COLUMN "imageParamsJson" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_imageProviderModelId_fkey"
  FOREIGN KEY ("imageProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SystemModelPolicy_imageProviderModelId_idx" ON "SystemModelPolicy"("imageProviderModelId");

ALTER TABLE "Attachment" ADD COLUMN "imageToolCallId" TEXT;
CREATE UNIQUE INDEX "Attachment_imageToolCallId_key" ON "Attachment"("imageToolCallId");
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_imageToolCallId_fkey"
  FOREIGN KEY ("producerModelRunId", "imageToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "UsageEvent" ADD COLUMN "imageToolCallId" TEXT;
CREATE UNIQUE INDEX "UsageEvent_imageToolCallId_key" ON "UsageEvent"("imageToolCallId");
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_imageToolCallId_fkey"
  FOREIGN KEY ("imageToolCallId") REFERENCES "ModelRunToolCall"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "UsageEvent" ADD COLUMN "imageGeneration" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_image_tool_pair_check" CHECK (
  ("origin"::text = 'IMAGE_OUTPUT') = ("imageToolCallId" IS NOT NULL)
  AND ("imageToolCallId" IS NULL OR ("producerModelRunId" IS NOT NULL AND "chatId" IS NOT NULL AND "messageId" IS NOT NULL AND "savedAt" IS NULL AND "kind" = 'image'))
);

-- Image receipts keep their separate purpose after a tool/run is removed.
ALTER TABLE "UsageEvent" DROP CONSTRAINT "UsageEvent_knowledge_shape_check";
ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
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
  );

CREATE FUNCTION image_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."imageGeneration" IS DISTINCT FROM OLD."imageGeneration" OR
    OLD."imageGeneration" AND (
      ROW(NEW."userId", NEW."provider", NEW."modelId", NEW."providerModelId",
        NEW."inputTokens", NEW."cachedInputTokens", NEW."cacheWriteInputTokens",
        NEW."outputTokens", NEW."reasoningTokens", NEW."totalTokens", NEW."estimatedCostMicros")
      IS DISTINCT FROM ROW(OLD."userId", OLD."provider", OLD."modelId", OLD."providerModelId",
        OLD."inputTokens", OLD."cachedInputTokens", OLD."cacheWriteInputTokens",
        OLD."outputTokens", OLD."reasoningTokens", OLD."totalTokens", OLD."estimatedCostMicros") OR
      (NEW."imageToolCallId" IS NOT NULL AND NEW."imageToolCallId" IS DISTINCT FROM OLD."imageToolCallId")
    )
  ) THEN RAISE EXCEPTION 'image_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."imageGeneration" AND NOT EXISTS (
    SELECT 1 FROM "ModelRunToolCall" t
    JOIN "ModelRun" r ON r."id" = t."modelRunId"
    JOIN "ProviderRunBinding" b ON b."modelRunId" = r."id" AND b."bindingKey" = 'image'
    WHERE t."id" = NEW."imageToolCallId" AND t."toolName" = 'generate_image'
      AND t."startedAt" IS NOT NULL AND r."id" = NEW."modelRunId"
      AND r."userId" = NEW."userId" AND r."chatId" = NEW."chatId"
      AND b."providerModelId" = NEW."providerModelId"
  ) THEN RAISE EXCEPTION 'image_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "UsageEvent_image_guard" BEFORE INSERT OR UPDATE ON "UsageEvent"
  FOR EACH ROW EXECUTE FUNCTION image_usage_guard();
