CREATE TABLE "OptionalDecisionAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "modelRunId" TEXT,
  "purpose" VARCHAR(32) NOT NULL,
  "operationKey" VARCHAR(128) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "executionSnapshot" JSONB NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'dispatched',
  "answers" JSONB,
  "failureCode" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "OptionalDecisionAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "OptionalDecisionAttempt_userId_modelRunId_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "OptionalDecisionAttempt_purpose_check" CHECK (
    ("purpose" = 'mcp_discovery' AND "modelRunId" IS NOT NULL)
    OR ("purpose" = 'skill_suggestions' AND "modelRunId" IS NULL)
  ),
  CONSTRAINT "OptionalDecisionAttempt_input_check" CHECK ("inputHash" ~ '^[0-9a-f]{64}$' AND char_length("operationKey") BETWEEN 1 AND 128),
  CONSTRAINT "OptionalDecisionAttempt_state_check" CHECK (
    ("state" = 'dispatched' AND "answers" IS NULL AND "failureCode" IS NULL AND "settledAt" IS NULL)
    OR ("state" IN ('settled', 'ambiguous') AND "settledAt" IS NOT NULL
      AND ("answers" IS NULL OR ("state" = 'settled' AND "failureCode" IS NULL
        AND jsonb_typeof("answers") = 'object' AND pg_column_size("answers") <= 2097152)))
  )
);
CREATE UNIQUE INDEX "OptionalDecisionAttempt_userId_purpose_operationKey_key" ON "OptionalDecisionAttempt"("userId", "purpose", "operationKey");
CREATE INDEX "OptionalDecisionAttempt_userId_createdAt_idx" ON "OptionalDecisionAttempt"("userId", "createdAt");
CREATE INDEX "OptionalDecisionAttempt_userId_modelRunId_idx" ON "OptionalDecisionAttempt"("userId", "modelRunId");
ALTER TABLE "UsageEvent" ADD COLUMN "optionalDecision" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UsageEvent" ADD COLUMN "optionalDecisionAttemptId" TEXT;
CREATE UNIQUE INDEX "UsageEvent_optionalDecisionAttemptId_key" ON "UsageEvent"("optionalDecisionAttemptId");
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_optionalDecisionAttemptId_fkey" FOREIGN KEY ("optionalDecisionAttemptId") REFERENCES "OptionalDecisionAttempt"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_optional_decision_link_check" CHECK ("optionalDecisionAttemptId" IS NULL OR "optionalDecision");
ALTER TABLE "UsageEvent" DROP CONSTRAINT "UsageEvent_knowledge_shape_check";
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
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
);
CREATE FUNCTION guard_optional_decision_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."userId", NEW."modelRunId", NEW."purpose", NEW."operationKey", NEW."inputHash", NEW."executionSnapshot", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."userId", OLD."modelRunId", OLD."purpose", OLD."operationKey", OLD."inputHash", OLD."executionSnapshot", OLD."createdAt")
     OR OLD."state" = 'settled' AND NEW IS DISTINCT FROM OLD
     OR OLD."state" = 'ambiguous' AND (NEW."state" = 'dispatched' OR NEW."answers" IS NOT NULL)
  THEN RAISE EXCEPTION 'optional_decision_attempt_immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OptionalDecisionAttempt_immutable" BEFORE UPDATE ON "OptionalDecisionAttempt"
FOR EACH ROW EXECUTE FUNCTION guard_optional_decision_attempt();

CREATE FUNCTION validate_optional_decision_usage_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UsageEvent" u WHERE u."id" = NEW."id" AND u."optionalDecisionAttemptId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "OptionalDecisionAttempt" a
      LEFT JOIN "ModelRun" r ON r."id" = a."modelRunId" AND r."userId" = a."userId"
      LEFT JOIN "Chat" c ON c."id" = r."chatId"
      WHERE a."id" = u."optionalDecisionAttemptId" AND a."userId" = u."userId"
        AND a."modelRunId" IS NOT DISTINCT FROM u."modelRunId"
        AND r."chatId" IS NOT DISTINCT FROM u."chatId"
        AND c."projectId" IS NOT DISTINCT FROM u."projectId"
    )) THEN RAISE EXCEPTION 'optional_decision_usage_owner_mismatch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "UsageEvent_optional_decision_owner_check"
AFTER INSERT OR UPDATE ON "UsageEvent" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."optionalDecisionAttemptId" IS NOT NULL) EXECUTE FUNCTION validate_optional_decision_usage_owner();
