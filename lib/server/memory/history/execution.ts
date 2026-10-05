import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { MemoryCoordinatorError, MemoryJobFencedError } from "../coordinator/errors";
import { currentMemoryJobsSql } from "../coordinator/currentJobs";
import { memoryHistoryObsoleteOrphanSql, memoryRecoverableFailureSql } from "../coordinator/recoveryPolicy";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  executeGovernedMemoryStructuredOutput,
  type MemoryExecutionAuthorityDependencies
} from "../execution";
import { memoryExecutionNow } from "../execution/authority";
import { memoryExecutionSha256 } from "../execution/canonical";
import { MemoryExecutionError } from "../execution/errors";
import {
  createPrismaMemoryExecutionLifecycle,
  type MemoryExecutionSettlementInput
} from "../execution/lifecycle";
import {
  MEMORY_STRUCTURED_OUTPUT_VALIDATION_MAX_ATTEMPTS,
  unavailableMemoryReportedUsage
} from "../execution/structuredClassifier";
import { MemoryPersistenceError } from "../persistence/errors";
import type { MemoryTransaction } from "../persistence/transaction";
import { MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE } from "./contract";

export class MemoryHistoryResultUnavailable extends Error {
  constructor() {
    super("memory_history_retained_result_unavailable");
  }
}

/** An orphaned classification's only settlement. Every recoverer writes the
 * same one, so a concurrent recoverer replays it instead of conflicting. */
const recoveredUncertainSettlement: MemoryExecutionSettlementInput = Object.freeze({
  acceptedOutputHash: null,
  errorCode: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE,
  providerResponseId: null,
  state: "OUTCOME_UNKNOWN",
  usage: unavailableMemoryReportedUsage
});

/** Freeze this once before any stage dispatches. A restarted job may finish
 * from retained results or safe raw history, never buy its previous work again.
 * A classification of this job still RUNNING here was orphaned: this attempt
 * holds the job's live lease and has not dispatched yet, so the attempt that
 * started it is gone. Its provider outcome is unknown, so it settles as such
 * with unavailable usage; its input then falls back to raw history. Any other
 * unsettled, ambiguous or unaccounted call keeps the job protected. */
