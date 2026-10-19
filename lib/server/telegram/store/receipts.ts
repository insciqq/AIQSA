import type { PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { TELEGRAM_CONTROL_ID } from "../control/repository";

/**
 * Update receipts: an update is claimed (one row per bot and update id) before
 * anything handles it, so a second poller sharing the database, a redelivered
 * batch or a restart never handles it again; a claimed update that never
 * finished stays unfinished. The stored offset moves past a batch only in the
 * transaction that claims it.
 */

export const TELEGRAM_UPDATE_KINDS = [
  "message", "edited_message", "callback_query", "my_chat_member", "stopped_message_generation", "other", "invalid"
] as const;
export type TelegramUpdateKind = (typeof TELEGRAM_UPDATE_KINDS)[number];

export type TelegramUpdateClaim = Readonly<{ updateId: number; kind: TelegramUpdateKind }>;

export type TelegramReceiptStore = Readonly<{
  /** The stored offset of `botId`, or null when none is stored for that bot. */
  readOffset(botId: number): Promise<number | null>;
  /**
   * Claims the batch's updates and advances `botId`'s stored offset to
   * `nextOffset` in one transaction; returns the ids this call claimed.
   */
  claimBatch(input: Readonly<{ botId: number; nextOffset: number; updates: readonly TelegramUpdateClaim[] }>): Promise<ReadonlySet<number>>;
  /** Claims one update without moving the offset (test injection). */
  claim(input: Readonly<{ botId: number; update: TelegramUpdateClaim }>): Promise<boolean>;
  finish(input: Readonly<{ botId: number; state: "done" | "failed"; updateId: number }>): Promise<void>;
}>;

type ReceiptClient = Pick<PrismaClient, "$transaction" | "telegramBotControl" | "telegramUpdateReceipt">;

export function createPrismaTelegramReceiptStore(prisma: ReceiptClient): TelegramReceiptStore {
  return Object.freeze({
    async readOffset(botId: number) {
      const row = await prisma.telegramBotControl.findUnique({
        select: { botId: true, updateOffset: true }, where: { id: TELEGRAM_CONTROL_ID }
      }).catch(retainDatabaseFailure);
      return row && row.botId !== null && Number(row.botId) === botId && row.updateOffset !== null ? Number(row.updateOffset) : null;
    },

    async claimBatch(input) {
      return prisma.$transaction(async (tx) => {
        const created = input.updates.length === 0 ? [] : await tx.telegramUpdateReceipt.createManyAndReturn({
          data: input.updates.map((update) => ({ botId: BigInt(input.botId), kind: update.kind, updateId: BigInt(update.updateId) })),
          select: { updateId: true },
          skipDuplicates: true
        }).catch(retainDatabaseFailure);
        await tx.telegramBotControl.updateMany({
          data: { updateOffset: BigInt(input.nextOffset) },
          where: {
            botId: BigInt(input.botId),
            id: TELEGRAM_CONTROL_ID,
            OR: [{ updateOffset: null }, { updateOffset: { lt: BigInt(input.nextOffset) } }]
          }
        }).catch(retainDatabaseFailure);
        return new Set(created.map((row) => Number(row.updateId)));
      }).catch(retainDatabaseFailure);
    },

    async claim(input) {
      const created = await prisma.telegramUpdateReceipt.createMany({
        data: [{ botId: BigInt(input.botId), kind: input.update.kind, updateId: BigInt(input.update.updateId) }],
        skipDuplicates: true
      }).catch(retainDatabaseFailure);
      return created.count === 1;
    },

    async finish(input) {
      await prisma.telegramUpdateReceipt.updateMany({
        data: { state: input.state },
        where: { botId: BigInt(input.botId), state: "claimed", updateId: BigInt(input.updateId) }
      }).catch(retainDatabaseFailure);
    }
  });
}
