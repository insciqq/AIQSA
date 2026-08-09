import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  withLockedMemoryTransaction,
  type MemoryTransaction
} from "../persistence/transaction";
import {
  assertMemoryExecutionBindingLineage,
  loadMemoryExecutionBinding,
  type MemoryExecutionBindingRecord
} from "./admission";
import {
  memoryExecutionNow,
  reauthorizeStoredMemoryExecution,
  type MemoryExecutionAuthorityDependencies
} from "./authority";
import { memoryExecutionFailure } from "./errors";
import {
  isValidMemoryExecutionIdentifier,
  storedMemoryExecutionOwner,
  type MemoryExecutionOwner
} from "./owner";
import { parseMemoryExecutionSnapshot } from "./snapshot";

export const MEMORY_EXECUTION_RECOVERY_HORIZON_MS = 24 * 60 * 60 * 1_000;

const sha256 = /^[a-f0-9]{64}$/u;
const safeCode = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$/u;
const safeProviderId = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u;

export type MemoryReportedUsage = Readonly<{
  cachedInputTokens: number | null;
  completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  estimatedCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}>;

export type MemoryExecutionSettlementInput = Readonly<{
  acceptedOutputHash: string | null;
  errorCode: string | null;
  providerResponseId: string | null;
  state: "CANCELLED" | "FAILED" | "OUTCOME_UNKNOWN" | "SUCCEEDED";
  usage: MemoryReportedUsage;
}>;

export type MemoryExecutionRecoveryInput = Readonly<{
  acceptedOutputHash: string | null;
  errorCode: string | null;
  state: "CANCELLED" | "FAILED" | "SUCCEEDED";
  usage: MemoryReportedUsage;
}>;

export type MemoryExecutionSettlementView = Readonly<{
  bindingId: string;
  completedAt: Date;
  owner: MemoryExecutionOwner;
  recoverableUntil: Date;
  replayed: boolean;
  state: MemoryExecutionSettlementInput["state"];
}>;

export type MemoryExecutionDetachTarget =
  | Readonly<{ bindingId: string }>
  | Readonly<{ connectionId: string }>
  | Readonly<{ credentialId: string }>
  | Readonly<{ providerModelId: string }>
  | Readonly<{ userId: string }>;

function validNullableCount(value: number | null): boolean {
  return value === null || Number.isSafeInteger(value) && value >= 0;
}

function validateUsage(usage: MemoryReportedUsage): void {
  const values = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
    usage.estimatedCostMicros
  ];
  if (values.some((value) => !validNullableCount(value))) {
    return memoryExecutionFailure("memory_execution_usage_invalid");
  }
  const tokenValues = values.slice(0, 5);
  if (
    (usage.completeness !== "UNAVAILABLE" &&
      usage.completeness !== "PARTIAL" &&
      usage.completeness !== "COMPLETE") ||
    (usage.completeness === "UNAVAILABLE" && values.some((value) => value !== null)) ||
    (usage.completeness === "PARTIAL" && values.every((value) => value === null)) ||
    (usage.completeness === "COMPLETE" && tokenValues.some((value) => value === null))
  ) {
    return memoryExecutionFailure("memory_execution_usage_invalid");
  }
}

function validateSettlement(input: MemoryExecutionSettlementInput): void {
  validateUsage(input.usage);
  if (
    (input.state !== "CANCELLED" &&
      input.state !== "FAILED" &&
      input.state !== "OUTCOME_UNKNOWN" &&
      input.state !== "SUCCEEDED") ||
    (input.acceptedOutputHash !== null && !sha256.test(input.acceptedOutputHash)) ||
    (input.state === "SUCCEEDED") !== (input.acceptedOutputHash !== null) ||
    (input.errorCode !== null && !safeCode.test(input.errorCode)) ||
    (input.providerResponseId !== null && !safeProviderId.test(input.providerResponseId))
  ) {
    return memoryExecutionFailure("memory_execution_output_invalid");
  }
}

function usageFromBinding(binding: MemoryExecutionBindingRecord): MemoryReportedUsage {
  return {
    cachedInputTokens: binding.cachedInputTokens,
    completeness: binding.usageCompleteness,
    estimatedCostMicros: binding.estimatedCostMicros,
    inputTokens: binding.inputTokens,
    outputTokens: binding.outputTokens,
    reasoningTokens: binding.reasoningTokens,
    totalTokens: binding.totalTokens
  };
}

