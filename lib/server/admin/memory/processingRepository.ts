import { Prisma, type PrismaClient } from "@prisma/client";
import { adminMemoryProcessingIssueKey, type AdminMemoryProcessingIssue, type AdminMemoryStatus } from "../../../contracts/adminMemory";
import { currentMemoryJobsSql } from "../../memory/coordinator/currentJobs";
import { memoryHistoryActiveWorkSql, memoryHistoryAutoHealAttemptsSql, memoryHistoryAutoHealProtectedSql, memoryHistoryIncompleteOutputSql,
  memoryHistoryUnrepairedOutputFailureSql } from "../../memory/history/autoHeal";
import { MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS } from "../../memory/history/contract";
import { memoryMaintenanceSourcePredicate } from "../../memory/maintenance/source";
import { createMemoryUtilityModelRoleResolver } from "../../providerRuntime/memoryUtilityModelRole";
import { MEMORY_PREPARATION_FAILURE_CODES } from "../../runs/preparingFailOpen";

const STALLED_MS = 15 * 60_000;
const RETRY_WARNING_MS = 5 * 60_000;
/** Users never see Memory command/search/preparation failures; administrators
 * get a rolling 24-hour count of them. Unindexed full scan inside the window. */
const RECENT_ACTIVITY_MS = 24 * 60 * 60_000;
type Stage = AdminMemoryProcessingIssue["stage"];
type Reason = AdminMemoryProcessingIssue["reason"];
type Healing = NonNullable<AdminMemoryProcessingIssue["autoHeal"]>;
type ProcessingRow = { stage: Stage; reason: Reason | null; autoHeal: Healing | null; count: bigint; oldestAt: Date };
type RecentActivityRow = { stage: "COMMAND" | "SEARCH" | "PREPARATION";
  reason: "COMMAND_FAILED" | "COMMAND_UNKNOWN" | "SEARCH_DEGRADED" | "SEARCH_FAILED" | "PREPARATION_SKIPPED" | "PREPARATION_FAILED";
  count: bigint; oldestAt: Date };
const priority: Record<Reason, number> = {
  MODEL_UNAVAILABLE: 6, CAPABILITY_UNAVAILABLE: 5, CONFIGURATION_REQUIRED: 4,
  PROCESSING_FAILED: 3, STALLED: 2, RETRYING: 1, OUTPUT_LIMIT: 0, HISTORY_INCOMPLETE: 0,
  COMMAND_FAILED: 1, COMMAND_UNKNOWN: 0, SEARCH_FAILED: 1, SEARCH_DEGRADED: 0,
  PREPARATION_FAILED: 1, PREPARATION_SKIPPED: 0
};

/** Only allowlisted statuses are counted; no content, identity or error text
 * leaves PostgreSQL. A command projected as FAILED/UNKNOWN by its queue state
 * (projection.ts) counts the same as a recorded terminal status. */
function recentActivitySql(now: Date): Prisma.Sql {
  const since = new Date(now.getTime() - RECENT_ACTIVITY_MS);
  return Prisma.sql`
    WITH recent AS (
      SELECT 'COMMAND' AS stage,
        CASE WHEN job."commandStatus" = 'FAILED'::"MemoryCommandStatus"
          OR job.state = 'TERMINAL_FAILED'::"MemoryJobState" THEN 'COMMAND_FAILED' ELSE 'COMMAND_UNKNOWN' END AS reason,
        job."updatedAt" AS "occurredAt"
      FROM "MemoryJob" AS job
      JOIN "User" AS owner ON owner.id = job."userId" AND owner.status = 'active'::"UserStatus"
      WHERE job.kind = 'MEMORY_COMMAND'::"MemoryJobKind"
        AND job."updatedAt" > ${since} AND job."updatedAt" <= ${now}
        AND (job."commandStatus" IN ('FAILED'::"MemoryCommandStatus", 'UNKNOWN'::"MemoryCommandStatus")
          OR (job."commandStatus" IN ('PENDING'::"MemoryCommandStatus", 'RUNNING'::"MemoryCommandStatus")
            AND job.state IN ('TERMINAL_FAILED'::"MemoryJobState", 'SUCCEEDED'::"MemoryJobState")))
      UNION ALL
      SELECT 'SEARCH',
        CASE WHEN run.state = 'ERROR'::"MemoryHistoryRunState" THEN 'SEARCH_FAILED' ELSE 'SEARCH_DEGRADED' END,
        COALESCE(run."completedAt", run."createdAt")
      FROM "MemoryHistoryRun" AS run
      JOIN "User" AS owner ON owner.id = run."userId" AND owner.status = 'active'::"UserStatus"
      WHERE run."createdAt" > ${since} AND run."createdAt" <= ${now}
        -- Cancelled searches are a user Stop, not degradation.
        AND (run.state = 'ERROR'::"MemoryHistoryRunState" OR run.outcome = 'DEGRADED'::"MemoryHistoryRunOutcome")
      UNION ALL
      -- Preparation-level fallbacks alone record a degradation code on a
      -- FAILED_SAFE receipt; retrieval-level optional stages leave it null.
      SELECT 'PREPARATION', 'PREPARATION_SKIPPED', binding."finalizedAt"
      FROM "ModelRunMemoryBinding" AS binding
      JOIN "User" AS owner ON owner.id = binding."userId" AND owner.status = 'active'::"UserStatus"
      WHERE binding."finalizedAt" > ${since} AND binding."finalizedAt" <= ${now}
        AND binding.outcome = 'FAILED_SAFE'::"MemoryReceiptOutcome"
        AND binding."degradationCode" IS NOT NULL
      UNION ALL
      SELECT 'PREPARATION', 'PREPARATION_FAILED', run."updatedAt"
      FROM "ModelRun" AS run
      JOIN "User" AS owner ON owner.id = run."userId" AND owner.status = 'active'::"UserStatus"
      WHERE run.status = 'error'::"ModelRunStatus"
        AND run."updatedAt" > ${since} AND run."updatedAt" <= ${now}
        AND run."errorPayload"->>'code' IN (${Prisma.join(MEMORY_PREPARATION_FAILURE_CODES)})
    )
    SELECT stage, reason, count(*) AS count, min("occurredAt") AS "oldestAt"
    FROM recent GROUP BY stage, reason
  `;
}

