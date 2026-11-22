import type { Prisma } from "@prisma/client";

/**
 * Messages past-chat search never holds (`ChatSearchExcludedMessage`): the old Memory's exclusions, carried once by
 * `prisma/migrations/20261122142000_chat_search_carried_exclusions/migration.sql`. The indexer leaves their turns out
 * (`./prismaStore.ts`) and `read_past_chat` never shows their turns either (`chatSearchWithheldMessages`,
 * `../search/read.ts`). Only two writers touch the rows,
 * each inside the caller's transaction after it locked or created the chat: a branch copies them with its messages,
 * and Resume removes them, because its disclosure says the whole chat becomes searchable.
 */

type Statement = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * The messages of a branch search withholds: each excluded message, and both messages of a turn (an answer and the
 * question it answers) when either is excluded, as the indexer makes no passage of such a turn and v0.4.43 kept the
 * whole pair out. An answer often repeats its question's words, so showing it would bring a forgotten question back.
 * `path` is the branch's message ids; `messages` holds each one's role and stored parent, before any read omits
 * server-written turns, so an answer to an omitted wake-up still counts as that wake-up's.
 */
export function chatSearchWithheldMessages(
  path: readonly string[],
  messages: ReadonlyMap<string, Readonly<{ role: string; parentMessageId: string | null }>>,
  excluded: ReadonlySet<string>
): ReadonlySet<string> {
  const withheld = new Set<string>();
  for (const id of path) {
    if (excluded.has(id)) withheld.add(id);
    const message = messages.get(id);
    if (message?.role !== "assistant" || message.parentMessageId === null) continue;
    const question = messages.get(message.parentMessageId);
    if (question?.role !== "user" || !(excluded.has(id) || excluded.has(message.parentMessageId))) continue;
    withheld.add(id);
    withheld.add(message.parentMessageId);
  }
  return withheld;
}

/**
 * A branch copy keeps out what its source kept out: each copied message whose source message is excluded is excluded
 * too. `copies` pairs each source message id with its copy's id; the copy chat must be the same owner's.
 */
export async function copyChatSearchExclusions(
  tx: Statement,
  input: Readonly<{
    userId: string;
    sourceChatId: string;
    copyChatId: string;
    copies: ReadonlyArray<readonly [sourceMessageId: string, copyMessageId: string]>;
  }>
): Promise<number> {
  if (input.copies.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO "ChatSearchExcludedMessage" ("chatId", "messageId", "userId")
    SELECT ${input.copyChatId}, pair.copy, ${input.userId}
    FROM unnest(
      ${input.copies.map(([source]) => source)}::text[],
      ${input.copies.map(([, copy]) => copy)}::text[]
    ) AS pair(source, copy)
    INNER JOIN "ChatSearchExcludedMessage" AS excluded
      ON excluded."chatId" = ${input.sourceChatId} AND excluded."messageId" = pair.source
        AND excluded."userId" = ${input.userId}
    ON CONFLICT ("chatId", "messageId") DO NOTHING`;
}

/** The owner resumed the chat after the disclosure that its whole history becomes searchable: nothing stays out. */
export async function clearChatSearchExclusions(tx: Statement, input: Readonly<{ chatId: string }>): Promise<number> {
  return tx.$executeRaw`DELETE FROM "ChatSearchExcludedMessage" WHERE "chatId" = ${input.chatId}`;
}
