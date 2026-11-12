import { Prisma, type DiscordConversation, type PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Conversations (PRD D-14): one Discord thread, forum post, direct-message
 * channel, voice-channel chat or (when no thread could be opened) text channel
 * is one chat of the service account. The row names the chat and the owner,
 * whose composite key keeps the chat the service account's; deleting the chat
 * (or the account) takes the conversation and its questions with it.
 */

export type DiscordConversationKind = "thread" | "forum_post" | "dm" | "voice_chat" | "channel";

export type DiscordConversationRecord = Readonly<{
  id: string;
  discordChannelId: string;
  kind: DiscordConversationKind;
  guildId: string | null;
  parentChannelId: string | null;
  userId: string;
  chatId: string;
  botOpened: boolean;
  lastIncludedMessageId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
}>;

export type DiscordConversationCreate = Readonly<{
  discordChannelId: string;
  kind: DiscordConversationKind;
  guildId: string | null;
  parentChannelId: string | null;
  userId: string;
  chatId: string;
  botOpened: boolean;
  lastIncludedMessageId?: string | null;
  now: Date;
}>;

export type DiscordConversationStore = Readonly<{
  findByChannel(discordChannelId: string): Promise<DiscordConversationRecord | null>;
  findByChat(chatId: string): Promise<DiscordConversationRecord | null>;
  /** Creates the conversation, or answers the one another process created for the same channel first. */
  create(input: DiscordConversationCreate): Promise<Readonly<{ record: DiscordConversationRecord; created: boolean }>>;
  /** Moves the activity time and, when given, the last message the chat has read. */
  touch(input: Readonly<{ id: string; at: Date; lastIncludedMessageId?: string }>): Promise<void>;
  /** Conversations active since `since` (newest first) and every direct-message one, for the backfill after a new session. */
  listForBackfill(input: Readonly<{ since: Date; limit: number }>): Promise<DiscordConversationRecord[]>;
}>;

type ConversationClient = Pick<PrismaClient, "discordConversation">;

function snowflake(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

export function discordConversationRecord(row: DiscordConversation): DiscordConversationRecord {
  return {
    botOpened: row.botOpened,
    chatId: row.chatId,
    createdAt: row.createdAt,
    discordChannelId: row.discordChannelId.toString(),
    guildId: snowflake(row.guildId),
    id: row.id,
    kind: row.kind,
    lastActivityAt: row.lastActivityAt,
    lastIncludedMessageId: snowflake(row.lastIncludedMessageId),
    parentChannelId: snowflake(row.parentChannelId),
    userId: row.userId
  };
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createPrismaDiscordConversationStore(prisma: ConversationClient): DiscordConversationStore {
  async function findByChannel(discordChannelId: string): Promise<DiscordConversationRecord | null> {
    const row = await prisma.discordConversation.findUnique({ where: { discordChannelId: BigInt(discordChannelId) } })
      .catch(retainDatabaseFailure);
    return row ? discordConversationRecord(row) : null;
  }

  return Object.freeze({
    findByChannel,

    async findByChat(chatId) {
      const row = await prisma.discordConversation.findUnique({ where: { chatId } }).catch(retainDatabaseFailure);
      return row ? discordConversationRecord(row) : null;
    },

    async create(input) {
      try {
        const row = await prisma.discordConversation.create({
          data: {
            botOpened: input.botOpened,
            chatId: input.chatId,
            createdAt: input.now,
            discordChannelId: BigInt(input.discordChannelId),
            guildId: input.guildId === null ? null : BigInt(input.guildId),
            kind: input.kind,
            lastActivityAt: input.now,
            lastIncludedMessageId: input.lastIncludedMessageId ? BigInt(input.lastIncludedMessageId) : null,
            parentChannelId: input.parentChannelId === null ? null : BigInt(input.parentChannelId),
            userId: input.userId
          }
        });
        return { created: true, record: discordConversationRecord(row) };
      } catch (error) {
        if (!uniqueViolation(error)) retainDatabaseFailure(error);
        const existing = await findByChannel(input.discordChannelId);
        if (!existing) retainDatabaseFailure(error);
        return { created: false, record: existing };
      }
    },

    async touch(input) {
      await prisma.discordConversation.updateMany({
        data: {
          lastActivityAt: input.at,
          ...(input.lastIncludedMessageId ? { lastIncludedMessageId: BigInt(input.lastIncludedMessageId) } : {})
        },
        where: { id: input.id }
      }).catch(retainDatabaseFailure);
    },

    async listForBackfill(input) {
      const rows = await prisma.discordConversation.findMany({
        orderBy: { lastActivityAt: "desc" },
        take: Math.max(1, Math.min(input.limit, 500)),
        where: { OR: [{ lastActivityAt: { gte: input.since } }, { kind: "dm" }] }
      }).catch(retainDatabaseFailure);
      return rows.map(discordConversationRecord);
    }
  });
}
