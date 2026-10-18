import { Prisma } from "@prisma/client";
import { ADMIN_HEALTH_CODE_PATTERN } from "../../../contracts/adminHealth";
import { normalizeRunReference, RUN_ID_LENGTH } from "../../../contracts/runReference";
import { ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS } from "./queueThresholds";
import type { AdminHealthQueueClient } from "./queuesRepository";

/**
 * Failure streaks of a window, read from the runs themselves: in one chat,
 * at least `minLength` consecutive settled runs of one user that failed or
 * were cancelled, with no completed run between them: answers a user lost
 * in a row, the strongest sign of a stuck user. Runs still in flight neither
 * extend nor end a streak. Only codes leave the error payload; user and run
 * ids are returned for the agent reports and the run references of the
 * default report, never the chat.
 */
export const FAILURE_STREAK_MIN_RUNS = 3;

export type FailureStreakCode = Readonly<{ code: string | null; runs: number }>;

export type FailureStreak = Readonly<{
  userId: string;
  /** Consecutive failed or cancelled runs. */
  runs: number;
  failed: number;
  cancelled: number;
  firstAt: Date;
  lastAt: Date;
  /** No later settled run of the chat in the window ended it. */
  ongoing: boolean;
  /** Failure codes of the streak, most runs first. */
  codes: readonly FailureStreakCode[];
  /** The streak's newest runs, newest first, at most `runsPerStreak`. */
  newestRunIds: readonly string[];
}>;

export type FailureStreakLoad = Readonly<{
  /** Every streak of the window and the distinct users they hit, beyond the listed rows too. */
  streaks: number;
  users: number;
  longest: number;
  /** Longest first, at most `limit`. */
  rows: readonly FailureStreak[];
  truncated: boolean;
}>;

export type FailureStreakQuery = Readonly<{
  /** Runs created in `[from, to)`. */
  from: Date;
  to: Date;
  limit: number;
  runsPerStreak: number;
  /** Only this user's streaks. */
  userId?: string;
  statementTimeoutMs?: number;
}>;

const MAX_ROWS = 1_000;
const MAX_RUNS_PER_STREAK = 50;
const MAX_CODES = 10;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

type Row = Readonly<{
  userId: string; runs: number | bigint; failed: number | bigint; cancelled: number | bigint; firstAt: Date; lastAt: Date;
  ongoing: boolean; codes: unknown; newestRunIds: unknown;
  totalStreaks: number | bigint; totalUsers: number | bigint; longest: number | bigint | null;
}>;

const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;

