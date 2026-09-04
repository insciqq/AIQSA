-- Workspace follow-up: durable long-lived execution registry and leased,
-- owner-guarded output export. Existing EXPORTING bindings carry no lease and
-- therefore become reclaimable stale leases instead of staying busy forever.
CREATE TYPE "WorkspaceExecutionState" AS ENUM (
  'ACTIVE',
  'TERMINATING',
  'CLOSED',
  'LOST'
);

ALTER TABLE "WorkspaceRunBinding"
  ADD COLUMN "exportLeaseToken" VARCHAR(64),
  ADD COLUMN "exportLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "exportStartedAt" TIMESTAMP(3),
  ADD COLUMN "exportCompletedAt" TIMESTAMP(3);

ALTER TABLE "WorkspaceRunBinding"
  ADD CONSTRAINT "WorkspaceRunBinding_export_lease_check" CHECK (
    ("exportLeaseToken" IS NULL AND "exportLeaseExpiresAt" IS NULL)
    OR (
      "exportLeaseToken" ~ '^[0-9a-f]{32,64}$'
      AND "exportLeaseExpiresAt" IS NOT NULL
      AND "exportState" = 'EXPORTING'
    )
  ),
  ADD CONSTRAINT "WorkspaceRunBinding_export_completed_check" CHECK (
    "exportCompletedAt" IS NULL OR "exportState" = 'COMPLETE'
  );

CREATE INDEX "WorkspaceRunBinding_exportState_exportLeaseExpiresAt_idx"
  ON "WorkspaceRunBinding"("exportState", "exportLeaseExpiresAt");

CREATE TABLE "WorkspaceExecution" (
  "id" TEXT NOT NULL,
  "workspaceSessionId" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "modelRunToolCallId" TEXT NOT NULL,
  "runtimeExecSessionId" VARCHAR(256) NOT NULL,
  "state" "WorkspaceExecutionState" NOT NULL DEFAULT 'ACTIVE',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkspaceExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceExecution_runtime_exec_session_check" CHECK (
    length("runtimeExecSessionId") BETWEEN 1 AND 256
    AND "runtimeExecSessionId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "WorkspaceExecution_error_code_check" CHECK (
    "lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT "WorkspaceExecution_completed_state_check" CHECK (
    "completedAt" IS NULL OR "state" IN ('CLOSED', 'LOST')
  )
);

CREATE UNIQUE INDEX "WorkspaceExecution_modelRunToolCallId_key"
  ON "WorkspaceExecution"("modelRunToolCallId");
CREATE UNIQUE INDEX "WorkspaceExecution_workspaceSessionId_runtimeExecSessionId_key"
  ON "WorkspaceExecution"("workspaceSessionId", "runtimeExecSessionId");
CREATE INDEX "WorkspaceExecution_modelRunId_state_idx"
  ON "WorkspaceExecution"("modelRunId", "state");
CREATE INDEX "WorkspaceExecution_workspaceSessionId_state_idx"
  ON "WorkspaceExecution"("workspaceSessionId", "state");

ALTER TABLE "WorkspaceExecution"
  ADD CONSTRAINT "WorkspaceExecution_workspaceSessionId_fkey"
  FOREIGN KEY ("workspaceSessionId") REFERENCES "WorkspaceSession"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "WorkspaceExecution"
  ADD CONSTRAINT "WorkspaceExecution_modelRunId_fkey"
  FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "WorkspaceExecution"
  ADD CONSTRAINT "WorkspaceExecution_modelRunToolCallId_fkey"
  FOREIGN KEY ("modelRunToolCallId") REFERENCES "ModelRunToolCall"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
