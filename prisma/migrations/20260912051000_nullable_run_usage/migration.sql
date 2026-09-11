-- Preserve reported evidence without treating legacy defaults as known zero.

ALTER TABLE "ModelRun"
  ALTER COLUMN "inputTokens" DROP NOT NULL, ALTER COLUMN "inputTokens" DROP DEFAULT,
  ALTER COLUMN "cachedInputTokens" DROP NOT NULL, ALTER COLUMN "cachedInputTokens" DROP DEFAULT,
  ALTER COLUMN "cacheWriteInputTokens" DROP NOT NULL, ALTER COLUMN "cacheWriteInputTokens" DROP DEFAULT,
  ALTER COLUMN "outputTokens" DROP NOT NULL, ALTER COLUMN "outputTokens" DROP DEFAULT,
  ALTER COLUMN "reasoningTokens" DROP NOT NULL, ALTER COLUMN "reasoningTokens" DROP DEFAULT,
  ALTER COLUMN "totalTokens" DROP NOT NULL, ALTER COLUMN "totalTokens" DROP DEFAULT,
  ALTER COLUMN "estimatedCostMicros" DROP NOT NULL, ALTER COLUMN "estimatedCostMicros" DROP DEFAULT;

ALTER TABLE "Message"
  ALTER COLUMN "inputTokens" DROP NOT NULL, ALTER COLUMN "inputTokens" DROP DEFAULT,
  ALTER COLUMN "outputTokens" DROP NOT NULL, ALTER COLUMN "outputTokens" DROP DEFAULT,
  ALTER COLUMN "reasoningTokens" DROP NOT NULL, ALTER COLUMN "reasoningTokens" DROP DEFAULT;

UPDATE "ModelRun" SET
  "inputTokens" = NULLIF("inputTokens", 0),
  "cachedInputTokens" = NULLIF("cachedInputTokens", 0),
  "cacheWriteInputTokens" = NULLIF("cacheWriteInputTokens", 0),
  "outputTokens" = NULLIF("outputTokens", 0),
  "reasoningTokens" = NULLIF("reasoningTokens", 0),
  "totalTokens" = NULLIF("totalTokens", 0),
  "estimatedCostMicros" = NULLIF("estimatedCostMicros", 0)
WHERE "usageCompleteness" = 'UNAVAILABLE';

UPDATE "ModelRun" SET "usageCompleteness" = 'PARTIAL'
WHERE "usageCompleteness" = 'UNAVAILABLE' AND ("inputTokens" IS NOT NULL OR "cachedInputTokens" IS NOT NULL OR "cacheWriteInputTokens" IS NOT NULL OR "outputTokens" IS NOT NULL OR "reasoningTokens" IS NOT NULL OR "totalTokens" IS NOT NULL);

UPDATE "UsageEvent" SET "usageCompleteness" = 'PARTIAL'
WHERE "usageCompleteness" = 'UNAVAILABLE' AND ("inputTokens" IS NOT NULL OR "cachedInputTokens" IS NOT NULL OR "cacheWriteInputTokens" IS NOT NULL OR "outputTokens" IS NOT NULL OR "reasoningTokens" IS NOT NULL OR "totalTokens" IS NOT NULL);

ALTER TABLE "MemoryExecutionBinding" ADD COLUMN "cacheWriteInputTokens" INTEGER;

ALTER TABLE "MemoryExecutionBinding"
  DROP CONSTRAINT "MemoryExecutionBinding_shape_check";

