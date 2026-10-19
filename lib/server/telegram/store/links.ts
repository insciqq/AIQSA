import type { PrismaClient, TelegramLink } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Users' Telegram links. A link is the only row holding a Telegram username
 * and display name; ids cross this boundary as numbers (Telegram's ids fit
 * 52 bits), never into logs.
 */

export type TelegramLinkRecord = Readonly<{
  id: string;
  userId: string;
  botId: number;
  telegramUserId: number;
  telegramChatId: number;
  telegramUsername: string | null;
  displayName: string | null;
  currentChatId: string | null;
  pendingAssistantId: string | null;
  selectedModelId: string | null;
  selectedProvider: string | null;
  searchEnabled: boolean;
  workspaceEnabled: boolean;
  agentEnabled: boolean;
  linkedAt: Date;
  lastSeenAt: Date;
}>;

/** What later features may change on a link: the chat it continues and its run settings. */
export type TelegramLinkPreferences = Partial<Readonly<{
  currentChatId: string | null;
  pendingAssistantId: string | null;
  selectedModel: Readonly<{ modelId: string; provider: string }> | null;
  searchEnabled: boolean;
  workspaceEnabled: boolean;
  agentEnabled: boolean;
}>>;

export type TelegramLinkStore = Readonly<{
  findByUserId(userId: string): Promise<TelegramLinkRecord | null>;
  findByTelegramUser(botId: number, telegramUserId: number): Promise<TelegramLinkRecord | null>;
  findByChat(botId: number, telegramChatId: number): Promise<TelegramLinkRecord | null>;
  /** Records activity at most once a minute. */
  touch(linkId: string, now: Date): Promise<void>;
  /** Changes the link only while it still is the one the caller read. */
  updatePreferences(linkId: string, preferences: TelegramLinkPreferences): Promise<boolean>;
}>;

const TOUCH_INTERVAL_MS = 60_000;

export function telegramLinkRecord(row: TelegramLink): TelegramLinkRecord {
  return {
    agentEnabled: row.agentEnabled,
    botId: Number(row.botId),
    currentChatId: row.currentChatId,
    displayName: row.displayName,
    id: row.id,
    lastSeenAt: row.lastSeenAt,
    linkedAt: row.linkedAt,
    pendingAssistantId: row.pendingAssistantId,
    searchEnabled: row.searchEnabled,
    selectedModelId: row.selectedModelId,
    selectedProvider: row.selectedProvider,
    telegramChatId: Number(row.telegramChatId),
    telegramUserId: Number(row.telegramUserId),
    telegramUsername: row.telegramUsername,
    userId: row.userId,
    workspaceEnabled: row.workspaceEnabled
  };
}

function safeId(value: number): bigint | null {
  return Number.isSafeInteger(value) ? BigInt(value) : null;
}

export function createPrismaTelegramLinkStore(prisma: Pick<PrismaClient, "telegramLink">): TelegramLinkStore {
  async function first(where: Parameters<typeof prisma.telegramLink.findFirst>[0]): Promise<TelegramLinkRecord | null> {
    const row = await prisma.telegramLink.findFirst(where).catch(retainDatabaseFailure);
    return row ? telegramLinkRecord(row) : null;
  }
  return Object.freeze({
    async findByUserId(userId: string) {
      const row = await prisma.telegramLink.findUnique({ where: { userId } }).catch(retainDatabaseFailure);
      return row ? telegramLinkRecord(row) : null;
    },
    async findByTelegramUser(botId: number, telegramUserId: number) {
      const bot = safeId(botId);
      const user = safeId(telegramUserId);
      if (bot === null || user === null) return null;
      const row = await prisma.telegramLink.findUnique({ where: { botId_telegramUserId: { botId: bot, telegramUserId: user } } })
        .catch(retainDatabaseFailure);
      return row ? telegramLinkRecord(row) : null;
    },
    async findByChat(botId: number, telegramChatId: number) {
      const bot = safeId(botId);
      const chat = safeId(telegramChatId);
      if (bot === null || chat === null || telegramChatId <= 0) return null;
      return first({ orderBy: { linkedAt: "desc" }, where: { botId: bot, telegramChatId: chat } });
    },
    async touch(linkId: string, now: Date) {
      await prisma.telegramLink.updateMany({
        data: { lastSeenAt: now }, where: { id: linkId, lastSeenAt: { lt: new Date(now.getTime() - TOUCH_INTERVAL_MS) } }
      }).catch(retainDatabaseFailure);
    },
    async updatePreferences(linkId: string, preferences: TelegramLinkPreferences) {
      const { selectedModel, ...rest } = preferences;
      const result = await prisma.telegramLink.updateMany({
        data: {
          ...rest,
          ...(selectedModel === undefined ? {} : {
            selectedModelId: selectedModel?.modelId ?? null, selectedProvider: selectedModel?.provider ?? null
          })
        },
        where: { id: linkId }
      }).catch(retainDatabaseFailure);
      return result.count === 1;
    }
  });
}