function sameUsage(left: MemoryReportedUsage, right: MemoryReportedUsage): boolean {
  return left.completeness === right.completeness &&
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.totalTokens === right.totalTokens &&
    left.estimatedCostMicros === right.estimatedCostMicros;
}

function usageCanRecover(
  prior: MemoryReportedUsage,
  recovered: MemoryReportedUsage
): boolean {
  const order = { COMPLETE: 2, PARTIAL: 1, UNAVAILABLE: 0 } as const;
  if (order[recovered.completeness] < order[prior.completeness]) return false;
  const pairs = [
    [prior.inputTokens, recovered.inputTokens],
    [prior.cachedInputTokens, recovered.cachedInputTokens],
    [prior.outputTokens, recovered.outputTokens],
    [prior.reasoningTokens, recovered.reasoningTokens],
    [prior.totalTokens, recovered.totalTokens],
    [prior.estimatedCostMicros, recovered.estimatedCostMicros]
  ];
  return pairs.every(([before, after]) => before === null || before === after);
}

function usageData(usage: MemoryReportedUsage) {
  return {
    cachedInputTokens: usage.cachedInputTokens,
    estimatedCostMicros: usage.estimatedCostMicros,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    usageCompleteness: usage.completeness
  } as const;
}

async function storedUsageEvent(
  tx: MemoryTransaction,
  userId: string,
  bindingId: string
) {
  return tx.usageEvent.findFirst({
    select: {
      cachedInputTokens: true,
      cacheWriteInputTokens: true,
      estimatedCostMicros: true,
      inputTokens: true,
      outputTokens: true,
      reasoningTokens: true,
      totalTokens: true
    },
    where: { memoryExecutionBindingId: bindingId, userId }
  });
}

