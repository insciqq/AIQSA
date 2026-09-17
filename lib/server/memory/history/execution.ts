import { Prisma, type PrismaClient } from "@prisma/client";
import { MemoryCoordinatorError } from "../coordinator/errors";
import { currentMemoryJobsSql } from "../coordinator/currentJobs";
import {
  executeGovernedMemoryStructuredOutput,
  type MemoryExecutionAuthorityDependencies
} from "../execution";
import { memoryExecutionNow } from "../execution/authority";
import { memoryExecutionSha256 } from "../execution/canonical";
import { createPrismaMemoryExecutionLifecycle } from "../execution/lifecycle";
import { unavailableMemoryReportedUsage } from "../execution/structuredClassifier";
import type { MemoryTransaction } from "../persistence/transaction";

export class MemoryHistoryResultUnavailable extends Error {
  constructor() {
    super("memory_history_retained_result_unavailable");
  }
}

/** Freeze this once before any stage dispatches. A restarted job may finish
 * from retained results or safe raw history, never buy its previous work again. */
export async function prepareMemoryHistoryExecutionRecovery(
  client: PrismaClient,
  authority: MemoryExecutionAuthorityDependencies,
  userId: string,
  jobId: string
): Promise<boolean> {
  const bindings = await client.memoryExecutionBinding.findMany({
    select: { id: true, logicalRole: true, ownerType: true, state: true, startedAt: true },
    where: { memoryJobId: jobId, userId }
  });
  if (bindings.some((binding) => binding.logicalRole !== "MEMORY_HISTORY_CLASSIFY" ||
    binding.ownerType !== "JOB" || binding.state === "RUNNING" ||
    binding.state === "OUTCOME_UNKNOWN" || binding.state === "PENDING" && binding.startedAt)) {
    throw new MemoryCoordinatorError("memory_history_execution_protected", false);
  }
  const lifecycle = createPrismaMemoryExecutionLifecycle(authority, client);
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
  return bindings.length > 0;
}

export async function clearMemoryHistoryExecutionResults(
  tx: MemoryTransaction,
  userId: string,
  jobId: string,
  now: Date
): Promise<void> {
  const unsettled = await tx.memoryExecutionBinding.count({
    where: { userId, memoryJobId: jobId, state: { in: ["PENDING", "RUNNING", "OUTCOME_UNKNOWN"] } }
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
  "owner" | "role" | "persistResult"
> & Readonly<{
  jobId: string;
  recoveryOnly?: boolean;
  onDispatch?: () => void;
  restore(value: unknown): Value;
}>) {
  const role = "MEMORY_HISTORY_CLASSIFY";
  const current = await input.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH ${currentMemoryJobsSql(memoryExecutionNow(input.authority))}
    SELECT id FROM current_jobs WHERE id = ${input.jobId} AND "userId" = ${input.userId}
      AND state = 'CLAIMED'
  `);
  if (current.length !== 1) throw new MemoryCoordinatorError("memory_history_job_invalid", false);
  const prior = await input.client.memoryExecutionBinding.findMany({
    orderBy: { ordinal: "desc" },
    select: {
      id: true, state: true, acceptedOutputHash: true, completedAt: true,
      pipelineVersion: true, policyVersion: true, promptVersion: true, schemaVersion: true
    },
    where: { inputHash: input.inputHash, logicalRole: role, memoryJobId: input.jobId,
      ownerType: "JOB", userId: input.userId }
  });
  if (prior.some(({ state }) => state === "RUNNING" || state === "OUTCOME_UNKNOWN")) {
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
  input.onDispatch?.();
  return executeGovernedMemoryStructuredOutput({
    ...input,
    owner: { memoryJobId: input.jobId, type: "JOB" },
    role,
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
