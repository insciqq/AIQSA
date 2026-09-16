CREATE TYPE "AgentAttemptState" AS ENUM ('DISPATCHED', 'COMPLETE', 'ERROR', 'UNKNOWN');

CREATE TABLE "AgentRunBinding" (
  "modelRunId" TEXT PRIMARY KEY,
  "configuration" JSONB NOT NULL,
  "compatibilityHash" CHAR(64) NOT NULL,
  "tokenHash" CHAR(64),
  "expiresAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "threadId" VARCHAR(128),
  "resumedFromRunId" TEXT,
  "modelCalls" INTEGER NOT NULL DEFAULT 0,
  "toolCalls" INTEGER NOT NULL DEFAULT 0,
  "reservedTokens" INTEGER NOT NULL DEFAULT 0,
  "providerInFlight" BOOLEAN NOT NULL DEFAULT false,
  "nextToolOrdinal" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentRunBinding_workspaceRun_fkey" FOREIGN KEY ("modelRunId") REFERENCES "WorkspaceRunBinding"("modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "AgentRunBinding_resumedFrom_fkey" FOREIGN KEY ("resumedFromRunId") REFERENCES "AgentRunBinding"("modelRunId") ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT "AgentRunBinding_counts_check" CHECK ("modelCalls" >= 0 AND "toolCalls" >= 0 AND "reservedTokens" >= 0 AND "nextToolOrdinal" >= 0),
  CONSTRAINT "AgentRunBinding_grant_check" CHECK (("tokenHash" IS NULL) = ("startedAt" IS NULL) AND ("tokenHash" IS NULL) = ("expiresAt" IS NULL))
);
CREATE UNIQUE INDEX "AgentRunBinding_tokenHash_key" ON "AgentRunBinding"("tokenHash");
CREATE INDEX "AgentRunBinding_leaseExpiresAt_idx" ON "AgentRunBinding"("leaseExpiresAt");
CREATE INDEX "AgentRunBinding_resumedFromRunId_idx" ON "AgentRunBinding"("resumedFromRunId");

CREATE TABLE "AgentProviderAttempt" (
  "id" TEXT PRIMARY KEY,
  "modelRunId" TEXT NOT NULL,
  "providerBindingKey" TEXT NOT NULL,
  "state" "AgentAttemptState" NOT NULL DEFAULT 'DISPATCHED',
  "reservedTokens" INTEGER NOT NULL,
  "usage" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AgentProviderAttempt_binding_fkey" FOREIGN KEY ("modelRunId") REFERENCES "AgentRunBinding"("modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT,
  -- The binding and receipt have different cascade depths from ModelRun.
  -- Verify their relationship at commit, after both owned subtrees are deleted.
  CONSTRAINT "AgentProviderAttempt_providerBinding_fkey" FOREIGN KEY ("modelRunId", "providerBindingKey") REFERENCES "ProviderRunBinding"("modelRunId", "bindingKey") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "AgentProviderAttempt_budget_check" CHECK ("reservedTokens" >= 0),
  CONSTRAINT "AgentProviderAttempt_terminal_check" CHECK (("state" = 'DISPATCHED') = ("completedAt" IS NULL))
);
CREATE INDEX "AgentProviderAttempt_modelRunId_createdAt_idx" ON "AgentProviderAttempt"("modelRunId", "createdAt");
CREATE INDEX "AgentProviderAttempt_modelRunId_providerBindingKey_idx" ON "AgentProviderAttempt"("modelRunId", "providerBindingKey");

CREATE TABLE "AgentMcpTool" (
  "modelRunId" TEXT NOT NULL,
  "toolId" VARCHAR(128) NOT NULL,
  "version" CHAR(64) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("modelRunId", "toolId"),
  CONSTRAINT "AgentMcpTool_binding_fkey" FOREIGN KEY ("modelRunId") REFERENCES "AgentRunBinding"("modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT
);
