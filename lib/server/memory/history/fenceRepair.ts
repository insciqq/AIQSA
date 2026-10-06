import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { prisma } from "../../prisma";
import { MemoryPersistenceError } from "../persistence/errors";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "./contract";

/** Content-free repair constant, registered in observability/failureCodes.json. */
export const MEMORY_HISTORY_FENCE_REPAIR_VERSION = "fence-repair-v1";
export const MEMORY_HISTORY_FENCE_REPAIR_BATCH_SIZE = 8;
// Until v0.3.1 a source, generation or settings fence that won while a job
// classified failed it terminally with this code. A current claim keeps the
// code only when its re-run gate still accepts the claim.
const FENCED_HISTORY_FAILURE_CODE = "memory_history_job_invalid";

/** Uses `job`. History indexing never dispatches a model call, so an earlier
 * ambiguous call of the chat cannot be bought again by the revived job. */
function repairableFenceCasualtySql(): Prisma.Sql {
  return Prisma.sql`job.kind = 'INDEX_HISTORY'::"MemoryJobKind"
    AND job.state = 'TERMINAL_FAILED'::"MemoryJobState"
    AND job."errorCode" = ${FENCED_HISTORY_FAILURE_CODE}
    AND job."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}`;
}

/**
 * Releases fenced history jobs that an earlier writer failed terminally; such
 * a row otherwise blocks backfill of its unchanged source forever. The flip to
 * STALE keeps the failure evidence and grants nothing: backfill re-proves the
 * current source and settings, then revives an unchanged source at the current
 * generation or enqueues a fresh job, and indexing re-applies suppressions and
 * pauses. The worker owns this repair
 * because previous-release writers may still add rows during replacement; the
 * predicate stops matching once none remain.
 */
export async function repairFencedMemoryHistoryJobs(
  client: PrismaClient = prisma,
  input: Readonly<{ limit?: number; now: Date }>
): Promise<number> {
  const limit = input.limit ?? MEMORY_HISTORY_FENCE_REPAIR_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_HISTORY_FENCE_REPAIR_BATCH_SIZE ||
    !Number.isFinite(input.now.getTime())) throw new Error("memory_history_fence_repair_input_invalid");
  const candidates = await client.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
    SELECT job.id, job."userId" FROM "MemoryJob" AS job
    JOIN "User" AS owner_user ON owner_user.id = job."userId"
      AND owner_user.status = 'active'::"UserStatus"
    JOIN "UserMemorySettings" AS settings ON settings."userId" = job."userId"
    WHERE ${repairableFenceCasualtySql()}
    ORDER BY job."completedAt", job.id LIMIT ${limit}
  `).catch(retainDatabaseFailure);
  const owners = new Map<string, string[]>();
  for (const { id, userId } of candidates) owners.set(userId, [...(owners.get(userId) ?? []), id]);
  let repaired = 0;
  let failed = 0;
  for (const [userId, ids] of owners) {
    try {
      // Recovery lock order: owner and settings first, then the job rows.
      repaired += await withLockedMemoryTransaction(client, userId, async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT job.id FROM "MemoryJob" AS job
          WHERE job."userId" = ${userId} AND job.id IN (${Prisma.join(ids)})
            AND ${repairableFenceCasualtySql()}
          FOR UPDATE OF job SKIP LOCKED
        `);
        if (locked.length === 0) return 0;
        const updated = await tx.memoryJob.updateMany({
          data: { progressAt: input.now, state: "STALE", updatedAt: input.now },
          where: { errorCode: FENCED_HISTORY_FAILURE_CODE, id: { in: locked.map(({ id }) => id) },
            kind: "INDEX_HISTORY", state: "TERMINAL_FAILED", userId }
        });
        return updated.count;
      });
    } catch (error) {
      // Account disable or deletion may win after selection. Any other owner
      // failure retries on a later pass without holding other owners back.
      if (!(error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable")) failed += 1;
    }
  }
  if (repaired > 0 || failed > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "recovery",
      outcome: failed > 0 ? "failed" : "completed", action: "retry",
      code: MEMORY_HISTORY_FENCE_REPAIR_VERSION, count: repaired,
      ...(failed > 0 ? { failed_count: failed } : {}) });
  }
  return repaired;
}
