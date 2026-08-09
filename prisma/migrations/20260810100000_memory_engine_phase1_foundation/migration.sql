-- CreateEnum
CREATE TYPE "MemorySensitiveAutomaticPolicy" AS ENUM ('EXPLICIT_ONLY');

-- CreateEnum
CREATE TYPE "MemoryUiLocale" AS ENUM ('RU', 'EN');

-- CreateEnum
CREATE TYPE "MemoryScopeType" AS ENUM ('GLOBAL_USER', 'FOLDER', 'ASSISTANT', 'CHAT');

-- CreateEnum
CREATE TYPE "MemoryScopeState" AS ENUM ('ACTIVE', 'ORPHANED', 'RETRACTED');

-- CreateEnum
CREATE TYPE "MemoryFactState" AS ENUM ('ACTIVE', 'CONFLICTED', 'ORPHANED', 'EXPIRED', 'RETRACTED', 'FORGOTTEN');

-- CreateEnum
CREATE TYPE "MemoryTemperatureClass" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "MemoryFactVersionState" AS ENUM ('ACTIVE', 'CONFLICTING', 'ORPHANED', 'SUPERSEDED', 'EXPIRED', 'RETRACTED', 'FORGOTTEN');

-- CreateEnum
CREATE TYPE "MemoryFactModality" AS ENUM ('STATE', 'PREFERENCE', 'CONSTRAINT', 'CONSIDERATION', 'INTENTION', 'PLAN', 'EVENT', 'HABIT', 'WORKFLOW');

