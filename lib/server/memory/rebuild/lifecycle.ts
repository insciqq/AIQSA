import { Prisma } from "@prisma/client";
import type { MemoryTransaction } from "../persistence/transaction";
import { MEMORY_SHADOW_REBUILD_PIPELINE_VERSION, memoryShadowRebuildJobPrefixes } from "./contract";

const shadowStates = ["BUILDING", "CATCHING_UP", "READY"] as const;
const recoverableStates = ["QUEUED", "CLAIMED", "RETRYABLE_FAILED",
  "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT", "SUCCEEDED"] as const;

function shadowJobPredicate(generation: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`rebuild_job."userId" = ${generation}."userId"
    AND rebuild_job.kind = 'REBUILD_INDEX'
    AND rebuild_job."pipelineVersion" = ${MEMORY_SHADOW_REBUILD_PIPELINE_VERSION}
    AND (rebuild_job."idempotencyFingerprint" LIKE
      (${MEMORY_SHADOW_REBUILD_PIPELINE_VERSION + ":r:"} || ${generation}.id || ':%')
      OR rebuild_job."idempotencyFingerprint" LIKE
      (${MEMORY_SHADOW_REBUILD_PIPELINE_VERSION + ":e:"} || ${generation}.id || ':%'))`;
}

export function memoryOrphanShadowPredicate(generation: Prisma.Sql): Prisma.Sql {
  // SUCCEEDED is a completed parent pass waiting for child/source settlement;
  // the existing wake path owns its next pass and full cutover proof.
  return Prisma.sql`${generation}.state IN ('BUILDING', 'CATCHING_UP', 'READY')
    AND NOT EXISTS (SELECT 1 FROM "MemoryJob" rebuild_job
      WHERE ${shadowJobPredicate(generation)}
        AND rebuild_job.state::text IN (${Prisma.join(recoverableStates)}))`;
}

export function memoryShadowCancelledByPausePredicate(generation: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`${generation}.state = 'CANCELLED'
    AND EXISTS (SELECT 1 FROM "MemoryJob" rebuild_job
      WHERE ${shadowJobPredicate(generation)}
        AND rebuild_job.state = 'CANCELLED' AND rebuild_job."errorCode" = 'memory_master_paused')`;
}

/** Caller owns the settings lock. Retire only invisible derived entries; the
 * selected active generation and canonical history/facts are never changed. */
export async function reconcileMemoryShadowGenerations(
  tx: MemoryTransaction,
  userId: string,
  pauseAt?: Date
): Promise<number> {
  const shadows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT shadow.id FROM "MemoryIndexGeneration" shadow
    WHERE shadow."userId" = ${userId}
      AND ${pauseAt
        ? Prisma.sql`shadow.state IN ('BUILDING', 'CATCHING_UP', 'READY')`
        : memoryOrphanShadowPredicate(Prisma.sql`shadow`)}
  `);
  for (const shadow of shadows) {
    const where = {
      userId, kind: "REBUILD_INDEX" as const,
      OR: memoryShadowRebuildJobPrefixes(shadow.id).map(prefix => ({
        idempotencyFingerprint: { startsWith: prefix }
      }))
    };
    if (pauseAt) {
      // The master pause already cancelled leased/queued jobs. A completed
      // parent pass may still own an unfinished shadow, so fence that too.
      await tx.memoryJob.updateMany({ where: { ...where, state: { in: [...recoverableStates] } },
        data: { state: "CANCELLED", completedAt: pauseAt, updatedAt: pauseAt,
          errorCode: "memory_master_paused", errorMessage: null,
          leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null } });
    }
    const failed = !pauseAt && await tx.memoryJob.count({ where: { ...where, state: "TERMINAL_FAILED" } });
    await tx.memoryIndexGeneration.updateMany({
      where: { id: shadow.id, userId, state: { in: [...shadowStates] } },
      data: { state: failed ? "FAILED" : "CANCELLED" }
    });
    await tx.memorySearchEntry.deleteMany({ where: { userId, indexGenerationId: shadow.id } });
  }
  return shadows.length;
}
