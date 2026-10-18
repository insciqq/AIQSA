import { Prisma } from "@prisma/client";
import { ADMIN_HEALTH_CODE_PATTERN } from "../../../contracts/adminHealth";
import { RUN_FAILURE_USER_INPUT_CODES } from "../attention/healthRules";
import { ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS } from "./queueThresholds";
import type { AdminHealthQueueClient } from "./queuesRepository";

/**
 * Runs created in a window per answer connection and model, read from the
 * runs and their answer binding, so every run counts once whatever recorded
 * it: preparation and recovery failures included. A user's Stop is
 * `cancelled`; a refusal of the user's own input (`RUN_FAILURE_USER_INPUT_CODES`)
 * is `refusedInput`, not a failure. Only failure codes leave the error
 * payload, never messages; ids are installation configuration.
 */
export type ModelRunCode = Readonly<{ code: string | null; runs: number }>;

export type ModelRunRow = Readonly<{
  /** The answer binding's connection and model; null for a run without one. */
  connectionId: string | null;
  providerModelId: string | null;
  /** Runs created in the window. */
  accepted: number;
  completed: number;
  failed: number;
  refusedInput: number;
  cancelled: number;
  /** Still preparing, queued or running. */
  open: number;
  users: number;
  lastFailedAt: Date | null;
  /** The most frequent failure codes, most runs first. */
  codes: readonly ModelRunCode[];
}>;

export type ModelRunLoad = Readonly<{ rows: readonly ModelRunRow[]; truncated: boolean }>;

export type ModelRunQuery = Readonly<{
  /** Runs created in `[from, to)`. */
  from: Date;
  to: Date;
  limit: number;
  codesPerModel: number;
  statementTimeoutMs?: number;
}>;

const MAX_ROWS = 1_000;
const MAX_CODES = 20;

type Row = Readonly<{
  connectionId: string | null; providerModelId: string | null; accepted: number | bigint; completed: number | bigint;
  failed: number | bigint; refusedInput: number | bigint; cancelled: number | bigint; users: number | bigint;
  lastFailedAt: Date | null; codes: unknown;
}>;

const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;

function count(value: bigint | number): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error("admin_health_model_run_count_invalid");
  return converted;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The statement: the window's runs (a range over creation time) with their
 * answer binding (unique per run), counted per connection and model, and
 * per model its most frequent failure codes.
 */
export function adminHealthModelRunsStatement(query: ModelRunQuery): Prisma.Sql {
  const { codesPerModel, from, limit, to } = query;
  if (!validDate(from) || !validDate(to) || from.getTime() >= to.getTime() ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS ||
    !Number.isSafeInteger(codesPerModel) || codesPerModel < 1 || codesPerModel > MAX_CODES) {
    throw new RangeError("admin_health_model_runs_invalid");
  }
  return Prisma.sql`
    WITH runs AS (
      SELECT run."userId", run."status", run."createdAt", binding."connectionId", binding."providerModelId",
        CASE WHEN run."status" = 'error'::"ModelRunStatus" AND jsonb_typeof(run."errorPayload" -> 'code') = 'string'
          THEN left(run."errorPayload" ->> 'code', 128) END AS "code"
      FROM "ModelRun" AS run
      LEFT JOIN "ProviderRunBinding" AS binding ON binding."modelRunId" = run."id" AND binding."bindingKey" = 'answer'
      WHERE run."createdAt" >= ${utc(from)} AND run."createdAt" < ${utc(to)}
    ), classified AS (
      SELECT runs.*, runs."status" = 'error'::"ModelRunStatus" AND runs."code" IS NOT NULL
        AND runs."code" = ANY(${[...RUN_FAILURE_USER_INPUT_CODES]}::text[]) AS "refused"
      FROM runs
    ), models AS (
      SELECT "connectionId", "providerModelId", count(*)::integer AS "accepted",
        count(*) FILTER (WHERE "status" = 'complete'::"ModelRunStatus")::integer AS "completed",
        count(*) FILTER (WHERE "status" = 'error'::"ModelRunStatus" AND NOT "refused")::integer AS "failed",
        count(*) FILTER (WHERE "refused")::integer AS "refusedInput",
        count(*) FILTER (WHERE "status" = 'cancelled'::"ModelRunStatus")::integer AS "cancelled",
        count(DISTINCT "userId")::integer AS "users",
        max("createdAt") FILTER (WHERE "status" = 'error'::"ModelRunStatus" AND NOT "refused") AS "lastFailedAt"
      FROM classified
      GROUP BY 1, 2
    ), codes AS (
      SELECT "connectionId", "providerModelId", "code", count(*)::integer AS "runs",
        row_number() OVER (PARTITION BY "connectionId", "providerModelId" ORDER BY count(*) DESC, "code" ASC NULLS LAST) AS "rank"
      FROM classified
      WHERE "status" = 'error'::"ModelRunStatus" AND NOT "refused"
      GROUP BY 1, 2, 3
    )
    SELECT models.*, COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', codes."code", 'runs', codes."runs") ORDER BY codes."rank")
      FROM codes
      WHERE codes."connectionId" IS NOT DISTINCT FROM models."connectionId"
        AND codes."providerModelId" IS NOT DISTINCT FROM models."providerModelId" AND codes."rank" <= ${codesPerModel}
    ), '[]'::jsonb) AS "codes"
    FROM models
    ORDER BY models."failed" DESC, models."accepted" DESC, models."connectionId" ASC NULLS LAST, models."providerModelId" ASC NULLS LAST
    LIMIT ${limit + 1}
  `;
}

function codes(value: unknown, limit: number): ModelRunCode[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((item: unknown): ModelRunCode[] => {
    if (typeof item !== "object" || item === null) return [];
    const { code, runs } = item as Record<string, unknown>;
    if (typeof runs !== "number" || !Number.isSafeInteger(runs) || runs < 1) return [];
    return [{ code: typeof code === "string" && ADMIN_HEALTH_CODE_PATTERN.test(code) ? code : null, runs }];
  });
}

/** Reads `adminHealthModelRunsStatement` under a statement timeout; it never writes. */
export async function readModelRunLoad(client: AdminHealthQueueClient, query: ModelRunQuery): Promise<ModelRunLoad> {
  const statement = adminHealthModelRunsStatement(query);
  const timeout = String(query.statementTimeoutMs ?? ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS);
  const [, rows] = await client.$transaction([
    client.$executeRaw(Prisma.sql`SELECT set_config('statement_timeout', ${timeout}, true)`),
    client.$queryRaw<Row[]>(statement)
  ]);
  return {
    rows: rows.slice(0, query.limit).map((row) => {
      const accepted = count(row.accepted);
      const completed = count(row.completed);
      const failed = count(row.failed);
      const refusedInput = count(row.refusedInput);
      const cancelled = count(row.cancelled);
      return {
        connectionId: row.connectionId, providerModelId: row.providerModelId, accepted, completed, failed, refusedInput, cancelled,
        open: Math.max(0, accepted - completed - failed - refusedInput - cancelled),
        users: count(row.users), lastFailedAt: validDate(row.lastFailedAt) ? row.lastFailedAt : null,
        codes: codes(row.codes, query.codesPerModel)
      };
    }),
    truncated: rows.length > query.limit
  };
}
