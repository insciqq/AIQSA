-- Telegram Connect: the installation's one bot (a disabled singleton control
-- row with a write-only token envelope, access groups, the durable long-poll
-- offset and content-free health), one-time link codes kept only as hashes,
-- each user's Telegram link, claimed update receipts, inline button rows,
-- references from bot messages to the chats they carry, the runs Telegram
-- messages started, the outbox of scheduled results bound for Telegram and the
-- task switch that sends them. Rows hold identifiers, codes and times; a link
-- alone keeps its Telegram username and display name and loses them with it.
-- Expand only: previous-release writers never read or write the tables, and
-- the new task column defaults to off.

-- CreateEnum
CREATE TYPE "TelegramUpdateReceiptState" AS ENUM ('claimed', 'done', 'failed');

-- CreateEnum
CREATE TYPE "TelegramCallbackKind" AS ENUM ('approval_allow_once', 'approval_allow_server', 'approval_deny', 'select_chat', 'select_assistant', 'select_model', 'model_page', 'toggle_search', 'toggle_workspace', 'toggle_agent', 'stop_run', 'unlink_confirm', 'open_settings');

-- CreateEnum
CREATE TYPE "TelegramRunDeliveryState" AS ENUM ('pending', 'claimed', 'delivered', 'failed', 'unknown');

-- CreateEnum
CREATE TYPE "TelegramScheduledDeliveryState" AS ENUM ('pending', 'sent', 'failed', 'unknown', 'skipped');

-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN     "telegramNotify" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TelegramBotControl" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "tokenEnvelope" TEXT,
    "tokenGeneration" INTEGER NOT NULL DEFAULT 0,
    "botId" BIGINT,
    "botUsername" VARCHAR(64),
    "updateOffset" BIGINT,
    "lastPollAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureCode" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramBotControl_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TelegramBotControl_singleton_check" CHECK ("id" = 'installation'),
    CONSTRAINT "TelegramBotControl_version_check" CHECK ("version" >= 1),
    CONSTRAINT "TelegramBotControl_generation_check" CHECK ("tokenGeneration" >= 0),
    -- A stored token always names its generation and the bot getMe proved it
    -- belongs to; without a token there is no bot identity.
    CONSTRAINT "TelegramBotControl_token_check" CHECK (
        ("tokenEnvelope" IS NULL AND "botId" IS NULL AND "botUsername" IS NULL)
        OR ("tokenEnvelope" IS NOT NULL AND "tokenGeneration" >= 1 AND "botId" > 0 AND "botUsername" IS NOT NULL)
    ),
    CONSTRAINT "TelegramBotControl_enabled_check" CHECK (NOT "enabled" OR "tokenEnvelope" IS NOT NULL),
    CONSTRAINT "TelegramBotControl_offset_check" CHECK (
        "updateOffset" IS NULL OR ("updateOffset" >= 0 AND "botId" IS NOT NULL)
    ),
    CONSTRAINT "TelegramBotControl_failure_check" CHECK (("lastFailureAt" IS NULL) = ("lastFailureCode" IS NULL))
);

-- CreateTable
CREATE TABLE "TelegramBotGroup" (
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramBotGroup_pkey" PRIMARY KEY ("groupId")
);

-- CreateTable
CREATE TABLE "TelegramLinkCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authSessionId" TEXT NOT NULL,
    "botId" BIGINT NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TelegramLinkCode_hash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "TelegramLinkCode_expiry_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "TelegramLinkCode_bot_check" CHECK ("botId" > 0)
);

-- CreateTable
CREATE TABLE "TelegramLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" BIGINT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "telegramUsername" VARCHAR(64),
    "displayName" VARCHAR(128),
    "currentChatId" TEXT,
    "pendingAssistantId" TEXT,
    "selectedModelId" VARCHAR(256),
    "selectedProvider" VARCHAR(256),
    "searchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "workspaceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "agentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TelegramLink_bot_check" CHECK ("botId" > 0 AND "telegramUserId" > 0),
    -- Only private chats: their ids are positive, groups' and channels' negative.
    CONSTRAINT "TelegramLink_private_chat_check" CHECK ("telegramChatId" > 0),
    CONSTRAINT "TelegramLink_model_check" CHECK (("selectedModelId" IS NULL) = ("selectedProvider" IS NULL))
);

