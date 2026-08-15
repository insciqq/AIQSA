-- Required by Knowledge and Memory vector columns and indexes.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AuthAccessRuleKind" AS ENUM ('email', 'domain');

-- CreateEnum
CREATE TYPE "AuthFlowTokenPurpose" AS ENUM ('email_verification', 'password_reset', 'invite_acceptance');

-- CreateEnum
CREATE TYPE "AuthIdentityProvider" AS ENUM ('password', 'google', 'yandex');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'disabled', 'denied');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('queued', 'streaming', 'complete', 'cancelled', 'error');

-- CreateEnum
CREATE TYPE "ModelRunStatus" AS ENUM ('preparing', 'queued', 'streaming', 'in_progress', 'complete', 'cancelled', 'error');

-- CreateEnum
CREATE TYPE "SearchRunStatus" AS ENUM ('complete', 'error');

-- CreateEnum
CREATE TYPE "KnowledgeRunOutcome" AS ENUM ('complete', 'zero_above_threshold', 'base_empty', 'base_indexing', 'embedding_model_unavailable');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "McpOAuthConnectionState" AS ENUM ('ready', 'reauthorization_required', 'disconnecting', 'disconnected');

-- CreateEnum
CREATE TYPE "McpOAuthPurpose" AS ENUM ('user', 'validation');

-- CreateEnum
CREATE TYPE "McpRuntimeState" AS ENUM ('starting', 'ready', 'failed', 'idle', 'stopping');

-- CreateEnum
CREATE TYPE "McpActivationStage" AS ENUM ('queued', 'resolving', 'preparing_runtime', 'connecting', 'discovering_tools', 'publishing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "ModelRunToolCallState" AS ENUM ('pending', 'running', 'complete', 'error', 'cancelled');

-- CreateEnum
CREATE TYPE "ProviderUnassignedPolicy" AS ENUM ('use_default', 'require_assignment');

-- CreateEnum
CREATE TYPE "ProviderCredentialCheckStatus" AS ENUM ('available', 'unavailable');

-- CreateEnum
CREATE TYPE "ProviderRunRole" AS ENUM ('answer', 'search');

-- CreateEnum
CREATE TYPE "ProviderModelClass" AS ENUM ('answer', 'embedding');

-- CreateEnum
CREATE TYPE "ProviderCredentialSource" AS ENUM ('default', 'group', 'user');

-- CreateEnum
CREATE TYPE "MemorySensitiveAutomaticPolicy" AS ENUM ('EXPLICIT_ONLY');

-- CreateEnum
CREATE TYPE "MemoryScopeType" AS ENUM ('GLOBAL_USER', 'FOLDER', 'ASSISTANT', 'CHAT');

-- CreateEnum
CREATE TYPE "MemoryScopeState" AS ENUM ('ACTIVE', 'ORPHANED', 'RETRACTED');

-- CreateEnum
CREATE TYPE "MemoryFactState" AS ENUM ('ACTIVE', 'CONFLICTED', 'ORPHANED', 'EXPIRED', 'RETRACTED', 'FORGOTTEN');

-- CreateEnum
CREATE TYPE "MemoryCandidateState" AS ENUM ('PENDING', 'DEFERRED', 'PROMOTED', 'REJECTED', 'STALE');

-- CreateEnum
CREATE TYPE "MemoryConsolidationOperation" AS ENUM ('ADD', 'REINFORCE', 'SUPERSEDE', 'CONFLICT', 'EXPIRE', 'NOOP', 'DEFER');

-- CreateEnum
CREATE TYPE "MemoryCandidateDecisionState" AS ENUM ('PENDING_VERIFICATION', 'APPLIED', 'REJECTED', 'STALE');

-- CreateEnum
CREATE TYPE "MemoryTemperatureClass" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "MemoryCoreSalience" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'NONE');

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
CREATE TYPE "MemoryEvidenceSourceType" AS ENUM ('MESSAGE', 'EXPLICIT_ACTION');

-- CreateEnum
CREATE TYPE "MemoryActorType" AS ENUM ('USER', 'SYSTEM', 'JOB');

-- CreateEnum
CREATE TYPE "MemoryEventOperation" AS ENUM ('EXPLICIT_SAVE', 'AUTO_PROPOSE', 'PROMOTE', 'REINFORCE', 'EDIT', 'SUPERSEDE', 'CONFLICT', 'EXPIRE', 'RETRACT', 'FORGET', 'SOURCE_INVALIDATE', 'SCOPE_CHANGE', 'PIN', 'UNPIN', 'USER_FEEDBACK', 'INDEX_SWITCH', 'REBUILD');

-- CreateEnum
CREATE TYPE "MemoryFeedbackType" AS ENUM ('CORRECT', 'INCORRECT', 'NOT_USEFUL', 'WRONG_SCOPE', 'OUTDATED', 'TOO_SENSITIVE', 'RETRACT');

-- CreateEnum
CREATE TYPE "MemoryFeedbackTargetKind" AS ENUM ('FACT_VERSION', 'RECALL_CHUNK');

-- CreateEnum
CREATE TYPE "MemorySuppressionScope" AS ENUM ('FACT', 'VALUE', 'SOURCE_MESSAGE', 'CATEGORY', 'ALL');

-- CreateEnum
CREATE TYPE "MemorySourceBarrierKind" AS ENUM ('AUTOMATIC_FACTS', 'HISTORY_INDEX', 'ALL_REUSABLE');

