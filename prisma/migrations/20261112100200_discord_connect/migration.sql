-- Discord Connect: the installation's one bot (a disabled singleton control
-- row with a write-only token envelope, the server, channel rule, direct
-- messages, test access, service account, Assistant, author and thread limits,
-- the gateway session the next process resumes, the IDENTIFY times of the last
-- day and content-free session health), one conversation per Discord thread
-- bound to the service account's chat, one journal row per question (its
-- claim, stages and run totals, never message text), ratings of answers and
-- monitoring keys kept only as hashes. Rows hold identifiers, codes, counts
-- and times; a question's row alone keeps its author's display name.
-- Expand only: previous-release writers never read or write the tables.

-- CreateEnum
CREATE TYPE "DiscordChannelMode" AS ENUM ('only_listed', 'all_except');

-- CreateEnum
CREATE TYPE "DiscordConversationKind" AS ENUM ('thread', 'forum_post', 'dm', 'voice_chat', 'channel');

-- CreateEnum
CREATE TYPE "DiscordReplyState" AS ENUM ('claimed', 'admitted', 'delivered', 'failed', 'interrupted', 'unknown');

-- CreateEnum
CREATE TYPE "DiscordReplyKind" AS ENUM ('answer', 'follow_up', 'refused');

-- CreateEnum
CREATE TYPE "DiscordLimitKind" AS ENUM ('author', 'thread', 'key');

