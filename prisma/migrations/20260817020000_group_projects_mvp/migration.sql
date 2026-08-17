CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETING');
CREATE TYPE "ProjectRole" AS ENUM ('VIEWER', 'CONTRIBUTOR', 'MANAGER', 'OWNER');
CREATE TYPE "ProjectMemoryFactState" AS ENUM ('ACTIVE', 'FORGOTTEN');
CREATE TYPE "ProjectMemoryProposalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "AttachmentProcessingJob"
  DROP CONSTRAINT "AttachmentProcessingJob_attachment_owner_fkey";

ALTER TABLE "Attachment"
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "uploaderDisplayName" TEXT,
  ADD COLUMN "uploaderUserId" TEXT,
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "Chat"
  ADD COLUMN "createdByDisplayName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "projectFolderId" TEXT,
  ADD COLUMN "projectId" TEXT,
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "Message"
  ADD COLUMN "authorDisplayName" TEXT,
  ADD COLUMN "authorProjectRole" "ProjectRole",
  ADD COLUMN "authorUserId" TEXT;

ALTER TABLE "SharedChatSnapshot"
  ADD COLUMN "createdByDisplayName" TEXT,
  ADD COLUMN "projectId" TEXT,
  ALTER COLUMN "ownerUserId" DROP NOT NULL;

ALTER TABLE "UsageEvent" ADD COLUMN "projectId" TEXT;

-- A run initiator owns a personal chat, but merely participates in a Project
-- chat. Replace the legacy personal-only composite FK with a deferred boundary
-- assertion once ProjectRunBinding exists below; the ordinary chatId FK still
-- owns run lifecycle cascading.
ALTER TABLE "ModelRun" DROP CONSTRAINT "ModelRun_user_chat_memory_fkey";
-- Project runs outlive the initiating account. Personal runs still disappear
-- through Chat -> ModelRun cascading when their personal owner is deleted.
ALTER TABLE "ModelRun" DROP CONSTRAINT "ModelRun_userId_fkey";

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
  "instructions" TEXT NOT NULL DEFAULT '',
  "instructionsRevision" INTEGER NOT NULL DEFAULT 1,
  "policy" JSONB NOT NULL DEFAULT '{}',
  "policyRevision" INTEGER NOT NULL DEFAULT 1,
  "defaults" JSONB NOT NULL DEFAULT '{}',
  "accessRevision" INTEGER NOT NULL DEFAULT 1,
  "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
  "memoryPolicy" JSONB NOT NULL DEFAULT '{"automatic":"OFF"}',
  "memoryRevision" INTEGER NOT NULL DEFAULT 0,
  "publicSharingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" TEXT,
  "createdByDisplayName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "deletionRequestedAt" TIMESTAMP(3),
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectGrant" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT,
  "groupId" TEXT,
  "role" "ProjectRole" NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectFolder" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "parentId" TEXT,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectFolder_pkey" PRIMARY KEY ("projectId", "id")
);

CREATE TABLE "ProjectModelBinding" (
  "projectId" TEXT NOT NULL,
  "providerModelId" TEXT NOT NULL,
  "addedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectModelBinding_pkey" PRIMARY KEY ("projectId", "providerModelId")
);

CREATE TABLE "ProjectSearchBinding" (
  "projectId" TEXT NOT NULL,
  "searchOptionId" TEXT NOT NULL,
  "addedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectSearchBinding_pkey" PRIMARY KEY ("projectId", "searchOptionId")
);

CREATE TABLE "ProjectMcpBinding" (
  "projectId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "addedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMcpBinding_pkey" PRIMARY KEY ("projectId", "serverId")
);

CREATE TABLE "ProjectKnowledgeBaseBinding" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "addedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectKnowledgeBaseBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectAssistantBinding" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "assistantId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "addedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectAssistantBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectAuditEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorDisplayName" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectMemoryFact" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "currentVersionId" TEXT,
  "state" "ProjectMemoryFactState" NOT NULL DEFAULT 'ACTIVE',
  "createdByUserId" TEXT,
  "createdByDisplayName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectMemoryFact_pkey" PRIMARY KEY ("projectId", "id")
);

CREATE TABLE "ProjectMemoryFactVersion" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "validUntil" TIMESTAMP(3),
  "sourceMessageId" TEXT,
  "sourceSnapshot" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "createdByDisplayName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMemoryFactVersion_pkey" PRIMARY KEY ("projectId", "factId", "id")
);

