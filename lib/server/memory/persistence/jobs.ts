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
  targetFactVersionId?: string;
  source?: Readonly<{
    activeLeafMessageId: string;
    branchGeneration: number;
    chatId: string;
    sourceHash: string;
    sourceMessageId?: string;
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
const vNextFactExtractionPipelines = new Set([
  "memory-fact-extraction-vnext-v2",
  "memory-fact-extraction-vnext-v3",
  "memory-fact-extraction-vnext-v4",
  "memory-fact-extraction-vnext-v5"
]);
const relationPipeline = "memory-fact-relation-v2";

export function isMemoryDirectMessageExtractionPipeline(
  pipelineVersion: string
): boolean {
  return vNextFactExtractionPipelines.has(pipelineVersion);
}

function validSource(input: MemoryJobEnqueueInput["source"]): boolean {
  return input === undefined || (
    validToken(input.activeLeafMessageId, 256) &&
    validToken(input.chatId, 256) &&
    (input.sourceMessageId === undefined || validToken(input.sourceMessageId, 256)) &&
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
    !validSource(input.source) ||
    (input.targetFactVersionId !== undefined &&
      !validToken(input.targetFactVersionId, 256)) ||
    (input.kind === "EXTRACT_FACTS" &&
      isMemoryDirectMessageExtractionPipeline(input.pipelineVersion) &&
      input.source?.sourceMessageId === undefined) ||
    (input.kind === "RESOLVE_FACT_RELATIONS" && (
      input.pipelineVersion !== relationPipeline ||
      input.targetFactVersionId === undefined ||
      !validToken(input.targetFactVersionId, 256) ||
      input.source?.sourceMessageId === undefined
    )) ||
    (input.kind !== "RESOLVE_FACT_RELATIONS" &&
      input.kind !== "SYNTHESIZE_MEMORIES" &&
      input.targetFactVersionId !== undefined)
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
      sourceMessageId: true,
      sourceRevision: true,
      state: true,
      targetFactVersionId: true
    },
    where: {
      userId_idempotencyFingerprint: {
        idempotencyFingerprint: input.idempotencyFingerprint,
        userId: settings.userId
      }
    }
  });
  if (existing) {
    const sourceConflict = input.kind === "EXTRACT_FACTS" &&
      isMemoryDirectMessageExtractionPipeline(input.pipelineVersion)
      ? existing.chatId !== (input.source?.chatId ?? null) ||
        existing.sourceMessageId !== (input.source?.sourceMessageId ?? null)
      : existing.chatId !== (input.source?.chatId ?? null) ||
        existing.activeLeafMessageId !== (input.source?.activeLeafMessageId ?? null) ||
        existing.branchGeneration !== (input.source?.branchGeneration ?? null) ||
        existing.sourceRevision !== (input.source?.sourceRevision ?? null) ||
        existing.sourceHash !== (input.source?.sourceHash ?? null) ||
        existing.sourceMessageId !== (input.source?.sourceMessageId ?? null);
    if (
      existing.kind !== input.kind ||
      existing.pipelineVersion !== input.pipelineVersion ||
      existing.targetFactVersionId !== (input.targetFactVersionId ?? null) ||
      sourceConflict
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
      targetFactVersionId: input.targetFactVersionId,
      ...(input.source
        ? {
            activeLeafMessageId: input.source.activeLeafMessageId,
            branchGeneration: input.source.branchGeneration,
            chatId: input.source.chatId,
            sourceHash: input.source.sourceHash,
            sourceMessageId: input.source.sourceMessageId,
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
