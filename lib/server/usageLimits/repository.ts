import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminUsageGroupLimitsInput,
  AdminUsageInstallationLimitsInput,
  AdminUsageLimits,
  AdminUsageUserLimitsInput,
  UsageInstallationLimits,
  UsageLimitValues,
  UsageUserLimits
} from "../../contracts/usageLimits";
import {
  resolveEffectiveUsageLimits,
  USAGE_DAY_MS,
  USAGE_HOUR_MS,
  utcMonthPeriod,
  type UsageAdmissionFacts,
  type UsageLimitGroupInput,
  type UsageMessageWindow
} from "../../domain/usageLimits";

const INSTALLATION = "installation";

/**
 * Everything `decideUsageAdmission` reads besides the run itself: add
 * `interactive` and `now`. `installationSpentMicros` is only read against a
 * cap, so it stays 0 without one instead of summing the whole month.
 */
export type UsageLimitStatus = Omit<UsageAdmissionFacts, "interactive" | "now">;

export type UsageLimitsRepository = Readonly<{
  /** Removes a user's override; `false` when the user does not exist. */
  deleteUserLimits(input: Readonly<{ targetUserId: string }>): Promise<boolean>;
  loadUsageLimitStatus(userId: string, now: Date): Promise<UsageLimitStatus>;
  /** Replaces a group's allowance (all fields unset removes it); `false` when the group does not exist. */
  putGroupLimits(input: Readonly<{ groupId: string; limits: AdminUsageGroupLimitsInput; userId: string }>): Promise<boolean>;
  /** Replaces a user's override (nothing set and not exempt removes it); `false` when the user does not exist. */
  putUserLimits(input: Readonly<{ limits: AdminUsageUserLimitsInput; targetUserId: string; userId: string }>): Promise<boolean>;
  readAdminUsageLimits(now: Date): Promise<AdminUsageLimits>;
  /** `null` when `expectedVersion` is no longer current. */
  updateInstallation(input: AdminUsageInstallationLimitsInput & Readonly<{ userId: string }>):
    Promise<UsageInstallationLimits | null>;
}>;

type Database = Pick<
  PrismaClient,
  "$executeRaw" | "$queryRaw" | "$transaction" | "group" | "modelRun" | "usageLimit" | "usageLimitPolicy" | "user"
>;
type Reader = Pick<Prisma.TransactionClient, "usageLimitPolicy">;
type Month = ReturnType<typeof utcMonthPeriod>;

type StoredValues = Readonly<{
  messagesPerDay: number | null;
  messagesPerHour: number | null;
  monthlyBudgetMicros: bigint | null;
}>;

const valueSelect = { messagesPerDay: true, messagesPerHour: true, monthlyBudgetMicros: true } as const;
const UNSET: UsageLimitValues = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };

/** What the migration inserts: no limits. A missing singleton reads as this row. */
const DEFAULT_INSTALLATION: UsageInstallationLimits = { ...UNSET, monthlyCapMicros: null, version: 1 };

