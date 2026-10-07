import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminUsageGroupLimitsInput,
  AdminUsageInstallationLimitsInput,
  AdminUsageLimits,
  AdminUsageUserLimitsInput,
  AdminUsageUserOverride,
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
 * `interactive` and `now`. Spend and message counts are read only when a
 * limit could refuse: `installationSpentMicros` stays 0 without a pooled cap,
 * and a user no per-user limit applies to reads 0 spend and empty windows.
 */
export type UsageLimitStatus = Omit<UsageAdmissionFacts, "interactive" | "now">;

/**
 * A versioned group or user save: `stale` when the row's version is not the
 * expected one (`null` expects no row), `not_found` when the group or user
 * does not exist.
 */
export type UsageLimitWriteResult = "not_found" | "stale" | "written";

export type UsageLimitsRepository = Readonly<{
  /** Removes a user's override saved at `expectedVersion` (`null` expects none: nothing to do). */
  deleteUserLimits(input: Readonly<{ expectedVersion: number | null; targetUserId: string }>): Promise<UsageLimitWriteResult>;
  loadUsageLimitStatus(userId: string, now: Date): Promise<UsageLimitStatus>;
  /** Replaces a group's allowance (all fields unset removes it). */
  putGroupLimits(input: Readonly<{ groupId: string; limits: AdminUsageGroupLimitsInput; userId: string }>):
    Promise<UsageLimitWriteResult>;
  /** Replaces a user's override (nothing set and not exempt removes it). */
  putUserLimits(input: Readonly<{ limits: AdminUsageUserLimitsInput; targetUserId: string; userId: string }>):
    Promise<UsageLimitWriteResult>;
  readAdminUsageLimits(now: Date): Promise<AdminUsageLimits>;
  /** `null` when `expectedVersion` is no longer current. */
  updateInstallation(input: AdminUsageInstallationLimitsInput & Readonly<{ userId: string }>):
    Promise<UsageInstallationLimits | null>;
}>;

type Database = Pick<
  PrismaClient,
  "$executeRaw" | "$queryRaw" | "$transaction" | "group" | "usageLimit" | "usageLimitPolicy" | "usageMessageAdmission" | "user"
>;
type Reader = Pick<Prisma.TransactionClient, "usageLimitPolicy">;
type Writer = Pick<Prisma.TransactionClient, "$queryRaw" | "usageLimit">;
type Month = ReturnType<typeof utcMonthPeriod>;
type Target = Readonly<{ groupId: string }> | Readonly<{ userId: string }>;

type StoredValues = Readonly<{
  messagesPerDay: number | null;
  messagesPerHour: number | null;
  monthlyBudgetMicros: bigint | null;
}>;

const valueSelect = { messagesPerDay: true, messagesPerHour: true, monthlyBudgetMicros: true } as const;
const UNSET: UsageLimitValues = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };

/** What the migration inserts: no limits. A missing singleton reads as this row. */
const DEFAULT_INSTALLATION: UsageInstallationLimits = { ...UNSET, monthlyCapMicros: null, version: 1 };

const NO_MESSAGES: UsageMessageWindow = { count: 0, freesAt: null };

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

type InstallationRow = StoredValues & Readonly<{ monthlyCapMicros: bigint | null; version: number }>;

function installationLimits(row: InstallationRow | null): UsageInstallationLimits {
  if (!row) return DEFAULT_INSTALLATION;
  return { ...limitValues(row), monthlyCapMicros: micros(row.monthlyCapMicros), version: row.version };
}

async function readInstallation(db: Reader): Promise<UsageInstallationLimits> {
  return installationLimits(await db.usageLimitPolicy.findUnique({
    select: { ...valueSelect, monthlyCapMicros: true, version: true },
    where: { id: INSTALLATION }
  }));
}

/** Nothing installation-wide can refuse anyone. */
function installationUnlimited(installation: UsageInstallationLimits): boolean {
  return installation.monthlyCapMicros === null && nothingSet(installation);
}

type AdmissionGateRow = Omit<InstallationRow, "version"> & Readonly<{ limited: boolean; version: number | null }>;

/**
 * Admission's first read, one statement: the installation singleton and
 * whether any per-user row applies to the user (an override, even an exempt
 * one, or an allowance of an active group they belong to).
 */
