import type { PrismaClient, TelegramRunLink } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Runs a Telegram message started (`TelegramRunLink`): the Telegram chat the
 * answer goes to and its delivery state. Delivery is claimed before anything
 * is sent (`pending` → `claimed`), so a restart never sends an answer twice: a
 * claim that never settled is ambiguous and is settled `unknown`, not retried.
 */

export type TelegramRunDeliveryState = "pending" | "claimed" | "delivered" | "failed" | "unknown";

export type TelegramRunLinkRecord = Readonly<{
  runId: string;
  userId: string;
  linkId: string;
  telegramChatId: number;
  draftId: number;
  statusMessageId: number | null;
  deliveryState: TelegramRunDeliveryState;
  deliveredAt: Date | null;
  createdAt: Date;
}>;

export type TelegramRunLinkStore = Readonly<{
  /** Records the run once; false when it already has a link. */
  create(input: Readonly<{
    draftId: number; linkId: string; now: Date; runId: string; telegramChatId: number; userId: string;
  }>): Promise<boolean>;
  find(runId: string): Promise<TelegramRunLinkRecord | null>;
  setStatusMessage(input: Readonly<{ runId: string; statusMessageId: number }>): Promise<void>;
  /** `pending` → `claimed`; true only for the one caller that may deliver. */
  claimDelivery(runId: string): Promise<boolean>;
  /** Settles a claimed delivery. */
  settle(input: Readonly<{ at: Date; runId: string; state: "delivered" | "failed" | "unknown" }>): Promise<void>;
  /** Oldest runs in one delivery state, for recovery sweeps. */
  listByState(input: Readonly<{ limit: number; state: "pending" | "claimed" }>): Promise<readonly TelegramRunLinkRecord[]>;
}>;

function record(row: TelegramRunLink): TelegramRunLinkRecord {
  return {
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    deliveryState: row.deliveryState,
    draftId: row.draftId,
    linkId: row.linkId,
    runId: row.runId,
    statusMessageId: row.statusMessageId === null ? null : Number(row.statusMessageId),
    telegramChatId: Number(row.telegramChatId),
    userId: row.userId
  };
}

export function createPrismaTelegramRunLinkStore(prisma: Pick<PrismaClient, "telegramRunLink">): TelegramRunLinkStore {
  return Object.freeze({
    async create(input) {
      const created = await prisma.telegramRunLink.createMany({
        data: [{
          createdAt: input.now, draftId: input.draftId, linkId: input.linkId, runId: input.runId,
          telegramChatId: BigInt(input.telegramChatId), userId: input.userId
        }],
        skipDuplicates: true
      }).catch(retainDatabaseFailure);
      return created.count === 1;
    },
    async find(runId) {
      const row = await prisma.telegramRunLink.findUnique({ where: { runId } }).catch(retainDatabaseFailure);
      return row ? record(row) : null;
    },
    async setStatusMessage(input) {
      await prisma.telegramRunLink.updateMany({
        data: { statusMessageId: BigInt(input.statusMessageId) }, where: { runId: input.runId }
      }).catch(retainDatabaseFailure);
    },
    async claimDelivery(runId) {
      const result = await prisma.telegramRunLink.updateMany({ data: { deliveryState: "claimed" }, where: { deliveryState: "pending", runId } })
        .catch(retainDatabaseFailure);
      return result.count === 1;
    },
    async settle(input) {
      await prisma.telegramRunLink.updateMany({
        data: { deliveredAt: input.state === "delivered" ? input.at : null, deliveryState: input.state },
        where: { deliveryState: "claimed", runId: input.runId }
      }).catch(retainDatabaseFailure);
    },
    async listByState(input) {
      const rows = await prisma.telegramRunLink.findMany({
        orderBy: [{ createdAt: "asc" }, { runId: "asc" }], take: Math.max(1, Math.min(input.limit, 500)),
        where: { deliveryState: input.state }
      }).catch(retainDatabaseFailure);
      return rows.map(record);
    }
  });
}
