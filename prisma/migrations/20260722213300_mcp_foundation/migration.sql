-- Add the compact ADR 0021 persistence foundation. MCP definitions remain
-- administrator-owned, while runtime rows are disposable observed state.

CREATE TYPE "McpOAuthConnectionState" AS ENUM (
  'ready',
  'reauthorization_required',
  'disconnecting',
  'disconnected'
);

CREATE TYPE "McpOAuthPurpose" AS ENUM ('user', 'validation');

CREATE TYPE "McpRuntimeState" AS ENUM (
  'starting',
  'ready',
  'failed',
  'idle',
  'stopping'
);

CREATE TYPE "ModelRunToolCallState" AS ENUM (
  'pending',
  'running',
  'complete',
  'error',
  'cancelled'
);

ALTER TABLE "ModelRun"
ADD COLUMN "toolLoopState" JSONB;

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

  CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpServer_shared_config_version_check"
    CHECK ("sharedConfigVersion" >= 0)
);

CREATE TABLE "McpRevision" (
  "id" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "configuration" JSONB NOT NULL,
  "resolvedArtifact" JSONB,
  "validationEvidence" JSONB NOT NULL,
  "draftHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "McpRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpRevision_revision_number_check"
    CHECK ("revisionNumber" > 0)
);

CREATE TABLE "McpGrant" (
  "id" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT,
  "groupId" TEXT,
  "canUse" BOOLEAN NOT NULL DEFAULT false,
  "personalSlotKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "McpGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpGrant_subject_check"
    CHECK (num_nonnulls("userId", "groupId") = 1),
  CONSTRAINT "McpGrant_group_personal_slots_check"
    CHECK ("groupId" IS NULL OR cardinality("personalSlotKeys") = 0),
  CONSTRAINT "McpGrant_permission_check"
    CHECK ("canUse" OR cardinality("personalSlotKeys") > 0)
);

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

  CONSTRAINT "McpUserServer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpUserServer_personal_config_version_check"
    CHECK ("personalConfigVersion" >= 0)
);

CREATE TABLE "McpOAuthClient" (
  "id" TEXT NOT NULL,
  "registrationKey" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientMetadata" JSONB NOT NULL,
  "clientSecretEnvelope" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpOAuthConnection" (
  "id" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "oauthClientId" TEXT,
  "purpose" "McpOAuthPurpose" NOT NULL,
  "policyFingerprint" TEXT NOT NULL,
  "state" "McpOAuthConnectionState" NOT NULL DEFAULT 'ready',
  "tokenEnvelope" TEXT,
  "externalAccountLabel" TEXT,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3),
  "disconnectRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "McpOAuthConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpRuntimeGeneration" (
  "id" TEXT NOT NULL,
  "userServerId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "oauthConnectionId" TEXT,
  "fingerprint" TEXT NOT NULL,
  "effectiveConfigEnvelope" TEXT,
  "runtimeHandle" JSONB,
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

  CONSTRAINT "McpRuntimeGeneration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpRuntimeGeneration_attempt_count_check"
    CHECK ("attemptCount" >= 0)
);

CREATE TABLE "McpRunBinding" (
  "id" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "runtimeGenerationId" TEXT,
  "runtimeGenerationFingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "McpRunBinding_pkey" PRIMARY KEY ("id")
);

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

  CONSTRAINT "ModelRunToolCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ModelRunToolCall_position_check"
    CHECK ("roundIndex" >= 0 AND "ordinal" >= 0)
);

CREATE UNIQUE INDEX "McpServer_namespace_key"
ON "McpServer"("namespace");
CREATE UNIQUE INDEX "McpServer_activeRevisionId_key"
ON "McpServer"("activeRevisionId");
CREATE INDEX "McpServer_enabled_archivedAt_idx"
ON "McpServer"("enabled", "archivedAt");

CREATE UNIQUE INDEX "McpRevision_serverId_revisionNumber_key"
ON "McpRevision"("serverId", "revisionNumber");
CREATE UNIQUE INDEX "McpRevision_serverId_draftHash_key"
ON "McpRevision"("serverId", "draftHash");
CREATE INDEX "McpRevision_serverId_createdAt_idx"
ON "McpRevision"("serverId", "createdAt");

CREATE UNIQUE INDEX "McpGrant_serverId_userId_key"
ON "McpGrant"("serverId", "userId");
CREATE UNIQUE INDEX "McpGrant_serverId_groupId_key"
ON "McpGrant"("serverId", "groupId");
CREATE INDEX "McpGrant_groupId_idx" ON "McpGrant"("groupId");
CREATE INDEX "McpGrant_userId_idx" ON "McpGrant"("userId");

CREATE UNIQUE INDEX "McpUserServer_desiredRuntimeGenerationId_key"
ON "McpUserServer"("desiredRuntimeGenerationId");
CREATE UNIQUE INDEX "McpUserServer_userId_serverId_key"
ON "McpUserServer"("userId", "serverId");
CREATE INDEX "McpUserServer_userId_enabled_idx"
ON "McpUserServer"("userId", "enabled");

