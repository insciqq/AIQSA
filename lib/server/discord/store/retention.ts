import type { PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Content-free Discord records past their retention, in bounded batches:
 * question rows (the journal) after 90 days, their ratings with them, and
 * monitoring keys 30 days after they were revoked. Conversations and their
 * chats are never deleted automatically (owner decision 2026-11-12, O-31). A
 * failing table never stops the other; the first failure is rethrown once
 * both were tried.
 */

const DAY_MS = 24 * 3_600_000;
export const DISCORD_RETENTION_MS = Object.freeze({
  replies: 90 * DAY_MS,
  revokedMonitoringKeys: 30 * DAY_MS
});
export const DISCORD_PRUNE_BATCH_ROWS = 500;
const PRUNE_MAX_BATCHES = 20;

type RetentionClient = Pick<PrismaClient, "$executeRaw">;

async function inBatches(prune: () => Promise<number>): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const count = await prune();
    deleted += count;
    if (count < DISCORD_PRUNE_BATCH_ROWS) break;
  }
  return deleted;
}

export async function deleteExpiredDiscordRecords(db: RetentionClient, now: Date): Promise<number> {
  const replies = new Date(now.getTime() - DISCORD_RETENTION_MS.replies);
  const keys = new Date(now.getTime() - DISCORD_RETENTION_MS.revokedMonitoringKeys);
  const rows = DISCORD_PRUNE_BATCH_ROWS;
  const prunes: readonly (() => Promise<number>)[] = [
    // Ratings cascade with their question.
    () => db.$executeRaw`
      DELETE FROM "DiscordReply" WHERE "questionMessageId" IN (
        SELECT "questionMessageId" FROM "DiscordReply" WHERE "receivedAt" < ${replies} ORDER BY "receivedAt" LIMIT ${rows}
      )`,
    () => db.$executeRaw`
      DELETE FROM "DiscordMonitoringKey" WHERE "id" IN (
        SELECT "id" FROM "DiscordMonitoringKey" WHERE "revokedAt" < ${keys} ORDER BY "revokedAt" LIMIT ${rows}
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
