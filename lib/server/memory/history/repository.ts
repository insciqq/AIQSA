import {
  Prisma,
  type MemoryEmbeddingState,
  type MemoryHistoryItemState,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import {
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryItemEmbeddingJobFingerprint
} from "../embedding/contract";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../coordinator/types";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import {
  memoryDestructiveSourceCutoff,
  memorySourceIsInsidePause
} from "../persistence/pauseIntervals";
import { enqueueMemoryJob } from "../persistence/jobs";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  requireActiveMemoryIndex,
  type LockedMemorySettings,
  type MemoryActiveIndex,
  type MemoryTransaction
} from "../persistence/transaction";
import {
  loadMemorySourceSnapshot,
  type MemorySourceSnapshot
} from "../sourceState";
import {
  chunkMemoryRecallProjection,
  MEMORY_HISTORY_CHUNKING_VERSION,
  type MemoryRecallChunkMessageJoin
} from "./chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryChunkId,
  memoryHistoryIndexClaimIsValid,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan,
  type MemoryHistoryIndexSourceIdentity,
  type MemoryHistoryPreparedChunk
} from "./contract";
import { planMemoryHistoryIncrementalUpdate } from "./incremental";
import {
  buildMemorySafeSourceSnapshot,
  MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
  type MemoryHistorySourceMessageInput,
  type MemoryHistorySourceOrigin,
  type MemoryHistoryTaintSource
} from "./sourceProjection";

type MemoryHistoryPrepareResult =
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{ plan: MemoryHistoryIndexPlan }>;

type HistoryAdmission = Readonly<{
  excludedMessageIds: readonly string[];
  sourceCreatedAtCutoff: string | null;
  suppressionIdentitySnapshot: string;
}>;

type CurrentChunkRow = Readonly<{
  branchGeneration: number;
  chunkOrdinal: number;
  chunkingVersion: string;
  contentHash: string;
  id: string;
  languageCode: string;
  normalizedSafeSearchText: string;
  occurredFrom: Date;
  occurredTo: Date;
  redactionReasonCodes: string[];
  redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
  safeProjectedText: string;
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
  sourceAssistantId: string | null;
  sourceFolderId: string | null;
  sourceProjectionVersion: string;
  sourceRevisionAtCreation: number;
  state: MemoryHistoryItemState;
  messageJoins: readonly MemoryRecallChunkMessageJoin[];
}>;

type ExpectedSearchEntry = Readonly<{
  languageCode: string;
  safeContentHash: string;
  normalizedSearchText: string;
  safetyIdentitySnapshot: string;
  sourceIdentitySnapshot: string;
  suppressionIdentitySnapshot: string;
}>;

const staleDecision = Object.freeze({
  errorCode: "memory_source_stale",
  status: "STALE" as const
});
const disabledDecision = Object.freeze({
  errorCode: "memory_history_disabled",
  status: "CANCELLED" as const
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function runTimeZone(value: Prisma.JsonValue | null): string {
  if (!isRecord(value) || !isRecord(value.prompt) || !isRecord(value.prompt.baseline)) {
    return "UTC";
  }
  return canonicalTimeZone(value.prompt.baseline.timeZone);
}

function sourceMatchesJob(
  source: MemorySourceSnapshot | null,
  job: MemoryJobDescriptor
): source is MemorySourceSnapshot & Readonly<{ activeLeafMessageId: string }> {
  return Boolean(
    source &&
    source.memoryMode === "NORMAL" &&
    source.activeLeafMessageId !== null &&
    source.activeLeafMessageId === job.activeLeafMessageId &&
    source.id === job.chatId &&
    source.memoryBranchGeneration === job.branchGeneration &&
    source.memorySourceRevision === job.sourceRevision &&
    source.sourceHash === job.sourceHash &&
    source.userId === job.userId
  );
}

async function probeWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor
): Promise<MemoryJobGateDecision> {
  if (!memoryHistoryIndexClaimIsValid(job)) {
    return {
      errorCode: "memory_history_job_invalid",
      status: "CANCELLED"
    };
  }
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return staleDecision;
  const settings = await tx.userMemorySettings.findUnique({
    select: {
      memoryGeneration: true,
      referenceChatHistory: true,
      useMemoryFacts: true
    },
    where: { userId: job.userId }
  });
  if (!settings || settings.memoryGeneration !== job.memoryGenerationSnapshot) {
    return staleDecision;
  }
  if (!settings.useMemoryFacts || !settings.referenceChatHistory) return disabledDecision;
  return { status: "READY" };
}

function pathOrigin(role: string): Readonly<{
  origin: MemoryHistorySourceOrigin;
  taintSources: readonly MemoryHistoryTaintSource[];
}> {
  if (role === "user") return { origin: "DIRECT_USER", taintSources: [] };
  if (role === "assistant") {
    return { origin: "VISIBLE_ASSISTANT", taintSources: [] };
  }
  if (role === "system") return { origin: "SYSTEM", taintSources: ["SYSTEM"] };
  if (role === "developer") {
    return { origin: "DEVELOPER", taintSources: ["DEVELOPER"] };
  }
  if (role === "tool") return { origin: "TOOL", taintSources: ["TOOL"] };
  return { origin: "PROVIDER_PAYLOAD", taintSources: ["PROVIDER_PAYLOAD"] };
}

async function loadHistoryAdmission(
  tx: MemoryTransaction,
  source: MemorySourceSnapshot,
  now: Date
): Promise<HistoryAdmission> {
  const pathMessageIds = source.messages.map((message) => message.id);
  const [barriers, checkpoint, pauseIntervals] = await Promise.all([
    tx.memorySourceBarrier.findMany({
      orderBy: [{ sourceCreatedAtCutoff: "asc" }, { id: "asc" }],
      select: {
        createdAt: true,
        explicitOverrideAllowed: true,
        id: true,
        kind: true,
        memoryGeneration: true,
        sourceCreatedAtCutoff: true
      },
      where: {
        explicitOverrideAllowed: false,
        kind: { in: ["ALL_REUSABLE", "HISTORY_INDEX"] },
        userId: source.userId
      }
    }),
    tx.chatMemoryCheckpoint.findUnique({
      select: { resumeCreatedAtCutoff: true },
      where: {
        userId_chatId: {
          chatId: source.id,
          userId: source.userId
        }
      }
    }),
    tx.memoryPauseInterval.findMany({
      orderBy: [{ pausedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        memoryGeneration: true,
        pausedAt: true,
        resumedAt: true,
        scope: true
      },
      where: {
        scope: { in: ["MASTER", "SEARCH_HISTORY"] },
        userId: source.userId
      }
    })
  ]);
  const suppressions = pathMessageIds.length === 0
    ? []
    : await tx.memorySuppression.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          expiresAt: true,
          fingerprintKeyVersion: true,
          id: true,
          scope: true,
          sourceBranchGeneration: true,
          sourceChatId: true,
          sourceMessageId: true
        },
        where: {
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            {
              OR: [
                { scope: "ALL" },
                {
                  scope: "SOURCE_MESSAGE",
                  sourceBranchGeneration: source.memoryBranchGeneration,
                  sourceChatId: source.id,
                  sourceMessageId: { in: pathMessageIds }
                }
              ]
            }
          ],
          userId: source.userId
        }
      });
  const excludesAll = suppressions.some((suppression) => suppression.scope === "ALL");
  const suppressionExcludedMessageIds = excludesAll
    ? pathMessageIds
    : suppressions.flatMap((suppression) =>
        suppression.scope === "SOURCE_MESSAGE" && suppression.sourceMessageId
          ? [suppression.sourceMessageId]
          : []);
  const pauseExcludedMessageIds = source.messages.flatMap((message) =>
    memorySourceIsInsidePause(message.createdAt, pauseIntervals) ? [message.id] : []);
  const excludedMessageIds = [
    ...suppressionExcludedMessageIds,
    ...pauseExcludedMessageIds
  ];
  const globalCutoff = memoryDestructiveSourceCutoff(barriers);
  const chatResumeCutoff = checkpoint?.resumeCreatedAtCutoff ?? null;
  const cutoff = globalCutoff && chatResumeCutoff
    ? (globalCutoff > chatResumeCutoff ? globalCutoff : chatResumeCutoff)
    : globalCutoff ?? chatResumeCutoff;
  return {
    excludedMessageIds: [...new Set(excludedMessageIds)].sort(),
    sourceCreatedAtCutoff: cutoff?.toISOString() ?? null,
    suppressionIdentitySnapshot: memorySha256({
      barriers: barriers.map((barrier) => ({
        createdAt: barrier.createdAt,
        explicitOverrideAllowed: barrier.explicitOverrideAllowed,
        id: barrier.id,
        kind: barrier.kind,
        memoryGeneration: barrier.memoryGeneration,
        sourceCreatedAtCutoff: barrier.sourceCreatedAtCutoff
      })),
      checkpointResumeCutoff: chatResumeCutoff,
      pauseIntervals,
      suppressions: suppressions.map((suppression) => ({
        expiresAt: suppression.expiresAt,
        fingerprintKeyVersion: suppression.fingerprintKeyVersion,
        id: suppression.id,
        scope: suppression.scope,
        sourceBranchGeneration: suppression.sourceBranchGeneration,
        sourceChatId: suppression.sourceChatId,
        sourceMessageId: suppression.sourceMessageId
      }))
    })
  };
}

