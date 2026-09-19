import { Prisma, type PrismaClient } from "@prisma/client";
import { adminMemoryProcessingIssueKey, type AdminMemoryProcessingIssue, type AdminMemoryStatus } from "../../../contracts/adminMemory";
import { currentMemoryJobsSql } from "../../memory/coordinator/currentJobs";
import { memoryHistoryActiveWorkSql, memoryHistoryAutoHealAttemptsSql, memoryHistoryAutoHealProtectedSql, memoryHistoryIncompleteOutputSql } from "../../memory/history/autoHeal";
import { MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS } from "../../memory/history/contract";
import { createMemoryUtilityModelRoleResolver } from "../../providerRuntime/memoryUtilityModelRole";

const STALLED_MS = 15 * 60_000;
const RETRY_WARNING_MS = 5 * 60_000;
type Stage = AdminMemoryProcessingIssue["stage"];
type Reason = AdminMemoryProcessingIssue["reason"];
type Healing = NonNullable<AdminMemoryProcessingIssue["autoHeal"]>;
type ProcessingRow = { stage: Stage; reason: Reason | null; autoHeal: Healing | null; count: bigint; oldestAt: Date };
const priority: Record<Reason, number> = {
  MODEL_UNAVAILABLE: 6, CAPABILITY_UNAVAILABLE: 5, CONFIGURATION_REQUIRED: 4,
  PROCESSING_FAILED: 3, STALLED: 2, RETRYING: 1, OUTPUT_LIMIT: 0, HISTORY_INCOMPLETE: 0
};

/** Read-only aggregates. Source identities stay inside PostgreSQL; worker
 * heartbeat and renewable leases are deliberately not evidence of progress. */