-- CreateTable
CREATE TABLE "DiscordBotControl" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "tokenEnvelope" TEXT,
    "tokenGeneration" INTEGER NOT NULL DEFAULT 0,
    "applicationId" BIGINT,
    "botUserId" BIGINT,
    "botUsername" VARCHAR(64),
    "botRoleId" BIGINT,
    "guildId" BIGINT,
    "guildName" VARCHAR(100),
    "channelMode" "DiscordChannelMode" NOT NULL DEFAULT 'only_listed',
    "channelIds" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "dmEnabled" BOOLEAN NOT NULL DEFAULT false,
    "testAuthorIds" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "testChannelIds" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "serviceUserId" TEXT,
    "assistantId" TEXT,
    "perAuthorHourly" INTEGER NOT NULL DEFAULT 20,
    "perAuthorDaily" INTEGER NOT NULL DEFAULT 100,
    "perThreadHourly" INTEGER NOT NULL DEFAULT 60,
    "parallelThreads" INTEGER NOT NULL DEFAULT 16,
    "sessionId" VARCHAR(128),
    "sessionGeneration" INTEGER,
    "sessionSeq" INTEGER,
    "resumeGatewayUrl" VARCHAR(256),
    "identifyAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "lastConnectedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureCode" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordBotControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordConversation" (
    "id" TEXT NOT NULL,
    "discordChannelId" BIGINT NOT NULL,
    "kind" "DiscordConversationKind" NOT NULL,
    "guildId" BIGINT,
    "parentChannelId" BIGINT,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "botOpened" BOOLEAN NOT NULL DEFAULT false,
    "lastIncludedMessageId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordReply" (
    "questionMessageId" BIGINT NOT NULL,
    "conversationId" TEXT,
    "guildId" BIGINT,
    "channelId" BIGINT NOT NULL,
    "discordUserId" BIGINT NOT NULL,
    "authorName" VARCHAR(100) NOT NULL,
    "kind" "DiscordReplyKind" NOT NULL DEFAULT 'answer',
    "state" "DiscordReplyState" NOT NULL DEFAULT 'claimed',
    "test" BOOLEAN NOT NULL DEFAULT false,
    "runId" TEXT,
    "expectedLeafId" TEXT,
    "statusMessageId" BIGINT,
    "answerMessageId" BIGINT,
    "code" VARCHAR(80),
    "failureKind" VARCHAR(32),
    "limitKind" "DiscordLimitKind",
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackAt" TIMESTAMP(3),
    "admittedAt" TIMESTAMP(3),
    "firstStatusAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "mcpByServer" JSONB,
    "compactions" INTEGER,
    "subagents" INTEGER,
    "sources" INTEGER,

    CONSTRAINT "DiscordReply_pkey" PRIMARY KEY ("questionMessageId")
);

-- CreateTable
CREATE TABLE "DiscordAnswerRating" (
    "replyId" BIGINT NOT NULL,
    "discordUserId" BIGINT NOT NULL,
    "value" SMALLINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordAnswerRating_pkey" PRIMARY KEY ("replyId","discordUserId")
);

-- CreateTable
CREATE TABLE "DiscordMonitoringKey" (
    "id" TEXT NOT NULL,
    "keyHash" CHAR(64) NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "DiscordMonitoringKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscordBotControl_updatedByUserId_idx" ON "DiscordBotControl"("updatedByUserId");

-- CreateIndex
CREATE INDEX "DiscordBotControl_serviceUserId_idx" ON "DiscordBotControl"("serviceUserId");

-- CreateIndex
CREATE INDEX "DiscordBotControl_assistantId_idx" ON "DiscordBotControl"("assistantId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordConversation_discordChannelId_key" ON "DiscordConversation"("discordChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordConversation_chatId_key" ON "DiscordConversation"("chatId");

-- CreateIndex
CREATE INDEX "DiscordConversation_userId_chatId_idx" ON "DiscordConversation"("userId", "chatId");

-- CreateIndex
CREATE INDEX "DiscordConversation_lastActivityAt_idx" ON "DiscordConversation"("lastActivityAt");

-- CreateIndex
CREATE INDEX "DiscordReply_discordUserId_receivedAt_idx" ON "DiscordReply"("discordUserId", "receivedAt");

-- CreateIndex
CREATE INDEX "DiscordReply_conversationId_receivedAt_idx" ON "DiscordReply"("conversationId", "receivedAt");

-- CreateIndex
CREATE INDEX "DiscordReply_state_receivedAt_idx" ON "DiscordReply"("state", "receivedAt");

-- CreateIndex
CREATE INDEX "DiscordReply_receivedAt_idx" ON "DiscordReply"("receivedAt");

-- CreateIndex
CREATE INDEX "DiscordReply_runId_idx" ON "DiscordReply"("runId");

-- CreateIndex
CREATE INDEX "DiscordReply_answerMessageId_idx" ON "DiscordReply"("answerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordMonitoringKey_keyHash_key" ON "DiscordMonitoringKey"("keyHash");

-- CreateIndex
CREATE INDEX "DiscordMonitoringKey_createdByUserId_idx" ON "DiscordMonitoringKey"("createdByUserId");

-- CreateIndex
CREATE INDEX "DiscordMonitoringKey_revokedAt_idx" ON "DiscordMonitoringKey"("revokedAt");

-- AddForeignKey
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_serviceUserId_fkey" FOREIGN KEY ("serviceUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "AssistantDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordConversation" ADD CONSTRAINT "DiscordConversation_userId_chatId_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DiscordReply" ADD CONSTRAINT "DiscordReply_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "DiscordConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordReply" ADD CONSTRAINT "DiscordReply_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ModelRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordAnswerRating" ADD CONSTRAINT "DiscordAnswerRating_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "DiscordReply"("questionMessageId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordMonitoringKey" ADD CONSTRAINT "DiscordMonitoringKey_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row; every save names the version it was made against.
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_singleton_check" CHECK ("id" = 'installation');
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_version_check" CHECK ("version" >= 1);
-- A stored token always names its generation and the bot and application
-- Discord proved it belongs to; without a token there is no bot identity.
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_token_check" CHECK (
  "tokenGeneration" >= 0 AND (
    ("tokenEnvelope" IS NULL AND "applicationId" IS NULL AND "botUserId" IS NULL AND "botUsername" IS NULL)
    OR ("tokenEnvelope" IS NOT NULL AND "tokenGeneration" >= 1 AND "applicationId" > 0 AND "botUserId" > 0
      AND "botUsername" IS NOT NULL)
  )
);
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_enabled_check"
  CHECK (NOT "enabled" OR ("tokenEnvelope" IS NOT NULL AND "enabledAt" IS NOT NULL));
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_guild_check" CHECK (
  ("guildId" IS NULL OR "guildId" > 0) AND ("guildName" IS NULL OR "guildId" IS NOT NULL)
  AND ("botRoleId" IS NULL OR "botRoleId" > 0)
);
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_lists_check" CHECK (
  cardinality(COALESCE("channelIds", '{}')) <= 200 AND cardinality(COALESCE("testAuthorIds", '{}')) <= 10
  AND cardinality(COALESCE("testChannelIds", '{}')) <= 10 AND cardinality(COALESCE("identifyAt", '{}')) <= 64
);
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_limits_check" CHECK (
  "perAuthorHourly" BETWEEN 1 AND 1000 AND "perAuthorDaily" BETWEEN 1 AND 10000
  AND "perThreadHourly" BETWEEN 1 AND 10000 AND "parallelThreads" BETWEEN 1 AND 64
);
-- A gateway session is whole and belongs to one token generation.
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_session_check" CHECK (
  ("sessionId" IS NULL AND "sessionGeneration" IS NULL AND "sessionSeq" IS NULL AND "resumeGatewayUrl" IS NULL)
  OR ("sessionId" IS NOT NULL AND "sessionGeneration" >= 1 AND "resumeGatewayUrl" IS NOT NULL
    AND ("sessionSeq" IS NULL OR "sessionSeq" >= 0))
);
ALTER TABLE "DiscordBotControl" ADD CONSTRAINT "DiscordBotControl_failure_check"
  CHECK (("lastFailureAt" IS NULL) = ("lastFailureCode" IS NULL));

-- Discord ids are positive snowflakes; only a direct-message channel has no server.
ALTER TABLE "DiscordConversation" ADD CONSTRAINT "DiscordConversation_identity_check" CHECK (
  "discordChannelId" > 0 AND ("guildId" IS NULL OR "guildId" > 0) AND ("parentChannelId" IS NULL OR "parentChannelId" > 0)
  AND ("lastIncludedMessageId" IS NULL OR "lastIncludedMessageId" > 0) AND (("kind" = 'dm') = ("guildId" IS NULL))
);

ALTER TABLE "DiscordReply" ADD CONSTRAINT "DiscordReply_identity_check" CHECK (
  "questionMessageId" > 0 AND "channelId" > 0 AND "discordUserId" > 0 AND ("guildId" IS NULL OR "guildId" > 0)
  AND ("statusMessageId" IS NULL OR "statusMessageId" > 0) AND ("answerMessageId" IS NULL OR "answerMessageId" > 0)
  AND char_length("authorName") >= 1
);
-- A refused question never started a run.
ALTER TABLE "DiscordReply" ADD CONSTRAINT "DiscordReply_refused_check" CHECK ("kind" <> 'refused' OR "runId" IS NULL);
ALTER TABLE "DiscordReply" ADD CONSTRAINT "DiscordReply_totals_check" CHECK (
  ("compactions" IS NULL OR "compactions" >= 0) AND ("subagents" IS NULL OR "subagents" >= 0)
  AND ("sources" IS NULL OR "sources" >= 0)
  AND ("mcpByServer" IS NULL OR jsonb_typeof("mcpByServer") = 'object')
);

ALTER TABLE "DiscordAnswerRating" ADD CONSTRAINT "DiscordAnswerRating_value_check"
  CHECK ("value" IN (-1, 1) AND "discordUserId" > 0);

ALTER TABLE "DiscordMonitoringKey" ADD CONSTRAINT "DiscordMonitoringKey_hash_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$');

-- The bot starts off and unconfigured; bootstrap repairs a missing row the same way.
INSERT INTO "DiscordBotControl" (
    "id",
    "enabled",
    "tokenGeneration",
    "version",
    "updatedAt"
) VALUES (
    'installation',
    false,
    0,
    1,
    CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;