export async function prepareMemoryHistoryExecutionRecovery(
  client: PrismaClient,
  authority: MemoryExecutionAuthorityDependencies,
  claim: Pick<MemoryJobClaim, "claimToken" | "id" | "userId">
): Promise<boolean> {
  const { id: jobId, userId } = claim;
  const now = memoryExecutionNow(authority);
  const related = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH ${currentMemoryJobsSql(now)}
    SELECT job.id FROM current_jobs job JOIN current_jobs current_job
      ON current_job.id = ${jobId} AND current_job."userId" = ${userId}
    WHERE job."userId" = current_job."userId" AND job.kind = 'INDEX_HISTORY'
      AND job."chatId" = current_job."chatId" AND job."sourceHash" = current_job."sourceHash"
      AND job."branchGeneration" = current_job."branchGeneration"
      AND job."sourceRevision" = current_job."sourceRevision"
      AND job."activeLeafMessageId" = current_job."activeLeafMessageId"
      AND job."memoryGenerationSnapshot" = current_job."memoryGenerationSnapshot"
      AND job.state = 'TERMINAL_FAILED' AND ${memoryRecoverableFailureSql()}
  `);
  const bindings = await client.memoryExecutionBinding.findMany({
    select: {
      acceptedOutputHash: true, errorCode: true, id: true, logicalRole: true, memoryJobId: true,
      ownerType: true, providerResponseId: true, startedAt: true, state: true
    },
    where: { memoryJobId: { in: [jobId, ...related.map(({ id }) => id)] }, userId }
  });
  // Only this job's own calls can be orphans: another job's dispatch belongs
  // to its owner. An unknown outcome is accepted only as such a settled orphan.
  if (bindings.some((binding) => binding.logicalRole !== "MEMORY_HISTORY_CLASSIFY" ||
    binding.ownerType !== "JOB" || binding.state === "PENDING" && binding.startedAt ||
    binding.state === "RUNNING" && (binding.memoryJobId !== jobId ||
      binding.acceptedOutputHash !== null || binding.providerResponseId !== null) ||
    binding.state === "OUTCOME_UNKNOWN" && (binding.memoryJobId !== jobId ||
      binding.errorCode !== MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE))) {
    throw new MemoryCoordinatorError("memory_history_execution_protected", false);
  }
  const orphaned = bindings.filter(({ state }) => state === "RUNNING").map(({ id }) => id);
  const settled = bindings.filter(({ state }) => state !== "PENDING" && state !== "RUNNING")
    .map(({ id }) => id);
  const receipts = async (ids: readonly string[]) => ids.length === 0 ? 0 : client.usageEvent.count({
    where: { userId, memoryExecutionBindingId: { in: [...ids] } }
  });
  // Every settled call holds its usage receipt; an orphan has none yet.
  if (await receipts(settled) !== settled.length || await receipts(orphaned) !== 0) {
    throw new MemoryCoordinatorError("memory_history_execution_protected", false);
  }
  const lifecycle = createPrismaMemoryExecutionLifecycle(authority, client);
  if (orphaned.length > 0) {
    const owned = await client.memoryJob.count({ where: {
      id: jobId, userId, state: "CLAIMED", leaseToken: claim.claimToken, leaseExpiresAt: { gt: now }
    } });
    if (owned !== 1) throw new MemoryCoordinatorError("memory_job_lease_lost", false);
    for (const bindingId of orphaned) {
      await lifecycle.settle(userId, bindingId, recoveredUncertainSettlement);
    }
    logEvent("service_operation", { subsystem: "memory", stage: "recovery", outcome: "degraded",
      action: "degrade", job_id: jobId, code: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE,
      count: orphaned.length });
  }
  for (const binding of bindings) {
    if (binding.state !== "PENDING") continue;
    await lifecycle.settle(userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: "memory_history_dispatch_abandoned",
      providerResponseId: null,
      state: "CANCELLED",
      usage: unavailableMemoryReportedUsage
    });
  }
  // A new pipeline can rebuild old failed work locally. Legacy outputs belong
  // to their immutable owner and are not rebound to this successor's dispatch.
  return bindings.length > 0 || related.length > 0;
}

/** Bounded part of the periodic recovery pass. An orphaned classification
 * whose job ended before its recovery could settle it and whose chat has moved
 * past the job's source (memoryHistoryObsoleteOrphanSql) would otherwise stay
 * RUNNING forever: it settles as an unknown outcome with unavailable usage,
 * exactly as in-job recovery would, and is never dispatched again. Returns the
 * number of new settlements. */
export async function settleObsoleteMemoryHistoryOrphans(
  client: PrismaClient,
  input: Readonly<{ limit: number; now: Date }>
): Promise<number> {
  const orphans = await client.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
    SELECT execution.id, execution."userId"
    FROM "MemoryExecutionBinding" AS execution
    JOIN "MemoryJob" AS job ON job.id = execution."memoryJobId" AND job."userId" = execution."userId"
    JOIN "User" AS owner ON owner.id = job."userId" AND owner.status = 'active'::"UserStatus"
    WHERE ${memoryHistoryObsoleteOrphanSql(input.now)}
    ORDER BY execution."startedAt", execution.id LIMIT ${input.limit}
  `).catch(retainDatabaseFailure);
  const lifecycle = createPrismaMemoryExecutionLifecycle({ now: () => input.now }, client);
  let settled = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try {
      const view = await lifecycle.settle(orphan.userId, orphan.id, recoveredUncertainSettlement);
      if (!view.replayed) settled += 1;
    } catch (error) {
      // A late settlement by the lost attempt, chat deletion or account
      // disable may win after selection. Anything else retries next pass.
      if (!(error instanceof MemoryExecutionError && (error.code === "memory_execution_state_conflict" ||
        error.code === "memory_execution_binding_not_found")) &&
        !(error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable")) failed += 1;
    }
  }
  if (settled > 0 || failed > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "recovery",
      outcome: failed > 0 ? "failed" : "degraded", action: failed > 0 ? "retry" : "degrade",
      code: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE, count: settled,
      ...(failed > 0 ? { failed_count: failed } : {}) });
  }
  return settled;
}

