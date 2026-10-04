import { Prisma } from "@prisma/client";
import {
  CHAT_MESSAGE_MATCH_SNIPPET_CONTEXT,
  CHAT_MESSAGE_SEARCH_MIN_QUERY_LENGTH,
  type ChatMessageMatchWire
} from "../../contracts/chats";
import type { prisma } from "../prisma";

/**
 * Bound on one content query. A query matching a large share of an
 * installation's messages fails visibly instead of holding a connection while
 * the browser has already moved on to the next keystroke.
 */
export const MESSAGE_SEARCH_STATEMENT_TIMEOUT_MS = 5_000;
/** A cut edge drops its partial word only within this many characters. */
const SNIPPET_WORD_EDGE = 24;

export type MessageSearchClient = Pick<typeof prisma, "$transaction">;

/** Keyset position after a chat: the page continues with older chats. */
export type MessageMatchPosition = Readonly<{ id: string; updatedAt: string }>;

export type MessageMatchRecord = ChatMessageMatchWire & Readonly<{ chatUpdatedAt: Date }>;

type MessageMatchRow = {
  chatId: string;
  chatUpdatedAt: Date;
  createdAt: Date;
  excerpt: string;
  excerptStart: number;
  matchCount: number;
  matchPosition: number;
  messageId: string;
  textLength: number;
  title: string;
};

export function messageSearchEligible(query: string): boolean {
  return Array.from(query).length >= CHAT_MESSAGE_SEARCH_MIN_QUERY_LENGTH;
}

/** An ILIKE pattern that matches the query literally anywhere in the text. */
export function messageSearchPattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
}

/**
 * Plain readable snippet from the excerpt the database cut around the first
 * match (positions count characters, as PostgreSQL does): a cut edge drops
 * its partial word while the match stays whole and is marked with an
 * ellipsis; whitespace runs collapse to one space.
 */
export function messageMatchSnippet(input: Readonly<{
  excerpt: string;
  excerptStart: number;
  matchLength: number;
  matchOffset: number | null;
  textLength: number;
}>): string {
  const characters = Array.from(input.excerpt);
  const cutBefore = input.excerptStart > 1;
  const cutAfter = input.excerptStart - 1 + characters.length < input.textLength;
  const matchStart = input.matchOffset ?? 0;
  const matchEnd = input.matchOffset === null ? 0 : input.matchOffset + input.matchLength;
  let start = 0;
  let end = characters.length;
  if (cutBefore) {
    const space = characters.findIndex((character, index) =>
      index < Math.min(matchStart, SNIPPET_WORD_EDGE) && /\s/u.test(character));
    if (space >= 0) start = space + 1;
  }
  if (cutAfter) {
    for (let index = characters.length - 1; index >= Math.max(matchEnd, characters.length - SNIPPET_WORD_EDGE); index -= 1) {
      if (/\s/u.test(characters[index]!)) {
        end = index;
        break;
      }
    }
  }
  const body = characters.slice(start, end).join("").replace(/\s+/gu, " ").trim();
  return `${cutBefore ? "…" : ""}${body}${cutAfter ? "…" : ""}`;
}

function timeoutError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2010" &&
    typeof error.meta === "object" && error.meta !== null &&
    (error.meta as Record<string, unknown>).code === "57014";
}

/**
 * One result per chat of the sidebar scope (owner, not archived, not
 * Temporary, not pending permanent deletion) whose readable message text
 * contains the query on any branch: the newest matching message, the number
 * of matching messages, and an excerpt around the first match. Chats come
 * newest first, exactly as the title results, so one keyset continues them.
 * The trigram index over `aiqsa_message_search_text` serves the match.
 */
export async function findMessageMatches(
  client: MessageSearchClient,
  input: Readonly<{
    after: MessageMatchPosition | null;
    limit: number;
    query: string;
    userId: string;
  }>
): Promise<MessageMatchRecord[] | "timeout"> {
  const after = input.after
    ? Prisma.sql`AND (
        chat."updatedAt" < CAST(${input.after.updatedAt} AS timestamp(3))
        OR (chat."updatedAt" = CAST(${input.after.updatedAt} AS timestamp(3)) AND chat."id" < ${input.after.id})
      )`
    : Prisma.empty;
  let rows: MessageMatchRow[];
  try {
    rows = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(MESSAGE_SEARCH_STATEMENT_TIMEOUT_MS)}, true)`;
      return tx.$queryRaw<MessageMatchRow[]>(Prisma.sql`
        WITH matched AS (
          SELECT message."chatId", message."id", message."createdAt"
          FROM "Message" AS message
          INNER JOIN "Chat" AS chat ON chat."id" = message."chatId"
          WHERE chat."userId" = ${input.userId}
            AND chat."archived" = false
            AND chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
            AND chat."permanentDeletionAt" IS NULL
            ${after}
            AND aiqsa_message_search_text(message."content") ILIKE ${messageSearchPattern(input.query)} ESCAPE '\\'
        ),
        grouped AS (
          SELECT
            "chatId",
            count(*)::integer AS "matchCount",
            (array_agg("id" ORDER BY "createdAt" DESC, "id" DESC))[1] AS "messageId"
          FROM matched
          GROUP BY "chatId"
        ),
        page AS (
          SELECT grouped.*, chat."title", chat."updatedAt" AS "chatUpdatedAt"
          FROM grouped
          INNER JOIN "Chat" AS chat ON chat."id" = grouped."chatId"
          ORDER BY chat."updatedAt" DESC, chat."id" DESC
          LIMIT CAST(${input.limit} AS integer)
        )
        SELECT
          page."chatId",
          page."chatUpdatedAt",
          page."matchCount",
          page."messageId",
          page."title",
          message."createdAt",
          found."position" AS "matchPosition",
          char_length(found."text") AS "textLength",
          bounds."start" AS "excerptStart",
          substr(found."text", bounds."start", CASE
            WHEN found."position" = 0 THEN CAST(${CHAT_MESSAGE_MATCH_SNIPPET_CONTEXT * 2} AS integer)
            ELSE found."position" - bounds."start" + char_length(${input.query}) + CAST(${CHAT_MESSAGE_MATCH_SNIPPET_CONTEXT} AS integer)
          END) AS "excerpt"
        FROM page
        INNER JOIN "Message" AS message ON message."id" = page."messageId"
        CROSS JOIN LATERAL (
          SELECT body."text", strpos(lower(body."text"), lower(${input.query})) AS "position"
          FROM (SELECT aiqsa_message_search_text(message."content") AS "text") AS body
        ) AS found
        CROSS JOIN LATERAL (
          SELECT greatest(found."position" - CAST(${CHAT_MESSAGE_MATCH_SNIPPET_CONTEXT} AS integer), 1) AS "start"
        ) AS bounds
        ORDER BY page."chatUpdatedAt" DESC, page."chatId" DESC
      `);
    });
  } catch (error) {
    if (timeoutError(error)) return "timeout";
    throw error;
  }
  const matchLength = Array.from(input.query).length;
  return rows.map((row) => ({
    chatId: row.chatId,
    chatUpdatedAt: row.chatUpdatedAt,
    createdAt: row.createdAt.toISOString(),
    matchCount: row.matchCount,
    messageId: row.messageId,
    snippet: messageMatchSnippet({
      excerpt: row.excerpt,
      excerptStart: row.excerptStart,
      matchLength,
      // A case mapping PostgreSQL and the browser disagree on may hide the
      // position; the excerpt then starts at the beginning of the text.
      matchOffset: row.matchPosition > 0 ? row.matchPosition - row.excerptStart : null,
      textLength: row.textLength
    }),
    title: row.title
  }));
}