export async function readAdminMemoryProcessing(
  client: PrismaClient,
  now: Date
): Promise<AdminMemoryStatus["processing"]> {
  const [owners, role, rows] = await Promise.all([
    client.$queryRaw<Array<{ enabled: bigint; learning: bigint }>>(Prisma.sql`
      SELECT count(*) FILTER (WHERE settings."useMemoryFacts") AS enabled,
        count(*) FILTER (WHERE settings."useMemoryFacts" AND settings."learnAutomatically") AS learning
      FROM "UserMemorySettings" AS settings
      JOIN "User" AS owner ON owner.id = settings."userId" AND owner.status = 'active'::"UserStatus"
    `),
    createMemoryUtilityModelRoleResolver(client).resolve(),
    client.$queryRaw<ProcessingRow[]>(Prisma.sql`
      WITH ${currentMemoryJobsSql(now)}, classified AS (
        SELECT job.stage, job."createdAt",
          CASE
            WHEN job.state IN ('WAITING_FOR_CONFIGURATION', 'WAITING_FOR_EGRESS_CONSENT') THEN
              CASE job."errorCode"
                WHEN 'memory_execution_target_unavailable' THEN 'MODEL_UNAVAILABLE'
                WHEN 'memory_execution_capability_unavailable' THEN 'CAPABILITY_UNAVAILABLE'
                ELSE 'CONFIGURATION_REQUIRED'
              END
            WHEN job.kind = 'INDEX_HISTORY' AND job.state = 'SUCCEEDED' AND EXISTS (
              SELECT 1 FROM "MemoryExecutionBinding" AS binding
              WHERE binding."memoryJobId" = job.id AND binding."userId" = job."userId"
                AND binding."errorCode" = 'memory_classifier_output_limit_exceeded'
            ) THEN 'OUTPUT_LIMIT'
            WHEN ${memoryHistoryIncompleteOutputSql()} THEN 'HISTORY_INCOMPLETE'
            WHEN job.state = 'TERMINAL_FAILED' THEN 'PROCESSING_FAILED'
            WHEN job.state = 'RETRYABLE_FAILED' AND job."createdAt" <= ${new Date(now.getTime() - RETRY_WARNING_MS)} THEN 'RETRYING'
            WHEN job.state IN ('QUEUED', 'CLAIMED') AND job."createdAt" <= ${new Date(now.getTime() - STALLED_MS)}
              AND (job."progressAt" IS NULL OR job."progressAt" <= ${new Date(now.getTime() - STALLED_MS)})
              AND (job.state = 'CLAIMED' OR NOT EXISTS (SELECT 1 FROM current_jobs AS progress
                WHERE progress."userId" = job."userId" AND progress.stage = job.stage
                  AND progress.state = 'SUCCEEDED' AND progress."completedAt" > ${new Date(now.getTime() - STALLED_MS)}))
              THEN 'STALLED'
            ELSE NULL
          END AS reason,
          CASE WHEN ${memoryHistoryIncompleteOutputSql()} THEN CASE
            WHEN ${memoryHistoryActiveWorkSql()} THEN 'RETRYING'
            WHEN EXISTS (SELECT 1 FROM current_jobs newer
              WHERE newer."userId" = job."userId" AND newer.kind = job.kind AND newer."chatId" = job."chatId"
                AND (newer."createdAt", newer.id) > (job."createdAt", job.id)
                AND newer.state = 'TERMINAL_FAILED') THEN 'UNAVAILABLE'
            WHEN ${memoryHistoryAutoHealProtectedSql()} THEN 'UNAVAILABLE'
            WHEN ${memoryHistoryAutoHealAttemptsSql()} >= ${MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS.length} THEN 'EXHAUSTED'
            ELSE 'RETRYING' END ELSE NULL END AS "autoHeal"
        FROM current_jobs AS job
        WHERE (job.state <> 'SUCCEEDED' OR job.kind = 'INDEX_HISTORY')
          AND (job.state NOT IN ('TERMINAL_FAILED', 'SUCCEEDED') OR NOT EXISTS (
            SELECT 1 FROM current_jobs AS recovered
            WHERE recovered."userId" = job."userId" AND recovered.kind = job.kind AND recovered.state = 'SUCCEEDED'
              AND recovered."completedAt" > job."completedAt"
              AND recovered."sourceMessageId" IS NOT DISTINCT FROM job."sourceMessageId"
              AND recovered."targetFactVersionId" IS NOT DISTINCT FROM job."targetFactVersionId"
              AND recovered."chatId" IS NOT DISTINCT FROM job."chatId"
          ))
        UNION ALL
        SELECT 'DELETION', deletion."createdAt",
          CASE WHEN deletion.state = 'BLOCKED_REQUIRES_ADMIN' THEN 'PROCESSING_FAILED'
            WHEN deletion."createdAt" <= ${new Date(now.getTime() - STALLED_MS)}
              AND (deletion."progressAt" IS NULL OR deletion."progressAt" <= ${new Date(now.getTime() - STALLED_MS)})
              THEN 'STALLED' ELSE NULL END, NULL AS "autoHeal"
        FROM "MemoryDeletionOutbox" AS deletion
        WHERE deletion.state IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN')
      )
      SELECT stage, reason, "autoHeal", count(*) AS count, min("createdAt") AS "oldestAt"
      FROM classified GROUP BY stage, reason, "autoHeal"
    `)
  ]);
  const issues = new Map<string, AdminMemoryProcessingIssue>();
  for (const row of rows) {
    const modelUnavailable = row.stage === "LEARNING" && !role.ok;
    const reason = modelUnavailable && row.reason !== "CAPABILITY_UNAVAILABLE"
      ? "MODEL_UNAVAILABLE" : row.reason;
    if (!reason) continue;
    const count = Number(row.count);
    const oldestAgeSeconds = Math.max(0, Math.floor((now.getTime() - row.oldestAt.getTime()) / 1000));
    const healing = row.autoHeal && !role.ok ? "UNAVAILABLE" : row.autoHeal;
    const issue: AdminMemoryProcessingIssue = {
      ...(healing && (reason === "OUTPUT_LIMIT" || reason === "HISTORY_INCOMPLETE") ? { autoHeal: healing } : {}),
      count,
      oldestAgeSeconds,
      reason,
      severity: row.stage === "INDEXING" || reason === "RETRYING" || reason === "STALLED" || reason === "OUTPUT_LIMIT" || reason === "HISTORY_INCOMPLETE" ? "warn" : "bad",
      stage: row.stage
    };
    const key = adminMemoryProcessingIssueKey(issue);
    const previous = issues.get(key);
    issues.set(key, { ...issue, count: (previous?.count ?? 0) + count,
      oldestAgeSeconds: Math.max(previous?.oldestAgeSeconds ?? 0, oldestAgeSeconds) });
  }
  if (!role.ok && Number(owners[0]?.learning ?? 0) > 0 && ![...issues.values()].some(issue => issue.stage === "LEARNING")) {
    const issue = { count: 0, oldestAgeSeconds: null, reason: "MODEL_UNAVAILABLE", severity: "bad", stage: "LEARNING" } as const;
    issues.set(adminMemoryProcessingIssueKey(issue), issue);
  }
  return {
    enabled: Number(owners[0]?.enabled ?? 0) > 0,
    issues: [...issues.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.stage.localeCompare(b.stage)
      || priority[b.reason] - priority[a.reason] || adminMemoryProcessingIssueKey(a).localeCompare(adminMemoryProcessingIssueKey(b)))
  };
}