async function loadIncrementalHistoryState(
  tx: MemoryTransaction,
  source: MemorySourceSnapshot
): Promise<Readonly<{
  chunks: readonly CurrentChunkRow[];
  checkpointPipelineVersion: string | null;
  messages: readonly Readonly<{
    messageId: string;
    sourceMessageUpdatedAt: string;
  }>[];
}>> {
  const [checkpoint, rows, messageRows] = await Promise.all([
    tx.chatMemoryCheckpoint.findUnique({
      select: { pipelineVersion: true },
      where: { userId_chatId: { chatId: source.id, userId: source.userId } }
    }),
    tx.memoryRecallChunk.findMany({
      orderBy: [{ chunkOrdinal: "asc" }, { id: "asc" }],
      where: {
        chatId: source.id,
        chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
        sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
        state: { in: ["ACTIVE", "SUPPRESSED"] },
        userId: source.userId
      }
    }),
    tx.chatMemoryCheckpointMessage.findMany({
      orderBy: { ordinal: "asc" },
      select: { messageId: true, sourceMessageUpdatedAt: true },
      where: { chatId: source.id, userId: source.userId }
    })
  ]);
  const chunkIds = rows.map((row) => row.id);
  const joins = chunkIds.length === 0
    ? []
    : await tx.memoryRecallChunkMessage.findMany({
        orderBy: [{ chunkId: "asc" }, { ordinal: "asc" }],
        where: { chunkId: { in: chunkIds }, userId: source.userId }
      });
  const joinsByChunk = new Map<string, MemoryRecallChunkMessageJoin[]>();
  for (const join of joins) {
    const values = joinsByChunk.get(join.chunkId) ?? [];
    values.push({
      endOffset: join.endOffset ?? 0,
      messageId: join.messageId,
      ordinal: join.ordinal,
      role: join.role as "assistant" | "user",
      safeTextHash: join.safeTextHash,
      sourceMessageContentHash: join.sourceMessageContentHash,
      sourceMessageUpdatedAt: join.sourceMessageUpdatedAt.toISOString(),
      startOffset: join.startOffset ?? 0
    });
    joinsByChunk.set(join.chunkId, values);
  }
  return Object.freeze({
    checkpointPipelineVersion: checkpoint?.pipelineVersion ?? null,
    chunks: Object.freeze(rows.flatMap((row): CurrentChunkRow[] => {
      const messageJoins = joinsByChunk.get(row.id) ?? [];
      return messageJoins.length === 0 ? [] : [{ ...row, messageJoins }];
    })),
    messages: Object.freeze(messageRows.map((message) => ({
      messageId: message.messageId,
      sourceMessageUpdatedAt: message.sourceMessageUpdatedAt.toISOString()
    })))
  });
}

