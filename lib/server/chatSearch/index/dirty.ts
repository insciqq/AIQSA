import { Prisma } from "@prisma/client";
import { chatSearchEligibleSql } from "../eligibility";

/**
 * How the rest of the application tells the index that a chat changed. Each function is one or two statements that
 * read no message content and are safe inside the caller's transaction; the background pass (`./pass.ts`) does the
 * work. Call them after the chat row is locked or written in the same transaction (run settlement, message edits and
 * deletions, mode and title changes lock the chat first), never before taking the chat row `FOR UPDATE`: the pass
 * locks the chat row before the state row, and the opposite order could deadlock with it.
 *
 * A mark moves `dirtyAt` forward, always: it is the chat's version for the pass (`./store.ts`). An interactive mark
 * carries the current time, so a new turn is claimed before background work; a background mark (backfill,
 * re-embedding) keeps an earlier time, the chat's last change, so recent chats go first.
 */

type Statement = Pick<Prisma.TransactionClient, "$executeRaw">;

/** The current time as the `timestamp(3)` columns hold it, in the database's clock. */
const NOW = Prisma.sql`clock_timestamp()::timestamp(3)`;

/**
 * A chat's searchable content changed: an answer settled, a message was edited, regenerated, deleted or its branch
 * switched, the title changed, or the chat became eligible again (resumed from Excluded). Creates the chat's state
 * when the chat may be indexed; an ineligible chat is marked only when it still has a state, so the pass clears it.
 * A chat that is missing or not the user's is left alone.
 */
export async function markChatSearchDirty(
  tx: Statement,
  input: Readonly<{ userId: string; chatId: string }>
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "ChatSearchState" ("chatId", "userId", "dirtyAt", "updatedAt")
    SELECT c."id", c."userId", ${NOW}, CURRENT_TIMESTAMP
    FROM "Chat" AS c
    WHERE c."id" = ${input.chatId} AND c."userId" = ${input.userId}
      AND ((${chatSearchEligibleSql("c", input.userId)})
        OR EXISTS (SELECT 1 FROM "ChatSearchState" AS state WHERE state."chatId" = c."id"))
    ON CONFLICT ("chatId") DO UPDATE SET
      "dirtyAt" = GREATEST(EXCLUDED."dirtyAt", "ChatSearchState"."dirtyAt" + interval '1 millisecond'),
      "nextAttemptAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP`;
}

/**
 * The chat may no longer be searched: it became Excluded or Temporary, or it is being deleted for good. Its passages
 * and its state go now, in the caller's transaction (the state row first, as the pass takes them). Turning the
 * user's Memory or past-chat search switch off is not a reason: the switches gate the tools and keep the index.
 */
export async function clearChatSearch(tx: Statement, input: Readonly<{ chatId: string }>): Promise<void> {
  await tx.$executeRaw`DELETE FROM "ChatSearchState" WHERE "chatId" = ${input.chatId}`;
  await tx.$executeRaw`DELETE FROM "ChatSearchPassage" WHERE "chatId" = ${input.chatId}`;
}

/**
 * The owner saved or changed a secret: every indexed chat of theirs is rebuilt, so passages holding the value get it
 * redacted. Only passages whose text changes are embedded again.
 */
export async function markOwnerChatsSearchDirty(tx: Statement, input: Readonly<{ userId: string }>): Promise<number> {
  return tx.$executeRaw`
    UPDATE "ChatSearchState" AS state SET
      "dirtyAt" = GREATEST(${NOW}, state."dirtyAt" + interval '1 millisecond'),
      "nextAttemptAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT "chatId" FROM "ChatSearchState" WHERE "userId" = ${input.userId} ORDER BY "chatId" FOR UPDATE
    ) AS locked
    WHERE state."chatId" = locked."chatId"`;
}

/**
 * The past-chat embedding role changed (set, replaced or cleared): every chat with passages is marked, at background
 * priority, so the pass embeds each passage that lacks a vector of the new role, once; vectors already of that role
 * are kept, so calling this again embeds nothing twice. Word search keeps working throughout: texts are untouched
 * and search uses only vectors of the current role.
 */
export async function scheduleChatSearchReembedding(db: Statement): Promise<number> {
  return db.$executeRaw`
    UPDATE "ChatSearchState" AS state SET
      "dirtyAt" = CASE WHEN state."dirtyAt" IS NULL THEN LEAST(chat."updatedAt", ${NOW})
        ELSE state."dirtyAt" + interval '1 millisecond' END,
      "nextAttemptAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT candidate."chatId" FROM "ChatSearchState" AS candidate
      WHERE EXISTS (SELECT 1 FROM "ChatSearchPassage" AS passage WHERE passage."chatId" = candidate."chatId")
      ORDER BY candidate."chatId" FOR UPDATE
    ) AS locked, "Chat" AS chat
    WHERE state."chatId" = locked."chatId" AND chat."id" = state."chatId"`;
}
