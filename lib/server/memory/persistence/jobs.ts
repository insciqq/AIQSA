import type { MemoryJobKind, MemoryJobState, PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { memoryPersistenceFailure } from "./errors";
import {
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "./transaction";

export type MemoryJobEnqueueInput = Readonly<{
  idempotencyFingerprint: string;
  kind: MemoryJobKind;
  nextAttemptAt?: Date | null;
  pipelineVersion: string;
}>;

export type MemoryJobEnqueueResult = Readonly<{
  created: boolean;
  id: string;
  memoryGenerationSnapshot: number;
  memoryRevisionSnapshot: number;
  state: MemoryJobState;
}>;

function validToken(value: string, maxLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maxLength;
}

export async function enqueueMemoryJob(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: MemoryJobEnqueueInput
): Promise<MemoryJobEnqueueResult> {
  if (!validToken(input.idempotencyFingerprint, 128) || !validToken(input.pipelineVersion, 64)) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  const existing = await tx.memoryJob.findUnique({
    select: {
      id: true,
      kind: true,
      memoryGenerationSnapshot: true,
      memoryRevisionSnapshot: true,
      pipelineVersion: true,
      state: true
    },
    where: {
      userId_idempotencyFingerprint: {
        idempotencyFingerprint: input.idempotencyFingerprint,
        userId: settings.userId
      }
    }
  });
  if (existing) {
    if (
      existing.kind !== input.kind ||
      existing.pipelineVersion !== input.pipelineVersion
    ) {
      return memoryPersistenceFailure("memory_idempotency_conflict");
    }
    return { ...existing, created: false };
  }

  const created = await tx.memoryJob.create({
    data: {
      idempotencyFingerprint: input.idempotencyFingerprint,
      kind: input.kind,
      memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision,
      nextAttemptAt: input.nextAttemptAt,
      pipelineVersion: input.pipelineVersion,
      userId: settings.userId
    },
    select: {
      id: true,
      memoryGenerationSnapshot: true,
      memoryRevisionSnapshot: true,
      state: true
    }
  });
  return { ...created, created: true };
}

export function createPrismaMemoryJobRepository(client: PrismaClient = prisma) {
  return Object.freeze({
    async enqueue(userId: string, input: MemoryJobEnqueueInput): Promise<MemoryJobEnqueueResult> {
      return withLockedMemoryTransaction(client, userId, (tx, settings) =>
        enqueueMemoryJob(tx, settings, input));
    }
  });
}