-- CreateEnum
CREATE TYPE "MemoryFactSourceMode" AS ENUM ('EXPLICIT', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "MemoryDirectness" AS ENUM ('DIRECT', 'PARAPHRASED', 'INFERRED');

-- CreateEnum
CREATE TYPE "MemorySensitivityClass" AS ENUM ('NORMAL', 'SENSITIVE', 'HIGHLY_SENSITIVE', 'SECRET');

-- CreateEnum
CREATE TYPE "MemoryEvidenceStance" AS ENUM ('SUPPORTS', 'CONTRADICTS');

-- CreateEnum
CREATE TYPE "MemoryEvidenceSourceType" AS ENUM ('MESSAGE', 'EXPLICIT_ACTION', 'EPISODE');

-- CreateEnum
CREATE TYPE "MemoryActorType" AS ENUM ('USER', 'SYSTEM', 'JOB');

-- CreateEnum
CREATE TYPE "MemoryEventOperation" AS ENUM ('EXPLICIT_SAVE', 'AUTO_PROPOSE', 'PROMOTE', 'REINFORCE', 'EDIT', 'SUPERSEDE', 'CONFLICT', 'EXPIRE', 'RETRACT', 'FORGET', 'SOURCE_INVALIDATE', 'SCOPE_CHANGE', 'PIN', 'UNPIN', 'USER_FEEDBACK', 'INDEX_SWITCH', 'REBUILD');

-- CreateEnum
CREATE TYPE "MemorySuppressionScope" AS ENUM ('FACT', 'VALUE', 'SOURCE_MESSAGE', 'SOURCE_EPISODE', 'CATEGORY', 'ALL');

-- CreateEnum
CREATE TYPE "MemorySourceBarrierKind" AS ENUM ('AUTOMATIC_FACTS', 'HISTORY_INDEX', 'ALL_REUSABLE');

-- CreateEnum
CREATE TYPE "MemoryJobKind" AS ENUM ('INDEX_HISTORY', 'EXTRACT_EPISODE', 'EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'EMBED_ITEMS', 'RECONCILE_BRANCH', 'RECONCILE_SOURCE', 'GLOBAL_DREAM', 'RECALCULATE_WORKING_SET', 'REBUILD_INDEX');

-- CreateEnum
CREATE TYPE "MemoryJobState" AS ENUM ('QUEUED', 'WAITING_FOR_EGRESS_CONSENT', 'CLAIMED', 'RETRYABLE_FAILED', 'SUCCEEDED', 'TERMINAL_FAILED', 'STALE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemoryExecutionOwnerType" AS ENUM ('JOB', 'RETRIEVAL_ATTEMPT', 'MODEL_RUN_TOOL_CALL');

-- CreateEnum
CREATE TYPE "MemoryExecutionState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "MemoryUsageCompleteness" AS ENUM ('UNAVAILABLE', 'PARTIAL', 'COMPLETE');

-- CreateEnum
CREATE TYPE "MemoryRetrievalAdmissionKind" AS ENUM ('NORMAL_SEND', 'REGENERATE');

-- CreateEnum
CREATE TYPE "MemoryUtilityEgressMode" AS ENUM ('LOCAL_ONLY', 'CONSENTED_EXTERNAL');

-- CreateEnum
CREATE TYPE "MemoryChatMode" AS ENUM ('NORMAL', 'EXCLUDED', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "MemoryRetrievalAttemptState" AS ENUM ('PENDING', 'EXECUTING', 'READY', 'CONSUMED', 'STALE', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MemoryReceiptOutcome" AS ENUM ('USED', 'EMPTY', 'DISABLED', 'DEGRADED', 'FAILED_SAFE');

-- CreateEnum
CREATE TYPE "MemorySearchItemType" AS ENUM ('FACT_VERSION');

-- CreateEnum
CREATE TYPE "MemoryDeletionOperation" AS ENUM ('FORGET_PURGE', 'SOURCE_PURGE', 'TEMPORARY_DELETE', 'BULK_CLEAR', 'ACCOUNT_MEMORY_DELETE');

-- CreateEnum
CREATE TYPE "MemoryDeletionState" AS ENUM ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN', 'SUCCEEDED');

-- CreateEnum
CREATE TYPE "MemoryMutationAction" AS ENUM ('SAVE', 'EDIT', 'MOVE_SCOPE', 'FORGET', 'BULK_DELETE');

-- CreateEnum
CREATE TYPE "MemoryOperationOutcome" AS ENUM ('APPLIED', 'NO_OP', 'REJECTED');

-- CreateEnum
CREATE TYPE "MemoryIndexGenerationState" AS ENUM ('BUILDING', 'CATCHING_UP', 'READY', 'ACTIVE', 'SUPERSEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemoryIndexMode" AS ENUM ('LEXICAL_ONLY', 'HYBRID');

-- CreateEnum
CREATE TYPE "MemoryEmbeddingState" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'READY', 'FAILED');

-- PREPARING is a durable admission state and participates in the existing
-- one-active-run fence. Prisma applies PostgreSQL migrations transactionally,
-- so recreate the enum instead of using a same-transaction ALTER TYPE ADD VALUE.
DROP INDEX "ModelRun_one_active_per_chat_idx";
DROP INDEX "ModelRun_status_idx";

ALTER TYPE "ModelRunStatus" RENAME TO "ModelRunStatus_pre_memory_p1";
CREATE TYPE "ModelRunStatus" AS ENUM (
  'preparing', 'queued', 'streaming', 'in_progress', 'complete', 'cancelled', 'error'
);
ALTER TABLE "ModelRun"
  ALTER COLUMN "status" TYPE "ModelRunStatus"
  USING ("status"::text::"ModelRunStatus");
DROP TYPE "ModelRunStatus_pre_memory_p1";
CREATE INDEX "ModelRun_status_idx" ON "ModelRun"("status");

-- Existing accepted runs predate the provider-preview invariant. Preserve them
-- with a bounded, content-free marker rather than inventing request content.
UPDATE "ModelRun"
SET "providerRequestPreview" = '{"unavailable":"legacy_pre_memory_phase1"}'::jsonb
WHERE "providerRequestPreview" IS NULL;

-- AlterTable
ALTER TABLE "ModelRun" ALTER COLUMN "normalizedRequest" DROP NOT NULL;

-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN     "memoryExecutionBindingId" TEXT;

-- CreateTable
CREATE TABLE "UserMemorySettings" (
    "userId" TEXT NOT NULL,
    "useMemoryFacts" BOOLEAN NOT NULL DEFAULT false,
    "referenceChatHistory" BOOLEAN NOT NULL DEFAULT false,
    "learnAutomatically" BOOLEAN NOT NULL DEFAULT false,
    "memoryGeneration" INTEGER NOT NULL DEFAULT 0,
    "memoryRevision" INTEGER NOT NULL DEFAULT 0,
    "activeIndexGenerationId" TEXT,
    "embeddingProviderModelId" TEXT,
    "sensitiveAutomaticPolicy" "MemorySensitiveAutomaticPolicy" NOT NULL DEFAULT 'EXPLICIT_ONLY',
    "memoryUiLocale" "MemoryUiLocale" NOT NULL DEFAULT 'RU',
    "preferredProfileLanguage" VARCHAR(35) NOT NULL DEFAULT 'AUTO',
    "memoryConsentRevision" INTEGER NOT NULL DEFAULT 0,
    "settingsRevision" INTEGER NOT NULL DEFAULT 0,
    "acceptedUtilityEgressFingerprint" VARCHAR(128),
    "acceptedUtilityPolicyVersion" VARCHAR(64),
    "acceptedUtilityEgressAt" TIMESTAMP(3),
    "lastGlobalDreamAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMemorySettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "MemoryScope" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeType" "MemoryScopeType" NOT NULL,
    "targetIdSnapshot" TEXT,
    "targetDisplaySnapshot" VARCHAR(256),
    "folderId" TEXT,
    "assistantId" TEXT,
    "chatId" TEXT,
    "state" "MemoryScopeState" NOT NULL DEFAULT 'ACTIVE',
    "orphanedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryFact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "canonicalKey" VARCHAR(256) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "state" "MemoryFactState" NOT NULL DEFAULT 'ACTIVE',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "movedToFactId" TEXT,
    "temperatureClass" "MemoryTemperatureClass" NOT NULL DEFAULT 'WARM',
    "temperatureScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "lastConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "forgottenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryFactVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "displayText" TEXT,
    "normalizedSearchText" TEXT,
    "languageCode" VARCHAR(35) NOT NULL,
    "structuredValue" JSONB,
    "category" VARCHAR(64) NOT NULL,
    "modality" "MemoryFactModality" NOT NULL,
    "sourceMode" "MemoryFactSourceMode" NOT NULL,
    "state" "MemoryFactVersionState" NOT NULL DEFAULT 'ACTIVE',
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "systemFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "systemTo" TIMESTAMP(3),
    "rawTemporalExpression" VARCHAR(512),
    "sourceTimezone" VARCHAR(64),
    "temporalResolverVersion" VARCHAR(64),
    "temporalResolutionEvidence" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL,
    "directness" "MemoryDirectness" NOT NULL,
    "sensitivityClass" "MemorySensitivityClass" NOT NULL,
    "supersedesVersionId" TEXT,
    "movedFromVersionId" TEXT,
    "createdByEventId" TEXT NOT NULL,
    "pipelineVersion" VARCHAR(64) NOT NULL,
    "contentPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryFactVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factVersionId" TEXT NOT NULL,
    "stance" "MemoryEvidenceStance" NOT NULL,
    "sourceType" "MemoryEvidenceSourceType" NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "episodeId" TEXT,
    "memoryEventId" TEXT,
    "branchGeneration" INTEGER,
    "sourceRole" VARCHAR(32),
    "safeExcerpt" TEXT NOT NULL,
    "safeSourceHash" VARCHAR(128) NOT NULL,
    "sourceProjectionVersion" VARCHAR(64) NOT NULL,
    "safetyClass" "MemorySensitivityClass" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operation" "MemoryEventOperation" NOT NULL,
    "actorType" "MemoryActorType" NOT NULL,
    "actorUserId" TEXT,
    "factId" TEXT,
    "factVersionId" TEXT,
    "sourceChatId" TEXT,
    "sourceGeneration" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorySuppression" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "MemorySuppressionScope" NOT NULL,
    "canonicalKeyHash" VARCHAR(128),
    "normalizedValueHash" VARCHAR(128),
    "sourceChatId" TEXT,
    "sourceMessageId" TEXT,
    "sourceEpisodeId" TEXT,
    "sourceBranchGeneration" INTEGER,
    "deletionGeneration" INTEGER NOT NULL,
    "fingerprintKeyVersion" VARCHAR(64) NOT NULL,
    "normalizationVersion" VARCHAR(64) NOT NULL,
    "explicitOverrideAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "MemorySuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorySourceBarrier" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "MemorySourceBarrierKind" NOT NULL,
    "sourceCreatedAtCutoff" TIMESTAMP(3) NOT NULL,
    "memoryGeneration" INTEGER NOT NULL,
    "explicitOverrideAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemorySourceBarrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryMutationAuthorization" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nonceHash" VARCHAR(128) NOT NULL,
    "action" "MemoryMutationAction" NOT NULL,
    "authorizedPayloadHash" VARCHAR(128) NOT NULL,
    "confirmationCopyVersion" VARCHAR(64) NOT NULL,
    "requestId" VARCHAR(256) NOT NULL,
    "modelRunId" TEXT,
    "persistedToolCallId" TEXT,
    "sourceChatId" TEXT,
    "sourceMessageId" TEXT,
    "exactSourceStart" INTEGER,
    "exactSourceEnd" INTEGER,
    "targetFactId" TEXT,
    "expectedTargetVersionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryMutationAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryOperationReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyFingerprint" VARCHAR(128) NOT NULL,
    "operation" "MemoryMutationAction" NOT NULL,
    "requestId" VARCHAR(256) NOT NULL,
    "modelRunId" TEXT,
    "persistedToolCallId" TEXT,
    "targetFactId" TEXT,
    "targetVersionId" TEXT,
    "outcome" "MemoryOperationOutcome" NOT NULL,
    "resultCode" VARCHAR(64) NOT NULL,
    "resultSnapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryOperationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryIndexGeneration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "state" "MemoryIndexGenerationState" NOT NULL,
    "indexMode" "MemoryIndexMode" NOT NULL,
    "sourceIndexGenerationId" TEXT,
    "targetMemoryRevision" INTEGER NOT NULL,
    "indexedThroughMemoryRevision" INTEGER NOT NULL,
    "embeddingConnectionId" TEXT,
    "embeddingProviderModelId" TEXT,
    "embeddingConfigurationFingerprint" VARCHAR(128),
    "embeddingDimension" INTEGER,
    "vectorSpaceFingerprint" VARCHAR(128),
    "languageProfile" VARCHAR(64) NOT NULL,
    "normalizationVersion" VARCHAR(64) NOT NULL,
    "chunkingVersion" VARCHAR(64) NOT NULL,
    "retrievalPipelineVersion" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "MemoryIndexGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorySearchEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "indexGenerationId" TEXT NOT NULL,
    "itemType" "MemorySearchItemType" NOT NULL,
    "factVersionId" TEXT NOT NULL,
    "safeSearchText" TEXT NOT NULL,
    "safeSearchTextYoNormalized" TEXT NOT NULL,
    "safeContentHash" VARCHAR(128) NOT NULL,
    "languageCode" VARCHAR(35) NOT NULL,
    "safetyIdentitySnapshot" VARCHAR(128) NOT NULL,
    "sourceIdentitySnapshot" VARCHAR(128) NOT NULL,
    "suppressionIdentitySnapshot" VARCHAR(128) NOT NULL,
    "embedding" vector,
    "embeddingDimension" INTEGER,
    "embeddingState" "MemoryEmbeddingState" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "searchVectorSimple" tsvector GENERATED ALWAYS AS
      (to_tsvector('simple', coalesce("safeSearchTextYoNormalized", ''))) STORED,
    "searchVectorRussian" tsvector GENERATED ALWAYS AS
      (to_tsvector('russian', coalesce("safeSearchTextYoNormalized", ''))) STORED,
    "searchVectorEnglish" tsvector GENERATED ALWAYS AS
      (to_tsvector('english', coalesce("safeSearchText", ''))) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemorySearchEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "activeLeafMessageId" TEXT,
    "branchGeneration" INTEGER,
    "sourceRevision" INTEGER,
    "sourceHash" VARCHAR(128),
    "kind" "MemoryJobKind" NOT NULL,
    "state" "MemoryJobState" NOT NULL DEFAULT 'QUEUED',
    "stage" VARCHAR(64),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(512),
    "pipelineVersion" VARCHAR(64) NOT NULL,
    "memoryGenerationSnapshot" INTEGER NOT NULL,
    "memoryRevisionSnapshot" INTEGER NOT NULL,
    "idempotencyFingerprint" VARCHAR(128) NOT NULL,
    "acceptedResultHash" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryDeletionOutbox" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operation" "MemoryDeletionOperation" NOT NULL,
    "targetType" VARCHAR(64) NOT NULL,
    "targetId" TEXT NOT NULL,
    "memoryGeneration" INTEGER NOT NULL,
    "state" "MemoryDeletionState" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseToken" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMP(3),
    "lastAuditAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryDeletionOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryRetrievalAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "attemptOrdinal" INTEGER NOT NULL,
    "chatId" TEXT NOT NULL,
    "admissionKind" "MemoryRetrievalAdmissionKind" NOT NULL,
    "preSendActiveLeafMessageId" TEXT,
    "admittedUserMessageId" TEXT NOT NULL,
    "admittedAssistantLeafMessageId" TEXT NOT NULL,
    "folderIdSnapshot" TEXT,
    "assistantIdSnapshot" TEXT,
    "chatMemoryModeSnapshot" "MemoryChatMode" NOT NULL,
    "settingsSnapshot" JSONB NOT NULL,
    "memoryGenerationSnapshot" INTEGER NOT NULL,
    "retrievalRevisionSnapshot" INTEGER NOT NULL,
    "indexGenerationIdSnapshot" TEXT,
    "utilityEgressMode" "MemoryUtilityEgressMode" NOT NULL,
    "acceptedUtilityEgressFingerprint" VARCHAR(128),
    "externalRolesUsed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "boundedSafeQuerySnapshot" TEXT,
    "queryHash" VARCHAR(128) NOT NULL,
    "boundedPrivateBaseRequestSnapshot" JSONB,
    "baseRequestHash" VARCHAR(128) NOT NULL,
    "state" "MemoryRetrievalAttemptState" NOT NULL DEFAULT 'PENDING',
    "outcome" "MemoryReceiptOutcome",
    "preparedContextText" TEXT,
    "preparedContextHash" VARCHAR(128),
    "preparedContextTokenCount" INTEGER,
    "budgetSnapshot" JSONB,
    "degradationCode" VARCHAR(64),
    "errorCode" VARCHAR(64),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryRetrievalAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryRetrievalAttemptItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "itemType" "MemorySearchItemType" NOT NULL,
    "exactItemId" TEXT NOT NULL,
    "factVersionId" TEXT NOT NULL,
    "exactSafeText" TEXT NOT NULL,
    "textHash" VARCHAR(128) NOT NULL,
    "sourceSnapshot" JSONB NOT NULL DEFAULT '{}',
    "versionSnapshot" JSONB NOT NULL DEFAULT '{}',
    "laneRanks" JSONB NOT NULL DEFAULT '{}',
    "featureSnapshot" JSONB NOT NULL DEFAULT '{}',
    "selectionReason" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRetrievalAttemptItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryExecutionBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ownerType" "MemoryExecutionOwnerType" NOT NULL,
    "memoryJobId" TEXT,
    "retrievalAttemptId" TEXT,
    "modelRunId" TEXT,
    "modelRunToolCallId" TEXT,
    "logicalRole" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "state" "MemoryExecutionState" NOT NULL DEFAULT 'PENDING',
    "connectionId" TEXT,
    "providerId" VARCHAR(64),
    "providerModelId" TEXT,
    "credentialId" TEXT,
    "credentialVersionId" TEXT,
    "destinationFingerprint" VARCHAR(128) NOT NULL,
    "policyVersion" VARCHAR(64) NOT NULL,
    "promptVersion" VARCHAR(64) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "pipelineVersion" VARCHAR(64) NOT NULL,
    "secretFreeExecutionSnapshot" JSONB NOT NULL,
    "inputHash" VARCHAR(128) NOT NULL,
    "acceptedOutputHash" VARCHAR(128),
    "providerResponseId" VARCHAR(256),
    "usageCompleteness" "MemoryUsageCompleteness" NOT NULL DEFAULT 'UNAVAILABLE',
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "outputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "totalTokens" INTEGER,
    "estimatedCostMicros" INTEGER,
    "recoverableUntil" TIMESTAMP(3),
    "relationsDetachedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryExecutionBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRunMemoryBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "retrievalAttemptId" TEXT NOT NULL,
    "memoryGenerationSnapshot" INTEGER NOT NULL,
    "retrievalRevisionSnapshot" INTEGER NOT NULL,
    "finalizedRevisionSnapshot" INTEGER NOT NULL,
    "settingsSnapshot" JSONB NOT NULL,
    "indexGenerationId" TEXT,
    "boundedSafeQuerySnapshot" TEXT,
    "queryHash" VARCHAR(128) NOT NULL,
    "queryPlannerVersion" VARCHAR(64) NOT NULL,
    "retrievalPipelineVersion" VARCHAR(64) NOT NULL,
    "contextTextHash" VARCHAR(128) NOT NULL,
    "contextTokenCount" INTEGER NOT NULL,
    "outcome" "MemoryReceiptOutcome" NOT NULL,
    "degradationCode" VARCHAR(64),
    "finalizedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelRunMemoryBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRunMemoryItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "itemType" "MemorySearchItemType" NOT NULL,
    "factVersionId" TEXT,
    "sourceChatIdSnapshot" TEXT,
    "sourceMessageIdsSnapshot" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "includedText" TEXT NOT NULL,
    "includedTextHash" VARCHAR(128) NOT NULL,
    "itemStateAtAdmission" VARCHAR(64) NOT NULL,
    "laneRanks" JSONB NOT NULL DEFAULT '{}',
    "featureSnapshot" JSONB NOT NULL DEFAULT '{}',
    "finalScore" DOUBLE PRECISION NOT NULL,
    "selectionReason" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelRunMemoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserMemorySettings_activeIndexGenerationId_idx" ON "UserMemorySettings"("activeIndexGenerationId");

-- CreateIndex
CREATE INDEX "UserMemorySettings_embeddingProviderModelId_idx" ON "UserMemorySettings"("embeddingProviderModelId");

-- CreateIndex
CREATE INDEX "MemoryScope_userId_state_scopeType_idx" ON "MemoryScope"("userId", "state", "scopeType");

-- CreateIndex
CREATE INDEX "MemoryScope_userId_folderId_idx" ON "MemoryScope"("userId", "folderId");

-- CreateIndex
CREATE INDEX "MemoryScope_userId_assistantId_idx" ON "MemoryScope"("userId", "assistantId");

-- CreateIndex
CREATE INDEX "MemoryScope_userId_chatId_idx" ON "MemoryScope"("userId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryScope_userId_id_key" ON "MemoryScope"("userId", "id");

-- CreateIndex
CREATE INDEX "MemoryFact_userId_scopeId_state_idx" ON "MemoryFact"("userId", "scopeId", "state");

-- CreateIndex
CREATE INDEX "MemoryFact_userId_currentVersionId_idx" ON "MemoryFact"("userId", "currentVersionId");

-- CreateIndex
CREATE INDEX "MemoryFact_userId_movedToFactId_idx" ON "MemoryFact"("userId", "movedToFactId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFact_userId_id_key" ON "MemoryFact"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFact_userId_scopeId_canonicalKey_key" ON "MemoryFact"("userId", "scopeId", "canonicalKey");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFact_userId_id_currentVersionId_key" ON "MemoryFact"("userId", "id", "currentVersionId");

-- CreateIndex
CREATE INDEX "MemoryFactVersion_userId_factId_state_idx" ON "MemoryFactVersion"("userId", "factId", "state");

-- CreateIndex
CREATE INDEX "MemoryFactVersion_userId_supersedesVersionId_idx" ON "MemoryFactVersion"("userId", "supersedesVersionId");

-- CreateIndex
CREATE INDEX "MemoryFactVersion_userId_movedFromVersionId_idx" ON "MemoryFactVersion"("userId", "movedFromVersionId");

-- CreateIndex
CREATE INDEX "MemoryFactVersion_userId_createdByEventId_idx" ON "MemoryFactVersion"("userId", "createdByEventId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFactVersion_userId_id_key" ON "MemoryFactVersion"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFactVersion_userId_factId_id_key" ON "MemoryFactVersion"("userId", "factId", "id");

-- CreateIndex
CREATE INDEX "MemoryEvidence_userId_factVersionId_stance_idx" ON "MemoryEvidence"("userId", "factVersionId", "stance");

-- CreateIndex
CREATE INDEX "MemoryEvidence_userId_chatId_messageId_idx" ON "MemoryEvidence"("userId", "chatId", "messageId");

-- CreateIndex
CREATE INDEX "MemoryEvidence_userId_memoryEventId_idx" ON "MemoryEvidence"("userId", "memoryEventId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryEvidence_userId_id_key" ON "MemoryEvidence"("userId", "id");

-- CreateIndex
CREATE INDEX "MemoryEvent_userId_factId_createdAt_idx" ON "MemoryEvent"("userId", "factId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryEvent_userId_factVersionId_idx" ON "MemoryEvent"("userId", "factVersionId");

-- CreateIndex
CREATE INDEX "MemoryEvent_userId_sourceChatId_createdAt_idx" ON "MemoryEvent"("userId", "sourceChatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryEvent_userId_id_key" ON "MemoryEvent"("userId", "id");

-- CreateIndex
CREATE INDEX "MemorySuppression_userId_scope_expiresAt_idx" ON "MemorySuppression"("userId", "scope", "expiresAt");

-- CreateIndex
CREATE INDEX "MemorySuppression_userId_canonicalKeyHash_idx" ON "MemorySuppression"("userId", "canonicalKeyHash");

-- CreateIndex
CREATE INDEX "MemorySuppression_userId_normalizedValueHash_idx" ON "MemorySuppression"("userId", "normalizedValueHash");

-- CreateIndex
CREATE INDEX "MemorySuppression_userId_sourceChatId_sourceMessageId_idx" ON "MemorySuppression"("userId", "sourceChatId", "sourceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "MemorySuppression_userId_id_key" ON "MemorySuppression"("userId", "id");

-- CreateIndex
CREATE INDEX "MemorySourceBarrier_userId_kind_sourceCreatedAtCutoff_idx" ON "MemorySourceBarrier"("userId", "kind", "sourceCreatedAtCutoff");

-- CreateIndex
CREATE UNIQUE INDEX "MemorySourceBarrier_userId_id_key" ON "MemorySourceBarrier"("userId", "id");

-- CreateIndex
CREATE INDEX "MemoryMutationAuthorization_userId_expiresAt_consumedAt_idx" ON "MemoryMutationAuthorization"("userId", "expiresAt", "consumedAt");

-- CreateIndex
CREATE INDEX "MemoryMutationAuthorization_userId_modelRunId_persistedTool_idx" ON "MemoryMutationAuthorization"("userId", "modelRunId", "persistedToolCallId");

-- CreateIndex
CREATE INDEX "MemoryMutationAuthorization_userId_targetFactId_idx" ON "MemoryMutationAuthorization"("userId", "targetFactId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryMutationAuthorization_userId_id_key" ON "MemoryMutationAuthorization"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryMutationAuthorization_userId_nonceHash_key" ON "MemoryMutationAuthorization"("userId", "nonceHash");

-- CreateIndex
CREATE INDEX "MemoryOperationReceipt_userId_modelRunId_persistedToolCallI_idx" ON "MemoryOperationReceipt"("userId", "modelRunId", "persistedToolCallId");

-- CreateIndex
CREATE INDEX "MemoryOperationReceipt_userId_targetFactId_targetVersionId_idx" ON "MemoryOperationReceipt"("userId", "targetFactId", "targetVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryOperationReceipt_userId_id_key" ON "MemoryOperationReceipt"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryOperationReceipt_userId_idempotencyFingerprint_key" ON "MemoryOperationReceipt"("userId", "idempotencyFingerprint");

-- CreateIndex
CREATE INDEX "MemoryIndexGeneration_userId_state_generation_idx" ON "MemoryIndexGeneration"("userId", "state", "generation");

-- CreateIndex
CREATE INDEX "MemoryIndexGeneration_userId_sourceIndexGenerationId_idx" ON "MemoryIndexGeneration"("userId", "sourceIndexGenerationId");

-- CreateIndex
CREATE INDEX "MemoryIndexGeneration_embeddingConnectionId_embeddingProvid_idx" ON "MemoryIndexGeneration"("embeddingConnectionId", "embeddingProviderModelId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryIndexGeneration_userId_id_key" ON "MemoryIndexGeneration"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryIndexGeneration_userId_generation_key" ON "MemoryIndexGeneration"("userId", "generation");

-- CreateIndex
CREATE INDEX "MemorySearchEntry_userId_indexGenerationId_embeddingState_idx" ON "MemorySearchEntry"("userId", "indexGenerationId", "embeddingState");

-- CreateIndex
CREATE INDEX "MemorySearchEntry_userId_factVersionId_idx" ON "MemorySearchEntry"("userId", "factVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "MemorySearchEntry_userId_id_key" ON "MemorySearchEntry"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemorySearchEntry_userId_indexGenerationId_itemType_factVer_key" ON "MemorySearchEntry"("userId", "indexGenerationId", "itemType", "factVersionId");

-- CreateIndex
CREATE INDEX "MemoryJob_userId_state_nextAttemptAt_createdAt_idx" ON "MemoryJob"("userId", "state", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryJob_userId_chatId_branchGeneration_sourceRevision_idx" ON "MemoryJob"("userId", "chatId", "branchGeneration", "sourceRevision");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryJob_userId_id_key" ON "MemoryJob"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryJob_userId_idempotencyFingerprint_key" ON "MemoryJob"("userId", "idempotencyFingerprint");

-- CreateIndex
CREATE INDEX "MemoryDeletionOutbox_userId_state_nextAttemptAt_createdAt_idx" ON "MemoryDeletionOutbox"("userId", "state", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryDeletionOutbox_userId_id_key" ON "MemoryDeletionOutbox"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryDeletionOutbox_userId_operation_targetType_targetId_m_key" ON "MemoryDeletionOutbox"("userId", "operation", "targetType", "targetId", "memoryGeneration");

-- CreateIndex
CREATE INDEX "MemoryRetrievalAttempt_userId_state_expiresAt_idx" ON "MemoryRetrievalAttempt"("userId", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "MemoryRetrievalAttempt_userId_chatId_createdAt_idx" ON "MemoryRetrievalAttempt"("userId", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryRetrievalAttempt_userId_indexGenerationIdSnapshot_idx" ON "MemoryRetrievalAttempt"("userId", "indexGenerationIdSnapshot");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttempt_userId_id_key" ON "MemoryRetrievalAttempt"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttempt_userId_modelRunId_id_key" ON "MemoryRetrievalAttempt"("userId", "modelRunId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttempt_modelRunId_attemptOrdinal_key" ON "MemoryRetrievalAttempt"("modelRunId", "attemptOrdinal");

-- CreateIndex
CREATE INDEX "MemoryRetrievalAttemptItem_userId_factVersionId_idx" ON "MemoryRetrievalAttemptItem"("userId", "factVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttemptItem_userId_id_key" ON "MemoryRetrievalAttemptItem"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttemptItem_userId_attemptId_ordinal_key" ON "MemoryRetrievalAttemptItem"("userId", "attemptId", "ordinal");

-- CreateIndex
CREATE INDEX "MemoryExecutionBinding_userId_memoryJobId_ordinal_idx" ON "MemoryExecutionBinding"("userId", "memoryJobId", "ordinal");

-- CreateIndex
CREATE INDEX "MemoryExecutionBinding_userId_retrievalAttemptId_ordinal_idx" ON "MemoryExecutionBinding"("userId", "retrievalAttemptId", "ordinal");

-- CreateIndex
CREATE INDEX "MemoryExecutionBinding_userId_modelRunId_modelRunToolCallId_idx" ON "MemoryExecutionBinding"("userId", "modelRunId", "modelRunToolCallId", "ordinal");

-- CreateIndex
CREATE INDEX "MemoryExecutionBinding_connectionId_providerModelId_idx" ON "MemoryExecutionBinding"("connectionId", "providerModelId");

-- CreateIndex
CREATE INDEX "MemoryExecutionBinding_credentialId_credentialVersionId_idx" ON "MemoryExecutionBinding"("credentialId", "credentialVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryExecutionBinding_userId_id_key" ON "MemoryExecutionBinding"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryBinding_modelRunId_key" ON "ModelRunMemoryBinding"("modelRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryBinding_retrievalAttemptId_key" ON "ModelRunMemoryBinding"("retrievalAttemptId");

-- CreateIndex
CREATE INDEX "ModelRunMemoryBinding_userId_indexGenerationId_idx" ON "ModelRunMemoryBinding"("userId", "indexGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryBinding_userId_id_key" ON "ModelRunMemoryBinding"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryBinding_userId_modelRunId_key" ON "ModelRunMemoryBinding"("userId", "modelRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryBinding_userId_retrievalAttemptId_key" ON "ModelRunMemoryBinding"("userId", "retrievalAttemptId");

-- CreateIndex
CREATE INDEX "ModelRunMemoryItem_userId_factVersionId_idx" ON "ModelRunMemoryItem"("userId", "factVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryItem_userId_id_key" ON "ModelRunMemoryItem"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryItem_userId_bindingId_ordinal_key" ON "ModelRunMemoryItem"("userId", "bindingId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_userId_id_key" ON "Chat"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_userId_id_key" ON "Folder"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRun_userId_id_key" ON "ModelRun"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRun_userId_chatId_id_key" ON "ModelRun"("userId", "chatId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_memoryExecutionBindingId_key" ON "UsageEvent"("memoryExecutionBindingId");

-- Existing run admission now admits a private PREPARING phase. Both request
-- artifacts become authoritative in the same finalization transaction.
ALTER TABLE "ModelRun"
  ADD CONSTRAINT "ModelRun_memory_request_shape_check"
  CHECK (
    ("status" = 'preparing' AND "normalizedRequest" IS NULL AND "providerRequestPreview" IS NULL)
    OR
    ("status" <> 'preparing' AND "normalizedRequest" IS NOT NULL AND "providerRequestPreview" IS NOT NULL)
  );

CREATE UNIQUE INDEX "ModelRun_one_active_per_chat_idx"
ON "ModelRun"("chatId")
WHERE "status" IN ('preparing', 'queued', 'streaming', 'in_progress');

ALTER TABLE "ModelRun"
  ADD CONSTRAINT "ModelRun_user_chat_memory_fkey"
  FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "UserMemorySettings"
  ADD CONSTRAINT "UserMemorySettings_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "UserMemorySettings_embedding_model_fkey"
    FOREIGN KEY ("embeddingProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "UserMemorySettings_counter_check"
    CHECK ("memoryGeneration" >= 0 AND "memoryRevision" >= 0 AND "memoryConsentRevision" >= 0 AND "settingsRevision" >= 0),
  ADD CONSTRAINT "UserMemorySettings_language_check"
    CHECK ("preferredProfileLanguage" ~ '^(AUTO|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'),
  ADD CONSTRAINT "UserMemorySettings_utility_consent_check"
    CHECK (
      num_nonnulls(
        "acceptedUtilityEgressFingerprint",
        "acceptedUtilityPolicyVersion",
        "acceptedUtilityEgressAt"
      ) IN (0, 3)
    );

ALTER TABLE "MemoryScope"
  ADD CONSTRAINT "MemoryScope_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryScope_folder_fkey"
    FOREIGN KEY ("userId", "folderId") REFERENCES "Folder"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryScope_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryScope_assistant_fkey"
    FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryScope_target_shape_check"
    CHECK (
      (
        "scopeType" = 'GLOBAL_USER'
        AND "state" = 'ACTIVE'
        AND num_nonnulls("targetIdSnapshot", "targetDisplaySnapshot", "folderId", "assistantId", "chatId", "orphanedAt") = 0
      )
      OR
      (
        "state" = 'ACTIVE'
        AND "scopeType" <> 'GLOBAL_USER'
        AND "targetIdSnapshot" IS NOT NULL
        AND "orphanedAt" IS NULL
        AND (
          ("scopeType" = 'FOLDER' AND "folderId" = "targetIdSnapshot" AND "assistantId" IS NULL AND "chatId" IS NULL)
          OR ("scopeType" = 'ASSISTANT' AND "assistantId" = "targetIdSnapshot" AND "folderId" IS NULL AND "chatId" IS NULL)
          OR ("scopeType" = 'CHAT' AND "chatId" = "targetIdSnapshot" AND "folderId" IS NULL AND "assistantId" IS NULL)
        )
      )
      OR
      (
        "state" IN ('ORPHANED', 'RETRACTED')
        AND "scopeType" <> 'GLOBAL_USER'
        AND "targetIdSnapshot" IS NOT NULL
        AND num_nonnulls("folderId", "assistantId", "chatId") = 0
        AND ("state" <> 'ORPHANED' OR "orphanedAt" IS NOT NULL)
      )
    );

CREATE UNIQUE INDEX "MemoryScope_one_global_user_idx"
  ON "MemoryScope"("userId") WHERE "scopeType" = 'GLOBAL_USER';
CREATE UNIQUE INDEX "MemoryScope_folder_identity_idx"
  ON "MemoryScope"("userId", "targetIdSnapshot") WHERE "scopeType" = 'FOLDER';
CREATE UNIQUE INDEX "MemoryScope_assistant_identity_idx"
  ON "MemoryScope"("userId", "targetIdSnapshot") WHERE "scopeType" = 'ASSISTANT';
CREATE UNIQUE INDEX "MemoryScope_chat_identity_idx"
  ON "MemoryScope"("userId", "targetIdSnapshot") WHERE "scopeType" = 'CHAT';

CREATE FUNCTION aiqsa_memory_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $memory_scope_guard$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."scopeType", NEW."targetIdSnapshot")
         IS DISTINCT FROM (OLD."scopeType", OLD."targetIdSnapshot") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory scope identity is immutable';
  END IF;

  IF NEW."scopeType" <> 'GLOBAL_USER' AND NEW."state" = 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Non-global Memory scopes remain feature-dark until Phase 3 authorization';
  END IF;
  RETURN NEW;
END
$memory_scope_guard$;

CREATE TRIGGER "MemoryScope_phase1_guard"
BEFORE INSERT OR UPDATE ON "MemoryScope"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_scope_guard();

ALTER TABLE "MemoryFact"
  ADD CONSTRAINT "MemoryFact_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFact_scope_fkey"
    FOREIGN KEY ("userId", "scopeId") REFERENCES "MemoryScope"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFact_moved_to_fkey"
    FOREIGN KEY ("userId", "movedToFactId") REFERENCES "MemoryFact"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFact_state_shape_check"
    CHECK (
      "temperatureScore" BETWEEN 0 AND 1
      AND "canonicalKey" ~ '^[a-z][a-z0-9_.:-]{0,255}$'
      AND "category" ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND (("state" = 'ACTIVE') = ("currentVersionId" IS NOT NULL))
      AND (("state" = 'FORGOTTEN') = ("forgottenAt" IS NOT NULL))
      AND ("movedToFactId" IS NULL OR "movedToFactId" <> "id")
    );

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFactVersion_fact_fkey"
    FOREIGN KEY ("userId", "factId") REFERENCES "MemoryFact"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFactVersion_supersedes_fkey"
    FOREIGN KEY ("userId", "supersedesVersionId") REFERENCES "MemoryFactVersion"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFactVersion_moved_from_fkey"
    FOREIGN KEY ("userId", "movedFromVersionId") REFERENCES "MemoryFactVersion"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryFactVersion_value_check"
    CHECK (
      "confidence" BETWEEN 0 AND 1
      AND "importance" BETWEEN 0 AND 1
      AND "category" ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" > "validFrom")
      AND ("systemTo" IS NULL OR "systemTo" > "systemFrom")
      AND ("supersedesVersionId" IS NULL OR "supersedesVersionId" <> "id")
      AND ("movedFromVersionId" IS NULL OR "movedFromVersionId" <> "id")
      AND (
        (
          "contentPurgedAt" IS NULL
          AND "displayText" IS NOT NULL
          AND "normalizedSearchText" IS NOT NULL
          AND "structuredValue" IS NOT NULL
        )
        OR
        (
          "contentPurgedAt" IS NOT NULL
          AND "state" IN ('RETRACTED', 'FORGOTTEN')
          AND num_nonnulls(
            "displayText", "normalizedSearchText", "structuredValue",
            "rawTemporalExpression", "temporalResolutionEvidence"
          ) = 0
        )
      )
    );

CREATE UNIQUE INDEX "MemoryFactVersion_one_active_idx"
  ON "MemoryFactVersion"("userId", "factId") WHERE "state" = 'ACTIVE';
CREATE INDEX "MemoryFact_active_owner_scope_idx"
  ON "MemoryFact"("userId", "scopeId", "canonicalKey") WHERE "state" = 'ACTIVE';

ALTER TABLE "MemoryEvent"
  ADD CONSTRAINT "MemoryEvent_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvent_actor_user_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvent_fact_fkey"
    FOREIGN KEY ("userId", "factId") REFERENCES "MemoryFact"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvent_version_fkey"
    FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "MemoryEvent_chat_fkey"
    FOREIGN KEY ("userId", "sourceChatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvent_actor_shape_check"
    CHECK (
      ("actorType" = 'USER' AND "actorUserId" = "userId")
      OR ("actorType" <> 'USER' AND "actorUserId" IS NULL)
    );

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_created_event_fkey"
  FOREIGN KEY ("userId", "createdByEventId") REFERENCES "MemoryEvent"("userId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "MemoryFact"
  ADD CONSTRAINT "MemoryFact_current_version_fkey"
  FOREIGN KEY ("userId", "id", "currentVersionId")
  REFERENCES "MemoryFactVersion"("userId", "factId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION aiqsa_memory_assert_fact_pointer(p_user_id text, p_fact_id text)
RETURNS void LANGUAGE plpgsql AS $memory_fact_pointer$
DECLARE
  fact_row "MemoryFact"%ROWTYPE;
  active_count integer;
  pointed_state "MemoryFactVersionState";
BEGIN
  SELECT * INTO fact_row FROM "MemoryFact"
  WHERE "userId" = p_user_id AND "id" = p_fact_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO active_count FROM "MemoryFactVersion"
  WHERE "userId" = p_user_id AND "factId" = p_fact_id AND "state" = 'ACTIVE';

  IF fact_row."state" = 'ACTIVE' THEN
    SELECT "state" INTO pointed_state FROM "MemoryFactVersion"
    WHERE "userId" = p_user_id
      AND "factId" = p_fact_id
      AND "id" = fact_row."currentVersionId";
    IF fact_row."currentVersionId" IS NULL OR pointed_state IS DISTINCT FROM 'ACTIVE' OR active_count <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'ACTIVE Memory fact must point to its one ACTIVE same-owner version';
    END IF;
  ELSIF fact_row."currentVersionId" IS NOT NULL OR active_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Non-ACTIVE Memory fact cannot retain an ACTIVE version or current pointer';
  END IF;
END
$memory_fact_pointer$;

CREATE FUNCTION aiqsa_memory_fact_pointer_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_fact_pointer_trigger$
BEGIN
  IF TG_TABLE_NAME = 'MemoryFact' THEN
    PERFORM aiqsa_memory_assert_fact_pointer(NEW."userId", NEW."id");
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_fact_pointer(NEW."userId", NEW."factId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_fact_pointer(OLD."userId", OLD."factId");
    END IF;
  END IF;
  RETURN NULL;
END
$memory_fact_pointer_trigger$;

CREATE CONSTRAINT TRIGGER "MemoryFact_pointer_state_guard"
AFTER INSERT OR UPDATE ON "MemoryFact"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_fact_pointer_trigger();

CREATE CONSTRAINT TRIGGER "MemoryFactVersion_pointer_state_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryFactVersion"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_fact_pointer_trigger();

ALTER TABLE "MemoryEvidence"
  ADD CONSTRAINT "MemoryEvidence_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvidence_version_fkey"
    FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvidence_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvidence_message_fkey"
    FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvidence_event_fkey"
    FOREIGN KEY ("userId", "memoryEventId") REFERENCES "MemoryEvent"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryEvidence_source_shape_check"
    CHECK (
      char_length("safeExcerpt") BETWEEN 1 AND 2000
      AND (
        (
          "sourceType" = 'MESSAGE'
          AND num_nonnulls("chatId", "messageId", "branchGeneration") = 3
          AND "episodeId" IS NULL AND "memoryEventId" IS NULL
        )
        OR
        (
          "sourceType" = 'EXPLICIT_ACTION'
          AND "memoryEventId" IS NOT NULL
          AND num_nonnulls("chatId", "messageId", "episodeId", "branchGeneration") = 0
        )
      )
    );

CREATE UNIQUE INDEX "MemoryEvidence_message_identity_idx"
  ON "MemoryEvidence"("userId", "factVersionId", "stance", "chatId", "messageId", "sourceProjectionVersion")
  WHERE "sourceType" = 'MESSAGE';
CREATE UNIQUE INDEX "MemoryEvidence_action_identity_idx"
  ON "MemoryEvidence"("userId", "factVersionId", "stance", "memoryEventId")
  WHERE "sourceType" = 'EXPLICIT_ACTION';

ALTER TABLE "MemorySuppression"
  ADD CONSTRAINT "MemorySuppression_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySuppression_chat_fkey"
    FOREIGN KEY ("userId", "sourceChatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySuppression_message_fkey"
    FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySuppression_shape_check"
    CHECK (
      "deletionGeneration" >= 0
      AND "fingerprintKeyVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND ("canonicalKeyHash" IS NULL OR "canonicalKeyHash" ~ '^[A-Za-z0-9_-]{43}$')
      AND ("normalizedValueHash" IS NULL OR "normalizedValueHash" ~ '^[A-Za-z0-9_-]{43}$')
      AND (
        ("scope" = 'FACT' AND "canonicalKeyHash" IS NOT NULL AND num_nonnulls("normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
        OR ("scope" = 'VALUE' AND "normalizedValueHash" IS NOT NULL AND num_nonnulls("canonicalKeyHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
        OR ("scope" = 'SOURCE_MESSAGE' AND num_nonnulls("sourceChatId", "sourceMessageId", "sourceBranchGeneration") = 3 AND "sourceEpisodeId" IS NULL)
        OR ("scope" = 'CATEGORY' AND "canonicalKeyHash" IS NOT NULL AND num_nonnulls("normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
        OR ("scope" = 'ALL' AND num_nonnulls("canonicalKeyHash", "normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceEpisodeId", "sourceBranchGeneration") = 0)
      )
    );

ALTER TABLE "MemorySourceBarrier"
  ADD CONSTRAINT "MemorySourceBarrier_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySourceBarrier_generation_check"
    CHECK ("memoryGeneration" >= 0);

ALTER TABLE "MemoryMutationAuthorization"
  ADD CONSTRAINT "MemoryMutationAuthorization_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryMutationAuthorization_run_fkey"
    FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryMutationAuthorization_tool_fkey"
    FOREIGN KEY ("modelRunId", "persistedToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryMutationAuthorization_chat_fkey"
    FOREIGN KEY ("userId", "sourceChatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryMutationAuthorization_message_fkey"
    FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryMutationAuthorization_target_fkey"
    FOREIGN KEY ("userId", "targetFactId", "expectedTargetVersionId")
    REFERENCES "MemoryFactVersion"("userId", "factId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryMutationAuthorization_shape_check"
    CHECK (
      "expiresAt" > "createdAt"
      AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
      AND ("persistedToolCallId" IS NULL OR "modelRunId" IS NOT NULL)
      AND (
        num_nonnulls("sourceChatId", "sourceMessageId", "exactSourceStart", "exactSourceEnd") = 0
        OR (
          num_nonnulls("sourceChatId", "sourceMessageId", "exactSourceStart", "exactSourceEnd") = 4
          AND "exactSourceStart" >= 0
          AND "exactSourceEnd" > "exactSourceStart"
        )
      )
      AND (
        ("action" IN ('EDIT', 'MOVE_SCOPE', 'FORGET') AND num_nonnulls("targetFactId", "expectedTargetVersionId") = 2)
        OR ("action" IN ('SAVE', 'BULK_DELETE') AND num_nonnulls("targetFactId", "expectedTargetVersionId") = 0)
      )
    );

ALTER TABLE "MemoryOperationReceipt"
  ADD CONSTRAINT "MemoryOperationReceipt_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryOperationReceipt_run_fkey"
    FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryOperationReceipt_tool_fkey"
    FOREIGN KEY ("modelRunId", "persistedToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryOperationReceipt_target_fkey"
    FOREIGN KEY ("userId", "targetFactId", "targetVersionId")
    REFERENCES "MemoryFactVersion"("userId", "factId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryOperationReceipt_shape_check"
    CHECK (
      ("persistedToolCallId" IS NULL OR "modelRunId" IS NOT NULL)
      AND num_nonnulls("targetFactId", "targetVersionId") IN (0, 2)
    );

CREATE UNIQUE INDEX "MemoryOperationReceipt_tool_idempotency_idx"
  ON "MemoryOperationReceipt"("userId", "modelRunId", "persistedToolCallId", "operation", "targetVersionId")
  NULLS NOT DISTINCT
  WHERE "persistedToolCallId" IS NOT NULL;

ALTER TABLE "MemoryIndexGeneration"
  ADD CONSTRAINT "MemoryIndexGeneration_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryIndexGeneration_source_fkey"
    FOREIGN KEY ("userId", "sourceIndexGenerationId") REFERENCES "MemoryIndexGeneration"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryIndexGeneration_model_fkey"
    FOREIGN KEY ("embeddingConnectionId", "embeddingProviderModelId")
    REFERENCES "ProviderModel"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryIndexGeneration_configuration_check"
    CHECK (
      "generation" >= 0
      AND "targetMemoryRevision" >= 0
      AND "indexedThroughMemoryRevision" >= 0
      AND ("sourceIndexGenerationId" IS NULL OR "sourceIndexGenerationId" <> "id")
      AND (
        (
          "indexMode" = 'LEXICAL_ONLY'
          AND num_nonnulls(
            "embeddingConnectionId", "embeddingProviderModelId",
            "embeddingConfigurationFingerprint", "embeddingDimension",
            "vectorSpaceFingerprint"
          ) = 0
        )
        OR
        (
          "indexMode" = 'HYBRID'
          AND num_nonnulls(
            "embeddingConnectionId", "embeddingProviderModelId",
            "embeddingConfigurationFingerprint", "embeddingDimension",
            "vectorSpaceFingerprint"
          ) = 5
          AND "embeddingDimension" BETWEEN 1 AND 4096
        )
      )
      AND (
        ("state" IN ('BUILDING', 'CATCHING_UP') AND num_nonnulls("readyAt", "activatedAt", "supersededAt") = 0)
        OR ("state" = 'READY' AND "readyAt" IS NOT NULL AND num_nonnulls("activatedAt", "supersededAt") = 0)
        OR ("state" = 'ACTIVE' AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "supersededAt" IS NULL)
        OR ("state" = 'SUPERSEDED' AND num_nonnulls("readyAt", "activatedAt", "supersededAt") = 3)
        OR ("state" IN ('FAILED', 'CANCELLED') AND "activatedAt" IS NULL AND "supersededAt" IS NULL)
      )
    );

CREATE UNIQUE INDEX "MemoryIndexGeneration_one_active_idx"
  ON "MemoryIndexGeneration"("userId") WHERE "state" = 'ACTIVE';
CREATE UNIQUE INDEX "MemoryIndexGeneration_one_shadow_idx"
  ON "MemoryIndexGeneration"("userId") WHERE "state" IN ('BUILDING', 'CATCHING_UP', 'READY');

CREATE FUNCTION aiqsa_memory_generation_immutable() RETURNS trigger
LANGUAGE plpgsql AS $memory_generation_immutable$
BEGIN
  IF (
    NEW."userId", NEW."generation", NEW."indexMode", NEW."sourceIndexGenerationId",
    NEW."targetMemoryRevision", NEW."embeddingConnectionId", NEW."embeddingProviderModelId",
    NEW."embeddingConfigurationFingerprint", NEW."embeddingDimension",
    NEW."vectorSpaceFingerprint", NEW."languageProfile", NEW."normalizationVersion",
    NEW."chunkingVersion", NEW."retrievalPipelineVersion"
  ) IS DISTINCT FROM (
    OLD."userId", OLD."generation", OLD."indexMode", OLD."sourceIndexGenerationId",
    OLD."targetMemoryRevision", OLD."embeddingConnectionId", OLD."embeddingProviderModelId",
    OLD."embeddingConfigurationFingerprint", OLD."embeddingDimension",
    OLD."vectorSpaceFingerprint", OLD."languageProfile", OLD."normalizationVersion",
    OLD."chunkingVersion", OLD."retrievalPipelineVersion"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory index generation configuration is immutable';
  END IF;
  RETURN NEW;
END
$memory_generation_immutable$;

CREATE TRIGGER "MemoryIndexGeneration_configuration_guard"
BEFORE UPDATE ON "MemoryIndexGeneration"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_generation_immutable();

ALTER TABLE "MemorySearchEntry"
  ADD CONSTRAINT "MemorySearchEntry_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySearchEntry_generation_fkey"
    FOREIGN KEY ("userId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySearchEntry_fact_version_fkey"
    FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemorySearchEntry_shape_check"
    CHECK (
      "itemType" = 'FACT_VERSION'
      AND char_length("safeSearchText") BETWEEN 1 AND 4000
      AND char_length("safeSearchTextYoNormalized") BETWEEN 1 AND 4000
      AND (
        ("embeddingState" IN ('NOT_APPLICABLE', 'PENDING', 'FAILED') AND num_nonnulls("embedding", "embeddingDimension") = 0)
        OR ("embeddingState" = 'READY' AND num_nonnulls("embedding", "embeddingDimension") = 2)
      )
    );

CREATE FUNCTION aiqsa_memory_search_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $memory_search_entry_guard$
DECLARE
  generation_mode "MemoryIndexMode";
  generation_dimension integer;
BEGIN
  SELECT "indexMode", "embeddingDimension"
    INTO generation_mode, generation_dimension
  FROM "MemoryIndexGeneration"
  WHERE "userId" = NEW."userId" AND "id" = NEW."indexGenerationId";

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'Memory search entry generation does not exist for owner';
  END IF;

  IF generation_mode = 'LEXICAL_ONLY' AND NEW."embeddingState" <> 'NOT_APPLICABLE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Lexical Memory generation cannot contain vector work';
  END IF;

  IF NEW."embeddingState" = 'READY'
     AND (
       generation_mode <> 'HYBRID'
       OR NEW."embeddingDimension" IS DISTINCT FROM generation_dimension
       OR vector_dims(NEW."embedding") IS DISTINCT FROM generation_dimension
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory search vector does not match its generation dimension';
  END IF;
  RETURN NEW;
END
$memory_search_entry_guard$;

CREATE TRIGGER "MemorySearchEntry_vector_guard"
BEFORE INSERT OR UPDATE ON "MemorySearchEntry"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_search_entry_guard();

CREATE INDEX "MemorySearchEntry_simple_gin_idx"
  ON "MemorySearchEntry" USING GIN ("searchVectorSimple");
CREATE INDEX "MemorySearchEntry_russian_gin_idx"
  ON "MemorySearchEntry" USING GIN ("searchVectorRussian");
CREATE INDEX "MemorySearchEntry_english_gin_idx"
  ON "MemorySearchEntry" USING GIN ("searchVectorEnglish");

ALTER TABLE "MemoryJob"
  ADD CONSTRAINT "MemoryJob_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryJob_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryJob_leaf_fkey"
    FOREIGN KEY ("chatId", "activeLeafMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryJob_shape_check"
    CHECK (
      "attemptCount" >= 0
      AND "memoryGenerationSnapshot" >= 0
      AND "memoryRevisionSnapshot" >= 0
      AND (
        ("chatId" IS NULL AND num_nonnulls("activeLeafMessageId", "branchGeneration", "sourceRevision") = 0)
        OR (
          num_nonnulls("chatId", "activeLeafMessageId", "branchGeneration", "sourceRevision", "sourceHash") = 5
          AND "branchGeneration" >= 0
          AND "sourceRevision" >= 0
        )
      )
      AND (
        ("state" = 'CLAIMED' AND num_nonnulls("leaseToken", "leaseExpiresAt") = 2 AND "completedAt" IS NULL)
        OR ("state" IN ('QUEUED', 'WAITING_FOR_EGRESS_CONSENT', 'RETRYABLE_FAILED') AND num_nonnulls("leaseToken", "leaseExpiresAt", "completedAt") = 0)
        OR ("state" IN ('SUCCEEDED', 'TERMINAL_FAILED', 'STALE', 'CANCELLED') AND num_nonnulls("leaseToken", "leaseExpiresAt") = 0 AND "completedAt" IS NOT NULL)
      )
      AND ("state" <> 'WAITING_FOR_EGRESS_CONSENT' OR "nextAttemptAt" IS NULL)
    );

CREATE INDEX "MemoryJob_pending_owner_due_idx"
  ON "MemoryJob"("userId", "nextAttemptAt", "createdAt")
  WHERE "state" IN ('QUEUED', 'RETRYABLE_FAILED');

ALTER TABLE "MemoryDeletionOutbox"
  ADD CONSTRAINT "MemoryDeletionOutbox_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryDeletionOutbox_shape_check"
    CHECK (
      "memoryGeneration" >= 0
      AND "attemptCount" >= 0
      AND (
        ("state" = 'RUNNING' AND num_nonnulls("leaseToken", "leaseExpiresAt") = 2 AND "completedAt" IS NULL)
        OR ("state" IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN') AND num_nonnulls("leaseToken", "leaseExpiresAt", "completedAt") = 0)
        OR ("state" = 'SUCCEEDED' AND num_nonnulls("leaseToken", "leaseExpiresAt") = 0 AND "completedAt" IS NOT NULL AND "lastAuditAt" IS NOT NULL)
      )
    );

ALTER TABLE "MemoryRetrievalAttempt"
  ADD CONSTRAINT "MemoryRetrievalAttempt_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttempt_run_fkey"
    FOREIGN KEY ("userId", "chatId", "modelRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttempt_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttempt_pre_leaf_fkey"
    FOREIGN KEY ("chatId", "preSendActiveLeafMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttempt_user_message_fkey"
    FOREIGN KEY ("chatId", "admittedUserMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttempt_assistant_message_fkey"
    FOREIGN KEY ("chatId", "admittedAssistantLeafMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttempt_generation_fkey"
    FOREIGN KEY ("userId", "indexGenerationIdSnapshot") REFERENCES "MemoryIndexGeneration"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttempt_shape_check"
    CHECK (
      "attemptOrdinal" >= 0
      AND "memoryGenerationSnapshot" >= 0
      AND "retrievalRevisionSnapshot" >= 0
      AND "expiresAt" > "createdAt"
      AND (
        ("utilityEgressMode" = 'LOCAL_ONLY' AND "acceptedUtilityEgressFingerprint" IS NULL AND cardinality("externalRolesUsed") = 0)
        OR ("utilityEgressMode" = 'CONSENTED_EXTERNAL' AND "acceptedUtilityEgressFingerprint" IS NOT NULL AND cardinality("externalRolesUsed") > 0)
      )
      AND (
        ("state" IN ('PENDING', 'EXECUTING') AND "outcome" IS NULL AND "consumedAt" IS NULL)
        OR ("state" = 'READY' AND "outcome" IS NOT NULL AND "consumedAt" IS NULL)
        OR ("state" = 'CONSUMED' AND "outcome" IS NOT NULL AND "consumedAt" IS NOT NULL)
        OR ("state" IN ('STALE', 'FAILED', 'CANCELLED', 'EXPIRED') AND ("outcome" IS NOT NULL OR "errorCode" IS NOT NULL) AND "consumedAt" IS NULL)
      )
      AND (
        num_nonnulls("preparedContextText", "preparedContextHash", "preparedContextTokenCount") = 0
        OR (
          num_nonnulls("preparedContextText", "preparedContextHash", "preparedContextTokenCount") = 3
          AND "preparedContextTokenCount" >= 0
        )
      )
      AND (
        "outcome" IS DISTINCT FROM 'USED'
        OR "state" NOT IN ('READY', 'CONSUMED')
        OR num_nonnulls("preparedContextText", "preparedContextHash", "preparedContextTokenCount") = 3
      )
      AND (
        "state" NOT IN ('PENDING', 'EXECUTING', 'READY')
        OR "boundedPrivateBaseRequestSnapshot" IS NOT NULL
      )
    );

CREATE UNIQUE INDEX "MemoryRetrievalAttempt_one_nonterminal_idx"
  ON "MemoryRetrievalAttempt"("modelRunId")
  WHERE "state" IN ('PENDING', 'EXECUTING', 'READY');

ALTER TABLE "MemoryRetrievalAttemptItem"
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_attempt_fkey"
    FOREIGN KEY ("userId", "attemptId") REFERENCES "MemoryRetrievalAttempt"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_version_fkey"
    FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_shape_check"
    CHECK (
      "ordinal" >= 0
      AND "itemType" = 'FACT_VERSION'
      AND "exactItemId" = "factVersionId"
      AND char_length("exactSafeText") BETWEEN 1 AND 4000
    );

CREATE FUNCTION aiqsa_memory_assert_run_preparation(p_run_id text)
RETURNS void LANGUAGE plpgsql AS $memory_run_preparation$
DECLARE
  run_status "ModelRunStatus";
  live_attempt_count integer;
BEGIN
  SELECT "status" INTO run_status FROM "ModelRun" WHERE "id" = p_run_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO live_attempt_count
  FROM "MemoryRetrievalAttempt"
  WHERE "modelRunId" = p_run_id AND "state" IN ('PENDING', 'EXECUTING', 'READY');

  IF run_status = 'preparing' AND live_attempt_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PREPARING ModelRun must have exactly one nonterminal Memory retrieval attempt';
  ELSIF run_status <> 'preparing' AND live_attempt_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Non-PREPARING ModelRun cannot retain a nonterminal Memory retrieval attempt';
  END IF;
END
$memory_run_preparation$;

CREATE FUNCTION aiqsa_memory_run_preparation_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_run_preparation_trigger$
BEGIN
  IF TG_TABLE_NAME = 'ModelRun' THEN
    PERFORM aiqsa_memory_assert_run_preparation(NEW."id");
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_run_preparation(NEW."modelRunId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_run_preparation(OLD."modelRunId");
    END IF;
  END IF;
  RETURN NULL;
END
$memory_run_preparation_trigger$;

CREATE CONSTRAINT TRIGGER "ModelRun_memory_preparation_guard"
AFTER INSERT OR UPDATE ON "ModelRun"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_run_preparation_trigger();

CREATE CONSTRAINT TRIGGER "MemoryRetrievalAttempt_run_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryRetrievalAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_run_preparation_trigger();

ALTER TABLE "MemoryExecutionBinding"
  ADD CONSTRAINT "MemoryExecutionBinding_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_job_fkey"
    FOREIGN KEY ("userId", "memoryJobId") REFERENCES "MemoryJob"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_attempt_fkey"
    FOREIGN KEY ("userId", "retrievalAttemptId") REFERENCES "MemoryRetrievalAttempt"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_run_fkey"
    FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_tool_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_connection_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_model_fkey"
    FOREIGN KEY ("connectionId", "providerModelId") REFERENCES "ProviderModel"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_credential_fkey"
    FOREIGN KEY ("connectionId", "credentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_version_fkey"
    FOREIGN KEY ("credentialId", "credentialVersionId") REFERENCES "ProviderCredentialVersion"("credentialId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryExecutionBinding_shape_check"
    CHECK (
      "ordinal" >= 0
      AND (
        ("ownerType" = 'JOB' AND "memoryJobId" IS NOT NULL AND num_nonnulls("retrievalAttemptId", "modelRunId", "modelRunToolCallId") = 0)
        OR ("ownerType" = 'RETRIEVAL_ATTEMPT' AND "retrievalAttemptId" IS NOT NULL AND num_nonnulls("memoryJobId", "modelRunId", "modelRunToolCallId") = 0)
        OR ("ownerType" = 'MODEL_RUN_TOOL_CALL' AND num_nonnulls("modelRunId", "modelRunToolCallId") = 2 AND num_nonnulls("memoryJobId", "retrievalAttemptId") = 0)
      )
      AND (
        ("state" = 'PENDING' AND num_nonnulls("startedAt", "completedAt") = 0)
        OR ("state" = 'RUNNING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
        OR ("state" = 'OUTCOME_UNKNOWN' AND num_nonnulls("startedAt", "completedAt") = 2)
        OR ("state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND "completedAt" IS NOT NULL)
      )
      AND ("startedAt" IS NULL OR "startedAt" >= "createdAt")
      AND ("completedAt" IS NULL OR "completedAt" >= COALESCE("startedAt", "createdAt"))
      AND "providerId" IS NOT NULL
      AND (
        (
          "relationsDetachedAt" IS NULL
          AND num_nonnulls("connectionId", "providerModelId", "credentialId", "credentialVersionId") = 4
        )
        OR
        (
          "relationsDetachedAt" IS NOT NULL
          AND "state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
          AND num_nonnulls("connectionId", "providerModelId", "credentialId", "credentialVersionId", "providerResponseId") = 0
          AND "recoverableUntil" IS NOT NULL
          AND "recoverableUntil" <= "relationsDetachedAt"
        )
      )
      AND (
        ("usageCompleteness" = 'UNAVAILABLE' AND num_nonnulls("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "estimatedCostMicros") = 0)
        OR ("usageCompleteness" = 'PARTIAL' AND num_nonnulls("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "estimatedCostMicros") > 0)
        OR ("usageCompleteness" = 'COMPLETE' AND num_nonnulls("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens") = 5)
      )
      AND COALESCE("inputTokens", 0) >= 0
      AND COALESCE("cachedInputTokens", 0) >= 0
      AND COALESCE("outputTokens", 0) >= 0
      AND COALESCE("reasoningTokens", 0) >= 0
      AND COALESCE("totalTokens", 0) >= 0
      AND COALESCE("estimatedCostMicros", 0) >= 0
    );

CREATE UNIQUE INDEX "MemoryExecutionBinding_job_ordinal_idx"
  ON "MemoryExecutionBinding"("userId", "memoryJobId", "logicalRole", "ordinal")
  WHERE "ownerType" = 'JOB';
CREATE UNIQUE INDEX "MemoryExecutionBinding_attempt_ordinal_idx"
  ON "MemoryExecutionBinding"("userId", "retrievalAttemptId", "logicalRole", "ordinal")
  WHERE "ownerType" = 'RETRIEVAL_ATTEMPT';
CREATE UNIQUE INDEX "MemoryExecutionBinding_tool_ordinal_idx"
  ON "MemoryExecutionBinding"("userId", "modelRunId", "modelRunToolCallId", "logicalRole", "ordinal")
  WHERE "ownerType" = 'MODEL_RUN_TOOL_CALL';

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_memory_execution_fkey"
  FOREIGN KEY ("userId", "memoryExecutionBindingId")
  REFERENCES "MemoryExecutionBinding"("userId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ModelRunMemoryBinding"
  ADD CONSTRAINT "ModelRunMemoryBinding_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryBinding_run_fkey"
    FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryBinding_attempt_fkey"
    FOREIGN KEY ("userId", "modelRunId", "retrievalAttemptId")
    REFERENCES "MemoryRetrievalAttempt"("userId", "modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryBinding_generation_fkey"
    FOREIGN KEY ("userId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryBinding_shape_check"
    CHECK (
      "memoryGenerationSnapshot" >= 0
      AND "retrievalRevisionSnapshot" >= 0
      AND "finalizedRevisionSnapshot" >= "retrievalRevisionSnapshot"
      AND "contextTokenCount" >= 0
    );

ALTER TABLE "ModelRunMemoryItem"
  ADD CONSTRAINT "ModelRunMemoryItem_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryItem_binding_fkey"
    FOREIGN KEY ("userId", "bindingId") REFERENCES "ModelRunMemoryBinding"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryItem_version_fkey"
    FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", "id")
    ON DELETE SET NULL ("factVersionId") ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModelRunMemoryItem_shape_check"
    CHECK (
      "ordinal" >= 0
      AND "itemType" = 'FACT_VERSION'
      AND char_length("includedText") BETWEEN 1 AND 4000
      AND "finalScore" BETWEEN 0 AND 1
    );

CREATE FUNCTION aiqsa_memory_assert_run_binding(p_run_id text)
RETURNS void LANGUAGE plpgsql AS $memory_run_binding$
DECLARE
  invalid_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelRun" WHERE "id" = p_run_id) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO invalid_count
  FROM "ModelRunMemoryBinding" binding
  JOIN "MemoryRetrievalAttempt" attempt ON attempt."id" = binding."retrievalAttemptId"
  JOIN "ModelRun" run ON run."id" = binding."modelRunId"
  WHERE binding."modelRunId" = p_run_id
    AND (
      attempt."state" <> 'CONSUMED'
      OR attempt."outcome" IS DISTINCT FROM binding."outcome"
      OR attempt."memoryGenerationSnapshot" <> binding."memoryGenerationSnapshot"
      OR attempt."retrievalRevisionSnapshot" <> binding."retrievalRevisionSnapshot"
      OR run."status" = 'preparing'
      OR run."normalizedRequest" IS NULL
      OR run."providerRequestPreview" IS NULL
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ModelRun Memory binding does not match its consumed attempt and finalized run';
  END IF;

  SELECT count(*) INTO invalid_count
  FROM "MemoryRetrievalAttempt" attempt
  WHERE attempt."modelRunId" = p_run_id
    AND attempt."state" = 'CONSUMED'
    AND NOT EXISTS (
      SELECT 1 FROM "ModelRunMemoryBinding" binding
      WHERE binding."retrievalAttemptId" = attempt."id"
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'CONSUMED Memory retrieval attempt must create its final run binding';
  END IF;
END
$memory_run_binding$;

CREATE FUNCTION aiqsa_memory_run_binding_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_run_binding_trigger$
DECLARE
  run_id text;
BEGIN
  IF TG_TABLE_NAME = 'ModelRun' THEN
    run_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    run_id := OLD."modelRunId";
  ELSE
    run_id := NEW."modelRunId";
  END IF;
  PERFORM aiqsa_memory_assert_run_binding(run_id);
  RETURN NULL;
END
$memory_run_binding_trigger$;

CREATE CONSTRAINT TRIGGER "ModelRun_memory_binding_guard"
AFTER INSERT OR UPDATE ON "ModelRun"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_run_binding_trigger();
CREATE CONSTRAINT TRIGGER "MemoryAttempt_final_binding_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryRetrievalAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_run_binding_trigger();
CREATE CONSTRAINT TRIGGER "ModelRunMemoryBinding_final_guard"
AFTER INSERT OR UPDATE OR DELETE ON "ModelRunMemoryBinding"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_run_binding_trigger();

ALTER TABLE "UserMemorySettings"
  ADD CONSTRAINT "UserMemorySettings_active_generation_fkey"
  FOREIGN KEY ("userId", "activeIndexGenerationId")
  REFERENCES "MemoryIndexGeneration"("userId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION aiqsa_memory_assert_active_generation(p_user_id text)
RETURNS void LANGUAGE plpgsql AS $memory_active_generation$
DECLARE
  active_pointer text;
  active_count integer;
  pointed_state "MemoryIndexGenerationState";
  settings_exist boolean;
BEGIN
  SELECT "activeIndexGenerationId", true INTO active_pointer, settings_exist
  FROM "UserMemorySettings" WHERE "userId" = p_user_id;

  SELECT count(*) INTO active_count FROM "MemoryIndexGeneration"
  WHERE "userId" = p_user_id AND "state" = 'ACTIVE';

  IF COALESCE(settings_exist, false) = false THEN
    IF EXISTS (SELECT 1 FROM "User" WHERE "id" = p_user_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Every user must retain one inert-or-enabled Memory settings row';
    END IF;
    IF active_count <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'ACTIVE Memory generation requires owner settings';
    END IF;
    RETURN;
  END IF;

  IF active_pointer IS NULL THEN
    IF active_count <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'ACTIVE Memory generation must be selected by owner settings';
    END IF;
  ELSE
    SELECT "state" INTO pointed_state FROM "MemoryIndexGeneration"
    WHERE "userId" = p_user_id AND "id" = active_pointer;
    IF pointed_state IS DISTINCT FROM 'ACTIVE' OR active_count <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Memory settings must point to the one same-owner ACTIVE generation';
    END IF;
  END IF;
END
$memory_active_generation$;

CREATE FUNCTION aiqsa_memory_active_generation_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_active_generation_trigger$
BEGIN
  IF TG_TABLE_NAME = 'UserMemorySettings' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_active_generation(NEW."userId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_active_generation(OLD."userId");
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_active_generation(NEW."userId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_active_generation(OLD."userId");
    END IF;
  END IF;
  RETURN NULL;
END
$memory_active_generation_trigger$;

CREATE CONSTRAINT TRIGGER "UserMemorySettings_active_generation_guard"
AFTER INSERT OR UPDATE OR DELETE ON "UserMemorySettings"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_active_generation_trigger();
CREATE CONSTRAINT TRIGGER "MemoryIndexGeneration_active_pointer_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryIndexGeneration"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_active_generation_trigger();

-- Every existing owner receives inert settings. No Memory gate is enabled and
-- no history backfill or provider work is scheduled by this migration.
INSERT INTO "UserMemorySettings" ("userId")
SELECT "id" FROM "User"
ON CONFLICT ("userId") DO NOTHING;

CREATE FUNCTION aiqsa_memory_create_default_settings() RETURNS trigger
LANGUAGE plpgsql AS $memory_default_settings$
BEGIN
  INSERT INTO "UserMemorySettings" ("userId") VALUES (NEW."id")
  ON CONFLICT ("userId") DO NOTHING;
  RETURN NEW;
END
$memory_default_settings$;

CREATE TRIGGER "User_memory_settings_default"
AFTER INSERT ON "User"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_create_default_settings();
