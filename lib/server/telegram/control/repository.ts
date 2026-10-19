import { Prisma, type PrismaClient, type TelegramBotControl } from "@prisma/client";
import type { TelegramHealthCode } from "../../../contracts/telegram";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * The installation's Telegram control row and its access groups. Every
 * administrator write locks the row, refuses a stale `expectedVersion` and
 * bumps the version; poll health and offsets never bump it, so polling never
 * makes an administrator's next edit stale.
 */

export const TELEGRAM_CONTROL_ID = "installation";

export type TelegramControlRecord = Readonly<{
  enabled: boolean;
  restricted: boolean;
  groupIds: readonly string[];
  tokenEnvelope: string | null;
  tokenGeneration: number;
  botId: number | null;
  botUsername: string | null;
  lastPollAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  version: number;
}>;

export type TelegramControlWrite =
  | Readonly<{ kind: "ok"; record: TelegramControlRecord }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "token_missing" }>
  | Readonly<{ kind: "groups_invalid" }>;

export type TelegramControlRepository = Readonly<{
  read(): Promise<TelegramControlRecord>;
  /**
   * Stores a token getMe proved for `botId`. `seal` encrypts it for the next
   * generation inside the row lock. Another bot restarts the poll offset;
   * health starts over either way.
   */
  saveToken(input: Readonly<{
    actorUserId: string; botId: number; botUsername: string; expectedVersion: number; seal(generation: number): string;
  }>): Promise<TelegramControlWrite>;
  setEnabled(input: Readonly<{ actorUserId: string; enabled: boolean; expectedVersion: number }>): Promise<TelegramControlWrite>;
  /** Replaces the access mode and groups; every group must exist and not be archived. */
  setAccess(input: Readonly<{
    actorUserId: string; expectedVersion: number; groupIds: readonly string[]; restricted: boolean;
  }>): Promise<TelegramControlWrite>;
  /** Poll health of the bot `botId` names; a poller of a replaced bot writes nothing. */
  recordPollHealth(input: Readonly<{ at: Date; botId: number; failureCode: TelegramHealthCode | null; success: boolean }>): Promise<void>;
}>;

type ControlClient = Pick<PrismaClient, "$transaction" | "telegramBotControl">;

function toNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

export function telegramControlRecord(row: TelegramBotControl, groupIds: readonly string[]): TelegramControlRecord {
  return {
    botId: toNumber(row.botId),
    botUsername: row.botUsername,
    enabled: row.enabled,
    groupIds: [...groupIds].sort(),
    lastFailureAt: row.lastFailureAt,
    lastFailureCode: row.lastFailureCode,
    lastPollAt: row.lastPollAt,
    lastSuccessAt: row.lastSuccessAt,
    restricted: row.restricted,
    tokenEnvelope: row.tokenEnvelope,
    tokenGeneration: row.tokenGeneration,
    version: row.version
  };
}

async function lockControl(tx: Prisma.TransactionClient): Promise<TelegramBotControl> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TelegramBotControl" WHERE "id" = ${TELEGRAM_CONTROL_ID} FOR UPDATE`)
    .catch(retainDatabaseFailure);
  const row = await tx.telegramBotControl.findUnique({ where: { id: TELEGRAM_CONTROL_ID } }).catch(retainDatabaseFailure);
  if (!row) throw new Error("telegram_control_missing");
  return row;
}

async function groupIdsOf(tx: Pick<Prisma.TransactionClient, "telegramBotGroup">): Promise<string[]> {
  const groups = await tx.telegramBotGroup.findMany({ select: { groupId: true } }).catch(retainDatabaseFailure);
  return groups.map((group) => group.groupId);
}

export function createPrismaTelegramControlRepository(
  prisma: ControlClient & Pick<PrismaClient, "telegramBotGroup">
): TelegramControlRepository {
  async function write(
    work: (tx: Prisma.TransactionClient, current: TelegramBotControl) => Promise<TelegramControlWrite | Prisma.TelegramBotControlUncheckedUpdateInput>,
    expectedVersion: number
  ): Promise<TelegramControlWrite> {
    return prisma.$transaction(async (tx) => {
      const current = await lockControl(tx);
      if (current.version !== expectedVersion) return { kind: "stale" } as const;
      const data = await work(tx, current);
      if ("kind" in data) return data as TelegramControlWrite;
      const updated = await tx.telegramBotControl.update({
        data: { ...data, version: { increment: 1 } }, where: { id: TELEGRAM_CONTROL_ID }
      }).catch(retainDatabaseFailure);
      return { kind: "ok", record: telegramControlRecord(updated, await groupIdsOf(tx)) } as const;
    }).catch(retainDatabaseFailure);
  }

  return {
    async read() {
      const [row, groupIds] = await Promise.all([
        prisma.telegramBotControl.findUnique({ where: { id: TELEGRAM_CONTROL_ID } }).catch(retainDatabaseFailure),
        groupIdsOf(prisma)
      ]);
      if (!row) throw new Error("telegram_control_missing");
      return telegramControlRecord(row, groupIds);
    },

    saveToken(input) {
      return write(async (_tx, current) => {
        const generation = current.tokenGeneration + 1;
        const sameBot = current.botId !== null && Number(current.botId) === input.botId;
        return {
          botId: BigInt(input.botId),
          botUsername: input.botUsername,
          lastFailureAt: null,
          lastFailureCode: null,
          lastPollAt: null,
          lastSuccessAt: null,
          tokenEnvelope: input.seal(generation),
          tokenGeneration: generation,
          updatedByUserId: input.actorUserId,
          // Update ids belong to one bot: another bot starts from Telegram's oldest pending update.
          ...(sameBot ? {} : { updateOffset: null })
        };
      }, input.expectedVersion);
    },

    setEnabled(input) {
      return write(async (_tx, current) => {
        if (input.enabled && current.tokenEnvelope === null) return { kind: "token_missing" } as const;
        return { enabled: input.enabled, updatedByUserId: input.actorUserId };
      }, input.expectedVersion);
    },

    setAccess(input) {
      return write(async (tx) => {
        const unique = [...new Set(input.groupIds)];
        if (unique.length !== input.groupIds.length) return { kind: "groups_invalid" } as const;
        if (unique.length > 0) {
          const found = await tx.group.count({ where: { archivedAt: null, id: { in: unique } } }).catch(retainDatabaseFailure);
          if (found !== unique.length) return { kind: "groups_invalid" } as const;
        }
        await tx.telegramBotGroup.deleteMany({ where: { groupId: { notIn: unique } } }).catch(retainDatabaseFailure);
        if (unique.length > 0) {
          await tx.telegramBotGroup.createMany({ data: unique.map((groupId) => ({ groupId })), skipDuplicates: true })
            .catch(retainDatabaseFailure);
        }
        return { restricted: input.restricted, updatedByUserId: input.actorUserId };
      }, input.expectedVersion);
    },

    async recordPollHealth(input) {
      const data: Prisma.TelegramBotControlUpdateManyMutationInput = input.success
        ? { lastPollAt: input.at, lastSuccessAt: input.at }
        : input.failureCode
          ? { lastFailureAt: input.at, lastFailureCode: input.failureCode, lastPollAt: input.at }
          : { lastPollAt: input.at };
      await prisma.telegramBotControl.updateMany({ data, where: { botId: BigInt(input.botId), id: TELEGRAM_CONTROL_ID } })
        .catch(retainDatabaseFailure);
    }
  };
}
