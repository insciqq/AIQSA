ALTER TABLE "MemoryExecutionBinding"
  ADD COLUMN "mutationAuthorizationId" TEXT;

DROP INDEX IF EXISTS "MemoryExecutionBinding_mutation_authorization_ordinal_idx";
CREATE UNIQUE INDEX "MemoryExecutionBinding_mutation_authorization_ordinal_idx"
  ON "MemoryExecutionBinding"(
    "userId", "mutationAuthorizationId", "logicalRole", "ordinal"
  )
  WHERE "ownerType" = 'MUTATION_AUTHORIZATION'::"MemoryExecutionOwnerType";

CREATE INDEX "MemoryExecutionBinding_userId_mutationAuthorizationId_ordin_idx"
  ON "MemoryExecutionBinding"("userId", "mutationAuthorizationId", "ordinal");

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
        "mutationAuthorizationId"
      ) = 0
      OR "ownerType" = 'RETRIEVAL_ATTEMPT'::"MemoryExecutionOwnerType"
      AND "retrievalAttemptId" IS NOT NULL
      AND num_nonnulls(
        "memoryJobId", "modelRunId", "modelRunToolCallId",
        "mutationAuthorizationId"
      ) = 0
      OR "ownerType" = 'MODEL_RUN_TOOL_CALL'::"MemoryExecutionOwnerType"
      AND num_nonnulls("modelRunId", "modelRunToolCallId") = 2
      AND num_nonnulls(
        "memoryJobId", "retrievalAttemptId", "mutationAuthorizationId"
      ) = 0
      OR "ownerType" = 'MUTATION_AUTHORIZATION'::"MemoryExecutionOwnerType"
      AND "mutationAuthorizationId" IS NOT NULL
      AND num_nonnulls(
        "memoryJobId", "retrievalAttemptId", "modelRunId", "modelRunToolCallId"
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

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "safetyClassifierExecutionId" TEXT;

ALTER TABLE "MemoryFactVersion"
  ALTER COLUMN "safetyClassificationState" SET DEFAULT 'PENDING',
  ALTER COLUMN "safetyClassifierProviderId" DROP DEFAULT,
  ALTER COLUMN "safetyClassifierModelId" DROP DEFAULT,
  ALTER COLUMN "safetyClassifierPolicyVersion" DROP DEFAULT,
  ALTER COLUMN "safetyClassifiedAt" DROP DEFAULT;

CREATE INDEX "MemoryFactVersion_userId_safetyClassifierExecutionId_idx"
  ON "MemoryFactVersion"("userId", "safetyClassifierExecutionId");

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_safety_execution_fkey"
  FOREIGN KEY ("userId", "safetyClassifierExecutionId")
  REFERENCES "MemoryExecutionBinding"("userId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_safety_provenance_check" CHECK (
    (
      "safetyClassificationState" = 'PENDING'::"MemorySafetyClassificationState"
      AND num_nonnulls(
        "safetyClassifierExecutionId", "safetyClassifierProviderId",
        "safetyClassifierModelId", "safetyClassifierPolicyVersion",
        "safetyClassificationReasonCode", "safetyClassifiedAt"
      ) = 0
    )
    OR (
      "safetyClassificationState" <> 'PENDING'::"MemorySafetyClassificationState"
      AND num_nonnulls(
        "safetyClassifierExecutionId", "safetyClassifierProviderId",
        "safetyClassifierModelId",
        "safetyClassifierPolicyVersion", "safetyClassificationReasonCode",
        "safetyClassifiedAt"
      ) = 6
    )
    OR (
      "safetyClassificationState" =
        'SECRET_FENCED'::"MemorySafetyClassificationState"
      AND "safetyClassifierExecutionId" IS NULL
      AND "safetyClassifierProviderId" = 'aiqsa-local-policy'
      AND "safetyClassifierModelId" = 'format-aware-secret-parser-v1'
      AND "safetyClassifierPolicyVersion" = 'memory-local-secret-parser-v1'
      AND "safetyClassificationReasonCode" = 'secret_material'
      AND "safetyClassifiedAt" IS NOT NULL
    )
  ) NOT VALID;

-- Keep the backfill as the final statement in this transaction. Updating a
-- fact version queues deferred bitemporal trigger events, after which
-- PostgreSQL rejects further DDL on this table. The following migration
-- validates the already-enforced constraint in a fresh transaction.
-- A placeholder tuple is not historical evidence. Fence every such row (and
-- every older CLASSIFIED row lacking complete provenance) until the governed
-- reclassification worker supplies a real decision.
UPDATE "MemoryFactVersion"
SET
  "safetyClassificationState" = 'PENDING',
  "safetyClassifierExecutionId" = NULL,
  "safetyClassifierProviderId" = NULL,
  "safetyClassifierModelId" = NULL,
  "safetyClassifierPolicyVersion" = NULL,
  "safetyClassificationReasonCode" = NULL,
  "safetyClassifiedAt" = NULL
WHERE "safetyClassificationState" <> 'PENDING'
  AND "safetyClassifierExecutionId" IS NULL
  AND NOT (
    "safetyClassificationState" = 'SECRET_FENCED'
    AND "safetyClassifierProviderId" = 'aiqsa-local-policy'
    AND "safetyClassifierModelId" = 'format-aware-secret-parser-v1'
    AND "safetyClassifierPolicyVersion" = 'memory-local-secret-parser-v1'
    AND "safetyClassificationReasonCode" = 'secret_material'
    AND "safetyClassifiedAt" IS NOT NULL
  );
