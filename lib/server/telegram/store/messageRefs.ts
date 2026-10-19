import type { PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Which AIQSA chat (and message) a bot message carried, so a reply to it
 * continues that chat. Kept 90 days; the link's, chat's or message's deletion
 * removes them.
 */

export type TelegramMessageRefOwner = Readonly<{
  linkId: string;
  userId: string;
  chatId: string;
  messageId?: string | null;
}>;

export type TelegramMessageRef = TelegramMessageRefOwner & Readonly<{
  botId: number;
  telegramChatId: number;
  telegramMessageId: number;
}>;

export type TelegramMessageRefStore = Readonly<{
  record(refs: readonly TelegramMessageRef[], now: Date): Promise<void>;
  find(input: Readonly<{ botId: number; telegramChatId: number; telegramMessageId: number }>): Promise<
    Readonly<{ linkId: string; userId: string; chatId: string; messageId: string | null }> | null
  >;
}>;

function valid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createPrismaTelegramMessageRefStore(prisma: Pick<PrismaClient, "telegramMessageRef">): TelegramMessageRefStore {
  return Object.freeze({
    async record(refs: readonly TelegramMessageRef[], now: Date) {
      const rows = refs.filter((ref) => valid(ref.botId) && valid(ref.telegramChatId) && valid(ref.telegramMessageId));
      if (rows.length === 0) return;
      await prisma.telegramMessageRef.createMany({
        data: rows.map((ref) => ({
          botId: BigInt(ref.botId),
          chatId: ref.chatId,
          createdAt: now,
          linkId: ref.linkId,
          messageId: ref.messageId ?? null,
          telegramChatId: BigInt(ref.telegramChatId),
          telegramMessageId: BigInt(ref.telegramMessageId),
          userId: ref.userId
        })),
        skipDuplicates: true
      }).catch(retainDatabaseFailure);
    },

    async find(input) {
      if (!valid(input.botId) || !valid(input.telegramChatId) || !valid(input.telegramMessageId)) return null;
      const row = await prisma.telegramMessageRef.findUnique({
        select: { chatId: true, linkId: true, messageId: true, userId: true },
        where: {
          botId_telegramChatId_telegramMessageId: {
            botId: BigInt(input.botId), telegramChatId: BigInt(input.telegramChatId), telegramMessageId: BigInt(input.telegramMessageId)
          }
        }
      }).catch(retainDatabaseFailure);
      return row;
    }
  });
}