function chunkProjectionMatchesStored(
  stored: CurrentChunkRow,
  projected: MemoryHistoryPreparedChunk
): boolean {
  return stored.id === projected.id &&
    stored.chunkOrdinal === projected.ordinal &&
    stored.chunkingVersion === projected.chunkingVersion &&
    stored.contentHash === projected.contentHash &&
    stored.languageCode === projected.languageCode &&
    stored.normalizedSafeSearchText === projected.normalizedSafeSearchText &&
    stored.occurredFrom.toISOString() === projected.occurredFrom &&
    stored.occurredTo.toISOString() === projected.occurredTo &&
    stored.safeProjectedText === projected.safeProjectedText &&
    stored.sourceAssistantId === projected.sourceAssistantId &&
    stored.sourceFolderId === projected.folderId &&
    stored.sourceProjectionVersion === projected.sourceProjectionVersion;
}

async function prepareWith(
  tx: MemoryTransaction,
  job: MemoryJobDescriptor,
  now: Date
): Promise<MemoryHistoryPrepareResult> {
  const decision = await probeWith(tx, job);
  if (decision.status !== "READY") return { decision };
  if (!memoryHistoryIndexClaimIsValid(job)) {
    return {
      decision: {
        errorCode: "memory_history_job_invalid",
        status: "CANCELLED"
      }
    };
  }
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return { decision: staleDecision };

  const pathIds = source.messages.map((message) => message.id);
  const rows = await tx.message.findMany({
    select: {
      chatId: true,
      content: true,
      createdAt: true,
      id: true,
      parentMessageId: true,
      role: true,
      status: true,
      updatedAt: true
    },
    where: { chatId: source.id, id: { in: pathIds } }
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (pathIds.some((id) => !byId.has(id))) return { decision: staleDecision };

  const runs = await tx.modelRun.findMany({
    select: {
      assistantId: true,
      assistantMessageId: true,
      id: true,
      normalizedRequest: true,
      status: true,
      userMessageId: true
    },
    where: {
      assistantMessageId: { in: pathIds },
      chatId: source.id,
      userId: source.userId
    }
  });
  const runAssistantIds = runs.flatMap((run) => run.assistantId ? [run.assistantId] : []);
  const ownedAssistants = runAssistantIds.length === 0
    ? []
    : await tx.assistantDefinition.findMany({
        select: { id: true },
        where: {
          archivedAt: null,
          id: { in: runAssistantIds },
          ownerUserId: source.userId
        }
      });
  const ownedAssistantIds = new Set(ownedAssistants.map((assistant) => assistant.id));
  const runsByAssistantMessage = new Map<string, typeof runs>();
  for (const run of runs) {
    if (!run.assistantMessageId) continue;
    runsByAssistantMessage.set(run.assistantMessageId, [
      ...(runsByAssistantMessage.get(run.assistantMessageId) ?? []),
      run
    ]);
  }

  const messages: MemoryHistorySourceMessageInput[] = pathIds.map((id) => {
    const row = byId.get(id);
    if (!row) throw new MemoryCoordinatorError("memory_source_stale", false);
    const base = pathOrigin(row.role);
    if (row.role !== "assistant") {
      return {
        chatId: row.chatId,
        content: row.content,
        createdAt: row.createdAt,
        id: row.id,
        parentMessageId: row.parentMessageId,
        provenance: {
          assistantId: null,
          complete: true,
          influencedByMessageIds: [],
          modelRunId: null,
          origin: base.origin,
          taintSources: base.taintSources
        },
        role: row.role,
        status: row.status,
        updatedAt: row.updatedAt
      };
    }

    const candidates = runsByAssistantMessage.get(row.id) ?? [];
    const run = candidates.length === 1 ? candidates[0]! : null;
    // Runtime sources live outside the visible Message row. Their raw payloads
    // stay excluded at those dedicated boundaries; ordinary use must not taint
    // the settled assistant text that the user actually saw.
    const taintSources: readonly MemoryHistoryTaintSource[] =
      run?.assistantId && !ownedAssistantIds.has(run.assistantId)
        ? ["DEVELOPER"]
        : [];
    return {
      chatId: row.chatId,
      content: row.content,
      createdAt: row.createdAt,
      id: row.id,
      parentMessageId: row.parentMessageId,
      provenance: {
        assistantId: run?.assistantId && ownedAssistantIds.has(run.assistantId)
          ? run.assistantId
          : null,
        complete: run?.status === "complete" && candidates.length === 1,
        influencedByMessageIds: run ? [run.userMessageId] : [],
        modelRunId: run?.id ?? null,
        origin: "VISIBLE_ASSISTANT",
        taintSources
      },
      role: row.role,
      status: row.status,
      updatedAt: row.updatedAt
    };
  });

  const activeRunCandidates = runsByAssistantMessage.get(source.activeLeafMessageId) ?? [];
  const activeRun = activeRunCandidates.length === 1
    ? activeRunCandidates[0]!
    : null;
  const safeSnapshot = buildMemorySafeSourceSnapshot({
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    folderId: source.folderId,
    messages,
    mode: source.memoryMode,
    sourceContentHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    timeZone: runTimeZone(activeRun?.normalizedRequest ?? null),
    userId: source.userId
  });
  const admission = await loadHistoryAdmission(tx, source, now);
  const sourceIdentity: MemoryHistoryIndexSourceIdentity = {
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    sourceHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    userId: source.userId
  };
  const projectedChunks = chunkMemoryRecallProjection(safeSnapshot, undefined, {
    excludedMessageIds: admission.excludedMessageIds,
    sourceCreatedAtCutoff: admission.sourceCreatedAtCutoff
  }).map((chunk): MemoryHistoryPreparedChunk => ({
    ...chunk,
    id: memoryHistoryChunkId(sourceIdentity, chunk),
    publicationState: "ACTIVE"
  }));
  const checkpointMessages = source.messages.map((message, ordinal) => ({
    createdAt: message.createdAt.toISOString(),
    messageId: message.id,
    ordinal,
    sourceMessageUpdatedAt: message.updatedAt.toISOString()
  }));
  const previous = await loadIncrementalHistoryState(tx, source);
  const incremental = planMemoryHistoryIncrementalUpdate({
    currentMessages: checkpointMessages,
    nextChunks: projectedChunks,
    previousChunks: previous.checkpointPipelineVersion ===
        MEMORY_HISTORY_INDEX_PIPELINE_VERSION
      ? previous.chunks.map((chunk) => ({
          id: chunk.id,
          messageJoins: chunk.messageJoins,
          ordinal: chunk.chunkOrdinal
        }))
      : [],
    previousMessages: previous.checkpointPipelineVersion ===
        MEMORY_HISTORY_INDEX_PIPELINE_VERSION
      ? previous.messages
      : []
  });
  const storedById = new Map(previous.chunks.map((chunk) => [chunk.id, chunk]));
  const reusable = new Set(incremental.reusedChunkIds.filter((id) => {
    const projected = projectedChunks.find((chunk) => chunk.id === id);
    const stored = storedById.get(id);
    return Boolean(projected && stored && chunkProjectionMatchesStored(stored, projected));
  }));
  const chunks = projectedChunks.map((chunk): MemoryHistoryPreparedChunk => {
    const stored = reusable.has(chunk.id) ? storedById.get(chunk.id) : null;
    return stored
      ? {
          ...chunk,
          publicationState: stored.state === "SUPPRESSED" ? "SUPPRESSED" : "ACTIVE",
          redactionReasonCodes: [...stored.redactionReasonCodes],
          redactionState: stored.redactionState,
          safetyClass: stored.safetyClass
        }
      : chunk;
  });
  const reusedChunkIds = chunks.flatMap((chunk) =>
    reusable.has(chunk.id) ? [chunk.id] : []);
  const rebuiltChunkIds = chunks.flatMap((chunk) =>
    reusable.has(chunk.id) ? [] : [chunk.id]);
  const incrementalSnapshot = {
    commonPathMessageCount: incremental.commonPathMessageCount,
    mode: incremental.mode,
    rebuildFromMessageOrdinal: incremental.rebuildFromMessageOrdinal
  } as const;
  const resultHash = memoryHistoryIndexResultHash(
    sourceIdentity,
    chunks,
    admission.suppressionIdentitySnapshot,
    null,
    {
      checkpointMessages,
      digest: null,
      digestPolicyVersion: null,
      incremental: incrementalSnapshot,
      rebuiltChunkIds,
      reusedChunkIds
    }
  );
  return {
    plan: {
      classificationPolicyVersion: null,
      checkpointMessages,
      chunks,
      digest: null,
      digestPolicyVersion: null,
      incremental: incrementalSnapshot,
      preparedResultHash: resultHash,
      rebuiltChunkIds,
      resultHash,
      reusedChunkIds,
      source: sourceIdentity,
      suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot
    }
  };
}

function expectedSearchEntry(
  plan: MemoryHistoryIndexPlan,
  chunk: MemoryHistoryPreparedChunk
): ExpectedSearchEntry {
  return {
    languageCode: chunk.languageCode,
    safeContentHash: chunk.contentHash,
    normalizedSearchText: normalizeMemorySearchText(chunk.safeProjectedText),
    safetyIdentitySnapshot: memorySha256({
      classificationPolicyVersion: plan.classificationPolicyVersion,
      projectionVersion: chunk.sourceProjectionVersion,
      redactionReasonCodes: chunk.redactionReasonCodes,
      redactionState: chunk.redactionState,
      safetyClass: chunk.safetyClass
    }),
    sourceIdentitySnapshot: memorySha256({
      chatId: chunk.chatId,
      contentHash: chunk.contentHash,
      messageJoins: chunk.messageJoins,
      sourceProjectionVersion: chunk.sourceProjectionVersion,
      userId: chunk.userId
    }),
    suppressionIdentitySnapshot: plan.suppressionIdentitySnapshot
  };
}

function chunkMatches(left: CurrentChunkRow, right: MemoryHistoryPreparedChunk): boolean {
  return left.id === right.id &&
    left.chunkOrdinal === right.ordinal &&
    left.chunkingVersion === right.chunkingVersion &&
    left.contentHash === right.contentHash &&
    left.languageCode === right.languageCode &&
    left.normalizedSafeSearchText === right.normalizedSafeSearchText &&
    left.occurredFrom.toISOString() === right.occurredFrom &&
    left.occurredTo.toISOString() === right.occurredTo &&
    JSON.stringify(left.redactionReasonCodes) === JSON.stringify(right.redactionReasonCodes) &&
    left.redactionState === right.redactionState &&
    left.safeProjectedText === right.safeProjectedText &&
    left.safetyClass === right.safetyClass &&
    left.sourceAssistantId === right.sourceAssistantId &&
    left.sourceFolderId === right.folderId &&
    left.sourceProjectionVersion === right.sourceProjectionVersion &&
    left.state === right.publicationState;
}

function embeddingStateMatchesIndex(
  indexMode: MemoryActiveIndex["indexMode"],
  state: MemoryEmbeddingState
): boolean {
  return indexMode === "LEXICAL_ONLY"
    ? state === "NOT_APPLICABLE"
    : state === "PENDING" || state === "READY" || state === "FAILED";
}

async function planAlreadyApplied(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  plan: MemoryHistoryIndexPlan
): Promise<boolean> {
  const checkpoint = await tx.chatMemoryCheckpoint.findUnique({
    where: {
      userId_chatId: {
        chatId: plan.source.chatId,
        userId: plan.source.userId
      }
    }
  });
  if (
    !checkpoint ||
    checkpoint.status !== "READY" ||
    checkpoint.pipelineVersion !== MEMORY_HISTORY_INDEX_PIPELINE_VERSION ||
    checkpoint.activeLeafMessageId !== plan.source.activeLeafMessageId ||
    checkpoint.branchGeneration !== plan.source.branchGeneration ||
    checkpoint.sourceContentHash !== plan.source.sourceHash ||
    checkpoint.sourceRevision !== plan.source.sourceRevision ||
    checkpoint.lastIndexedMessageId !== plan.source.activeLeafMessageId
  ) return false;

  const checkpointMessages = await tx.chatMemoryCheckpointMessage.findMany({
    orderBy: { ordinal: "asc" },
    where: { chatId: plan.source.chatId, userId: plan.source.userId }
  });
  if (
    checkpointMessages.length !== plan.checkpointMessages.length ||
    plan.checkpointMessages.some((expected, index) => {
      const current = checkpointMessages[index];
      return !current || current.messageId !== expected.messageId ||
        current.ordinal !== expected.ordinal ||
        current.sourceMessageCreatedAt.toISOString() !== expected.createdAt ||
        current.sourceMessageUpdatedAt.toISOString() !== expected.sourceMessageUpdatedAt;
    })
  ) return false;

  const chunkRows = await tx.memoryRecallChunk.findMany({
    where: {
      chatId: plan.source.chatId,
      chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
      sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
      state: { in: ["ACTIVE", "SUPPRESSED"] },
      userId: plan.source.userId
    }
  });
  const chunkIds = plan.chunks.map((chunk) => chunk.id);
  const joins = chunkIds.length === 0 ? [] :
    await tx.memoryRecallChunkMessage.findMany({
      orderBy: [{ chunkId: "asc" }, { ordinal: "asc" }],
      where: { chunkId: { in: chunkIds }, userId: plan.source.userId }
    });
  const joinsByChunk = new Map<string, MemoryRecallChunkMessageJoin[]>();
  for (const join of joins) {
    const current = joinsByChunk.get(join.chunkId) ?? [];
    current.push({
      endOffset: join.endOffset ?? 0,
      messageId: join.messageId,
      ordinal: join.ordinal,
      role: join.role as "assistant" | "user",
      safeTextHash: join.safeTextHash,
      sourceMessageContentHash: join.sourceMessageContentHash,
      sourceMessageUpdatedAt: join.sourceMessageUpdatedAt.toISOString(),
      startOffset: join.startOffset ?? 0
    });
    joinsByChunk.set(join.chunkId, current);
  }
  const chunks: CurrentChunkRow[] = chunkRows.map((chunk) => ({
    ...chunk,
    messageJoins: joinsByChunk.get(chunk.id) ?? []
  }));
  if (
    chunks.length !== plan.chunks.length ||
    plan.chunks.some((chunk) => {
      const current = chunks.find((candidate) => candidate.id === chunk.id);
      return !current || !chunkMatches(current, chunk) ||
        current.messageJoins.length !== chunk.messageJoins.length ||
        chunk.messageJoins.some((expected, index) =>
          JSON.stringify(expected) !== JSON.stringify(current.messageJoins[index]));
    })
  ) return false;

  const activePlanChunks = plan.chunks.filter((chunk) =>
    chunk.publicationState === "ACTIVE");
  if (activePlanChunks.length > 0) {
    const activeIndex = await requireActiveMemoryIndex(tx, settings);
    if (!activeIndex) return false;
    const entries = await tx.memorySearchEntry.findMany({
      where: {
        indexGenerationId: activeIndex.id,
        itemType: "RECALL_CHUNK",
        recallChunkId: { in: activePlanChunks.map((chunk) => chunk.id) },
        userId: plan.source.userId
      }
    });
    if (entries.length !== activePlanChunks.length ||
      activePlanChunks.some((chunk) => {
        const entry = entries.find((candidate) => candidate.recallChunkId === chunk.id);
        const expected = expectedSearchEntry(plan, chunk);
        return !entry ||
          !embeddingStateMatchesIndex(activeIndex.indexMode, entry.embeddingState) ||
          entry.languageCode !== expected.languageCode ||
          entry.safeContentHash !== expected.safeContentHash ||
          entry.normalizedSearchText !== expected.normalizedSearchText ||
          entry.safetyIdentitySnapshot !== expected.safetyIdentitySnapshot ||
          entry.sourceIdentitySnapshot !== expected.sourceIdentitySnapshot ||
          entry.suppressionIdentitySnapshot !== expected.suppressionIdentitySnapshot;
      })) return false;
  }
  const activeDigest = await tx.chatMemoryDigest.findFirst({
    where: { chatId: plan.source.chatId, state: "ACTIVE", userId: plan.source.userId }
  });
  if (plan.digest === null) return activeDigest === null;
  if (!activeDigest || activeDigest.id !== plan.digest.id ||
    activeDigest.contentHash !== plan.digest.contentHash ||
    activeDigest.safeDigestText !== plan.digest.safeDigestText ||
    activeDigest.sourceContentHash !== plan.source.sourceHash ||
    activeDigest.activeLeafMessageId !== plan.source.activeLeafMessageId) return false;
  const [digestChunks, digestMessages] = await Promise.all([
    tx.chatMemoryDigestChunk.findMany({
      orderBy: { ordinal: "asc" }, where: { digestId: plan.digest.id }
    }),
    tx.chatMemoryDigestMessage.findMany({
      orderBy: { ordinal: "asc" }, where: { digestId: plan.digest.id }
    })
  ]);
  return digestChunks.map(({ chunkId }) => chunkId).join("\u0000") ===
      plan.digest.sourceChunkIds.join("\u0000") &&
    digestMessages.map(({ messageId }) => messageId).join("\u0000") ===
      plan.digest.sourceMessageIds.join("\u0000");
}

async function persistChunk(
  tx: MemoryTransaction,
  activeIndex: MemoryActiveIndex | null,
  plan: MemoryHistoryIndexPlan,
  chunk: MemoryHistoryPreparedChunk
): Promise<Readonly<{ embeddingState: MemoryEmbeddingState; id: string }> | null> {
  await tx.memoryRecallChunk.upsert({
    create: {
      branchGeneration: chunk.branchGeneration,
      chatId: chunk.chatId,
      chunkOrdinal: chunk.ordinal,
      chunkingVersion: chunk.chunkingVersion,
      contentHash: chunk.contentHash,
      id: chunk.id,
      languageCode: chunk.languageCode,
      normalizedSafeSearchText: chunk.normalizedSafeSearchText,
      occurredFrom: new Date(chunk.occurredFrom),
      occurredTo: new Date(chunk.occurredTo),
      redactionReasonCodes: [...chunk.redactionReasonCodes],
      redactionState: chunk.redactionState,
      safeProjectedText: chunk.safeProjectedText,
      safetyClass: chunk.safetyClass,
      sourceAssistantId: chunk.sourceAssistantId,
      sourceFolderId: chunk.folderId,
      sourceProjectionVersion: chunk.sourceProjectionVersion,
      sourceRevisionAtCreation: chunk.sourceRevision,
      state: chunk.publicationState,
      userId: chunk.userId
    },
    update: {
      chunkOrdinal: chunk.ordinal,
      chunkingVersion: chunk.chunkingVersion,
      contentHash: chunk.contentHash,
      invalidatedAt: null,
      languageCode: chunk.languageCode,
      normalizedSafeSearchText: chunk.normalizedSafeSearchText,
      occurredFrom: new Date(chunk.occurredFrom),
      occurredTo: new Date(chunk.occurredTo),
      redactionReasonCodes: [...chunk.redactionReasonCodes],
      redactionState: chunk.redactionState,
      safeProjectedText: chunk.safeProjectedText,
      safetyClass: chunk.safetyClass,
      sourceAssistantId: chunk.sourceAssistantId,
      sourceFolderId: chunk.folderId,
      sourceProjectionVersion: chunk.sourceProjectionVersion,
      state: chunk.publicationState
    },
    where: { id: chunk.id }
  });
  await tx.memoryRecallChunkMessage.deleteMany({
    where: { chunkId: chunk.id, userId: chunk.userId }
  });
  await tx.memoryRecallChunkMessage.createMany({
    data: chunk.messageJoins.map((join) => ({
      chatId: chunk.chatId,
      chunkId: chunk.id,
      endOffset: join.endOffset,
      messageId: join.messageId,
      ordinal: join.ordinal,
      role: join.role,
      safeTextHash: join.safeTextHash,
      sourceMessageContentHash: join.sourceMessageContentHash,
      sourceMessageUpdatedAt: new Date(join.sourceMessageUpdatedAt),
      startOffset: join.startOffset,
      userId: chunk.userId
    }))
  });
  if (chunk.publicationState === "SUPPRESSED") {
    await tx.memorySearchEntry.deleteMany({
      where: { recallChunkId: chunk.id, userId: chunk.userId }
    });
    return null;
  }
  if (!activeIndex) {
    throw new MemoryCoordinatorError("memory_active_generation_invalid", false);
  }
  const existing = await tx.memorySearchEntry.findFirst({
    orderBy: { id: "asc" },
    where: {
      indexGenerationId: activeIndex.id,
      itemType: "RECALL_CHUNK",
      recallChunkId: chunk.id,
      userId: chunk.userId
    }
  });
  const expected = expectedSearchEntry(plan, chunk);
  if (existing) {
    await tx.memorySearchEntry.deleteMany({
      where: {
        id: { not: existing.id },
        indexGenerationId: activeIndex.id,
        recallChunkId: chunk.id,
        userId: chunk.userId
      }
    });
    return tx.memorySearchEntry.update({
      data: {
        languageCode: expected.languageCode,
        normalizedSearchText: expected.normalizedSearchText,
        safeContentHash: expected.safeContentHash,
        safetyIdentitySnapshot: expected.safetyIdentitySnapshot,
        sourceIdentitySnapshot: expected.sourceIdentitySnapshot,
        suppressionIdentitySnapshot: expected.suppressionIdentitySnapshot
      },
      select: { embeddingState: true, id: true },
      where: { id: existing.id }
    });
  }
  return tx.memorySearchEntry.create({
    data: {
      embeddingState: activeIndex.indexMode === "LEXICAL_ONLY"
        ? "NOT_APPLICABLE"
        : "PENDING",
      indexGenerationId: activeIndex.id,
      itemType: "RECALL_CHUNK",
      languageCode: expected.languageCode,
      recallChunkId: chunk.id,
      safeContentHash: expected.safeContentHash,
      normalizedSearchText: expected.normalizedSearchText,
      safetyIdentitySnapshot: expected.safetyIdentitySnapshot,
      sourceIdentitySnapshot: expected.sourceIdentitySnapshot,
      suppressionIdentitySnapshot: expected.suppressionIdentitySnapshot,
      userId: chunk.userId
    },
    select: { embeddingState: true, id: true }
  });
}

async function enqueueChunkEmbedding(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  entry: Readonly<{ embeddingState: MemoryEmbeddingState; id: string }>,
  triggerIdentity: string
): Promise<void> {
  if (entry.embeddingState !== "PENDING") return;
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
      entry.id,
      triggerIdentity
    ),
    kind: "EMBED_ITEMS",
    pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
  });
}