ALTER TABLE "MemoryExecutionBinding"
  ADD CONSTRAINT "MemoryExecutionBinding_shape_check" CHECK (
    ordinal >= 0
    AND (
      "ownerType" = 'JOB'::"MemoryExecutionOwnerType"
      AND "memoryJobId" IS NOT NULL
      AND num_nonnulls(
        "retrievalAttemptId", "modelRunId", "modelRunToolCallId",
        "mutationAuthorizationId", "inboundMcpRequestId"
      ) = 0
      OR "ownerType" = 'RETRIEVAL_ATTEMPT'::"MemoryExecutionOwnerType"
      AND "retrievalAttemptId" IS NOT NULL
      AND num_nonnulls(
        "memoryJobId", "modelRunId", "modelRunToolCallId",
        "mutationAuthorizationId", "inboundMcpRequestId"
      ) = 0
      OR "ownerType" = 'MODEL_RUN_TOOL_CALL'::"MemoryExecutionOwnerType"
      AND num_nonnulls("modelRunId", "modelRunToolCallId") = 2
      AND num_nonnulls(
        "memoryJobId", "retrievalAttemptId", "mutationAuthorizationId",
        "inboundMcpRequestId"
      ) = 0
      OR "ownerType" = 'MUTATION_AUTHORIZATION'::"MemoryExecutionOwnerType"
      AND "mutationAuthorizationId" IS NOT NULL
      AND num_nonnulls(
        "memoryJobId", "retrievalAttemptId", "modelRunId", "modelRunToolCallId",
        "inboundMcpRequestId"
      ) = 0
      OR "ownerType" = 'INBOUND_MCP_REQUEST'::"MemoryExecutionOwnerType"
      AND "inboundMcpRequestId" IS NOT NULL
      AND num_nonnulls(
        "memoryJobId", "retrievalAttemptId", "modelRunId", "modelRunToolCallId",
        "mutationAuthorizationId"
      ) = 0
    )
    AND (
      state = 'PENDING'::"MemoryExecutionState"
      AND num_nonnulls("startedAt", "completedAt") = 0
      OR state = 'RUNNING'::"MemoryExecutionState"
      AND "startedAt" IS NOT NULL AND "completedAt" IS NULL
      OR state = 'OUTCOME_UNKNOWN'::"MemoryExecutionState"
      AND num_nonnulls("startedAt", "completedAt") = 2
      OR state = ANY (ARRAY[
        'SUCCEEDED'::"MemoryExecutionState",
        'FAILED'::"MemoryExecutionState",
        'CANCELLED'::"MemoryExecutionState"
      ])
      AND "completedAt" IS NOT NULL
    )
    AND ("startedAt" IS NULL OR "startedAt" >= "createdAt")
    AND ("completedAt" IS NULL OR "completedAt" >= COALESCE("startedAt", "createdAt"))
    AND "providerId" IS NOT NULL
    AND (
      "relationsDetachedAt" IS NULL
      AND num_nonnulls(
        "connectionId", "providerModelId", "credentialId", "credentialVersionId"
      ) = 4
      OR "relationsDetachedAt" IS NOT NULL
      AND state = ANY (ARRAY[
        'SUCCEEDED'::"MemoryExecutionState",
        'FAILED'::"MemoryExecutionState",
        'CANCELLED'::"MemoryExecutionState"
      ])
      AND num_nonnulls(
        "connectionId", "providerModelId", "credentialId", "credentialVersionId",
        "providerResponseId"
      ) = 0
      AND "recoverableUntil" IS NOT NULL
      AND "recoverableUntil" <= "relationsDetachedAt"
    )
    AND (
      "usageCompleteness" = 'UNAVAILABLE'::"MemoryUsageCompleteness"
      AND num_nonnulls(
        "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens",
        "totalTokens", "cacheWriteInputTokens", "estimatedCostMicros"
      ) = 0
      OR "usageCompleteness" = 'PARTIAL'::"MemoryUsageCompleteness"
      AND num_nonnulls(
        "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens",
        "totalTokens", "cacheWriteInputTokens", "estimatedCostMicros"
      ) > 0
      OR "usageCompleteness" = 'COMPLETE'::"MemoryUsageCompleteness"
      AND num_nonnulls(
        "inputTokens", "outputTokens", "totalTokens"
      ) = 3
    )
    AND COALESCE("inputTokens", 0) >= 0
    AND COALESCE("cachedInputTokens", 0) >= 0
    AND COALESCE("cacheWriteInputTokens", 0) >= 0
    AND COALESCE("outputTokens", 0) >= 0
    AND COALESCE("reasoningTokens", 0) >= 0
    AND COALESCE("totalTokens", 0) >= 0
    AND COALESCE("estimatedCostMicros", 0) >= 0
  );

