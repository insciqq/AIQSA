import { Prisma } from "@prisma/client";
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
  MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION,
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

function requiresFullHistoryRebuild(
  event: MemoryRetainedSourceMutationEvent
): boolean {
  return event.previous.folderId !== event.snapshot.folderId ||
    event.previous.memoryMode !== event.snapshot.memoryMode ||
    event.mutations.some((mutation) =>
      mutation === "SOURCE_EXCLUDE" ||
      mutation === "SOURCE_RESUME" ||
      mutation === "FOLDER_MOVE" ||
      mutation === "SCOPE_TARGET_DELETE");
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

async function invalidateAffectedHistory(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent,
  now: Date
): Promise<Readonly<{ chunks: number; digest: number; rounds: number }>> {
  const invalidateAll = event.snapshot.memoryMode !== "NORMAL" ||
    event.snapshot.activeLeafMessageId === null ||
    event.previous.folderId !== event.snapshot.folderId ||
    event.mutations.includes("SOURCE_HARD_DELETE") ||
    event.mutations.includes("SOURCE_EXCLUDE");
  const chunks = invalidateAll
    ? await tx.memoryRecallChunk.findMany({
        select: { id: true },
        where: {
          chatId: event.snapshot.id,
          state: { in: ["ACTIVE", "SUPPRESSED"] },
          userId: event.snapshot.userId
        }
      })
    : await tx.$queryRaw<Array<{ id: string }>>`
        WITH RECURSIVE active_path AS (
          SELECT message."id", message."parentMessageId"
          FROM "Message" AS message
          WHERE message."chatId" = ${event.snapshot.id}
            AND message."id" = ${event.snapshot.activeLeafMessageId}
          UNION ALL
          SELECT parent."id", parent."parentMessageId"
          FROM active_path AS child
          INNER JOIN "Message" AS parent
            ON parent."chatId" = ${event.snapshot.id}
            AND parent."id" = child."parentMessageId"
        )
        SELECT DISTINCT chunk."id"
        FROM "MemoryRecallChunk" AS chunk
        INNER JOIN "MemoryRecallChunkMessage" AS source_map
          ON source_map."userId" = chunk."userId"
          AND source_map."chatId" = chunk."chatId"
          AND source_map."chunkId" = chunk."id"
        LEFT JOIN "Message" AS source_message
          ON source_message."chatId" = source_map."chatId"
          AND source_message."id" = source_map."messageId"
        LEFT JOIN active_path ON active_path."id" = source_map."messageId"
        WHERE chunk."userId" = ${event.snapshot.userId}
          AND chunk."chatId" = ${event.snapshot.id}
          AND chunk."state" IN (
            'ACTIVE'::"MemoryHistoryItemState",
            'SUPPRESSED'::"MemoryHistoryItemState"
          )
          AND (
            active_path."id" IS NULL
            OR source_message."id" IS NULL
            OR source_message."updatedAt" <> source_map."sourceMessageUpdatedAt"
          )
        ORDER BY chunk."id"
      `;
  const roundParentPredicate = chunks.length > 0
    ? Prisma.sql`round."parentChunkId" IN (${Prisma.join(chunks.map(({ id }) => id))}) OR`
    : Prisma.empty;
  const rounds = invalidateAll
    ? await tx.memoryRecallRound.findMany({
        select: { id: true },
        where: {
          chatId: event.snapshot.id,
          state: { in: ["ACTIVE", "SUPPRESSED"] },
          userId: event.snapshot.userId
        }
      })
    : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT round."id"
        FROM "MemoryRecallRound" AS round
        WHERE round."userId" = ${event.snapshot.userId}
          AND round."chatId" = ${event.snapshot.id}
          AND round."state" IN (
            'ACTIVE'::"MemoryHistoryItemState",
            'SUPPRESSED'::"MemoryHistoryItemState"
          )
          AND (
            ${roundParentPredicate}
            NOT EXISTS (
              SELECT 1 FROM "MemoryRecallChunk" AS parent
              WHERE parent."userId" = round."userId"
                AND parent."id" = round."parentChunkId"
                AND parent."state" = 'ACTIVE'::"MemoryHistoryItemState"
            )
          )
        ORDER BY round."id"
      `);
  const activeDigest = await tx.chatMemoryDigest.findFirst({
    select: { id: true },
    where: {
      chatId: event.snapshot.id,
      state: "ACTIVE",
      userId: event.snapshot.userId
    }
  });
  if (activeDigest) {
    await tx.chatMemoryDigest.update({
      data: { invalidatedAt: now, state: "INVALIDATED" },
      where: { id: activeDigest.id }
    });
  }
  if (chunks.length === 0 && rounds.length === 0) {
    return { chunks: 0, digest: Number(activeDigest !== null), rounds: 0 };
  }

  await tx.memorySearchEntry.deleteMany({
    where: {
      OR: [
        { recallChunkId: { in: chunks.map((chunk) => chunk.id) } },
        { recallRoundId: { in: rounds.map((round) => round.id) } }
      ],
      userId: event.snapshot.userId
    }
  });
  if (rounds.length > 0) {
    await tx.memoryRecallRound.updateMany({
      data: { invalidatedAt: now, state: "INVALIDATED" },
      where: {
        id: { in: rounds.map((round) => round.id) },
        state: { in: ["ACTIVE", "SUPPRESSED"] },
        userId: event.snapshot.userId
      }
    });
  }
  await tx.memoryRecallChunk.updateMany({
    data: { invalidatedAt: now, state: "INVALIDATED" },
    where: {
      id: { in: chunks.map((chunk) => chunk.id) },
      state: { in: ["ACTIVE", "SUPPRESSED"] },
      userId: event.snapshot.userId
    }
  });
  return {
    chunks: chunks.length,
    digest: Number(activeDigest !== null),
    rounds: rounds.length
  };
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
        pipelineVersion: MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION,
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
        pipelineVersion: MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION,
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
      ...(requiresFullHistoryRebuild(event)
        ? { pipelineVersion: MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION }
        : {}),
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
      const invalidated = await invalidateAffectedHistory(tx, event, now);
      if (invalidated.chunks > 0 || invalidated.digest > 0 || invalidated.rounds > 0) {
        await settleVisibleMutationCounter(tx, settings, event);
        if (!permanentDelete && (
          invalidated.chunks > 0 || invalidated.rounds > 0 ||
            event.snapshot.memoryMode !== "NORMAL"
        )) {
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