async function persistDigest(
  tx: MemoryTransaction,
  plan: MemoryHistoryIndexPlan,
  now: Date
): Promise<void> {
  const current = await tx.chatMemoryDigest.findMany({
    select: { id: true },
    where: {
      chatId: plan.source.chatId,
      state: "ACTIVE",
      userId: plan.source.userId
    }
  });
  const staleIds = current.flatMap(({ id }) =>
    id === plan.digest?.id ? [] : [id]);
  if (staleIds.length > 0) {
    await tx.chatMemoryDigest.updateMany({
      data: { invalidatedAt: now, state: "INVALIDATED" },
      where: { id: { in: staleIds }, userId: plan.source.userId }
    });
  }
  const digest = plan.digest;
  if (!digest) return;
  if (!plan.digestPolicyVersion) {
    throw new MemoryCoordinatorError("memory_chat_digest_invalid", false);
  }
  const anchor = plan.chunks.find((chunk) => chunk.id === digest.anchorChunkId);
  if (!anchor || anchor.publicationState !== "ACTIVE") {
    throw new MemoryCoordinatorError("memory_chat_digest_invalid", false);
  }
  await tx.chatMemoryDigest.upsert({
    create: {
      activeLeafMessageId: plan.source.activeLeafMessageId,
      anchorChunkId: digest.anchorChunkId,
      branchGeneration: plan.source.branchGeneration,
      chatId: plan.source.chatId,
      contentHash: digest.contentHash,
      decisions: [...digest.decisions],
      id: digest.id,
      languageCode: digest.languageCode,
      normalizedSafeSearchText: normalizeMemorySearchText(digest.safeDigestText),
      occurredFrom: new Date(digest.occurredFrom),
      occurredTo: new Date(digest.occurredTo),
      openLoops: [...digest.openLoops],
      pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
      redactionState: "NOT_NEEDED",
      safeDigestText: digest.safeDigestText,
      safetyClass: "NORMAL",
      safetyPolicyVersion: plan.digestPolicyVersion,
      sourceAssistantId: anchor.sourceAssistantId,
      sourceContentHash: plan.source.sourceHash,
      sourceFolderId: anchor.folderId,
      sourceProjectionVersion: anchor.sourceProjectionVersion,
      sourceRevisionAtCreation: plan.source.sourceRevision,
      state: "ACTIVE",
      summary: digest.summary,
      topics: [...digest.topics],
      userId: plan.source.userId
    },
    update: {
      activeLeafMessageId: plan.source.activeLeafMessageId,
      anchorChunkId: digest.anchorChunkId,
      branchGeneration: plan.source.branchGeneration,
      contentHash: digest.contentHash,
      decisions: [...digest.decisions],
      invalidatedAt: null,
      languageCode: digest.languageCode,
      normalizedSafeSearchText: normalizeMemorySearchText(digest.safeDigestText),
      occurredFrom: new Date(digest.occurredFrom),
      occurredTo: new Date(digest.occurredTo),
      openLoops: [...digest.openLoops],
      redactionState: "NOT_NEEDED",
      safeDigestText: digest.safeDigestText,
      safetyClass: "NORMAL",
      safetyPolicyVersion: plan.digestPolicyVersion,
      sourceAssistantId: anchor.sourceAssistantId,
      sourceContentHash: plan.source.sourceHash,
      sourceFolderId: anchor.folderId,
      sourceRevisionAtCreation: plan.source.sourceRevision,
      state: "ACTIVE",
      summary: digest.summary,
      topics: [...digest.topics]
    },
    where: { id: digest.id }
  });
  await Promise.all([
    tx.chatMemoryDigestChunk.deleteMany({ where: { digestId: digest.id } }),
    tx.chatMemoryDigestMessage.deleteMany({ where: { digestId: digest.id } })
  ]);
  await tx.chatMemoryDigestChunk.createMany({
    data: digest.sourceChunkIds.map((chunkId, ordinal) => ({
      chatId: plan.source.chatId,
      chunkId,
      digestId: digest.id,
      ordinal,
      userId: plan.source.userId
    }))
  });
  const messageIdentities = new Map(plan.chunks.flatMap((chunk) =>
    chunk.messageJoins.map((join) => [join.messageId, join] as const)));
  await tx.chatMemoryDigestMessage.createMany({
    data: digest.sourceMessageIds.map((messageId, ordinal) => {
      const identity = messageIdentities.get(messageId);
      if (!identity) {
        throw new MemoryCoordinatorError("memory_chat_digest_invalid", false);
      }
      return {
        chatId: plan.source.chatId,
        digestId: digest.id,
        messageId,
        ordinal,
        sourceMessageContentHash: identity.sourceMessageContentHash,
        sourceMessageUpdatedAt: new Date(identity.sourceMessageUpdatedAt),
        userId: plan.source.userId
      };
    })
  });
}

