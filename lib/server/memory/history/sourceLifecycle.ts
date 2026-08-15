import { memoryCounterEffectFor } from "../../../domain/memory/counters";
import { enqueueMemoryJob } from "../persistence/jobs";
import { enqueueMemoryDeletion } from "../persistence/deletion";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  requireActiveMemoryIndex,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../persistence/transaction";
import type { MemoryRetainedSourceMutationEvent } from "../sourceState";
import {
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryIndexJobFingerprint
} from "./contract";
import { MEMORY_HISTORY_SOURCE_TARGET_TYPE } from "./purge";

function sourceIdentityChanged(event: MemoryRetainedSourceMutationEvent): boolean {
  return event.previous.activeLeafMessageId !== event.snapshot.activeLeafMessageId ||
    event.previous.folderId !== event.snapshot.folderId ||
    event.previous.memoryBranchGeneration !== event.snapshot.memoryBranchGeneration ||
    event.previous.memoryMode !== event.snapshot.memoryMode ||
    event.previous.memorySourceRevision !== event.snapshot.memorySourceRevision;
}

function parentMutationAdvancedMemoryRevision(
  event: MemoryRetainedSourceMutationEvent
): boolean {
  return event.mutations.some((mutation) =>
    memoryCounterEffectFor(mutation).memoryRevision);
}

function shouldIndex(event: MemoryRetainedSourceMutationEvent): boolean {
  if (
    event.snapshot.memoryMode !== "NORMAL" ||
    event.snapshot.activeLeafMessageId === null
  ) {
    return false;
  }
  if (event.mutations.includes("SOURCE_RESUME")) return true;
  return event.mutations.includes("TERMINAL_SETTLEMENT") &&
    event.settlement?.status === "complete" &&
    event.settlement.assistantMessageId === event.snapshot.activeLeafMessageId;
}

async function invalidateVisibleHistory(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent,
  now: Date
): Promise<number> {
  const chunks = await tx.memoryRecallChunk.findMany({
    select: { id: true },
    where: {
      chatId: event.snapshot.id,
      state: "ACTIVE",
      userId: event.snapshot.userId
    }
  });
  if (chunks.length === 0) return 0;

  await tx.memorySearchEntry.deleteMany({
    where: {
      recallChunkId: { in: chunks.map((chunk) => chunk.id) },
      userId: event.snapshot.userId
    }
  });
  await tx.memoryRecallChunk.updateMany({
    data: { invalidatedAt: now, state: "INVALIDATED" },
    where: {
      id: { in: chunks.map((chunk) => chunk.id) },
      state: "ACTIVE",
      userId: event.snapshot.userId
    }
  });
  return chunks.length;
}

async function settleVisibleMutationCounter(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  event: MemoryRetainedSourceMutationEvent
): Promise<void> {
  if (!parentMutationAdvancedMemoryRevision(event)) {
    await advanceMemoryMutation(tx, settings, "CHUNK_VISIBILITY_CHANGE");
    return;
  }
  const activeIndex = await requireActiveMemoryIndex(tx, settings);
  if (!activeIndex) return;
  const settled = await tx.memoryIndexGeneration.updateMany({
    data: { indexedThroughMemoryRevision: settings.memoryRevision },
    where: {
      id: activeIndex.id,
      state: "ACTIVE",
      userId: settings.userId
    }
  });
  if (settled.count !== 1) {
    throw new Error("memory_active_generation_invalid");
  }
}

async function updateExistingCheckpoint(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent
): Promise<void> {
  if (event.snapshot.activeLeafMessageId === null) {
    await tx.chatMemoryCheckpoint.deleteMany({
      where: { chatId: event.snapshot.id, userId: event.snapshot.userId }
    });
    return;
  }
  await tx.chatMemoryCheckpoint.updateMany({
    data: {
      activeLeafMessageId: event.snapshot.activeLeafMessageId,
      branchGeneration: event.snapshot.memoryBranchGeneration,
      lastErrorCode: event.snapshot.memoryMode === "NORMAL"
        ? null
        : "memory_source_ineligible",
      lastIndexedMessageId: null,
      lastSucceededAt: null,
      sourceContentHash: event.snapshot.sourceHash,
      sourceRevision: event.snapshot.memorySourceRevision,
      status: event.snapshot.memoryMode === "NORMAL" ? "PENDING" : "STALE"
    },
    where: { chatId: event.snapshot.id, userId: event.snapshot.userId }
  });
}

async function ensurePendingCheckpoint(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent
): Promise<void> {
  const activeLeafMessageId = event.snapshot.activeLeafMessageId;
  if (!activeLeafMessageId) return;
  await tx.chatMemoryCheckpoint.upsert({
    create: {
      activeLeafMessageId,
      branchGeneration: event.snapshot.memoryBranchGeneration,
      chatId: event.snapshot.id,
      sourceContentHash: event.snapshot.sourceHash,
      sourceRevision: event.snapshot.memorySourceRevision,
      status: "PENDING",
      userId: event.snapshot.userId
    },
    update: {
      activeLeafMessageId,
      branchGeneration: event.snapshot.memoryBranchGeneration,
      lastErrorCode: null,
      lastIndexedMessageId: null,
      lastSucceededAt: null,
      sourceContentHash: event.snapshot.sourceHash,
      sourceRevision: event.snapshot.memorySourceRevision,
      status: "PENDING"
    },
    where: {
      userId_chatId: {
        chatId: event.snapshot.id,
        userId: event.snapshot.userId
      }
    }
  });
}

export async function applyMemoryHistorySourceMutation(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent
): Promise<void> {
  const changed = sourceIdentityChanged(event);
  const permanentDelete = event.mutations.includes("SOURCE_HARD_DELETE");
  let settings: LockedMemorySettings | null = null;
  if (changed) {
    const now = new Date();
    const invalidated = await invalidateVisibleHistory(tx, event, now);
    if (invalidated > 0) {
      settings = await lockMemorySettings(tx, event.snapshot.userId, false);
      await settleVisibleMutationCounter(tx, settings, event);
      if (!permanentDelete) {
        const deletion = await enqueueMemoryDeletion(tx, settings, {
          operation: "SOURCE_PURGE",
          targetId: event.snapshot.id,
          targetType: MEMORY_HISTORY_SOURCE_TARGET_TYPE
        });
        if (!deletion.created) {
          await tx.memoryDeletionOutbox.update({
            data: {
              completedAt: null,
              errorCode: null,
              lastAuditAt: null,
              leaseExpiresAt: null,
              leaseToken: null,
              nextAttemptAt: null,
              state: "PENDING"
            },
            where: { id: deletion.id }
          });
        }
      }
    }
    await updateExistingCheckpoint(tx, event);
  }

  if (!shouldIndex(event)) return;
  settings ??= await lockMemorySettings(tx, event.snapshot.userId, false);
  if (!settings.referenceChatHistory) return;
  await ensurePendingCheckpoint(tx, event);
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryHistoryIndexJobFingerprint(event.snapshot),
    kind: "INDEX_HISTORY",
    pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    source: {
      activeLeafMessageId: event.snapshot.activeLeafMessageId!,
      branchGeneration: event.snapshot.memoryBranchGeneration,
      chatId: event.snapshot.id,
      sourceHash: event.snapshot.sourceHash,
      sourceRevision: event.snapshot.memorySourceRevision
    }
  });
}
