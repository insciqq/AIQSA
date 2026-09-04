-- Chat-scoped Workspace is opt-in. The relational state is canonical while
-- microVM disks remain external, disposable runtime state.
CREATE TYPE "AttachmentOrigin" AS ENUM (
  'USER_UPLOAD',
  'WORKSPACE_OUTPUT',
  'WORKSPACE_EXPORT'
);

CREATE TYPE "WorkspaceSessionState" AS ENUM (
  'PENDING',
  'CREATING',
  'READY',
  'RUNNING',
  'STOPPED',
  'FAILED',
  'DELETING'
);

CREATE TYPE "WorkspaceExportState" AS ENUM (
  'PENDING',
  'EXPORTING',
  'COMPLETE',
  'FAILED'
);

CREATE TYPE "WorkspaceCleanupState" AS ENUM (
  'PENDING',
  'RUNNING',
  'FAILED'
);

ALTER TABLE "Chat"
  ADD COLUMN "workspaceEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Attachment"
  ADD COLUMN "origin" "AttachmentOrigin" NOT NULL DEFAULT 'USER_UPLOAD',
  ADD COLUMN "producerModelRunId" TEXT;

ALTER TABLE "ModelRunToolCall"
  ADD COLUMN "workspaceRunBindingId" TEXT;

CREATE TABLE "WorkspacePolicy" (
  "id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "internetEnabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkspacePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspacePolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "WorkspacePolicy_version_check" CHECK ("version" > 0)
);