async function applyPlan(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  plan: MemoryHistoryIndexPlan,
  now: Date
): Promise<void> {
  if (
    !memoryHistoryIndexClaimIsValid(claim) ||
    plan.classificationPolicyVersion === null ||
    plan.source.activeLeafMessageId !== claim.activeLeafMessageId ||
    plan.source.branchGeneration !== claim.branchGeneration ||
    plan.source.chatId !== claim.chatId ||
    plan.source.sourceHash !== claim.sourceHash ||
    plan.source.sourceRevision !== claim.sourceRevision ||
    plan.source.userId !== claim.userId ||
    plan.digestPolicyVersion === null ||
    memoryHistoryIndexResultHash(
      plan.source,
      plan.chunks,
      plan.suppressionIdentitySnapshot,
      plan.classificationPolicyVersion,
      {
        checkpointMessages: plan.checkpointMessages,
        digest: plan.digest,
        digestPolicyVersion: plan.digestPolicyVersion,
        incremental: plan.incremental,
        rebuiltChunkIds: plan.rebuiltChunkIds,
        reusedChunkIds: plan.reusedChunkIds
      }
    ) !== plan.resultHash
  ) {
    throw new MemoryCoordinatorError("memory_history_plan_invalid", false);
  }
  const settings = await lockMemorySettings(tx, claim.userId, false);
  if (!settings.referenceChatHistory) return;
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: claim.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: claim.userId
  });
  if (
    settings.memoryGeneration !== claim.memoryGenerationSnapshot ||
    !sourceMatchesJob(source, claim)
  ) {
    throw new MemoryCoordinatorError("memory_source_stale", false);
  }
  // A retried coordinator commit may replay the exact accepted plan after its
  // first transaction committed. Check that durable state before regenerating
  // a raw incremental plan, whose APPEND/FULL_REBUILD mode correctly changes
  // to UNCHANGED once the checkpoint has advanced.
  if (await planAlreadyApplied(tx, settings, plan)) {
    const pendingEntries = await tx.memorySearchEntry.findMany({
      select: { embeddingState: true, id: true },
      where: {
        embeddingState: "PENDING",
        indexGenerationId: settings.activeIndexGenerationId!,
        itemType: "RECALL_CHUNK",
        recallChunkId: {
          in: plan.chunks.flatMap((chunk) =>
            chunk.publicationState === "ACTIVE" ? [chunk.id] : [])
        },
        userId: plan.source.userId
      }
    });
    for (const entry of pendingEntries) {
      await enqueueChunkEmbedding(tx, settings, entry, plan.resultHash);
    }
    return;
  }
  const currentPrepared = await prepareWith(tx, claim, now);
  if (
    "decision" in currentPrepared ||
    currentPrepared.plan.resultHash !== plan.preparedResultHash
  ) {
    throw new MemoryCoordinatorError("memory_history_plan_stale", true);
  }
  const currentChunks = await tx.memoryRecallChunk.findMany({
    select: { id: true, state: true },
    where: {
      chatId: claim.chatId,
      state: { in: ["ACTIVE", "SUPPRESSED"] },
      userId: claim.userId
    }
  });
  const currentDigest = await tx.chatMemoryDigest.findFirst({
    select: { contentHash: true, id: true },
    where: { chatId: claim.chatId, state: "ACTIVE", userId: claim.userId }
  });
  const currentVisible = currentChunks.flatMap((chunk) =>
    chunk.state === "ACTIVE" ? [chunk.id] : []).sort();
  const nextVisible = plan.chunks.flatMap((chunk) =>
    chunk.publicationState === "ACTIVE" ? [chunk.id] : []).sort();
  const visibilityChanged = currentVisible.join("\u0000") !== nextVisible.join("\u0000") ||
    (currentDigest?.id ?? null) !== (plan.digest?.id ?? null) ||
    (currentDigest?.contentHash ?? null) !== (plan.digest?.contentHash ?? null);
  let activeIndex: MemoryActiveIndex | null = null;
  if (visibilityChanged) {
    await advanceMemoryMutation(tx, settings, "CHUNK_VISIBILITY_CHANGE");
  }
  if (nextVisible.length > 0) {
    activeIndex = await requireActiveMemoryIndex(tx, settings);
    if (!activeIndex) {
      throw new MemoryCoordinatorError("memory_active_generation_invalid", false);
    }
  }
  const desiredIds = new Set(plan.chunks.map((chunk) => chunk.id));
  const staleIds = currentChunks.flatMap((chunk) =>
    desiredIds.has(chunk.id) ? [] : [chunk.id]);
  if (staleIds.length > 0) {
    await tx.memorySearchEntry.deleteMany({
      where: { recallChunkId: { in: staleIds }, userId: claim.userId }
    });
    await tx.memoryRecallChunk.updateMany({
      data: { invalidatedAt: now, state: "INVALIDATED" },
      where: {
        id: { in: staleIds },
        state: { in: ["ACTIVE", "SUPPRESSED"] },
        userId: claim.userId
      }
    });
  }
  const retainedEntries = plan.chunks.length === 0
    ? []
    : await tx.memorySearchEntry.findMany({
        where: {
          itemType: "RECALL_CHUNK",
          recallChunkId: { in: plan.chunks.map((chunk) => chunk.id) },
          userId: claim.userId
        }
      });
  const rebuilt = new Set(plan.rebuiltChunkIds);
  for (const chunk of plan.chunks) {
    const expected = expectedSearchEntry(plan, chunk);
    const retainedEntry = activeIndex
      ? retainedEntries.find((entry) =>
          entry.indexGenerationId === activeIndex.id &&
          entry.recallChunkId === chunk.id)
      : null;
    const searchArtifactNeedsRepair = chunk.publicationState === "SUPPRESSED"
      ? retainedEntries.some((entry) => entry.recallChunkId === chunk.id)
      : !retainedEntry ||
        !embeddingStateMatchesIndex(activeIndex!.indexMode, retainedEntry.embeddingState) ||
        retainedEntry.languageCode !== expected.languageCode ||
        retainedEntry.safeContentHash !== expected.safeContentHash ||
        retainedEntry.normalizedSearchText !== expected.normalizedSearchText ||
        retainedEntry.safetyIdentitySnapshot !== expected.safetyIdentitySnapshot ||
        retainedEntry.sourceIdentitySnapshot !== expected.sourceIdentitySnapshot ||
        retainedEntry.suppressionIdentitySnapshot !== expected.suppressionIdentitySnapshot;
    if (!rebuilt.has(chunk.id) && !searchArtifactNeedsRepair) continue;
    const entry = await persistChunk(tx, activeIndex, plan, chunk);
    if (entry) {
      await enqueueChunkEmbedding(tx, settings, entry, plan.resultHash);
    }
  }
  await persistDigest(tx, plan, now);
  await tx.chatMemoryCheckpoint.upsert({
    create: {
      activeLeafMessageId: plan.source.activeLeafMessageId,
      branchGeneration: plan.source.branchGeneration,
      chatId: plan.source.chatId,
      lastIndexedMessageId: plan.source.activeLeafMessageId,
      lastSucceededAt: now,
      pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
      sourceContentHash: plan.source.sourceHash,
      sourceRevision: plan.source.sourceRevision,
      status: "READY",
      userId: plan.source.userId
    },
    update: {
      activeLeafMessageId: plan.source.activeLeafMessageId,
      branchGeneration: plan.source.branchGeneration,
      lastErrorCode: null,
      lastIndexedMessageId: plan.source.activeLeafMessageId,
      lastSucceededAt: now,
      pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
      sourceContentHash: plan.source.sourceHash,
      sourceRevision: plan.source.sourceRevision,
      status: "READY"
    },
    where: {
      userId_chatId: {
        chatId: plan.source.chatId,
        userId: plan.source.userId
      }
    }
  });
  await tx.chatMemoryCheckpointMessage.deleteMany({
    where: { chatId: plan.source.chatId, userId: plan.source.userId }
  });
  if (plan.checkpointMessages.length > 0) {
    await tx.chatMemoryCheckpointMessage.createMany({
      data: plan.checkpointMessages.map((message) => ({
        chatId: plan.source.chatId,
        messageId: message.messageId,
        ordinal: message.ordinal,
        sourceMessageCreatedAt: new Date(message.createdAt),
        sourceMessageUpdatedAt: new Date(message.sourceMessageUpdatedAt),
        userId: plan.source.userId
      }))
    });
  }
}

export function createPrismaMemoryHistoryIndexRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    apply: applyPlan,
    async preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      return client.$transaction((tx) => probeWith(tx, job), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },
    async prepare(job: MemoryJobDescriptor): Promise<MemoryHistoryPrepareResult> {
      return client.$transaction((tx) => prepareWith(tx, job, new Date()), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    }
  });
}

export type MemoryHistoryIndexRepository = ReturnType<
  typeof createPrismaMemoryHistoryIndexRepository
>;

export type { MemoryHistoryPrepareResult };
