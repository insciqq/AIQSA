import { Prisma, type PrismaClient } from "@prisma/client";
import { currentMemoryJobsSql } from "../coordinator/currentJobs";
import { memoryRecoveryProtectedSql } from "../coordinator/recoveryPolicy";
import { MemoryPersistenceError } from "../persistence/errors";
import { MemoryExecutionError } from "../execution/errors";
import { probeMemoryStructuredOutputAuthority } from "../execution/structuredClassifier";
import { MEMORY_CONTEXTUAL_KEY_VERSIONS } from "./contextualKeys";
import { enqueueMemoryJob } from "../persistence/jobs";
import { withLockedMemoryTransaction, type MemoryTransaction } from "../persistence/transaction";
import { loadMemorySourceSnapshot } from "../sourceState";
import { MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS, MEMORY_HISTORY_AUTO_HEAL_POLICY_VERSION, MEMORY_HISTORY_INDEX_PIPELINE_VERSION, memoryHistoryAutoHealJobFingerprint } from "./contract";

/** Known settled output failures, not transport ambiguity or successful work. */
export function memoryHistoryIncompleteOutputSql(): Prisma.Sql {
  return Prisma.sql`job.kind = 'INDEX_HISTORY' AND job.state = 'SUCCEEDED' AND EXISTS (
    SELECT 1 FROM "MemoryExecutionBinding" binding
    WHERE binding."memoryJobId" = job.id AND binding."userId" = job."userId"
      AND binding.state = 'FAILED'
      AND binding."errorCode" IN ('memory_classifier_output_limit_exceeded', 'memory_classifier_output_invalid')
  )`;
}

export function memoryHistoryAutoHealAttemptsSql(): Prisma.Sql {
  return Prisma.sql`COALESCE((SELECT max(right(repair."idempotencyFingerprint", 1)::int)
    FROM "MemoryJob" repair WHERE repair."userId" = job."userId" AND repair.kind = job.kind
      AND repair."chatId" = job."chatId" AND repair."sourceRevision" = job."sourceRevision"
      AND repair."branchGeneration" = job."branchGeneration" AND repair."sourceHash" = job."sourceHash"
      AND repair."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND repair."idempotencyFingerprint" ~ ('^heal-history:[a-f0-9]{64}:' || ${MEMORY_HISTORY_AUTO_HEAL_POLICY_VERSION} || ':' ||
        (SELECT version::text FROM "MemoryUtilityModelPolicy" WHERE id = 'installation') || ':[1-3]$')), 0)`;
}