CREATE TABLE "ProjectMemoryProposal" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "proposedText" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "sourceMessageId" TEXT,
  "sourceSnapshot" JSONB NOT NULL DEFAULT '{}',
  "state" "ProjectMemoryProposalState" NOT NULL DEFAULT 'PENDING',
  "proposedByUserId" TEXT,
  "proposedByDisplayName" TEXT NOT NULL,
  "reviewedByUserId" TEXT,
  "reviewedByDisplayName" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "resultingFactId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectMemoryProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectRunBinding" (
  "modelRunId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "initiatorUserId" TEXT NOT NULL,
  "acceptedRole" "ProjectRole" NOT NULL,
  "accessRevision" INTEGER NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "instructionsRevision" INTEGER NOT NULL,
  "memoryRevision" INTEGER NOT NULL,
  "personalMemoryDisabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectRunBinding_pkey" PRIMARY KEY ("modelRunId")
);

CREATE TABLE "ProjectMemoryRunItem" (
  "projectId" TEXT NOT NULL,
  "projectRunBindingId" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "factVersionId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "includedText" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMemoryRunItem_pkey" PRIMARY KEY ("projectRunBindingId", "factId")
);

CREATE INDEX "Project_createdByUserId_idx" ON "Project"("createdByUserId");
CREATE INDEX "Project_status_updatedAt_idx" ON "Project"("status", "updatedAt");
CREATE INDEX "ProjectGrant_createdByUserId_idx" ON "ProjectGrant"("createdByUserId");
CREATE INDEX "ProjectGrant_groupId_projectId_idx" ON "ProjectGrant"("groupId", "projectId");
CREATE INDEX "ProjectGrant_userId_projectId_idx" ON "ProjectGrant"("userId", "projectId");
CREATE UNIQUE INDEX "ProjectGrant_projectId_userId_key" ON "ProjectGrant"("projectId", "userId");
CREATE UNIQUE INDEX "ProjectGrant_projectId_groupId_key" ON "ProjectGrant"("projectId", "groupId");
CREATE INDEX "ProjectFolder_createdByUserId_idx" ON "ProjectFolder"("createdByUserId");
CREATE INDEX "ProjectFolder_projectId_parentId_sortOrder_idx" ON "ProjectFolder"("projectId", "parentId", "sortOrder");
CREATE UNIQUE INDEX "ProjectFolder_projectId_parentId_name_key" ON "ProjectFolder"("projectId", "parentId", "name") NULLS NOT DISTINCT;
CREATE INDEX "ProjectModelBinding_addedByUserId_idx" ON "ProjectModelBinding"("addedByUserId");
CREATE INDEX "ProjectModelBinding_providerModelId_idx" ON "ProjectModelBinding"("providerModelId");
CREATE INDEX "ProjectSearchBinding_addedByUserId_idx" ON "ProjectSearchBinding"("addedByUserId");
CREATE INDEX "ProjectSearchBinding_searchOptionId_idx" ON "ProjectSearchBinding"("searchOptionId");
CREATE INDEX "ProjectMcpBinding_addedByUserId_idx" ON "ProjectMcpBinding"("addedByUserId");
CREATE INDEX "ProjectMcpBinding_serverId_idx" ON "ProjectMcpBinding"("serverId");
CREATE INDEX "ProjectKnowledgeBaseBinding_addedByUserId_idx" ON "ProjectKnowledgeBaseBinding"("addedByUserId");
CREATE INDEX "ProjectKnowledgeBaseBinding_knowledgeBaseId_idx" ON "ProjectKnowledgeBaseBinding"("knowledgeBaseId");
CREATE UNIQUE INDEX "ProjectKnowledgeBaseBinding_projectId_knowledgeBaseId_key" ON "ProjectKnowledgeBaseBinding"("projectId", "knowledgeBaseId");
CREATE INDEX "ProjectAssistantBinding_addedByUserId_idx" ON "ProjectAssistantBinding"("addedByUserId");
CREATE INDEX "ProjectAssistantBinding_assistantId_revisionId_idx" ON "ProjectAssistantBinding"("assistantId", "revisionId");
CREATE UNIQUE INDEX "ProjectAssistantBinding_projectId_assistantId_key" ON "ProjectAssistantBinding"("projectId", "assistantId");
CREATE INDEX "ProjectAuditEvent_actorUserId_idx" ON "ProjectAuditEvent"("actorUserId");
CREATE INDEX "ProjectAuditEvent_projectId_createdAt_id_idx" ON "ProjectAuditEvent"("projectId", "createdAt", "id");
CREATE UNIQUE INDEX "ProjectMemoryFact_currentVersionId_key" ON "ProjectMemoryFact"("currentVersionId");
CREATE INDEX "ProjectMemoryFact_createdByUserId_idx" ON "ProjectMemoryFact"("createdByUserId");
CREATE INDEX "ProjectMemoryFact_projectId_state_updatedAt_idx" ON "ProjectMemoryFact"("projectId", "state", "updatedAt");
CREATE UNIQUE INDEX "ProjectMemoryFact_projectId_id_currentVersionId_key" ON "ProjectMemoryFact"("projectId", "id", "currentVersionId");
CREATE INDEX "ProjectMemoryFactVersion_createdByUserId_idx" ON "ProjectMemoryFactVersion"("createdByUserId");
CREATE INDEX "ProjectMemoryFactVersion_projectId_createdAt_idx" ON "ProjectMemoryFactVersion"("projectId", "createdAt");
CREATE UNIQUE INDEX "ProjectMemoryFactVersion_projectId_factId_versionNumber_key" ON "ProjectMemoryFactVersion"("projectId", "factId", "versionNumber");
CREATE INDEX "ProjectMemoryProposal_projectId_state_createdAt_idx" ON "ProjectMemoryProposal"("projectId", "state", "createdAt");
CREATE INDEX "ProjectMemoryProposal_proposedByUserId_idx" ON "ProjectMemoryProposal"("proposedByUserId");
CREATE INDEX "ProjectMemoryProposal_reviewedByUserId_idx" ON "ProjectMemoryProposal"("reviewedByUserId");
CREATE INDEX "ProjectRunBinding_initiatorUserId_idx" ON "ProjectRunBinding"("initiatorUserId");
CREATE INDEX "ProjectRunBinding_projectId_createdAt_idx" ON "ProjectRunBinding"("projectId", "createdAt");
CREATE UNIQUE INDEX "ProjectRunBinding_projectId_modelRunId_key" ON "ProjectRunBinding"("projectId", "modelRunId");
CREATE INDEX "ProjectMemoryRunItem_projectId_factId_factVersionId_idx" ON "ProjectMemoryRunItem"("projectId", "factId", "factVersionId");
CREATE UNIQUE INDEX "ProjectMemoryRunItem_projectRunBindingId_ordinal_key" ON "ProjectMemoryRunItem"("projectRunBindingId", "ordinal");
CREATE INDEX "Attachment_projectId_createdAt_idx" ON "Attachment"("projectId", "createdAt");
CREATE INDEX "Attachment_uploaderUserId_idx" ON "Attachment"("uploaderUserId");
CREATE INDEX "Chat_projectId_archived_updatedAt_idx" ON "Chat"("projectId", "archived", "updatedAt");
CREATE INDEX "Chat_projectFolderId_idx" ON "Chat"("projectFolderId");
CREATE INDEX "Message_authorUserId_idx" ON "Message"("authorUserId");
CREATE INDEX "SharedChatSnapshot_projectId_createdAt_idx" ON "SharedChatSnapshot"("projectId", "createdAt");
CREATE INDEX "UsageEvent_projectId_createdAt_idx" ON "UsageEvent"("projectId", "createdAt");

