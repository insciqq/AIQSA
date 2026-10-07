import { Prisma, type PrismaClient } from "@prisma/client";
import type { UsageLimitAlertKey, UsageLimitAlertKind } from "./alertsPolicy";

export type UsageLimitAlertClaim = Readonly<{ id: string; kind: UsageLimitAlertKind; userId: string | null }>;

/** An active administrator; `email` only when it is the account's verified address. */
export type UsageLimitAlertRecipient = Readonly<{ email: string | null; userId: string }>;

export type UsageLimitAlertStore = Readonly<{
  /**
   * Claims, for the month, every key not claimed yet and every undelivered
   * one whose retry is due, and returns what this call claimed. Concurrent
   * calls claim each key once.
   */
  claim(input: Readonly<{ keys: readonly UsageLimitAlertKey[]; now: Date; periodStart: Date }>): Promise<readonly UsageLimitAlertClaim[]>;
  /** Settles claimed rows; `undelivered` lets a later check claim them again. */
  settle(ids: readonly string[], state: "delivered" | "undelivered", now: Date): Promise<void>;
  listRecipients(): Promise<readonly UsageLimitAlertRecipient[]>;
  /** Removes rows of months before `periodStart`; they no longer dedupe anything. */
  pruneBefore(periodStart: Date): Promise<void>;
}>;

/** Claims of an alert that reached nobody, the first included. */
export const USAGE_LIMIT_ALERT_MAX_ATTEMPTS = 6;
/** How long an undelivered alert waits before a later check claims it again. */
export const USAGE_LIMIT_ALERT_RETRY_MS = 30 * 60_000;
/** Administrators one alert reaches at most. */
const MAX_RECIPIENTS = 100;

type Database = Pick<PrismaClient, "$queryRaw" | "usageLimitAlert" | "user">;

const KINDS = new Set<UsageLimitAlertKind>(["installation_cap_near", "installation_cap_reached", "user_budget_reached"]);

/** Prisma stores `DateTime` as UTC `timestamp(3)`; bind instants in UTC whatever the session time zone is. */
function utcTimestamp(value: Date): Prisma.Sql {
  return Prisma.sql`(${value}::timestamptz AT TIME ZONE 'UTC')`;
}

export function createUsageLimitAlertStore(database: Database): UsageLimitAlertStore {
  return {
    async claim({ keys, now, periodStart }) {
      const unique = new Map<string, UsageLimitAlertKey>();
      for (const key of keys) unique.set(`${key.kind}:${key.userId ?? ""}`, key);
      if (unique.size === 0) return [];
      const kinds = [...unique.values()].map((key) => key.kind);
      // An empty string stands for "no user": unnest cannot carry NULL text elements through Prisma.
      const userIds = [...unique.values()].map((key) => key.userId ?? "");
      const rows = await database.$queryRaw<Array<{ id: string; kind: string; userId: string | null }>>(Prisma.sql`
        INSERT INTO "UsageLimitAlert" ("id", "periodStart", "kind", "userId", "claimedAt")
        SELECT gen_random_uuid()::text, ${utcTimestamp(periodStart)}, key."kind"::"UsageLimitAlertKind",
          NULLIF(key."userId", ''), ${utcTimestamp(now)}
        FROM unnest(${kinds}::text[], ${userIds}::text[]) AS key("kind", "userId")
        -- A user deleted since the status read has nothing left to alert.
        WHERE key."userId" = '' OR EXISTS (SELECT 1 FROM "User" AS account WHERE account."id" = key."userId")
        ON CONFLICT ("periodStart", "kind", "userId") DO UPDATE
          SET "state" = 'claimed', "attempts" = "UsageLimitAlert"."attempts" + 1,
            "claimedAt" = EXCLUDED."claimedAt", "settledAt" = NULL
          WHERE "UsageLimitAlert"."state" = 'undelivered'
            AND "UsageLimitAlert"."attempts" < ${USAGE_LIMIT_ALERT_MAX_ATTEMPTS}
            AND "UsageLimitAlert"."settledAt" <= ${utcTimestamp(new Date(now.getTime() - USAGE_LIMIT_ALERT_RETRY_MS))}
        RETURNING "id", "kind"::text AS "kind", "userId"
      `);
      return rows.flatMap((row) => KINDS.has(row.kind as UsageLimitAlertKind)
        ? [{ id: row.id, kind: row.kind as UsageLimitAlertKind, userId: row.userId }]
        : []);
    },

    async settle(ids, state, now) {
      if (ids.length === 0) return;
      await database.usageLimitAlert.updateMany({
        data: { settledAt: now, state },
        where: { id: { in: [...ids] }, state: "claimed" }
      });
    },

    async listRecipients() {
      const admins = await database.user.findMany({
        orderBy: { id: "asc" },
        select: {
          authIdentities: { select: { normalizedEmail: true }, where: { emailVerifiedAt: { not: null } } },
          email: true,
          id: true
        },
        take: MAX_RECIPIENTS,
        where: { role: "admin", status: "active" }
      });
      return admins.map((admin) => {
        const email = admin.email?.trim() || null;
        const verified = email !== null &&
          admin.authIdentities.some((identity) => identity.normalizedEmail === email.toLowerCase());
        return { email: verified ? email : null, userId: admin.id };
      });
    },

    async pruneBefore(periodStart) {
      await database.usageLimitAlert.deleteMany({ where: { periodStart: { lt: periodStart } } });
    }
  };
}