async function readAdmissionGate(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string
): Promise<Readonly<{ installation: UsageInstallationLimits; limited: boolean }>> {
  const [row] = await db.$queryRaw<AdmissionGateRow[]>`
    SELECT policy."monthlyCapMicros", policy."monthlyBudgetMicros", policy."messagesPerHour", policy."messagesPerDay",
      policy."version",
      (EXISTS (SELECT 1 FROM "UsageLimit" AS own WHERE own."userId" = ${userId})
        OR EXISTS (
          SELECT 1
          FROM "UserGroup" AS membership
          JOIN "Group" AS team ON team."id" = membership."groupId" AND team."archivedAt" IS NULL
          JOIN "UsageLimit" AS allowance ON allowance."groupId" = team."id"
          WHERE membership."userId" = ${userId}
        )) AS "limited"
    FROM (SELECT 1) AS anchor
    LEFT JOIN "UsageLimitPolicy" AS policy ON policy."id" = ${INSTALLATION}`;
  const version = row?.version ?? null;
  return {
    installation: row && version !== null ? installationLimits({ ...row, version }) : DEFAULT_INSTALLATION,
    limited: row?.limited === true
  };
}

/**
 * Applies a versioned save to one group or user row: a row is created only
 * when none is expected, and changed or removed only at the expected version.
 * Every insert and change takes the next value of the column's sequence, so
 * versions never repeat across a removal and a new row.
 */
async function writeVersionedLimit(
  tx: Writer,
  target: Target,
  expectedVersion: number | null,
  values: (UsageLimitValues & { exempt?: boolean }) | null,
  updatedByUserId: string | null
): Promise<"stale" | "written"> {
  if (values === null) {
    if (expectedVersion === null) {
      return await tx.usageLimit.findUnique({ select: { id: true }, where: target }) ? "stale" : "written";
    }
    const removed = await tx.usageLimit.deleteMany({ where: { ...target, version: expectedVersion } });
    return removed.count === 1 ? "written" : "stale";
  }
  if (expectedVersion === null) {
    // The target is unique: a row someone else created first is a conflict, not an overwrite.
    const created = await tx.usageLimit.createMany({
      data: [{ ...values, ...target, updatedByUserId }],
      skipDuplicates: true
    });
    return created.count === 1 ? "written" : "stale";
  }
  const [next] = await tx.$queryRaw<Array<{ version: number }>>`
    SELECT nextval(pg_get_serial_sequence('"UsageLimit"', 'version'))::int AS "version"`;
  if (!next) throw new Error("usage_limit_version_unavailable");
  const updated = await tx.usageLimit.updateMany({
    data: { ...values, updatedByUserId, version: next.version },
    where: { ...target, version: expectedVersion }
  });
  return updated.count === 1 ? "written" : "stale";
}

function missingParent(error: unknown): boolean {
  // A group or user deleted between the existence check and the write.
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2003" || error.code === "P2025");
}

/**
 * Admission log rows are kept this long: the day window plus an hour of slack
 * for clock differences between the run's creation and a later count.
 */
export const USAGE_MESSAGE_ADMISSION_RETENTION_MS = USAGE_DAY_MS + USAGE_HOUR_MS;

/**
 * Records one admitted interactive run (a send, edit or regeneration; never a
 * scheduled run or a continuation of an accepted one) for the message limits.
 * Call it in the transaction that creates the run, with the run's creation
 * time, so the row commits or rolls back with it. The user's rows that no
 * window counts anymore are pruned on the way.
 */
export async function recordUsageMessageAdmission(
  tx: Pick<Prisma.TransactionClient, "usageMessageAdmission">,
  input: Readonly<{ at: Date; userId: string }>
): Promise<void> {
  await tx.usageMessageAdmission.deleteMany({
    where: { createdAt: { lt: new Date(input.at.getTime() - USAGE_MESSAGE_ADMISSION_RETENTION_MS) }, userId: input.userId }
  });
  await tx.usageMessageAdmission.create({ data: { createdAt: input.at, userId: input.userId } });
}

/**
 * The user's admitted interactive runs in `(now - length, now]`. The log
 * survives chat and branch deletion, unlike the runs themselves.
 */
