-- Distinguish ordinary run attribution, Knowledge batch markers, and Memory
-- per-call attribution. Memory rows retain their exact deployment snapshot
-- without becoming run usage or impersonating a Knowledge batch.
ALTER TABLE "UsageEvent"
  DROP CONSTRAINT "UsageEvent_knowledge_shape_check";

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
    (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
    )
    OR (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NOT NULL
      AND "knowledgeIndexGenerationId" IS NOT NULL
      AND "knowledgeDocumentVersionId" IS NOT NULL
      AND "knowledgeBatchIndex" >= 0
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
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
  );