ALTER TABLE "Chat" ADD CONSTRAINT "Chat_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_projectId_projectFolderId_fkey" FOREIGN KEY ("projectId", "projectFolderId") REFERENCES "ProjectFolder"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderUserId_fkey" FOREIGN KEY ("uploaderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttachmentProcessingJob" ADD CONSTRAINT "AttachmentProcessingJob_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "SharedChatSnapshot" ADD CONSTRAINT "SharedChatSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectFolder" ADD CONSTRAINT "ProjectFolder_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectFolder" ADD CONSTRAINT "ProjectFolder_projectId_parentId_fkey" FOREIGN KEY ("projectId", "parentId") REFERENCES "ProjectFolder"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProjectFolder" ADD CONSTRAINT "ProjectFolder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectModelBinding" ADD CONSTRAINT "ProjectModelBinding_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectModelBinding" ADD CONSTRAINT "ProjectModelBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectModelBinding" ADD CONSTRAINT "ProjectModelBinding_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectSearchBinding" ADD CONSTRAINT "ProjectSearchBinding_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectSearchBinding" ADD CONSTRAINT "ProjectSearchBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectSearchBinding" ADD CONSTRAINT "ProjectSearchBinding_searchOptionId_fkey" FOREIGN KEY ("searchOptionId") REFERENCES "SearchOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpBinding" ADD CONSTRAINT "ProjectMcpBinding_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpBinding" ADD CONSTRAINT "ProjectMcpBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMcpBinding" ADD CONSTRAINT "ProjectMcpBinding_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectKnowledgeBaseBinding" ADD CONSTRAINT "ProjectKnowledgeBaseBinding_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectKnowledgeBaseBinding" ADD CONSTRAINT "ProjectKnowledgeBaseBinding_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectKnowledgeBaseBinding" ADD CONSTRAINT "ProjectKnowledgeBaseBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAssistantBinding" ADD CONSTRAINT "ProjectAssistantBinding_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectAssistantBinding" ADD CONSTRAINT "ProjectAssistantBinding_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectAssistantBinding" ADD CONSTRAINT "ProjectAssistantBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAssistantBinding" ADD CONSTRAINT "ProjectAssistantBinding_assistantId_revisionId_fkey" FOREIGN KEY ("assistantId", "revisionId") REFERENCES "AssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProjectAuditEvent" ADD CONSTRAINT "ProjectAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectAuditEvent" ADD CONSTRAINT "ProjectAuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryFact" ADD CONSTRAINT "ProjectMemoryFact_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryFact" ADD CONSTRAINT "ProjectMemoryFact_projectId_id_currentVersionId_fkey" FOREIGN KEY ("projectId", "id", "currentVersionId") REFERENCES "ProjectMemoryFactVersion"("projectId", "factId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProjectMemoryFact" ADD CONSTRAINT "ProjectMemoryFact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryFactVersion" ADD CONSTRAINT "ProjectMemoryFactVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryFactVersion" ADD CONSTRAINT "ProjectMemoryFactVersion_projectId_factId_fkey" FOREIGN KEY ("projectId", "factId") REFERENCES "ProjectMemoryFact"("projectId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ProjectMemoryFactVersion" ADD CONSTRAINT "ProjectMemoryFactVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryProposal" ADD CONSTRAINT "ProjectMemoryProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryProposal" ADD CONSTRAINT "ProjectMemoryProposal_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryProposal" ADD CONSTRAINT "ProjectMemoryProposal_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryProposal" ADD CONSTRAINT "ProjectMemoryProposal_projectId_resultingFactId_fkey" FOREIGN KEY ("projectId", "resultingFactId") REFERENCES "ProjectMemoryFact"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProjectRunBinding" ADD CONSTRAINT "ProjectRunBinding_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectRunBinding" ADD CONSTRAINT "ProjectRunBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectMemoryRunItem" ADD CONSTRAINT "ProjectMemoryRunItem_projectId_projectRunBindingId_fkey" FOREIGN KEY ("projectId", "projectRunBindingId") REFERENCES "ProjectRunBinding"("projectId", "modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ProjectMemoryRunItem" ADD CONSTRAINT "ProjectMemoryRunItem_projectId_factId_fkey" FOREIGN KEY ("projectId", "factId") REFERENCES "ProjectMemoryFact"("projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProjectMemoryRunItem" ADD CONSTRAINT "ProjectMemoryRunItem_projectId_factId_factVersionId_fkey" FOREIGN KEY ("projectId", "factId", "factVersionId") REFERENCES "ProjectMemoryFactVersion"("projectId", "factId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ProjectMemoryRunItem" ADD CONSTRAINT "ProjectMemoryRunItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Project" ADD CONSTRAINT "Project_shape_check" CHECK (
  char_length(btrim("name")) BETWEEN 1 AND 120
  AND char_length("description") <= 2000
  AND char_length("instructions") <= 32000
  AND "instructionsRevision" >= 1
  AND "policyRevision" >= 1
  AND "accessRevision" >= 1
  AND "memoryRevision" >= 0
  AND (("status" = 'ACTIVE' AND "archivedAt" IS NULL AND "deletionRequestedAt" IS NULL)
    OR ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL AND "deletionRequestedAt" IS NULL)
    OR ("status" = 'DELETING' AND "deletionRequestedAt" IS NOT NULL))
);
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_principal_check" CHECK (num_nonnulls("userId", "groupId") = 1);
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_group_role_check" CHECK ("groupId" IS NULL OR "role" <> 'OWNER');
ALTER TABLE "ProjectFolder" ADD CONSTRAINT "ProjectFolder_shape_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120 AND "parentId" IS DISTINCT FROM "id");
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_owner_boundary_check" CHECK (
  num_nonnulls("userId", "projectId") = 1
  AND ("projectId" IS NULL OR (
    "folderId" IS NULL
    AND "memoryMode" = 'EXCLUDED'
    AND "permanentDeletionAt" IS NULL
    AND "permanentDeletionOperationId" IS NULL
    AND "temporaryRetentionPolicyVersion" IS NULL
    AND "temporaryRetentionDeadline" IS NULL
    AND "createdByDisplayName" <> ''
  ))
  AND ("projectId" IS NOT NULL OR "projectFolderId" IS NULL)
);
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_owner_boundary_check" CHECK (
  num_nonnulls("userId", "projectId") = 1
  AND ("projectId" IS NULL OR "uploaderDisplayName" IS NOT NULL)
);
ALTER TABLE "SharedChatSnapshot" ADD CONSTRAINT "SharedChatSnapshot_owner_boundary_check" CHECK (num_nonnulls("ownerUserId", "projectId") = 1);
ALTER TABLE "ProjectMemoryFactVersion" ADD CONSTRAINT "ProjectMemoryFactVersion_shape_check" CHECK (
  "versionNumber" >= 1 AND char_length(btrim("text")) BETWEEN 1 AND 4000
  AND char_length("normalizedText") BETWEEN 1 AND 4000
);
ALTER TABLE "ProjectMemoryProposal" ADD CONSTRAINT "ProjectMemoryProposal_shape_check" CHECK (
  char_length(btrim("proposedText")) BETWEEN 1 AND 4000
  AND char_length("normalizedText") BETWEEN 1 AND 4000
  AND (("state" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedByDisplayName" IS NULL AND "resultingFactId" IS NULL)
    OR ("state" = 'APPROVED' AND "reviewedAt" IS NOT NULL AND "reviewedByDisplayName" IS NOT NULL AND "resultingFactId" IS NOT NULL)
    OR ("state" = 'REJECTED' AND "reviewedAt" IS NOT NULL AND "reviewedByDisplayName" IS NOT NULL AND "resultingFactId" IS NULL))
);
ALTER TABLE "ProjectRunBinding" ADD CONSTRAINT "ProjectRunBinding_shape_check" CHECK (
  "personalMemoryDisabled" = true AND "accessRevision" >= 1
  AND "policyRevision" >= 1 AND "instructionsRevision" >= 1 AND "memoryRevision" >= 0
);
ALTER TABLE "ProjectMemoryRunItem" ADD CONSTRAINT "ProjectMemoryRunItem_shape_check" CHECK ("ordinal" >= 0 AND char_length("includedText") BETWEEN 1 AND 4000);

CREATE OR REPLACE FUNCTION aiqsa_assert_project_active_owner(p_project_id TEXT)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Project"
    WHERE "id" = p_project_id AND "status" <> 'DELETING'
  ) AND NOT EXISTS (
    SELECT 1
    FROM "ProjectGrant" AS grant_row
    INNER JOIN "User" AS owner ON owner."id" = grant_row."userId"
    WHERE grant_row."projectId" = p_project_id
      AND grant_row."groupId" IS NULL
      AND grant_row."role" = 'OWNER'
      AND owner."status" = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Project must retain an active direct owner';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_project_owner_constraint_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'ProjectGrant' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM aiqsa_assert_project_active_owner(OLD."projectId"); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM aiqsa_assert_project_active_owner(NEW."projectId"); END IF;
  ELSIF TG_TABLE_NAME = 'Project' THEN
    IF TG_OP <> 'DELETE' THEN PERFORM aiqsa_assert_project_active_owner(NEW."id"); END IF;
  ELSE
    IF TG_OP <> 'INSERT' AND OLD."status" = 'active' THEN
      PERFORM aiqsa_assert_project_active_owner(grant_row."projectId")
      FROM "ProjectGrant" AS grant_row
      WHERE grant_row."userId" = OLD."id" AND grant_row."role" = 'OWNER';
    END IF;
    IF TG_OP <> 'DELETE' AND NEW."status" <> 'active' THEN
      PERFORM aiqsa_assert_project_active_owner(grant_row."projectId")
      FROM "ProjectGrant" AS grant_row
      WHERE grant_row."userId" = NEW."id" AND grant_row."role" = 'OWNER';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "Project_owner_required"
AFTER INSERT OR UPDATE ON "Project" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_owner_constraint_trigger();
CREATE CONSTRAINT TRIGGER "ProjectGrant_owner_required"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectGrant" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_owner_constraint_trigger();
CREATE CONSTRAINT TRIGGER "User_project_owner_required"
AFTER UPDATE OF "status" OR DELETE ON "User" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_owner_constraint_trigger();

CREATE OR REPLACE FUNCTION aiqsa_assert_model_run_owner_boundary(p_model_run_id TEXT)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ModelRun" AS run_row
    INNER JOIN "Chat" AS chat_row ON chat_row."id" = run_row."chatId"
    WHERE run_row."id" = p_model_run_id
      AND NOT (
        (
          chat_row."projectId" IS NULL
          AND chat_row."userId" = run_row."userId"
          AND NOT EXISTS (
            SELECT 1 FROM "ProjectRunBinding" AS binding
            WHERE binding."modelRunId" = run_row."id"
          )
        )
        OR (
          chat_row."userId" IS NULL
          AND chat_row."projectId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "ProjectRunBinding" AS binding
            WHERE binding."modelRunId" = run_row."id"
              AND binding."projectId" = chat_row."projectId"
              AND binding."initiatorUserId" = run_row."userId"
              AND binding."personalMemoryDisabled" = TRUE
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ModelRun ownership must match its personal or Project chat boundary';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_model_run_owner_boundary_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM aiqsa_assert_model_run_owner_boundary(NEW."id");
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_project_run_binding_owner_boundary_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM aiqsa_assert_model_run_owner_boundary(OLD."modelRunId");
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM aiqsa_assert_model_run_owner_boundary(NEW."modelRunId");
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "ModelRun_owner_boundary"
AFTER INSERT OR UPDATE OF "chatId", "userId" ON "ModelRun" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_model_run_owner_boundary_trigger();
CREATE CONSTRAINT TRIGGER "ProjectRunBinding_owner_boundary"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectRunBinding" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_run_binding_owner_boundary_trigger();

CREATE OR REPLACE FUNCTION aiqsa_project_access_revision_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'ProjectGrant' THEN
    IF TG_OP <> 'INSERT' THEN UPDATE "Project" SET "accessRevision" = "accessRevision" + 1 WHERE "id" = OLD."projectId"; END IF;
    IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."projectId" IS DISTINCT FROM OLD."projectId") THEN
      UPDATE "Project" SET "accessRevision" = "accessRevision" + 1 WHERE "id" = NEW."projectId";
    END IF;
  ELSIF TG_TABLE_NAME = 'UserGroup' THEN
    IF TG_OP <> 'INSERT' THEN
      UPDATE "Project" SET "accessRevision" = "accessRevision" + 1
      WHERE "id" IN (SELECT "projectId" FROM "ProjectGrant" WHERE "groupId" = OLD."groupId");
    END IF;
    IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."groupId" IS DISTINCT FROM OLD."groupId" OR NEW."userId" IS DISTINCT FROM OLD."userId") THEN
      UPDATE "Project" SET "accessRevision" = "accessRevision" + 1
      WHERE "id" IN (SELECT "projectId" FROM "ProjectGrant" WHERE "groupId" = NEW."groupId");
    END IF;
  ELSIF TG_TABLE_NAME = 'Group' THEN
    IF NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt" THEN
      UPDATE "Project" SET "accessRevision" = "accessRevision" + 1
      WHERE "id" IN (SELECT "projectId" FROM "ProjectGrant" WHERE "groupId" = NEW."id");
    END IF;
  ELSE
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      UPDATE "Project" SET "accessRevision" = "accessRevision" + 1
      WHERE "id" IN (
        SELECT grant_row."projectId" FROM "ProjectGrant" AS grant_row
        WHERE grant_row."userId" = NEW."id"
           OR grant_row."groupId" IN (SELECT "groupId" FROM "UserGroup" WHERE "userId" = NEW."id")
      );
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "ProjectGrant_access_revision" AFTER INSERT OR UPDATE OR DELETE ON "ProjectGrant"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_access_revision_trigger();
CREATE TRIGGER "UserGroup_project_access_revision" AFTER INSERT OR UPDATE OR DELETE ON "UserGroup"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_access_revision_trigger();
CREATE TRIGGER "Group_project_access_revision" AFTER UPDATE OF "archivedAt" ON "Group"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_access_revision_trigger();
CREATE TRIGGER "User_project_access_revision" AFTER UPDATE OF "status" ON "User"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_access_revision_trigger();

CREATE OR REPLACE FUNCTION aiqsa_project_message_authorship_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE project_chat boolean;
BEGIN
  SELECT "projectId" IS NOT NULL INTO project_chat FROM "Chat" WHERE "id" = NEW."chatId";
  IF project_chat AND NEW."role" = 'user' AND (
    NEW."authorDisplayName" IS NULL OR NEW."authorProjectRole" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Project user message requires author attribution';
  END IF;
  IF (NOT project_chat OR NEW."role" <> 'user') AND num_nonnulls(NEW."authorUserId", NEW."authorDisplayName", NEW."authorProjectRole") <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Message author attribution is reserved for Project user messages';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Message_project_authorship" BEFORE INSERT OR UPDATE OF "chatId", "role", "authorUserId", "authorDisplayName", "authorProjectRole" ON "Message"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_message_authorship_guard();

CREATE OR REPLACE FUNCTION aiqsa_project_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = TG_TABLE_NAME || ' rows are immutable';
END;
$function$;
CREATE TRIGGER "ProjectRunBinding_immutable" BEFORE UPDATE ON "ProjectRunBinding"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_immutable_guard();
CREATE TRIGGER "ProjectMemoryRunItem_immutable" BEFORE UPDATE ON "ProjectMemoryRunItem"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_immutable_guard();
CREATE TRIGGER "ProjectMemoryFactVersion_immutable" BEFORE UPDATE ON "ProjectMemoryFactVersion"
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_immutable_guard();

CREATE OR REPLACE FUNCTION aiqsa_assert_project_memory_fact(p_project_id TEXT, p_fact_id TEXT)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE fact_row "ProjectMemoryFact"%ROWTYPE;
BEGIN
  SELECT * INTO fact_row FROM "ProjectMemoryFact"
  WHERE "projectId" = p_project_id AND "id" = p_fact_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF fact_row."state" = 'ACTIVE' AND (
    fact_row."currentVersionId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "ProjectMemoryFactVersion"
      WHERE "projectId" = p_project_id AND "factId" = p_fact_id
        AND "id" = fact_row."currentVersionId"
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Active Project Memory fact requires its current version';
  END IF;
  IF fact_row."state" = 'FORGOTTEN' AND fact_row."currentVersionId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Forgotten Project Memory fact cannot retain a current version';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_project_memory_fact_constraint_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'ProjectMemoryFact' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM aiqsa_assert_project_memory_fact(OLD."projectId", OLD."id"); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM aiqsa_assert_project_memory_fact(NEW."projectId", NEW."id"); END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM aiqsa_assert_project_memory_fact(OLD."projectId", OLD."factId"); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM aiqsa_assert_project_memory_fact(NEW."projectId", NEW."factId"); END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "ProjectMemoryFact_current_version_required"
AFTER INSERT OR UPDATE OR DELETE ON "ProjectMemoryFact" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_memory_fact_constraint_trigger();
CREATE CONSTRAINT TRIGGER "ProjectMemoryFactVersion_current_version_required"
AFTER INSERT OR DELETE ON "ProjectMemoryFactVersion" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_project_memory_fact_constraint_trigger();

UPDATE "Chat" AS chat
SET "createdByUserId" = chat."userId",
    "createdByDisplayName" = owner."displayName"
FROM "User" AS owner
WHERE owner."id" = chat."userId";