-- CreateEnum
CREATE TYPE "MemoryJobKind" AS ENUM ('INDEX_HISTORY', 'EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'EMBED_ITEMS', 'RECONCILE_BRANCH', 'RECONCILE_SOURCE', 'REBUILD_INDEX');

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
CREATE TYPE "MemorySearchItemType" AS ENUM ('FACT_VERSION', 'RECALL_CHUNK');

-- CreateEnum
CREATE TYPE "MemoryHistoryCheckpointStatus" AS ENUM ('PENDING', 'INDEXING', 'READY', 'STALE', 'FAILED');

-- CreateEnum
CREATE TYPE "MemoryHistoryItemState" AS ENUM ('ACTIVE', 'INVALIDATED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "MemoryDerivedSafetyClass" AS ENUM ('NORMAL', 'SENSITIVE', 'HIGHLY_SENSITIVE', 'SECRET_TAINTED');

-- CreateEnum
CREATE TYPE "MemoryRedactionState" AS ENUM ('NOT_NEEDED', 'REDACTED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "MemoryDeletionOperation" AS ENUM ('FORGET_PURGE', 'SOURCE_PURGE', 'TEMPORARY_DELETE', 'BULK_CLEAR', 'ACCOUNT_MEMORY_DELETE');

-- CreateEnum
CREATE TYPE "MemoryDeletionState" AS ENUM ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN', 'SUCCEEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemoryMutationAction" AS ENUM ('SAVE', 'EDIT', 'MOVE_SCOPE', 'FORGET', 'BULK_DELETE');

-- CreateEnum
CREATE TYPE "MemoryOperationOutcome" AS ENUM ('APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MemoryIndexGenerationState" AS ENUM ('BUILDING', 'CATCHING_UP', 'READY', 'ACTIVE', 'SUPERSEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemoryIndexMode" AS ENUM ('LEXICAL_ONLY', 'HYBRID');

-- CreateEnum
CREATE TYPE "MemoryEmbeddingState" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "MemoryHistoryRunState" AS ENUM ('RUNNING', 'COMPLETE', 'ERROR', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemoryHistoryRunOutcome" AS ENUM ('RESULTS', 'EMPTY', 'DISABLED', 'DEGRADED', 'FAILED');

-- CreateEnum
CREATE TYPE "MemoryReceiptRetentionState" AS ENUM ('RETAINED', 'SCRUBBED');

-- CreateEnum
CREATE TYPE "MemoryToolEgressMode" AS ENUM ('PROVIDER_REQUEST', 'TOOL_CALL');

-- CreateEnum
CREATE TYPE "MemoryToolEgressDispatchState" AS ENUM ('DISPATCHED', 'COMPLETED', 'BLOCKED', 'FAILED');

-- CreateEnum
CREATE TYPE "GroupSystemRole" AS ENUM ('full_access');

-- CreateEnum
CREATE TYPE "AssistantPublicationScope" AS ENUM ('group', 'installation');

-- CreateEnum
CREATE TYPE "KnowledgeBasePublicationScope" AS ENUM ('group', 'installation');

-- CreateEnum
CREATE TYPE "KnowledgeDocumentIngestState" AS ENUM ('queued', 'parsing', 'chunking', 'embedding', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "KnowledgeIndexGenerationStatus" AS ENUM ('building', 'ready', 'active', 'retired', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "status" "UserStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmtpControl" (
    "id" TEXT NOT NULL,
    "draftConfig" JSONB,
    "draftPasswordEnvelope" TEXT,
    "draftSecretGeneration" INTEGER,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "testedDraftVersion" INTEGER,
    "draftTestVersion" INTEGER,
    "draftTestAt" TIMESTAMP(3),
    "draftTestCode" TEXT,
    "activeConfig" JSONB,
    "activePasswordEnvelope" TEXT,
    "activeSecretGeneration" INTEGER,
    "activeVersion" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "secretGenerationCounter" INTEGER NOT NULL DEFAULT 0,
    "healthActiveVersion" INTEGER,
    "lastAttemptAt" TIMESTAMP(3),
    "lastAcceptedAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "configurationUpdatedAt" TIMESTAMP(3),
    "configurationUpdatedByUserId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmtpControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AuthIdentityProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokedReason" TEXT,
    "createdByIp" TEXT,
    "createdByUserAgent" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRateLimitBucket" (
    "keyHash" CHAR(64) NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "resetAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AuthRateLimitBucket_pkey" PRIMARY KEY ("keyHash")
);

-- CreateTable
CREATE TABLE "AuthAccessRule" (
    "id" TEXT NOT NULL,
    "kind" "AuthAccessRuleKind" NOT NULL,
    "value" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAccessRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAccessRuleGroup" (
    "accessRuleId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAccessRuleGroup_pkey" PRIMARY KEY ("accessRuleId","groupId")
);

-- CreateTable
CREATE TABLE "AuthInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthInviteGroup" (
    "inviteId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthInviteGroup_pkey" PRIMARY KEY ("inviteId","groupId")
);

-- CreateTable
CREATE TABLE "AuthFlowToken" (
    "id" TEXT NOT NULL,
    "purpose" "AuthFlowTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT,
    "identityId" TEXT,
    "inviteId" TEXT,
    "normalizedEmail" TEXT,
    "sentToEmail" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthFlowToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "systemRole" "GroupSystemRole",
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserGroup" (
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGroup_pkey" PRIMARY KEY ("userId","groupId")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "defaultProviderModelId" TEXT,
    "defaultFolderId" TEXT,
    "defaultSearchStrategyId" TEXT NOT NULL DEFAULT 'openai-native-web-search',
    "defaultSearchPlan" JSONB,
    "defaultControlValues" JSONB NOT NULL DEFAULT '{}',
    "showCitations" BOOLEAN NOT NULL DEFAULT true,
    "showReasoningBlocks" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchPolicy" (
    "id" TEXT NOT NULL,
    "defaultPlan" JSONB NOT NULL DEFAULT '{"mode":"all_selected","optionIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgePolicy" (
    "id" TEXT NOT NULL,
    "candidateLimit" INTEGER NOT NULL DEFAULT 40,
    "resultLimit" INTEGER NOT NULL DEFAULT 8,
    "scoreThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelPolicy" (
    "id" TEXT NOT NULL,
    "defaultProviderModelId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemModelPolicy" (
    "id" TEXT NOT NULL,
    "providerModelId" TEXT,
    "reasoningEffort" VARCHAR(32),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemModelPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryEgressAdminPolicy" (
    "id" TEXT NOT NULL,
    "acceptedFingerprint" VARCHAR(128),
    "acceptedPolicyVersion" VARCHAR(64),
    "acceptedDestinations" JSONB NOT NULL DEFAULT '[]',
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEgressAdminPolicy_pkey" PRIMARY KEY ("id")
);

-- Required installation-owned singleton foundations. Earlier development
-- migrations created these rows alongside their tables; the squashed baseline
-- must preserve the same clean-install invariant before bootstrap starts.
INSERT INTO "SmtpControl" ("id")
VALUES ('installation-smtp');

INSERT INTO "SearchPolicy" ("id", "updatedAt")
VALUES ('installation', CURRENT_TIMESTAMP);

INSERT INTO "KnowledgePolicy" ("id", "updatedAt")
VALUES ('installation', CURRENT_TIMESTAMP);

INSERT INTO "ModelPolicy" ("id", "updatedAt")
VALUES ('installation', CURRENT_TIMESTAMP);

INSERT INTO "SystemModelPolicy" ("id", "updatedAt")
VALUES ('installation', CURRENT_TIMESTAMP);

INSERT INTO "MemoryEgressAdminPolicy" ("id")
VALUES ('installation');

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "groupId" TEXT,
    "providerConnectionId" TEXT,
    "providerModelId" TEXT,
    "searchStrategy" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "projectMemory" TEXT NOT NULL DEFAULT '',
    "defaultKnowledgePlan" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantDefinition" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "currentRevisionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantRevision" (
    "id" TEXT NOT NULL,
    "assistantId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT,
    "avatar" JSONB NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "developerPrompt" TEXT,
    "runControls" JSONB NOT NULL DEFAULT '{}',
    "searchPlan" JSONB NOT NULL,
    "mcpServerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "knowledgeBaseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "starterPrompts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantPublication" (
    "id" TEXT NOT NULL,
    "assistantId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "scope" "AssistantPublicationScope" NOT NULL,
    "groupId" TEXT,
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantPin" (
    "userId" TEXT NOT NULL,
    "assistantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantPin_pkey" PRIMARY KEY ("userId","assistantId")
);

-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "activeIndexGenerationId" TEXT,
    "contentRevision" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeIndexGeneration" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "embeddingProviderModelId" TEXT NOT NULL,
    "sourceIndexGenerationId" TEXT,
    "sourceBaseVersion" INTEGER,
    "targetContentRevision" INTEGER,
    "embeddingConfiguration" JSONB NOT NULL,
    "vectorSpaceFingerprint" CHAR(64) NOT NULL,
    "targetDimension" INTEGER NOT NULL,
    "chunkingProfileVersion" INTEGER NOT NULL,
    "indexedContentRevision" INTEGER NOT NULL DEFAULT 0,
    "status" "KnowledgeIndexGenerationStatus" NOT NULL DEFAULT 'building',
    "lastErrorCode" VARCHAR(64),
    "readyAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeIndexGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocumentVersion" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ingestGenerationId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "originalStorageKey" TEXT,
    "normalizedTextStorageKey" TEXT,
    "normalizedTextByteSize" INTEGER,
    "normalizedTextChecksum" CHAR(64),
    "pageCount" INTEGER,
    "visibleFromRevision" INTEGER,
    "visibleUntilRevision" INTEGER,
    "ingestState" "KnowledgeDocumentIngestState" NOT NULL DEFAULT 'queued',
    "ingestErrorCode" VARCHAR(64),
    "ingestClaimToken" VARCHAR(128),
    "ingestClaimedAt" TIMESTAMP(3),
    "ingestAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "ingestNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestChunkCount" INTEGER,
    "ingestEmbeddedChunkCount" INTEGER NOT NULL DEFAULT 0,
    "ingestStartedAt" TIMESTAMP(3),
    "ingestCompletedAt" TIMESTAMP(3),
    "payloadPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGenerationDocument" (
    "knowledgeBaseId" TEXT NOT NULL,
    "indexGenerationId" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "state" "KnowledgeDocumentIngestState" NOT NULL DEFAULT 'queued',
    "errorCode" VARCHAR(64),
    "claimToken" VARCHAR(128),
    "claimedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "chunkCount" INTEGER,
    "embeddedChunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeGenerationDocument_pkey" PRIMARY KEY ("indexGenerationId","documentVersionId")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "indexGenerationId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "headingPath" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text" TEXT NOT NULL,
    "embeddingDimension" INTEGER NOT NULL,
    "embedding" vector,
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBasePublication" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "scope" "KnowledgeBasePublicationScope" NOT NULL,
    "groupId" TEXT,
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBasePublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderModel" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "templateKey" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "modelClass" "ProviderModelClass" NOT NULL DEFAULT 'answer',
    "inputTokenPriceMicros" INTEGER NOT NULL DEFAULT 0,
    "outputTokenPriceMicros" INTEGER NOT NULL DEFAULT 0,
    "supportsVision" BOOLEAN NOT NULL DEFAULT false,
    "supportsPdf" BOOLEAN NOT NULL DEFAULT false,
    "supportsReasoning" BOOLEAN NOT NULL DEFAULT false,
    "supportsNativeSearch" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "draftConfig" JSONB NOT NULL DEFAULT '{}',
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "activeConfig" JSONB,
    "activeVersion" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "capabilities" JSONB NOT NULL,
    "defaultParams" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT,
    "displayName" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "unassignedPolicy" "ProviderUnassignedPolicy" NOT NULL DEFAULT 'use_default',
    "defaultCredentialId" TEXT,
    "draftConfig" JSONB NOT NULL DEFAULT '{}',
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "activeConfig" JSONB,
    "activeVersion" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchOption" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "templateKey" TEXT,
    "sourceConnectionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "draftSecretEnvelope" TEXT,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "activeVersionId" TEXT,
    "testedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCredentialVersion" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "secretEnvelope" TEXT,
    "testEvidence" JSONB NOT NULL,
    "testedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCredentialVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderGroupCredentialAssignment" (
    "connectionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderGroupCredentialAssignment_pkey" PRIMARY KEY ("connectionId","groupId")
);

-- CreateTable
CREATE TABLE "ProviderUserCredentialAssignment" (
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderUserCredentialAssignment_pkey" PRIMARY KEY ("connectionId","userId")
);

-- CreateTable
CREATE TABLE "ProviderDraftCheck" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "credentialVersionId" TEXT,
    "credentialDraftVersion" INTEGER,
    "connectionDraftVersion" INTEGER NOT NULL,
    "modelDraftVersion" INTEGER NOT NULL,
    "status" "ProviderCredentialCheckStatus" NOT NULL,
    "evidence" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderDraftCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderModelCredentialCheck" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "credentialVersionId" TEXT NOT NULL,
    "connectionVersion" INTEGER NOT NULL,
    "modelVersion" INTEGER NOT NULL,
    "status" "ProviderCredentialCheckStatus" NOT NULL,
    "evidence" JSONB,
    "latestRefreshError" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "refreshFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderModelCredentialCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRunBinding" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "bindingKey" TEXT NOT NULL DEFAULT 'answer',
    "role" "ProviderRunRole" NOT NULL,
    "connectionId" TEXT,
    "providerModelId" TEXT,
    "credentialId" TEXT,
    "credentialVersionId" TEXT,
    "credentialSource" "ProviderCredentialSource" NOT NULL,
    "executionSnapshot" JSONB NOT NULL,
    "recoverableUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderRunBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeRunBinding" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "baseContentRevision" INTEGER NOT NULL,
    "indexGenerationId" TEXT NOT NULL,
    "indexedContentRevision" INTEGER NOT NULL,
    "vectorSpaceFingerprint" CHAR(64) NOT NULL,
    "targetDimension" INTEGER NOT NULL,
    "embeddingConnectionId" TEXT NOT NULL,
    "embeddingProviderModelId" TEXT NOT NULL,
    "embeddingCredentialId" TEXT NOT NULL,
    "embeddingCredentialVersionId" TEXT NOT NULL,
    "embeddingCredentialSource" "ProviderCredentialSource" NOT NULL,
    "embeddingExecutionSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeRunBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchStrategy" (
    "id" TEXT NOT NULL,
    "searchOptionId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "providerModelId" TEXT,
    "displayName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "adapterKind" TEXT NOT NULL DEFAULT 'answer_provider_hosted',
    "credentialMode" TEXT NOT NULL DEFAULT 'answer_provider',
    "draft" JSONB NOT NULL DEFAULT '{}',
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "testedDraftHash" TEXT,
    "draftTestEvidence" JSONB,
    "activeRevisionId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchIntegrationRevision" (
    "id" TEXT NOT NULL,
    "searchStrategyId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "adapterKind" TEXT NOT NULL,
    "credentialMode" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "providerModelId" TEXT,
    "validationEvidence" JSONB NOT NULL,
    "draftHash" TEXT NOT NULL,
    "validationFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchIntegrationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "folderId" TEXT,
    "title" TEXT NOT NULL,
    "activeLeafMessageId" TEXT,
    "defaultProviderModelId" TEXT,
    "defaultKnowledgePlan" JSONB,
    "memoryMode" "MemoryChatMode" NOT NULL DEFAULT 'NORMAL',
    "memoryBranchGeneration" INTEGER NOT NULL DEFAULT 0,
    "memorySourceRevision" INTEGER NOT NULL DEFAULT 0,
    "permanentDeletionAt" TIMESTAMP(3),
    "permanentDeletionOperationId" TEXT,
    "temporaryRetentionPolicyVersion" VARCHAR(64),
    "temporaryRetentionDeadline" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalReasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "parentMessageId" TEXT,
    "content" JSONB NOT NULL,
    "groundedAt" TIMESTAMP(3),
    "groundingProvider" TEXT,
    "groundingStrategy" TEXT,
    "provider" TEXT,
    "modelId" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'complete',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRun" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT,
    "assistantId" TEXT,
    "assistantRevisionId" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" "ModelRunStatus" NOT NULL,
    "normalizedRequest" JSONB,
    "providerResponseId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicros" INTEGER NOT NULL DEFAULT 0,
    "errorPayload" JSONB,
    "toolLoopState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRunEvent" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "activeRevisionId" TEXT,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "testedDraftHash" TEXT,
    "draftTestEvidence" JSONB,
    "sharedConfigEnvelope" TEXT,
    "sharedConfigVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpActivationJob" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "draftHash" TEXT NOT NULL,
    "sharedConfigVersion" INTEGER NOT NULL,
    "validationUserId" TEXT,
    "stage" "McpActivationStage" NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "issues" JSONB,
    "leaseId" TEXT,
    "workloadToken" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpActivationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpRevision" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "configuration" JSONB NOT NULL,
    "resolvedArtifact" JSONB,
    "validationEvidence" JSONB NOT NULL,
    "draftHash" TEXT NOT NULL,
    "identityHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpGrant" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT,
    "groupId" TEXT,
    "canUse" BOOLEAN NOT NULL DEFAULT false,
    "personalSlotKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpUserServer" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "personalConfigEnvelope" TEXT,
    "personalConfigVersion" INTEGER NOT NULL DEFAULT 0,
    "desiredRuntimeGenerationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpUserServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "registrationKey" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientMetadata" JSONB NOT NULL,
    "clientSecretEnvelope" TEXT,
    "clientSecretGeneration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthConnection" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "oauthClientId" TEXT,
    "purpose" "McpOAuthPurpose" NOT NULL,
    "policyFingerprint" TEXT NOT NULL,
    "state" "McpOAuthConnectionState" NOT NULL DEFAULT 'ready',
    "tokenEnvelope" TEXT,
    "tokenGeneration" INTEGER NOT NULL DEFAULT 0,
    "externalAccountLabel" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "disconnectRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpRuntimeGeneration" (
    "id" TEXT NOT NULL,
    "userServerId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "oauthConnectionId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "credentialSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalAccountLabel" TEXT,
    "effectiveConfigEnvelope" TEXT,
    "inventory" JSONB,
    "inventoryUpdatedAt" TIMESTAMP(3),
    "state" "McpRuntimeState" NOT NULL DEFAULT 'starting',
    "readinessCheckedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "retryAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpRuntimeGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpRunBinding" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "runtimeGenerationId" TEXT,
    "runtimeGenerationFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpRunBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRunToolCall" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "mcpRunBindingId" TEXT,
    "roundIndex" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "providerCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "state" "ModelRunToolCallState" NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelRunToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeRun" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "modelRunToolCallId" TEXT NOT NULL,
    "invocationOrdinal" INTEGER NOT NULL,
    "query" VARCHAR(500) NOT NULL,
    "outcome" "KnowledgeRunOutcome" NOT NULL,
    "fusion" VARCHAR(32) NOT NULL,
    "candidateLimit" INTEGER NOT NULL,
    "resultLimit" INTEGER NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "baseEvidence" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "providerText" TEXT NOT NULL,
    "embeddingUsage" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "failureCode" VARCHAR(128),
    "rerankerBinding" JSONB,
    "preRerankOrder" JSONB,
    "postRerankOrder" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchRun" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "searchRevisionId" TEXT,
    "invocationId" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "artifacts" JSONB NOT NULL,
    "status" "SearchRunStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentProcessingFairnessCursor" (
    "pipeline" VARCHAR(32) NOT NULL,
    "lastGrantedOwnerUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentProcessingFairnessCursor_pkey" PRIMARY KEY ("pipeline")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'ready',
    "processingErrorCode" VARCHAR(64),
    "byteSize" INTEGER NOT NULL,
    "extractedText" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentProcessingJob" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentDeletionJob" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentDeletionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedChatSnapshot" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "chatId" TEXT,
    "slugHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedChatSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "modelRunId" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "providerModelId" TEXT,
    "knowledgeBaseId" TEXT,
    "knowledgeIndexGenerationId" TEXT,
    "knowledgeDocumentVersionId" TEXT,
    "knowledgeBatchIndex" INTEGER,
    "memoryExecutionBindingId" TEXT,
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "cacheWriteInputTokens" INTEGER,
    "outputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "totalTokens" INTEGER,
    "estimatedCostMicros" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMemorySettings" (
    "userId" TEXT NOT NULL,
    "useMemoryFacts" BOOLEAN NOT NULL DEFAULT true,
    "referenceChatHistory" BOOLEAN NOT NULL DEFAULT true,
    "learnAutomatically" BOOLEAN NOT NULL DEFAULT true,
    "memoryGeneration" INTEGER NOT NULL DEFAULT 0,
    "memoryRevision" INTEGER NOT NULL DEFAULT 0,
    "activeIndexGenerationId" TEXT,
    "embeddingProviderModelId" TEXT,
    "sensitiveAutomaticPolicy" "MemorySensitiveAutomaticPolicy" NOT NULL DEFAULT 'EXPLICIT_ONLY',
    "memoryConsentRevision" INTEGER NOT NULL DEFAULT 0,
    "settingsRevision" INTEGER NOT NULL DEFAULT 0,
    "acceptedUtilityEgressFingerprint" VARCHAR(128),
    "acceptedUtilityPolicyVersion" VARCHAR(64),
    "acceptedUtilityEgressAt" TIMESTAMP(3),
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
CREATE TABLE "ChatMemoryCheckpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "branchGeneration" INTEGER NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "activeLeafMessageId" TEXT NOT NULL,
    "sourceContentHash" VARCHAR(128) NOT NULL,
    "lastIndexedMessageId" TEXT,
    "status" "MemoryHistoryCheckpointStatus" NOT NULL DEFAULT 'PENDING',
    "lastSucceededAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMemoryCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryRecallChunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "sourceFolderId" TEXT,
    "sourceAssistantId" TEXT,
    "branchGeneration" INTEGER NOT NULL,
    "sourceRevisionAtCreation" INTEGER NOT NULL,
    "chunkOrdinal" INTEGER NOT NULL,
    "contentHash" VARCHAR(128) NOT NULL,
    "safeProjectedText" TEXT NOT NULL,
    "normalizedSafeSearchText" TEXT NOT NULL,
    "languageCode" VARCHAR(35) NOT NULL,
    "occurredFrom" TIMESTAMP(3) NOT NULL,
    "occurredTo" TIMESTAMP(3) NOT NULL,
    "state" "MemoryHistoryItemState" NOT NULL DEFAULT 'ACTIVE',
    "chunkingVersion" VARCHAR(64) NOT NULL,
    "sourceProjectionVersion" VARCHAR(64) NOT NULL,
    "safetyClass" "MemoryDerivedSafetyClass" NOT NULL,
    "redactionState" "MemoryRedactionState" NOT NULL,
    "redactionReasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryRecallChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryRecallChunkMessage" (
    "userId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "startOffset" INTEGER,
    "endOffset" INTEGER,

    CONSTRAINT "MemoryRecallChunkMessage_pkey" PRIMARY KEY ("chunkId","messageId")
);

-- CreateTable
CREATE TABLE "MemoryCandidate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "branchGeneration" INTEGER NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "sourceHash" VARCHAR(128) NOT NULL,
    "sourceProjectionHash" VARCHAR(128) NOT NULL,
    "sourceProjectionVersion" VARCHAR(64) NOT NULL,
    "createdByExecutionId" TEXT NOT NULL,
    "proposedCanonicalKey" VARCHAR(256),
    "proposedDisplayText" TEXT,
    "proposedValue" JSONB,
    "proposedCategory" VARCHAR(64),
    "proposedModality" "MemoryFactModality",
    "proposedScope" JSONB,
    "proposedValidFrom" TIMESTAMP(3),
    "proposedValidTo" TIMESTAMP(3),
    "rawTemporalExpression" VARCHAR(512),
    "sourceTimezone" VARCHAR(64),
    "temporalResolverVersion" VARCHAR(64),
    "temporalResolutionEvidence" JSONB,
    "proposedDirectness" "MemoryDirectness",
    "proposedSensitivity" "MemorySensitivityClass",
    "proposedCoreEligible" BOOLEAN,
    "proposedCoreSalience" "MemoryCoreSalience",
    "languageCode" VARCHAR(35),
    "importance" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "negated" BOOLEAN,
    "state" "MemoryCandidateState" NOT NULL DEFAULT 'PENDING',
    "reasonCode" VARCHAR(64),
    "pipelineVersion" VARCHAR(64) NOT NULL,
    "resolvedFactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "contentPurgedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryCandidateMessage" (
    "userId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "sourceTextHash" VARCHAR(128) NOT NULL,

    CONSTRAINT "MemoryCandidateMessage_pkey" PRIMARY KEY ("candidateId","messageId")
);

-- CreateTable
CREATE TABLE "MemoryCandidateDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "consolidationJobId" TEXT NOT NULL,
    "consolidationExecutionId" TEXT NOT NULL,
    "operation" "MemoryConsolidationOperation" NOT NULL,
    "targetFactId" TEXT,
    "targetVersionId" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "reasonCode" VARCHAR(64) NOT NULL,
    "requiresVerification" BOOLEAN NOT NULL,
    "state" "MemoryCandidateDecisionState" NOT NULL,
    "relatedSnapshotHash" VARCHAR(64) NOT NULL,
    "consolidationInputHash" VARCHAR(64) NOT NULL,
    "consolidationOutputHash" VARCHAR(64) NOT NULL,
    "verificationJobId" TEXT,
    "verificationInputHash" VARCHAR(64),
    "verificationExecutionId" TEXT,
    "verificationOutputHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryCandidateDecision_pkey" PRIMARY KEY ("id")
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
    "coreEligible" BOOLEAN NOT NULL DEFAULT false,
    "coreSalience" "MemoryCoreSalience" NOT NULL DEFAULT 'NONE',
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
    "sourceDeletedAt" TIMESTAMP(3),
    "sourceGeneration" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyFingerprint" VARCHAR(128) NOT NULL,
    "requestId" VARCHAR(256) NOT NULL,
    "feedbackType" "MemoryFeedbackType" NOT NULL,
    "targetKind" "MemoryFeedbackTargetKind" NOT NULL,
    "memoryFactId" TEXT,
    "memoryFactVersionId" TEXT,
    "recallChunkId" TEXT,
    "modelRunId" TEXT,
    "modelRunMemoryItemId" TEXT,
    "modelRunToolCallId" TEXT,
    "sourceChatIdSnapshot" TEXT,
    "sourceBranchGenerationSnapshot" INTEGER,
    "comment" VARCHAR(1000),
    "retractsFeedbackId" TEXT,
    "memoryEventId" TEXT,
    "contentPurgedAt" TIMESTAMP(3),
    "purgeReason" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryFeedback_pkey" PRIMARY KEY ("id")
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
    "factVersionId" TEXT,
    "recallChunkId" TEXT,
    "normalizedSearchText" TEXT NOT NULL,
    "safeContentHash" VARCHAR(128) NOT NULL,
    "languageCode" VARCHAR(35) NOT NULL,
    "safetyIdentitySnapshot" VARCHAR(128) NOT NULL,
    "sourceIdentitySnapshot" VARCHAR(128) NOT NULL,
    "suppressionIdentitySnapshot" VARCHAR(128) NOT NULL,
    "embedding" vector,
    "embeddingDimension" INTEGER,
    "embeddingState" "MemoryEmbeddingState" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "searchVectorSimple" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE("normalizedSearchText", ''::text))) STORED,
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
    "admissionAuthorizationId" TEXT,
    "admittedChatSourceRevision" INTEGER,
    "admittedActiveLeafMessageId" TEXT,
    "alsoForgetOriginMemories" BOOLEAN,
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
    "externalRolesUsed" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
    "factVersionId" TEXT,
    "recallChunkId" TEXT,
    "sourceChatIdSnapshot" TEXT,
    "sourceBranchGenerationSnapshot" INTEGER,
    "sourceRevisionSnapshot" INTEGER,
    "sourceContentHashSnapshot" VARCHAR(128),
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
    "exactItemId" TEXT NOT NULL,
    "factVersionId" TEXT,
    "recallChunkId" TEXT,
    "sourceChatIdSnapshot" TEXT,
    "sourceBranchGenerationSnapshot" INTEGER,
    "sourceRevisionSnapshot" INTEGER,
    "sourceContentHashSnapshot" VARCHAR(128),
    "sourceMessageIdsSnapshot" TEXT[] DEFAULT ARRAY[]::TEXT[],
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

-- CreateTable
CREATE TABLE "MemoryHistoryRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "modelRunToolCallId" TEXT NOT NULL,
    "invocationOrdinal" INTEGER NOT NULL,
    "state" "MemoryHistoryRunState" NOT NULL DEFAULT 'RUNNING',
    "outcome" "MemoryHistoryRunOutcome",
    "query" VARCHAR(2000),
    "queryHash" VARCHAR(128) NOT NULL,
    "privateRequest" JSONB NOT NULL,
    "indexingEvidence" JSONB NOT NULL DEFAULT '{}',
    "executionBindingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "results" JSONB,
    "providerResult" JSONB,
    "resultHash" VARCHAR(128),
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "errorCode" VARCHAR(128),
    "retentionState" "MemoryReceiptRetentionState" NOT NULL DEFAULT 'RETAINED',
    "plaintextPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryHistoryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryToolEgressReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "modelRunToolCallId" TEXT,
    "requestOrdinal" INTEGER NOT NULL,
    "mode" "MemoryToolEgressMode" NOT NULL,
    "destinationKind" VARCHAR(64) NOT NULL,
    "destinationFingerprint" VARCHAR(128) NOT NULL,
    "destinationSnapshot" JSONB NOT NULL,
    "requestEvidenceHash" VARCHAR(128) NOT NULL,
    "requestPreviewHash" VARCHAR(128),
    "dispatchState" "MemoryToolEgressDispatchState" NOT NULL DEFAULT 'DISPATCHED',
    "dispatchStartedAt" TIMESTAMP(3),
    "dispatchCompletedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryToolEgressReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "AuthIdentity_normalizedEmail_idx" ON "AuthIdentity"("normalizedEmail");

-- CreateIndex
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_providerAccountId_key" ON "AuthIdentity"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_normalizedEmail_key" ON "AuthIdentity"("provider", "normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_revokedAt_idx" ON "AuthSession"("revokedAt");

-- CreateIndex
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthRateLimitBucket_resetAt_idx" ON "AuthRateLimitBucket"("resetAt");

-- CreateIndex
CREATE INDEX "AuthAccessRule_enabled_idx" ON "AuthAccessRule"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AuthAccessRule_kind_value_key" ON "AuthAccessRule"("kind", "value");

-- CreateIndex
CREATE INDEX "AuthAccessRuleGroup_groupId_idx" ON "AuthAccessRuleGroup"("groupId");

-- CreateIndex
CREATE INDEX "AuthInvite_expiresAt_idx" ON "AuthInvite"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthInvite_normalizedEmail_idx" ON "AuthInvite"("normalizedEmail");

-- CreateIndex
CREATE INDEX "AuthInvite_revokedAt_idx" ON "AuthInvite"("revokedAt");

-- CreateIndex
CREATE INDEX "AuthInviteGroup_groupId_idx" ON "AuthInviteGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthFlowToken_tokenHash_key" ON "AuthFlowToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthFlowToken_identityId_idx" ON "AuthFlowToken"("identityId");

-- CreateIndex
CREATE INDEX "AuthFlowToken_inviteId_idx" ON "AuthFlowToken"("inviteId");

-- CreateIndex
CREATE INDEX "AuthFlowToken_normalizedEmail_idx" ON "AuthFlowToken"("normalizedEmail");

-- CreateIndex
CREATE INDEX "AuthFlowToken_consumedAt_idx" ON "AuthFlowToken"("consumedAt");

-- CreateIndex
CREATE INDEX "AuthFlowToken_purpose_expiresAt_idx" ON "AuthFlowToken"("purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthFlowToken_userId_idx" ON "AuthFlowToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Group_systemRole_key" ON "Group"("systemRole");

-- CreateIndex
CREATE INDEX "Group_archivedAt_idx" ON "Group"("archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE INDEX "UserSettings_defaultProviderModelId_idx" ON "UserSettings"("defaultProviderModelId");

-- CreateIndex
CREATE INDEX "SearchPolicy_updatedByUserId_idx" ON "SearchPolicy"("updatedByUserId");

-- CreateIndex
CREATE INDEX "KnowledgePolicy_updatedByUserId_idx" ON "KnowledgePolicy"("updatedByUserId");

-- CreateIndex
CREATE INDEX "ModelPolicy_defaultProviderModelId_idx" ON "ModelPolicy"("defaultProviderModelId");

-- CreateIndex
CREATE INDEX "ModelPolicy_updatedByUserId_idx" ON "ModelPolicy"("updatedByUserId");

-- CreateIndex
CREATE INDEX "SystemModelPolicy_providerModelId_idx" ON "SystemModelPolicy"("providerModelId");

-- CreateIndex
CREATE INDEX "SystemModelPolicy_updatedByUserId_idx" ON "SystemModelPolicy"("updatedByUserId");

-- CreateIndex
CREATE INDEX "MemoryEgressAdminPolicy_acceptedByUserId_idx" ON "MemoryEgressAdminPolicy"("acceptedByUserId");

-- CreateIndex
CREATE INDEX "AccessGrant_groupId_idx" ON "AccessGrant"("groupId");

-- CreateIndex
CREATE INDEX "AccessGrant_providerConnectionId_idx" ON "AccessGrant"("providerConnectionId");

-- CreateIndex
CREATE INDEX "AccessGrant_providerModelId_idx" ON "AccessGrant"("providerModelId");

-- CreateIndex
CREATE INDEX "AccessGrant_searchStrategy_idx" ON "AccessGrant"("searchStrategy");

-- CreateIndex
CREATE INDEX "AccessGrant_userId_idx" ON "AccessGrant"("userId");

-- CreateIndex
CREATE INDEX "Folder_parentId_idx" ON "Folder"("parentId");

-- CreateIndex
CREATE INDEX "Folder_userId_sortOrder_idx" ON "Folder"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "Folder_userId_parentId_sortOrder_idx" ON "Folder"("userId", "parentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_userId_parentId_name_key" ON "Folder"("userId", "parentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_userId_id_key" ON "Folder"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantDefinition_currentRevisionId_key" ON "AssistantDefinition"("currentRevisionId");

-- CreateIndex
CREATE INDEX "AssistantDefinition_ownerUserId_archivedAt_idx" ON "AssistantDefinition"("ownerUserId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantDefinition_id_currentRevisionId_key" ON "AssistantDefinition"("id", "currentRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantDefinition_ownerUserId_id_key" ON "AssistantDefinition"("ownerUserId", "id");

-- CreateIndex
CREATE INDEX "AssistantRevision_authorUserId_idx" ON "AssistantRevision"("authorUserId");

-- CreateIndex
CREATE INDEX "AssistantRevision_providerModelId_idx" ON "AssistantRevision"("providerModelId");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantRevision_assistantId_revisionNumber_key" ON "AssistantRevision"("assistantId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantRevision_assistantId_id_key" ON "AssistantRevision"("assistantId", "id");

-- CreateIndex
CREATE INDEX "AssistantPublication_groupId_idx" ON "AssistantPublication"("groupId");

-- CreateIndex
CREATE INDEX "AssistantPublication_assistantId_scope_idx" ON "AssistantPublication"("assistantId", "scope");

-- CreateIndex
CREATE INDEX "AssistantPublication_revisionId_idx" ON "AssistantPublication"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantPublication_assistantId_groupId_key" ON "AssistantPublication"("assistantId", "groupId");

-- CreateIndex
CREATE INDEX "AssistantPin_assistantId_idx" ON "AssistantPin"("assistantId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeBase_activeIndexGenerationId_key" ON "KnowledgeBase"("activeIndexGenerationId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_ownerUserId_archivedAt_idx" ON "KnowledgeBase"("ownerUserId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeBase_id_activeIndexGenerationId_key" ON "KnowledgeBase"("id", "activeIndexGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeBase_id_ownerUserId_key" ON "KnowledgeBase"("id", "ownerUserId");

-- CreateIndex
CREATE INDEX "KnowledgeIndexGeneration_embeddingProviderModelId_idx" ON "KnowledgeIndexGeneration"("embeddingProviderModelId");

-- CreateIndex
CREATE INDEX "KnowledgeIndexGeneration_knowledgeBaseId_status_idx" ON "KnowledgeIndexGeneration"("knowledgeBaseId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeIndexGeneration_sourceIndexGenerationId_idx" ON "KnowledgeIndexGeneration"("sourceIndexGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeIndexGeneration_knowledgeBaseId_id_key" ON "KnowledgeIndexGeneration"("knowledgeBaseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_currentVersionId_key" ON "KnowledgeDocument"("currentVersionId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_knowledgeBaseId_archivedAt_idx" ON "KnowledgeDocument"("knowledgeBaseId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_knowledgeBaseId_id_key" ON "KnowledgeDocument"("knowledgeBaseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_id_currentVersionId_key" ON "KnowledgeDocument"("id", "currentVersionId");

-- CreateIndex
CREATE INDEX "KnowledgeDocumentVersion_knowledgeBaseId_ingestState_ingest_idx" ON "KnowledgeDocumentVersion"("knowledgeBaseId", "ingestState", "ingestNextAttemptAt");

-- CreateIndex
CREATE INDEX "KnowledgeDocumentVersion_ingestGenerationId_idx" ON "KnowledgeDocumentVersion"("ingestGenerationId");

-- CreateIndex
CREATE INDEX "KnowledgeDocumentVersion_originalStorageKey_idx" ON "KnowledgeDocumentVersion"("originalStorageKey");

-- CreateIndex
CREATE INDEX "KnowledgeDocumentVersion_normalizedTextStorageKey_idx" ON "KnowledgeDocumentVersion"("normalizedTextStorageKey");

-- CreateIndex
CREATE INDEX "KnowledgeDocumentVersion_knowledgeBaseId_visibleFromRevisio_idx" ON "KnowledgeDocumentVersion"("knowledgeBaseId", "visibleFromRevision", "visibleUntilRevision");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_versionNumber_key" ON "KnowledgeDocumentVersion"("documentId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_id_key" ON "KnowledgeDocumentVersion"("documentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_knowledgeBaseId_id_key" ON "KnowledgeDocumentVersion"("knowledgeBaseId", "id");

-- CreateIndex
CREATE INDEX "KnowledgeGenerationDocument_state_nextAttemptAt_claimedAt_c_idx" ON "KnowledgeGenerationDocument"("state", "nextAttemptAt", "claimedAt", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeGenerationDocument_knowledgeBaseId_documentVersion_idx" ON "KnowledgeGenerationDocument"("knowledgeBaseId", "documentVersionId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_documentVersionId_idx" ON "KnowledgeChunk"("documentVersionId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_knowledgeBaseId_indexGenerationId_idx" ON "KnowledgeChunk"("knowledgeBaseId", "indexGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_indexGenerationId_documentVersionId_chunkInd_key" ON "KnowledgeChunk"("indexGenerationId", "documentVersionId", "chunkIndex");

-- CreateIndex
CREATE INDEX "KnowledgeBasePublication_groupId_idx" ON "KnowledgeBasePublication"("groupId");

-- CreateIndex
CREATE INDEX "KnowledgeBasePublication_knowledgeBaseId_scope_idx" ON "KnowledgeBasePublication"("knowledgeBaseId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeBasePublication_knowledgeBaseId_groupId_key" ON "KnowledgeBasePublication"("knowledgeBaseId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderModel_templateKey_key" ON "ProviderModel"("templateKey");

-- CreateIndex
CREATE INDEX "ProviderModel_provider_modelId_idx" ON "ProviderModel"("provider", "modelId");

-- CreateIndex
CREATE INDEX "ProviderModel_modelClass_enabled_idx" ON "ProviderModel"("modelClass", "enabled");

-- CreateIndex
CREATE INDEX "ProviderModel_connectionId_enabled_idx" ON "ProviderModel"("connectionId", "enabled");

-- CreateIndex
CREATE INDEX "ProviderModel_provider_enabled_idx" ON "ProviderModel"("provider", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderModel_connectionId_id_key" ON "ProviderModel"("connectionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_templateKey_key" ON "ProviderConnection"("templateKey");

-- CreateIndex
CREATE INDEX "ProviderConnection_enabled_idx" ON "ProviderConnection"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SearchOption_optionId_key" ON "SearchOption"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchOption_templateKey_key" ON "SearchOption"("templateKey");

-- CreateIndex
CREATE INDEX "SearchOption_sourceConnectionId_idx" ON "SearchOption"("sourceConnectionId");

-- CreateIndex
CREATE INDEX "SearchOption_enabled_archivedAt_idx" ON "SearchOption"("enabled", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SearchOption_sourceConnectionId_kind_key" ON "SearchOption"("sourceConnectionId", "kind");

-- CreateIndex
CREATE INDEX "ProviderCredential_connectionId_enabled_idx" ON "ProviderCredential"("connectionId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_connectionId_id_key" ON "ProviderCredential"("connectionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_connectionId_label_key" ON "ProviderCredential"("connectionId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_id_activeVersionId_key" ON "ProviderCredential"("id", "activeVersionId");

-- CreateIndex
CREATE INDEX "ProviderCredentialVersion_revokedAt_idx" ON "ProviderCredentialVersion"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredentialVersion_credentialId_id_key" ON "ProviderCredentialVersion"("credentialId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredentialVersion_credentialId_version_key" ON "ProviderCredentialVersion"("credentialId", "version");

-- CreateIndex
CREATE INDEX "ProviderGroupCredentialAssignment_credentialId_idx" ON "ProviderGroupCredentialAssignment"("credentialId");

-- CreateIndex
CREATE INDEX "ProviderGroupCredentialAssignment_groupId_idx" ON "ProviderGroupCredentialAssignment"("groupId");

-- CreateIndex
CREATE INDEX "ProviderUserCredentialAssignment_credentialId_idx" ON "ProviderUserCredentialAssignment"("credentialId");

-- CreateIndex
CREATE INDEX "ProviderUserCredentialAssignment_userId_idx" ON "ProviderUserCredentialAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderDraftCheck_fingerprint_key" ON "ProviderDraftCheck"("fingerprint");

-- CreateIndex
CREATE INDEX "ProviderDraftCheck_connectionId_providerModelId_idx" ON "ProviderDraftCheck"("connectionId", "providerModelId");

-- CreateIndex
CREATE INDEX "ProviderDraftCheck_credentialId_credentialVersionId_idx" ON "ProviderDraftCheck"("credentialId", "credentialVersionId");

-- CreateIndex
CREATE INDEX "ProviderModelCredentialCheck_connection_model_idx" ON "ProviderModelCredentialCheck"("connectionId", "providerModelId");

-- CreateIndex
CREATE INDEX "ProviderModelCredentialCheck_credential_version_idx" ON "ProviderModelCredentialCheck"("credentialId", "credentialVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderModelCredentialCheck_tuple_key" ON "ProviderModelCredentialCheck"("providerModelId", "credentialVersionId", "connectionVersion", "modelVersion");

-- CreateIndex
CREATE INDEX "ProviderRunBinding_modelRunId_role_idx" ON "ProviderRunBinding"("modelRunId", "role");

-- CreateIndex
CREATE INDEX "ProviderRunBinding_connection_model_idx" ON "ProviderRunBinding"("connectionId", "providerModelId");

-- CreateIndex
CREATE INDEX "ProviderRunBinding_credential_version_idx" ON "ProviderRunBinding"("credentialId", "credentialVersionId");

-- CreateIndex
CREATE INDEX "ProviderRunBinding_recoverableUntil_idx" ON "ProviderRunBinding"("recoverableUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRunBinding_modelRunId_bindingKey_key" ON "ProviderRunBinding"("modelRunId", "bindingKey");

-- CreateIndex
CREATE INDEX "KnowledgeRunBinding_knowledgeBaseId_indexGenerationId_idx" ON "KnowledgeRunBinding"("knowledgeBaseId", "indexGenerationId");

-- CreateIndex
CREATE INDEX "KnowledgeRunBinding_embedding_model_idx" ON "KnowledgeRunBinding"("embeddingConnectionId", "embeddingProviderModelId");

-- CreateIndex
CREATE INDEX "KnowledgeRunBinding_credential_version_idx" ON "KnowledgeRunBinding"("embeddingCredentialId", "embeddingCredentialVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeRunBinding_modelRunId_ordinal_key" ON "KnowledgeRunBinding"("modelRunId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeRunBinding_modelRunId_knowledgeBaseId_key" ON "KnowledgeRunBinding"("modelRunId", "knowledgeBaseId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchStrategy_strategyId_key" ON "SearchStrategy"("strategyId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchStrategy_activeRevisionId_key" ON "SearchStrategy"("activeRevisionId");

-- CreateIndex
CREATE INDEX "SearchStrategy_providerModelId_idx" ON "SearchStrategy"("providerModelId");

-- CreateIndex
CREATE INDEX "SearchStrategy_searchOptionId_idx" ON "SearchStrategy"("searchOptionId");

-- CreateIndex
CREATE INDEX "SearchStrategy_enabled_archivedAt_idx" ON "SearchStrategy"("enabled", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SearchStrategy_id_activeRevisionId_key" ON "SearchStrategy"("id", "activeRevisionId");

-- CreateIndex
CREATE INDEX "SearchIntegrationRevision_providerModelId_idx" ON "SearchIntegrationRevision"("providerModelId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchIntegrationRevision_searchStrategyId_revisionNumber_key" ON "SearchIntegrationRevision"("searchStrategyId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SearchIntegrationRevision_strategy_draft_validation_key" ON "SearchIntegrationRevision"("searchStrategyId", "draftHash", "validationFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "SearchIntegrationRevision_searchStrategyId_id_key" ON "SearchIntegrationRevision"("searchStrategyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_permanentDeletionOperationId_key" ON "Chat"("permanentDeletionOperationId");

-- CreateIndex
CREATE INDEX "Chat_activeLeafMessageId_idx" ON "Chat"("activeLeafMessageId");

-- CreateIndex
CREATE INDEX "Chat_defaultProviderModelId_idx" ON "Chat"("defaultProviderModelId");

-- CreateIndex
CREATE INDEX "Chat_memoryMode_temporaryRetentionDeadline_idx" ON "Chat"("memoryMode", "temporaryRetentionDeadline");

-- CreateIndex
CREATE INDEX "Chat_userId_permanentDeletionAt_idx" ON "Chat"("userId", "permanentDeletionAt");

-- CreateIndex
CREATE INDEX "Chat_userId_archived_updatedAt_idx" ON "Chat"("userId", "archived", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_userId_id_key" ON "Chat"("userId", "id");

-- CreateIndex
CREATE INDEX "Message_chatId_parentMessageId_idx" ON "Message"("chatId", "parentMessageId");

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_idx" ON "Message"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_groundingProvider_groundedAt_idx" ON "Message"("groundingProvider", "groundedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_chatId_id_key" ON "Message"("chatId", "id");

-- CreateIndex
CREATE INDEX "ModelRun_assistantId_assistantRevisionId_idx" ON "ModelRun"("assistantId", "assistantRevisionId");

-- CreateIndex
CREATE INDEX "ModelRun_chatId_createdAt_idx" ON "ModelRun"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelRun_provider_modelId_idx" ON "ModelRun"("provider", "modelId");

-- CreateIndex
CREATE INDEX "ModelRun_status_idx" ON "ModelRun"("status");

-- CreateIndex
CREATE INDEX "ModelRun_userId_createdAt_idx" ON "ModelRun"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRun_userId_id_key" ON "ModelRun"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRun_userId_chatId_id_key" ON "ModelRun"("userId", "chatId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunEvent_modelRunId_sequence_key" ON "ModelRunEvent"("modelRunId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_namespace_key" ON "McpServer"("namespace");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_activeRevisionId_key" ON "McpServer"("activeRevisionId");

-- CreateIndex
CREATE INDEX "McpServer_enabled_archivedAt_idx" ON "McpServer"("enabled", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpActivationJob_serverId_key" ON "McpActivationJob"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "McpActivationJob_workloadToken_key" ON "McpActivationJob"("workloadToken");

-- CreateIndex
CREATE INDEX "McpActivationJob_stage_updatedAt_idx" ON "McpActivationJob"("stage", "updatedAt");

-- CreateIndex
CREATE INDEX "McpActivationJob_validationUserId_idx" ON "McpActivationJob"("validationUserId");

-- CreateIndex
CREATE INDEX "McpRevision_serverId_draftHash_idx" ON "McpRevision"("serverId", "draftHash");

-- CreateIndex
CREATE INDEX "McpRevision_serverId_createdAt_idx" ON "McpRevision"("serverId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpRevision_serverId_revisionNumber_key" ON "McpRevision"("serverId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "McpRevision_serverId_identityHash_key" ON "McpRevision"("serverId", "identityHash");

-- CreateIndex
CREATE INDEX "McpGrant_groupId_idx" ON "McpGrant"("groupId");

-- CreateIndex
CREATE INDEX "McpGrant_userId_idx" ON "McpGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "McpGrant_serverId_userId_key" ON "McpGrant"("serverId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "McpGrant_serverId_groupId_key" ON "McpGrant"("serverId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "McpUserServer_desiredRuntimeGenerationId_key" ON "McpUserServer"("desiredRuntimeGenerationId");

-- CreateIndex
CREATE INDEX "McpUserServer_userId_enabled_idx" ON "McpUserServer"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "McpUserServer_userId_serverId_key" ON "McpUserServer"("userId", "serverId");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthClient_registrationKey_key" ON "McpOAuthClient"("registrationKey");

-- CreateIndex
CREATE INDEX "McpOAuthConnection_oauthClientId_idx" ON "McpOAuthConnection"("oauthClientId");

-- CreateIndex
CREATE INDEX "McpOAuthConnection_serverId_userId_purpose_state_idx" ON "McpOAuthConnection"("serverId", "userId", "purpose", "state");

-- CreateIndex
CREATE UNIQUE INDEX "McpRuntimeGeneration_fingerprint_key" ON "McpRuntimeGeneration"("fingerprint");

-- CreateIndex
CREATE INDEX "McpRuntimeGeneration_oauthConnectionId_idx" ON "McpRuntimeGeneration"("oauthConnectionId");

-- CreateIndex
CREATE INDEX "McpRuntimeGeneration_revisionId_idx" ON "McpRuntimeGeneration"("revisionId");

-- CreateIndex
CREATE INDEX "McpRuntimeGeneration_state_retryAt_idx" ON "McpRuntimeGeneration"("state", "retryAt");

-- CreateIndex
CREATE INDEX "McpRuntimeGeneration_userServerId_idx" ON "McpRuntimeGeneration"("userServerId");

-- CreateIndex
CREATE INDEX "McpRunBinding_runtimeGenerationId_idx" ON "McpRunBinding"("runtimeGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "McpRunBinding_modelRunId_runtimeGenerationFingerprint_key" ON "McpRunBinding"("modelRunId", "runtimeGenerationFingerprint");

-- CreateIndex
CREATE INDEX "ModelRunToolCall_mcpRunBindingId_idx" ON "ModelRunToolCall"("mcpRunBindingId");

-- CreateIndex
CREATE INDEX "ModelRunToolCall_modelRunId_state_idx" ON "ModelRunToolCall"("modelRunId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunToolCall_modelRunId_roundIndex_providerCallId_key" ON "ModelRunToolCall"("modelRunId", "roundIndex", "providerCallId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunToolCall_modelRunId_roundIndex_ordinal_key" ON "ModelRunToolCall"("modelRunId", "roundIndex", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunToolCall_modelRunId_id_key" ON "ModelRunToolCall"("modelRunId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeRun_modelRunToolCallId_key" ON "KnowledgeRun"("modelRunToolCallId");

-- CreateIndex
CREATE INDEX "KnowledgeRun_modelRunId_createdAt_idx" ON "KnowledgeRun"("modelRunId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeRun_modelRunId_modelRunToolCallId_key" ON "KnowledgeRun"("modelRunId", "modelRunToolCallId");

-- CreateIndex
CREATE INDEX "SearchRun_strategyId_idx" ON "SearchRun"("strategyId");

-- CreateIndex
CREATE INDEX "SearchRun_searchRevisionId_idx" ON "SearchRun"("searchRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchRun_modelRunId_invocationId_key" ON "SearchRun"("modelRunId", "invocationId");

-- CreateIndex
CREATE INDEX "Attachment_userId_createdAt_idx" ON "Attachment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE INDEX "Attachment_storageKey_idx" ON "Attachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_id_userId_key" ON "Attachment"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentProcessingJob_attachmentId_key" ON "AttachmentProcessingJob"("attachmentId");

-- CreateIndex
CREATE INDEX "AttachmentProcessingJob_owner_due_idx" ON "AttachmentProcessingJob"("ownerUserId", "nextAttemptAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AttachmentProcessingJob_due_owner_idx" ON "AttachmentProcessingJob"("nextAttemptAt", "createdAt", "ownerUserId", "id");

-- CreateIndex
CREATE INDEX "AttachmentProcessingJob_nextAttemptAt_claimedAt_createdAt_idx" ON "AttachmentProcessingJob"("nextAttemptAt", "claimedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentProcessingJob_attachmentId_ownerUserId_key" ON "AttachmentProcessingJob"("attachmentId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentDeletionJob_storageKey_key" ON "AttachmentDeletionJob"("storageKey");

-- CreateIndex
CREATE INDEX "AttachmentDeletionJob_claimedAt_createdAt_idx" ON "AttachmentDeletionJob"("claimedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SharedChatSnapshot_slugHash_key" ON "SharedChatSnapshot"("slugHash");

-- CreateIndex
CREATE INDEX "SharedChatSnapshot_chatId_createdAt_idx" ON "SharedChatSnapshot"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "SharedChatSnapshot_ownerUserId_createdAt_idx" ON "SharedChatSnapshot"("ownerUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_memoryExecutionBindingId_key" ON "UsageEvent"("memoryExecutionBindingId");

-- CreateIndex
CREATE INDEX "UsageEvent_userId_createdAt_idx" ON "UsageEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_provider_modelId_idx" ON "UsageEvent"("provider", "modelId");

-- CreateIndex
CREATE INDEX "UsageEvent_knowledgeBaseId_createdAt_idx" ON "UsageEvent"("knowledgeBaseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_knowledgeIndexGenerationId_knowledgeDocumentVers_key" ON "UsageEvent"("knowledgeIndexGenerationId", "knowledgeDocumentVersionId", "knowledgeBatchIndex");

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
CREATE INDEX "ChatMemoryCheckpoint_userId_status_updatedAt_idx" ON "ChatMemoryCheckpoint"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatMemoryCheckpoint_chatId_activeLeafMessageId_idx" ON "ChatMemoryCheckpoint"("chatId", "activeLeafMessageId");

-- CreateIndex
CREATE INDEX "ChatMemoryCheckpoint_chatId_lastIndexedMessageId_idx" ON "ChatMemoryCheckpoint"("chatId", "lastIndexedMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMemoryCheckpoint_userId_id_key" ON "ChatMemoryCheckpoint"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMemoryCheckpoint_userId_chatId_key" ON "ChatMemoryCheckpoint"("userId", "chatId");

-- CreateIndex
CREATE INDEX "MemoryRecallChunk_userId_chatId_state_branchGeneration_sour_idx" ON "MemoryRecallChunk"("userId", "chatId", "state", "branchGeneration", "sourceRevisionAtCreation");

-- CreateIndex
CREATE INDEX "MemoryRecallChunk_userId_sourceFolderId_state_idx" ON "MemoryRecallChunk"("userId", "sourceFolderId", "state");

-- CreateIndex
CREATE INDEX "MemoryRecallChunk_userId_sourceAssistantId_state_idx" ON "MemoryRecallChunk"("userId", "sourceAssistantId", "state");

-- CreateIndex
CREATE INDEX "MemoryRecallChunk_userId_occurredFrom_occurredTo_idx" ON "MemoryRecallChunk"("userId", "occurredFrom", "occurredTo");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRecallChunk_userId_id_key" ON "MemoryRecallChunk"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRecallChunk_userId_chatId_id_key" ON "MemoryRecallChunk"("userId", "chatId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRecallChunk_source_identity_key" ON "MemoryRecallChunk"("userId", "id", "chatId", "branchGeneration", "sourceRevisionAtCreation", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRecallChunk_source_ordinal_key" ON "MemoryRecallChunk"("userId", "chatId", "branchGeneration", "sourceRevisionAtCreation", "chunkingVersion", "sourceProjectionVersion", "chunkOrdinal");

-- CreateIndex
CREATE INDEX "MemoryRecallChunkMessage_userId_chatId_messageId_idx" ON "MemoryRecallChunkMessage"("userId", "chatId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRecallChunkMessage_chunkId_ordinal_key" ON "MemoryRecallChunkMessage"("chunkId", "ordinal");

-- CreateIndex
CREATE INDEX "MemoryCandidate_userId_jobId_idx" ON "MemoryCandidate"("userId", "jobId");

-- CreateIndex
CREATE INDEX "MemoryCandidate_userId_chatId_state_branchGeneration_source_idx" ON "MemoryCandidate"("userId", "chatId", "state", "branchGeneration", "sourceRevision");

-- CreateIndex
CREATE INDEX "MemoryCandidate_userId_createdByExecutionId_idx" ON "MemoryCandidate"("userId", "createdByExecutionId");

-- CreateIndex
CREATE INDEX "MemoryCandidate_userId_resolvedFactId_idx" ON "MemoryCandidate"("userId", "resolvedFactId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCandidate_userId_id_key" ON "MemoryCandidate"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCandidate_userId_chatId_id_key" ON "MemoryCandidate"("userId", "chatId", "id");

-- CreateIndex
CREATE INDEX "MemoryCandidateMessage_userId_chatId_messageId_idx" ON "MemoryCandidateMessage"("userId", "chatId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCandidateMessage_candidateId_ordinal_key" ON "MemoryCandidateMessage"("candidateId", "ordinal");

-- CreateIndex
CREATE INDEX "MemoryCandidateDecision_userId_state_createdAt_idx" ON "MemoryCandidateDecision"("userId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryCandidateDecision_userId_consolidationJobId_idx" ON "MemoryCandidateDecision"("userId", "consolidationJobId");

-- CreateIndex
CREATE INDEX "MemoryCandidateDecision_userId_verificationJobId_idx" ON "MemoryCandidateDecision"("userId", "verificationJobId");

-- CreateIndex
CREATE INDEX "MemoryCandidateDecision_userId_targetFactId_targetVersionId_idx" ON "MemoryCandidateDecision"("userId", "targetFactId", "targetVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCandidateDecision_userId_id_key" ON "MemoryCandidateDecision"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCandidateDecision_userId_candidateId_key" ON "MemoryCandidateDecision"("userId", "candidateId");

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
CREATE INDEX "MemoryFeedback_userId_memoryFactId_memoryFactVersionId_crea_idx" ON "MemoryFeedback"("userId", "memoryFactId", "memoryFactVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryFeedback_userId_recallChunkId_createdAt_idx" ON "MemoryFeedback"("userId", "recallChunkId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryFeedback_userId_modelRunId_modelRunMemoryItemId_idx" ON "MemoryFeedback"("userId", "modelRunId", "modelRunMemoryItemId");

-- CreateIndex
CREATE INDEX "MemoryFeedback_userId_modelRunId_modelRunToolCallId_idx" ON "MemoryFeedback"("userId", "modelRunId", "modelRunToolCallId");

-- CreateIndex
CREATE INDEX "MemoryFeedback_userId_sourceChatIdSnapshot_createdAt_idx" ON "MemoryFeedback"("userId", "sourceChatIdSnapshot", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFeedback_userId_id_key" ON "MemoryFeedback"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFeedback_userId_idempotencyFingerprint_key" ON "MemoryFeedback"("userId", "idempotencyFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFeedback_userId_retractsFeedbackId_key" ON "MemoryFeedback"("userId", "retractsFeedbackId");

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
CREATE INDEX "MemorySearchEntry_userId_recallChunkId_idx" ON "MemorySearchEntry"("userId", "recallChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "MemorySearchEntry_userId_id_key" ON "MemorySearchEntry"("userId", "id");

-- CreateIndex
CREATE INDEX "MemoryJob_userId_state_nextAttemptAt_createdAt_idx" ON "MemoryJob"("userId", "state", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryJob_userId_chatId_branchGeneration_sourceRevision_idx" ON "MemoryJob"("userId", "chatId", "branchGeneration", "sourceRevision");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryJob_userId_id_key" ON "MemoryJob"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryJob_userId_idempotencyFingerprint_key" ON "MemoryJob"("userId", "idempotencyFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryJob_source_identity_key" ON "MemoryJob"("userId", "id", "chatId", "branchGeneration", "sourceRevision", "sourceHash");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryDeletionOutbox_admissionAuthorizationId_key" ON "MemoryDeletionOutbox"("admissionAuthorizationId");

-- CreateIndex
CREATE INDEX "MemoryDeletionOutbox_userId_operation_targetId_createdAt_idx" ON "MemoryDeletionOutbox"("userId", "operation", "targetId", "createdAt");

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
CREATE INDEX "MemoryRetrievalAttemptItem_userId_recallChunkId_idx" ON "MemoryRetrievalAttemptItem"("userId", "recallChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttemptItem_userId_id_key" ON "MemoryRetrievalAttemptItem"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttemptItem_userId_attemptId_ordinal_key" ON "MemoryRetrievalAttemptItem"("userId", "attemptId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRetrievalAttemptItem_target_key" ON "MemoryRetrievalAttemptItem"("userId", "attemptId", "itemType", "exactItemId");

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
CREATE INDEX "ModelRunMemoryItem_userId_recallChunkId_idx" ON "ModelRunMemoryItem"("userId", "recallChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryItem_userId_id_key" ON "ModelRunMemoryItem"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRunMemoryItem_userId_bindingId_ordinal_key" ON "ModelRunMemoryItem"("userId", "bindingId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryHistoryRun_modelRunToolCallId_key" ON "MemoryHistoryRun"("modelRunToolCallId");

-- CreateIndex
CREATE INDEX "MemoryHistoryRun_userId_createdAt_idx" ON "MemoryHistoryRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryHistoryRun_userId_retentionState_createdAt_idx" ON "MemoryHistoryRun"("userId", "retentionState", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryHistoryRun_modelRunId_state_idx" ON "MemoryHistoryRun"("modelRunId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryHistoryRun_userId_id_key" ON "MemoryHistoryRun"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryHistoryRun_userId_modelRunId_id_key" ON "MemoryHistoryRun"("userId", "modelRunId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryHistoryRun_modelRunId_invocationOrdinal_key" ON "MemoryHistoryRun"("modelRunId", "invocationOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryHistoryRun_modelRunId_modelRunToolCallId_key" ON "MemoryHistoryRun"("modelRunId", "modelRunToolCallId");

-- CreateIndex
CREATE INDEX "MemoryToolEgressReceipt_userId_dispatchState_createdAt_idx" ON "MemoryToolEgressReceipt"("userId", "dispatchState", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryToolEgressReceipt_modelRunId_mode_idx" ON "MemoryToolEgressReceipt"("modelRunId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryToolEgressReceipt_userId_id_key" ON "MemoryToolEgressReceipt"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryToolEgressReceipt_userId_modelRunId_id_key" ON "MemoryToolEgressReceipt"("userId", "modelRunId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryToolEgressReceipt_modelRunId_requestOrdinal_key" ON "MemoryToolEgressReceipt"("modelRunId", "requestOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryToolEgressReceipt_modelRunId_modelRunToolCallId_key" ON "MemoryToolEgressReceipt"("modelRunId", "modelRunToolCallId");

-- AddForeignKey
ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_activatedByUserId_fkey" FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_configurationUpdatedByUserId_fkey" FOREIGN KEY ("configurationUpdatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccessRule" ADD CONSTRAINT "AuthAccessRule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccessRuleGroup" ADD CONSTRAINT "AuthAccessRuleGroup_accessRuleId_fkey" FOREIGN KEY ("accessRuleId") REFERENCES "AuthAccessRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccessRuleGroup" ADD CONSTRAINT "AuthAccessRuleGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInvite" ADD CONSTRAINT "AuthInvite_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInvite" ADD CONSTRAINT "AuthInvite_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInviteGroup" ADD CONSTRAINT "AuthInviteGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInviteGroup" ADD CONSTRAINT "AuthInviteGroup_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "AuthInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthFlowToken" ADD CONSTRAINT "AuthFlowToken_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "AuthIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthFlowToken" ADD CONSTRAINT "AuthFlowToken_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "AuthInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthFlowToken" ADD CONSTRAINT "AuthFlowToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGroup" ADD CONSTRAINT "UserGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGroup" ADD CONSTRAINT "UserGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_defaultProviderModelId_fkey" FOREIGN KEY ("defaultProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchPolicy" ADD CONSTRAINT "SearchPolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelPolicy" ADD CONSTRAINT "ModelPolicy_defaultProviderModelId_fkey" FOREIGN KEY ("defaultProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelPolicy" ADD CONSTRAINT "ModelPolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryEgressAdminPolicy" ADD CONSTRAINT "MemoryEgressAdminPolicy_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantDefinition" ADD CONSTRAINT "AssistantDefinition_currentRevision_fkey" FOREIGN KEY ("id", "currentRevisionId") REFERENCES "AssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssistantDefinition" ADD CONSTRAINT "AssistantDefinition_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_revision_fkey" FOREIGN KEY ("assistantId", "revisionId") REFERENCES "AssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssistantPin" ADD CONSTRAINT "AssistantPin_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantPin" ADD CONSTRAINT "AssistantPin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_activeIndexGeneration_fkey" FOREIGN KEY ("id", "activeIndexGenerationId") REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_embeddingProviderModelId_fkey" FOREIGN KEY ("embeddingProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_source_fkey" FOREIGN KEY ("knowledgeBaseId", "sourceIndexGenerationId") REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_currentVersion_fkey" FOREIGN KEY ("id", "currentVersionId") REFERENCES "KnowledgeDocumentVersion"("documentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_document_fkey" FOREIGN KEY ("knowledgeBaseId", "documentId") REFERENCES "KnowledgeDocument"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_ingestGeneration_fkey" FOREIGN KEY ("knowledgeBaseId", "ingestGenerationId") REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_knowledgeBase_owner_fkey" FOREIGN KEY ("knowledgeBaseId", "ownerUserId") REFERENCES "KnowledgeBase"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_version_fkey" FOREIGN KEY ("knowledgeBaseId", "documentVersionId") REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_generation_fkey" FOREIGN KEY ("knowledgeBaseId", "indexGenerationId") REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_knowledgeBase_owner_fkey" FOREIGN KEY ("knowledgeBaseId", "ownerUserId") REFERENCES "KnowledgeBase"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentVersion_fkey" FOREIGN KEY ("knowledgeBaseId", "documentVersionId") REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_indexGeneration_fkey" FOREIGN KEY ("knowledgeBaseId", "indexGenerationId") REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeBasePublication" ADD CONSTRAINT "KnowledgeBasePublication_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBasePublication" ADD CONSTRAINT "KnowledgeBasePublication_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBasePublication" ADD CONSTRAINT "KnowledgeBasePublication_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderModel" ADD CONSTRAINT "ProviderModel_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_defaultCredential_fkey" FOREIGN KEY ("id", "defaultCredentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SearchOption" ADD CONSTRAINT "SearchOption_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_activeVersion_fkey" FOREIGN KEY ("id", "activeVersionId") REFERENCES "ProviderCredentialVersion"("credentialId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCredentialVersion" ADD CONSTRAINT "ProviderCredentialVersion_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ProviderCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderGroupCredentialAssignment" ADD CONSTRAINT "ProviderGroupAssignment_credential_fkey" FOREIGN KEY ("connectionId", "credentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderGroupCredentialAssignment" ADD CONSTRAINT "ProviderGroupAssignment_group_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderUserCredentialAssignment" ADD CONSTRAINT "ProviderUserAssignment_credential_fkey" FOREIGN KEY ("connectionId", "credentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderUserCredentialAssignment" ADD CONSTRAINT "ProviderUserAssignment_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderDraftCheck" ADD CONSTRAINT "ProviderDraftCheck_credential_fkey" FOREIGN KEY ("connectionId", "credentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderDraftCheck" ADD CONSTRAINT "ProviderDraftCheck_version_fkey" FOREIGN KEY ("credentialId", "credentialVersionId") REFERENCES "ProviderCredentialVersion"("credentialId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderDraftCheck" ADD CONSTRAINT "ProviderDraftCheck_model_fkey" FOREIGN KEY ("connectionId", "providerModelId") REFERENCES "ProviderModel"("connectionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderModelCredentialCheck" ADD CONSTRAINT "ProviderModelCredentialCheck_credential_fkey" FOREIGN KEY ("connectionId", "credentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderModelCredentialCheck" ADD CONSTRAINT "ProviderModelCredentialCheck_version_fkey" FOREIGN KEY ("credentialId", "credentialVersionId") REFERENCES "ProviderCredentialVersion"("credentialId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderModelCredentialCheck" ADD CONSTRAINT "ProviderModelCredentialCheck_model_fkey" FOREIGN KEY ("connectionId", "providerModelId") REFERENCES "ProviderModel"("connectionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderRunBinding" ADD CONSTRAINT "ProviderRunBinding_credential_fkey" FOREIGN KEY ("connectionId", "credentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderRunBinding" ADD CONSTRAINT "ProviderRunBinding_version_fkey" FOREIGN KEY ("credentialId", "credentialVersionId") REFERENCES "ProviderCredentialVersion"("credentialId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderRunBinding" ADD CONSTRAINT "ProviderRunBinding_model_fkey" FOREIGN KEY ("connectionId", "providerModelId") REFERENCES "ProviderModel"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProviderRunBinding" ADD CONSTRAINT "ProviderRunBinding_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_credential_fkey" FOREIGN KEY ("embeddingConnectionId", "embeddingCredentialId") REFERENCES "ProviderCredential"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_credentialVersion_fkey" FOREIGN KEY ("embeddingCredentialId", "embeddingCredentialVersionId") REFERENCES "ProviderCredentialVersion"("credentialId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_embeddingModel_fkey" FOREIGN KEY ("embeddingConnectionId", "embeddingProviderModelId") REFERENCES "ProviderModel"("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_generation_fkey" FOREIGN KEY ("knowledgeBaseId", "indexGenerationId") REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchStrategy" ADD CONSTRAINT "SearchStrategy_activeRevision_fkey" FOREIGN KEY ("id", "activeRevisionId") REFERENCES "SearchIntegrationRevision"("searchStrategyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SearchStrategy" ADD CONSTRAINT "SearchStrategy_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchStrategy" ADD CONSTRAINT "SearchStrategy_searchOptionId_fkey" FOREIGN KEY ("searchOptionId") REFERENCES "SearchOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchIntegrationRevision" ADD CONSTRAINT "SearchIntegrationRevision_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchIntegrationRevision" ADD CONSTRAINT "SearchIntegrationRevision_searchStrategyId_fkey" FOREIGN KEY ("searchStrategyId") REFERENCES "SearchStrategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_id_activeLeafMessageId_fkey" FOREIGN KEY ("id", "activeLeafMessageId") REFERENCES "Message"("chatId", "id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_defaultProviderModelId_fkey" FOREIGN KEY ("defaultProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_parentMessageId_fkey" FOREIGN KEY ("chatId", "parentMessageId") REFERENCES "Message"("chatId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_assistantRevision_fkey" FOREIGN KEY ("assistantId", "assistantRevisionId") REFERENCES "AssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRunEvent" ADD CONSTRAINT "ModelRunEvent_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_activeRevisionId_fkey" FOREIGN KEY ("activeRevisionId") REFERENCES "McpRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpActivationJob" ADD CONSTRAINT "McpActivationJob_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpActivationJob" ADD CONSTRAINT "McpActivationJob_validationUserId_fkey" FOREIGN KEY ("validationUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpRevision" ADD CONSTRAINT "McpRevision_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpUserServer" ADD CONSTRAINT "McpUserServer_desiredRuntimeGenerationId_fkey" FOREIGN KEY ("desiredRuntimeGenerationId") REFERENCES "McpRuntimeGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpUserServer" ADD CONSTRAINT "McpUserServer_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpUserServer" ADD CONSTRAINT "McpUserServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthConnection" ADD CONSTRAINT "McpOAuthConnection_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "McpOAuthClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthConnection" ADD CONSTRAINT "McpOAuthConnection_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthConnection" ADD CONSTRAINT "McpOAuthConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpRuntimeGeneration" ADD CONSTRAINT "McpRuntimeGeneration_oauthConnectionId_fkey" FOREIGN KEY ("oauthConnectionId") REFERENCES "McpOAuthConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpRuntimeGeneration" ADD CONSTRAINT "McpRuntimeGeneration_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "McpRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpRuntimeGeneration" ADD CONSTRAINT "McpRuntimeGeneration_userServerId_fkey" FOREIGN KEY ("userServerId") REFERENCES "McpUserServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpRunBinding" ADD CONSTRAINT "McpRunBinding_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpRunBinding" ADD CONSTRAINT "McpRunBinding_runtimeGenerationId_fkey" FOREIGN KEY ("runtimeGenerationId") REFERENCES "McpRuntimeGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRunToolCall" ADD CONSTRAINT "ModelRunToolCall_mcpRunBindingId_fkey" FOREIGN KEY ("mcpRunBindingId") REFERENCES "McpRunBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelRunToolCall" ADD CONSTRAINT "ModelRunToolCall_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_toolCall_fkey" FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SearchRun" ADD CONSTRAINT "SearchRun_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchRun" ADD CONSTRAINT "SearchRun_searchRevisionId_fkey" FOREIGN KEY ("searchRevisionId") REFERENCES "SearchIntegrationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentProcessingJob" ADD CONSTRAINT "AttachmentProcessingJob_attachment_owner_fkey" FOREIGN KEY ("attachmentId", "ownerUserId") REFERENCES "Attachment"("id", "userId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SharedChatSnapshot" ADD CONSTRAINT "SharedChatSnapshot_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedChatSnapshot" ADD CONSTRAINT "SharedChatSnapshot_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledgeDocumentVersion_fkey" FOREIGN KEY ("knowledgeBaseId", "knowledgeDocumentVersionId") REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledgeIndexGeneration_fkey" FOREIGN KEY ("knowledgeBaseId", "knowledgeIndexGenerationId") REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryHistoryRun" ADD CONSTRAINT "MemoryHistoryRun_modelRun_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemoryHistoryRun" ADD CONSTRAINT "MemoryHistoryRun_toolCall_fkey" FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemoryToolEgressReceipt" ADD CONSTRAINT "MemoryToolEgressReceipt_modelRun_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemoryToolEgressReceipt" ADD CONSTRAINT "MemoryToolEgressReceipt_toolCall_fkey" FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- PostgreSQL-only indexes required by the current pre-production schema.

CREATE UNIQUE INDEX "AssistantPublication_installation_key" ON public."AssistantPublication" USING btree ("assistantId") WHERE (scope = 'installation'::"AssistantPublicationScope");

CREATE UNIQUE INDEX "Folder_userId_top_level_name_key" ON public."Folder" USING btree ("userId", name) WHERE ("parentId" IS NULL);

CREATE UNIQUE INDEX "KnowledgeBasePublication_installation_key" ON public."KnowledgeBasePublication" USING btree ("knowledgeBaseId") WHERE (scope = 'installation'::"KnowledgeBasePublicationScope");

CREATE INDEX "KnowledgeChunk_embedding_1024_hnsw_idx" ON public."KnowledgeChunk" USING hnsw (((embedding)::vector(1024)) vector_cosine_ops) WHERE ("embeddingDimension" = 1024);

CREATE INDEX "KnowledgeChunk_embedding_1536_hnsw_idx" ON public."KnowledgeChunk" USING hnsw (((embedding)::vector(1536)) vector_cosine_ops) WHERE ("embeddingDimension" = 1536);

CREATE INDEX "KnowledgeChunk_searchVector_gin_idx" ON public."KnowledgeChunk" USING gin ("searchVector");

CREATE UNIQUE INDEX "KnowledgeDocumentVersion_one_active_ingest_idx" ON public."KnowledgeDocumentVersion" USING btree ("documentId") WHERE ("ingestState" = ANY (ARRAY['queued'::"KnowledgeDocumentIngestState", 'parsing'::"KnowledgeDocumentIngestState", 'chunking'::"KnowledgeDocumentIngestState", 'embedding'::"KnowledgeDocumentIngestState"]));

CREATE INDEX "KnowledgeDocumentVersion_owner_due_active_idx" ON public."KnowledgeDocumentVersion" USING btree ("ownerUserId", "ingestNextAttemptAt", "createdAt", id) WHERE (("ingestGenerationId" IS NOT NULL) AND ("ingestState" = ANY (ARRAY['queued'::"KnowledgeDocumentIngestState", 'parsing'::"KnowledgeDocumentIngestState", 'chunking'::"KnowledgeDocumentIngestState", 'embedding'::"KnowledgeDocumentIngestState"])));

CREATE INDEX "KnowledgeGenerationDocument_owner_due_active_idx" ON public."KnowledgeGenerationDocument" USING btree ("ownerUserId", "nextAttemptAt", "createdAt", "indexGenerationId", "documentVersionId") WHERE (state = ANY (ARRAY['queued'::"KnowledgeDocumentIngestState", 'embedding'::"KnowledgeDocumentIngestState"]));

CREATE UNIQUE INDEX "KnowledgeIndexGeneration_one_building_reindex_idx" ON public."KnowledgeIndexGeneration" USING btree ("knowledgeBaseId") WHERE ((status = 'building'::"KnowledgeIndexGenerationStatus") AND ("sourceIndexGenerationId" IS NOT NULL));

CREATE UNIQUE INDEX "MemoryDeletionOutbox_temporary_chat_key" ON public."MemoryDeletionOutbox" USING btree ("userId", operation, "targetType", "targetId") WHERE ((operation = 'TEMPORARY_DELETE'::"MemoryDeletionOperation") AND (("targetType")::text = 'TEMPORARY_CHAT@temporary-24h-v1'::text));

CREATE UNIQUE INDEX "MemoryEvidence_action_identity_idx" ON public."MemoryEvidence" USING btree ("userId", "factVersionId", stance, "memoryEventId") WHERE ("sourceType" = 'EXPLICIT_ACTION'::"MemoryEvidenceSourceType");

CREATE UNIQUE INDEX "MemoryEvidence_message_identity_idx" ON public."MemoryEvidence" USING btree ("userId", "factVersionId", stance, "chatId", "messageId", "sourceProjectionVersion") WHERE ("sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType");

CREATE UNIQUE INDEX "MemoryExecutionBinding_attempt_ordinal_idx" ON public."MemoryExecutionBinding" USING btree ("userId", "retrievalAttemptId", "logicalRole", ordinal) WHERE ("ownerType" = 'RETRIEVAL_ATTEMPT'::"MemoryExecutionOwnerType");

CREATE UNIQUE INDEX "MemoryExecutionBinding_job_ordinal_idx" ON public."MemoryExecutionBinding" USING btree ("userId", "memoryJobId", "logicalRole", ordinal) WHERE ("ownerType" = 'JOB'::"MemoryExecutionOwnerType");

CREATE UNIQUE INDEX "MemoryExecutionBinding_tool_ordinal_idx" ON public."MemoryExecutionBinding" USING btree ("userId", "modelRunId", "modelRunToolCallId", "logicalRole", ordinal) WHERE ("ownerType" = 'MODEL_RUN_TOOL_CALL'::"MemoryExecutionOwnerType");

CREATE INDEX "MemoryFact_active_owner_scope_idx" ON public."MemoryFact" USING btree ("userId", "scopeId", "canonicalKey") WHERE (state = 'ACTIVE'::"MemoryFactState");

CREATE UNIQUE INDEX "MemoryFactVersion_one_active_idx" ON public."MemoryFactVersion" USING btree ("userId", "factId") WHERE (state = 'ACTIVE'::"MemoryFactVersionState");

CREATE UNIQUE INDEX "MemoryIndexGeneration_one_active_idx" ON public."MemoryIndexGeneration" USING btree ("userId") WHERE (state = 'ACTIVE'::"MemoryIndexGenerationState");

CREATE UNIQUE INDEX "MemoryIndexGeneration_one_shadow_idx" ON public."MemoryIndexGeneration" USING btree ("userId") WHERE (state = ANY (ARRAY['BUILDING'::"MemoryIndexGenerationState", 'CATCHING_UP'::"MemoryIndexGenerationState", 'READY'::"MemoryIndexGenerationState"]));

CREATE INDEX "MemoryJob_pending_owner_due_idx" ON public."MemoryJob" USING btree ("userId", "nextAttemptAt", "createdAt") WHERE (state = ANY (ARRAY['QUEUED'::"MemoryJobState", 'RETRYABLE_FAILED'::"MemoryJobState"]));

CREATE UNIQUE INDEX "MemoryOperationReceipt_tool_idempotency_idx" ON public."MemoryOperationReceipt" USING btree ("userId", "modelRunId", "persistedToolCallId", operation, "targetVersionId") NULLS NOT DISTINCT WHERE ("persistedToolCallId" IS NOT NULL);

CREATE UNIQUE INDEX "MemoryRetrievalAttempt_one_nonterminal_idx" ON public."MemoryRetrievalAttempt" USING btree ("modelRunId") WHERE (state = ANY (ARRAY['PENDING'::"MemoryRetrievalAttemptState", 'EXECUTING'::"MemoryRetrievalAttemptState", 'READY'::"MemoryRetrievalAttemptState"]));

CREATE UNIQUE INDEX "MemoryScope_assistant_identity_idx" ON public."MemoryScope" USING btree ("userId", "targetIdSnapshot") WHERE ("scopeType" = 'ASSISTANT'::"MemoryScopeType");

CREATE UNIQUE INDEX "MemoryScope_chat_identity_idx" ON public."MemoryScope" USING btree ("userId", "targetIdSnapshot") WHERE ("scopeType" = 'CHAT'::"MemoryScopeType");

CREATE UNIQUE INDEX "MemoryScope_folder_identity_idx" ON public."MemoryScope" USING btree ("userId", "targetIdSnapshot") WHERE ("scopeType" = 'FOLDER'::"MemoryScopeType");

CREATE UNIQUE INDEX "MemoryScope_one_global_user_idx" ON public."MemoryScope" USING btree ("userId") WHERE ("scopeType" = 'GLOBAL_USER'::"MemoryScopeType");

CREATE INDEX "MemorySearchEntry_embedding_1024_hnsw_idx" ON public."MemorySearchEntry" USING hnsw (((embedding)::vector(1024)) vector_cosine_ops) WHERE (("embeddingState" = 'READY'::"MemoryEmbeddingState") AND ("embeddingDimension" = 1024));

CREATE INDEX "MemorySearchEntry_embedding_1536_hnsw_idx" ON public."MemorySearchEntry" USING hnsw (((embedding)::vector(1536)) vector_cosine_ops) WHERE (("embeddingState" = 'READY'::"MemoryEmbeddingState") AND ("embeddingDimension" = 1536));

CREATE UNIQUE INDEX "MemorySearchEntry_fact_target_key" ON public."MemorySearchEntry" USING btree ("userId", "indexGenerationId", "factVersionId") WHERE ("itemType" = 'FACT_VERSION'::"MemorySearchItemType");

CREATE UNIQUE INDEX "MemorySearchEntry_recall_chunk_target_key" ON public."MemorySearchEntry" USING btree ("userId", "indexGenerationId", "recallChunkId") WHERE ("itemType" = 'RECALL_CHUNK'::"MemorySearchItemType");

CREATE INDEX "MemorySearchEntry_simple_gin_idx" ON public."MemorySearchEntry" USING gin ("searchVectorSimple");

CREATE UNIQUE INDEX "ModelRun_one_active_per_chat_idx" ON public."ModelRun" USING btree ("chatId") WHERE (status = ANY (ARRAY['preparing'::"ModelRunStatus", 'queued'::"ModelRunStatus", 'streaming'::"ModelRunStatus", 'in_progress'::"ModelRunStatus"]));

CREATE UNIQUE INDEX "ProviderDraftCheck_active_tuple_key" ON public."ProviderDraftCheck" USING btree ("connectionId", "providerModelId", "credentialId", "credentialVersionId", "connectionDraftVersion", "modelDraftVersion") WHERE ("credentialVersionId" IS NOT NULL);

CREATE UNIQUE INDEX "ProviderDraftCheck_draft_tuple_key" ON public."ProviderDraftCheck" USING btree ("connectionId", "providerModelId", "credentialId", "credentialDraftVersion", "connectionDraftVersion", "modelDraftVersion") WHERE ("credentialDraftVersion" IS NOT NULL);

CREATE UNIQUE INDEX "SearchStrategy_searchOptionId_adapterKind_active_key" ON public."SearchStrategy" USING btree ("searchOptionId", "adapterKind") WHERE ("archivedAt" IS NULL);

-- Integrity functions required by the current pre-production schema.

CREATE OR REPLACE FUNCTION public.aiqsa_assert_temporary_chat_obligation(p_chat_id text, p_user_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  is_temporary boolean;
  obligation_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM "Chat" AS chat
    WHERE chat."id" = p_chat_id
      AND chat."userId" = p_user_id
      AND chat."memoryMode" = 'TEMPORARY'
  ) INTO is_temporary;

  IF NOT is_temporary THEN
    RETURN;
  END IF;

  SELECT count(*) INTO obligation_count
  FROM "MemoryDeletionOutbox" AS deletion
  WHERE deletion."userId" = p_user_id
    AND deletion."operation" = 'TEMPORARY_DELETE'
    AND deletion."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1'
    AND deletion."targetId" = p_chat_id
    AND deletion."memoryGeneration" = 0;

  IF obligation_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary chat must have exactly one durable deletion obligation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_chat_memory_mode_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."memoryMode" IS DISTINCT FROM OLD."memoryMode"
     AND (OLD."memoryMode" = 'TEMPORARY' OR NEW."memoryMode" = 'TEMPORARY') THEN
    IF OLD."memoryMode" <> 'NORMAL'
       OR NEW."memoryMode" <> 'TEMPORARY'
       OR OLD."activeLeafMessageId" IS NOT NULL
       OR OLD."archived"
       OR NEW."temporaryRetentionPolicyVersion" <> 'temporary-24h-v1'
       OR NEW."temporaryRetentionDeadline" IS NULL
       OR EXISTS (SELECT 1 FROM "Message" WHERE "chatId" = OLD."id")
       OR EXISTS (SELECT 1 FROM "ModelRun" WHERE "chatId" = OLD."id") THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Temporary chat mode is immutable after first-send admission';
    END IF;
  END IF;

  IF OLD."memoryMode" = 'TEMPORARY'
     AND NEW."temporaryRetentionPolicyVersion"
         IS DISTINCT FROM OLD."temporaryRetentionPolicyVersion" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary retention policy is immutable after admission';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_full_access_mcp_grant_id(mcp_server_id text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  candidate_hash TEXT;
  candidate_id TEXT;
  candidate_index INTEGER := 0;
BEGIN
  LOOP
    candidate_hash := md5(
      'aiqsa:full-access-mcp-grant:v1:' || mcp_server_id || ':' || candidate_index::TEXT
    );
    candidate_id :=
      substr(candidate_hash, 1, 8) || '-' ||
      substr(candidate_hash, 9, 4) || '-4' ||
      substr(candidate_hash, 14, 3) || '-8' ||
      substr(candidate_hash, 18, 3) || '-' ||
      substr(candidate_hash, 21, 12);

    IF NOT EXISTS (SELECT 1 FROM "McpGrant" WHERE "id" = candidate_id) THEN
      RETURN candidate_id;
    END IF;

    candidate_index := candidate_index + 1;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_grant_full_access_to_new_mcp_server()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  full_access_group_id TEXT;
BEGIN
  SELECT "id"
    INTO full_access_group_id
  FROM "Group"
  WHERE "systemRole" = 'full_access'::"GroupSystemRole";

  IF full_access_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "McpGrant" (
    "id",
    "serverId",
    "groupId",
    "canUse",
    "personalSlotKeys",
    "createdAt",
    "updatedAt"
  ) VALUES (
    aiqsa_full_access_mcp_grant_id(NEW."id"),
    NEW."id",
    full_access_group_id,
    true,
    ARRAY[]::TEXT[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("serverId", "groupId")
  DO UPDATE SET
    "canUse" = true,
    "personalSlotKeys" = ARRAY[]::TEXT[],
    "updatedAt" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_active_generation_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_active_generation(p_user_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_candidate_has_evidence(p_candidate_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  candidate_state "MemoryCandidateState";
  purged_at timestamp(3);
BEGIN
  SELECT "state", "contentPurgedAt" INTO candidate_state, purged_at
  FROM "MemoryCandidate" WHERE "id" = p_candidate_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF candidate_state IN ('PENDING', 'DEFERRED') AND purged_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM "MemoryCandidateMessage"
    WHERE "candidateId" = p_candidate_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Active Memory candidate requires direct USER evidence';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_fact_pointer(p_user_id text, p_fact_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_history_source(p_user_id text, p_chat_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  chat_row "Chat"%ROWTYPE;
BEGIN
  SELECT * INTO chat_row
  FROM "Chat"
  WHERE "userId" = p_user_id AND "id" = p_chat_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MemoryRecallChunk" AS chunk
    WHERE chunk."userId" = p_user_id
      AND chunk."chatId" = p_chat_id
      AND chunk."state" = 'ACTIVE'
      AND (
        chat_row."memoryMode" <> 'NORMAL'
        OR chunk."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR chunk."sourceRevisionAtCreation" <> chat_row."memorySourceRevision"
        OR chunk."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
      )
  ) OR EXISTS (
    SELECT 1
    FROM "ChatMemoryCheckpoint" AS checkpoint
    WHERE checkpoint."userId" = p_user_id
      AND checkpoint."chatId" = p_chat_id
      AND checkpoint."status" = 'READY'
      AND (
        chat_row."memoryMode" <> 'NORMAL'
        OR checkpoint."branchGeneration" <> chat_row."memoryBranchGeneration"
        OR checkpoint."sourceRevision" <> chat_row."memorySourceRevision"
        OR checkpoint."activeLeafMessageId" IS DISTINCT FROM chat_row."activeLeafMessageId"
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory history must match the current eligible chat source generation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_run_binding(p_run_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_run_preparation(p_run_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_scope_fact_availability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  checked_user_id text;
  checked_scope_id text;
BEGIN
  IF TG_TABLE_NAME = 'MemoryScope' THEN
    checked_user_id := NEW."userId";
    checked_scope_id := NEW."id";
  ELSE
    checked_user_id := NEW."userId";
    checked_scope_id := NEW."scopeId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE fact."userId" = checked_user_id
      AND fact."scopeId" = checked_scope_id
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND scope."state" <> 'ACTIVE'::"MemoryScopeState"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory fact requires an ACTIVE scope';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_candidate_authority_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "MemoryJob" AS job
    INNER JOIN "MemoryExecutionBinding" AS execution
      ON execution."userId" = job."userId"
      AND execution."memoryJobId" = job."id"
    WHERE job."userId" = NEW."userId"
      AND job."id" = NEW."jobId"
      AND job."chatId" = NEW."chatId"
      AND job."branchGeneration" = NEW."branchGeneration"
      AND job."sourceRevision" = NEW."sourceRevision"
      AND job."sourceHash" = NEW."sourceHash"
      AND job."kind" = 'EXTRACT_FACTS'
      AND job."pipelineVersion" = NEW."pipelineVersion"
      AND execution."id" = NEW."createdByExecutionId"
      AND execution."ownerType" = 'JOB'
      AND execution."logicalRole" = 'MEMORY_FACT_EXTRACT'
      AND execution."state" = 'SUCCEEDED'
      AND execution."acceptedOutputHash" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate requires its exact succeeded fact-extraction authority';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_candidate_decision_authority_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "MemoryCandidate" AS candidate
    INNER JOIN "MemoryJob" AS job
      ON job."userId" = candidate."userId"
      AND job."id" = NEW."consolidationJobId"
    INNER JOIN "MemoryExecutionBinding" AS execution
      ON execution."userId" = job."userId"
      AND execution."memoryJobId" = job."id"
    WHERE candidate."userId" = NEW."userId"
      AND candidate."id" = NEW."candidateId"
      AND job."kind" = 'CONSOLIDATE_CANDIDATE'
      AND job."pipelineVersion" IN (
        'memory-fact-consolidation-v1',
        'memory-fact-consolidation-v2'
      )
      AND job."idempotencyFingerprint" LIKE
        ('consolidate-candidate:' || candidate."id" || ':%')
      AND job."chatId" = candidate."chatId"
      AND job."branchGeneration" = candidate."branchGeneration"
      AND job."sourceRevision" = candidate."sourceRevision"
      AND job."sourceHash" = candidate."sourceHash"
      AND execution."id" = NEW."consolidationExecutionId"
      AND execution."ownerType" = 'JOB'
      AND execution."logicalRole" = 'MEMORY_CONSOLIDATE'
      AND execution."state" = 'SUCCEEDED'
      AND execution."inputHash" = NEW."consolidationInputHash"
      AND execution."acceptedOutputHash" = NEW."consolidationOutputHash"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision requires exact consolidation authority';
  END IF;

  IF NEW."verificationJobId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "MemoryCandidate" AS candidate
    INNER JOIN "MemoryJob" AS job
      ON job."userId" = candidate."userId"
      AND job."id" = NEW."verificationJobId"
    WHERE candidate."userId" = NEW."userId"
      AND candidate."id" = NEW."candidateId"
      AND job."kind" = 'VERIFY_CANDIDATE'
      AND job."pipelineVersion" IN (
        'memory-fact-verification-v1',
        'memory-fact-verification-v2'
      )
      AND job."idempotencyFingerprint" = ('verify-candidate:' || NEW."id")
      AND job."chatId" = candidate."chatId"
      AND job."branchGeneration" = candidate."branchGeneration"
      AND job."sourceRevision" = candidate."sourceRevision"
      AND job."sourceHash" = candidate."sourceHash"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision requires exact verification job authority';
  END IF;

  IF NEW."verificationExecutionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "MemoryExecutionBinding" AS execution
    WHERE execution."userId" = NEW."userId"
      AND execution."id" = NEW."verificationExecutionId"
      AND execution."memoryJobId" = NEW."verificationJobId"
      AND execution."ownerType" = 'JOB'
      AND execution."logicalRole" = 'MEMORY_VERIFY'
      AND execution."state" = 'SUCCEEDED'
      AND execution."inputHash" = NEW."verificationInputHash"
      AND execution."acceptedOutputHash" = NEW."verificationOutputHash"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision requires exact verification authority';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_candidate_decision_immutable_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."candidateId" IS DISTINCT FROM OLD."candidateId"
    OR NEW."consolidationJobId" IS DISTINCT FROM OLD."consolidationJobId"
    OR NEW."consolidationExecutionId" IS DISTINCT FROM OLD."consolidationExecutionId"
    OR NEW."operation" IS DISTINCT FROM OLD."operation"
    OR NEW."targetFactId" IS DISTINCT FROM OLD."targetFactId"
    OR NEW."targetVersionId" IS DISTINCT FROM OLD."targetVersionId"
    OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
    OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
    OR NEW."requiresVerification" IS DISTINCT FROM OLD."requiresVerification"
    OR NEW."relatedSnapshotHash" IS DISTINCT FROM OLD."relatedSnapshotHash"
    OR NEW."consolidationInputHash" IS DISTINCT FROM OLD."consolidationInputHash"
    OR NEW."consolidationOutputHash" IS DISTINCT FROM OLD."consolidationOutputHash"
    OR NEW."verificationJobId" IS DISTINCT FROM OLD."verificationJobId"
    OR NEW."verificationInputHash" IS DISTINCT FROM OLD."verificationInputHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate decision authority is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_candidate_evidence_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'MemoryCandidate' THEN
    PERFORM aiqsa_memory_assert_candidate_has_evidence(NEW."id");
  ELSE
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_candidate_has_evidence(OLD."candidateId");
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_candidate_has_evidence(NEW."candidateId");
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_candidate_message_authority_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "MemoryCandidate" AS candidate
    INNER JOIN "Message" AS message
      ON message."chatId" = candidate."chatId"
    WHERE candidate."userId" = NEW."userId"
      AND candidate."id" = NEW."candidateId"
      AND candidate."chatId" = NEW."chatId"
      AND message."id" = NEW."messageId"
      AND message."role" = 'user'
      AND message."status" = 'complete'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate evidence requires an exact settled direct USER message';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_create_default_settings()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "UserMemorySettings" ("userId") VALUES (NEW."id")
  ON CONFLICT ("userId") DO NOTHING;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_deletion_admission_immutable_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (
    NEW."admissionAuthorizationId",
    NEW."admittedChatSourceRevision",
    NEW."admittedActiveLeafMessageId",
    NEW."alsoForgetOriginMemories"
  ) IS DISTINCT FROM (
    OLD."admissionAuthorizationId",
    OLD."admittedChatSourceRevision",
    OLD."admittedActiveLeafMessageId",
    OLD."alsoForgetOriginMemories"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Deletion admission metadata is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_event_deleted_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."sourceDeletedAt" IS NOT NULL
    AND NEW."sourceDeletedAt" IS DISTINCT FROM OLD."sourceDeletedAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Deleted source lifecycle is immutable';
  END IF;
  IF NEW."sourceDeletedAt" IS NOT NULL
    AND (OLD."sourceChatId" IS NULL OR NEW."sourceChatId" IS NOT NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Deleted source lifecycle requires one-way source detachment';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_fact_pointer_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_fact_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."scopeId" IS DISTINCT FROM OLD."scopeId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory fact scope identity is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_feedback_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."idempotencyFingerprint" IS DISTINCT FROM OLD."idempotencyFingerprint"
    OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
    OR NEW."feedbackType" IS DISTINCT FROM OLD."feedbackType"
    OR NEW."targetKind" IS DISTINCT FROM OLD."targetKind"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR OLD."contentPurgedAt" IS NOT NULL
    OR NEW."contentPurgedAt" IS NULL
    OR OLD."purgeReason" IS NOT NULL
    OR NEW."purgeReason" IS NULL
    OR (NEW."memoryFactId" IS NOT NULL AND NEW."memoryFactId" IS DISTINCT FROM OLD."memoryFactId")
    OR (NEW."memoryFactVersionId" IS NOT NULL AND NEW."memoryFactVersionId" IS DISTINCT FROM OLD."memoryFactVersionId")
    OR (NEW."recallChunkId" IS NOT NULL AND NEW."recallChunkId" IS DISTINCT FROM OLD."recallChunkId")
    OR (NEW."modelRunId" IS NOT NULL AND NEW."modelRunId" IS DISTINCT FROM OLD."modelRunId")
    OR (NEW."modelRunMemoryItemId" IS NOT NULL AND NEW."modelRunMemoryItemId" IS DISTINCT FROM OLD."modelRunMemoryItemId")
    OR (NEW."modelRunToolCallId" IS NOT NULL AND NEW."modelRunToolCallId" IS DISTINCT FROM OLD."modelRunToolCallId")
    OR (NEW."sourceChatIdSnapshot" IS NOT NULL AND NEW."sourceChatIdSnapshot" IS DISTINCT FROM OLD."sourceChatIdSnapshot")
    OR (NEW."sourceBranchGenerationSnapshot" IS NOT NULL AND NEW."sourceBranchGenerationSnapshot" IS DISTINCT FROM OLD."sourceBranchGenerationSnapshot")
    OR (NEW."comment" IS NOT NULL AND NEW."comment" IS DISTINCT FROM OLD."comment")
    OR (NEW."retractsFeedbackId" IS NOT NULL AND NEW."retractsFeedbackId" IS DISTINCT FROM OLD."retractsFeedbackId")
    OR (NEW."memoryEventId" IS NOT NULL AND NEW."memoryEventId" IS DISTINCT FROM OLD."memoryEventId")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback is append-only except for one-way purge';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_feedback_target_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  feedback_event "MemoryEvent"%ROWTYPE;
  target_item "ModelRunMemoryItem"%ROWTYPE;
  retracted "MemoryFeedback"%ROWTYPE;
BEGIN
  IF NEW."contentPurgedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO feedback_event
  FROM "MemoryEvent"
  WHERE "userId" = NEW."userId" AND "id" = NEW."memoryEventId";
  IF NOT FOUND
    OR feedback_event."operation" <> 'USER_FEEDBACK'
    OR feedback_event."actorType" <> 'USER'
    OR feedback_event."actorUserId" IS DISTINCT FROM NEW."userId"
    OR feedback_event."metadata" ->> 'schemaVersion' IS DISTINCT FROM
      'memory-feedback-event-v1'
    OR feedback_event."metadata" ->> 'feedbackId' IS DISTINCT FROM NEW."id"
    OR feedback_event."metadata" ->> 'feedbackType' IS DISTINCT FROM
      NEW."feedbackType"::text
    OR (
      NEW."targetKind" = 'FACT_VERSION'
      AND (
        feedback_event."factId" IS DISTINCT FROM NEW."memoryFactId"
        OR feedback_event."factVersionId" IS DISTINCT FROM NEW."memoryFactVersionId"
      )
    )
    OR (
      NEW."targetKind" <> 'FACT_VERSION'
      AND num_nonnulls(feedback_event."factId", feedback_event."factVersionId") <> 0
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback event must match its immutable signal';
  END IF;

  IF NEW."modelRunMemoryItemId" IS NOT NULL THEN
    SELECT * INTO target_item
    FROM "ModelRunMemoryItem"
    WHERE "userId" = NEW."userId" AND "id" = NEW."modelRunMemoryItemId";
    IF NOT FOUND
      OR target_item."bindingId" NOT IN (
        SELECT binding."id" FROM "ModelRunMemoryBinding" AS binding
        WHERE binding."userId" = NEW."userId" AND binding."modelRunId" = NEW."modelRunId"
      )
      OR (NEW."targetKind" = 'FACT_VERSION' AND target_item."factVersionId" IS DISTINCT FROM NEW."memoryFactVersionId")
      OR (NEW."targetKind" = 'RECALL_CHUNK' AND target_item."recallChunkId" IS DISTINCT FROM NEW."recallChunkId")
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Memory feedback run item must match its same-owner target';
    END IF;
  END IF;

  IF NEW."modelRunToolCallId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "ModelRunToolCall" AS tool_call
    WHERE tool_call."modelRunId" = NEW."modelRunId"
      AND tool_call."id" = NEW."modelRunToolCallId"
      AND tool_call."toolName" = 'mark_memory_incorrect'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory feedback tool provenance must name mark_memory_incorrect';
  END IF;

  IF NEW."feedbackType" = 'RETRACT' THEN
    SELECT * INTO retracted
    FROM "MemoryFeedback"
    WHERE "userId" = NEW."userId" AND "id" = NEW."retractsFeedbackId";
    IF NOT FOUND
      OR retracted."feedbackType" = 'RETRACT'
      OR retracted."contentPurgedAt" IS NOT NULL
      OR retracted."targetKind" IS DISTINCT FROM NEW."targetKind"
      OR retracted."memoryFactId" IS DISTINCT FROM NEW."memoryFactId"
      OR retracted."memoryFactVersionId" IS DISTINCT FROM NEW."memoryFactVersionId"
      OR retracted."recallChunkId" IS DISTINCT FROM NEW."recallChunkId"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Memory feedback retraction must match one live same-owner signal';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_generation_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_history_source_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'Chat' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_history_source(NEW."userId", NEW."id");
    END IF;
    IF TG_OP <> 'INSERT'
       AND (OLD."userId", OLD."id") IS DISTINCT FROM (NEW."userId", NEW."id") THEN
      PERFORM aiqsa_memory_assert_history_source(OLD."userId", OLD."id");
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_history_source(NEW."userId", NEW."chatId");
    END IF;
    IF TG_OP <> 'INSERT'
       AND (OLD."userId", OLD."chatId") IS DISTINCT FROM (NEW."userId", NEW."chatId") THEN
      PERFORM aiqsa_memory_assert_history_source(OLD."userId", OLD."chatId");
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_model_run_item_target_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND (
    (NEW."itemType" = 'FACT_VERSION' AND NEW."factVersionId" IS NULL)
    OR (NEW."itemType" = 'RECALL_CHUNK' AND NEW."recallChunkId" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accepted Memory item requires its exact live target at insert';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."exactItemId" IS DISTINCT FROM OLD."exactItemId"
       OR NEW."itemType" IS DISTINCT FROM OLD."itemType"
       OR NEW."sourceChatIdSnapshot" IS DISTINCT FROM OLD."sourceChatIdSnapshot"
       OR NEW."sourceBranchGenerationSnapshot" IS DISTINCT FROM OLD."sourceBranchGenerationSnapshot"
       OR NEW."sourceRevisionSnapshot" IS DISTINCT FROM OLD."sourceRevisionSnapshot"
       OR NEW."sourceContentHashSnapshot" IS DISTINCT FROM OLD."sourceContentHashSnapshot"
       OR (NEW."factVersionId" IS DISTINCT FROM OLD."factVersionId"
           AND NOT (OLD."factVersionId" IS NOT NULL AND NEW."factVersionId" IS NULL))
       OR (NEW."recallChunkId" IS DISTINCT FROM OLD."recallChunkId"
           AND NOT (OLD."recallChunkId" IS NOT NULL AND NEW."recallChunkId" IS NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accepted Memory item identity and source generation are immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_protect_candidate_execution_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryCandidate"
    WHERE "userId" = OLD."userId" AND "createdByExecutionId" = OLD."id"
  ) AND (
    NEW."ownerType" <> 'JOB'
    OR NEW."logicalRole" <> 'MEMORY_FACT_EXTRACT'
    OR NEW."state" <> 'SUCCEEDED'
    OR NEW."acceptedOutputHash" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Memory candidate extraction authority is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_protect_candidate_job_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryCandidate"
    WHERE "userId" = OLD."userId" AND "jobId" = OLD."id"
  ) AND (
    NEW."kind" <> 'EXTRACT_FACTS'
    OR NEW."pipelineVersion" <> OLD."pipelineVersion"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Memory candidate source job authority is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_protect_candidate_message_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW."role" <> 'user' OR NEW."status" <> 'complete') AND EXISTS (
    SELECT 1 FROM "MemoryCandidateMessage"
    WHERE "chatId" = OLD."chatId" AND "messageId" = OLD."id"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Memory candidate source must remain a settled direct USER message';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_run_binding_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_run_preparation_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."userId", NEW."scopeType", NEW."targetIdSnapshot")
         IS DISTINCT FROM (OLD."userId", OLD."scopeType", OLD."targetIdSnapshot") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory scope identity is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_search_entry_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_permanent_chat_child_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."chatId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Chat"
    WHERE "id" = NEW."chatId" AND "permanentDeletionAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanently deleted chat cannot accept new aggregate children';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_permanent_chat_delete_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."permanentDeletionAt" IS NOT NULL AND (
    NEW."permanentDeletionAt" IS DISTINCT FROM OLD."permanentDeletionAt"
    OR NEW."permanentDeletionOperationId" IS DISTINCT FROM OLD."permanentDeletionOperationId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanent chat deletion fence is immutable';
  END IF;

  IF NEW."permanentDeletionAt" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "MemoryDeletionOutbox" AS deletion
    WHERE deletion."userId" = NEW."userId"
      AND deletion."id" = NEW."permanentDeletionOperationId"
      AND deletion."operation" = 'SOURCE_PURGE'::"MemoryDeletionOperation"
      AND deletion."targetType" = 'CHAT@memory-chat-delete-v1'
      AND deletion."targetId" = NEW."id"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanent chat deletion fence requires its exact durable operation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_permanent_chat_source_snapshot_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."sourceChatIdSnapshot" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Chat"
    WHERE "id" = NEW."sourceChatIdSnapshot" AND "permanentDeletionAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanently deleted chat cannot enter new source snapshots';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_permanent_chat_source_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."sourceChatId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Chat"
    WHERE "id" = NEW."sourceChatId" AND "permanentDeletionAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanently deleted chat cannot become a reusable source';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_protect_full_access_group()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."systemRole" = 'full_access'::"GroupSystemRole" THEN
      RAISE EXCEPTION 'Full access is a built-in group and cannot be deleted'
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  IF OLD."systemRole" IS NULL
    AND NEW."systemRole" = 'full_access'::"GroupSystemRole"
  THEN
    RAISE EXCEPTION 'Ordinary groups cannot be promoted to the built-in Full access identity'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."systemRole" = 'full_access'::"GroupSystemRole" THEN
    IF NEW."systemRole" IS DISTINCT FROM 'full_access'::"GroupSystemRole"
      OR NEW."name" IS DISTINCT FROM 'Full access'
      OR NEW."archivedAt" IS NOT NULL
    THEN
      RAISE EXCEPTION 'Full access is a built-in group and cannot be renamed or archived'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_temporary_chat_delete_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."memoryMode" = 'TEMPORARY'
     AND NOT EXISTS (
       SELECT 1
       FROM "MemoryDeletionOutbox" AS deletion
       WHERE deletion."userId" = OLD."userId"
         AND deletion."operation" = 'TEMPORARY_DELETE'
         AND deletion."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1'
         AND deletion."targetId" = OLD."id"
         AND deletion."memoryGeneration" = 0
         AND deletion."state" = 'RUNNING'
         AND deletion."leaseToken" IS NOT NULL
         AND deletion."leaseExpiresAt" > CURRENT_TIMESTAMP
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary chat deletion requires its claimed durable obligation';
  END IF;
  RETURN OLD;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_temporary_chat_obligation_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  chat_id text;
  owner_id text;
BEGIN
  IF TG_TABLE_NAME = 'Chat' THEN
    IF TG_OP = 'DELETE' THEN
      chat_id := OLD."id";
      owner_id := OLD."userId";
    ELSE
      chat_id := NEW."id";
      owner_id := NEW."userId";
    END IF;
    IF owner_id IS NOT NULL THEN
      PERFORM aiqsa_assert_temporary_chat_obligation(chat_id, owner_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'Message' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      chat_id := OLD."chatId";
      SELECT "userId" INTO owner_id FROM "Chat" WHERE "id" = chat_id;
      IF owner_id IS NOT NULL THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(chat_id, owner_id);
      END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      chat_id := NEW."chatId";
      SELECT "userId" INTO owner_id FROM "Chat" WHERE "id" = chat_id;
      IF owner_id IS NOT NULL THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(chat_id, owner_id);
      END IF;
    END IF;
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      IF OLD."operation" = 'TEMPORARY_DELETE'
         AND OLD."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1' THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(
          OLD."targetId", OLD."userId"
        );
      END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      IF NEW."operation" = 'TEMPORARY_DELETE'
         AND NEW."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1' THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(
          NEW."targetId", NEW."userId"
        );
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

-- PostgreSQL-only constraints required by the current pre-production schema.

ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_subject_check" CHECK (num_nonnulls("userId", "groupId") = 1);

ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_target_check" CHECK (num_nonnulls("providerConnectionId", "providerModelId", "searchStrategy") = 1 AND ("providerConnectionId" IS NULL OR btrim("providerConnectionId") <> ''::text) AND ("providerModelId" IS NULL OR btrim("providerModelId") <> ''::text) AND ("searchStrategy" IS NULL OR btrim("searchStrategy") <> ''::text));

ALTER TABLE "AssistantDefinition" ADD CONSTRAINT "AssistantDefinition_version_check" CHECK (version >= 1);

ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_scope_group_check" CHECK (scope = 'group'::"AssistantPublicationScope" AND "groupId" IS NOT NULL OR scope = 'installation'::"AssistantPublicationScope" AND "groupId" IS NULL);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_category_check" CHECK (category IS NULL OR char_length(category) >= 1 AND char_length(category) <= 40);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_description_check" CHECK (char_length(description) <= 400);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_developer_prompt_check" CHECK ("developerPrompt" IS NULL OR char_length("developerPrompt") <= 16000);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_knowledge_base_ids_check" CHECK (cardinality("knowledgeBaseIds") <= 3);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_mcp_server_ids_check" CHECK (cardinality("mcpServerIds") <= 16);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_name_check" CHECK (char_length(name) >= 1 AND char_length(name) <= 80);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_revision_number_check" CHECK ("revisionNumber" >= 1);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_schema_version_check" CHECK ("schemaVersion" >= 1);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_starter_prompts_check" CHECK (cardinality("starterPrompts") <= 4);

ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_system_prompt_check" CHECK (char_length("systemPrompt") <= 32000);

ALTER TABLE "AuthRateLimitBucket" ADD CONSTRAINT "AuthRateLimitBucket_attemptCount_check" CHECK ("attemptCount" >= 1);

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_revocation_attribution_check" CHECK ("revokedAt" IS NULL AND "revokedByUserId" IS NULL AND "revokedReason" IS NULL OR "revokedAt" IS NOT NULL AND "revokedReason" IS NOT NULL AND btrim("revokedReason") <> ''::text AND (("revokedReason" <> ALL (ARRAY['admin_revoke_user'::text, 'admin_revoke_all'::text])) OR "revokedByUserId" IS NOT NULL));

ALTER TABLE "Chat" DROP CONSTRAINT "Chat_id_activeLeafMessageId_fkey";

ALTER TABLE "Chat" ADD CONSTRAINT "Chat_id_activeLeafMessageId_fkey" FOREIGN KEY (id, "activeLeafMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE SET NULL ("activeLeafMessageId");

ALTER TABLE "Chat" ADD CONSTRAINT "Chat_memory_state_check" CHECK ("memoryBranchGeneration" >= 0 AND "memorySourceRevision" >= 0 AND (("memoryMode" = ANY (ARRAY['NORMAL'::"MemoryChatMode", 'EXCLUDED'::"MemoryChatMode"])) AND "temporaryRetentionPolicyVersion" IS NULL AND "temporaryRetentionDeadline" IS NULL OR "memoryMode" = 'TEMPORARY'::"MemoryChatMode" AND "temporaryRetentionPolicyVersion" IS NOT NULL AND "temporaryRetentionPolicyVersion"::text = 'temporary-24h-v1'::text AND "temporaryRetentionDeadline" IS NOT NULL AND "temporaryRetentionDeadline" > "createdAt"));

ALTER TABLE "Chat" ADD CONSTRAINT "Chat_permanent_deletion_operation_fkey" FOREIGN KEY ("userId", "permanentDeletionOperationId") REFERENCES "MemoryDeletionOutbox"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "Chat" ADD CONSTRAINT "Chat_permanent_deletion_shape_check" CHECK ((num_nonnulls("permanentDeletionAt", "permanentDeletionOperationId") = ANY (ARRAY[0, 2])) AND ("permanentDeletionAt" IS NULL OR archived = true AND "memoryMode" = 'EXCLUDED'::"MemoryChatMode"));

ALTER TABLE "ChatMemoryCheckpoint" ADD CONSTRAINT "ChatMemoryCheckpoint_active_leaf_fkey" FOREIGN KEY ("chatId", "activeLeafMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "ChatMemoryCheckpoint" ADD CONSTRAINT "ChatMemoryCheckpoint_chat_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "ChatMemoryCheckpoint" ADD CONSTRAINT "ChatMemoryCheckpoint_last_indexed_message_fkey" FOREIGN KEY ("chatId", "lastIndexedMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "ChatMemoryCheckpoint" ADD CONSTRAINT "ChatMemoryCheckpoint_shape_check" CHECK ("branchGeneration" >= 0 AND "sourceRevision" >= 0 AND char_length("sourceContentHash"::text) >= 16 AND char_length("sourceContentHash"::text) <= 128 AND ("lastErrorCode" IS NULL OR "lastErrorCode"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text) AND (status <> 'READY'::"MemoryHistoryCheckpointStatus" OR "lastSucceededAt" IS NOT NULL AND "lastErrorCode" IS NULL) AND (status <> 'FAILED'::"MemoryHistoryCheckpointStatus" OR "lastErrorCode" IS NOT NULL));

ALTER TABLE "ChatMemoryCheckpoint" ADD CONSTRAINT "ChatMemoryCheckpoint_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "DocumentProcessingFairnessCursor" ADD CONSTRAINT "DocumentProcessingFairnessCursor_pipeline_check" CHECK (pipeline::text = ANY (ARRAY['attachment'::character varying, 'knowledge'::character varying, 'memory-job'::character varying, 'memory-delete'::character varying]::text[]));

ALTER TABLE "Group" ADD CONSTRAINT "Group_full_access_identity_check" CHECK ("systemRole" IS NOT NULL AND "systemRole" = 'full_access'::"GroupSystemRole" AND name = 'Full access'::text AND "archivedAt" IS NULL OR "systemRole" IS NULL AND lower(btrim(name)) <> 'full access'::text);

ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_content_revision_check" CHECK ("contentRevision" >= 0);

ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_description_check" CHECK (char_length(description) <= 2000);

ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_name_check" CHECK (char_length(name) >= 1 AND char_length(name) <= 80);

ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_version_check" CHECK (version >= 1);

ALTER TABLE "KnowledgeBasePublication" ADD CONSTRAINT "KnowledgeBasePublication_scope_group_check" CHECK (scope = 'group'::"KnowledgeBasePublicationScope" AND "groupId" IS NOT NULL OR scope = 'installation'::"KnowledgeBasePublicationScope" AND "groupId" IS NULL);

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_dimension_check" CHECK (("embeddingDimension" = ANY (ARRAY[1024, 1536])) AND vector_dims(embedding) = "embeddingDimension");

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_heading_path_check" CHECK (cardinality("headingPath") <= 16);

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_index_check" CHECK ("chunkIndex" >= 0);

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_page_check" CHECK (page >= 1);

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_text_check" CHECK (char_length(text) >= 1 AND char_length(text) <= 20000);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_byte_size_check" CHECK ("byteSize" > 0);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_checksum_check" CHECK (checksum ~ '^[0-9a-f]{64}$'::text);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_claim_check" CHECK (("ingestClaimToken" IS NULL) = ("ingestClaimedAt" IS NULL));

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_error_check" CHECK ("ingestState" = 'failed'::"KnowledgeDocumentIngestState" AND "ingestErrorCode" IS NOT NULL OR "ingestState" <> 'failed'::"KnowledgeDocumentIngestState" AND "ingestErrorCode" IS NULL);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_file_name_check" CHECK (char_length("fileName") >= 1 AND char_length("fileName") <= 512);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_ingest_attempt_check" CHECK ("ingestAttemptCount" >= 0);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_ingest_progress_check" CHECK (("ingestChunkCount" IS NULL OR "ingestChunkCount" >= 0) AND "ingestEmbeddedChunkCount" >= 0 AND ("ingestChunkCount" IS NULL OR "ingestEmbeddedChunkCount" <= "ingestChunkCount"));

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_mime_type_check" CHECK (char_length("mimeType") >= 1 AND char_length("mimeType") <= 255);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_normalized_object_check" CHECK ("normalizedTextByteSize" IS NULL AND "normalizedTextChecksum" IS NULL OR "normalizedTextStorageKey" IS NOT NULL AND "normalizedTextByteSize" > 0 AND "normalizedTextChecksum" ~ '^[0-9a-f]{64}$'::text);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_page_count_check" CHECK ("pageCount" IS NULL OR "pageCount" >= 1);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_storage_key_check" CHECK ("payloadPurgedAt" IS NULL AND char_length("originalStorageKey") >= 1 AND char_length("originalStorageKey") <= 1024 AND ("normalizedTextStorageKey" IS NULL OR char_length("normalizedTextStorageKey") >= 1 AND char_length("normalizedTextStorageKey") <= 1024) OR "payloadPurgedAt" IS NOT NULL AND "originalStorageKey" IS NULL AND "normalizedTextStorageKey" IS NULL AND "normalizedTextByteSize" IS NULL AND "normalizedTextChecksum" IS NULL);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_version_check" CHECK ("versionNumber" >= 1);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_visibility_check" CHECK ("visibleFromRevision" IS NULL AND "visibleUntilRevision" IS NULL OR "visibleFromRevision" >= 1 AND ("visibleUntilRevision" IS NULL OR "visibleUntilRevision" > "visibleFromRevision"));

ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_attempt_check" CHECK ("attemptCount" >= 0);

ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_claim_check" CHECK (("claimToken" IS NULL) = ("claimedAt" IS NULL));

ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_error_check" CHECK (state = 'failed'::"KnowledgeDocumentIngestState" AND "errorCode" IS NOT NULL OR state <> 'failed'::"KnowledgeDocumentIngestState" AND "errorCode" IS NULL);

ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_progress_check" CHECK (("chunkCount" IS NULL OR "chunkCount" >= 0) AND "embeddedChunkCount" >= 0 AND ("chunkCount" IS NULL OR "embeddedChunkCount" <= "chunkCount"));

ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_state_check" CHECK (state = ANY (ARRAY['queued'::"KnowledgeDocumentIngestState", 'embedding'::"KnowledgeDocumentIngestState", 'ready'::"KnowledgeDocumentIngestState", 'failed'::"KnowledgeDocumentIngestState"]));

ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_chunking_profile_check" CHECK ("chunkingProfileVersion" >= 1);

ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_dimension_check" CHECK ("targetDimension" = ANY (ARRAY[1024, 1536]));

ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_fingerprint_check" CHECK ("vectorSpaceFingerprint" ~ '^[0-9a-f]{64}$'::text);

ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_indexed_revision_check" CHECK ("indexedContentRevision" >= 0);

ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_lifecycle_check" CHECK (status = 'building'::"KnowledgeIndexGenerationStatus" AND "readyAt" IS NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "failedAt" IS NULL AND "lastErrorCode" IS NULL OR status = 'ready'::"KnowledgeIndexGenerationStatus" AND "readyAt" IS NOT NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "failedAt" IS NULL AND "lastErrorCode" IS NULL OR status = 'active'::"KnowledgeIndexGenerationStatus" AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL AND "failedAt" IS NULL AND "lastErrorCode" IS NULL OR status = 'retired'::"KnowledgeIndexGenerationStatus" AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "failedAt" IS NULL AND "lastErrorCode" IS NULL OR status = 'failed'::"KnowledgeIndexGenerationStatus" AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "failedAt" IS NOT NULL AND "lastErrorCode" IS NOT NULL);

ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_reindex_source_check" CHECK ("sourceIndexGenerationId" IS NULL AND "sourceBaseVersion" IS NULL AND "targetContentRevision" IS NULL OR "sourceIndexGenerationId" IS NOT NULL AND "sourceIndexGenerationId" <> id AND "sourceBaseVersion" >= 1 AND "targetContentRevision" >= 0);

ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_candidate_limit_check" CHECK ("candidateLimit" >= 1 AND "candidateLimit" <= 100);

ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_result_limit_check" CHECK ("resultLimit" >= 1 AND "resultLimit" <= 8 AND "resultLimit" <= "candidateLimit");

ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_score_threshold_check" CHECK ("scoreThreshold" >= 0::double precision AND "scoreThreshold" <= 1::double precision);

ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_singleton_check" CHECK (id = 'installation'::text);

ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_version_check" CHECK (version >= 1);

ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_evidence_shape_check" CHECK (jsonb_typeof("baseEvidence") = 'array'::text AND jsonb_array_length("baseEvidence") >= 1 AND jsonb_array_length("baseEvidence") <= 3 AND jsonb_typeof(results) = 'array'::text AND jsonb_array_length(results) <= 8 AND jsonb_typeof("embeddingUsage") = 'array'::text AND jsonb_array_length("embeddingUsage") <= 3 AND octet_length("providerText") >= 1 AND octet_length("providerText") <= 49152);

ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_failure_code_check" CHECK ("failureCode" IS NULL OR "failureCode"::text ~ '^[a-z][a-z0-9_]{0,127}$'::text);

ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_limits_check" CHECK (fusion::text = 'rrf_k60'::text AND "invocationOrdinal" >= 1 AND "invocationOrdinal" <= 3 AND "candidateLimit" >= 1 AND "candidateLimit" <= 100 AND "resultLimit" >= 1 AND "resultLimit" <= 8 AND "candidateLimit" >= "resultLimit" AND "candidateCount" >= 0 AND threshold >= 0::double precision AND threshold <= 1::double precision AND "durationMs" >= 0);

ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_negative_outcome_check" CHECK (outcome = 'base_empty'::"KnowledgeRunOutcome" AND "candidateCount" = 0 OR outcome = 'zero_above_threshold'::"KnowledgeRunOutcome" AND "candidateCount" > 0 OR (outcome <> ALL (ARRAY['base_empty'::"KnowledgeRunOutcome", 'zero_above_threshold'::"KnowledgeRunOutcome"])));

ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_outcome_shape_check" CHECK (outcome = 'complete'::"KnowledgeRunOutcome" AND jsonb_array_length(results) >= 1 AND jsonb_array_length(results) <= 8 OR outcome <> 'complete'::"KnowledgeRunOutcome" AND jsonb_array_length(results) = 0);

ALTER TABLE "KnowledgeRun" ADD CONSTRAINT "KnowledgeRun_query_check" CHECK (char_length(btrim(query::text)) >= 1 AND char_length(btrim(query::text)) <= 500 AND query::text !~ '[[:cntrl:]]'::text);

ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_base_revision_check" CHECK ("baseContentRevision" >= 0);

ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_dimension_check" CHECK ("targetDimension" = ANY (ARRAY[1024, 1536]));

ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_fingerprint_check" CHECK ("vectorSpaceFingerprint" ~ '^[0-9a-f]{64}$'::text);

ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_indexed_revision_check" CHECK ("indexedContentRevision" >= 0);

ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_ordinal_check" CHECK (ordinal >= 0 AND ordinal <= 2);

ALTER TABLE "KnowledgeRunBinding" ADD CONSTRAINT "KnowledgeRunBinding_snapshot_check" CHECK (jsonb_typeof("embeddingExecutionSnapshot") = 'object'::text);

ALTER TABLE "McpActivationJob" ADD CONSTRAINT "McpActivationJob_sharedConfigVersion_check" CHECK ("sharedConfigVersion" >= 0);

ALTER TABLE "McpActivationJob" ADD CONSTRAINT "McpActivationJob_terminal_fields_check" CHECK (stage = 'failed'::"McpActivationStage" AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL OR stage = 'ready'::"McpActivationStage" AND "completedAt" IS NOT NULL AND "errorCode" IS NULL OR (stage <> ALL (ARRAY['ready'::"McpActivationStage", 'failed'::"McpActivationStage"])) AND "completedAt" IS NULL AND "errorCode" IS NULL);

ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_group_personal_slots_check" CHECK ("groupId" IS NULL OR cardinality("personalSlotKeys") = 0);

ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_permission_check" CHECK ("canUse" OR cardinality("personalSlotKeys") > 0);

ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_subject_check" CHECK (num_nonnulls("userId", "groupId") = 1);

ALTER TABLE "McpOAuthClient" ADD CONSTRAINT "McpOAuthClient_secret_generation_check" CHECK ("clientSecretGeneration" >= 0 AND ("clientSecretGeneration" > 0 OR "clientSecretEnvelope" IS NULL));

ALTER TABLE "McpOAuthConnection" ADD CONSTRAINT "McpOAuthConnection_token_generation_check" CHECK ("tokenGeneration" >= 0 AND ("tokenGeneration" > 0 OR "tokenEnvelope" IS NULL));

ALTER TABLE "McpRevision" ADD CONSTRAINT "McpRevision_revision_number_check" CHECK ("revisionNumber" > 0);

ALTER TABLE "McpRuntimeGeneration" ADD CONSTRAINT "McpRuntimeGeneration_attempt_count_check" CHECK ("attemptCount" >= 0);

ALTER TABLE "McpRuntimeGeneration" ADD CONSTRAINT "McpRuntimeGeneration_credentialSources_check" CHECK ("credentialSources" <@ ARRAY['oauth'::text, 'personal'::text, 'shared'::text] AND cardinality("credentialSources") <= 3);

ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_shared_config_envelope_generation_check" CHECK ("sharedConfigVersion" > 0 OR "sharedConfigEnvelope" IS NULL);

ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_shared_config_version_check" CHECK ("sharedConfigVersion" >= 0);

ALTER TABLE "McpUserServer" ADD CONSTRAINT "McpUserServer_personal_config_envelope_generation_check" CHECK ("personalConfigVersion" > 0 OR "personalConfigEnvelope" IS NULL);

ALTER TABLE "McpUserServer" ADD CONSTRAINT "McpUserServer_personal_config_version_check" CHECK ("personalConfigVersion" >= 0);

ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_chat_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_execution_fkey" FOREIGN KEY ("userId", "createdByExecutionId") REFERENCES "MemoryExecutionBinding"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_job_source_fkey" FOREIGN KEY ("userId", "jobId", "chatId", "branchGeneration", "sourceRevision", "sourceHash") REFERENCES "MemoryJob"("userId", id, "chatId", "branchGeneration", "sourceRevision", "sourceHash") ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_resolved_fact_fkey" FOREIGN KEY ("userId", "resolvedFactId") REFERENCES "MemoryFact"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_shape_check" CHECK (id ~ '^[a-f0-9]{64}$'::text AND "branchGeneration" >= 0 AND "sourceRevision" >= 0 AND "sourceHash"::text ~ '^[a-f0-9]{64}$'::text AND "sourceProjectionHash"::text ~ '^[a-f0-9]{64}$'::text AND "sourceProjectionVersion"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND "pipelineVersion"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND ("reasonCode" IS NULL OR "reasonCode"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text) AND ("contentPurgedAt" IS NULL OR (state = ANY (ARRAY['PROMOTED'::"MemoryCandidateState", 'REJECTED'::"MemoryCandidateState", 'STALE'::"MemoryCandidateState"])) AND num_nonnulls("proposedCanonicalKey", "proposedDisplayText", "proposedValue", "proposedCategory", "proposedModality", "proposedScope", "proposedValidFrom", "proposedValidTo", "rawTemporalExpression", "sourceTimezone", "temporalResolverVersion", "temporalResolutionEvidence", "proposedDirectness", "proposedSensitivity", "proposedCoreEligible", "proposedCoreSalience", "languageCode", importance, confidence, negated) = 0) AND ("contentPurgedAt" IS NOT NULL OR num_nonnulls("proposedCanonicalKey", "proposedDisplayText", "proposedValue", "proposedCategory", "proposedModality", "proposedScope", "sourceTimezone", "proposedDirectness", "proposedSensitivity", "languageCode", importance, confidence, negated) = 13 AND char_length("proposedCanonicalKey"::text) >= 1 AND char_length("proposedCanonicalKey"::text) <= 256 AND "proposedCanonicalKey"::text ~ '^[a-z0-9][a-z0-9._:-]{0,255}$'::text AND char_length("proposedDisplayText") >= 1 AND char_length("proposedDisplayText") <= 2000 AND char_length("proposedCategory"::text) >= 1 AND char_length("proposedCategory"::text) <= 64 AND "proposedCategory"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND pg_column_size("proposedValue") <= 8192 AND jsonb_typeof("proposedScope") = 'object'::text AND pg_column_size("proposedScope") <= 2048 AND "proposedScope" ? 'type'::text AND "proposedScope" ? 'target_id'::text AND (("proposedScope" ->> 'type'::text) = ANY (ARRAY['GLOBAL_USER'::text, 'FOLDER'::text, 'ASSISTANT'::text, 'CHAT'::text])) AND ("proposedScope" - ARRAY['type'::text, 'target_id'::text]) = '{}'::jsonb AND (("proposedScope" ->> 'type'::text) = 'GLOBAL_USER'::text AND COALESCE("proposedScope" ->> 'target_id'::text, ''::text) = ''::text OR ("proposedScope" ->> 'type'::text) <> 'GLOBAL_USER'::text AND char_length(COALESCE("proposedScope" ->> 'target_id'::text, ''::text)) >= 1 AND char_length(COALESCE("proposedScope" ->> 'target_id'::text, ''::text)) <= 256 AND COALESCE("proposedScope" ->> 'target_id'::text, ''::text) !~ '\\s'::text) AND ("proposedValidFrom" IS NULL OR "proposedValidTo" IS NULL OR "proposedValidTo" >= "proposedValidFrom") AND ("rawTemporalExpression" IS NULL OR char_length("rawTemporalExpression"::text) >= 1 AND char_length("rawTemporalExpression"::text) <= 512) AND "sourceTimezone"::text ~ '^[A-Za-z0-9_+./-]{1,64}$'::text AND (num_nonnulls("temporalResolverVersion", "temporalResolutionEvidence") = 0 OR num_nonnulls("temporalResolverVersion", "temporalResolutionEvidence") = 2 AND "temporalResolverVersion"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND jsonb_typeof("temporalResolutionEvidence") = 'object'::text AND pg_column_size("temporalResolutionEvidence") <= 4096) AND ("proposedDirectness" = ANY (ARRAY['DIRECT'::"MemoryDirectness", 'PARAPHRASED'::"MemoryDirectness"])) AND "proposedSensitivity" = 'NORMAL'::"MemorySensitivityClass" AND char_length("languageCode"::text) >= 2 AND char_length("languageCode"::text) <= 35 AND "languageCode"::text !~ '[[:cntrl:][:space:]]'::text AND importance >= 0::double precision AND importance <= 1::double precision AND confidence >= 0::double precision AND confidence <= 1::double precision AND ("pipelineVersion"::text <> 'memory-fact-extraction-v2'::text OR num_nonnulls("proposedCoreEligible", "proposedCoreSalience") = 2 AND ("proposedCoreEligible" AND "proposedCoreSalience" <> 'NONE'::"MemoryCoreSalience" OR NOT "proposedCoreEligible" AND "proposedCoreSalience" = 'NONE'::"MemoryCoreSalience"))) AND (state = 'PENDING'::"MemoryCandidateState" AND "reasonCode" IS NULL AND "resolvedAt" IS NULL AND "resolvedFactId" IS NULL AND "contentPurgedAt" IS NULL OR state = 'DEFERRED'::"MemoryCandidateState" AND "reasonCode" IS NOT NULL AND "resolvedAt" IS NULL AND "resolvedFactId" IS NULL AND "contentPurgedAt" IS NULL OR state = 'PROMOTED'::"MemoryCandidateState" AND "resolvedAt" IS NOT NULL AND "resolvedFactId" IS NOT NULL OR (state = ANY (ARRAY['REJECTED'::"MemoryCandidateState", 'STALE'::"MemoryCandidateState"])) AND "reasonCode" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "resolvedFactId" IS NULL));

ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_candidate_fkey" FOREIGN KEY ("userId", "candidateId") REFERENCES "MemoryCandidate"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_consolidation_execution_fkey" FOREIGN KEY ("userId", "consolidationExecutionId") REFERENCES "MemoryExecutionBinding"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_consolidation_job_fkey" FOREIGN KEY ("userId", "consolidationJobId") REFERENCES "MemoryJob"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_shape_check" CHECK (id ~ '^[a-f0-9]{64}$'::text AND "relatedSnapshotHash"::text ~ '^[a-f0-9]{64}$'::text AND "consolidationInputHash"::text ~ '^[a-f0-9]{64}$'::text AND "consolidationOutputHash"::text ~ '^[a-f0-9]{64}$'::text AND ("verificationInputHash" IS NULL OR "verificationInputHash"::text ~ '^[a-f0-9]{64}$'::text) AND ("verificationOutputHash" IS NULL OR "verificationOutputHash"::text ~ '^[a-f0-9]{64}$'::text) AND "reasonCode"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND ((operation = ANY (ARRAY['ADD'::"MemoryConsolidationOperation", 'NOOP'::"MemoryConsolidationOperation", 'DEFER'::"MemoryConsolidationOperation"])) AND num_nonnulls("targetFactId", "targetVersionId") = 0 OR (operation = ANY (ARRAY['REINFORCE'::"MemoryConsolidationOperation", 'SUPERSEDE'::"MemoryConsolidationOperation", 'CONFLICT'::"MemoryConsolidationOperation", 'EXPIRE'::"MemoryConsolidationOperation"])) AND num_nonnulls("targetFactId", "targetVersionId") = 2) AND (operation = 'SUPERSEDE'::"MemoryConsolidationOperation" OR "effectiveFrom" IS NULL) AND "requiresVerification" = (num_nonnulls("verificationJobId", "verificationInputHash") = 2) AND (num_nonnulls("verificationExecutionId", "verificationOutputHash") = ANY (ARRAY[0, 2])) AND (state = 'PENDING_VERIFICATION'::"MemoryCandidateDecisionState" AND "requiresVerification" AND "resolvedAt" IS NULL AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 0 OR state = 'APPLIED'::"MemoryCandidateDecisionState" AND "resolvedAt" IS NOT NULL AND (NOT "requiresVerification" AND num_nonnulls("verificationJobId", "verificationInputHash", "verificationExecutionId", "verificationOutputHash") = 0 OR "requiresVerification" AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 2) OR state = 'REJECTED'::"MemoryCandidateDecisionState" AND "requiresVerification" AND "resolvedAt" IS NOT NULL AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 2 OR state = 'STALE'::"MemoryCandidateDecisionState" AND "resolvedAt" IS NOT NULL));

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_target_fact_fkey" FOREIGN KEY ("userId", "targetFactId") REFERENCES "MemoryFact"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_target_version_fkey" FOREIGN KEY ("userId", "targetFactId", "targetVersionId") REFERENCES "MemoryFactVersion"("userId", "factId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_verification_execution_fkey" FOREIGN KEY ("userId", "verificationExecutionId") REFERENCES "MemoryExecutionBinding"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidateDecision" ADD CONSTRAINT "MemoryCandidateDecision_verification_job_fkey" FOREIGN KEY ("userId", "verificationJobId") REFERENCES "MemoryJob"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidateMessage" ADD CONSTRAINT "MemoryCandidateMessage_candidate_fkey" FOREIGN KEY ("userId", "chatId", "candidateId") REFERENCES "MemoryCandidate"("userId", "chatId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryCandidateMessage" ADD CONSTRAINT "MemoryCandidateMessage_message_fkey" FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryCandidateMessage" ADD CONSTRAINT "MemoryCandidateMessage_shape_check" CHECK (ordinal >= 0 AND ordinal <= 23 AND "startOffset" >= 0 AND "endOffset" > "startOffset" AND "endOffset" <= 16000 AND "sourceTextHash"::text ~ '^[a-f0-9]{64}$'::text);

ALTER TABLE "MemoryDeletionOutbox" ADD CONSTRAINT "MemoryDeletionOutbox_shape_check" CHECK ("memoryGeneration" >= 0 AND "attemptCount" >= 0 AND (state = 'RUNNING'::"MemoryDeletionState" AND num_nonnulls("leaseToken", "leaseExpiresAt") = 2 AND "completedAt" IS NULL OR (state = ANY (ARRAY['PENDING'::"MemoryDeletionState", 'RETRY_WAIT'::"MemoryDeletionState", 'BLOCKED_REQUIRES_ADMIN'::"MemoryDeletionState"])) AND num_nonnulls("leaseToken", "leaseExpiresAt", "completedAt") = 0 OR state = 'SUCCEEDED'::"MemoryDeletionState" AND num_nonnulls("leaseToken", "leaseExpiresAt") = 0 AND "completedAt" IS NOT NULL AND "lastAuditAt" IS NOT NULL OR state = 'CANCELLED'::"MemoryDeletionState" AND num_nonnulls("leaseToken", "leaseExpiresAt", "nextAttemptAt") = 0 AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL) AND (operation = 'SOURCE_PURGE'::"MemoryDeletionOperation" AND "targetType"::text = 'CHAT@memory-chat-delete-v1'::text AND "admissionAuthorizationId" IS NOT NULL AND "admittedChatSourceRevision" >= 0 AND "alsoForgetOriginMemories" IS NOT NULL OR NOT (operation = 'SOURCE_PURGE'::"MemoryDeletionOperation" AND "targetType"::text = 'CHAT@memory-chat-delete-v1'::text) AND num_nonnulls("admissionAuthorizationId", "admittedChatSourceRevision", "admittedActiveLeafMessageId", "alsoForgetOriginMemories") = 0));

ALTER TABLE "MemoryDeletionOutbox" ADD CONSTRAINT "MemoryDeletionOutbox_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEgressAdminPolicy" ADD CONSTRAINT "MemoryEgressAdminPolicy_shape_check" CHECK (id = 'installation'::text AND version >= 1 AND jsonb_typeof("acceptedDestinations") = 'array'::text AND jsonb_array_length("acceptedDestinations") <= 8192 AND pg_column_size("acceptedDestinations") <= 1048576 AND ("acceptedFingerprint" IS NULL AND "acceptedPolicyVersion" IS NULL AND "acceptedAt" IS NULL AND "acceptedDestinations" = '[]'::jsonb OR "acceptedFingerprint"::text ~ '^[a-f0-9]{64}$'::text AND "acceptedPolicyVersion"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND "acceptedAt" IS NOT NULL));

ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_actor_shape_check" CHECK ("actorType" = 'USER'::"MemoryActorType" AND "actorUserId" = "userId" OR "actorType" <> 'USER'::"MemoryActorType" AND "actorUserId" IS NULL);

ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_actor_user_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE SET NULL;

ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_chat_fkey" FOREIGN KEY ("userId", "sourceChatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_deleted_source_shape_check" CHECK ("sourceDeletedAt" IS NULL OR "sourceChatId" IS NULL);

ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_fact_fkey" FOREIGN KEY ("userId", "factId") REFERENCES "MemoryFact"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_version_fkey" FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_chat_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_event_fkey" FOREIGN KEY ("userId", "memoryEventId") REFERENCES "MemoryEvent"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_message_fkey" FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_version_fkey" FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_attempt_fkey" FOREIGN KEY ("userId", "retrievalAttemptId") REFERENCES "MemoryRetrievalAttempt"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_connection_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_credential_fkey" FOREIGN KEY ("connectionId", "credentialId") REFERENCES "ProviderCredential"("connectionId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_job_fkey" FOREIGN KEY ("userId", "memoryJobId") REFERENCES "MemoryJob"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_model_fkey" FOREIGN KEY ("connectionId", "providerModelId") REFERENCES "ProviderModel"("connectionId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_run_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_shape_check" CHECK (ordinal >= 0 AND ("ownerType" = 'JOB'::"MemoryExecutionOwnerType" AND "memoryJobId" IS NOT NULL AND num_nonnulls("retrievalAttemptId", "modelRunId", "modelRunToolCallId") = 0 OR "ownerType" = 'RETRIEVAL_ATTEMPT'::"MemoryExecutionOwnerType" AND "retrievalAttemptId" IS NOT NULL AND num_nonnulls("memoryJobId", "modelRunId", "modelRunToolCallId") = 0 OR "ownerType" = 'MODEL_RUN_TOOL_CALL'::"MemoryExecutionOwnerType" AND num_nonnulls("modelRunId", "modelRunToolCallId") = 2 AND num_nonnulls("memoryJobId", "retrievalAttemptId") = 0) AND (state = 'PENDING'::"MemoryExecutionState" AND num_nonnulls("startedAt", "completedAt") = 0 OR state = 'RUNNING'::"MemoryExecutionState" AND "startedAt" IS NOT NULL AND "completedAt" IS NULL OR state = 'OUTCOME_UNKNOWN'::"MemoryExecutionState" AND num_nonnulls("startedAt", "completedAt") = 2 OR (state = ANY (ARRAY['SUCCEEDED'::"MemoryExecutionState", 'FAILED'::"MemoryExecutionState", 'CANCELLED'::"MemoryExecutionState"])) AND "completedAt" IS NOT NULL) AND ("startedAt" IS NULL OR "startedAt" >= "createdAt") AND ("completedAt" IS NULL OR "completedAt" >= COALESCE("startedAt", "createdAt")) AND "providerId" IS NOT NULL AND ("relationsDetachedAt" IS NULL AND num_nonnulls("connectionId", "providerModelId", "credentialId", "credentialVersionId") = 4 OR "relationsDetachedAt" IS NOT NULL AND (state = ANY (ARRAY['SUCCEEDED'::"MemoryExecutionState", 'FAILED'::"MemoryExecutionState", 'CANCELLED'::"MemoryExecutionState"])) AND num_nonnulls("connectionId", "providerModelId", "credentialId", "credentialVersionId", "providerResponseId") = 0 AND "recoverableUntil" IS NOT NULL AND "recoverableUntil" <= "relationsDetachedAt") AND ("usageCompleteness" = 'UNAVAILABLE'::"MemoryUsageCompleteness" AND num_nonnulls("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "estimatedCostMicros") = 0 OR "usageCompleteness" = 'PARTIAL'::"MemoryUsageCompleteness" AND num_nonnulls("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "estimatedCostMicros") > 0 OR "usageCompleteness" = 'COMPLETE'::"MemoryUsageCompleteness" AND num_nonnulls("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens") = 5) AND COALESCE("inputTokens", 0) >= 0 AND COALESCE("cachedInputTokens", 0) >= 0 AND COALESCE("outputTokens", 0) >= 0 AND COALESCE("reasoningTokens", 0) >= 0 AND COALESCE("totalTokens", 0) >= 0 AND COALESCE("estimatedCostMicros", 0) >= 0);

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_tool_fkey" FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_version_fkey" FOREIGN KEY ("credentialId", "credentialVersionId") REFERENCES "ProviderCredentialVersion"("credentialId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_current_version_fkey" FOREIGN KEY ("userId", id, "currentVersionId") REFERENCES "MemoryFactVersion"("userId", "factId", id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_moved_to_fkey" FOREIGN KEY ("userId", "movedToFactId") REFERENCES "MemoryFact"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_scope_fkey" FOREIGN KEY ("userId", "scopeId") REFERENCES "MemoryScope"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_state_shape_check" CHECK ("temperatureScore" >= 0::double precision AND "temperatureScore" <= 1::double precision AND "canonicalKey"::text ~ '^[a-z][a-z0-9_.:-]{0,255}$'::text AND category::text ~ '^[a-z][a-z0-9_-]{0,63}$'::text AND (state = 'ACTIVE'::"MemoryFactState") = ("currentVersionId" IS NOT NULL) AND (state = 'FORGOTTEN'::"MemoryFactState") = ("forgottenAt" IS NOT NULL) AND ("movedToFactId" IS NULL OR "movedToFactId" <> id));

ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactVersion" ADD CONSTRAINT "MemoryFactVersion_created_event_fkey" FOREIGN KEY ("userId", "createdByEventId") REFERENCES "MemoryEvent"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "MemoryFactVersion" ADD CONSTRAINT "MemoryFactVersion_fact_fkey" FOREIGN KEY ("userId", "factId") REFERENCES "MemoryFact"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactVersion" ADD CONSTRAINT "MemoryFactVersion_moved_from_fkey" FOREIGN KEY ("userId", "movedFromVersionId") REFERENCES "MemoryFactVersion"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFactVersion" ADD CONSTRAINT "MemoryFactVersion_supersedes_fkey" FOREIGN KEY ("userId", "supersedesVersionId") REFERENCES "MemoryFactVersion"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFactVersion" ADD CONSTRAINT "MemoryFactVersion_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactVersion" ADD CONSTRAINT "MemoryFactVersion_value_check" CHECK (confidence >= 0::double precision AND confidence <= 1::double precision AND importance >= 0::double precision AND importance <= 1::double precision AND category::text ~ '^[a-z][a-z0-9_-]{0,63}$'::text AND ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" > "validFrom") AND ("systemTo" IS NULL OR "systemTo" > "systemFrom") AND ("supersedesVersionId" IS NULL OR "supersedesVersionId" <> id) AND ("movedFromVersionId" IS NULL OR "movedFromVersionId" <> id) AND ("contentPurgedAt" IS NULL AND "displayText" IS NOT NULL AND "normalizedSearchText" IS NOT NULL AND "structuredValue" IS NOT NULL OR "contentPurgedAt" IS NOT NULL AND (state = ANY (ARRAY['RETRACTED'::"MemoryFactVersionState", 'FORGOTTEN'::"MemoryFactVersionState"])) AND num_nonnulls("displayText", "normalizedSearchText", "structuredValue", "rawTemporalExpression", "temporalResolutionEvidence") = 0));

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_event_fkey" FOREIGN KEY ("userId", "memoryEventId") REFERENCES "MemoryEvent"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_fact_fkey" FOREIGN KEY ("userId", "memoryFactId") REFERENCES "MemoryFact"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_recall_chunk_fkey" FOREIGN KEY ("userId", "recallChunkId") REFERENCES "MemoryRecallChunk"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_retracts_fkey" FOREIGN KEY ("userId", "retractsFeedbackId") REFERENCES "MemoryFeedback"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_run_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_run_item_fkey" FOREIGN KEY ("userId", "modelRunMemoryItemId") REFERENCES "ModelRunMemoryItem"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_run_tool_fkey" FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_version_fkey" FOREIGN KEY ("userId", "memoryFactId", "memoryFactVersionId") REFERENCES "MemoryFactVersion"("userId", "factId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryHistoryRun" ADD CONSTRAINT "MemoryHistoryRun_shape_check" CHECK ("invocationOrdinal" >= 1 AND "invocationOrdinal" <= 2 AND "queryHash"::text ~ '^[a-f0-9]{64}$'::text AND pg_column_size("privateRequest") <= 16384 AND pg_column_size("indexingEvidence") <= 16384 AND cardinality("executionBindingIds") <= 8 AND char_length(array_to_string("executionBindingIds", ','::text)) <= 4096 AND array_to_string("executionBindingIds", ','::text) !~ '[[:cntrl:]]'::text AND (results IS NULL OR pg_column_size(results) <= 131072) AND ("providerResult" IS NULL OR pg_column_size("providerResult") <= 262144) AND ("resultHash" IS NULL OR "resultHash"::text ~ '^[a-f0-9]{64}$'::text) AND "resultCount" >= 0 AND "resultCount" <= 20 AND ("durationMs" IS NULL OR "durationMs" >= 0) AND ("errorCode" IS NULL OR "errorCode"::text ~ '^[A-Za-z0-9._-]{1,128}$'::text) AND ("retentionState" = 'RETAINED'::"MemoryReceiptRetentionState" AND query IS NOT NULL AND char_length(query::text) >= 1 AND char_length(query::text) <= 500 AND "plaintextPurgedAt" IS NULL OR "retentionState" = 'SCRUBBED'::"MemoryReceiptRetentionState" AND query IS NULL AND "privateRequest" = '{}'::jsonb AND results IS NULL AND "providerResult" IS NULL AND "plaintextPurgedAt" IS NOT NULL) AND (state = 'RUNNING'::"MemoryHistoryRunState" AND outcome IS NULL AND "completedAt" IS NULL AND "durationMs" IS NULL AND "errorCode" IS NULL AND results IS NULL AND "providerResult" IS NULL AND "resultHash" IS NULL AND "resultCount" = 0 OR state = 'COMPLETE'::"MemoryHistoryRunState" AND (outcome = ANY (ARRAY['RESULTS'::"MemoryHistoryRunOutcome", 'EMPTY'::"MemoryHistoryRunOutcome", 'DISABLED'::"MemoryHistoryRunOutcome", 'DEGRADED'::"MemoryHistoryRunOutcome"])) AND "completedAt" IS NOT NULL AND "durationMs" IS NOT NULL AND "errorCode" IS NULL AND ("retentionState" = 'SCRUBBED'::"MemoryReceiptRetentionState" OR results IS NOT NULL AND "providerResult" IS NOT NULL AND "resultHash" IS NOT NULL) AND (outcome = 'RESULTS'::"MemoryHistoryRunOutcome") = ("resultCount" > 0) OR (state = ANY (ARRAY['ERROR'::"MemoryHistoryRunState", 'CANCELLED'::"MemoryHistoryRunState"])) AND outcome = 'FAILED'::"MemoryHistoryRunOutcome" AND "completedAt" IS NOT NULL AND "durationMs" IS NOT NULL AND "errorCode" IS NOT NULL AND ("retentionState" = 'SCRUBBED'::"MemoryReceiptRetentionState" OR "providerResult" IS NOT NULL AND "resultHash" IS NOT NULL)));

ALTER TABLE "MemoryIndexGeneration" ADD CONSTRAINT "MemoryIndexGeneration_configuration_check" CHECK (generation >= 0 AND "targetMemoryRevision" >= 0 AND "indexedThroughMemoryRevision" >= 0 AND ("sourceIndexGenerationId" IS NULL OR "sourceIndexGenerationId" <> id) AND ("indexMode" = 'LEXICAL_ONLY'::"MemoryIndexMode" AND num_nonnulls("embeddingConnectionId", "embeddingProviderModelId", "embeddingConfigurationFingerprint", "embeddingDimension", "vectorSpaceFingerprint") = 0 OR "indexMode" = 'HYBRID'::"MemoryIndexMode" AND num_nonnulls("embeddingConnectionId", "embeddingProviderModelId", "embeddingConfigurationFingerprint", "embeddingDimension", "vectorSpaceFingerprint") = 5 AND "embeddingDimension" >= 1 AND "embeddingDimension" <= 4096) AND ((state = ANY (ARRAY['BUILDING'::"MemoryIndexGenerationState", 'CATCHING_UP'::"MemoryIndexGenerationState"])) AND num_nonnulls("readyAt", "activatedAt", "supersededAt") = 0 OR state = 'READY'::"MemoryIndexGenerationState" AND "readyAt" IS NOT NULL AND num_nonnulls("activatedAt", "supersededAt") = 0 OR state = 'ACTIVE'::"MemoryIndexGenerationState" AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "supersededAt" IS NULL OR state = 'SUPERSEDED'::"MemoryIndexGenerationState" AND num_nonnulls("readyAt", "activatedAt", "supersededAt") = 3 OR (state = ANY (ARRAY['FAILED'::"MemoryIndexGenerationState", 'CANCELLED'::"MemoryIndexGenerationState"])) AND "activatedAt" IS NULL AND "supersededAt" IS NULL));

ALTER TABLE "MemoryIndexGeneration" ADD CONSTRAINT "MemoryIndexGeneration_model_fkey" FOREIGN KEY ("embeddingConnectionId", "embeddingProviderModelId") REFERENCES "ProviderModel"("connectionId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryIndexGeneration" ADD CONSTRAINT "MemoryIndexGeneration_source_fkey" FOREIGN KEY ("userId", "sourceIndexGenerationId") REFERENCES "MemoryIndexGeneration"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryIndexGeneration" ADD CONSTRAINT "MemoryIndexGeneration_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_chat_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_leaf_fkey" FOREIGN KEY ("chatId", "activeLeafMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_shape_check" CHECK ("attemptCount" >= 0 AND "memoryGenerationSnapshot" >= 0 AND "memoryRevisionSnapshot" >= 0 AND ("chatId" IS NULL AND num_nonnulls("activeLeafMessageId", "branchGeneration", "sourceRevision") = 0 OR num_nonnulls("chatId", "activeLeafMessageId", "branchGeneration", "sourceRevision", "sourceHash") = 5 AND "branchGeneration" >= 0 AND "sourceRevision" >= 0) AND (state = 'CLAIMED'::"MemoryJobState" AND num_nonnulls("leaseToken", "leaseExpiresAt") = 2 AND "completedAt" IS NULL OR (state = ANY (ARRAY['QUEUED'::"MemoryJobState", 'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState", 'RETRYABLE_FAILED'::"MemoryJobState"])) AND num_nonnulls("leaseToken", "leaseExpiresAt", "completedAt") = 0 OR (state = ANY (ARRAY['SUCCEEDED'::"MemoryJobState", 'TERMINAL_FAILED'::"MemoryJobState", 'STALE'::"MemoryJobState", 'CANCELLED'::"MemoryJobState"])) AND num_nonnulls("leaseToken", "leaseExpiresAt") = 0 AND "completedAt" IS NOT NULL) AND (state <> 'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState" OR "nextAttemptAt" IS NULL));

ALTER TABLE "MemoryJob" ADD CONSTRAINT "MemoryJob_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryMutationAuthorization" ADD CONSTRAINT "MemoryMutationAuthorization_chat_fkey" FOREIGN KEY ("userId", "sourceChatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryMutationAuthorization" ADD CONSTRAINT "MemoryMutationAuthorization_message_fkey" FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryMutationAuthorization" ADD CONSTRAINT "MemoryMutationAuthorization_run_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryMutationAuthorization" ADD CONSTRAINT "MemoryMutationAuthorization_shape_check" CHECK ("expiresAt" > "createdAt" AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt") AND ("persistedToolCallId" IS NULL OR "modelRunId" IS NOT NULL) AND (num_nonnulls("sourceChatId", "sourceMessageId", "exactSourceStart", "exactSourceEnd") = 0 OR num_nonnulls("sourceChatId", "sourceMessageId", "exactSourceStart", "exactSourceEnd") = 4 AND "exactSourceStart" >= 0 AND "exactSourceEnd" > "exactSourceStart") AND ((action = ANY (ARRAY['EDIT'::"MemoryMutationAction", 'MOVE_SCOPE'::"MemoryMutationAction", 'FORGET'::"MemoryMutationAction"])) AND num_nonnulls("targetFactId", "expectedTargetVersionId") = 2 OR (action = ANY (ARRAY['SAVE'::"MemoryMutationAction", 'BULK_DELETE'::"MemoryMutationAction"])) AND num_nonnulls("targetFactId", "expectedTargetVersionId") = 0));

ALTER TABLE "MemoryMutationAuthorization" ADD CONSTRAINT "MemoryMutationAuthorization_target_fkey" FOREIGN KEY ("userId", "targetFactId", "expectedTargetVersionId") REFERENCES "MemoryFactVersion"("userId", "factId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryMutationAuthorization" ADD CONSTRAINT "MemoryMutationAuthorization_tool_fkey" FOREIGN KEY ("modelRunId", "persistedToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryMutationAuthorization" ADD CONSTRAINT "MemoryMutationAuthorization_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryOperationReceipt" ADD CONSTRAINT "MemoryOperationReceipt_run_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryOperationReceipt" ADD CONSTRAINT "MemoryOperationReceipt_shape_check" CHECK (("persistedToolCallId" IS NULL OR "modelRunId" IS NOT NULL) AND (num_nonnulls("targetFactId", "targetVersionId") = ANY (ARRAY[0, 2])));

ALTER TABLE "MemoryOperationReceipt" ADD CONSTRAINT "MemoryOperationReceipt_target_fkey" FOREIGN KEY ("userId", "targetFactId", "targetVersionId") REFERENCES "MemoryFactVersion"("userId", "factId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryOperationReceipt" ADD CONSTRAINT "MemoryOperationReceipt_tool_fkey" FOREIGN KEY ("modelRunId", "persistedToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryOperationReceipt" ADD CONSTRAINT "MemoryOperationReceipt_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRecallChunk" ADD CONSTRAINT "MemoryRecallChunk_assistant_fkey" FOREIGN KEY ("userId", "sourceAssistantId") REFERENCES "AssistantDefinition"("ownerUserId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRecallChunk" ADD CONSTRAINT "MemoryRecallChunk_chat_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRecallChunk" ADD CONSTRAINT "MemoryRecallChunk_folder_fkey" FOREIGN KEY ("userId", "sourceFolderId") REFERENCES "Folder"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRecallChunk" ADD CONSTRAINT "MemoryRecallChunk_shape_check" CHECK ("branchGeneration" >= 0 AND "sourceRevisionAtCreation" >= 0 AND "chunkOrdinal" >= 0 AND char_length("contentHash"::text) >= 16 AND char_length("contentHash"::text) <= 128 AND char_length("safeProjectedText") >= 1 AND char_length("safeProjectedText") <= 4000 AND char_length("normalizedSafeSearchText") >= 1 AND char_length("normalizedSafeSearchText") <= 4000 AND "languageCode"::text ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'::text AND "occurredTo" >= "occurredFrom" AND "chunkingVersion"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND "sourceProjectionVersion"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND "safetyClass" <> 'SECRET_TAINTED'::"MemoryDerivedSafetyClass" AND "redactionState" <> 'EXCLUDED'::"MemoryRedactionState" AND cardinality("redactionReasonCodes") <= 16 AND char_length(array_to_string("redactionReasonCodes", ','::text)) <= 1024 AND array_to_string("redactionReasonCodes", ','::text) ~ '^[A-Za-z0-9._,-]*$'::text AND ("redactionState" = 'NOT_NEEDED'::"MemoryRedactionState" AND cardinality("redactionReasonCodes") = 0 OR "redactionState" = 'REDACTED'::"MemoryRedactionState" AND cardinality("redactionReasonCodes") > 0) AND (state = 'ACTIVE'::"MemoryHistoryItemState" AND "invalidatedAt" IS NULL OR (state = ANY (ARRAY['INVALIDATED'::"MemoryHistoryItemState", 'SUPPRESSED'::"MemoryHistoryItemState"])) AND "invalidatedAt" IS NOT NULL));

ALTER TABLE "MemoryRecallChunk" ADD CONSTRAINT "MemoryRecallChunk_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRecallChunkMessage" ADD CONSTRAINT "MemoryRecallChunkMessage_chunk_fkey" FOREIGN KEY ("userId", "chatId", "chunkId") REFERENCES "MemoryRecallChunk"("userId", "chatId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRecallChunkMessage" ADD CONSTRAINT "MemoryRecallChunkMessage_message_fkey" FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRecallChunkMessage" ADD CONSTRAINT "MemoryRecallChunkMessage_shape_check" CHECK (ordinal >= 0 AND (role::text = ANY (ARRAY['user'::character varying, 'assistant'::character varying]::text[])) AND (num_nonnulls("startOffset", "endOffset") = 0 OR num_nonnulls("startOffset", "endOffset") = 2 AND "startOffset" >= 0 AND "endOffset" > "startOffset"));

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_assistant_message_fkey" FOREIGN KEY ("chatId", "admittedAssistantLeafMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_chat_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_generation_fkey" FOREIGN KEY ("userId", "indexGenerationIdSnapshot") REFERENCES "MemoryIndexGeneration"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_pre_leaf_fkey" FOREIGN KEY ("chatId", "preSendActiveLeafMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_run_fkey" FOREIGN KEY ("userId", "chatId", "modelRunId") REFERENCES "ModelRun"("userId", "chatId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_shape_check" CHECK ("attemptOrdinal" >= 0 AND "memoryGenerationSnapshot" >= 0 AND "retrievalRevisionSnapshot" >= 0 AND "expiresAt" > "createdAt" AND ("utilityEgressMode" = 'LOCAL_ONLY'::"MemoryUtilityEgressMode" AND "acceptedUtilityEgressFingerprint" IS NULL AND cardinality("externalRolesUsed") = 0 OR "utilityEgressMode" = 'CONSENTED_EXTERNAL'::"MemoryUtilityEgressMode" AND "acceptedUtilityEgressFingerprint" IS NOT NULL AND cardinality("externalRolesUsed") > 0) AND ((state = ANY (ARRAY['PENDING'::"MemoryRetrievalAttemptState", 'EXECUTING'::"MemoryRetrievalAttemptState"])) AND outcome IS NULL AND "consumedAt" IS NULL OR state = 'READY'::"MemoryRetrievalAttemptState" AND outcome IS NOT NULL AND "consumedAt" IS NULL OR state = 'CONSUMED'::"MemoryRetrievalAttemptState" AND outcome IS NOT NULL AND "consumedAt" IS NOT NULL OR (state = ANY (ARRAY['STALE'::"MemoryRetrievalAttemptState", 'FAILED'::"MemoryRetrievalAttemptState", 'CANCELLED'::"MemoryRetrievalAttemptState", 'EXPIRED'::"MemoryRetrievalAttemptState"])) AND (outcome IS NOT NULL OR "errorCode" IS NOT NULL) AND "consumedAt" IS NULL) AND (num_nonnulls("preparedContextText", "preparedContextHash", "preparedContextTokenCount") = 0 OR num_nonnulls("preparedContextText", "preparedContextHash", "preparedContextTokenCount") = 3 AND "preparedContextTokenCount" >= 0) AND (outcome IS DISTINCT FROM 'USED'::"MemoryReceiptOutcome" OR (state <> ALL (ARRAY['READY'::"MemoryRetrievalAttemptState", 'CONSUMED'::"MemoryRetrievalAttemptState"])) OR num_nonnulls("preparedContextText", "preparedContextHash", "preparedContextTokenCount") = 3) AND ((state <> ALL (ARRAY['PENDING'::"MemoryRetrievalAttemptState", 'EXECUTING'::"MemoryRetrievalAttemptState", 'READY'::"MemoryRetrievalAttemptState"])) OR "boundedPrivateBaseRequestSnapshot" IS NOT NULL));

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRetrievalAttempt" ADD CONSTRAINT "MemoryRetrievalAttempt_user_message_fkey" FOREIGN KEY ("chatId", "admittedUserMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRetrievalAttemptItem" ADD CONSTRAINT "MemoryRetrievalAttemptItem_attempt_fkey" FOREIGN KEY ("userId", "attemptId") REFERENCES "MemoryRetrievalAttempt"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRetrievalAttemptItem" ADD CONSTRAINT "MemoryRetrievalAttemptItem_recall_chunk_fkey" FOREIGN KEY ("userId", "recallChunkId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot", "sourceRevisionSnapshot", "sourceContentHashSnapshot") REFERENCES "MemoryRecallChunk"("userId", id, "chatId", "branchGeneration", "sourceRevisionAtCreation", "contentHash") ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryRetrievalAttemptItem" ADD CONSTRAINT "MemoryRetrievalAttemptItem_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryRetrievalAttemptItem" ADD CONSTRAINT "MemoryRetrievalAttemptItem_version_fkey" FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryScope" ADD CONSTRAINT "MemoryScope_assistant_fkey" FOREIGN KEY ("userId", "assistantId") REFERENCES "AssistantDefinition"("ownerUserId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryScope" ADD CONSTRAINT "MemoryScope_chat_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryScope" ADD CONSTRAINT "MemoryScope_folder_fkey" FOREIGN KEY ("userId", "folderId") REFERENCES "Folder"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryScope" ADD CONSTRAINT "MemoryScope_target_shape_check" CHECK ("scopeType" = 'GLOBAL_USER'::"MemoryScopeType" AND state = 'ACTIVE'::"MemoryScopeState" AND num_nonnulls("targetIdSnapshot", "targetDisplaySnapshot", "folderId", "assistantId", "chatId", "orphanedAt") = 0 OR state = 'ACTIVE'::"MemoryScopeState" AND "scopeType" <> 'GLOBAL_USER'::"MemoryScopeType" AND "targetIdSnapshot" IS NOT NULL AND "orphanedAt" IS NULL AND ("scopeType" = 'FOLDER'::"MemoryScopeType" AND "folderId" = "targetIdSnapshot" AND "assistantId" IS NULL AND "chatId" IS NULL OR "scopeType" = 'ASSISTANT'::"MemoryScopeType" AND "assistantId" = "targetIdSnapshot" AND "folderId" IS NULL AND "chatId" IS NULL OR "scopeType" = 'CHAT'::"MemoryScopeType" AND "chatId" = "targetIdSnapshot" AND "folderId" IS NULL AND "assistantId" IS NULL) OR (state = ANY (ARRAY['ORPHANED'::"MemoryScopeState", 'RETRACTED'::"MemoryScopeState"])) AND "scopeType" <> 'GLOBAL_USER'::"MemoryScopeType" AND "targetIdSnapshot" IS NOT NULL AND num_nonnulls("folderId", "assistantId", "chatId") = 0 AND (state <> 'ORPHANED'::"MemoryScopeState" OR "orphanedAt" IS NOT NULL));

ALTER TABLE "MemoryScope" ADD CONSTRAINT "MemoryScope_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySearchEntry" ADD CONSTRAINT "MemorySearchEntry_fact_version_fkey" FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySearchEntry" ADD CONSTRAINT "MemorySearchEntry_generation_fkey" FOREIGN KEY ("userId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySearchEntry" ADD CONSTRAINT "MemorySearchEntry_recall_chunk_fkey" FOREIGN KEY ("userId", "recallChunkId") REFERENCES "MemoryRecallChunk"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySearchEntry" ADD CONSTRAINT "MemorySearchEntry_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySourceBarrier" ADD CONSTRAINT "MemorySourceBarrier_generation_check" CHECK ("memoryGeneration" >= 0);

ALTER TABLE "MemorySourceBarrier" ADD CONSTRAINT "MemorySourceBarrier_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemorySuppression" ADD CONSTRAINT "MemorySuppression_chat_fkey" FOREIGN KEY ("userId", "sourceChatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemorySuppression" ADD CONSTRAINT "MemorySuppression_message_fkey" FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemorySuppression" ADD CONSTRAINT "MemorySuppression_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryToolEgressReceipt" ADD CONSTRAINT "MemoryToolEgressReceipt_shape_check" CHECK ("requestOrdinal" >= 1 AND "requestOrdinal" <= 64 AND "destinationKind"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text AND "destinationFingerprint"::text ~ '^[a-f0-9]{64}$'::text AND "requestEvidenceHash"::text ~ '^[a-f0-9]{64}$'::text AND ("requestPreviewHash" IS NULL OR "requestPreviewHash"::text ~ '^[a-f0-9]{64}$'::text) AND pg_column_size("destinationSnapshot") <= 32768 AND (jsonb_typeof("destinationSnapshot") = ANY (ARRAY['object'::text, 'array'::text])) AND ("errorCode" IS NULL OR "errorCode"::text ~ '^[A-Za-z0-9._-]{1,128}$'::text) AND (mode = 'PROVIDER_REQUEST'::"MemoryToolEgressMode" AND "modelRunToolCallId" IS NULL OR mode = 'TOOL_CALL'::"MemoryToolEgressMode" AND "modelRunToolCallId" IS NOT NULL) AND ("dispatchState" = 'DISPATCHED'::"MemoryToolEgressDispatchState" AND "dispatchStartedAt" IS NOT NULL AND "dispatchCompletedAt" IS NULL AND "errorCode" IS NULL OR "dispatchState" = 'COMPLETED'::"MemoryToolEgressDispatchState" AND num_nonnulls("dispatchStartedAt", "dispatchCompletedAt") = 2 AND "errorCode" IS NULL OR "dispatchState" = 'BLOCKED'::"MemoryToolEgressDispatchState" AND "dispatchStartedAt" IS NULL AND "dispatchCompletedAt" IS NOT NULL AND "errorCode" IS NOT NULL OR "dispatchState" = 'FAILED'::"MemoryToolEgressDispatchState" AND num_nonnulls("dispatchStartedAt", "dispatchCompletedAt") = 2 AND "errorCode" IS NOT NULL) AND ("dispatchCompletedAt" IS NULL OR "dispatchStartedAt" IS NULL OR "dispatchCompletedAt" >= "dispatchStartedAt"));

ALTER TABLE "Message" ADD CONSTRAINT "Message_grounding_provenance_check" CHECK ("groundedAt" IS NULL AND "groundingProvider" IS NULL AND "groundingStrategy" IS NULL OR role = 'assistant'::text AND "groundedAt" IS NOT NULL AND "groundingProvider" = 'gemini'::text AND "groundingStrategy" = 'gemini-google-search'::text);

ALTER TABLE "ModelPolicy" ADD CONSTRAINT "ModelPolicy_singleton_check" CHECK (id = 'installation'::text);

ALTER TABLE "ModelPolicy" ADD CONSTRAINT "ModelPolicy_version_check" CHECK (version >= 1);

ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_assistant_pair_check" CHECK (("assistantId" IS NULL) = ("assistantRevisionId" IS NULL));

ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_user_chat_memory_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "ModelRunMemoryBinding" ADD CONSTRAINT "ModelRunMemoryBinding_attempt_fkey" FOREIGN KEY ("userId", "modelRunId", "retrievalAttemptId") REFERENCES "MemoryRetrievalAttempt"("userId", "modelRunId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "ModelRunMemoryBinding" ADD CONSTRAINT "ModelRunMemoryBinding_generation_fkey" FOREIGN KEY ("userId", "indexGenerationId") REFERENCES "MemoryIndexGeneration"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "ModelRunMemoryBinding" ADD CONSTRAINT "ModelRunMemoryBinding_run_fkey" FOREIGN KEY ("userId", "modelRunId") REFERENCES "ModelRun"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "ModelRunMemoryBinding" ADD CONSTRAINT "ModelRunMemoryBinding_shape_check" CHECK ("memoryGenerationSnapshot" >= 0 AND "retrievalRevisionSnapshot" >= 0 AND "finalizedRevisionSnapshot" >= "retrievalRevisionSnapshot" AND "contextTokenCount" >= 0);

ALTER TABLE "ModelRunMemoryBinding" ADD CONSTRAINT "ModelRunMemoryBinding_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "ModelRunMemoryItem" ADD CONSTRAINT "ModelRunMemoryItem_binding_fkey" FOREIGN KEY ("userId", "bindingId") REFERENCES "ModelRunMemoryBinding"("userId", id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "ModelRunMemoryItem" ADD CONSTRAINT "ModelRunMemoryItem_recall_chunk_fkey" FOREIGN KEY ("userId", "recallChunkId", "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot", "sourceRevisionSnapshot", "sourceContentHashSnapshot") REFERENCES "MemoryRecallChunk"("userId", id, "chatId", "branchGeneration", "sourceRevisionAtCreation", "contentHash") ON UPDATE RESTRICT ON DELETE SET NULL ("recallChunkId");

ALTER TABLE "ModelRunMemoryItem" ADD CONSTRAINT "ModelRunMemoryItem_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "ModelRunMemoryItem" ADD CONSTRAINT "ModelRunMemoryItem_version_fkey" FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", id) ON UPDATE RESTRICT ON DELETE SET NULL ("factVersionId");

ALTER TABLE "ModelRunToolCall" ADD CONSTRAINT "ModelRunToolCall_position_check" CHECK ("roundIndex" >= 0 AND ordinal >= 0);

ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_active_config_check" CHECK ("activeVersion" = 0 AND "activeConfig" IS NULL AND "activatedAt" IS NULL OR "activeVersion" > 0 AND "activeConfig" IS NOT NULL AND "activatedAt" IS NOT NULL);

ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_name_family_check" CHECK (btrim("displayName") <> ''::text AND btrim(family) <> ''::text);

ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_versions_check" CHECK ("draftVersion" >= 1 AND "activeVersion" >= 0);

ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_active_pointer_check" CHECK ("activeVersionId" IS NULL OR "activatedAt" IS NOT NULL);

ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_draft_version_check" CHECK ("draftVersion" >= 0);

ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_label_check" CHECK (btrim(label) <> ''::text);

ALTER TABLE "ProviderCredentialVersion" ADD CONSTRAINT "ProviderCredentialVersion_secret_check" CHECK ("secretEnvelope" IS NOT NULL OR "revokedAt" IS NOT NULL OR COALESCE(("testEvidence" ->> 'authenticationMode'::text) = 'none'::text, false));

ALTER TABLE "ProviderCredentialVersion" ADD CONSTRAINT "ProviderCredentialVersion_version_check" CHECK (version > 0);

ALTER TABLE "ProviderDraftCheck" ADD CONSTRAINT "ProviderDraftCheck_credential_source_check" CHECK (num_nonnulls("credentialVersionId", "credentialDraftVersion") = 1);

ALTER TABLE "ProviderDraftCheck" ADD CONSTRAINT "ProviderDraftCheck_versions_check" CHECK ("connectionDraftVersion" >= 1 AND "modelDraftVersion" >= 1 AND ("credentialDraftVersion" IS NULL OR "credentialDraftVersion" >= 1));

ALTER TABLE "ProviderModel" ADD CONSTRAINT "ProviderModel_active_config_check" CHECK ("activeVersion" = 0 AND "activeConfig" IS NULL AND "activatedAt" IS NULL OR "activeVersion" > 0 AND "activeConfig" IS NOT NULL AND "activatedAt" IS NOT NULL);

ALTER TABLE "ProviderModel" ADD CONSTRAINT "ProviderModel_versions_check" CHECK ("draftVersion" >= 1 AND "activeVersion" >= 0);

ALTER TABLE "ProviderModelCredentialCheck" ADD CONSTRAINT "ProviderModelCredentialCheck_versions_check" CHECK ("connectionVersion" > 0 AND "modelVersion" > 0);

ALTER TABLE "ProviderRunBinding" ADD CONSTRAINT "ProviderRunBinding_live_or_detached_check" CHECK ("connectionId" IS NULL AND "providerModelId" IS NULL AND "credentialId" IS NULL AND "credentialVersionId" IS NULL OR "connectionId" IS NOT NULL AND "providerModelId" IS NOT NULL AND ("credentialId" IS NULL AND "credentialVersionId" IS NULL OR "credentialId" IS NOT NULL AND "credentialVersionId" IS NOT NULL));

ALTER TABLE "SearchIntegrationRevision" ADD CONSTRAINT "SearchIntegrationRevision_adapterKind_check" CHECK ("adapterKind" = ANY (ARRAY['none'::text, 'answer_provider_hosted'::text, 'provider_model_client'::text]));

ALTER TABLE "SearchIntegrationRevision" ADD CONSTRAINT "SearchIntegrationRevision_credentialMode_check" CHECK ("credentialMode" = ANY (ARRAY['answer_provider'::text, 'provider_model'::text]));

ALTER TABLE "SearchIntegrationRevision" ADD CONSTRAINT "SearchIntegrationRevision_revisionNumber_check" CHECK ("revisionNumber" >= 1);

ALTER TABLE "SearchOption" ADD CONSTRAINT "SearchOption_archive_check" CHECK ("archivedAt" IS NULL OR NOT enabled);

ALTER TABLE "SearchOption" ADD CONSTRAINT "SearchOption_kind_check" CHECK (kind = ANY (ARRAY['none'::text, 'web_search'::text, 'gemini_google_search'::text, 'perplexity_search'::text]));

ALTER TABLE "SearchOption" ADD CONSTRAINT "SearchOption_source_check" CHECK (kind = 'none'::text AND "optionId" = 'search-disabled'::text AND "sourceConnectionId" IS NULL OR kind <> 'none'::text AND "sourceConnectionId" IS NOT NULL);

ALTER TABLE "SearchOption" ADD CONSTRAINT "SearchOption_text_check" CHECK (btrim("optionId") <> ''::text AND char_length("optionId") <= 160 AND btrim("displayName") <> ''::text AND char_length("displayName") <= 160 AND btrim(description) <> ''::text AND char_length(description) <= 500 AND ("templateKey" IS NULL OR btrim("templateKey") <> ''::text AND char_length("templateKey") <= 160));

ALTER TABLE "SearchPolicy" ADD CONSTRAINT "SearchPolicy_singleton_check" CHECK (id = 'installation'::text);

ALTER TABLE "SearchPolicy" ADD CONSTRAINT "SearchPolicy_version_check" CHECK (version >= 1);

ALTER TABLE "SearchStrategy" ADD CONSTRAINT "SearchStrategy_adapterKind_check" CHECK ("adapterKind" = ANY (ARRAY['none'::text, 'answer_provider_hosted'::text, 'provider_model_client'::text]));

ALTER TABLE "SearchStrategy" ADD CONSTRAINT "SearchStrategy_credentialMode_check" CHECK ("credentialMode" = ANY (ARRAY['answer_provider'::text, 'provider_model'::text]));

ALTER TABLE "SearchStrategy" ADD CONSTRAINT "SearchStrategy_draftVersion_check" CHECK ("draftVersion" >= 1);

ALTER TABLE "SearchStrategy" ADD CONSTRAINT "SearchStrategy_provider_model_check" CHECK ((kind = ANY (ARRAY['perplexity_tool_search'::text, 'provider_model_web_search'::text])) AND "providerModelId" IS NOT NULL OR kind = 'gemini_google_search'::text AND ("adapterKind" = 'answer_provider_hosted'::text AND "credentialMode" = 'answer_provider'::text AND "providerModelId" IS NULL OR "adapterKind" = 'provider_model_client'::text AND "credentialMode" = 'provider_model'::text AND "providerModelId" IS NOT NULL) OR kind = 'anthropic_native_web_search'::text AND "adapterKind" = 'answer_provider_hosted'::text AND "credentialMode" = 'answer_provider'::text AND "providerModelId" IS NULL OR (kind = ANY (ARRAY['none'::text, 'openai_native_web_search'::text])) AND "providerModelId" IS NULL);

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_active_secret_check" CHECK (("activePasswordEnvelope" IS NULL) = ("activeSecretGeneration" IS NULL) AND ("activeSecretGeneration" IS NULL OR "activeSecretGeneration" > 0 AND "activeSecretGeneration" <= "secretGenerationCounter"));

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_active_slot_check" CHECK ("activeConfig" IS NULL AND "activePasswordEnvelope" IS NULL AND "activeSecretGeneration" IS NULL AND enabled = false AND "activatedAt" IS NULL AND "activatedByUserId" IS NULL OR "activeConfig" IS NOT NULL AND "activatedAt" IS NOT NULL);

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_draft_secret_check" CHECK (("draftPasswordEnvelope" IS NULL) = ("draftSecretGeneration" IS NULL) AND ("draftSecretGeneration" IS NULL OR "draftSecretGeneration" > 0 AND "draftSecretGeneration" <= "secretGenerationCounter"));

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_draft_slot_check" CHECK ("draftConfig" IS NOT NULL OR "draftPasswordEnvelope" IS NULL AND "draftSecretGeneration" IS NULL AND "testedDraftVersion" IS NULL AND "draftTestVersion" IS NULL AND "draftTestAt" IS NULL AND "draftTestCode" IS NULL);

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_draft_test_check" CHECK ("draftTestVersion" IS NULL AND "draftTestAt" IS NULL AND "draftTestCode" IS NULL OR "draftTestVersion" = "draftVersion" AND "draftTestAt" IS NOT NULL AND "draftTestCode" IS NOT NULL);

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_health_check" CHECK ("healthActiveVersion" IS NULL AND "lastAttemptAt" IS NULL AND "lastAcceptedAt" IS NULL AND "lastFailureAt" IS NULL AND "lastFailureCode" IS NULL OR "healthActiveVersion" = "activeVersion" AND ("lastFailureAt" IS NULL) = ("lastFailureCode" IS NULL));

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_singleton_check" CHECK (id = 'installation-smtp'::text);

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_tested_draft_check" CHECK ("testedDraftVersion" IS NULL OR "testedDraftVersion" = "draftVersion" AND "draftTestVersion" = "draftVersion" AND "draftTestCode" = 'accepted'::text);

ALTER TABLE "SmtpControl" ADD CONSTRAINT "SmtpControl_versions_check" CHECK ("draftVersion" >= 0 AND "activeVersion" >= 0 AND "secretGenerationCounter" >= 0);

ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_reasoningEffort_check" CHECK ("reasoningEffort" IS NULL OR char_length("reasoningEffort"::text) >= 1 AND char_length("reasoningEffort"::text) <= 32 AND btrim("reasoningEffort"::text) = "reasoningEffort"::text AND "reasoningEffort"::text !~ '[[:cntrl:]]'::text);

ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_reasoning_target_check" CHECK ("providerModelId" IS NOT NULL OR "reasoningEffort" IS NULL);

ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_singleton_check" CHECK (id = 'installation'::text);

ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_version_check" CHECK (version >= 1);

ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK ("memoryExecutionBindingId" IS NULL AND "providerModelId" IS NULL AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL OR "memoryExecutionBindingId" IS NULL AND "providerModelId" IS NOT NULL AND "knowledgeBaseId" IS NOT NULL AND "knowledgeIndexGenerationId" IS NOT NULL AND "knowledgeDocumentVersionId" IS NOT NULL AND "knowledgeBatchIndex" >= 0 AND "modelRunId" IS NULL AND "chatId" IS NULL OR "memoryExecutionBindingId" IS NOT NULL AND "providerModelId" IS NOT NULL AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL AND "modelRunId" IS NULL AND "chatId" IS NULL);

ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_memory_execution_fkey" FOREIGN KEY ("userId", "memoryExecutionBindingId") REFERENCES "MemoryExecutionBinding"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "UserMemorySettings" ADD CONSTRAINT "UserMemorySettings_active_generation_fkey" FOREIGN KEY ("userId", "activeIndexGenerationId") REFERENCES "MemoryIndexGeneration"("userId", id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "UserMemorySettings" ADD CONSTRAINT "UserMemorySettings_counter_check" CHECK ("memoryGeneration" >= 0 AND "memoryRevision" >= 0 AND "memoryConsentRevision" >= 0 AND "settingsRevision" >= 0);

ALTER TABLE "UserMemorySettings" ADD CONSTRAINT "UserMemorySettings_embedding_model_fkey" FOREIGN KEY ("embeddingProviderModelId") REFERENCES "ProviderModel"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "UserMemorySettings" ADD CONSTRAINT "UserMemorySettings_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "UserMemorySettings" ADD CONSTRAINT "UserMemorySettings_utility_consent_check" CHECK (num_nonnulls("acceptedUtilityEgressFingerprint", "acceptedUtilityPolicyVersion", "acceptedUtilityEgressAt") = ANY (ARRAY[0, 3]));

ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_source_shape_check" CHECK (
    char_length("safeExcerpt") BETWEEN 1 AND 2000
    AND (
      "sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
      AND num_nonnulls("chatId", "messageId", "branchGeneration") = 3
      AND "memoryEventId" IS NULL
      OR "sourceType" = 'EXPLICIT_ACTION'::"MemoryEvidenceSourceType"
      AND "memoryEventId" IS NOT NULL
      AND num_nonnulls("chatId", "messageId", "branchGeneration") = 0
    )
  );

ALTER TABLE "MemoryFeedback" ADD CONSTRAINT "MemoryFeedback_shape_check" CHECK (
    "idempotencyFingerprint"::text ~ '^[a-f0-9]{64}$'::text
    AND char_length("requestId"::text) BETWEEN 1 AND 256
    AND (comment IS NULL OR char_length(comment::text) BETWEEN 1 AND 1000 AND btrim(comment::text) <> ''::text)
    AND (
      "contentPurgedAt" IS NULL
      AND "purgeReason" IS NULL
      AND "memoryEventId" IS NOT NULL
      AND (
        "targetKind" = 'FACT_VERSION'::"MemoryFeedbackTargetKind"
        AND num_nonnulls("memoryFactId", "memoryFactVersionId") = 2
        AND "recallChunkId" IS NULL
        OR "targetKind" = 'RECALL_CHUNK'::"MemoryFeedbackTargetKind"
        AND "recallChunkId" IS NOT NULL
        AND num_nonnulls("memoryFactId", "memoryFactVersionId") = 0
      )
      AND (
        num_nonnulls("modelRunId", "modelRunMemoryItemId", "modelRunToolCallId") = 0
        OR "modelRunId" IS NOT NULL AND num_nonnulls("modelRunMemoryItemId", "modelRunToolCallId") = 1
      )
      AND (
        "feedbackType" = 'RETRACT'::"MemoryFeedbackType" AND "retractsFeedbackId" IS NOT NULL AND comment IS NULL
        OR "feedbackType" <> 'RETRACT'::"MemoryFeedbackType" AND "retractsFeedbackId" IS NULL
      )
      OR "contentPurgedAt" IS NOT NULL
      AND "purgeReason"::text ~ '^[a-z][a-z0-9._-]{0,63}$'::text
      AND num_nonnulls(
        "memoryFactId", "memoryFactVersionId", "recallChunkId", "modelRunId",
        "modelRunMemoryItemId", "modelRunToolCallId", "sourceChatIdSnapshot",
        "sourceBranchGenerationSnapshot", comment, "retractsFeedbackId", "memoryEventId"
      ) = 0
    )
  );

ALTER TABLE "MemoryRetrievalAttemptItem" ADD CONSTRAINT "MemoryRetrievalAttemptItem_shape_check" CHECK (
    ordinal >= 0
    AND char_length("exactItemId") BETWEEN 1 AND 256
    AND char_length("exactSafeText") BETWEEN 1 AND 4000
    AND (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND "factVersionId" IS NOT NULL
      AND "exactItemId" = "factVersionId"
      AND "recallChunkId" IS NULL
      AND (
        num_nonnulls("sourceChatIdSnapshot", "sourceBranchGenerationSnapshot", "sourceRevisionSnapshot", "sourceContentHashSnapshot") IN (0, 4)
        OR num_nonnulls("sourceChatIdSnapshot", "sourceBranchGenerationSnapshot") = 2
          AND num_nonnulls("sourceRevisionSnapshot", "sourceContentHashSnapshot") = 0
      )
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "recallChunkId" IS NOT NULL
      AND "exactItemId" = "recallChunkId"
      AND "factVersionId" IS NULL
      AND num_nonnulls("sourceChatIdSnapshot", "sourceBranchGenerationSnapshot", "sourceRevisionSnapshot", "sourceContentHashSnapshot") = 4
    )
    AND ("sourceBranchGenerationSnapshot" IS NULL OR "sourceBranchGenerationSnapshot" >= 0)
    AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
  );

ALTER TABLE "MemorySearchEntry" ADD CONSTRAINT "MemorySearchEntry_shape_check" CHECK (
    (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND "factVersionId" IS NOT NULL
      AND "recallChunkId" IS NULL
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "recallChunkId" IS NOT NULL
      AND "factVersionId" IS NULL
    )
    AND char_length("normalizedSearchText") BETWEEN 1 AND 4000
    AND (
      "embeddingState" IN ('NOT_APPLICABLE'::"MemoryEmbeddingState", 'PENDING'::"MemoryEmbeddingState", 'FAILED'::"MemoryEmbeddingState")
      AND num_nonnulls(embedding, "embeddingDimension") = 0
      OR "embeddingState" = 'READY'::"MemoryEmbeddingState"
      AND num_nonnulls(embedding, "embeddingDimension") = 2
    )
  );

ALTER TABLE "MemorySuppression" ADD CONSTRAINT "MemorySuppression_shape_check" CHECK (
    "deletionGeneration" >= 0
    AND "fingerprintKeyVersion"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text
    AND ("canonicalKeyHash" IS NULL OR "canonicalKeyHash"::text ~ '^[A-Za-z0-9_-]{43}$'::text)
    AND ("normalizedValueHash" IS NULL OR "normalizedValueHash"::text ~ '^[A-Za-z0-9_-]{43}$'::text)
    AND (
      scope = 'FACT'::"MemorySuppressionScope"
      AND "canonicalKeyHash" IS NOT NULL
      AND num_nonnulls("normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceBranchGeneration") = 0
      OR scope = 'VALUE'::"MemorySuppressionScope"
      AND "normalizedValueHash" IS NOT NULL
      AND num_nonnulls("canonicalKeyHash", "sourceChatId", "sourceMessageId", "sourceBranchGeneration") = 0
      OR scope = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
      AND num_nonnulls("sourceChatId", "sourceMessageId", "sourceBranchGeneration") = 3
      OR scope = 'CATEGORY'::"MemorySuppressionScope"
      AND "canonicalKeyHash" IS NOT NULL
      AND num_nonnulls("normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceBranchGeneration") = 0
      OR scope = 'ALL'::"MemorySuppressionScope"
      AND num_nonnulls("canonicalKeyHash", "normalizedValueHash", "sourceChatId", "sourceMessageId", "sourceBranchGeneration") = 0
    )
  );

ALTER TABLE "ModelRunMemoryItem" ADD CONSTRAINT "ModelRunMemoryItem_shape_check" CHECK (
    ordinal >= 0
    AND char_length("exactItemId") BETWEEN 1 AND 256
    AND char_length("includedText") BETWEEN 1 AND 4000
    AND "finalScore" BETWEEN 0::double precision AND 1::double precision
    AND num_nonnulls("factVersionId", "recallChunkId") <= 1
    AND (
      "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND "recallChunkId" IS NULL
      AND ("factVersionId" IS NULL OR "exactItemId" = "factVersionId")
      OR "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND "factVersionId" IS NULL
      AND ("recallChunkId" IS NULL OR "exactItemId" = "recallChunkId")
      AND num_nonnulls("sourceChatIdSnapshot", "sourceBranchGenerationSnapshot", "sourceRevisionSnapshot", "sourceContentHashSnapshot") = 4
    )
    AND ("sourceBranchGenerationSnapshot" IS NULL OR "sourceBranchGenerationSnapshot" >= 0)
    AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
  );

ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_memory_request_shape_check" CHECK (
    status = 'preparing'::"ModelRunStatus" AND "normalizedRequest" IS NULL
    OR status <> 'preparing'::"ModelRunStatus" AND "normalizedRequest" IS NOT NULL
  );

-- Deferred and row-level integrity triggers required by the current pre-production schema.

CREATE TRIGGER "Attachment_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "Attachment" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE CONSTRAINT TRIGGER "Chat_memory_history_source_guard" AFTER INSERT OR UPDATE ON "Chat" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_history_source_trigger();

CREATE TRIGGER "Chat_memory_mode_guard" BEFORE UPDATE ON "Chat" FOR EACH ROW EXECUTE FUNCTION aiqsa_chat_memory_mode_guard();

CREATE TRIGGER "Chat_permanent_deletion_guard" BEFORE UPDATE ON "Chat" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_delete_guard();

CREATE TRIGGER "Chat_temporary_delete_guard" BEFORE DELETE ON "Chat" FOR EACH ROW EXECUTE FUNCTION aiqsa_temporary_chat_delete_guard();

CREATE CONSTRAINT TRIGGER "Chat_temporary_obligation_guard" AFTER INSERT OR DELETE OR UPDATE ON "Chat" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_temporary_chat_obligation_trigger();

CREATE TRIGGER "ChatMemoryCheckpoint_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "ChatMemoryCheckpoint" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE CONSTRAINT TRIGGER "ChatMemoryCheckpoint_source_guard" AFTER INSERT OR DELETE OR UPDATE ON "ChatMemoryCheckpoint" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_history_source_trigger();

CREATE TRIGGER aiqsa_protect_full_access_group BEFORE DELETE OR UPDATE ON "Group" FOR EACH ROW EXECUTE FUNCTION aiqsa_protect_full_access_group();

CREATE TRIGGER aiqsa_grant_full_access_to_new_mcp_server AFTER INSERT ON "McpServer" FOR EACH ROW EXECUTE FUNCTION aiqsa_grant_full_access_to_new_mcp_server();

CREATE TRIGGER "MemoryCandidate_authority_trigger" BEFORE INSERT OR UPDATE OF "userId", "jobId", "chatId", "branchGeneration", "sourceRevision", "sourceHash", "createdByExecutionId", "pipelineVersion" ON "MemoryCandidate" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_authority_trigger();

CREATE CONSTRAINT TRIGGER "MemoryCandidate_evidence_trigger" AFTER INSERT OR UPDATE OF state, "contentPurgedAt" ON "MemoryCandidate" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_evidence_trigger();

CREATE TRIGGER "MemoryCandidate_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryCandidate" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryCandidateDecision_authority_trigger" BEFORE INSERT OR UPDATE ON "MemoryCandidateDecision" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_decision_authority_trigger();

CREATE TRIGGER "MemoryCandidateDecision_immutable_trigger" BEFORE UPDATE ON "MemoryCandidateDecision" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_decision_immutable_trigger();

CREATE TRIGGER "MemoryCandidateMessage_authority_trigger" BEFORE INSERT OR UPDATE OF "userId", "candidateId", "chatId", "messageId" ON "MemoryCandidateMessage" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_message_authority_trigger();

CREATE CONSTRAINT TRIGGER "MemoryCandidateMessage_evidence_trigger" AFTER INSERT OR DELETE OR UPDATE ON "MemoryCandidateMessage" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_evidence_trigger();

CREATE TRIGGER "MemoryDeletionOutbox_admission_immutable_guard" BEFORE UPDATE ON "MemoryDeletionOutbox" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_deletion_admission_immutable_guard();

CREATE CONSTRAINT TRIGGER "MemoryDeletionOutbox_temporary_chat_guard" AFTER INSERT OR DELETE OR UPDATE ON "MemoryDeletionOutbox" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_temporary_chat_obligation_trigger();

CREATE TRIGGER "MemoryEvent_deleted_source_guard" BEFORE UPDATE ON "MemoryEvent" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_event_deleted_source_guard();

CREATE TRIGGER "MemoryEvent_permanent_chat_source_write_guard" BEFORE INSERT OR UPDATE OF "sourceChatId" ON "MemoryEvent" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_write_guard();

CREATE TRIGGER "MemoryEvidence_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryEvidence" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryExecutionBinding_candidate_authority_trigger" BEFORE UPDATE OF "ownerType", "logicalRole", state, "acceptedOutputHash", "relationsDetachedAt" ON "MemoryExecutionBinding" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_protect_candidate_execution_trigger();

CREATE CONSTRAINT TRIGGER "MemoryFact_pointer_state_guard" AFTER INSERT OR UPDATE ON "MemoryFact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_fact_pointer_trigger();

CREATE CONSTRAINT TRIGGER "MemoryFact_scope_availability_check" AFTER INSERT OR UPDATE ON "MemoryFact" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_assert_scope_fact_availability();

CREATE TRIGGER "MemoryFact_scope_identity_guard" BEFORE UPDATE OF "scopeId" ON "MemoryFact" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_fact_scope_guard();

CREATE CONSTRAINT TRIGGER "MemoryFactVersion_pointer_state_guard" AFTER INSERT OR DELETE OR UPDATE ON "MemoryFactVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_fact_pointer_trigger();

CREATE TRIGGER "MemoryFeedback_append_only_guard" BEFORE UPDATE ON "MemoryFeedback" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_feedback_guard();

CREATE TRIGGER "MemoryFeedback_permanent_source_write_guard" BEFORE INSERT OR UPDATE OF "sourceChatIdSnapshot" ON "MemoryFeedback" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_snapshot_write_guard();

CREATE TRIGGER "MemoryFeedback_target_guard" BEFORE INSERT ON "MemoryFeedback" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_feedback_target_guard();

CREATE CONSTRAINT TRIGGER "MemoryIndexGeneration_active_pointer_guard" AFTER INSERT OR DELETE OR UPDATE ON "MemoryIndexGeneration" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_active_generation_trigger();

CREATE TRIGGER "MemoryIndexGeneration_configuration_guard" BEFORE UPDATE ON "MemoryIndexGeneration" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_generation_immutable();

CREATE TRIGGER "MemoryJob_candidate_authority_trigger" BEFORE UPDATE OF kind, "pipelineVersion" ON "MemoryJob" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_protect_candidate_job_trigger();

CREATE TRIGGER "MemoryJob_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryJob" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryMutationAuthorization_permanent_chat_source_write_guard" BEFORE INSERT OR UPDATE OF "sourceChatId" ON "MemoryMutationAuthorization" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_write_guard();

CREATE TRIGGER "MemoryRecallChunk_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryRecallChunk" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE CONSTRAINT TRIGGER "MemoryRecallChunk_source_guard" AFTER INSERT OR DELETE OR UPDATE ON "MemoryRecallChunk" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_history_source_trigger();

CREATE CONSTRAINT TRIGGER "MemoryAttempt_final_binding_guard" AFTER INSERT OR DELETE OR UPDATE ON "MemoryRetrievalAttempt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_binding_trigger();

CREATE TRIGGER "MemoryRetrievalAttempt_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryRetrievalAttempt" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE CONSTRAINT TRIGGER "MemoryRetrievalAttempt_run_guard" AFTER INSERT OR DELETE OR UPDATE ON "MemoryRetrievalAttempt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_preparation_trigger();

CREATE TRIGGER "MemoryRetrievalAttemptItem_permanent_source_write_guard" BEFORE INSERT OR UPDATE OF "sourceChatIdSnapshot" ON "MemoryRetrievalAttemptItem" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_snapshot_write_guard();

CREATE CONSTRAINT TRIGGER "MemoryScope_fact_availability_check" AFTER INSERT OR UPDATE ON "MemoryScope" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_assert_scope_fact_availability();

CREATE TRIGGER "MemoryScope_identity_guard" BEFORE UPDATE ON "MemoryScope" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_scope_guard();

CREATE TRIGGER "MemoryScope_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryScope" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemorySearchEntry_vector_guard" BEFORE INSERT OR UPDATE ON "MemorySearchEntry" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_search_entry_guard();

CREATE TRIGGER "MemorySuppression_permanent_chat_source_write_guard" BEFORE INSERT OR UPDATE OF "sourceChatId" ON "MemorySuppression" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_write_guard();

CREATE TRIGGER "Message_memory_candidate_authority_trigger" BEFORE UPDATE OF role, status ON "Message" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_protect_candidate_message_trigger();

CREATE TRIGGER "Message_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "Message" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE CONSTRAINT TRIGGER "Message_temporary_obligation_guard" AFTER INSERT OR DELETE OR UPDATE ON "Message" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_temporary_chat_obligation_trigger();

CREATE CONSTRAINT TRIGGER "ModelRun_memory_binding_guard" AFTER INSERT OR UPDATE ON "ModelRun" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_binding_trigger();

CREATE CONSTRAINT TRIGGER "ModelRun_memory_preparation_guard" AFTER INSERT OR UPDATE ON "ModelRun" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_preparation_trigger();

CREATE TRIGGER "ModelRun_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "ModelRun" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE CONSTRAINT TRIGGER "ModelRunMemoryBinding_final_guard" AFTER INSERT OR DELETE OR UPDATE ON "ModelRunMemoryBinding" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_binding_trigger();

CREATE TRIGGER "ModelRunMemoryItem_permanent_source_write_guard" BEFORE INSERT OR UPDATE OF "sourceChatIdSnapshot" ON "ModelRunMemoryItem" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_snapshot_write_guard();

CREATE TRIGGER "ModelRunMemoryItem_target_guard" BEFORE INSERT OR UPDATE ON "ModelRunMemoryItem" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_model_run_item_target_guard();

CREATE TRIGGER "SharedChatSnapshot_permanent_chat_write_guard" BEFORE INSERT OR UPDATE OF "chatId" ON "SharedChatSnapshot" FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "User_memory_settings_default" AFTER INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_create_default_settings();

CREATE CONSTRAINT TRIGGER "UserMemorySettings_active_generation_guard" AFTER INSERT OR DELETE OR UPDATE ON "UserMemorySettings" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_active_generation_trigger();
