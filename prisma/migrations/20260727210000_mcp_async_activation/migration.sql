CREATE TYPE "McpActivationStage" AS ENUM (
  'queued',
  'resolving',
  'preparing_runtime',
  'connecting',
  'discovering_tools',
  'publishing',
  'ready',
  'failed'
);

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

  CONSTRAINT "McpActivationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpActivationJob_sharedConfigVersion_check" CHECK ("sharedConfigVersion" >= 0),
  CONSTRAINT "McpActivationJob_terminal_fields_check" CHECK (
    ("stage" = 'failed' AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
    OR ("stage" = 'ready' AND "completedAt" IS NOT NULL AND "errorCode" IS NULL)
    OR ("stage" NOT IN ('ready', 'failed') AND "completedAt" IS NULL AND "errorCode" IS NULL)
  )
);

CREATE UNIQUE INDEX "McpActivationJob_serverId_key" ON "McpActivationJob"("serverId");
CREATE UNIQUE INDEX "McpActivationJob_workloadToken_key" ON "McpActivationJob"("workloadToken");
CREATE INDEX "McpActivationJob_stage_updatedAt_idx" ON "McpActivationJob"("stage", "updatedAt");
CREATE INDEX "McpActivationJob_validationUserId_idx" ON "McpActivationJob"("validationUserId");

ALTER TABLE "McpActivationJob"
  ADD CONSTRAINT "McpActivationJob_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "McpActivationJob"
  ADD CONSTRAINT "McpActivationJob_validationUserId_fkey"
  FOREIGN KEY ("validationUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
