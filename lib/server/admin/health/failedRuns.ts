import { Prisma } from "@prisma/client";
import { ADMIN_HEALTH_CODE_PATTERN } from "../../../contracts/adminHealth";
import { normalizeRunReference, RUN_ID_LENGTH } from "../../../contracts/runReference";
import { RUN_FAILURE_USER_INPUT_CODES } from "../attention/healthRules";
import { ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS } from "./queueThresholds";
import type { AdminHealthQueueClient } from "./queuesRepository";

/**
 * Failed chat runs of a window, read from the runs themselves: one row per
 * run in `error`, so preparation and recovery failures count as well, and a
 * user's Stop or cancellation (`cancelled`) does not. Refusals of the user's
 * own input (`RUN_FAILURE_USER_INPUT_CODES`) are left out: nothing in AIQSA
 * failed. Only the failure code of the error payload leaves it, never the
 * message; run and user ids are returned for the agent report and the run
 * references of the attention item.
 */
export type FailedRunSample = Readonly<{ runId: string; userId: string; startedAt: Date }>;

export type FailedRunGroup = Readonly<{
  /** The run's stable failure code; `null` when it has none (or not a well-formed one). */
  code: string | null;
  runs: number;
  users: number;
  firstAt: Date;
  lastAt: Date;
  /** The newest runs of the code, newest first, at most `perCode`. */
  newest: readonly FailedRunSample[];
}>;

export type FailedRunLoad = Readonly<{
  runs: number;
  users: number;
  /** Codes with the most failed runs first. */
  groups: readonly FailedRunGroup[];
  /** More codes failed than `groups` lists. */
  groupsTruncated: boolean;
}>;

export type FailedRunQuery = Readonly<{
  /** Runs created in `[from, to)`. */
  from: Date;
  to: Date;
  perCode: number;
  groupLimit: number;
  statementTimeoutMs?: number;
}>;

const MAX_PER_CODE = 100;
const MAX_GROUPS = 1_000;

type GroupRow = Readonly<{
  code: string | null;
  runs: bigint | number;
  users: bigint | number;
  firstAt: Date;
  lastAt: Date;
  newest: unknown;
  totalRuns: bigint | number;
  totalUsers: bigint | number;
}>;

const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;

function count(value: bigint | number): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error("admin_health_failed_run_count_invalid");
  return converted;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The statement: the `status` index selects failed runs, the creation window
 * bounds them; per code the run count, distinct users and the newest runs.
 * The filtered set is referenced twice, so PostgreSQL scans it once.
 */
export function adminHealthFailedRunsStatement(query: FailedRunQuery): Prisma.Sql {
  const { from, groupLimit, perCode, to } = query;
  if (!validDate(from) || !validDate(to) || from.getTime() >= to.getTime() ||
    !Number.isSafeInteger(perCode) || perCode < 1 || perCode > MAX_PER_CODE ||
    !Number.isSafeInteger(groupLimit) || groupLimit < 1 || groupLimit > MAX_GROUPS) {
    throw new RangeError("admin_health_failed_runs_invalid");
  }
  return Prisma.sql`
    WITH failed AS (
      SELECT run."id", run."userId", run."createdAt",
        CASE WHEN jsonb_typeof(run."errorPayload" -> 'code') = 'string'
          THEN left(run."errorPayload" ->> 'code', 128) END AS "code"
      FROM "ModelRun" AS run
      WHERE run."status" = 'error'::"ModelRunStatus"
        AND run."createdAt" >= ${utc(from)} AND run."createdAt" < ${utc(to)}
    ), kept AS (
      SELECT * FROM failed WHERE "code" IS NULL OR NOT ("code" = ANY(${[...RUN_FAILURE_USER_INPUT_CODES]}::text[]))
    ), ranked AS (
      SELECT kept.*, row_number() OVER (PARTITION BY "code" ORDER BY "createdAt" DESC, "id" DESC) AS "rank"
      FROM kept
    )
    SELECT "code", count(*)::integer AS "runs", count(DISTINCT "userId")::integer AS "users",
      min("createdAt") AS "firstAt", max("createdAt") AS "lastAt",
      COALESCE(jsonb_agg(jsonb_build_object(
        'runId', "id", 'userId', "userId", 'startedAt', to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY "createdAt" DESC, "id" DESC) FILTER (WHERE "rank" <= ${perCode}), '[]'::jsonb) AS "newest",
      (SELECT count(*) FROM kept)::integer AS "totalRuns",
      (SELECT count(DISTINCT "userId") FROM kept)::integer AS "totalUsers"
    FROM ranked
    GROUP BY "code"
    ORDER BY count(*) DESC, "code" ASC NULLS LAST
    LIMIT ${groupLimit + 1}
  `;
}

function samples(value: unknown, perCode: number): FailedRunSample[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, perCode).flatMap((item: unknown): FailedRunSample[] => {
    if (typeof item !== "object" || item === null) return [];
    const { startedAt, runId, userId } = item as Record<string, unknown>;
    const at = typeof startedAt === "string" ? new Date(startedAt) : null;
    if (typeof runId !== "string" || runId.length !== RUN_ID_LENGTH || normalizeRunReference(runId) !== runId ||
      typeof userId !== "string" || userId.length === 0 || at === null || !validDate(at)) return [];
    return [{ runId, userId, startedAt: at }];
  });
}

/** Reads `adminHealthFailedRunsStatement` under a statement timeout; it never writes. */
export async function readFailedRunLoad(client: AdminHealthQueueClient, query: FailedRunQuery): Promise<FailedRunLoad> {
  const statement = adminHealthFailedRunsStatement(query);
  const timeout = String(query.statementTimeoutMs ?? ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS);
  const [, rows] = await client.$transaction([
    client.$executeRaw(Prisma.sql`SELECT set_config('statement_timeout', ${timeout}, true)`),
    client.$queryRaw<GroupRow[]>(statement)
  ]);
  const first = rows[0];
  return {
    runs: first ? count(first.totalRuns) : 0,
    users: first ? count(first.totalUsers) : 0,
    groups: rows.slice(0, query.groupLimit).map((row) => ({
      code: row.code !== null && ADMIN_HEALTH_CODE_PATTERN.test(row.code) ? row.code : null,
      runs: count(row.runs),
      users: count(row.users),
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      newest: samples(row.newest, query.perCode)
    })),
    groupsTruncated: rows.length > query.groupLimit
  };
}
