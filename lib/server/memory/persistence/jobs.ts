import type { MemoryJobKind, MemoryJobState } from "@prisma/client";
import { isMemoryCoordinatorJobKind } from "../coordinator/registry";
import { memoryPersistenceFailure } from "./errors";
import {
  type LockedMemorySettings,
  type MemoryTransaction
} from "./transaction";

export type MemoryJobEnqueueInput = Readonly<{
  idempotencyFingerprint: string;
  kind: MemoryJobKind;
  nextAttemptAt?: Date | null;
  pipelineVersion: string;
  source?: Readonly<{
    activeLeafMessageId: string;
    branchGeneration: number;
    chatId: string;
    sourceHash: string;
    sourceRevision: number;
  }>;
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

const sha256 = /^[a-f0-9]{64}$/u;

function validSource(input: MemoryJobEnqueueInput["source"]): boolean {
  return input === undefined || (
    validToken(input.activeLeafMessageId, 256) &&
    validToken(input.chatId, 256) &&
    sha256.test(input.sourceHash) &&
    Number.isSafeInteger(input.branchGeneration) &&
    input.branchGeneration >= 0 &&
    Number.isSafeInteger(input.sourceRevision) &&
    input.sourceRevision >= 0
  );
}

export async function enqueueMemoryJob(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: MemoryJobEnqueueInput
): Promise<MemoryJobEnqueueResult> {
  if (
    !isMemoryCoordinatorJobKind(input.kind) ||
    !validToken(input.idempotencyFingerprint, 128) ||
    !validToken(input.pipelineVersion, 64) ||
    !validSource(input.source)
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  const existing = await tx.memoryJob.findUnique({
    select: {
      id: true,
      activeLeafMessageId: true,
      branchGeneration: true,
      chatId: true,
      kind: true,
      memoryGenerationSnapshot: true,
      memoryRevisionSnapshot: true,
      pipelineVersion: true,
      sourceHash: true,
      sourceRevision: true,
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
      existing.pipelineVersion !== input.pipelineVersion ||
      existing.chatId !== (input.source?.chatId ?? null) ||
      existing.activeLeafMessageId !== (input.source?.activeLeafMessageId ?? null) ||
      existing.branchGeneration !== (input.source?.branchGeneration ?? null) ||
      existing.sourceRevision !== (input.source?.sourceRevision ?? null) ||
      existing.sourceHash !== (input.source?.sourceHash ?? null)
    ) {
      return memoryPersistenceFailure("memory_idempotency_conflict");
    }
    return {
      created: false,
      id: existing.id,
      memoryGenerationSnapshot: existing.memoryGenerationSnapshot,
      memoryRevisionSnapshot: existing.memoryRevisionSnapshot,
      state: existing.state
    };
  }

  const created = await tx.memoryJob.create({
    data: {
      idempotencyFingerprint: input.idempotencyFingerprint,
      kind: input.kind,
      memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision,
      nextAttemptAt: input.nextAttemptAt,
      pipelineVersion: input.pipelineVersion,
      ...(input.source
        ? {
            activeLeafMessageId: input.source.activeLeafMessageId,
            branchGeneration: input.source.branchGeneration,
            chatId: input.source.chatId,
            sourceHash: input.source.sourceHash,
            sourceRevision: input.source.sourceRevision
          }
        : {}),
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
