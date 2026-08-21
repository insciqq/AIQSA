import { enqueueMemoryDeletion } from "../persistence/deletion";
import { enqueueMemoryJob } from "../persistence/jobs";
import {
  lockMemorySettings,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../persistence/transaction";
import type { MemoryRetainedSourceMutationEvent } from "../sourceState";
import { MEMORY_HISTORY_SOURCE_TARGET_TYPE } from "../history/purge";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  memoryFactExtractionJobFingerprint
} from "./extraction/contract";
import { normalizeMemoryFactsForSourceMutation } from "./consolidation/normalization";

function invalidatesCandidates(event: MemoryRetainedSourceMutationEvent): boolean {
  return event.previous.folderId !== event.snapshot.folderId ||
    event.previous.memoryBranchGeneration !== event.snapshot.memoryBranchGeneration ||
    event.previous.memoryMode !== event.snapshot.memoryMode ||
    event.mutations.includes("SOURCE_HARD_DELETE") ||
    event.mutations.includes("SOURCE_EXCLUDE");
}

function isProjectSource(event: MemoryRetainedSourceMutationEvent): boolean {
  return (event.snapshot.projectId !== null && event.snapshot.projectId !== undefined) ||
    (event.previous.projectId !== null && event.previous.projectId !== undefined);
}

function shouldExtract(event: MemoryRetainedSourceMutationEvent): boolean {
  if (
    isProjectSource(event) ||
    event.snapshot.memoryMode !== "NORMAL" ||
    event.snapshot.activeLeafMessageId === null
  ) return false;
  // Resume is a forward-only boundary. Automatic extraction starts with the
  // next settled user turn; it must never replay the retained pre-exclusion
  // path implicitly.
  return event.mutations.includes("TERMINAL_SETTLEMENT") &&
    event.settlement?.status === "complete" &&
    event.settlement.assistantMessageId === event.snapshot.activeLeafMessageId;
}

async function reopenSourcePurge(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  chatId: string
): Promise<void> {
  const deletion = await enqueueMemoryDeletion(tx, settings, {
    operation: "SOURCE_PURGE",
    targetId: chatId,
    targetType: MEMORY_HISTORY_SOURCE_TARGET_TYPE
  });
  if (deletion.created) return;
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

export async function applyMemoryLearningSourceMutation(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent
): Promise<void> {
  // Project chats never enter the personal automatic-facts lifecycle.
  if (isProjectSource(event)) {
    return;
  }
  const permanentDelete = event.mutations.includes("SOURCE_HARD_DELETE");
  let settings: LockedMemorySettings | null =
    await normalizeMemoryFactsForSourceMutation(tx, event);
  if (settings && !permanentDelete) {
    await reopenSourcePurge(tx, settings, event.snapshot.id);
  }
  if (invalidatesCandidates(event)) {
    const now = new Date();
    const candidates = await tx.memoryCandidate.findMany({
      select: { id: true },
      where: {
        chatId: event.snapshot.id,
        state: { in: ["PENDING", "DEFERRED"] },
        userId: event.snapshot.userId
      }
    });
    if (candidates.length > 0) {
      await tx.memoryCandidateDecision.updateMany({
        data: { resolvedAt: now, state: "STALE" },
        where: {
          candidateId: { in: candidates.map(({ id }) => id) },
          state: "PENDING_VERIFICATION",
          userId: event.snapshot.userId
        }
      });
    }
    const invalidated = await tx.memoryCandidate.updateMany({
      data: {
        reasonCode: "source_invalidated",
        resolvedAt: now,
        state: "STALE"
      },
      where: {
        chatId: event.snapshot.id,
        state: { in: ["PENDING", "DEFERRED"] },
        userId: event.snapshot.userId
      }
    });
    if (invalidated.count > 0 && !permanentDelete) {
      settings = await lockMemorySettings(tx, event.snapshot.userId, false);
      await reopenSourcePurge(tx, settings, event.snapshot.id);
    }
  }

  if (!shouldExtract(event)) return;
  settings ??= await lockMemorySettings(tx, event.snapshot.userId, false);
  // Master Memory is the outer gate.  Source cleanup and stale-candidate
  // fencing above still run while paused, but no new automatic-learning job
  // may be admitted until the user explicitly resumes Memory.
  if (!settings.useMemoryFacts || !settings.learnAutomatically) return;
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryFactExtractionJobFingerprint({
      activeLeafMessageId: event.snapshot.activeLeafMessageId!,
      branchGeneration: event.snapshot.memoryBranchGeneration,
      chatId: event.snapshot.id,
      sourceHash: event.snapshot.sourceHash,
      sourceRevision: event.snapshot.memorySourceRevision,
      userId: event.snapshot.userId
    }),
    kind: "EXTRACT_FACTS",
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    source: {
      activeLeafMessageId: event.snapshot.activeLeafMessageId!,
      branchGeneration: event.snapshot.memoryBranchGeneration,
      chatId: event.snapshot.id,
      sourceHash: event.snapshot.sourceHash,
      sourceRevision: event.snapshot.memorySourceRevision
    }
  });
}