// BigInt columns are bounded by database checks far below 2^53.
function micros(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function limitValues(row: StoredValues): UsageLimitValues {
  return {
    messagesPerDay: row.messagesPerDay,
    messagesPerHour: row.messagesPerHour,
    monthlyBudgetMicros: micros(row.monthlyBudgetMicros)
  };
}

function nothingSet(values: UsageLimitValues): boolean {
  return values.messagesPerDay === null && values.messagesPerHour === null && values.monthlyBudgetMicros === null;
}

function spentMicros(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.min(Math.max(0, Number(value)), Number.MAX_SAFE_INTEGER);
}

/** Prisma stores `DateTime` as UTC `timestamp(3)`; compare in UTC whatever the session time zone is. */
function utcTimestamp(value: Date): Prisma.Sql {
  return Prisma.sql`(${value}::timestamptz AT TIME ZONE 'UTC')`;
}

async function readInstallation(db: Reader): Promise<UsageInstallationLimits> {
  const row = await db.usageLimitPolicy.findUnique({
    select: { ...valueSelect, monthlyCapMicros: true, version: true },
    where: { id: INSTALLATION }
  });
  if (!row) return DEFAULT_INSTALLATION;
  return { ...limitValues(row), monthlyCapMicros: micros(row.monthlyCapMicros), version: row.version };
}

function missingParent(error: unknown): boolean {
  // A group or user deleted between the existence check and the write.
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2003" || error.code === "P2025");
}

/** The user's interactive runs (scheduled ones excluded) in `(now - length, now]`. */
function interactiveRuns(userId: string, now: Date, length: number): Prisma.ModelRunWhereInput {
  return { createdAt: { gt: new Date(now.getTime() - length), lte: now }, scheduledTaskId: null, userId };
}

export function createUsageLimitsRepository(database: Database): UsageLimitsRepository {
  /** Known estimated cost in the month; usage without a known price adds nothing. */
  async function knownCost(month: Month, userId: string | null): Promise<number> {
    const [row] = await database.$queryRaw<Array<{ spent: bigint | null }>>`
      SELECT COALESCE(SUM("estimatedCostMicros"), 0)::bigint AS "spent"
      FROM "UsageEvent"
      WHERE "createdAt" >= ${utcTimestamp(month.periodStart)} AND "createdAt" < ${utcTimestamp(month.resetsAt)}
        ${userId === null ? Prisma.empty : Prisma.sql`AND "userId" = ${userId}`}`;
    return spentMicros(row?.spent);
  }

  /**
   * When a reached window next has room: the run at ascending offset
   * `count - limit` ages out. Only for a set limit above zero.
   */
  async function messageWindow(
    where: Prisma.ModelRunWhereInput,
    count: number,
    limit: number | null,
    length: number
  ): Promise<UsageMessageWindow> {
    if (limit === null || limit <= 0 || count < limit) return { count, freesAt: null };
    const agingOut = await database.modelRun.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { createdAt: true },
      skip: count - limit,
      where
    });
    return { count, freesAt: agingOut ? new Date(agingOut.createdAt.getTime() + length) : null };
  }

  return {
    async loadUsageLimitStatus(userId, now) {
      const month = utcMonthPeriod(now);
      const hour = interactiveRuns(userId, now, USAGE_HOUR_MS);
      const day = interactiveRuns(userId, now, USAGE_DAY_MS);
      const [installation, user, userSpentMicros, hourCount, dayCount] = await Promise.all([
        readInstallation(database),
        database.user.findUnique({
          select: {
            groups: {
              select: { group: { select: { id: true, name: true, usageLimit: { select: valueSelect } } } },
              // Archived groups grant nothing; groups without an allowance do not participate.
              where: { group: { archivedAt: null, usageLimit: { isNot: null } } }
            },
            usageLimit: { select: { ...valueSelect, exempt: true } }
          },
          where: { id: userId }
        }),
        knownCost(month, userId),
        database.modelRun.count({ where: hour }),
        database.modelRun.count({ where: day })
      ]);
      const groups: UsageLimitGroupInput[] = (user?.groups ?? []).flatMap(({ group }) =>
        group.usageLimit ? [{ groupId: group.id, limits: limitValues(group.usageLimit), name: group.name }] : []);
      const override: UsageUserLimits | null = user?.usageLimit
        ? { ...limitValues(user.usageLimit), exempt: user.usageLimit.exempt, userId }
        : null;
      const effective = resolveEffectiveUsageLimits({ groups, installation, user: override });
      const [installationSpentMicros, lastHour, lastDay] = await Promise.all([
        installation.monthlyCapMicros === null ? 0 : knownCost(month, null),
        messageWindow(hour, hourCount, effective.messagesPerHour.value, USAGE_HOUR_MS),
        messageWindow(day, dayCount, effective.messagesPerDay.value, USAGE_DAY_MS)
      ]);
      return {
        effective,
        installationCapMicros: installation.monthlyCapMicros,
        installationSpentMicros,
        lastDay,
        lastHour,
        userSpentMicros
      };
    },

    async readAdminUsageLimits(now) {
      const { periodStart, resetsAt } = utcMonthPeriod(now);
      const hourStart = new Date(now.getTime() - USAGE_HOUR_MS);
      const dayStart = new Date(now.getTime() - USAGE_DAY_MS);
      const [installation, groupRows, userRows, spendRows, messageRows] = await Promise.all([
        readInstallation(database),
        database.group.findMany({
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: {
            _count: { select: { users: true } },
            archivedAt: true,
            id: true,
            name: true,
            usageLimit: { select: valueSelect }
          }
        }),
        database.user.findMany({
          orderBy: [{ displayName: "asc" }, { id: "asc" }],
          select: {
            displayName: true,
            email: true,
            groups: { select: { groupId: true } },
            id: true,
            status: true,
            usageLimit: { select: { ...valueSelect, exempt: true } }
          }
        }),
        database.$queryRaw<Array<{ spent: bigint | null; userId: string }>>`
          SELECT "userId", COALESCE(SUM("estimatedCostMicros"), 0)::bigint AS "spent"
          FROM "UsageEvent"
          WHERE "createdAt" >= ${utcTimestamp(periodStart)} AND "createdAt" < ${utcTimestamp(resetsAt)}
          GROUP BY "userId"`,
        // One indexed (userId, createdAt) range per user instead of a scan of every run.
        database.$queryRaw<Array<{ lastDay: number; lastHour: number; userId: string }>>`
          SELECT account."id" AS "userId", runs."lastHour", runs."lastDay"
          FROM "User" AS account
          CROSS JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE run."createdAt" > ${utcTimestamp(hourStart)})::int AS "lastHour",
              COUNT(*)::int AS "lastDay"
            FROM "ModelRun" AS run
            WHERE run."userId" = account."id" AND run."scheduledTaskId" IS NULL
              AND run."createdAt" > ${utcTimestamp(dayStart)} AND run."createdAt" <= ${utcTimestamp(now)}
          ) AS runs
          WHERE runs."lastDay" > 0`
      ]);
      const spentByUser = new Map(spendRows.map((row) => [row.userId, spentMicros(row.spent)]));
      const messagesByUser = new Map(messageRows.map((row) => [row.userId, row]));
      const activeGroupLimits = new Map<string, UsageLimitGroupInput>();
      for (const group of groupRows) {
        if (group.archivedAt === null && group.usageLimit) {
          activeGroupLimits.set(group.id, { groupId: group.id, limits: limitValues(group.usageLimit), name: group.name });
        }
      }
      let installationSpentMicros = 0;
      for (const spent of spentByUser.values()) installationSpentMicros += spent;
      return {
        groups: groupRows.map((group) => ({
          ...(group.usageLimit ? limitValues(group.usageLimit) : UNSET),
          archivedAt: group.archivedAt?.toISOString() ?? null,
          groupId: group.id,
          memberCount: group._count.users,
          name: group.name
        })),
        installation,
        installationSpentMicros: Math.min(installationSpentMicros, Number.MAX_SAFE_INTEGER),
        periodStart: periodStart.toISOString(),
        resetsAt: resetsAt.toISOString(),
        users: userRows.map((user) => {
          const override: UsageUserLimits | null = user.usageLimit
            ? { ...limitValues(user.usageLimit), exempt: user.usageLimit.exempt, userId: user.id }
            : null;
          const groups = user.groups.flatMap(({ groupId }) => activeGroupLimits.get(groupId) ?? []);
          const messages = messagesByUser.get(user.id);
          return {
            displayName: user.displayName.trim() ? user.displayName : user.email || "Unnamed user",
            effective: resolveEffectiveUsageLimits({ groups, installation, user: override }),
            email: user.email || null,
            messagesLastDay: messages?.lastDay ?? 0,
            messagesLastHour: messages?.lastHour ?? 0,
            monthSpentMicros: spentByUser.get(user.id) ?? 0,
            override,
            status: user.status,
            userId: user.id
          };
        })
      };
    },

    async updateInstallation({ expectedVersion, userId, ...limits }) {
      return database.$transaction(async (tx) => {
        // The migration inserts the singleton; recreate it with its defaults if it went missing.
        await tx.$executeRaw`
          INSERT INTO "UsageLimitPolicy" ("id", "updatedAt") VALUES (${INSTALLATION}, CURRENT_TIMESTAMP)
          ON CONFLICT ("id") DO NOTHING`;
        const updated = await tx.usageLimitPolicy.updateMany({
          data: {
            messagesPerDay: limits.messagesPerDay,
            messagesPerHour: limits.messagesPerHour,
            monthlyBudgetMicros: limits.monthlyBudgetMicros,
            monthlyCapMicros: limits.monthlyCapMicros,
            updatedByUserId: userId,
            version: { increment: 1 }
          },
          where: { id: INSTALLATION, version: expectedVersion }
        });
        return updated.count === 1 ? readInstallation(tx) : null;
      });
    },

    async putGroupLimits({ groupId, limits, userId }) {
      const values: UsageLimitValues = {
        messagesPerDay: limits.messagesPerDay,
        messagesPerHour: limits.messagesPerHour,
        monthlyBudgetMicros: limits.monthlyBudgetMicros
      };
      try {
        return await database.$transaction(async (tx) => {
          if (!await tx.group.findUnique({ select: { id: true }, where: { id: groupId } })) return false;
          if (nothingSet(values)) {
            await tx.usageLimit.deleteMany({ where: { groupId } });
          } else {
            await tx.usageLimit.upsert({
              create: { ...values, groupId, updatedByUserId: userId },
              update: { ...values, updatedByUserId: userId },
              where: { groupId }
            });
          }
          return true;
        });
      } catch (error) {
        if (missingParent(error)) return false;
        throw error;
      }
    },

    async putUserLimits({ limits, targetUserId, userId }) {
      const values: UsageLimitValues & { exempt: boolean } = {
        exempt: limits.exempt,
        messagesPerDay: limits.messagesPerDay,
        messagesPerHour: limits.messagesPerHour,
        monthlyBudgetMicros: limits.monthlyBudgetMicros
      };
      try {
        return await database.$transaction(async (tx) => {
          if (!await tx.user.findUnique({ select: { id: true }, where: { id: targetUserId } })) return false;
          if (!values.exempt && nothingSet(values)) {
            await tx.usageLimit.deleteMany({ where: { userId: targetUserId } });
          } else {
            await tx.usageLimit.upsert({
              create: { ...values, updatedByUserId: userId, userId: targetUserId },
              update: { ...values, updatedByUserId: userId },
              where: { userId: targetUserId }
            });
          }
          return true;
        });
      } catch (error) {
        if (missingParent(error)) return false;
        throw error;
      }
    },

    async deleteUserLimits({ targetUserId }) {
      if (!await database.user.findUnique({ select: { id: true }, where: { id: targetUserId } })) return false;
      await database.usageLimit.deleteMany({ where: { userId: targetUserId } });
      return true;
    }
  };
}
