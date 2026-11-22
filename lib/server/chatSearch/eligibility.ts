import { Prisma } from "@prisma/client";

/**
 * Which chats past-chat search may index and return: the owner's own ordinary
 * chats. Temporary and Excluded chats, imported chats (and their
 * continuations, which stay Excluded), scheduled-task chats, Discord chats and
 * chats fenced for permanent deletion are never indexed or returned
 * (operator decision 2026-11-22). A NORMAL chat never carries a Temporary
 * deadline (`Chat_memory_state_check`). The indexer and the search tools share this
 * one rule so a chat cannot be searchable by one and unreadable by the other.
 */
export type ChatSearchEligibilityFields = Readonly<{
  userId: string | null;
  memoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  importSource: string | null;
  scheduledTaskId: string | null;
  permanentDeletionAt: Date | null;
  /** True when the chat carries a Discord conversation. */
  discord: boolean;
}>;

/** The rule on a loaded chat row. */
export function chatSearchEligible(chat: ChatSearchEligibilityFields, ownerId: string): boolean {
  return chat.userId === ownerId &&
    chat.memoryMode === "NORMAL" &&
    chat.importSource === null &&
    chat.scheduledTaskId === null &&
    chat.permanentDeletionAt === null &&
    !chat.discord;
}

/** The fields `chatSearchEligible` needs, as a Prisma `select`. */
export const chatSearchEligibilitySelect = {
  userId: true,
  memoryMode: true,
  importSource: true,
  scheduledTaskId: true,
  permanentDeletionAt: true,
  discordConversations: { select: { id: true }, take: 1 }
} as const satisfies Prisma.ChatSelect;

/** Maps a row loaded with `chatSearchEligibilitySelect` to the rule's fields. */
export function chatSearchEligibilityFields(row: Readonly<{
  userId: string | null;
  memoryMode: ChatSearchEligibilityFields["memoryMode"];
  importSource: string | null;
  scheduledTaskId: string | null;
  permanentDeletionAt: Date | null;
  discordConversations: ReadonlyArray<unknown>;
}>): ChatSearchEligibilityFields {
  return {
    userId: row.userId,
    memoryMode: row.memoryMode,
    importSource: row.importSource,
    scheduledTaskId: row.scheduledTaskId,
    permanentDeletionAt: row.permanentDeletionAt,
    discord: row.discordConversations.length > 0
  };
}

/** The rule as a Prisma `where` on `Chat` for one owner. */
export function chatSearchEligibleWhere(ownerId: string): Prisma.ChatWhereInput {
  return {
    userId: ownerId,
    memoryMode: "NORMAL",
    importSource: null,
    scheduledTaskId: null,
    permanentDeletionAt: null,
    discordConversations: { none: {} }
  };
}

/**
 * The rule as a raw SQL predicate over a `"Chat"` alias, for the search
 * queries. `alias` is a fixed identifier chosen by the caller, never input.
 */
export function chatSearchEligibleSql(alias: "c", ownerId: string): Prisma.Sql {
  const chat = Prisma.raw(`"${alias}"`);
  return Prisma.sql`${chat}."userId" = ${ownerId}
    AND ${chat}."memoryMode" = 'NORMAL'::"MemoryChatMode"
    AND ${chat}."importSource" IS NULL
    AND ${chat}."scheduledTaskId" IS NULL
    AND ${chat}."permanentDeletionAt" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "DiscordConversation" d WHERE d."chatId" = ${chat}."id")`;
}
