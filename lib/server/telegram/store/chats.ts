import type { PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * The personal chats `/chats` offers: the user's own chats the web sidebar
 * lists (not archived, not Temporary, not waiting for deletion, outside
 * Projects), most recently active first, at most ten. Ids and titles only.
 */

export const TELEGRAM_RECENT_CHATS_LIMIT = 10;

export type TelegramRecentChat = Readonly<{ id: string; title: string }>;

export type TelegramChatListStore = Readonly<{
  recentPersonalChats(userId: string): Promise<readonly TelegramRecentChat[]>;
}>;

export function createPrismaTelegramChatListStore(prisma: Pick<PrismaClient, "chat">): TelegramChatListStore {
  return Object.freeze({
    async recentPersonalChats(userId: string) {
      return prisma.chat.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: { id: true, title: true },
        take: TELEGRAM_RECENT_CHATS_LIMIT,
        where: { archived: false, memoryMode: { not: "TEMPORARY" }, permanentDeletionAt: null, userId }
      }).catch(retainDatabaseFailure);
    }
  });
}