/** Uses current_jobs `job`. A failed command is never re-run: it stays a
 * processing failure only for the window in which the command aggregate also
 * reports it. A failed maintenance review has not recovered only while some
 * version it reviewed is still a maintenance source; once none is, nothing
 * remains to retry. Neither rule changes a job. */
function unresolvedTerminalFailureSql(now: Date): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN job.state <> 'TERMINAL_FAILED' THEN TRUE
    WHEN job.kind = 'MEMORY_COMMAND' THEN COALESCE(job."completedAt", job."createdAt") >
      ${new Date(now.getTime() - RECENT_ACTIVITY_MS)}
    WHEN job.kind = 'SYNTHESIZE_MEMORIES' THEN EXISTS (
      SELECT 1 FROM "MemoryMaintenanceReview" AS reviewed
      JOIN "MemoryFactVersion" AS version ON version."userId" = reviewed."userId" AND version.id = reviewed."factVersionId"
      JOIN "MemoryFact" AS fact ON fact."userId" = version."userId" AND fact.id = version."factId"
      JOIN "MemoryScope" AS scope ON scope."userId" = fact."userId" AND scope.id = fact."scopeId"
      JOIN "UserMemorySettings" AS settings ON settings."userId" = fact."userId"
      WHERE reviewed."userId" = job."userId" AND reviewed."memoryJobId" = job.id
        AND ${memoryMaintenanceSourcePredicate(Prisma.sql`job."userId"`)})
    ELSE TRUE
  END`;
}

/** Read-only aggregates. Source identities stay inside PostgreSQL; worker
 * heartbeat and renewable leases are deliberately not evidence of progress. */
export async function readAdminMemoryProcessing(
  client: PrismaClient,
  now: Date
): Promise<AdminMemoryStatus["processing"]> {
  const [owners, role, rows, recentRows] = await Promise.all([
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
            WHEN job.kind = 'INDEX_HISTORY' AND job.state = 'SUCCEEDED' AND ${memoryHistoryUnrepairedOutputFailureSql([
              "memory_classifier_output_limit_exceeded"
            ])} THEN 'OUTPUT_LIMIT'
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
          AND ${unresolvedTerminalFailureSql(now)}
        UNION ALL
        SELECT 'DELETION', CASE WHEN deletion.state IN ('PENDING', 'RETRY_WAIT')
          THEN GREATEST(deletion."createdAt", deletion."nextAttemptAt") ELSE deletion."createdAt" END,
          CASE WHEN deletion.state = 'BLOCKED_REQUIRES_ADMIN' THEN 'PROCESSING_FAILED'
            WHEN deletion."createdAt" <= ${new Date(now.getTime() - STALLED_MS)}
              AND (deletion."progressAt" IS NULL OR deletion."progressAt" <= ${new Date(now.getTime() - STALLED_MS)})
              -- Scheduled retention and retry backoff are not stalled work.
              AND (deletion.state = 'RUNNING' OR deletion."nextAttemptAt" IS NULL
                OR deletion."nextAttemptAt" <= ${new Date(now.getTime() - STALLED_MS)})
              THEN 'STALLED' ELSE NULL END, NULL AS "autoHeal"
        FROM "MemoryDeletionOutbox" AS deletion
        WHERE deletion.state IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN')
      )
      SELECT stage, reason, "autoHeal", count(*) AS count, min("createdAt") AS "oldestAt"
      FROM classified GROUP BY stage, reason, "autoHeal"
    `),
    client.$queryRaw<RecentActivityRow[]>(recentActivitySql(now))
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
  for (const row of recentRows) {
    const issue: AdminMemoryProcessingIssue = {
      count: Number(row.count),
      oldestAgeSeconds: Math.max(0, Math.floor((now.getTime() - row.oldestAt.getTime()) / 1000)),
      reason: row.reason,
      severity: "warn",
      stage: row.stage
    };
    issues.set(adminMemoryProcessingIssueKey(issue), issue);
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
