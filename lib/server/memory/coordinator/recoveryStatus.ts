import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminMemoryStatus } from "../../../contracts/adminMemory";
import { currentMemoryJobsSql } from "./currentJobs";
import {
  MEMORY_RECOVERY_DELAYS_MS,
  memoryRecoverableFailureSql,
  memoryRecoveryDueAtSql,
  memoryRecoveryProtectedSql,
  memoryUnresolvedFailureSql
} from "./recoveryPolicy";

export async function readMemoryRecoveryStatus(
  client: PrismaClient,
  now: Date
): Promise<AdminMemoryStatus["recovery"]> {
  const rows = await client.$queryRaw<Array<{
    eligible: bigint; scheduled: bigint; permanent: bigint; protected: bigint;
    exhausted: bigint; obsolete: bigint; configurationRequired: bigint; nextRetryAt: Date | null;
  }>>(Prisma.sql`
    WITH ${currentMemoryJobsSql(now)}, failures AS (
      SELECT job.id, (${memoryRecoveryDueAtSql()}) AS "dueAt",
        CASE
          WHEN job.state IN ('WAITING_FOR_CONFIGURATION', 'WAITING_FOR_EGRESS_CONSENT') THEN 'configuration'
          WHEN NOT ${memoryRecoverableFailureSql()} THEN 'permanent'
          WHEN ${memoryRecoveryProtectedSql()} THEN 'protected'
          WHEN job."recoveryCount" >= ${MEMORY_RECOVERY_DELAYS_MS.length} THEN 'exhausted'
          WHEN (${memoryRecoveryDueAtSql()}) > ${now} THEN 'scheduled'
          ELSE 'eligible'
        END AS category
      FROM current_jobs AS job
      WHERE job.state IN ('TERMINAL_FAILED', 'WAITING_FOR_CONFIGURATION', 'WAITING_FOR_EGRESS_CONSENT')
        AND (job.state <> 'TERMINAL_FAILED' OR ${memoryUnresolvedFailureSql()})
    )
    SELECT count(*) FILTER (WHERE category = 'eligible') AS eligible,
      count(*) FILTER (WHERE category = 'scheduled') AS scheduled,
      count(*) FILTER (WHERE category = 'permanent') AS permanent,
      count(*) FILTER (WHERE category = 'protected') AS protected,
      count(*) FILTER (WHERE category = 'exhausted') AS exhausted,
      count(*) FILTER (WHERE category = 'configuration') AS "configurationRequired",
      min("dueAt") FILTER (WHERE category = 'scheduled') AS "nextRetryAt",
      (SELECT count(*) FROM "MemoryJob" AS historical
        WHERE (historical.state = 'TERMINAL_FAILED' OR (historical.state = 'STALE' AND historical."errorCode" IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM failures WHERE failures.id = historical.id)) AS obsolete
    FROM failures
  `);
  const row = rows[0];
  if (!row) throw new Error("memory_recovery_status_invalid");
  return {
    eligible: Number(row.eligible), scheduled: Number(row.scheduled),
    permanent: Number(row.permanent), protected: Number(row.protected),
    exhausted: Number(row.exhausted), obsolete: Number(row.obsolete),
    configurationRequired: Number(row.configurationRequired),
    nextRetrySeconds: row.nextRetryAt === null ? null :
      Math.max(0, Math.ceil((row.nextRetryAt.getTime() - now.getTime()) / 1_000))
  };
}