CREATE UNIQUE INDEX "McpOAuthClient_registrationKey_key"
ON "McpOAuthClient"("registrationKey");

CREATE INDEX "McpOAuthConnection_oauthClientId_idx"
ON "McpOAuthConnection"("oauthClientId");
CREATE INDEX "McpOAuthConnection_serverId_userId_purpose_state_idx"
ON "McpOAuthConnection"("serverId", "userId", "purpose", "state");

CREATE UNIQUE INDEX "McpRuntimeGeneration_fingerprint_key"
ON "McpRuntimeGeneration"("fingerprint");
CREATE INDEX "McpRuntimeGeneration_oauthConnectionId_idx"
ON "McpRuntimeGeneration"("oauthConnectionId");
CREATE INDEX "McpRuntimeGeneration_revisionId_idx"
ON "McpRuntimeGeneration"("revisionId");
CREATE INDEX "McpRuntimeGeneration_state_retryAt_idx"
ON "McpRuntimeGeneration"("state", "retryAt");
CREATE INDEX "McpRuntimeGeneration_userServerId_idx"
ON "McpRuntimeGeneration"("userServerId");

CREATE UNIQUE INDEX "McpRunBinding_modelRunId_runtimeGenerationFingerprint_key"
ON "McpRunBinding"("modelRunId", "runtimeGenerationFingerprint");
CREATE INDEX "McpRunBinding_runtimeGenerationId_idx"
ON "McpRunBinding"("runtimeGenerationId");

CREATE UNIQUE INDEX "ModelRunToolCall_modelRunId_roundIndex_providerCallId_key"
ON "ModelRunToolCall"("modelRunId", "roundIndex", "providerCallId");
CREATE UNIQUE INDEX "ModelRunToolCall_modelRunId_roundIndex_ordinal_key"
ON "ModelRunToolCall"("modelRunId", "roundIndex", "ordinal");
CREATE INDEX "ModelRunToolCall_mcpRunBindingId_idx"
ON "ModelRunToolCall"("mcpRunBindingId");
CREATE INDEX "ModelRunToolCall_modelRunId_state_idx"
ON "ModelRunToolCall"("modelRunId", "state");

ALTER TABLE "McpServer"
ADD CONSTRAINT "McpServer_activeRevisionId_fkey"
FOREIGN KEY ("activeRevisionId") REFERENCES "McpRevision"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "McpRevision"
ADD CONSTRAINT "McpRevision_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "McpServer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "McpGrant"
ADD CONSTRAINT "McpGrant_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "McpServer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpGrant"
ADD CONSTRAINT "McpGrant_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpGrant"
ADD CONSTRAINT "McpGrant_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "Group"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "McpUserServer"
ADD CONSTRAINT "McpUserServer_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "McpServer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpUserServer"
ADD CONSTRAINT "McpUserServer_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "McpOAuthConnection"
ADD CONSTRAINT "McpOAuthConnection_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "McpServer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpOAuthConnection"
ADD CONSTRAINT "McpOAuthConnection_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpOAuthConnection"
ADD CONSTRAINT "McpOAuthConnection_oauthClientId_fkey"
FOREIGN KEY ("oauthClientId") REFERENCES "McpOAuthClient"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "McpRuntimeGeneration"
ADD CONSTRAINT "McpRuntimeGeneration_userServerId_fkey"
FOREIGN KEY ("userServerId") REFERENCES "McpUserServer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpRuntimeGeneration"
ADD CONSTRAINT "McpRuntimeGeneration_revisionId_fkey"
FOREIGN KEY ("revisionId") REFERENCES "McpRevision"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "McpRuntimeGeneration"
ADD CONSTRAINT "McpRuntimeGeneration_oauthConnectionId_fkey"
FOREIGN KEY ("oauthConnectionId") REFERENCES "McpOAuthConnection"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "McpUserServer"
ADD CONSTRAINT "McpUserServer_desiredRuntimeGenerationId_fkey"
FOREIGN KEY ("desiredRuntimeGenerationId") REFERENCES "McpRuntimeGeneration"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "McpRunBinding"
ADD CONSTRAINT "McpRunBinding_modelRunId_fkey"
FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpRunBinding"
ADD CONSTRAINT "McpRunBinding_runtimeGenerationId_fkey"
FOREIGN KEY ("runtimeGenerationId") REFERENCES "McpRuntimeGeneration"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModelRunToolCall"
ADD CONSTRAINT "ModelRunToolCall_modelRunId_fkey"
FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelRunToolCall"
ADD CONSTRAINT "ModelRunToolCall_mcpRunBindingId_fkey"
FOREIGN KEY ("mcpRunBindingId") REFERENCES "McpRunBinding"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
