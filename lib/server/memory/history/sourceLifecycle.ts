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

function isProjectSource(event: MemoryRetainedSourceMutationEvent): boolean {
  return (event.snapshot.projectId !== null && event.snapshot.projectId !== undefined) ||
    (event.previous.projectId !== null && event.previous.projectId !== undefined);
}

function shouldIndex(event: MemoryRetainedSourceMutationEvent): boolean {
  if (
    isProjectSource(event) ||
    event.snapshot.memoryMode !== "NORMAL" ||
    event.snapshot.activeLeafMessageId === null
  ) {
    return false;
  }
  // Resume only opens the source for future turns.  Reindexing the retained
  // pre-exclusion path would violate the per-chat pause boundary; the next
  // settled assistant turn creates a fresh source snapshot and is handled by
  // the terminal-settlement branch below.
  return event.mutations.includes("TERMINAL_SETTLEMENT") &&
    event.settlement?.status === "complete" &&
    event.settlement.assistantMessageId === event.snapshot.activeLeafMessageId;
}

function retainsVisibleHistoryWhilePaused(
  settings: LockedMemorySettings,
  event: MemoryRetainedSourceMutationEvent
): boolean {
  return (
    (!settings.useMemoryFacts || !settings.referenceChatHistory) &&
    event.previous.memoryMode === "NORMAL" &&
    event.snapshot.memoryMode === "NORMAL" &&
    event.previous.folderId === event.snapshot.folderId &&
    event.previous.memoryBranchGeneration === event.snapshot.memoryBranchGeneration &&
    event.mutations.some((mutation) =>
      mutation === "NORMAL_APPEND" || mutation === "TERMINAL_SETTLEMENT") &&
    !event.mutations.some((mutation) =>
      mutation === "SOURCE_EXCLUDE" || mutation === "SOURCE_HARD_DELETE")
  );
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
  const resumedWithoutBackfill = event.mutations.includes("SOURCE_RESUME");
  if (resumedWithoutBackfill) {
    const resumeCreatedAtCutoff = new Date();
    await tx.chatMemoryCheckpoint.upsert({
      create: {
        activeLeafMessageId: event.snapshot.activeLeafMessageId,
        branchGeneration: event.snapshot.memoryBranchGeneration,
        chatId: event.snapshot.id,
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
        resumeCreatedAtCutoff,
        sourceContentHash: event.snapshot.sourceHash,
        sourceRevision: event.snapshot.memorySourceRevision,
        status: "STALE",
        userId: event.snapshot.userId
      },
      update: {
        activeLeafMessageId: event.snapshot.activeLeafMessageId,
        branchGeneration: event.snapshot.memoryBranchGeneration,
        lastErrorCode: null,
        lastIndexedMessageId: null,
        lastSucceededAt: null,
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
        resumeCreatedAtCutoff,
        sourceContentHash: event.snapshot.sourceHash,
        sourceRevision: event.snapshot.memorySourceRevision,
        status: "STALE"
      },
      where: {
        userId_chatId: {
          chatId: event.snapshot.id,
          userId: event.snapshot.userId
        }
      }
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
      pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
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
      pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
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
      pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
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
  // Project chats are a separate shared-memory boundary.  Do not invalidate,
  // checkpoint, purge, or enqueue personal history artifacts for them.
  if (isProjectSource(event)) {
    return;
  }
  const changed = sourceIdentityChanged(event);
  const permanentDelete = event.mutations.includes("SOURCE_HARD_DELETE");
  let settings: LockedMemorySettings | null = null;
  if (changed) {
    settings = await lockMemorySettings(tx, event.snapshot.userId, false);
    // A Normal append while master/Search is paused is not a destructive
    // source mutation. Keep the last READY derivative and checkpoint intact;
    // retrieval may reuse it after resume only when the current leaf is
    // proven to belong to the closed pause interval. The first post-resume
    // append follows the ordinary invalidation/reindex path below.
    if (!retainsVisibleHistoryWhilePaused(settings, event)) {
      const now = new Date();
      const invalidated = await invalidateVisibleHistory(tx, event, now);
      if (invalidated > 0) {
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
  }

  if (!shouldIndex(event)) return;
  settings ??= await lockMemorySettings(tx, event.snapshot.userId, false);
  // The master switch is authoritative over every personal source.  Keep
  // deletion/invalidation work above this point alive while paused, but do
  // not create a history checkpoint/job until Memory is explicitly resumed.
  if (!settings.useMemoryFacts || !settings.referenceChatHistory) return;
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
