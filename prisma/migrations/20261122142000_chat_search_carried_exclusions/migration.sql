-- Past-chat search keeps out what the old Memory kept out of history search, before
-- `20261122150000_drop_old_memory` drops the tables that said so. On v0.4.43 a message of an ordinary chat never
-- reached the history index, and so never the embedding model or a search, when:
--
-- 1. it was created at or before the owner cleared the history index or deleted all of Memory (a
--    `MemorySourceBarrier` of kind HISTORY_INDEX or ALL_REUSABLE);
-- 2. it was created at or before the chat's Resume (`ChatMemoryCheckpoint.resumeCreatedAtCutoff`: the old Resume
--    promised that only new messages would be used, and a branch copy inherited its source's cutoff);
-- 3. it was created while the owner had Memory or past-chat search paused (`MemoryPauseInterval` of scope MASTER or
--    SEARCH_HISTORY, both ends included; a pause still open covers everything up to this upgrade);
-- 4. the owner forgot it as a source (`MemorySuppression` of scope SOURCE_MESSAGE, from forgetting a recalled chat
--    source or a fact it supported), or an unexpired suppression of scope ALL stood.
--
-- Each such user or assistant message of a chat that may be searched again (Normal, not fenced for permanent
-- deletion) gets a `ChatSearchExcludedMessage` row; the indexer builds no passage for a turn with one, and
-- `read_past_chat` never shows it. The rows are carried more strictly than the old code honoured them in two corners:
-- a forgotten source stays out after a later branch change too (the old code dropped it with the branch generation),
-- and a suppression that would have expired stays for good (no release wrote one with an expiry). An Excluded chat
-- gets no rows: it becomes searchable only through Resume, whose disclosure now says that its whole history becomes
-- searchable, and Resume removes the chat's rows (`lib/server/chats/prismaRepository.ts`). Temporary chats are never
-- searchable, and scheduled task prompts stay out by their own mark. The old tables are only read.

-- CreateTable
CREATE TABLE "ChatSearchExcludedMessage" (
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ChatSearchExcludedMessage_pkey" PRIMARY KEY ("chatId","messageId")
);

-- AddForeignKey: the owner is the chat's owner; the account's deletion reaches these rows through its chats.
ALTER TABLE "ChatSearchExcludedMessage" ADD CONSTRAINT "ChatSearchExcludedMessage_userId_chatId_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey: a row goes with its message (its branch, its chat).
ALTER TABLE "ChatSearchExcludedMessage" ADD CONSTRAINT "ChatSearchExcludedMessage_chatId_messageId_fkey" FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Carry the exclusions.
INSERT INTO "ChatSearchExcludedMessage" ("chatId", "messageId", "userId")
SELECT message."chatId", message."id", chat."userId"
FROM "Message" AS message
INNER JOIN "Chat" AS chat ON chat."id" = message."chatId"
WHERE chat."userId" IS NOT NULL
  AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
  AND chat."permanentDeletionAt" IS NULL
  AND message."role" IN ('user', 'assistant')
  AND (
    EXISTS (
      SELECT 1 FROM "MemorySourceBarrier" AS barrier
      WHERE barrier."userId" = chat."userId"
        AND barrier."kind" IN ('HISTORY_INDEX'::"MemorySourceBarrierKind", 'ALL_REUSABLE'::"MemorySourceBarrierKind")
        AND NOT barrier."explicitOverrideAllowed"
        AND message."createdAt" <= barrier."sourceCreatedAtCutoff"
    )
    OR EXISTS (
      SELECT 1 FROM "ChatMemoryCheckpoint" AS checkpoint
      WHERE checkpoint."userId" = chat."userId" AND checkpoint."chatId" = chat."id"
        AND message."createdAt" <= checkpoint."resumeCreatedAtCutoff"
    )
    OR EXISTS (
      SELECT 1 FROM "MemoryPauseInterval" AS pause
      WHERE pause."userId" = chat."userId"
        AND pause."scope" IN ('MASTER'::"MemoryPauseScope", 'SEARCH_HISTORY'::"MemoryPauseScope")
        AND message."createdAt" >= pause."pausedAt"
        AND (pause."resumedAt" IS NULL OR message."createdAt" <= pause."resumedAt")
    )
    OR EXISTS (
      SELECT 1 FROM "MemorySuppression" AS suppression
      WHERE suppression."userId" = chat."userId"
        AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
        AND (
          suppression."scope" = 'ALL'::"MemorySuppressionScope"
          OR (suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND suppression."sourceChatId" = message."chatId" AND suppression."sourceMessageId" = message."id")
        )
    )
  );
