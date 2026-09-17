import { Prisma } from "@prisma/client";
import { MEMORY_COORDINATOR_JOB_KINDS } from "./registry";

export const MEMORY_RECOVERY_BATCH_SIZE = 8;
export const MEMORY_RECOVERY_INTERVAL_MS = 60_000;
export const MEMORY_RECOVERY_DELAYS_MS = Object.freeze([5 * 60_000, 30 * 60_000, 6 * 60 * 60_000]);

/** Only persistence failures whose rollback is known, plus the legacy history
 * apply failure repaired by the current writer. Unknown/model-output failures
 * do not grant another paid execution. These predicates use current_jobs job. */
export function memoryRecoverableFailureSql(): Prisma.Sql {
  return Prisma.sql`(job.kind IN (${Prisma.join(MEMORY_COORDINATOR_JOB_KINDS.map((kind) => Prisma.sql`${kind}::"MemoryJobKind"`))}) AND COALESCE((
    job."errorCode" IN ('memory_job_commit_timeout', 'memory_job_commit_database_p2034',
      'memory_job_commit_database_p1001', 'memory_job_commit_database_p1002',
      'memory_job_commit_database_p1017')
    OR (job.kind = 'INDEX_HISTORY'::"MemoryJobKind" AND job."workStage" = 'lexical_apply'
      AND job."errorCode" = 'memory_job_commit_database_failed')
  ), FALSE))`;
}

export function memoryRecoveryDueAtSql(): Prisma.Sql {
  return Prisma.sql`job."completedAt" + CASE job."recoveryCount"
    WHEN 0 THEN ${MEMORY_RECOVERY_DELAYS_MS[0]}
    WHEN 1 THEN ${MEMORY_RECOVERY_DELAYS_MS[1]}
    ELSE ${MEMORY_RECOVERY_DELAYS_MS[2]}
  END::double precision * INTERVAL '1 millisecond'`;
}

/** A binding without a retained result cannot be replayed by a generic retry.
 * Feature-specific receipt recovery may lift this restriction separately. */
export function memoryRecoveryProtectedSql(): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "MemoryExecutionBinding" AS execution
    WHERE execution."userId" = job."userId" AND execution."memoryJobId" = job.id
  )`;
}

export function memoryTerminalRecoveryEligibleSql(now: Date): Prisma.Sql {
  return Prisma.sql`job.state = 'TERMINAL_FAILED'::"MemoryJobState"
    AND ${memoryRecoverableFailureSql()}
    AND job."recoveryCount" < ${MEMORY_RECOVERY_DELAYS_MS.length}
    AND (${memoryRecoveryDueAtSql()}) <= ${now}
    AND NOT ${memoryRecoveryProtectedSql()}
    AND ${memoryUnresolvedFailureSql()}`;
}

export function memoryUnresolvedFailureSql(): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM current_jobs AS recovered
    WHERE recovered."userId" = job."userId" AND recovered.kind = job.kind
      AND recovered.state = 'SUCCEEDED' AND recovered."completedAt" > job."completedAt"
      AND recovered."sourceMessageId" IS NOT DISTINCT FROM job."sourceMessageId"
      AND recovered."targetFactVersionId" IS NOT DISTINCT FROM job."targetFactVersionId"
      AND recovered."chatId" IS NOT DISTINCT FROM job."chatId"
  )`;
}
