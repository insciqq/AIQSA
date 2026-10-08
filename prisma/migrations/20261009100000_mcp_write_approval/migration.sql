-- MCP write approval (operator decision 2026-10-08): interactive runs ask
-- their initiator before an MCP tool that may change data runs. Expand only:
-- previous-release writers never read or write these tables or the column.

-- CreateEnum
CREATE TYPE "MessageSystemTurnKind" AS ENUM ('mcp_approval_continuation');

-- CreateEnum
CREATE TYPE "McpToolApprovalSource" AS ENUM ('model', 'code', 'agent');

-- CreateEnum
CREATE TYPE "McpToolApprovalDecision" AS ENUM ('allow_once', 'allow_server', 'deny');

-- CreateEnum
CREATE TYPE "McpToolConsentScope" AS ENUM ('server_always');

-- A user message the server wrote (the continuation after an approval) is
-- never the user's speech. Only user messages carry the kind; every existing
-- row starts null, so the check holds at once.
ALTER TABLE "Message"
  ADD COLUMN "systemTurnKind" "MessageSystemTurnKind",
  ADD CONSTRAINT "Message_system_turn_kind_check" CHECK ("systemTurnKind" IS NULL OR "role" = 'user');

-- CreateTable
CREATE TABLE "McpToolConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "scope" "McpToolConsentScope" NOT NULL DEFAULT 'server_always',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpToolConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToolApproval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "toolCallId" TEXT,
    "source" "McpToolApprovalSource" NOT NULL,
    "serverId" TEXT NOT NULL,
    "serverName" VARCHAR(160) NOT NULL,
    "toolName" VARCHAR(256) NOT NULL,
    "toolTitle" VARCHAR(160) NOT NULL,
    "definitionHash" CHAR(64) NOT NULL,
    "argumentsDigest" CHAR(64) NOT NULL,
    "decision" "McpToolApprovalDecision",
    "decisionNonce" VARCHAR(128),
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "consumedByRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpToolApproval_pkey" PRIMARY KEY ("id"),
    -- A decision is one write: its time and nonce come with it. Only Allow
    -- once is a one-shot approval with an expiry, consumed once by a run.
    -- A tool-loop or Agent request names its refused call; guest code has none.
    CONSTRAINT "McpToolApproval_state_check" CHECK (
      ("decision" IS NULL) = ("decidedAt" IS NULL)
      AND ("decisionNonce" IS NULL OR "decision" IS NOT NULL)
      AND (("expiresAt" IS NOT NULL) = ("decision" IS NOT NULL AND "decision" = 'allow_once'))
      AND (("consumedAt" IS NULL) = ("consumedByRunId" IS NULL))
      AND ("consumedAt" IS NULL OR "decision" = 'allow_once')
      AND (("source" = 'code') = ("toolCallId" IS NULL))
      AND "definitionHash" ~ '^[0-9a-f]{64}$'
      AND "argumentsDigest" ~ '^[0-9a-f]{64}$'
    )
);

-- CreateIndex
CREATE INDEX "McpToolConsent_serverId_idx" ON "McpToolConsent"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "McpToolConsent_userId_serverId_key" ON "McpToolConsent"("userId", "serverId");

-- CreateIndex
CREATE INDEX "McpToolApproval_modelRunId_createdAt_idx" ON "McpToolApproval"("modelRunId", "createdAt");

-- CreateIndex
CREATE INDEX "McpToolApproval_userId_chatId_serverId_toolName_argumentsDi_idx" ON "McpToolApproval"("userId", "chatId", "serverId", "toolName", "argumentsDigest");

-- CreateIndex
CREATE INDEX "McpToolApproval_modelRunId_toolCallId_idx" ON "McpToolApproval"("modelRunId", "toolCallId");

-- CreateIndex
CREATE INDEX "McpToolApproval_serverId_idx" ON "McpToolApproval"("serverId");

-- AddForeignKey
ALTER TABLE "McpToolConsent" ADD CONSTRAINT "McpToolConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToolConsent" ADD CONSTRAINT "McpToolConsent_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToolApproval" ADD CONSTRAINT "McpToolApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToolApproval" ADD CONSTRAINT "McpToolApproval_modelRun_fkey" FOREIGN KEY ("userId", "chatId", "modelRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "McpToolApproval" ADD CONSTRAINT "McpToolApproval_toolCall_fkey" FOREIGN KEY ("modelRunId", "toolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "McpToolApproval" ADD CONSTRAINT "McpToolApproval_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