-- The previous release has no discriminator. During rolling replacement its
-- non-null counts remain usable but conservatively incomplete.
CREATE FUNCTION token_usage_legacy_writer_completeness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."usageCompleteness" = 'UNAVAILABLE' AND num_nonnulls(
    NEW."inputTokens", NEW."cachedInputTokens", NEW."cacheWriteInputTokens",
    NEW."outputTokens", NEW."reasoningTokens", NEW."totalTokens") > 0 THEN
    NEW."usageCompleteness" := 'PARTIAL';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ModelRun_usage_completeness" BEFORE INSERT OR UPDATE ON "ModelRun"
  FOR EACH ROW EXECUTE FUNCTION token_usage_legacy_writer_completeness();
CREATE TRIGGER "UsageEvent_usage_completeness" BEFORE INSERT OR UPDATE ON "UsageEvent"
  FOR EACH ROW EXECUTE FUNCTION token_usage_legacy_writer_completeness();

CREATE OR REPLACE FUNCTION chat_pdf_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."chatPdfPreparation" IS DISTINCT FROM OLD."chatPdfPreparation" OR
    OLD."chatPdfPreparation" AND (
      ((OLD."usageCompleteness" <> 'UNAVAILABLE' OR OLD."inputTokens" IS NOT NULL) AND
        ROW(NEW."inputTokens",NEW."cachedInputTokens",NEW."cacheWriteInputTokens",NEW."outputTokens",
          NEW."reasoningTokens",NEW."totalTokens",NEW."estimatedCostMicros",NEW."usageCompleteness") IS DISTINCT FROM
        ROW(OLD."inputTokens",OLD."cachedInputTokens",OLD."cacheWriteInputTokens",OLD."outputTokens",
          OLD."reasoningTokens",OLD."totalTokens",OLD."estimatedCostMicros",OLD."usageCompleteness")) OR
      ROW(NEW."userId",NEW."provider",NEW."modelId",NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId",OLD."provider",OLD."modelId",OLD."providerModelId") OR
      (NEW."chatPdfPageAttemptId" IS NOT NULL AND NEW."chatPdfPageAttemptId" IS DISTINCT FROM OLD."chatPdfPageAttemptId")
    )) THEN RAISE EXCEPTION 'chat_pdf_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."chatPdfPreparation" AND NOT EXISTS (
    SELECT 1 FROM "ChatPdfPageAttempt" a
    JOIN "ChatPdfAttachmentPreparation" p ON p."id" = a."preparationId"
    JOIN "ModelRun" r ON r."id" = p."modelRunId"
    WHERE a."id" = NEW."chatPdfPageAttemptId" AND a."state" = 'dispatched'
      AND p."providerModelId" = NEW."providerModelId" AND p."modelRunId" = NEW."modelRunId"
      AND r."userId" = NEW."userId" AND r."chatId" = NEW."chatId"
  ) THEN RAISE EXCEPTION 'chat_pdf_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION chat_title_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."chatTitleGeneration" IS DISTINCT FROM OLD."chatTitleGeneration" OR
    OLD."chatTitleGeneration" AND (
      ROW(NEW."userId", NEW."provider", NEW."modelId", NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId", OLD."provider", OLD."modelId", OLD."providerModelId") OR
      (NEW."chatTitleGenerationId" IS NOT NULL AND NEW."chatTitleGenerationId" IS DISTINCT FROM OLD."chatTitleGenerationId") OR
      ((OLD."usageCompleteness" <> 'UNAVAILABLE' OR OLD."inputTokens" IS NOT NULL) AND
        ROW(NEW."inputTokens", NEW."cachedInputTokens", NEW."cacheWriteInputTokens", NEW."outputTokens",
          NEW."reasoningTokens", NEW."totalTokens", NEW."estimatedCostMicros", NEW."usageCompleteness") IS DISTINCT FROM
        ROW(OLD."inputTokens", OLD."cachedInputTokens", OLD."cacheWriteInputTokens", OLD."outputTokens",
          OLD."reasoningTokens", OLD."totalTokens", OLD."estimatedCostMicros", OLD."usageCompleteness"))
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

ALTER TABLE "UsageEvent" ADD COLUMN "operationCount" INTEGER,
  ADD CONSTRAINT "UsageEvent_operation_count_check" CHECK ("operationCount" IS NULL OR "operationCount" > 0);