export function memoryHistoryActiveWorkSql(): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "MemoryJob" active
    WHERE active."userId" = job."userId" AND active.kind = job.kind AND active."chatId" = job."chatId"
      AND active.state IN ('QUEUED', 'CLAIMED', 'RETRYABLE_FAILED', 'WAITING_FOR_CONFIGURATION', 'WAITING_FOR_EGRESS_CONSENT'))`;
}

export function memoryHistoryAutoHealProtectedSql(): Prisma.Sql {
  return Prisma.sql`(${memoryRecoveryProtectedSql()} OR EXISTS (
    SELECT 1 FROM "MemoryExecutionBinding" execution
    JOIN "MemoryJob" previous ON previous.id = execution."memoryJobId" AND previous."userId" = execution."userId"
    WHERE previous."userId" = job."userId" AND previous."chatId" = job."chatId" AND previous.kind = job.kind
      AND (execution.state IN ('RUNNING', 'OUTCOME_UNKNOWN')
        OR (execution.state = 'PENDING' AND execution."startedAt" IS NOT NULL))
  ))`;
}

type Candidate = { id: string; userId: string; chatId: string; attempts: number; utilityPolicyVersion: number | null };

function candidates(client: PrismaClient | MemoryTransaction, now: Date, limit: number, id?: string) {
  return client.$queryRaw<Candidate[]>(Prisma.sql`
    WITH ${currentMemoryJobsSql(now)}
    SELECT job.id, job."userId", job."chatId", ${memoryHistoryAutoHealAttemptsSql()} AS attempts,
      (SELECT version FROM "MemoryUtilityModelPolicy" WHERE id = 'installation') AS "utilityPolicyVersion" FROM current_jobs job
    WHERE ${memoryHistoryIncompleteOutputSql()} AND job."chatId" IS NOT NULL
      ${id ? Prisma.sql`AND job.id = ${id}` : Prisma.empty}
      AND NOT ${memoryHistoryAutoHealProtectedSql()}
      AND ${memoryHistoryAutoHealAttemptsSql()} < ${MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS.length}
      AND job."completedAt" + CASE ${memoryHistoryAutoHealAttemptsSql()}
        WHEN 0 THEN ${MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]}
        WHEN 1 THEN ${MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[1]}
        ELSE ${MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[2]}
      END::double precision * INTERVAL '1 millisecond' <= ${now}
      AND NOT EXISTS (
        SELECT 1 FROM current_jobs newer
        WHERE newer."userId" = job."userId" AND newer.kind = job.kind AND newer."chatId" = job."chatId"
          AND (newer."createdAt", newer.id) > (job."createdAt", job.id)
      )
      AND NOT ${memoryHistoryActiveWorkSql()}
    ORDER BY job."createdAt", job.id LIMIT ${limit}
  `);
}

/** Bounded background repair of known failed enrichment. Each attempt has a
 * durable unique identity; existing jobs/bindings/usage remain immutable.
 * Successful stages are reused by incremental history and digest generation. */
export async function autoHealIncompleteMemoryHistory(
  client: PrismaClient,
  input: Readonly<{ limit: number; now: Date }>
): Promise<number> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 8 ||
    !Number.isFinite(input.now.getTime())) throw new Error("memory_history_auto_heal_input_invalid");
  const selected = await candidates(client, input.now, input.limit);
  let admitted = 0;
  for (const candidate of selected) {
    try {
      await probeMemoryStructuredOutputAuthority({ client, authority: { now: () => input.now },
        role: "MEMORY_HISTORY_CLASSIFY", userId: candidate.userId, versions: MEMORY_CONTEXTUAL_KEY_VERSIONS });
    } catch (error) {
      if (error instanceof MemoryExecutionError || error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable") continue;
      throw error;
    }
    const created = await withLockedMemoryTransaction(client, candidate.userId, async (tx, settings) => {
      const [current] = await candidates(tx, input.now, 1, candidate.id);
      if (!current || current.utilityPolicyVersion === null) return false;
      const source = await loadMemorySourceSnapshot(tx, {
        userId: candidate.userId, chatId: candidate.chatId, personalOnly: true, lock: "SHARE"
      });
      if (!source || source.memoryMode !== "NORMAL" || !source.activeLeafMessageId ||
        !settings.useMemoryFacts || !settings.referenceChatHistory) return false;
      const prior = await tx.memoryJob.findUniqueOrThrow({ where: { id: candidate.id } });
      if (prior.sourceHash !== source.sourceHash || prior.sourceRevision !== source.memorySourceRevision ||
        prior.branchGeneration !== source.memoryBranchGeneration || prior.activeLeafMessageId !== source.activeLeafMessageId) return false;
      const queued = await enqueueMemoryJob(tx, settings, {
        kind: "INDEX_HISTORY", pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
        idempotencyFingerprint: memoryHistoryAutoHealJobFingerprint(source, current.attempts + 1, current.utilityPolicyVersion),
        source: {
          chatId: source.id, activeLeafMessageId: source.activeLeafMessageId,
          branchGeneration: source.memoryBranchGeneration, sourceRevision: source.memorySourceRevision,
          sourceHash: source.sourceHash
        }
      });
      return queued.created;
    }).catch((error: unknown) => {
      if (error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable") return false;
      throw error;
    });
    if (created) admitted += 1;
  }
  return admitted;
}
