import type { PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Content-free Telegram records past their retention, in bounded batches:
 * link codes a day after they expired or were used, update receipts after 7
 * days, buttons a day after they expired, message references after 90 days,
 * and settled scheduled deliveries after 30 days. A failing table never stops
 * the others; the first failure is rethrown once all were tried.
 */

const DAY_MS = 24 * 3_600_000;
export const TELEGRAM_RETENTION_MS = Object.freeze({
  callbacksAfterExpiry: DAY_MS,
  linkCodesAfterUse: DAY_MS,
  messageRefs: 90 * DAY_MS,
  receipts: 7 * DAY_MS,
  settledScheduledDeliveries: 30 * DAY_MS
});
export const TELEGRAM_PRUNE_BATCH_ROWS = 500;
const PRUNE_MAX_BATCHES = 20;

type RetentionClient = Pick<PrismaClient, "$executeRaw">;

async function inBatches(prune: () => Promise<number>): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const count = await prune();
    deleted += count;
    if (count < TELEGRAM_PRUNE_BATCH_ROWS) break;
  }
  return deleted;
}

export async function deleteExpiredTelegramRecords(db: RetentionClient, now: Date): Promise<number> {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const codes = before(TELEGRAM_RETENTION_MS.linkCodesAfterUse);
  const receipts = before(TELEGRAM_RETENTION_MS.receipts);
  const callbacks = before(TELEGRAM_RETENTION_MS.callbacksAfterExpiry);
  const refs = before(TELEGRAM_RETENTION_MS.messageRefs);
  const deliveries = before(TELEGRAM_RETENTION_MS.settledScheduledDeliveries);
  const rows = TELEGRAM_PRUNE_BATCH_ROWS;
  const prunes: readonly (() => Promise<number>)[] = [
    () => db.$executeRaw`
      DELETE FROM "TelegramLinkCode" WHERE "id" IN (
        SELECT "id" FROM "TelegramLinkCode" WHERE "expiresAt" < ${codes} OR "consumedAt" < ${codes} LIMIT ${rows}
      )`,
    () => db.$executeRaw`
      DELETE FROM "TelegramUpdateReceipt" WHERE ("botId", "updateId") IN (
        SELECT "botId", "updateId" FROM "TelegramUpdateReceipt" WHERE "receivedAt" < ${receipts} ORDER BY "receivedAt" LIMIT ${rows}
      )`,
    () => db.$executeRaw`
      DELETE FROM "TelegramCallback" WHERE "id" IN (
        SELECT "id" FROM "TelegramCallback" WHERE "expiresAt" < ${callbacks} ORDER BY "expiresAt" LIMIT ${rows}
      )`,
    () => db.$executeRaw`
      DELETE FROM "TelegramMessageRef" WHERE ("botId", "telegramChatId", "telegramMessageId") IN (
        SELECT "botId", "telegramChatId", "telegramMessageId" FROM "TelegramMessageRef"
        WHERE "createdAt" < ${refs} ORDER BY "createdAt" LIMIT ${rows}
      )`,
    () => db.$executeRaw`
      DELETE FROM "TelegramScheduledDelivery" WHERE "id" IN (
        SELECT "id" FROM "TelegramScheduledDelivery"
        WHERE "state" <> 'pending' AND "createdAt" < ${deliveries} ORDER BY "createdAt" LIMIT ${rows}
      )`
  ];
  let deleted = 0;
  let failure: unknown;
  for (const prune of prunes) {
    try {
      deleted += await inBatches(prune);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) retainDatabaseFailure(failure);
  return deleted;
}
