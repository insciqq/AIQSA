-- Sub-agents (`lib/contracts/subagents.ts`): named threads of a chat, their
-- turns (one per `call_subagent` that starts or continues a thread), the thread
-- key on transcript items and tool calls, background sub-agent runs, callbacks
-- and mailbox messages on the follow-up store, and custom sub-agent
-- definitions with revisions. Expand only: every new column is nullable or
-- defaulted, nothing reads the new fields yet, and previous-release writers
-- never name them. The transcript and tool-call keys gain the thread in
-- following concurrent migrations (`20261029230200` to `20261029230800`),
-- because both tables are large and live.

-- CreateEnum
CREATE TYPE "RunFollowupOrigin" AS ENUM ('user', 'main_agent', 'subagent_callback');

-- CreateEnum
CREATE TYPE "SubagentTurnMode" AS ENUM ('foreground', 'background');

-- CreateEnum
CREATE TYPE "SubagentTurnState" AS ENUM ('running', 'waiting', 'done', 'stopped', 'failed', 'interrupted');

-- CreateEnum
CREATE TYPE "SubagentOutcome" AS ENUM ('done', 'partial', 'blocked');

-- CreateEnum
CREATE TYPE "SubagentBindingSource" AS ENUM ('parent', 'type', 'call');

-- AlterEnum: the schema's order. Nothing below uses the new values, which
-- PostgreSQL allows only after this transaction commits; the usage check that
-- names `subagent` follows in `20261029230100_subagent_usage_cost_reported`.
-- Personal purposes come first in the vocabulary (lib/domain/usagePurpose.ts).
ALTER TYPE "MessageSystemTurnKind" ADD VALUE 'subagent_callback' AFTER 'answer_revision_request';
ALTER TYPE "UsagePurpose" ADD VALUE 'subagent' AFTER 'speech_to_text';

-- AlterTable: a background sub-agent run names its thread and turn, both or
-- neither, and never answers a message. Every existing run is a main-agent run.
ALTER TABLE "ModelRun" ADD COLUMN "subagentThreadId" TEXT,
ADD COLUMN "subagentTurnId" TEXT,
ADD CONSTRAINT "ModelRun_subagent_turn_check" CHECK (
  ("subagentThreadId" IS NULL) = ("subagentTurnId" IS NULL)
  AND ("subagentTurnId" IS NULL OR "assistantMessageId" IS NULL)
);

-- AlterTable: existing follow-ups are the user's; only a callback names the
-- turn it reports.
ALTER TABLE "RunFollowup" ADD COLUMN "origin" "RunFollowupOrigin" NOT NULL DEFAULT 'user',
ADD COLUMN "subagentTurnId" TEXT,
ADD CONSTRAINT "RunFollowup_subagent_turn_check" CHECK (
  ("origin" = 'subagent_callback') = ("subagentTurnId" IS NOT NULL)
);

-- AlterTable
ALTER TABLE "RunTranscriptItem" ADD COLUMN "subagentThreadId" TEXT;

-- AlterTable
ALTER TABLE "ModelRunToolCall" ADD COLUMN "subagentThreadId" TEXT;

-- CreateTable
CREATE TABLE "SubagentThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "anchorRunId" TEXT NOT NULL,
    "name" VARCHAR(48) NOT NULL,
    "definitionId" TEXT,
    "typeName" VARCHAR(48),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubagentThread_pkey" PRIMARY KEY ("id"),
    -- The slug itself is the contract's (`SUBAGENT_NAME_PATTERN`); a custom
    -- sub-agent's thread keeps its type name after the definition is deleted.
    CONSTRAINT "SubagentThread_shape_check" CHECK (
      char_length("name") >= 1
      AND ("typeName" IS NULL OR char_length("typeName") >= 1)
      AND ("definitionId" IS NULL OR "typeName" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "SubagentTurn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "parentRunId" TEXT NOT NULL,
    "parentToolCallId" TEXT NOT NULL,
    "mode" "SubagentTurnMode" NOT NULL,
    "state" "SubagentTurnState" NOT NULL DEFAULT 'running',
    "outcome" "SubagentOutcome",
    "reasonCode" VARCHAR(64),
    "result" JSONB,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "providerModelId" TEXT,
    "reasoningEffort" VARCHAR(32),
    "modelSource" "SubagentBindingSource" NOT NULL DEFAULT 'parent',
    "effortSource" "SubagentBindingSource" NOT NULL DEFAULT 'parent',
    "definitionRevisionId" TEXT,
    "callbackRunId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubagentTurn_pkey" PRIMARY KEY ("id"),
    -- Active turns (running, waiting) have no end; only a done turn has an
    -- outcome, a blocked one with its reason, and a failed turn says why. Only
    -- a background turn that ended owes a callback, so only it names the run
    -- that received it.
    CONSTRAINT "SubagentTurn_state_check" CHECK (
      ("state" IN ('running', 'waiting')) = ("endedAt" IS NULL)
      AND ("state" = 'done') = ("outcome" IS NOT NULL)
      AND ("outcome" IS DISTINCT FROM 'blocked' OR "reasonCode" IS NOT NULL)
      AND ("state" <> 'failed' OR "reasonCode" IS NOT NULL)
      AND ("callbackRunId" IS NULL OR ("mode" = 'background' AND "endedAt" IS NOT NULL))
      AND ("result" IS NULL OR jsonb_typeof("result") = 'object')
      AND ("endedAt" IS NULL OR "endedAt" >= "startedAt")
    )
);

-- CreateTable
CREATE TABLE "SubagentDefinition" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" VARCHAR(48) NOT NULL,
    "currentRevisionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubagentDefinition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubagentDefinition_shape_check" CHECK (char_length("name") >= 1 AND "version" >= 1)
);

