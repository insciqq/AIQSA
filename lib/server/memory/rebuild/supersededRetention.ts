import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { withLockedMemoryTransaction } from "../persistence/transaction";

// Retention of superseded search generations (decision 2026-10-25). A cutover,
// promotion, reset or account deletion supersedes a generation by moving the
// settings pointer away from it. Every search and preparation read joins that
// pointer and the ACTIVE state, and a shadow whose source stops being active
// fails, so nothing reads a superseded generation's entries again and there is
// no rollback to one. Its entries are therefore deleted without a grace
// period. The generation row stays: run bindings, retrieval attempts and later
// generations reference it restrictively.

/** Entries one owner transaction deletes; it holds the owner lock briefly. */
export const MEMORY_SUPERSEDED_ENTRY_PRUNE_BATCH = 500;
/** Batches one coordinator pass runs, across owners. */
export const MEMORY_SUPERSEDED_ENTRY_PRUNE_MAX_BATCHES = 8;

/** Content-free code, registered in observability/failureCodes.json. */
const MEMORY_SUPERSEDED_ENTRIES_PRUNED_CODE = "memory_superseded_entries_pruned";

export type MemorySupersededEntryPruneLimits = Readonly<{
  batchEntries: number;
  maxBatches: number;
}>;

export type MemorySupersededEntryPruneStore = Readonly<{
  /** Owners with prunable entries, the longest superseded first. */
  owners(limit: number): Promise<readonly string[]>;
  /** Deletes at most `limit` prunable entries of one owner; returns the count. */
  pruneBatch(userId: string, limit: number): Promise<number>;
}>;

export type MemorySupersededEntryPruneResult = Readonly<{
  batches: number;
  deletedEntries: number;
}>;

const OPEN_JOB_STATES = Prisma.sql`(
  'QUEUED'::"MemoryJobState", 'CLAIMED'::"MemoryJobState",
  'RETRYABLE_FAILED'::"MemoryJobState",
  'WAITING_FOR_CONFIGURATION'::"MemoryJobState",
  'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
)`;

/** Uses `entry`. An open embedding job still owns the entry's batch child;
 * the entry goes in a later pass, once that job settled. */
const NO_OPEN_BATCH_CHILD = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "MemoryEmbeddingBatchItem" AS child
  INNER JOIN "MemoryJob" AS job
    ON job."userId" = child."userId" AND job."id" = child."memoryJobId"
  WHERE child."userId" = entry."userId"
    AND child."searchEntryId" = entry."id"
    AND job."state" IN ${OPEN_JOB_STATES}
)`;

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * One bounded, idempotent coordinator step. Each batch commits on its own, so
 * an interrupted pass loses nothing and the next pass continues. Owners are
 * served in order; one that fails is skipped for this pass and the first
 * failure is rethrown after the others ran.
 */
export async function pruneSupersededMemorySearchEntries(
  store: MemorySupersededEntryPruneStore,
  limits: MemorySupersededEntryPruneLimits = {
    batchEntries: MEMORY_SUPERSEDED_ENTRY_PRUNE_BATCH,
    maxBatches: MEMORY_SUPERSEDED_ENTRY_PRUNE_MAX_BATCHES
  }
): Promise<MemorySupersededEntryPruneResult> {
  if (!validLimit(limits.batchEntries) || !validLimit(limits.maxBatches)) {
    throw new Error("memory_superseded_entry_prune_limits_invalid");
  }
  const failures: unknown[] = [];
  let batches = 0;
  let deletedEntries = 0;
  let owners: readonly string[] = [];
  try {
    owners = await store.owners(limits.maxBatches);
  } catch (error) {
    failures.push(error);
  }
  for (const userId of owners) {
    if (batches >= limits.maxBatches) break;
    while (batches < limits.maxBatches) {
      batches += 1;
      let deleted: number;
      try {
        deleted = await store.pruneBatch(userId, limits.batchEntries);
      } catch (error) {
        failures.push(error);
        break;
      }
      deletedEntries += deleted;
      if (deleted < limits.batchEntries) break;
    }
  }
  if (deletedEntries > 0) {
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "cleanup", outcome: "completed",
      code: MEMORY_SUPERSEDED_ENTRIES_PRUNED_CODE, count: deletedEntries });
  }
  if (failures.length > 0) throw failures[0];
  return Object.freeze({ batches, deletedEntries });
}

export function createPrismaMemorySupersededEntryPruneStore(
  client: PrismaClient
): MemorySupersededEntryPruneStore {
  return Object.freeze({
    async owners(limit: number) {
      const rows = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        SELECT generation."userId"
        FROM "MemoryIndexGeneration" AS generation
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = generation."userId"
        WHERE generation."state" = 'SUPERSEDED'::"MemoryIndexGenerationState"
          AND generation."id" IS DISTINCT FROM settings."activeIndexGenerationId"
          AND EXISTS (
            SELECT 1 FROM "MemorySearchEntry" AS entry
            WHERE entry."userId" = generation."userId"
              AND entry."indexGenerationId" = generation."id"
              AND ${NO_OPEN_BATCH_CHILD}
          )
        GROUP BY generation."userId"
        ORDER BY MIN(generation."supersededAt") ASC NULLS FIRST, generation."userId"
        LIMIT ${limit}
      `);
      return rows.map(({ userId }) => userId);
    },

    pruneBatch(userId: string, limit: number) {
      // The owner lock orders the delete with every generation transition, so
      // a generation cannot leave SUPERSEDED, or become the pointer, under it.
      // Owners of any status are pruned: the rows are unreachable either way.
      return withLockedMemoryTransaction(client, userId, (tx, settings) => {
        const notActive = settings.activeIndexGenerationId
          ? Prisma.sql`AND generation."id" <> ${settings.activeIndexGenerationId}`
          : Prisma.empty;
        return tx.$executeRaw(Prisma.sql`
          DELETE FROM "MemorySearchEntry" AS pruned
          WHERE pruned."userId" = ${userId}
            AND pruned."id" IN (
              SELECT entry."id"
              FROM "MemorySearchEntry" AS entry
              INNER JOIN "MemoryIndexGeneration" AS generation
                ON generation."userId" = entry."userId"
                AND generation."id" = entry."indexGenerationId"
              WHERE entry."userId" = ${userId}
                AND generation."state" = 'SUPERSEDED'::"MemoryIndexGenerationState"
                ${notActive}
                AND ${NO_OPEN_BATCH_CHILD}
              LIMIT ${limit}
            )
        `);
      }, { requireActiveOwner: false });
    }
  });
}

export function reconcileSupersededMemorySearchEntries(
  client: PrismaClient
): Promise<MemorySupersededEntryPruneResult> {
  return pruneSupersededMemorySearchEntries(
    createPrismaMemorySupersededEntryPruneStore(client)
  );
}
