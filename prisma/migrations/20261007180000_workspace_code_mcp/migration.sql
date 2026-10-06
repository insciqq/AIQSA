-- MCP calls from Workspace guest code: one run-scoped grant (bearer hash
-- only), one invocation per dispatched sandbox command or exec session and
-- one content-free receipt per call. No arguments, results or bearers.
CREATE TABLE "WorkspaceCodeGrant" (
  "modelRunId" TEXT NOT NULL,
  "workspaceSessionId" TEXT NOT NULL,
  "tokenHash" CHAR(64),
  "issuedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "callCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceCodeGrant_pkey" PRIMARY KEY ("modelRunId"),
  CONSTRAINT "WorkspaceCodeGrant_binding_fkey" FOREIGN KEY ("modelRunId", "workspaceSessionId")
    REFERENCES "WorkspaceRunBinding" ("modelRunId", "workspaceSessionId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCodeGrant_token_check" CHECK (
    ("tokenHash" IS NULL OR ("tokenHash" ~ '^[a-f0-9]{64}$' AND "issuedAt" IS NOT NULL AND "revokedAt" IS NULL))
    AND "callCount" >= 0
  )
);
CREATE UNIQUE INDEX "WorkspaceCodeGrant_tokenHash_key" ON "WorkspaceCodeGrant" ("tokenHash");
CREATE UNIQUE INDEX "WorkspaceCodeGrant_modelRunId_workspaceSessionId_key" ON "WorkspaceCodeGrant" ("modelRunId", "workspaceSessionId");

CREATE TABLE "WorkspaceCodeInvocation" (
  "id" CHAR(32) NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'open',
  "refusedCalls" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceCodeInvocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceCodeInvocation_grant_fkey" FOREIGN KEY ("modelRunId")
    REFERENCES "WorkspaceCodeGrant" ("modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCodeInvocation_toolCall_fkey" FOREIGN KEY ("modelRunId", "toolCallId")
    REFERENCES "ModelRunToolCall" ("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCodeInvocation_state_check" CHECK (
    "id" ~ '^[a-f0-9]{32}$' AND "kind" IN ('command', 'session') AND "refusedCalls" >= 0
    AND "state" IN ('open', 'closed', 'unknown') AND ("state" = 'open') = ("closedAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "WorkspaceCodeInvocation_modelRunId_id_key" ON "WorkspaceCodeInvocation" ("modelRunId", "id");
CREATE INDEX "WorkspaceCodeInvocation_modelRunId_toolCallId_idx" ON "WorkspaceCodeInvocation" ("modelRunId", "toolCallId");
CREATE INDEX "WorkspaceCodeInvocation_modelRunId_state_idx" ON "WorkspaceCodeInvocation" ("modelRunId", "state");

CREATE TABLE "WorkspaceCodeCall" (
  "id" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "invocationId" CHAR(32) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "serverId" VARCHAR(128) NOT NULL,
  "toolName" VARCHAR(128) NOT NULL,
  "argumentHash" CHAR(64) NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'dispatching',
  "errorCode" VARCHAR(64),
  "resultBytes" INTEGER,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceCodeCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceCodeCall_grant_fkey" FOREIGN KEY ("modelRunId")
    REFERENCES "WorkspaceCodeGrant" ("modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCodeCall_invocation_fkey" FOREIGN KEY ("modelRunId", "invocationId")
    REFERENCES "WorkspaceCodeInvocation" ("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCodeCall_receipt_check" CHECK (
    "sequence" >= 0 AND "argumentHash" ~ '^[a-f0-9]{64}$' AND length("serverId") > 0 AND length("toolName") > 0
    AND ("resultBytes" IS NULL OR "resultBytes" >= 0) AND ("durationMs" IS NULL OR "durationMs" >= 0)
    AND "state" IN ('dispatching', 'complete', 'error', 'unknown') AND ("state" = 'dispatching') = ("settledAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "WorkspaceCodeCall_modelRunId_sequence_key" ON "WorkspaceCodeCall" ("modelRunId", "sequence");
CREATE INDEX "WorkspaceCodeCall_modelRunId_state_idx" ON "WorkspaceCodeCall" ("modelRunId", "state");
CREATE INDEX "WorkspaceCodeCall_modelRunId_createdAt_idx" ON "WorkspaceCodeCall" ("modelRunId", "createdAt");
CREATE INDEX "WorkspaceCodeCall_invocationId_idx" ON "WorkspaceCodeCall" ("invocationId");
