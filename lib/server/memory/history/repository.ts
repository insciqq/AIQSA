import {
  Prisma,
  type MemoryEmbeddingState,
  type MemoryHistoryItemState,
  type PrismaClient
} from "@prisma/client";
import { estimateApproxTokens } from "../../../domain/contextBudget";
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
  lockMemorySourceChat,
  type LockedMemorySourceChat,
  type MemorySourceSnapshot
} from "../sourceState";
import {
  chunkMemoryRecallProjection,
  DEFAULT_MEMORY_HISTORY_CHUNKING_OPTIONS,
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
import {
  MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES,
  planMemoryHistoryTailUpdate
} from "./incremental";
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

type HistoryPathMessageMetadata = Readonly<{
  createdAt: Date;
  cycle: boolean;
  depth: number;
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  updatedAt: Date;
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
  source: LockedMemorySourceChat | null,
  job: MemoryJobDescriptor
): source is LockedMemorySourceChat & Readonly<{ activeLeafMessageId: string }> {
  return Boolean(
    source &&
    source.memoryMode === "NORMAL" &&
    source.activeLeafMessageId !== null &&
    source.activeLeafMessageId === job.activeLeafMessageId &&
    source.id === job.chatId &&
    source.memoryBranchGeneration === job.branchGeneration &&
    source.memorySourceRevision === job.sourceRevision &&
    source.userId === job.userId
  );
}

async function loadHistoryPathMetadata(
  tx: MemoryTransaction,
  chatId: string,
  activeLeafMessageId: string
): Promise<readonly HistoryPathMessageMetadata[]> {
  const rows = await tx.$queryRaw<HistoryPathMessageMetadata[]>(Prisma.sql`
    WITH RECURSIVE active_path AS (
      SELECT
        message."id", message."parentMessageId", message."role",
        message."status"::text AS "status", message."createdAt",
        message."updatedAt", 0 AS "depth",
        ARRAY[message."id"]::text[] AS visited, FALSE AS cycle
      FROM "Message" AS message
      WHERE message."chatId" = ${chatId}
        AND message."id" = ${activeLeafMessageId}

      UNION ALL

      SELECT
        parent."id", parent."parentMessageId", parent."role",
        parent."status"::text AS "status", parent."createdAt",
        parent."updatedAt", child."depth" + 1,
        child.visited || parent."id",
        parent."id" = ANY(child.visited)
      FROM active_path AS child
      INNER JOIN "Message" AS parent
        ON parent."chatId" = ${chatId}
       AND parent."id" = child."parentMessageId"
      WHERE NOT child.cycle
        AND child."depth" < ${MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES}
    )
    SELECT
      "id", "parentMessageId", "role", "status", "createdAt", "updatedAt",
      "depth", cycle
    FROM active_path
    ORDER BY "depth" DESC
  `);
  if (
    rows.length === 0 ||
    rows.length > MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES ||
    rows.some((row) => row.cycle) ||
    rows[0]?.parentMessageId !== null ||
    rows.at(-1)?.id !== activeLeafMessageId ||
    rows.some((row, index) =>
      index > 0 && row.parentMessageId !== rows[index - 1]?.id)
  ) {
    throw new MemoryCoordinatorError("memory_source_path_invalid", false);
  }
  return Object.freeze(rows);
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
  const source = await lockMemorySourceChat(tx, {
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

function storedChunkProjection(
  row: CurrentChunkRow,
  source: MemorySourceSnapshot,
  ordinal: number
): MemoryHistoryPreparedChunk {
  return {
    approxTokens: estimateApproxTokens(row.safeProjectedText),
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
    contentHash: row.contentHash,
    folderId: source.folderId,
    id: row.id,
    languageCode: row.languageCode as MemoryHistoryPreparedChunk["languageCode"],
    messageJoins: row.messageJoins,
    normalizedSafeSearchText: row.normalizedSafeSearchText,
    occurredFrom: row.occurredFrom.toISOString(),
    occurredTo: row.occurredTo.toISOString(),
    ordinal,
    overlapFromPreviousTurnGroupIds: [],
    providerSafeText: row.safeProjectedText,
    publicationState: row.state === "SUPPRESSED" ? "SUPPRESSED" : "ACTIVE",
    redactionReasonCodes: Object.freeze([...row.redactionReasonCodes]),
    redactionState: row.redactionState,
    safeProjectedText: row.safeProjectedText,
    safetyClass: row.safetyClass,
    sourceAssistantId: row.sourceAssistantId,
    sourceContentHash: source.sourceHash,
    sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    sourceRevision: source.memorySourceRevision,
    turnGroupIds: [],
    userId: source.userId
  };
}

function alignHistoryTailStart(
  path: readonly HistoryPathMessageMetadata[],
  requested: number
): number {
  let start = Math.max(0, Math.min(requested, path.length));
  // A projected recall unit starts with the user message. A one-row rewind is
  // still bounded and prevents a suffix from starting on its assistant.
  if (
    start > 0 &&
    path[start]?.role === "assistant" &&
    path[start - 1]?.role === "user"
  ) {
    start -= 1;
  }
  return start;
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
  const chat = await lockMemorySourceChat(tx, {
    chatId: job.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: job.userId
  });
  if (!sourceMatchesJob(chat, job)) return { decision: staleDecision };
  const path = await loadHistoryPathMetadata(tx, chat.id, chat.activeLeafMessageId);
  const source: MemorySourceSnapshot & Readonly<{ activeLeafMessageId: string }> = {
    ...chat,
    activeLeafMessageId: chat.activeLeafMessageId,
    messages: path.map(({ createdAt, id, updatedAt }) => ({
      createdAt,
      id,
      updatedAt
    })),
    sourceHash: job.sourceHash
  };
  const checkpointMessages = path.map((message, ordinal) => ({
    createdAt: message.createdAt.toISOString(),
    messageId: message.id,
    ordinal,
    sourceMessageUpdatedAt: message.updatedAt.toISOString()
  }));
  const [admission, previous] = await Promise.all([
    loadHistoryAdmission(tx, source, now),
    loadIncrementalHistoryState(tx, source)
  ]);
  const previousIsCurrent = previous.checkpointPipelineVersion ===
    MEMORY_HISTORY_INDEX_PIPELINE_VERSION;
  let incremental = planMemoryHistoryTailUpdate({
    currentMessages: checkpointMessages,
    previousChunks: previousIsCurrent
      ? previous.chunks.map((chunk) => ({
          id: chunk.id,
          messageJoins: chunk.messageJoins,
          ordinal: chunk.chunkOrdinal
        }))
      : [],
    previousMessages: previousIsCurrent ? previous.messages : []
  });
  const excluded = new Set(admission.excludedMessageIds);
  const cutoff = admission.sourceCreatedAtCutoff
    ? new Date(admission.sourceCreatedAtCutoff)
    : null;
  const pathById = new Map(path.map((message) => [message.id, message]));
  const reusableIds = new Set(incremental.reusedChunkIds);
  const reusableRows = previous.chunks.filter((chunk) =>
    reusableIds.has(chunk.id) &&
    chunk.messageJoins.every((join) => {
      const message = pathById.get(join.messageId);
      return Boolean(
        message &&
        !excluded.has(join.messageId) &&
        (cutoff === null || message.createdAt > cutoff)
      );
    }));
  // Admission drift can affect an arbitrary earlier segment. It is rare and
  // cannot use an append proof, so fail closed to the bounded full-rebuild lane.
  if (reusableRows.length !== reusableIds.size) {
    incremental = {
      commonPathMessageCount: incremental.commonPathMessageCount,
      mode: "FULL_REBUILD",
      rebuildFromMessageOrdinal: 0,
      reusedChunkIds: []
    };
  }
  const retainedRows = incremental.mode === "FULL_REBUILD"
    ? []
    : reusableRows;
  const retained = retainedRows.map((row, ordinal) =>
    storedChunkProjection(row, source, ordinal));
  const requestedTailStart = incremental.mode === "UNCHANGED"
    ? path.length
    : incremental.rebuildFromMessageOrdinal;
  const tailStart = alignHistoryTailStart(path, requestedTailStart);
  const tailPath = path.slice(tailStart);
  const tailIds = tailPath.map((message) => message.id);
  const rows = tailIds.length === 0 ? [] : await tx.message.findMany({
    select: {
      content: true,
      id: true
    },
    where: { chatId: source.id, id: { in: tailIds } }
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (tailIds.some((id) => !byId.has(id))) return { decision: staleDecision };

  const runs = tailIds.length === 0 ? [] : await tx.modelRun.findMany({
    select: {
      assistantId: true,
      assistantMessageId: true,
      id: true,
      normalizedRequest: true,
      status: true,
      userMessageId: true
    },
    where: {
      assistantMessageId: { in: tailIds },
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

  const messages: MemoryHistorySourceMessageInput[] = tailPath.map((metadata, ordinal) => {
    const contentRow = byId.get(metadata.id);
    if (!contentRow) throw new MemoryCoordinatorError("memory_source_stale", false);
    const base = pathOrigin(metadata.role);
    const parentMessageId = ordinal === 0 ? null : metadata.parentMessageId;
    if (metadata.role !== "assistant") {
      return {
        chatId: source.id,
        content: contentRow.content,
        createdAt: metadata.createdAt,
        id: metadata.id,
        parentMessageId,
        provenance: {
          assistantId: null,
          complete: true,
          influencedByMessageIds: [],
          modelRunId: null,
          origin: base.origin,
          taintSources: base.taintSources
        },
        role: metadata.role,
        status: metadata.status,
        updatedAt: metadata.updatedAt
      };
    }

    const candidates = runsByAssistantMessage.get(metadata.id) ?? [];
    const run = candidates.length === 1 ? candidates[0]! : null;
    // Runtime sources live outside the visible Message row. Their raw payloads
    // stay excluded at those dedicated boundaries; ordinary use must not taint
    // the settled assistant text that the user actually saw.
    const taintSources: readonly MemoryHistoryTaintSource[] =
      run?.assistantId && !ownedAssistantIds.has(run.assistantId)
        ? ["DEVELOPER"]
        : [];
    return {
      chatId: source.id,
      content: contentRow.content,
      createdAt: metadata.createdAt,
      id: metadata.id,
      parentMessageId,
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
      role: metadata.role,
      status: metadata.status,
      updatedAt: metadata.updatedAt
    };
  });

  const activeRunCandidates = runsByAssistantMessage.get(source.activeLeafMessageId) ?? [];
  const activeRun = activeRunCandidates.length === 1
    ? activeRunCandidates[0]!
    : null;
  const sourceIdentity: MemoryHistoryIndexSourceIdentity = {
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    sourceHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    userId: source.userId
  };
  const projectedChunks = messages.length === 0
    ? []
    : chunkMemoryRecallProjection(buildMemorySafeSourceSnapshot({
        activeLeafMessageId: tailPath.at(-1)?.id ?? null,
        branchGeneration: source.memoryBranchGeneration,
        chatId: source.id,
        folderId: source.folderId,
        messages,
        mode: source.memoryMode,
        sourceContentHash: source.sourceHash,
        sourceRevision: source.memorySourceRevision,
        timeZone: runTimeZone(activeRun?.normalizedRequest ?? null),
        userId: source.userId
      }), undefined, {
        excludedMessageIds: admission.excludedMessageIds,
        sourceCreatedAtCutoff: admission.sourceCreatedAtCutoff
      }).map((chunk, ordinal): MemoryHistoryPreparedChunk => ({
        ...chunk,
        id: memoryHistoryChunkId(sourceIdentity, chunk),
        ordinal: retained.length + ordinal,
        publicationState: "ACTIVE"
      }));
  const retainedIds = new Set(retained.map((chunk) => chunk.id));
  const rebuilt = projectedChunks.filter((chunk) => !retainedIds.has(chunk.id));
  const chunks = [...retained, ...rebuilt];
  if (chunks.length > DEFAULT_MEMORY_HISTORY_CHUNKING_OPTIONS.maxChunks) {
    throw new MemoryCoordinatorError("memory_history_chunk_limit_exceeded", false);
  }
  const reusedChunkIds = retained.map((chunk) => chunk.id);
  const rebuiltChunkIds = rebuilt.map((chunk) => chunk.id);
  const incrementalSnapshot = {
    commonPathMessageCount: incremental.commonPathMessageCount,
    mode: incremental.mode,
    rebuildFromMessageOrdinal: tailStart
  } as const;
  const work = {
    chunksBuilt: projectedChunks.length,
    chunksReplaced: Math.max(0, previous.chunks.length - retained.length),
    chunksReused: retained.length,
    digestSegmentsProcessed: 0,
    digestSourceChunksProcessed: 0,
    messageContentRowsLoaded: rows.length,
    messagesProjected: messages.length,
    modelRunRowsLoaded: runs.length,
    pathMetadataRowsRead: path.length
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
      reusedChunkIds,
      work
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
      suppressionIdentitySnapshot: admission.suppressionIdentitySnapshot,
      work
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
    activeDigest.incrementalDepth !== plan.digest.incrementalDepth ||
    activeDigest.inputFingerprint !== plan.digest.inputFingerprint ||
    activeDigest.rebuildPolicyVersion !== plan.digest.rebuildPolicyVersion ||
    activeDigest.safeDigestText !== plan.digest.safeDigestText ||
    activeDigest.sourceFingerprint !== plan.digest.sourceFingerprint ||
    activeDigest.sourceContentHash !== plan.source.sourceHash ||
    activeDigest.activeLeafMessageId !== plan.source.activeLeafMessageId ||
    activeDigest.updateMode !== plan.digest.updateMode) return false;
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
      incrementalDepth: digest.incrementalDepth,
      inputFingerprint: digest.inputFingerprint,
      languageCode: digest.languageCode,
      normalizedSafeSearchText: normalizeMemorySearchText(digest.safeDigestText),
      occurredFrom: new Date(digest.occurredFrom),
      occurredTo: new Date(digest.occurredTo),
      openLoops: [...digest.openLoops],
      pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
      rebuildPolicyVersion: digest.rebuildPolicyVersion,
      redactionState: "NOT_NEEDED",
      safeDigestText: digest.safeDigestText,
      safetyClass: "NORMAL",
      safetyPolicyVersion: plan.digestPolicyVersion,
      sourceAssistantId: anchor.sourceAssistantId,
      sourceContentHash: plan.source.sourceHash,
      sourceFingerprint: digest.sourceFingerprint,
      sourceFolderId: anchor.folderId,
      sourceProjectionVersion: anchor.sourceProjectionVersion,
      sourceRevisionAtCreation: plan.source.sourceRevision,
      state: "ACTIVE",
      summary: digest.summary,
      topics: [...digest.topics],
      updateMode: digest.updateMode,
      userId: plan.source.userId
    },
    update: {
      activeLeafMessageId: plan.source.activeLeafMessageId,
      anchorChunkId: digest.anchorChunkId,
      branchGeneration: plan.source.branchGeneration,
      contentHash: digest.contentHash,
      decisions: [...digest.decisions],
      incrementalDepth: digest.incrementalDepth,
      inputFingerprint: digest.inputFingerprint,
      invalidatedAt: null,
      languageCode: digest.languageCode,
      normalizedSafeSearchText: normalizeMemorySearchText(digest.safeDigestText),
      occurredFrom: new Date(digest.occurredFrom),
      occurredTo: new Date(digest.occurredTo),
      openLoops: [...digest.openLoops],
      rebuildPolicyVersion: digest.rebuildPolicyVersion,
      redactionState: "NOT_NEEDED",
      safeDigestText: digest.safeDigestText,
      safetyClass: "NORMAL",
      safetyPolicyVersion: plan.digestPolicyVersion,
      sourceAssistantId: anchor.sourceAssistantId,
      sourceContentHash: plan.source.sourceHash,
      sourceFingerprint: digest.sourceFingerprint,
      sourceFolderId: anchor.folderId,
      sourceRevisionAtCreation: plan.source.sourceRevision,
      state: "ACTIVE",
      summary: digest.summary,
      topics: [...digest.topics],
      updateMode: digest.updateMode
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
        reusedChunkIds: plan.reusedChunkIds,
        work: plan.work
      }
    ) !== plan.resultHash
  ) {
    throw new MemoryCoordinatorError("memory_history_plan_invalid", false);
  }
  const settings = await lockMemorySettings(tx, claim.userId, false);
  if (!settings.referenceChatHistory) return;
  const source = await lockMemorySourceChat(tx, {
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