-- CreateTable
CREATE TABLE "SubagentDefinitionRevision" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "name" VARCHAR(48) NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "providerModelId" TEXT,
    "reasoningEffort" VARCHAR(32),
    "toolGroups" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubagentDefinitionRevision_pkey" PRIMARY KEY ("id"),
    -- Bounds are the contract's (`SUBAGENT_DEFINITION_LIMITS`); these are the
    -- outer guards every writer meets.
    CONSTRAINT "SubagentDefinitionRevision_shape_check" CHECK (
      "revisionNumber" >= 1
      AND char_length("name") >= 1
      AND char_length("description") <= 4000
      AND char_length("instructions") <= 64000
      AND ("toolGroups" IS NULL OR jsonb_typeof("toolGroups") = 'array')
    )
);

-- CreateIndex
CREATE INDEX "SubagentThread_chatId_createdAt_idx" ON "SubagentThread"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "SubagentThread_userId_definitionId_idx" ON "SubagentThread"("userId", "definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentThread_chatId_anchorRunId_name_key" ON "SubagentThread"("chatId", "anchorRunId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentThread_userId_chatId_id_key" ON "SubagentThread"("userId", "chatId", "id");

-- CreateIndex
CREATE INDEX "SubagentTurn_threadId_startedAt_idx" ON "SubagentTurn"("threadId", "startedAt");

-- CreateIndex
CREATE INDEX "SubagentTurn_chatId_state_idx" ON "SubagentTurn"("chatId", "state");

-- CreateIndex
CREATE INDEX "SubagentTurn_chatId_callbackRunId_idx" ON "SubagentTurn"("chatId", "callbackRunId");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentTurn_parentRunId_parentToolCallId_key" ON "SubagentTurn"("parentRunId", "parentToolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentTurn_userId_chatId_threadId_id_key" ON "SubagentTurn"("userId", "chatId", "threadId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentTurn_chatId_id_key" ON "SubagentTurn"("chatId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentDefinition_currentRevisionId_key" ON "SubagentDefinition"("currentRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentDefinition_ownerUserId_name_key" ON "SubagentDefinition"("ownerUserId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentDefinition_ownerUserId_id_key" ON "SubagentDefinition"("ownerUserId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentDefinition_id_currentRevisionId_key" ON "SubagentDefinition"("id", "currentRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentDefinitionRevision_definitionId_revisionNumber_key" ON "SubagentDefinitionRevision"("definitionId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentDefinitionRevision_definitionId_id_key" ON "SubagentDefinitionRevision"("definitionId", "id");

-- CreateIndex: RunFollowup holds only clarifications, so it is small enough to
-- index inside this transaction.
CREATE INDEX "RunFollowup_chatId_subagentTurnId_idx" ON "RunFollowup"("chatId", "subagentTurnId");

-- AddForeignKey: every existing run has neither column, so validation finds
-- nothing to check. The index the cascade uses follows concurrently
-- (`20261029230500_model_run_subagent_turn_index`).
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_subagentTurn_fkey" FOREIGN KEY ("userId", "chatId", "subagentThreadId", "subagentTurnId") REFERENCES "SubagentTurn"("userId", "chatId", "threadId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RunFollowup" ADD CONSTRAINT "RunFollowup_subagentTurn_fkey" FOREIGN KEY ("chatId", "subagentTurnId") REFERENCES "SubagentTurn"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubagentThread" ADD CONSTRAINT "SubagentThread_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey: the anchor run carries the owner and chat (`ModelRun` is
-- itself bound to its chat's owner), so a thread never names another user's
-- or another chat's run.
ALTER TABLE "SubagentThread" ADD CONSTRAINT "SubagentThread_anchorRun_fkey" FOREIGN KEY ("userId", "chatId", "anchorRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey: deleting the definition clears only the thread's definition
-- column, never its owner.
ALTER TABLE "SubagentThread" ADD CONSTRAINT "SubagentThread_definition_fkey" FOREIGN KEY ("userId", "definitionId") REFERENCES "SubagentDefinition"("ownerUserId", "id") ON DELETE SET NULL ("definitionId") ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubagentTurn" ADD CONSTRAINT "SubagentTurn_thread_fkey" FOREIGN KEY ("userId", "chatId", "threadId") REFERENCES "SubagentThread"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubagentTurn" ADD CONSTRAINT "SubagentTurn_parentRun_fkey" FOREIGN KEY ("userId", "chatId", "parentRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubagentTurn" ADD CONSTRAINT "SubagentTurn_parentToolCall_fkey" FOREIGN KEY ("parentRunId", "parentToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey: deleting the run that received a callback clears only the
-- callback column, so the callback is owed again.
ALTER TABLE "SubagentTurn" ADD CONSTRAINT "SubagentTurn_callbackRun_fkey" FOREIGN KEY ("chatId", "callbackRunId") REFERENCES "ModelRun"("chatId", "id") ON DELETE SET NULL ("callbackRunId") ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubagentDefinition" ADD CONSTRAINT "SubagentDefinition_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: NO ACTION, checked at the end of the statement, so deleting
-- a definition may cascade to the revision it points at.
ALTER TABLE "SubagentDefinition" ADD CONSTRAINT "SubagentDefinition_currentRevision_fkey" FOREIGN KEY ("id", "currentRevisionId") REFERENCES "SubagentDefinitionRevision"("definitionId", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubagentDefinitionRevision" ADD CONSTRAINT "SubagentDefinitionRevision_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "SubagentDefinition"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
