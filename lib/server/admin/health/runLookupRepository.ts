import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeRunReference, runReferenceRange } from "../../../contracts/runReference";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import type { AdminHealthRunRepository, AdminHealthRunRow } from "./runLookup";

export type AdminHealthRunDatabase = Pick<PrismaClient, "$queryRaw">;

const MAX_ROWS = 16;

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
  return Prisma.sql`
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
      ON model."connectionId" = binding."connectionId" AND model."id" = binding."providerModelId"
    WHERE run."id" >= ${range.lower} AND run."id" < ${range.upper} AND starts_with(run."id", ${reference})
    ORDER BY run."id"
    LIMIT ${limit}
  `;
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
