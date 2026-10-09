import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeRunReference, runReferenceRange } from "../../../contracts/runReference";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import type { AdminHealthRunRepository, AdminHealthRunRow } from "./runLookup";

export type AdminHealthRunDatabase = Pick<PrismaClient, "$queryRaw">;

const MAX_ROWS = 16;
export const ADMIN_HEALTH_USER_RUNS_MAX_ROWS = 501;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;

/** Lifecycle columns, only the failure code of the error payload (never the message) and the answer binding's names. */
const runColumns = Prisma.sql`
    SELECT run."id", run."status"::text AS "status", run."createdAt", run."updatedAt",
      CASE WHEN jsonb_typeof(run."errorPayload" -> 'code') = 'string'
        THEN left(run."errorPayload" ->> 'code', 128) END AS "failureCode",
      binding."connectionId", connection."displayName" AS "connectionName",
      binding."providerModelId", model."displayName" AS "modelDisplayName", model."modelId" AS "modelProviderId"
    FROM "ModelRun" run
    LEFT JOIN "ProviderRunBinding" binding
      ON binding."modelRunId" = run."id" AND binding."bindingKey" = 'answer'
    LEFT JOIN "ProviderConnection" connection ON connection."id" = binding."connectionId"
    LEFT JOIN "ProviderModel" model
      ON model."connectionId" = binding."connectionId" AND model."id" = binding."providerModelId"`;

/**
 * The lookup statement. The id range keeps the scan on the `ModelRun`
 * primary-key btree (a `LIKE` prefix cannot use an index in a non-C
 * collation); `starts_with` makes the match exact. Only the failure code
 * leaves the error payload; provider names come from the answer binding.
 */
export function adminHealthRunLookupStatement(reference: string, limit: number): Prisma.Sql {
  if (normalizeRunReference(reference) !== reference || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) {
    throw new RangeError("admin_health_run_lookup_invalid");
  }
  const range = runReferenceRange(reference);
  return Prisma.sql`${runColumns}
    WHERE run."id" >= ${range.lower} AND run."id" < ${range.upper} AND starts_with(run."id", ${reference})
    ORDER BY run."id"
    LIMIT ${limit}
  `;
}

export type AdminHealthUserRunsQuery = Readonly<{ userId: string; from: Date; to: Date; limit: number }>;

/**
 * One user's failed and cancelled runs created in `[from, to)`, newest first,
 * at most `limit`: the lookup's content-free columns, read through the
 * `(userId, createdAt)` index.
 */
export function adminHealthUserFailedRunsStatement(query: AdminHealthUserRunsQuery): Prisma.Sql {
  const { from, limit, to, userId } = query;
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId) || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > ADMIN_HEALTH_USER_RUNS_MAX_ROWS || !(from instanceof Date) || !(to instanceof Date) ||
    !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from.getTime() >= to.getTime()) {
    throw new RangeError("admin_health_user_runs_invalid");
  }
  return Prisma.sql`${runColumns}
    WHERE run."userId" = ${userId} AND run."createdAt" >= ${utc(from)} AND run."createdAt" < ${utc(to)}
      AND run."status" IN ('error', 'cancelled')
    ORDER BY run."createdAt" DESC, run."id" DESC
    LIMIT ${limit}
  `;
}

/** Reads `adminHealthUserFailedRunsStatement`; it never writes. */
export async function readAdminHealthUserFailedRuns(
  db: AdminHealthRunDatabase,
  query: AdminHealthUserRunsQuery
): Promise<readonly AdminHealthRunRow[]> {
  const statement = adminHealthUserFailedRunsStatement(query);
  try {
    return await db.$queryRaw<AdminHealthRunRow[]>(statement);
  } catch (error) {
    return retainDatabaseFailure(error);
  }
}

export function createPrismaAdminHealthRunRepository(db: AdminHealthRunDatabase): AdminHealthRunRepository {
  return Object.freeze({
    async findByReference(reference: string, limit: number): Promise<readonly AdminHealthRunRow[]> {
      const statement = adminHealthRunLookupStatement(reference, limit);
      try {
        return await db.$queryRaw<AdminHealthRunRow[]>(statement);
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    }
  });
}
