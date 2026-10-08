import { Prisma } from "@prisma/client";
import { memoryAdmittedShadowPredicate } from "../../memory/rebuild/lifecycle";
import { ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS } from "./queueThresholds";
import type { AdminHealthQueueClient } from "./queuesRepository";

/**
 * Admitted full Memory search-index rebuilds per owner over a window, as
 * counts only: each rebuild re-indexes, and for a vector index re-embeds, one
 * owner's whole Memory under its settings lock. No owner identity leaves
 * PostgreSQL; the reason of each admission is in the operator telemetry.
 */
export type MemoryRebuildLoad = Readonly<{
  /** The most rebuilds admitted for one owner. */
  maxPerOwner: number;
  /** Owners with at least one rebuild. */
  owners: number;
  /** Owners with at least `threshold` rebuilds. */
  ownersAtThreshold: number;
  /** Rebuilds admitted for all owners. */
  rebuilds: number;
}>;

type LoadRow = Readonly<Record<keyof MemoryRebuildLoad, bigint | number>>;

function count(value: bigint | number): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error("admin_health_memory_rebuild_count_invalid");
  }
  return converted;
}

/** Only a full Memory reset or account deletion removes an owner's old shadow
 * generations, and the table holds a handful of rows per owner, so the window
 * needs no index. */
export async function readMemoryRebuildLoad(
  client: AdminHealthQueueClient,
  input: Readonly<{ now: Date; threshold: number; windowMs: number }>
): Promise<MemoryRebuildLoad> {
  const since = new Date(input.now.getTime() - input.windowMs);
  const [, rows] = await client.$transaction([
    client.$executeRaw(Prisma.sql`
      SELECT set_config('statement_timeout', ${String(ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS)}, true)
    `),
    client.$queryRaw<LoadRow[]>(Prisma.sql`
      SELECT
        COALESCE(sum(per_owner."rebuilds"), 0)::integer AS "rebuilds",
        count(*)::integer AS "owners",
        COALESCE(max(per_owner."rebuilds"), 0)::integer AS "maxPerOwner",
        count(*) FILTER (WHERE per_owner."rebuilds" >= ${input.threshold})::integer
          AS "ownersAtThreshold"
      FROM (
        SELECT count(*)::integer AS "rebuilds"
        FROM "MemoryIndexGeneration" AS generation
        WHERE generation."createdAt" > ${since}
          AND generation."createdAt" <= ${input.now}
          AND generation."sourceIndexGenerationId" IS NOT NULL
          AND ${memoryAdmittedShadowPredicate(Prisma.sql`generation`)}
        GROUP BY generation."userId"
      ) AS per_owner
    `)
  ]);
  const row = rows[0];
  if (!row) throw new Error("admin_health_memory_rebuild_row_missing");
  return {
    maxPerOwner: count(row.maxPerOwner),
    owners: count(row.owners),
    ownersAtThreshold: count(row.ownersAtThreshold),
    rebuilds: count(row.rebuilds)
  };
}