INSERT INTO "WorkspacePolicy" (
  "id",
  "enabled",
  "internetEnabled",
  "version",
  "updatedAt"
) VALUES (
  'installation',
  false,
  true,
  1,
  CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

CREATE TABLE "WorkspaceSession" (
  "id" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "sandboxName" TEXT NOT NULL,
  "runtimeSandboxId" TEXT,
  "imageRef" TEXT NOT NULL,
  "state" "WorkspaceSessionState" NOT NULL DEFAULT 'PENDING',
  "internetEnabled" BOOLEAN NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "lastErrorCode" VARCHAR(64),
  "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stoppedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkspaceSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceSession_policy_revision_check" CHECK ("policyRevision" > 0),
  CONSTRAINT "WorkspaceSession_version_check" CHECK ("version" > 0),
  CONSTRAINT "WorkspaceSession_sandbox_name_check" CHECK (
    length("sandboxName") BETWEEN 1 AND 160
    AND "sandboxName" !~ '[[:cntrl:]/\\]'
  ),
  CONSTRAINT "WorkspaceSession_runtime_id_check" CHECK (
    "runtimeSandboxId" IS NULL OR (
      length("runtimeSandboxId") BETWEEN 1 AND 256
      AND "runtimeSandboxId" !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT "WorkspaceSession_image_ref_check" CHECK (
    length("imageRef") BETWEEN 1 AND 512
    AND "imageRef" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "WorkspaceSession_error_code_check" CHECK (
    "lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT "WorkspaceSession_expiry_check" CHECK ("expiresAt" >= "lastActiveAt"),
  CONSTRAINT "WorkspaceSession_stopped_state_check" CHECK (
    "stoppedAt" IS NULL OR "state" IN ('STOPPED', 'FAILED', 'DELETING')
  )
);

CREATE TABLE "WorkspaceCleanupJob" (
  "id" TEXT NOT NULL,
  "workspaceSessionId" TEXT NOT NULL,
  "sandboxName" TEXT NOT NULL,
  "runtimeSandboxId" TEXT,
  "state" "WorkspaceCleanupState" NOT NULL DEFAULT 'PENDING',
  "claimToken" TEXT,
  "claimedAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkspaceCleanupJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceCleanupJob_attempt_count_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "WorkspaceCleanupJob_claim_check" CHECK (
    ("claimToken" IS NULL AND "claimedAt" IS NULL)
    OR ("claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL)
  ),
  CONSTRAINT "WorkspaceCleanupJob_error_code_check" CHECK (
    "lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT "WorkspaceCleanupJob_sandbox_name_check" CHECK (
    length("sandboxName") BETWEEN 1 AND 160
    AND "sandboxName" !~ '[[:cntrl:]/\\]'
  )
);

CREATE TABLE "WorkspaceRunBinding" (
  "modelRunId" TEXT NOT NULL,
  "workspaceSessionId" TEXT NOT NULL,
  "imageRef" TEXT NOT NULL,
  "internetEnabled" BOOLEAN NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "runtimeVersion" TEXT NOT NULL,
  "mcpVersion" TEXT NOT NULL,
  "toolCatalogHash" CHAR(64) NOT NULL,
  "toolDefinitions" JSONB NOT NULL,
  "outputDirectory" VARCHAR(255) NOT NULL,
  "exportState" "WorkspaceExportState" NOT NULL DEFAULT 'PENDING',
  "exportAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastExportErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkspaceRunBinding_pkey" PRIMARY KEY ("modelRunId"),
  CONSTRAINT "WorkspaceRunBinding_policy_revision_check" CHECK ("policyRevision" > 0),
  CONSTRAINT "WorkspaceRunBinding_version_values_check" CHECK (
    length("imageRef") BETWEEN 1 AND 512
    AND length("runtimeVersion") BETWEEN 1 AND 64
    AND length("mcpVersion") BETWEEN 1 AND 64
    AND "imageRef" !~ '[[:cntrl:]]'
    AND "runtimeVersion" !~ '[[:cntrl:]]'
    AND "mcpVersion" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "WorkspaceRunBinding_tool_catalog_hash_check" CHECK (
    "toolCatalogHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "WorkspaceRunBinding_tool_definitions_check" CHECK (
    jsonb_typeof("toolDefinitions") = 'array'
    AND jsonb_array_length("toolDefinitions") BETWEEN 1 AND 32
  ),
  CONSTRAINT "WorkspaceRunBinding_output_directory_check" CHECK (
    "outputDirectory" ~ '^/workspace/output/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  ),
  CONSTRAINT "WorkspaceRunBinding_export_attempt_count_check" CHECK (
    "exportAttemptCount" >= 0
  ),
  CONSTRAINT "WorkspaceRunBinding_export_error_check" CHECK (
    "lastExportErrorCode" IS NULL
    OR "lastExportErrorCode" ~ '^[a-z][a-z0-9_]{0,63}$'
  )
);

CREATE TABLE "WorkspaceRunOutput" (
  "id" TEXT NOT NULL,
  "workspaceRunBindingId" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "relativePath" VARCHAR(512) NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkspaceRunOutput_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceRunOutput_relative_path_check" CHECK (
    length("relativePath") BETWEEN 1 AND 512
    AND "relativePath" !~ '[[:cntrl:]\\]'
    AND "relativePath" !~ '^/'
    AND "relativePath" !~ '(^|/)\.\.?(/|$)'
    AND "relativePath" !~ '//'
  ),
  CONSTRAINT "WorkspaceRunOutput_checksum_check" CHECK (
    "checksum" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "WorkspaceRunOutput_byte_size_check" CHECK ("byteSize" > 0)
);

CREATE UNIQUE INDEX "WorkspaceSession_chatId_key"
  ON "WorkspaceSession"("chatId");
CREATE UNIQUE INDEX "WorkspaceSession_sandboxName_key"
  ON "WorkspaceSession"("sandboxName");
CREATE INDEX "WorkspaceSession_state_expiresAt_idx"
  ON "WorkspaceSession"("state", "expiresAt");
CREATE INDEX "WorkspaceSession_state_lastActiveAt_idx"
  ON "WorkspaceSession"("state", "lastActiveAt");

CREATE INDEX "WorkspacePolicy_updatedByUserId_idx"
  ON "WorkspacePolicy"("updatedByUserId");

CREATE UNIQUE INDEX "WorkspaceCleanupJob_workspaceSessionId_key"
  ON "WorkspaceCleanupJob"("workspaceSessionId");
CREATE INDEX "WorkspaceCleanupJob_nextAttemptAt_claimedAt_createdAt_idx"
  ON "WorkspaceCleanupJob"("nextAttemptAt", "claimedAt", "createdAt");
CREATE INDEX "WorkspaceCleanupJob_state_nextAttemptAt_idx"
  ON "WorkspaceCleanupJob"("state", "nextAttemptAt");

CREATE INDEX "WorkspaceRunBinding_workspaceSessionId_createdAt_idx"
  ON "WorkspaceRunBinding"("workspaceSessionId", "createdAt");
CREATE INDEX "WorkspaceRunBinding_exportState_updatedAt_idx"
  ON "WorkspaceRunBinding"("exportState", "updatedAt");

CREATE UNIQUE INDEX "WorkspaceRunOutput_attachmentId_key"
  ON "WorkspaceRunOutput"("attachmentId");
CREATE UNIQUE INDEX "WorkspaceRunOutput_workspaceRunBindingId_relativePath_key"
  ON "WorkspaceRunOutput"("workspaceRunBindingId", "relativePath");
CREATE INDEX "WorkspaceRunOutput_workspaceRunBindingId_createdAt_idx"
  ON "WorkspaceRunOutput"("workspaceRunBindingId", "createdAt");

CREATE INDEX "Attachment_producerModelRunId_idx"
  ON "Attachment"("producerModelRunId");
CREATE INDEX "ModelRunToolCall_workspaceRunBindingId_idx"
  ON "ModelRunToolCall"("workspaceRunBindingId");

ALTER TABLE "WorkspacePolicy"
  ADD CONSTRAINT "WorkspacePolicy_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkspaceSession"
  ADD CONSTRAINT "WorkspaceSession_chatId_fkey"
  FOREIGN KEY ("chatId") REFERENCES "Chat"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "WorkspaceCleanupJob"
  ADD CONSTRAINT "WorkspaceCleanupJob_workspaceSessionId_fkey"
  FOREIGN KEY ("workspaceSessionId") REFERENCES "WorkspaceSession"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "WorkspaceRunBinding"
  ADD CONSTRAINT "WorkspaceRunBinding_modelRunId_fkey"
  FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "WorkspaceRunBinding"
  ADD CONSTRAINT "WorkspaceRunBinding_workspaceSessionId_fkey"
  FOREIGN KEY ("workspaceSessionId") REFERENCES "WorkspaceSession"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "WorkspaceRunOutput"
  ADD CONSTRAINT "WorkspaceRunOutput_workspaceRunBindingId_fkey"
  FOREIGN KEY ("workspaceRunBindingId") REFERENCES "WorkspaceRunBinding"("modelRunId")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "WorkspaceRunOutput"
  ADD CONSTRAINT "WorkspaceRunOutput_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "Attachment"
  ADD CONSTRAINT "Attachment_producerModelRunId_fkey"
  FOREIGN KEY ("producerModelRunId") REFERENCES "ModelRun"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ModelRunToolCall"
  ADD CONSTRAINT "ModelRunToolCall_workspaceRunBindingId_fkey"
  FOREIGN KEY ("workspaceRunBindingId") REFERENCES "WorkspaceRunBinding"("modelRunId")
  ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "ModelRunToolCall"
  ADD CONSTRAINT "ModelRunToolCall_workspace_binding_owner_check" CHECK (
    "workspaceRunBindingId" IS NULL OR "workspaceRunBindingId" = "modelRunId"
  );
