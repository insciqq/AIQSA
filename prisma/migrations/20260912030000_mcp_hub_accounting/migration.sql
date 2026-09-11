ALTER TABLE "McpHubDispatch"
  ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
  ADD CONSTRAINT "McpHubDispatch_resource_check" CHECK ("resourcePath" = '/mcp/hub');
CREATE INDEX "McpHubDispatch_state_expiresAt_idx" ON "McpHubDispatch"("state", "expiresAt");

CREATE TABLE "McpHubDiscoveryAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "clientId" VARCHAR(2048) NOT NULL,
  "grantId" VARCHAR(64) NOT NULL,
  "resourcePath" VARCHAR(32) NOT NULL DEFAULT '/mcp/hub',
  "connectionId" TEXT NOT NULL,
  "providerModelId" TEXT NOT NULL,
  "credentialVersionId" TEXT NOT NULL,
  "state" "McpHubDispatchState" NOT NULL DEFAULT 'DISPATCHED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
  "completedAt" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "McpHubDiscoveryAttempt_resource_check" CHECK ("resourcePath" = '/mcp/hub'),
  CONSTRAINT "McpHubDiscoveryAttempt_state_check" CHECK (
    ("state" = 'DISPATCHED' AND "completedAt" IS NULL)
    OR ("state" IN ('COMPLETE', 'ERROR', 'UNKNOWN') AND "completedAt" IS NOT NULL)
  )
);
CREATE INDEX "McpHubDiscoveryAttempt_userId_createdAt_idx" ON "McpHubDiscoveryAttempt"("userId", "createdAt");
CREATE INDEX "McpHubDiscoveryAttempt_state_expiresAt_idx" ON "McpHubDiscoveryAttempt"("state", "expiresAt");
CREATE INDEX "McpHubDiscoveryAttempt_createdAt_idx" ON "McpHubDiscoveryAttempt"("createdAt");

ALTER TABLE "UsageEvent"
  ADD COLUMN "mcpHubDiscovery" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mcpHubDiscoveryAttemptId" TEXT,
  ADD CONSTRAINT "UsageEvent_mcpHubDiscoveryAttemptId_fkey"
    FOREIGN KEY ("mcpHubDiscoveryAttemptId") REFERENCES "McpHubDiscoveryAttempt"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  ADD CONSTRAINT "UsageEvent_mcpHubDiscovery_check" CHECK (
    ("mcpHubDiscoveryAttemptId" IS NULL OR "mcpHubDiscovery")
    AND (NOT "mcpHubDiscovery" OR ("chatId" IS NULL AND "modelRunId" IS NULL AND "projectId" IS NULL))
  );
CREATE UNIQUE INDEX "UsageEvent_mcpHubDiscoveryAttemptId_key" ON "UsageEvent"("mcpHubDiscoveryAttemptId");

-- Preserve every existing usage purpose and add only the independent Hub lane.
ALTER TABLE "UsageEvent" DROP CONSTRAINT "UsageEvent_knowledge_shape_check";
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
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
);
