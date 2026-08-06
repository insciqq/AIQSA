-- Reusable Assistants v1: contract removal of the drained PromptPreset and
-- RunProfile surfaces plus the append-only Assistant aggregate and accepted-run
-- Assistant provenance.
--
-- Ordering: the preceding prompt_preset_stock_cleanup migration already proved
-- and removed the only expected PromptPreset stock rows fail-closed, and the
-- new application code contains no PromptPreset/RunProfile reads or writes, so
-- dropping the tables here is the contract half of the expand/contract removal
-- running in the same drained single-host deployment.
--
-- Historical accepted runs are unaffected: resolved prompt text lives in
-- "ModelRun"."normalizedRequest" and run profiles were never accepted-run
-- identity.

-- Drop PromptPreset references and table.
ALTER TABLE "Message" DROP CONSTRAINT "Message_promptPresetId_fkey";
ALTER TABLE "Message" DROP COLUMN "promptPresetId";
ALTER TABLE "Chat" DROP COLUMN "defaultPromptPresetId";
ALTER TABLE "UserSettings" DROP COLUMN "defaultPromptPresetId";
DROP TABLE "PromptPreset";

-- Drop the fixed Fast/Balanced/Deep run-profile slots. The restrictive
-- provider-model deletion guard moves to "AssistantRevision"."providerModelId".
DROP TABLE "RunProfile";

-- Assistant publication scope vocabulary.
CREATE TYPE "AssistantPublicationScope" AS ENUM ('group', 'installation');

-- Stable Assistant identity plus optimistic version and archive state.
CREATE TABLE "AssistantDefinition" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "currentRevisionId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AssistantDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantDefinition_version_check" CHECK ("version" >= 1)
);

-- Append-only versioned execution and presentation data. Bounds are defense in
-- depth; the application decoders own the strict field contracts.
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
  "mcpServerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "starterPrompts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "authorUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssistantRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantRevision_revision_number_check" CHECK ("revisionNumber" >= 1),
  CONSTRAINT "AssistantRevision_schema_version_check" CHECK ("schemaVersion" >= 1),
  CONSTRAINT "AssistantRevision_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "AssistantRevision_description_check" CHECK (char_length("description") <= 400),
  CONSTRAINT "AssistantRevision_category_check" CHECK ("category" IS NULL OR char_length("category") BETWEEN 1 AND 40),
  CONSTRAINT "AssistantRevision_system_prompt_check" CHECK (char_length("systemPrompt") <= 32000),
  CONSTRAINT "AssistantRevision_developer_prompt_check" CHECK ("developerPrompt" IS NULL OR char_length("developerPrompt") <= 16000),
  CONSTRAINT "AssistantRevision_starter_prompts_check" CHECK (cardinality("starterPrompts") <= 4),
  CONSTRAINT "AssistantRevision_mcp_server_ids_check" CHECK (cardinality("mcpServerIds") <= 16)
);

-- Publication of one exact immutable revision to one active group or the
-- installation. Groups may pin different revisions of the same Assistant.
CREATE TABLE "AssistantPublication" (
  "id" TEXT NOT NULL,
  "assistantId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "scope" "AssistantPublicationScope" NOT NULL,
  "groupId" TEXT,
  "publishedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AssistantPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantPublication_scope_group_check" CHECK (
    ("scope" = 'group' AND "groupId" IS NOT NULL)
    OR ("scope" = 'installation' AND "groupId" IS NULL)
  )
);

-- Per-user pin preference. Pins grant no access and never enter run evidence.
CREATE TABLE "AssistantPin" (
  "userId" TEXT NOT NULL,
  "assistantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssistantPin_pkey" PRIMARY KEY ("userId", "assistantId")
);

-- Accepted-run Assistant provenance: exact definition plus revision, either
-- both present or both absent, with composite lineage integrity.
ALTER TABLE "ModelRun" ADD COLUMN "assistantId" TEXT;
ALTER TABLE "ModelRun" ADD COLUMN "assistantRevisionId" TEXT;
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_assistant_pair_check"
  CHECK (("assistantId" IS NULL) = ("assistantRevisionId" IS NULL));

CREATE UNIQUE INDEX "AssistantDefinition_currentRevisionId_key" ON "AssistantDefinition"("currentRevisionId");
CREATE UNIQUE INDEX "AssistantDefinition_id_currentRevisionId_key" ON "AssistantDefinition"("id", "currentRevisionId");
CREATE INDEX "AssistantDefinition_ownerUserId_archivedAt_idx" ON "AssistantDefinition"("ownerUserId", "archivedAt");

CREATE UNIQUE INDEX "AssistantRevision_assistantId_revisionNumber_key" ON "AssistantRevision"("assistantId", "revisionNumber");
CREATE UNIQUE INDEX "AssistantRevision_assistantId_id_key" ON "AssistantRevision"("assistantId", "id");
CREATE INDEX "AssistantRevision_authorUserId_idx" ON "AssistantRevision"("authorUserId");
CREATE INDEX "AssistantRevision_providerModelId_idx" ON "AssistantRevision"("providerModelId");

CREATE UNIQUE INDEX "AssistantPublication_assistantId_groupId_key" ON "AssistantPublication"("assistantId", "groupId");
-- PostgreSQL treats NULL groupId values as distinct, so installation-wide
-- uniqueness needs its own partial unique index.
CREATE UNIQUE INDEX "AssistantPublication_installation_key" ON "AssistantPublication"("assistantId") WHERE "scope" = 'installation';
CREATE INDEX "AssistantPublication_groupId_idx" ON "AssistantPublication"("groupId");
CREATE INDEX "AssistantPublication_assistantId_scope_idx" ON "AssistantPublication"("assistantId", "scope");
CREATE INDEX "AssistantPublication_revisionId_idx" ON "AssistantPublication"("revisionId");

CREATE INDEX "AssistantPin_assistantId_idx" ON "AssistantPin"("assistantId");

CREATE INDEX "ModelRun_assistantId_assistantRevisionId_idx" ON "ModelRun"("assistantId", "assistantRevisionId");

ALTER TABLE "AssistantDefinition" ADD CONSTRAINT "AssistantDefinition_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_assistantId_fkey"
  FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AssistantRevision" ADD CONSTRAINT "AssistantRevision_providerModelId_fkey"
  FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssistantDefinition" ADD CONSTRAINT "AssistantDefinition_currentRevision_fkey"
  FOREIGN KEY ("id", "currentRevisionId") REFERENCES "AssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_assistantId_fkey"
  FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_publishedByUserId_fkey"
  FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AssistantPublication" ADD CONSTRAINT "AssistantPublication_revision_fkey"
  FOREIGN KEY ("assistantId", "revisionId") REFERENCES "AssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AssistantPin" ADD CONSTRAINT "AssistantPin_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantPin" ADD CONSTRAINT "AssistantPin_assistantId_fkey"
  FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_assistantRevision_fkey"
  FOREIGN KEY ("assistantId", "assistantRevisionId") REFERENCES "AssistantRevision"("assistantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
