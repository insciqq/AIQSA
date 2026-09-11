import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminMemoryProcessingIssue, AdminMemoryStatus } from "../../../contracts/adminMemory";
import { createSystemModelRoleResolver } from "../../providerRuntime/systemModelRole";

const STALLED_MS = 15 * 60_000;
const RETRY_WARNING_MS = 5 * 60_000;
type Stage = AdminMemoryProcessingIssue["stage"];
type Reason = AdminMemoryProcessingIssue["reason"];
type ProcessingRow = { stage: Stage; reason: Reason | null; count: bigint; oldestAt: Date };
const priority: Record<Reason, number> = {
  MODEL_UNAVAILABLE: 6, CAPABILITY_UNAVAILABLE: 5, CONFIGURATION_REQUIRED: 4,
  PROCESSING_FAILED: 3, STALLED: 2, RETRYING: 1
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
    createSystemModelRoleResolver(client).resolve(),
    client.$queryRaw<ProcessingRow[]>(Prisma.sql`
      WITH current_jobs AS (
        SELECT job.id, job."userId", job.kind, job.state, job."errorCode", job."createdAt",
          job."completedAt", job."sourceMessageId", job."targetFactVersionId", job."chatId",
          CASE
            WHEN job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS') THEN 'LEARNING'
            WHEN job.kind = 'INDEX_HISTORY' THEN 'HISTORY'
            WHEN job.kind IN ('EMBED_ITEMS', 'REBUILD_INDEX') THEN 'INDEXING'
            WHEN job.kind = 'SYNTHESIZE_MEMORIES' THEN 'SYNTHESIS'
            ELSE 'MAINTENANCE'
          END AS stage
        FROM "MemoryJob" AS job
        JOIN "UserMemorySettings" AS settings ON settings."userId" = job."userId"
          AND settings."memoryGeneration" = job."memoryGenerationSnapshot"
        JOIN "User" AS owner ON owner.id = job."userId" AND owner.status = 'active'::"UserStatus"
        LEFT JOIN "Chat" AS chat ON chat.id = job."chatId" AND chat."userId" = job."userId"
        LEFT JOIN "Message" AS source ON source.id = job."sourceMessageId" AND source."chatId" = chat.id
        WHERE job.state NOT IN ('CANCELLED', 'STALE') AND job."createdAt" <= ${now}
          AND CASE
            WHEN job.kind = 'INDEX_HISTORY' THEN settings."useMemoryFacts" AND settings."referenceChatHistory"
            WHEN job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS')
              THEN settings."useMemoryFacts" AND settings."learnAutomatically"
            WHEN job.kind = 'SYNTHESIZE_MEMORIES' THEN settings."useMemoryFacts" AND settings."synthesisEnabled"
            ELSE settings."useMemoryFacts"
          END
          AND (job."chatId" IS NULL OR (
            chat.id IS NOT NULL AND chat."projectId" IS NULL AND chat."permanentDeletionAt" IS NULL
            AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
            AND (job."branchGeneration" IS NULL OR job."branchGeneration" = chat."memoryBranchGeneration")
            AND (job."sourceRevision" IS NULL OR job."sourceRevision" = chat."memorySourceRevision")
            AND (job."activeLeafMessageId" IS NULL OR job."activeLeafMessageId" = chat."activeLeafMessageId")
            AND (job."sourceMessageId" IS NULL OR source.id IS NOT NULL)
          ))
          AND (job."targetFactVersionId" IS NULL OR EXISTS (
            SELECT 1 FROM "MemoryFactVersion" AS version
            JOIN "MemoryFact" AS fact ON fact.id = version."factId" AND fact."userId" = version."userId"
              AND fact."currentVersionId" = version.id AND fact.state = 'ACTIVE'::"MemoryFactState"
            JOIN "MemoryScope" AS scope ON scope.id = fact."scopeId" AND scope."userId" = fact."userId"
              AND scope.state = 'ACTIVE'::"MemoryScopeState" AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
            WHERE version.id = job."targetFactVersionId" AND version."userId" = job."userId"
              AND version.state = 'ACTIVE'::"MemoryFactVersionState"
          ))
          AND NOT EXISTS (
            SELECT 1 FROM "MemorySourceBarrier" AS barrier
            WHERE barrier."userId" = job."userId" AND NOT barrier."explicitOverrideAllowed"
              AND COALESCE(source."createdAt", job."createdAt") <= barrier."sourceCreatedAtCutoff"
              AND (barrier.kind = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
                OR (barrier.kind = 'HISTORY_INDEX'::"MemorySourceBarrierKind" AND job.kind = 'INDEX_HISTORY')
                OR (barrier.kind = 'AUTOMATIC_FACTS'::"MemorySourceBarrierKind"
                  AND job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS')))
          )
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryPauseInterval" AS pause
            WHERE pause."userId" = job."userId"
              AND COALESCE(source."createdAt", job."createdAt") >= pause."pausedAt"
              AND (pause."resumedAt" IS NULL OR COALESCE(source."createdAt", job."createdAt") <= pause."resumedAt")
              AND (pause.scope = 'MASTER' OR (pause.scope = 'AUTOMATIC_LEARNING'
                AND job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS'))
                OR (pause.scope = 'SEARCH_HISTORY' AND job.kind = 'INDEX_HISTORY'))
          )
      ), classified AS (
        SELECT job.stage, job."createdAt",
          CASE
            WHEN job.state IN ('WAITING_FOR_CONFIGURATION', 'WAITING_FOR_EGRESS_CONSENT') THEN
              CASE job."errorCode"
                WHEN 'memory_execution_target_unavailable' THEN 'MODEL_UNAVAILABLE'
                WHEN 'memory_execution_capability_unavailable' THEN 'CAPABILITY_UNAVAILABLE'
                ELSE 'CONFIGURATION_REQUIRED'
              END
            WHEN job.state = 'TERMINAL_FAILED' THEN 'PROCESSING_FAILED'
            WHEN job.state = 'RETRYABLE_FAILED' AND job."createdAt" <= ${new Date(now.getTime() - RETRY_WARNING_MS)} THEN 'RETRYING'
            WHEN job.state IN ('QUEUED', 'CLAIMED') AND job."createdAt" <= ${new Date(now.getTime() - STALLED_MS)}
              AND NOT EXISTS (SELECT 1 FROM current_jobs AS progress
                WHERE progress."userId" = job."userId" AND progress.stage = job.stage
                  AND progress.state = 'SUCCEEDED' AND progress."completedAt" > ${new Date(now.getTime() - STALLED_MS)})
              THEN 'STALLED'
            ELSE NULL
          END AS reason
        FROM current_jobs AS job
        WHERE job.state <> 'SUCCEEDED'
          AND (job.state <> 'TERMINAL_FAILED' OR NOT EXISTS (
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
            WHEN deletion."createdAt" <= ${new Date(now.getTime() - STALLED_MS)} THEN 'STALLED' ELSE NULL END
        FROM "MemoryDeletionOutbox" AS deletion
        WHERE deletion.state IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN')
      )
      SELECT stage, reason, count(*) AS count, min("createdAt") AS "oldestAt"
      FROM classified GROUP BY stage, reason
    `)
  ]);
  const issues = new Map<Stage, AdminMemoryProcessingIssue>();
  for (const row of rows) {
    const modelUnavailable = row.stage === "LEARNING" && !role.ok;
    const reason = modelUnavailable && row.reason !== "CAPABILITY_UNAVAILABLE"
      ? "MODEL_UNAVAILABLE" : row.reason;
    if (!reason) continue;
    const count = Number(row.count);
    const oldestAgeSeconds = Math.max(0, Math.floor((now.getTime() - row.oldestAt.getTime()) / 1000));
    const previous = issues.get(row.stage);
    const selectedReason = previous && priority[previous.reason] > priority[reason] ? previous.reason : reason;
    issues.set(row.stage, {
      count: (previous?.count ?? 0) + count,
      oldestAgeSeconds: Math.max(previous?.oldestAgeSeconds ?? 0, oldestAgeSeconds),
      reason: selectedReason,
      severity: row.stage === "INDEXING" || selectedReason === "RETRYING" || selectedReason === "STALLED" ? "warn" : "bad",
      stage: row.stage
    });
  }
  if (!role.ok && Number(owners[0]?.learning ?? 0) > 0 && !issues.has("LEARNING")) {
    issues.set("LEARNING", { count: 0, oldestAgeSeconds: null, reason: "MODEL_UNAVAILABLE", severity: "bad", stage: "LEARNING" });
  }
  return {
    enabled: Number(owners[0]?.enabled ?? 0) > 0,
    issues: [...issues.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.stage.localeCompare(b.stage))
  };
}