function admittedMessages(userId: string, now: Date, length: number): Prisma.UsageMessageAdmissionWhereInput {
  return { createdAt: { gt: new Date(now.getTime() - length), lte: now }, userId };
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
   * When a reached window next has room: the admission at ascending offset
   * `count - limit` ages out. Only for a set limit above zero.
   */
  async function messageWindow(
    where: Prisma.UsageMessageAdmissionWhereInput,
    count: number,
    limit: number | null,
    length: number
  ): Promise<UsageMessageWindow> {
    if (limit === null || limit <= 0 || count < limit) return { count, freesAt: null };
    const agingOut = await database.usageMessageAdmission.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { createdAt: true },
      skip: count - limit,
      where
    });
    return { count, freesAt: agingOut ? new Date(agingOut.createdAt.getTime() + length) : null };
  }

  return {
    async loadUsageLimitStatus(userId, now) {
      const { installation, limited } = await readAdmissionGate(database, userId);
      if (!limited && installationUnlimited(installation)) {
        // Nothing can refuse this user: no spend sums, no message counts.
        return {
          effective: resolveEffectiveUsageLimits({ groups: [], installation, user: null }),
          installationCapMicros: null,
          installationSpentMicros: 0,
          lastDay: NO_MESSAGES,
          lastHour: NO_MESSAGES,
          userSpentMicros: 0
        };
      }
      const month = utcMonthPeriod(now);
      const hour = admittedMessages(userId, now, USAGE_HOUR_MS);
      const day = admittedMessages(userId, now, USAGE_DAY_MS);
      const [user, userSpentMicros, hourCount, dayCount] = await Promise.all([
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
        database.usageMessageAdmission.count({ where: hour }),
        database.usageMessageAdmission.count({ where: day })
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
            usageLimit: { select: { ...valueSelect, version: true } }
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
            usageLimit: { select: { ...valueSelect, exempt: true, version: true } }
          }
        }),
        database.$queryRaw<Array<{ spent: bigint | null; userId: string }>>`
          SELECT "userId", COALESCE(SUM("estimatedCostMicros"), 0)::bigint AS "spent"
          FROM "UsageEvent"
          WHERE "createdAt" >= ${utcTimestamp(periodStart)} AND "createdAt" < ${utcTimestamp(resetsAt)}
          GROUP BY "userId"`,
        // One indexed (userId, createdAt) range per user instead of a scan of the whole log.
        database.$queryRaw<Array<{ lastDay: number; lastHour: number; userId: string }>>`
          SELECT account."id" AS "userId", admitted."lastHour", admitted."lastDay"
          FROM "User" AS account
          CROSS JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE admission."createdAt" > ${utcTimestamp(hourStart)})::int AS "lastHour",
              COUNT(*)::int AS "lastDay"
            FROM "UsageMessageAdmission" AS admission
            WHERE admission."userId" = account."id"
              AND admission."createdAt" > ${utcTimestamp(dayStart)} AND admission."createdAt" <= ${utcTimestamp(now)}
          ) AS admitted
          WHERE admitted."lastDay" > 0`
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
          name: group.name,
          version: group.usageLimit?.version ?? null
        })),
        installation,
        installationSpentMicros: Math.min(installationSpentMicros, Number.MAX_SAFE_INTEGER),
        periodStart: periodStart.toISOString(),
        resetsAt: resetsAt.toISOString(),
        users: userRows.map((user) => {
          const override: AdminUsageUserOverride | null = user.usageLimit
            ? { ...limitValues(user.usageLimit), exempt: user.usageLimit.exempt, userId: user.id, version: user.usageLimit.version }
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
          if (!await tx.group.findUnique({ select: { id: true }, where: { id: groupId } })) return "not_found";
          return writeVersionedLimit(tx, { groupId }, limits.expectedVersion, nothingSet(values) ? null : values, userId);
        });
      } catch (error) {
        if (missingParent(error)) return "not_found";
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
      const cleared = !values.exempt && nothingSet(values);
      try {
        return await database.$transaction(async (tx) => {
          if (!await tx.user.findUnique({ select: { id: true }, where: { id: targetUserId } })) return "not_found";
          return writeVersionedLimit(tx, { userId: targetUserId }, limits.expectedVersion, cleared ? null : values, userId);
        });
      } catch (error) {
        if (missingParent(error)) return "not_found";
        throw error;
      }
    },

    async deleteUserLimits({ expectedVersion, targetUserId }) {
      return database.$transaction(async (tx) => {
        if (!await tx.user.findUnique({ select: { id: true }, where: { id: targetUserId } })) return "not_found";
        return writeVersionedLimit(tx, { userId: targetUserId }, expectedVersion, null, null);
      });
    }
  };
}
