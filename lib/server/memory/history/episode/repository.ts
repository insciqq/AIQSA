import {
  Prisma,
  type MemoryExecutionState,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../../prisma";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import {
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryItemEmbeddingJobFingerprint
} from "../../embedding/contract";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../../coordinator/types";
import {
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../../persistence/lexical";
import { enqueueMemoryJob } from "../../persistence/jobs";
import {
  advanceMemoryMutation,
  requireActiveMemoryIndex,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../../persistence/transaction";
import {
  loadMemorySourceSnapshot,
  type MemorySourceSnapshot
} from "../../sourceState";
import { projectMemoryHistorySafeText } from "../safety";
import {
  MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
  MEMORY_EPISODE_MAX_INPUT_CHARACTERS,
  MEMORY_EPISODE_MAX_INPUT_CHUNKS,
  memoryEpisodeExtractionClaimIsValid,
  memoryEpisodeExtractionInputHash,
  memoryEpisodeExtractionOutputHash,
  memoryEpisodeId,
  memoryEpisodeRedreamBatchId,
  memoryEpisodeSourceWindowHash,
  type MemoryEpisodeExtractionInput,
  type MemoryEpisodeExtractionPlan,
  type MemoryEpisodeInputChunk,
  type MemoryEpisodeSourceIdentity
} from "./contract";

type PrepareResult =
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{ input: MemoryEpisodeExtractionInput }>;

export type MemoryEpisodeExecutionBinding = Readonly<{
  acceptedOutputHash: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  secretFreeExecutionSnapshot: unknown;
  state: MemoryExecutionState;
}>;

const staleDecision = Object.freeze({
  errorCode: "memory_episode_source_stale",
  status: "STALE" as const
});
const disabledDecision = Object.freeze({
  errorCode: "memory_history_disabled",
  status: "CANCELLED" as const
});

function sourceMatchesJob(
  source: MemorySourceSnapshot | null,
  job: MemoryJobDescriptor
): source is MemorySourceSnapshot & Readonly<{ activeLeafMessageId: string }> {
  return Boolean(
    source && source.memoryMode === "NORMAL" && source.activeLeafMessageId &&
    source.activeLeafMessageId === job.activeLeafMessageId &&
    source.id === job.chatId &&
    source.memoryBranchGeneration === job.branchGeneration &&
    source.memorySourceRevision === job.sourceRevision &&
    source.sourceHash === job.sourceHash && source.userId === job.userId
  );
}

async function sourceHasActiveSuppression(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor & MemoryEpisodeSourceIdentity
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ suppressed: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "MemorySuppression" AS suppression
      WHERE suppression."userId" = ${job.userId}
        AND (
          suppression."expiresAt" IS NULL
          OR suppression."expiresAt" > CURRENT_TIMESTAMP
        )
        AND (
          suppression."scope" = 'ALL'::"MemorySuppressionScope"
          OR (
            suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND suppression."sourceChatId" = ${job.chatId}
            AND (
              suppression."sourceBranchGeneration" IS NULL
              OR suppression."sourceBranchGeneration" = ${job.branchGeneration}
            )
            AND EXISTS (
              SELECT 1
              FROM "MemoryRecallChunk" AS chunk
              INNER JOIN "MemoryRecallChunkMessage" AS source_message
                ON source_message."userId" = chunk."userId"
                AND source_message."chunkId" = chunk."id"
              WHERE chunk."userId" = suppression."userId"
                AND chunk."chatId" = ${job.chatId}
                AND chunk."branchGeneration" = ${job.branchGeneration}
                AND chunk."sourceRevisionAtCreation" = ${job.sourceRevision}
                AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
                AND source_message."messageId" = suppression."sourceMessageId"
            )
          )
          OR (
            suppression."scope" = 'SOURCE_EPISODE'::"MemorySuppressionScope"
            AND EXISTS (
              SELECT 1
              FROM "MemoryEpisode" AS episode
              WHERE episode."userId" = suppression."userId"
                AND episode."id" = suppression."sourceEpisodeId"
                AND episode."chatId" = ${job.chatId}
                AND episode."branchGeneration" = ${job.branchGeneration}
                AND episode."sourceRevisionAtCreation" = ${job.sourceRevision}
            )
          )
        )
    ) AS "suppressed"
  `);
  return rows[0]?.suppressed === true;
}

async function probeWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor
): Promise<MemoryJobGateDecision> {
  if (!memoryEpisodeExtractionClaimIsValid(job)) {
    return { errorCode: "memory_episode_job_invalid", status: "CANCELLED" };
  }
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return staleDecision;
  const settings = await tx.userMemorySettings.findUnique({
    select: { memoryGeneration: true, referenceChatHistory: true },
    where: { userId: job.userId }
  });
  if (!settings || settings.memoryGeneration !== job.memoryGenerationSnapshot) {
    return staleDecision;
  }
  if (!settings.referenceChatHistory) return disabledDecision;
  if (await sourceHasActiveSuppression(tx, job)) return staleDecision;
  const checkpoint = await tx.chatMemoryCheckpoint.findUnique({
    select: {
      activeLeafMessageId: true,
      branchGeneration: true,
      lastIndexedMessageId: true,
      sourceContentHash: true,
      sourceRevision: true,
      status: true
    },
    where: { userId_chatId: { chatId: job.chatId, userId: job.userId } }
  });
  if (
    !checkpoint || checkpoint.status !== "READY" ||
    checkpoint.activeLeafMessageId !== job.activeLeafMessageId ||
    checkpoint.lastIndexedMessageId !== job.activeLeafMessageId ||
    checkpoint.branchGeneration !== job.branchGeneration ||
    checkpoint.sourceRevision !== job.sourceRevision ||
    checkpoint.sourceContentHash !== job.sourceHash
  ) return staleDecision;
  return { status: "READY" };
}

function boundedRecentChunks<T extends Readonly<{
  chunkOrdinal: number;
  safeProjectedText: string;
}>>(chunks: readonly T[]): readonly T[] {
  const selected: T[] = [];
  let characters = 0;
  for (const chunk of [...chunks].sort((left, right) =>
    right.chunkOrdinal - left.chunkOrdinal)) {
    if (selected.length >= MEMORY_EPISODE_MAX_INPUT_CHUNKS) break;
    if (characters + chunk.safeProjectedText.length >
      MEMORY_EPISODE_MAX_INPUT_CHARACTERS) continue;
    selected.push(chunk);
    characters += chunk.safeProjectedText.length;
  }
  return selected.sort((left, right) => left.chunkOrdinal - right.chunkOrdinal);
}

async function prepareWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor
): Promise<PrepareResult> {
  const decision = await probeWith(tx, job);
  if (decision.status !== "READY") return { decision };
  if (!memoryEpisodeExtractionClaimIsValid(job)) {
    return {
      decision: { errorCode: "memory_episode_job_invalid", status: "CANCELLED" }
    };
  }
  const settings = await tx.userMemorySettings.findUnique({
    select: { activeIndexGenerationId: true },
    where: { userId: job.userId }
  });
  if (!settings?.activeIndexGenerationId) return { decision: staleDecision };
  const rows = await tx.memoryRecallChunk.findMany({
    orderBy: [{ chunkOrdinal: "asc" }, { id: "asc" }],
    select: {
      chunkOrdinal: true,
      contentHash: true,
      id: true,
      languageCode: true,
      occurredFrom: true,
      occurredTo: true,
      redactionReasonCodes: true,
      redactionState: true,
      safeProjectedText: true,
      safetyClass: true,
      sourceAssistantId: true,
      sourceFolderId: true,
      sourceProjectionVersion: true
    },
    where: {
      branchGeneration: job.branchGeneration,
      chatId: job.chatId,
      sourceRevisionAtCreation: job.sourceRevision,
      state: "ACTIVE",
      userId: job.userId
    }
  });
  const safeRows = rows.filter((row) => {
    if (
      row.redactionState === "EXCLUDED" ||
      row.safetyClass === "HIGHLY_SENSITIVE" ||
      row.safetyClass === "SECRET_TAINTED"
    ) return false;
    const safety = projectMemoryHistorySafeText(row.safeProjectedText);
    return safety.eligible && safety.safeText === row.safeProjectedText &&
      safety.providerSafeText === row.safeProjectedText;
  });
  const selected = boundedRecentChunks(safeRows);
  const selectedIds = selected.map((chunk) => chunk.id);
  const [joins, entries] = selectedIds.length === 0
    ? [[], []] as const
    : await Promise.all([
        tx.memoryRecallChunkMessage.findMany({
          orderBy: [{ chunkId: "asc" }, { ordinal: "asc" }],
          select: { chunkId: true, messageId: true, ordinal: true },
          where: { chunkId: { in: selectedIds }, userId: job.userId }
        }),
        tx.memorySearchEntry.findMany({
          select: {
            recallChunkId: true,
            suppressionIdentitySnapshot: true
          },
          where: {
            indexGenerationId: settings.activeIndexGenerationId,
            itemType: "RECALL_CHUNK",
            recallChunkId: { in: selectedIds },
            userId: job.userId
          }
        })
      ]);
  if (
    selectedIds.some((id) => !joins.some((join) => join.chunkId === id)) ||
    entries.length !== selectedIds.length
  ) return { decision: staleDecision };
  const suppressionSnapshots = [...new Set(
    entries.map((entry) => entry.suppressionIdentitySnapshot)
  )].sort();
  const suppressionIdentitySnapshot = suppressionSnapshots.length === 1
    ? suppressionSnapshots[0]!
    : memorySha256({ suppressionSnapshots });
  const chunks: MemoryEpisodeInputChunk[] = selected.map((chunk) => ({
    contentHash: chunk.contentHash,
    id: chunk.id,
    languageCode: chunk.languageCode as MemoryEpisodeInputChunk["languageCode"],
    messageIds: joins
      .filter((join) => join.chunkId === chunk.id)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((join) => join.messageId),
    occurredFrom: chunk.occurredFrom.toISOString(),
    occurredTo: chunk.occurredTo.toISOString(),
    ordinal: chunk.chunkOrdinal,
    redactionReasonCodes: chunk.redactionReasonCodes,
    redactionState: chunk.redactionState as MemoryEpisodeInputChunk["redactionState"],
    safeProjectedText: chunk.safeProjectedText,
    safetyClass: chunk.safetyClass as MemoryEpisodeInputChunk["safetyClass"],
    sourceAssistantId: chunk.sourceAssistantId,
    sourceFolderId: chunk.sourceFolderId,
    sourceProjectionVersion: chunk.sourceProjectionVersion
  }));
  const source: MemoryEpisodeSourceIdentity = {
    activeLeafMessageId: job.activeLeafMessageId,
    branchGeneration: job.branchGeneration,
    chatId: job.chatId,
    sourceHash: job.sourceHash,
    sourceRevision: job.sourceRevision,
    userId: job.userId
  };
  const sourceWindowHash = memoryEpisodeSourceWindowHash(
    source,
    chunks,
    suppressionIdentitySnapshot
  );
  const withoutInputHash = {
    chunks,
    source,
    sourceWindowHash,
    suppressionIdentitySnapshot
  };
  return {
    input: {
      ...withoutInputHash,
      inputHash: memoryEpisodeExtractionInputHash(withoutInputHash)
    }
  };
}

async function markDegradedWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor,
  errorCode: string | null,
  now: Date
): Promise<void> {
  if (!memoryEpisodeExtractionClaimIsValid(job)) return;
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return;
  await tx.chatMemoryCheckpoint.updateMany({
    data: {
      lastDreamedMessageId: job.activeLeafMessageId,
      lastErrorCode: errorCode,
      lastSucceededAt: now,
      status: "READY"
    },
    where: {
      activeLeafMessageId: job.activeLeafMessageId,
      branchGeneration: job.branchGeneration,
      chatId: job.chatId,
      sourceContentHash: job.sourceHash,
      sourceRevision: job.sourceRevision,
      userId: job.userId
    }
  });
}

async function alreadyAppliedWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor,
  bindingId: string
): Promise<boolean> {
  if (!memoryEpisodeExtractionClaimIsValid(job)) return false;
  const checkpoint = await tx.chatMemoryCheckpoint.findUnique({
    select: { lastDreamedMessageId: true, lastErrorCode: true },
    where: { userId_chatId: { chatId: job.chatId, userId: job.userId } }
  });
  if (
    checkpoint?.lastDreamedMessageId !== job.activeLeafMessageId ||
    checkpoint.lastErrorCode !== null
  ) return false;
  const count = await tx.memoryEpisode.count({
    where: { createdByExecutionId: bindingId, userId: job.userId }
  });
  return count > 0 ||
    memoryEpisodeRedreamBatchId(job.idempotencyFingerprint) === null;
}

function expectedEpisodeId(
  plan: MemoryEpisodeExtractionPlan,
  ordinal: number
): string {
  return memoryEpisodeId(plan.input, plan.episodes[ordinal]!, ordinal);
}

async function applyPlan(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryEpisodeExtractionPlan,
  bindingId: string,
  now: Date
): Promise<"APPLIED" | "STALE"> {
  if (
    !memoryEpisodeExtractionClaimIsValid(claim) ||
    plan.input.source.userId !== claim.userId ||
    memoryEpisodeExtractionOutputHash(plan.input, plan.episodes) !== plan.outputHash
  ) throw new MemoryCoordinatorError("memory_episode_plan_invalid", false);
  if (!settings.referenceChatHistory ||
    settings.memoryGeneration !== claim.memoryGenerationSnapshot) return "STALE";
  const current = await prepareWith(tx, claim);
  if ("decision" in current || current.input.inputHash !== plan.input.inputHash) {
    return "STALE";
  }
  if (await alreadyAppliedWith(tx, claim, bindingId)) return "APPLIED";

  const activeEpisodes = await tx.memoryEpisode.findMany({
    select: { id: true },
    where: {
      branchGeneration: claim.branchGeneration,
      chatId: claim.chatId,
      sourceRevisionAtCreation: claim.sourceRevision,
      state: "ACTIVE",
      userId: claim.userId
    }
  });
  const visibilityChanged = activeEpisodes.length > 0 || plan.episodes.length > 0;
  let activeIndex = visibilityChanged
    ? await requireActiveMemoryIndex(tx, settings)
    : null;
  if (visibilityChanged && !activeIndex) {
    throw new MemoryCoordinatorError("memory_active_generation_invalid", false);
  }
  if (visibilityChanged) {
    await advanceMemoryMutation(tx, settings, "CHUNK_OR_EPISODE_VISIBILITY_CHANGE");
    activeIndex = await requireActiveMemoryIndex(tx, settings);
  }
  if (activeEpisodes.length > 0) {
    const ids = activeEpisodes.map((episode) => episode.id);
    await tx.memorySearchEntry.deleteMany({
      where: { episodeId: { in: ids }, userId: claim.userId }
    });
    await tx.memoryEpisode.updateMany({
      data: { invalidatedAt: now, state: "INVALIDATED" },
      where: { id: { in: ids }, state: "ACTIVE", userId: claim.userId }
    });
  }
  const plannedIds = plan.episodes.map((_, ordinal) => expectedEpisodeId(plan, ordinal));
  const suppressedIds = plannedIds.length === 0
    ? new Set<string>()
    : new Set((await tx.memorySuppression.findMany({
        select: { sourceEpisodeId: true },
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          scope: "SOURCE_EPISODE",
          sourceEpisodeId: { in: plannedIds },
          userId: claim.userId
        }
      })).flatMap(({ sourceEpisodeId }) => sourceEpisodeId ? [sourceEpisodeId] : []));
  for (let ordinal = 0; ordinal < plan.episodes.length; ordinal += 1) {
    const episode = plan.episodes[ordinal]!;
    const id = plannedIds[ordinal]!;
    if (suppressedIds.has(id)) continue;
    const episodeData = {
        branchGeneration: claim.branchGeneration!,
        chatId: claim.chatId!,
        createdByExecutionId: bindingId,
        entities: [...episode.entities],
        extractorRole: "MEMORY_EPISODE_EXTRACT",
        keywords: [...episode.keywords],
        languageCode: episode.languageCode,
        normalizedSafeSearchText: normalizeMemorySearchText(episode.safeSummary),
        occurredFrom: new Date(episode.occurredFrom),
        occurredTo: new Date(episode.occurredTo),
        pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
        redactionReasonCodes: [...episode.redactionReasonCodes],
        redactionState: episode.redactionState,
        safeSummary: episode.safeSummary,
        safetyClass: episode.safetyClass,
        sourceAssistantId: episode.sourceAssistantId,
        sourceFolderId: episode.sourceFolderId,
        sourceHash: claim.sourceHash!,
        sourceProjectionVersion: episode.sourceProjectionVersion,
        sourceRevisionAtCreation: claim.sourceRevision!,
        state: "ACTIVE" as const,
        userId: claim.userId
    };
    await tx.memoryEpisode.upsert({
      create: { ...episodeData, createdAt: now, id },
      update: {
        ...episodeData,
        invalidatedAt: null
      },
      where: { id }
    });
    await tx.memoryEpisodeMessage.deleteMany({
      where: { episodeId: id, userId: claim.userId }
    });
    await tx.memoryEpisodeMessage.createMany({
      data: episode.messageIds.map((messageId, messageOrdinal) => ({
        chatId: claim.chatId!,
        episodeId: id,
        messageId,
        ordinal: messageOrdinal,
        userId: claim.userId
      }))
    });
    const safeContentHash = memorySha256(episode.safeSummary);
    const searchEntry = await tx.memorySearchEntry.create({
      data: {
        embeddingState: activeIndex!.indexMode === "LEXICAL_ONLY"
          ? "NOT_APPLICABLE"
          : "PENDING",
        episodeId: id,
        indexGenerationId: activeIndex!.id,
        itemType: "EPISODE",
        languageCode: episode.languageCode,
        safeContentHash,
        safeSearchText: normalizeMemorySearchText(episode.safeSummary),
        safeSearchTextYoNormalized: normalizeMemorySearchTextYo(episode.safeSummary),
        safetyIdentitySnapshot: memorySha256({
          redactionReasonCodes: episode.redactionReasonCodes,
          redactionState: episode.redactionState,
          safetyClass: episode.safetyClass,
          sourceProjectionVersion: episode.sourceProjectionVersion
        }),
        sourceIdentitySnapshot: memorySha256({
          branchGeneration: claim.branchGeneration,
          chatId: claim.chatId,
          chunkIds: episode.chunkIds,
          messageIds: episode.messageIds,
          sourceHash: claim.sourceHash,
          sourceRevision: claim.sourceRevision,
          userId: claim.userId
        }),
        suppressionIdentitySnapshot: plan.input.suppressionIdentitySnapshot,
        userId: claim.userId
      },
      select: { embeddingState: true, id: true }
    });
    if (searchEntry.embeddingState === "PENDING") {
      await enqueueMemoryJob(tx, settings, {
        idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
          searchEntry.id,
          `${plan.outputHash}:${id}`
        ),
        kind: "EMBED_ITEMS",
        pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
      });
    }
  }
  await tx.chatMemoryCheckpoint.updateMany({
    data: {
      lastDreamedMessageId: claim.activeLeafMessageId,
      lastErrorCode: null,
      lastSucceededAt: now,
      status: "READY"
    },
    where: {
      activeLeafMessageId: claim.activeLeafMessageId,
      branchGeneration: claim.branchGeneration,
      chatId: claim.chatId,
      sourceContentHash: claim.sourceHash,
      sourceRevision: claim.sourceRevision,
      userId: claim.userId
    }
  });
  return "APPLIED";
}

export function createPrismaMemoryEpisodeRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    apply: applyPlan,
    async alreadyApplied(
      job: MemoryJobDescriptor,
      bindingId: string
    ): Promise<boolean> {
      return client.$transaction((tx) => alreadyAppliedWith(tx, job, bindingId), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    bindings(userId: string, jobId: string): Promise<MemoryEpisodeExecutionBinding[]> {
      return client.memoryExecutionBinding.findMany({
        orderBy: [{ ordinal: "asc" }, { createdAt: "asc" }],
        select: {
          acceptedOutputHash: true,
          id: true,
          inputHash: true,
          ordinal: true,
          secretFreeExecutionSnapshot: true,
          state: true
        },
        where: { memoryJobId: jobId, userId }
      });
    },
    async markDegraded(
      job: MemoryJobDescriptor,
      errorCode: string,
      now: Date
    ): Promise<void> {
      await client.$transaction((tx) => markDegradedWith(tx, job, errorCode, now), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    async markComplete(job: MemoryJobDescriptor, now: Date): Promise<void> {
      await client.$transaction((tx) => markDegradedWith(tx, job, null, now), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    async preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      return client.$transaction((tx) => probeWith(tx, job), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    async prepare(job: MemoryJobDescriptor): Promise<PrepareResult> {
      return client.$transaction((tx) => prepareWith(tx, job), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    }
  });
}

export type MemoryEpisodeRepository = ReturnType<
  typeof createPrismaMemoryEpisodeRepository
>;

export type { PrepareResult as MemoryEpisodePrepareResult };
