-- Auxiliary Vision keeps its provider attribution after run/attempt retention.
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_vision_analysis_link_check"
  CHECK ("visionAnalysisAttemptId" IS NULL OR "visionAnalysis");
ALTER TABLE "UsageEvent" DROP CONSTRAINT "UsageEvent_knowledge_shape_check";
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
  (NOT "visionAnalysis" AND "visionAnalysisAttemptId" IS NULL AND (

  (NOT "optionalDecision" AND (
  (NOT "knowledgeRelevance" AND (
  (NOT "mcpHubDiscovery" AND (
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
  )) OR (
    "mcpHubDiscovery" AND "providerModelId" IS NOT NULL
    AND "memoryExecutionBindingId" IS NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
    AND "chatId" IS NULL AND "modelRunId" IS NULL AND "projectId" IS NULL
  )
)) OR (
    "knowledgeRelevance" AND "providerModelId" IS NOT NULL
    AND "memoryExecutionBindingId" IS NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "mcpHubDiscovery" AND "mcpHubDiscoveryAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
  )
)) OR (
    "optionalDecision" AND "providerModelId" IS NOT NULL
    AND "memoryExecutionBindingId" IS NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "knowledgeRelevance" AND "knowledgeRelevanceAttemptId" IS NULL
    AND NOT "mcpHubDiscovery" AND "mcpHubDiscoveryAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
  )
  )) OR (
    "visionAnalysis" AND "providerModelId" IS NOT NULL
    AND "memoryExecutionBindingId" IS NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "optionalDecision" AND "optionalDecisionAttemptId" IS NULL
    AND NOT "knowledgeRelevance" AND "knowledgeRelevanceAttemptId" IS NULL
    AND NOT "mcpHubDiscovery" AND "mcpHubDiscoveryAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
  )
);
