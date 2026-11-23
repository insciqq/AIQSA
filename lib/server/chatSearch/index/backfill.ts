import { Prisma, type PrismaClient } from "@prisma/client";
import type { ChatSearchEmbedder } from "../embedder";
import { chatSearchEligibleWhere } from "../eligibility";
import { chatSearchOwnerEmbeddingSql } from "./ownerEmbedding";

/**
 * The bounded background sweep that lets the index fill and heal itself, run every
 * `CHAT_SEARCH_BACKFILL_PASS_INTERVAL_MS` by the worker:
 *
 * - backfill: eligible chats without a state get one, most recently changed first, so an upgraded installation (or
 *   a chat whose mark was lost) is indexed without anyone asking;
 * - vectors: while the embedding role is usable, indexed chats holding passages without a vector of that role are
 *   marked, which covers a role that became usable again (a fixed credential), a pass that stopped midway and an
 *   owner who turned Memory or past-chat search back on; only owners who allow vectors now (`./ownerEmbedding.ts`)
 *   are swept, so another owner's chats are not marked again and again;
 * - leftovers: indexed chats that may no longer be indexed are marked, so the pass clears them even when the caller
 *   that changed them did not.
 *
 * Every mark is at background priority (`./dirty.ts`), so new turns are still indexed first.
 */

/** How often the worker runs this sweep. */
export const CHAT_SEARCH_BACKFILL_PASS_INTERVAL_MS = 60_000;

export const CHAT_SEARCH_BACKFILL_LIMITS: Readonly<{ newChats: number; staleChats: number; leftoverChats: number }> =
  Object.freeze({ leftoverChats: 100, newChats: 200, staleChats: 100 });

export type ChatSearchBackfillSummary = Readonly<{
  /** Chats that got their first state. */
  added: number;
  /** Indexed chats marked to get vectors of the current role. */
  vectors: number;
  /** Indexed chats marked to be cleared. */
  leftovers: number;
  /** A bound was reached: more is waiting for the next sweep. */
  more: boolean;
}>;

export type ChatSearchBackfillInput = Readonly<{
  db: PrismaClient;
  embedder: Pick<ChatSearchEmbedder, "currentModel">;
  limits?: Partial<typeof CHAT_SEARCH_BACKFILL_LIMITS> & Readonly<{ ownerIds?: readonly string[] }>;
}>;

/** The eligibility rule (`../eligibility.ts`) for every owner rather than one. */
function eligibleChatWhere(): Prisma.ChatWhereInput {
  const { userId: _owner, ...rule } = chatSearchEligibleWhere("");
  void _owner;
  return rule;
}

const BACKGROUND_PRIORITY = Prisma.sql`LEAST(chat."updatedAt", clock_timestamp()::timestamp(3))`;

async function markAtBackground(db: PrismaClient, chatIds: readonly string[]): Promise<number> {
  if (chatIds.length === 0) return 0;
  return db.$executeRaw`
    UPDATE "ChatSearchState" AS state SET
      "dirtyAt" = CASE WHEN state."dirtyAt" IS NULL THEN ${BACKGROUND_PRIORITY}
        ELSE state."dirtyAt" + interval '1 millisecond' END,
      "nextAttemptAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT "chatId" FROM "ChatSearchState" WHERE "chatId" = ANY(${[...chatIds]}::text[]) ORDER BY "chatId" FOR UPDATE
    ) AS locked, "Chat" AS chat
    WHERE state."chatId" = locked."chatId" AND chat."id" = state."chatId"`;
}

export async function runChatSearchBackfillPass(input: ChatSearchBackfillInput): Promise<ChatSearchBackfillSummary> {
  const limits = { ...CHAT_SEARCH_BACKFILL_LIMITS, ...input.limits };
  const owners = limits.ownerIds ? [...limits.ownerIds] : null;
  const { db } = input;

  const candidates = await db.chat.findMany({
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
    take: limits.newChats,
    where: { ...eligibleChatWhere(), searchStates: { none: {} }, ...(owners ? { userId: { in: owners } } : {}) }
  });
  const added = candidates.length === 0 ? 0 : await db.$executeRaw`
    INSERT INTO "ChatSearchState" ("chatId", "userId", "dirtyAt", "updatedAt")
    SELECT chat."id", chat."userId", ${BACKGROUND_PRIORITY}, CURRENT_TIMESTAMP
    FROM "Chat" AS chat
    WHERE chat."id" = ANY(${candidates.map((chat) => chat.id)}::text[])
    ON CONFLICT ("chatId") DO NOTHING`;

  let vectors = 0;
  let staleFound = 0;
  const model = await input.embedder.currentModel().catch(() => null);
  if (model?.kind === "model") {
    const ownerFilter = owners ? Prisma.sql`AND state."userId" = ANY(${owners}::text[])` : Prisma.empty;
    const stale = await db.$queryRaw<Array<{ chatId: string }>>`
      SELECT state."chatId" FROM "ChatSearchState" AS state
      WHERE state."dirtyAt" IS NULL ${ownerFilter}
        AND ${chatSearchOwnerEmbeddingSql(Prisma.sql`state."userId"`)}
        AND EXISTS (
          SELECT 1 FROM "ChatSearchPassage" AS passage
          WHERE passage."chatId" = state."chatId"
            AND (passage."embedding" IS NULL OR passage."embeddingProviderModelId" IS DISTINCT FROM ${model.providerModelId})
        )
      ORDER BY state."chatId"
      LIMIT ${limits.staleChats}`;
    staleFound = stale.length;
    vectors = await markAtBackground(db, stale.map((row) => row.chatId));
  }

  const leftoverRows = await db.chatSearchState.findMany({
    orderBy: { chatId: "asc" },
    select: { chatId: true },
    take: limits.leftoverChats,
    where: { chat: { NOT: eligibleChatWhere() }, dirtyAt: null, ...(owners ? { userId: { in: owners } } : {}) }
  });
  const leftovers = await markAtBackground(db, leftoverRows.map((row) => row.chatId));

  return {
    added,
    leftovers,
    more: candidates.length >= limits.newChats || staleFound >= limits.staleChats || leftoverRows.length >= limits.leftoverChats,
    vectors
  };
}