export async function clearMemoryHistoryExecutionResults(
  tx: MemoryTransaction,
  userId: string,
  jobId: string,
  now: Date
): Promise<void> {
  // An orphan settled by recovery is final: its input is never dispatched again.
  const unsettled = await tx.memoryExecutionBinding.count({
    where: { userId, memoryJobId: jobId, OR: [
      { state: { in: ["PENDING", "RUNNING"] } },
      { state: "OUTCOME_UNKNOWN", OR: [
        { errorCode: null }, { errorCode: { not: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE } }
      ] }
    ] }
  });
  if (unsettled > 0) throw new MemoryCoordinatorError("memory_history_execution_protected", false);
  await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryHistoryExecution" SET "acceptedOutput" = NULL,
      "clearedAt" = GREATEST(${now}, "createdAt")
    WHERE "userId" = ${userId} AND "memoryJobId" = ${jobId} AND "clearedAt" IS NULL
  `);
}

export async function executeRecoverableMemoryHistoryOutput<Value>(input: Omit<
  Parameters<typeof executeGovernedMemoryStructuredOutput<Value>>[0],
  "owner" | "role" | "persistResult" | "ordinal" | "validationRetry"
> & Readonly<{
  jobId: string;
  recoveryOnly?: boolean;
  onDispatch?: () => void;
  restore(value: unknown): Value;
}>) {
  const role = "MEMORY_HISTORY_CLASSIFY";
  await assertMemoryHistoryJobCurrent(input);
  const prior = await input.client.memoryExecutionBinding.findMany({
    orderBy: { ordinal: "desc" },
    select: {
      id: true, state: true, acceptedOutputHash: true, completedAt: true, errorCode: true,
      pipelineVersion: true, policyVersion: true, promptVersion: true, schemaVersion: true
    },
    where: { inputHash: input.inputHash, logicalRole: role, memoryJobId: input.jobId,
      ownerType: "JOB", userId: input.userId }
  });
  // A dispatch still in flight is never raced. An orphan settled by recovery
  // has no retained result: its input falls back to raw history below.
  if (prior.some(({ errorCode, state }) => state === "RUNNING" ||
    state === "OUTCOME_UNKNOWN" && errorCode !== MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE)) {
    throw new MemoryCoordinatorError("memory_history_execution_protected", false);
  }
  for (const binding of prior) {
    if (binding.state !== "SUCCEEDED" || !binding.acceptedOutputHash || !binding.completedAt ||
      binding.pipelineVersion !== input.versions.pipelineVersion ||
      binding.policyVersion !== input.versions.policyVersion ||
      binding.promptVersion !== input.versions.promptVersion ||
      binding.schemaVersion !== input.versions.schemaVersion) continue;
    const receipt = await input.client.memoryHistoryExecution.findFirst({
      where: { executionBindingId: binding.id, userId: input.userId, memoryJobId: input.jobId,
        inputHash: input.inputHash, acceptedOutputHash: binding.acceptedOutputHash,
        clearedAt: null, recoverableUntil: { gt: memoryExecutionNow(input.authority) } }
    });
    if (!receipt) continue;
    const hash = (output: unknown) => memoryExecutionSha256({
      inputHash: input.inputHash, output, role, version: 1
    });
    if (hash(receipt.acceptedOutput) !== binding.acceptedOutputHash) {
      throw new MemoryCoordinatorError("memory_history_result_invalid", false);
    }
    const value = input.restore(receipt.acceptedOutput);
    if (hash(value) !== binding.acceptedOutputHash) {
      throw new MemoryCoordinatorError("memory_history_result_invalid", false);
    }
    await createPrismaMemoryExecutionLifecycle(input.authority, input.client)
      .withAuthorizedResultCommit(input.userId, {
        bindingId: binding.id, acceptedOutputHash: binding.acceptedOutputHash
      }, async (_tx, evidence) => {
        if (evidence.owner.type !== "JOB" || evidence.owner.memoryJobId !== input.jobId) {
          throw new MemoryCoordinatorError("memory_history_result_invalid", false);
        }
      });
    return { acceptedOutputHash: binding.acceptedOutputHash, bindingId: binding.id, value };
  }
  if (input.recoveryOnly || prior.length > 0) throw new MemoryHistoryResultUnavailable();
  // Fresh dispatch only. Every call, including a validation retry, binds the
  // next free ordinal of this job and role, so a retry never collides with a
  // later stage's call.
  const nextOrdinal = async () => {
    const latest = await input.client.memoryExecutionBinding.aggregate({
      _max: { ordinal: true },
      where: { logicalRole: role, memoryJobId: input.jobId, ownerType: "JOB", userId: input.userId }
    });
    return (latest._max.ordinal ?? -1) + 1;
  };
  const ordinal = await nextOrdinal();
  input.onDispatch?.();
  return executeGovernedMemoryStructuredOutput({
    ...input,
    ordinal,
    owner: { memoryJobId: input.jobId, type: "JOB" },
    role,
    validationRetry: {
      maxAttempts: MEMORY_STRUCTURED_OUTPUT_VALIDATION_MAX_ATTEMPTS,
      // A retry discloses the source again: revalidate it like the first call.
      beforeRetry: () => assertMemoryHistoryJobCurrent(input),
      allocateOrdinal: async () => {
        const retryOrdinal = await nextOrdinal();
        input.onDispatch?.();
        return retryOrdinal;
      }
    },
    persistResult: async (tx, result) => {
      // Settlement owns accounting even if a source fence wins during I/O.
      // Such a result must never recreate private staging after its purge.
      const current = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH ${currentMemoryJobsSql(result.completedAt)}
        SELECT job.id FROM current_jobs job
        WHERE job.id = ${input.jobId} AND job."userId" = ${input.userId}
          AND NOT EXISTS (SELECT 1 FROM "MemorySuppression" suppression
            WHERE suppression."userId" = job."userId"
              AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > ${result.completedAt})
              AND (suppression.scope = 'ALL' OR suppression."sourceChatId" = job."chatId"))
      `);
      const retain = current.length === 1;
      await tx.memoryHistoryExecution.createMany({
        data: [{
          userId: input.userId, memoryJobId: input.jobId, executionBindingId: result.bindingId,
          inputHash: result.inputHash, acceptedOutputHash: result.acceptedOutputHash,
          acceptedOutput: retain ? JSON.parse(JSON.stringify(result.value)) as Prisma.InputJsonValue : Prisma.DbNull,
          createdAt: result.completedAt, recoverableUntil: result.recoverableUntil,
          clearedAt: retain ? null : result.completedAt
        }],
        skipDuplicates: true
      });
      const stored = await tx.memoryHistoryExecution.findUniqueOrThrow({
        where: { userId_executionBindingId: { userId: input.userId, executionBindingId: result.bindingId } }
      });
      if (stored.memoryJobId !== input.jobId || stored.inputHash !== result.inputHash ||
        stored.acceptedOutputHash !== result.acceptedOutputHash ||
        stored.clearedAt === null && memoryExecutionSha256({
          inputHash: stored.inputHash, output: stored.acceptedOutput, role, version: 1
        }) !== result.acceptedOutputHash) {
        throw new MemoryCoordinatorError("memory_history_result_invalid", false);
      }
    }
  });
}

/** Proves the claimed job current before every dispatch, including each
 * validation retry. An append, settlement, branch change, Forget, exclusion or
 * setting that landed during classification fences this job before any
 * further binding. */
async function assertMemoryHistoryJobCurrent(input: Readonly<{
  authority: MemoryExecutionAuthorityDependencies;
  client: PrismaClient;
  jobId: string;
  userId: string;
}>): Promise<void> {
  const current = await input.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH ${currentMemoryJobsSql(memoryExecutionNow(input.authority))}
    SELECT id FROM current_jobs WHERE id = ${input.jobId} AND "userId" = ${input.userId}
      AND state = 'CLAIMED'
  `);
  if (current.length !== 1) {
    throw new MemoryJobFencedError("memory_history_job_invalid", {
      errorCode: "memory_source_stale", status: "STALE"
    });
  }
}
