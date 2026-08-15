import type {
  MemoryDeletionOperation,
  MemoryDeletionState
} from "@prisma/client";
import { memoryPersistenceFailure } from "./errors";
import {
  type LockedMemorySettings,
  type MemoryTransaction
} from "./transaction";

export type MemoryDeletionEnqueueInput = Readonly<{
  nextAttemptAt?: Date | null;
  operation: MemoryDeletionOperation;
  targetId: string;
  targetType: string;
}>;

export type MemoryDeletionEnqueueResult = Readonly<{
  created: boolean;
  id: string;
  memoryGeneration: number;
  state: MemoryDeletionState;
}>;

function validTarget(value: string, maxLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maxLength;
}

function validateDeletionInput(input: MemoryDeletionEnqueueInput): void {
  if (
    !validTarget(input.targetType, 64) ||
    !validTarget(input.targetId, 512) ||
    (input.nextAttemptAt !== undefined && input.nextAttemptAt !== null &&
      !Number.isFinite(input.nextAttemptAt.getTime()))
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

export async function enqueueMemoryDeletion(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: MemoryDeletionEnqueueInput
): Promise<MemoryDeletionEnqueueResult> {
  validateDeletionInput(input);
  const existing = await tx.memoryDeletionOutbox.findUnique({
    select: { id: true, memoryGeneration: true, state: true },
    where: {
      userId_operation_targetType_targetId_memoryGeneration: {
        memoryGeneration: settings.memoryGeneration,
        operation: input.operation,
        targetId: input.targetId,
        targetType: input.targetType,
        userId: settings.userId
      }
    }
  });
  if (existing) {
    return { ...existing, created: false };
  }
  const created = await tx.memoryDeletionOutbox.create({
    data: {
      memoryGeneration: settings.memoryGeneration,
      nextAttemptAt: input.nextAttemptAt,
      operation: input.operation,
      targetId: input.targetId,
      targetType: input.targetType,
      userId: settings.userId
    },
    select: { id: true, memoryGeneration: true, state: true }
  });
  return { ...created, created: true };
}