-- CreateTable
CREATE TABLE "TelegramUpdateReceipt" (
    "botId" BIGINT NOT NULL,
    "updateId" BIGINT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "state" "TelegramUpdateReceiptState" NOT NULL DEFAULT 'claimed',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramUpdateReceipt_pkey" PRIMARY KEY ("botId","updateId"),
    CONSTRAINT "TelegramUpdateReceipt_identity_check" CHECK ("botId" > 0 AND "updateId" >= 0),
    CONSTRAINT "TelegramUpdateReceipt_kind_check" CHECK ("kind" IN (
        'message', 'edited_message', 'callback_query', 'my_chat_member', 'stopped_message_generation', 'other', 'invalid'
    ))
);

-- CreateTable
CREATE TABLE "TelegramCallback" (
    "id" CHAR(22) NOT NULL,
    "linkId" TEXT NOT NULL,
    "kind" "TelegramCallbackKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramCallback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TelegramCallback_id_check" CHECK ("id" ~ '^[A-Za-z0-9_-]{22}$'),
    CONSTRAINT "TelegramCallback_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "TelegramCallback_expiry_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "TelegramMessageRef" (
    "botId" BIGINT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "telegramMessageId" BIGINT NOT NULL,
    "linkId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramMessageRef_pkey" PRIMARY KEY ("botId","telegramChatId","telegramMessageId"),
    CONSTRAINT "TelegramMessageRef_identity_check" CHECK ("botId" > 0 AND "telegramChatId" > 0 AND "telegramMessageId" > 0)
);

-- CreateTable
CREATE TABLE "TelegramRunLink" (
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "draftId" INTEGER NOT NULL,
    "statusMessageId" BIGINT,
    "deliveryState" "TelegramRunDeliveryState" NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramRunLink_pkey" PRIMARY KEY ("runId"),
    CONSTRAINT "TelegramRunLink_chat_check" CHECK ("telegramChatId" > 0 AND "draftId" <> 0),
    CONSTRAINT "TelegramRunLink_status_message_check" CHECK ("statusMessageId" IS NULL OR "statusMessageId" > 0),
    CONSTRAINT "TelegramRunLink_delivery_check" CHECK (("deliveryState" = 'delivered') = ("deliveredAt" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "TelegramScheduledDelivery" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "TelegramScheduledDeliveryState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailureCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "TelegramScheduledDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TelegramScheduledDelivery_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "TelegramScheduledDelivery_sent_check" CHECK (("state" = 'sent') = ("sentAt" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "TelegramBotControl_updatedByUserId_idx" ON "TelegramBotControl"("updatedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLinkCode_codeHash_key" ON "TelegramLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "TelegramLinkCode_expiresAt_consumedAt_idx" ON "TelegramLinkCode"("expiresAt", "consumedAt");

-- CreateIndex
CREATE INDEX "TelegramLinkCode_userId_authSessionId_idx" ON "TelegramLinkCode"("userId", "authSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLink_userId_key" ON "TelegramLink"("userId");

-- CreateIndex
CREATE INDEX "TelegramLink_botId_telegramChatId_idx" ON "TelegramLink"("botId", "telegramChatId");

-- CreateIndex
CREATE INDEX "TelegramLink_pendingAssistantId_idx" ON "TelegramLink"("pendingAssistantId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLink_id_userId_key" ON "TelegramLink"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLink_botId_telegramUserId_key" ON "TelegramLink"("botId", "telegramUserId");

-- CreateIndex
CREATE INDEX "TelegramUpdateReceipt_receivedAt_idx" ON "TelegramUpdateReceipt"("receivedAt");

-- CreateIndex
CREATE INDEX "TelegramCallback_linkId_idx" ON "TelegramCallback"("linkId");

-- CreateIndex
CREATE INDEX "TelegramCallback_expiresAt_idx" ON "TelegramCallback"("expiresAt");

-- CreateIndex
CREATE INDEX "TelegramMessageRef_linkId_userId_idx" ON "TelegramMessageRef"("linkId", "userId");

-- CreateIndex
CREATE INDEX "TelegramMessageRef_userId_chatId_idx" ON "TelegramMessageRef"("userId", "chatId");

-- CreateIndex
CREATE INDEX "TelegramMessageRef_chatId_messageId_idx" ON "TelegramMessageRef"("chatId", "messageId");

-- CreateIndex
CREATE INDEX "TelegramMessageRef_createdAt_idx" ON "TelegramMessageRef"("createdAt");

-- CreateIndex
CREATE INDEX "TelegramRunLink_linkId_userId_idx" ON "TelegramRunLink"("linkId", "userId");

-- CreateIndex
CREATE INDEX "TelegramRunLink_deliveryState_createdAt_idx" ON "TelegramRunLink"("deliveryState", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramScheduledDelivery_occurrenceId_key" ON "TelegramScheduledDelivery"("occurrenceId");

-- CreateIndex
CREATE INDEX "TelegramScheduledDelivery_state_nextAttemptAt_idx" ON "TelegramScheduledDelivery"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TelegramScheduledDelivery_userId_idx" ON "TelegramScheduledDelivery"("userId");

-- CreateIndex
CREATE INDEX "TelegramScheduledDelivery_createdAt_idx" ON "TelegramScheduledDelivery"("createdAt");

-- AddForeignKey
ALTER TABLE "TelegramBotControl" ADD CONSTRAINT "TelegramBotControl_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramBotGroup" ADD CONSTRAINT "TelegramBotGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: the creating session belongs to the code's user; ending the session ends the code.
ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_authSessionId_fkey" FOREIGN KEY ("userId", "authSessionId") REFERENCES "AuthSession"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: column-scoped SET NULL, so deleting the current chat never clears userId.
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_currentChatId_fkey" FOREIGN KEY ("userId", "currentChatId") REFERENCES "Chat"("userId", "id") ON DELETE SET NULL ("currentChatId") ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_pendingAssistantId_fkey" FOREIGN KEY ("pendingAssistantId") REFERENCES "AssistantDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramCallback" ADD CONSTRAINT "TelegramCallback_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "TelegramLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramMessageRef" ADD CONSTRAINT "TelegramMessageRef_linkId_userId_fkey" FOREIGN KEY ("linkId", "userId") REFERENCES "TelegramLink"("id", "userId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelegramMessageRef" ADD CONSTRAINT "TelegramMessageRef_userId_chatId_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelegramMessageRef" ADD CONSTRAINT "TelegramMessageRef_chatId_messageId_fkey" FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelegramRunLink" ADD CONSTRAINT "TelegramRunLink_userId_runId_fkey" FOREIGN KEY ("userId", "runId") REFERENCES "ModelRun"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelegramRunLink" ADD CONSTRAINT "TelegramRunLink_linkId_userId_fkey" FOREIGN KEY ("linkId", "userId") REFERENCES "TelegramLink"("id", "userId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelegramScheduledDelivery" ADD CONSTRAINT "TelegramScheduledDelivery_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "ScheduledTaskOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramScheduledDelivery" ADD CONSTRAINT "TelegramScheduledDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The bot starts off and unconfigured; bootstrap repairs a missing row the same way.
INSERT INTO "TelegramBotControl" (
    "id",
    "enabled",
    "restricted",
    "tokenGeneration",
    "version",
    "updatedAt"
) VALUES (
    'installation',
    false,
    false,
    0,
    1,
    CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;