function count(value: bigint | number | null): number {
  const converted = Number(value ?? 0);
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error("admin_health_failure_streak_count_invalid");
  return converted;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The statement: the `status` index finds the users' chats with enough failed
 * or cancelled runs in the window, the `(chatId, createdAt)` index reads those
 * chats' settled runs in order, and each run of a streak shares the count of
 * completed runs before it.
 */
export function adminHealthFailureStreaksStatement(query: FailureStreakQuery): Prisma.Sql {
  const { from, limit, runsPerStreak, to, userId } = query;
  if (!validDate(from) || !validDate(to) || from.getTime() >= to.getTime() ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS ||
    !Number.isSafeInteger(runsPerStreak) || runsPerStreak < 1 || runsPerStreak > MAX_RUNS_PER_STREAK ||
    userId !== undefined && (typeof userId !== "string" || !USER_ID_PATTERN.test(userId))) {
    throw new RangeError("admin_health_failure_streaks_invalid");
  }
  const window = Prisma.sql`run."createdAt" >= ${utc(from)} AND run."createdAt" < ${utc(to)}`;
  return Prisma.sql`
    WITH candidates AS (
      SELECT run."userId", run."chatId"
      FROM "ModelRun" AS run
      WHERE run."status" IN ('error'::"ModelRunStatus", 'cancelled'::"ModelRunStatus") AND ${window}
        ${userId === undefined ? Prisma.empty : Prisma.sql`AND run."userId" = ${userId}`}
      GROUP BY 1, 2
      HAVING count(*) >= ${FAILURE_STREAK_MIN_RUNS}
    ), runs AS (
      SELECT run."id", run."userId", run."chatId", run."status", run."createdAt",
        CASE WHEN run."status" = 'error'::"ModelRunStatus" AND jsonb_typeof(run."errorPayload" -> 'code') = 'string'
          THEN left(run."errorPayload" ->> 'code', 128) END AS "code"
      FROM "ModelRun" AS run
      JOIN candidates ON candidates."chatId" = run."chatId" AND candidates."userId" = run."userId"
      WHERE ${window}
        AND run."status" IN ('complete'::"ModelRunStatus", 'error'::"ModelRunStatus", 'cancelled'::"ModelRunStatus")
    ), marked AS (
      SELECT runs.*,
        count(*) FILTER (WHERE runs."status" = 'complete'::"ModelRunStatus") OVER (
          PARTITION BY runs."userId", runs."chatId" ORDER BY runs."createdAt", runs."id" ROWS UNBOUNDED PRECEDING) AS "island",
        max(runs."createdAt") OVER (PARTITION BY runs."userId", runs."chatId") AS "chatLastAt"
      FROM runs
    ), streaks AS (
      SELECT "userId", "chatId", "island", count(*)::integer AS "runs",
        count(*) FILTER (WHERE "status" = 'error'::"ModelRunStatus")::integer AS "failed",
        count(*) FILTER (WHERE "status" = 'cancelled'::"ModelRunStatus")::integer AS "cancelled",
        min("createdAt") AS "firstAt", max("createdAt") AS "lastAt", max("createdAt") = max("chatLastAt") AS "ongoing",
        (array_agg("id" ORDER BY "createdAt" DESC, "id" DESC))[1:${runsPerStreak}::integer] AS "newestRunIds"
      FROM marked
      WHERE "status" <> 'complete'::"ModelRunStatus"
      GROUP BY 1, 2, 3
      HAVING count(*) >= ${FAILURE_STREAK_MIN_RUNS}
    ), codes AS (
      SELECT "userId", "chatId", "island", "code", count(*)::integer AS "runs"
      FROM marked
      WHERE "status" = 'error'::"ModelRunStatus"
      GROUP BY 1, 2, 3, 4
    )
    SELECT streaks."userId", streaks."runs", streaks."failed", streaks."cancelled", streaks."firstAt", streaks."lastAt",
      streaks."ongoing", streaks."newestRunIds",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('code', codes."code", 'runs', codes."runs") ORDER BY codes."runs" DESC, codes."code" ASC NULLS LAST)
        FROM codes
        WHERE codes."userId" = streaks."userId" AND codes."chatId" = streaks."chatId" AND codes."island" = streaks."island"
      ), '[]'::jsonb) AS "codes",
      (SELECT count(*) FROM streaks)::integer AS "totalStreaks",
      (SELECT count(DISTINCT "userId") FROM streaks)::integer AS "totalUsers",
      (SELECT max("runs") FROM streaks)::integer AS "longest"
    FROM streaks
    ORDER BY streaks."runs" DESC, streaks."lastAt" DESC, streaks."userId", streaks."chatId", streaks."island"
    LIMIT ${limit + 1}
  `;
}

function codes(value: unknown): FailureStreakCode[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CODES).flatMap((item: unknown): FailureStreakCode[] => {
    if (typeof item !== "object" || item === null) return [];
    const { code, runs } = item as Record<string, unknown>;
    if (typeof runs !== "number" || !Number.isSafeInteger(runs) || runs < 1) return [];
    return [{ code: typeof code === "string" && ADMIN_HEALTH_CODE_PATTERN.test(code) ? code : null, runs }];
  });
}

function runIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).filter((id): id is string =>
    typeof id === "string" && id.length === RUN_ID_LENGTH && normalizeRunReference(id) === id);
}

/** Reads `adminHealthFailureStreaksStatement` under a statement timeout; it never writes. */
export async function readFailureStreakLoad(client: AdminHealthQueueClient, query: FailureStreakQuery): Promise<FailureStreakLoad> {
  const statement = adminHealthFailureStreaksStatement(query);
  const timeout = String(query.statementTimeoutMs ?? ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS);
  const [, rows] = await client.$transaction([
    client.$executeRaw(Prisma.sql`SELECT set_config('statement_timeout', ${timeout}, true)`),
    client.$queryRaw<Row[]>(statement)
  ]);
  const first = rows[0];
  return {
    streaks: first ? count(first.totalStreaks) : 0,
    users: first ? count(first.totalUsers) : 0,
    longest: first ? count(first.longest) : 0,
    rows: rows.slice(0, query.limit).flatMap((row): FailureStreak[] => typeof row.userId === "string" &&
      validDate(row.firstAt) && validDate(row.lastAt) ? [{
      userId: row.userId, runs: count(row.runs), failed: count(row.failed), cancelled: count(row.cancelled),
      firstAt: row.firstAt, lastAt: row.lastAt, ongoing: row.ongoing === true, codes: codes(row.codes),
      newestRunIds: runIds(row.newestRunIds, query.runsPerStreak)
    }] : []),
    truncated: rows.length > query.limit
  };
}
