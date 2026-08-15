import type { MemorySuppression, PrismaClient } from "@prisma/client";
import {
  enqueueMemoryDeletion,
  type MemoryDeletionEnqueueInput,
  type MemoryDeletionEnqueueResult
} from "@/lib/server/memory/persistence/deletion";
import { memoryPersistenceFailure } from "@/lib/server/memory/persistence/errors";
import {
  enqueueMemoryJob,
  type MemoryJobEnqueueInput,
  type MemoryJobEnqueueResult
} from "@/lib/server/memory/persistence/jobs";
import {
  createMemorySuppressionInTransaction,
  findMatchingMemorySuppressions,
  type MemorySuppressionCreateInput,
  type MemorySuppressionCreateResult,
  type MemorySuppressionMatchInput
} from "@/lib/server/memory/persistence/suppressions";
import {
  advanceMemoryMutation,
  withLockedMemoryTransaction
} from "@/lib/server/memory/persistence/transaction";
import type { MemorySuppressionKeyring } from "@/lib/server/memory/suppressionKeyring";

function validDeletionInput(input: MemoryDeletionEnqueueInput): boolean {
  const validTarget = (value: string, maxLength: number) =>
    value.trim() === value && value.length > 0 && value.length <= maxLength;
  return validTarget(input.targetType, 64) &&
    validTarget(input.targetId, 512) &&
    (input.nextAttemptAt === undefined || input.nextAttemptAt === null ||
      Number.isFinite(input.nextAttemptAt.getTime()));
}

export function createPrismaMemoryDeletionRepository(client: PrismaClient) {
  return Object.freeze({
    async enqueueDestructive(
      userId: string,
      input: MemoryDeletionEnqueueInput
    ): Promise<MemoryDeletionEnqueueResult> {
      if (!validDeletionInput(input)) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const prior = await tx.memoryDeletionOutbox.findUnique({
          select: { id: true, memoryGeneration: true, state: true },
          where: {
            userId_operation_targetType_targetId_memoryGeneration: {
              memoryGeneration: settings.memoryGeneration,
              operation: input.operation,
              targetId: input.targetId,
              targetType: input.targetType,
              userId
            }
          }
        });
        if (prior) return { ...prior, created: false };
        await advanceMemoryMutation(tx, settings, "FORGET_OR_BULK_CLEAR");
        return enqueueMemoryDeletion(tx, settings, input);
      }, { requireActiveOwner: input.operation !== "ACCOUNT_MEMORY_DELETE" });
    }
  });
}

export function createPrismaMemoryJobRepository(client: PrismaClient) {
  return Object.freeze({
    async enqueue(userId: string, input: MemoryJobEnqueueInput): Promise<MemoryJobEnqueueResult> {
      return withLockedMemoryTransaction(client, userId, (tx, settings) =>
        enqueueMemoryJob(tx, settings, input));
    }
  });
}

export function createPrismaMemorySuppressionRepository(
  keyring: MemorySuppressionKeyring,
  client: PrismaClient
) {
  return Object.freeze({
    async create(
      userId: string,
      input: MemorySuppressionCreateInput
    ): Promise<MemorySuppressionCreateResult> {
      return withLockedMemoryTransaction(client, userId, (tx, settings) =>
        createMemorySuppressionInTransaction(tx, settings, keyring, input));
    },
    async matching(
      userId: string,
      input: MemorySuppressionMatchInput
    ): Promise<MemorySuppression[]> {
      return withLockedMemoryTransaction(client, userId, (tx) =>
        findMatchingMemorySuppressions(tx, keyring, userId, input));
    }
  });
}
