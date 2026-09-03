ALTER TABLE "MemoryExecutionBinding"
  ADD COLUMN "inboundMcpRequestId" TEXT;

CREATE UNIQUE INDEX "MemoryExecutionBinding_inbound_mcp_request_ordinal_idx"
  ON "MemoryExecutionBinding"(
    "userId", "inboundMcpRequestId", "logicalRole", "ordinal"
  )
  WHERE "ownerType" = 'INBOUND_MCP_REQUEST'::"MemoryExecutionOwnerType";

CREATE INDEX "MemoryExecutionBinding_user_inbound_mcp_ordinal_idx"
  ON "MemoryExecutionBinding"("userId", "inboundMcpRequestId", "ordinal");

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
        "totalTokens", "estimatedCostMicros"
      ) = 0
      OR "usageCompleteness" = 'PARTIAL'::"MemoryUsageCompleteness"
      AND num_nonnulls(
        "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens",
        "totalTokens", "estimatedCostMicros"
      ) > 0
      OR "usageCompleteness" = 'COMPLETE'::"MemoryUsageCompleteness"
      AND num_nonnulls(
        "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens",
        "totalTokens"
      ) = 5
    )
    AND COALESCE("inputTokens", 0) >= 0
    AND COALESCE("cachedInputTokens", 0) >= 0
    AND COALESCE("outputTokens", 0) >= 0
    AND COALESCE("reasoningTokens", 0) >= 0
    AND COALESCE("totalTokens", 0) >= 0
    AND COALESCE("estimatedCostMicros", 0) >= 0
  );