async function assertDurableUsage(
  tx: MemoryTransaction,
  binding: MemoryExecutionBindingRecord,
  expected: MemoryReportedUsage
): Promise<void> {
  const event = await storedUsageEvent(tx, binding.userId, binding.id);
  if (
    !event ||
    event.cacheWriteInputTokens !== null ||
    event.inputTokens !== expected.inputTokens ||
    event.cachedInputTokens !== expected.cachedInputTokens ||
    event.outputTokens !== expected.outputTokens ||
    event.reasoningTokens !== expected.reasoningTokens ||
    event.totalTokens !== expected.totalTokens ||
    event.estimatedCostMicros !== expected.estimatedCostMicros
  ) {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
}

function settlementView(
  binding: MemoryExecutionBindingRecord,
  replayed: boolean
): MemoryExecutionSettlementView {
  if (
    !binding.completedAt ||
    !binding.recoverableUntil ||
    (binding.state !== "SUCCEEDED" &&
      binding.state !== "FAILED" &&
      binding.state !== "CANCELLED" &&
      binding.state !== "OUTCOME_UNKNOWN")
  ) {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
  return {
    bindingId: binding.id,
    completedAt: binding.completedAt,
    owner: storedMemoryExecutionOwner(binding),
    recoverableUntil: binding.recoverableUntil,
    replayed,
    state: binding.state
  };
}

function sameSettlement(
  binding: MemoryExecutionBindingRecord,
  input: MemoryExecutionSettlementInput
): boolean {
  return binding.state === input.state &&
    binding.acceptedOutputHash === input.acceptedOutputHash &&
    binding.errorCode === input.errorCode &&
    binding.providerResponseId === input.providerResponseId &&
    sameUsage(usageFromBinding(binding), input.usage);
}

async function createUsageEvent(
  tx: MemoryTransaction,
  binding: MemoryExecutionBindingRecord,
  usage: MemoryReportedUsage
): Promise<void> {
  const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
  const provider = snapshot.providerExecutionSnapshot;
  await tx.usageEvent.create({
    data: {
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: null,
      estimatedCostMicros: usage.estimatedCostMicros,
      inputTokens: usage.inputTokens,
      memoryExecutionBindingId: binding.id,
      modelId: provider.model.upstreamModelId,
      outputTokens: usage.outputTokens,
      provider: provider.providerFamily,
      providerModelId: provider.providerModelId,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      user: { connect: { id: binding.userId } }
    }
  });
}

function targetPredicate(target: MemoryExecutionDetachTarget): Prisma.Sql {
  if ("bindingId" in target) return Prisma.sql`binding."id" = ${target.bindingId}`;
  if ("connectionId" in target) {
    return Prisma.sql`binding."connectionId" = ${target.connectionId}`;
  }
  if ("credentialId" in target) {
    return Prisma.sql`binding."credentialId" = ${target.credentialId}`;
  }
  if ("providerModelId" in target) {
    return Prisma.sql`binding."providerModelId" = ${target.providerModelId}`;
  }
  return Prisma.sql`binding."userId" = ${target.userId}`;
}

/** Detach only settled, usage-backed evidence after its recovery horizon.
 * OUTCOME_UNKNOWN deliberately remains attached until provider-specific
 * recovery reaches an honest terminal state. */
export async function detachExpiredMemoryExecutionBindings(
  tx: MemoryTransaction,
  target: MemoryExecutionDetachTarget,
  now: Date
): Promise<number> {
  if (!Number.isFinite(now.getTime())) {
    return memoryExecutionFailure("memory_execution_input_invalid");
  }
  return tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryExecutionBinding" AS binding
    SET
      "connectionId" = NULL,
      "providerModelId" = NULL,
      "credentialId" = NULL,
      "credentialVersionId" = NULL,
      "providerResponseId" = NULL,
      "relationsDetachedAt" = ${now}
    WHERE ${targetPredicate(target)}
      AND binding."relationsDetachedAt" IS NULL
      AND binding."state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
      AND binding."recoverableUntil" IS NOT NULL
      AND binding."recoverableUntil" <= ${now}
      AND EXISTS (
        SELECT 1
        FROM "UsageEvent" AS usage
        WHERE usage."userId" = binding."userId"
          AND usage."memoryExecutionBindingId" = binding."id"
      )
  `);
}

export async function countBlockingMemoryExecutionBindings(
  tx: Pick<MemoryTransaction, "memoryExecutionBinding">,
  target: Exclude<MemoryExecutionDetachTarget, { bindingId: string } | { userId: string }>
): Promise<number> {
  return tx.memoryExecutionBinding.count({ where: target });
}

export function createPrismaMemoryExecutionLifecycle(
  dependencies: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma
) {
  async function settle(
    userId: string,
    bindingId: string,
    input: MemoryExecutionSettlementInput
  ): Promise<MemoryExecutionSettlementView> {
    if (
      !isValidMemoryExecutionIdentifier(userId) ||
      !isValidMemoryExecutionIdentifier(bindingId)
    ) {
      return memoryExecutionFailure("memory_execution_input_invalid");
    }
    validateSettlement(input);
    return withLockedMemoryTransaction(client, userId, async (tx) => {
      const now = memoryExecutionNow(dependencies);
      const binding = await loadMemoryExecutionBinding(tx, userId, bindingId);
      if (sameSettlement(binding, input)) {
        await assertDurableUsage(tx, binding, input.usage);
        return settlementView(binding, true);
      }
      const allowed = binding.state === "RUNNING" ||
        binding.state === "PENDING" &&
          (input.state === "FAILED" || input.state === "CANCELLED");
      if (!allowed || binding.relationsDetachedAt) {
        return memoryExecutionFailure("memory_execution_state_conflict");
      }
      if (
        binding.state === "PENDING" &&
        (input.usage.completeness !== "UNAVAILABLE" || input.providerResponseId !== null)
      ) {
        return memoryExecutionFailure("memory_execution_usage_invalid");
      }
      const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
      assertMemoryExecutionBindingLineage(binding, snapshot);
      const recoverableUntil = binding.state === "PENDING"
        ? now
        : new Date(now.getTime() + MEMORY_EXECUTION_RECOVERY_HORIZON_MS);
      const updated = await tx.memoryExecutionBinding.updateMany({
        data: {
          acceptedOutputHash: input.acceptedOutputHash,
          completedAt: now,
          errorCode: input.errorCode,
          providerResponseId: input.providerResponseId,
          recoverableUntil,
          state: input.state,
          ...usageData(input.usage)
        },
        where: {
          id: binding.id,
          relationsDetachedAt: null,
          state: binding.state,
          userId
        }
      });
      if (updated.count !== 1) {
        return memoryExecutionFailure("memory_execution_state_conflict");
      }
      await createUsageEvent(tx, binding, input.usage);
      const settled = await loadMemoryExecutionBinding(tx, userId, bindingId);
      return settlementView(settled, false);
    });
  }

  return Object.freeze({
    settle,

    async recoverOutcome(
      userId: string,
      bindingId: string,
      input: MemoryExecutionRecoveryInput
    ): Promise<MemoryExecutionSettlementView> {
      if (
        !isValidMemoryExecutionIdentifier(userId) ||
        !isValidMemoryExecutionIdentifier(bindingId)
      ) {
        return memoryExecutionFailure("memory_execution_input_invalid");
      }
      validateSettlement({
        ...input,
        providerResponseId: null
      });
      return withLockedMemoryTransaction(client, userId, async (tx) => {
        const now = memoryExecutionNow(dependencies);
        const binding = await loadMemoryExecutionBinding(tx, userId, bindingId);
        const replayInput: MemoryExecutionSettlementInput = {
          ...input,
          providerResponseId: binding.providerResponseId
        };
        if (sameSettlement(binding, replayInput)) {
          await assertDurableUsage(tx, binding, input.usage);
          return settlementView(binding, true);
        }
        if (
          binding.state !== "OUTCOME_UNKNOWN" ||
          binding.relationsDetachedAt ||
          !binding.recoverableUntil ||
          binding.recoverableUntil <= now
        ) {
          return memoryExecutionFailure(
            binding.state === "OUTCOME_UNKNOWN"
              ? "memory_execution_recovery_expired"
              : "memory_execution_state_conflict"
          );
        }
        const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
        assertMemoryExecutionBindingLineage(binding, snapshot);
        if (!usageCanRecover(usageFromBinding(binding), input.usage)) {
          return memoryExecutionFailure("memory_execution_usage_invalid");
        }
        await assertDurableUsage(tx, binding, usageFromBinding(binding));
        const updated = await tx.memoryExecutionBinding.updateMany({
          data: {
            acceptedOutputHash: input.acceptedOutputHash,
            completedAt: now,
            errorCode: input.errorCode,
            state: input.state,
            ...usageData(input.usage)
          },
          where: {
            id: binding.id,
            relationsDetachedAt: null,
            state: "OUTCOME_UNKNOWN",
            userId
          }
        });
        if (updated.count !== 1) {
          return memoryExecutionFailure("memory_execution_state_conflict");
        }
        await tx.usageEvent.update({
          data: {
            cachedInputTokens: input.usage.cachedInputTokens,
            estimatedCostMicros: input.usage.estimatedCostMicros,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            reasoningTokens: input.usage.reasoningTokens,
            totalTokens: input.usage.totalTokens
          },
          where: { memoryExecutionBindingId: binding.id }
        });
        const recovered = await loadMemoryExecutionBinding(tx, userId, bindingId);
        return settlementView(recovered, false);
      });
    },

    async detachExpiredForUser(userId: string): Promise<number> {
      if (!isValidMemoryExecutionIdentifier(userId)) {
        return memoryExecutionFailure("memory_execution_input_invalid");
      }
      return withLockedMemoryTransaction(
        client,
        userId,
        (tx) => detachExpiredMemoryExecutionBindings(
          tx,
          { userId },
          memoryExecutionNow(dependencies)
        ),
        { requireActiveOwner: false }
      );
    },

    /** The callback is the authoritative apply transaction. It must contain no
     * external I/O and must remain idempotent because serialization retries may
     * invoke it again. */
    async withAuthorizedResultCommit<Value>(
      userId: string,
      input: Readonly<{ acceptedOutputHash: string; bindingId: string }>,
      apply: (
        tx: MemoryTransaction,
        evidence: Readonly<{
          bindingId: string;
          owner: MemoryExecutionOwner;
        }>
      ) => Promise<Value>
    ): Promise<Value> {
      if (
        !isValidMemoryExecutionIdentifier(userId) ||
        !isValidMemoryExecutionIdentifier(input.bindingId) ||
        !sha256.test(input.acceptedOutputHash) ||
        typeof apply !== "function"
      ) {
        return memoryExecutionFailure("memory_execution_input_invalid");
      }
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const now = memoryExecutionNow(dependencies);
        const binding = await loadMemoryExecutionBinding(tx, userId, input.bindingId);
        if (
          binding.state !== "SUCCEEDED" ||
          binding.acceptedOutputHash !== input.acceptedOutputHash ||
          binding.relationsDetachedAt
        ) {
          return memoryExecutionFailure("memory_execution_state_conflict");
        }
        const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
        assertMemoryExecutionBindingLineage(binding, snapshot);
        await assertDurableUsage(tx, binding, usageFromBinding(binding));
        await reauthorizeStoredMemoryExecution(tx, settings, {
          dependencies,
          now,
          snapshot,
          userId
        });
        return apply(tx, {
          bindingId: binding.id,
          owner: storedMemoryExecutionOwner(binding)
        });
      });
    }
  });
}

export type MemoryExecutionLifecycle = ReturnType<
  typeof createPrismaMemoryExecutionLifecycle
>;
