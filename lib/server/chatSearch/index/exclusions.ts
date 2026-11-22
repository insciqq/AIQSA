import type { Prisma } from "@prisma/client";

/**
 * Messages past-chat search never holds (`ChatSearchExcludedMessage`): the old Memory's exclusions, carried once by
 * `prisma/migrations/20261122142000_chat_search_carried_exclusions/migration.sql`. The indexer leaves their turns out
 * (`./prismaStore.ts`) and `read_past_chat` never shows them (`../search/read.ts`). Only two writers touch the rows,
 * each inside the caller's transaction after it locked or created the chat: a branch copies them with its messages,
 * and Resume removes them, because its disclosure says the whole chat becomes searchable.
 */

type Statement = Pick<Prisma.TransactionClient, "$executeRaw">;

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
