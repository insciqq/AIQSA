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
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../persistence/lexical";
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
  chunkMemoryRecallProjection
} from "./chunking";
import {
  memoryHistoryChunkId,
  memoryHistoryIndexClaimIsValid,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan,
  type MemoryHistoryIndexSourceIdentity,
  type MemoryHistoryPreparedChunk
} from "./contract";
import {
  buildMemorySafeSourceSnapshot,
  type MemoryHistorySourceMessageInput,
  type MemoryHistorySourceOrigin,
  type MemoryHistoryTaintSource
} from "./sourceProjection";
import {
  MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
  memoryEpisodeExtractionJobFingerprint
} from "./episode/contract";

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
}>;

type ExpectedSearchEntry = Readonly<{
  languageCode: string;
  safeContentHash: string;
  safeSearchText: string;
  safeSearchTextYoNormalized: string;
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
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return staleDecision;
  const settings = await tx.userMemorySettings.findUnique({
    select: {
      memoryGeneration: true,
      referenceChatHistory: true
    },
    where: { userId: job.userId }
  });
  if (!settings || settings.memoryGeneration !== job.memoryGenerationSnapshot) {
    return staleDecision;
  }
  if (!settings.referenceChatHistory) return disabledDecision;
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
  const barriers = await tx.memorySourceBarrier.findMany({
    orderBy: [{ sourceCreatedAtCutoff: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      memoryGeneration: true,
      sourceCreatedAtCutoff: true
    },
    where: {
      kind: { in: ["ALL_REUSABLE", "HISTORY_INDEX"] },
      userId: source.userId
    }
  });
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
  const excludedMessageIds = excludesAll
    ? pathMessageIds
    : suppressions.flatMap((suppression) =>
        suppression.scope === "SOURCE_MESSAGE" && suppression.sourceMessageId
          ? [suppression.sourceMessageId]
          : []);
  const cutoff = barriers.at(-1)?.sourceCreatedAtCutoff ?? null;
  return {
    excludedMessageIds: [...new Set(excludedMessageIds)].sort(),
    sourceCreatedAtCutoff: cutoff?.toISOString() ?? null,
    suppressionIdentitySnapshot: memorySha256({
      barriers: barriers.map((barrier) => ({
        id: barrier.id,
        kind: barrier.kind,
        memoryGeneration: barrier.memoryGeneration,
        sourceCreatedAtCutoff: barrier.sourceCreatedAtCutoff
      })),
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
    userId: job.userId
  });
  if (!sourceMatchesJob(source, job)) return { decision: staleDecision };

  const pathIds = source.messages.map((message) => message.id);
  const rows = await tx.message.findMany({
    select: {
      chatId: true,
      content: true,
      createdAt: true,
      groundedAt: true,
      groundingProvider: true,
      groundingStrategy: true,
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
      _count: {
        select: {
          knowledgeRunBindings: true,
          knowledgeRuns: true,
          mcpRunBindings: true,
          searchRunBindings: true,
          searchRuns: true,
          toolCalls: true
        }
      },
      assistantId: true,
      assistantMessageId: true,
      id: true,
      normalizedRequest: true,
      status: true,
      toolLoopState: true,
      userMessageId: true
    },
    where: {
      assistantMessageId: { in: pathIds },
      chatId: source.id,
      userId: source.userId
    }
  });
  const runIds = runs.map((run) => run.id);
  const memoryBindings = runIds.length === 0
    ? []
    : await tx.modelRunMemoryBinding.findMany({
        select: { modelRunId: true },
        where: { modelRunId: { in: runIds }, userId: source.userId }
      });
  const memoryBoundRunIds = new Set(memoryBindings.map((binding) => binding.modelRunId));
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
  const attachments = pathIds.length === 0
    ? []
    : await tx.attachment.findMany({
        select: { messageId: true },
        where: { messageId: { in: pathIds }, userId: source.userId }
      });
  const attachmentMessageIds = new Set(attachments.flatMap((attachment) =>
    attachment.messageId ? [attachment.messageId] : []));
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
    const taint = new Set<MemoryHistoryTaintSource>();
    if (row.groundedAt || row.groundingProvider || row.groundingStrategy) {
      taint.add("SEARCH");
    }
    if (run) {
      if (
        run._count.knowledgeRunBindings > 0 ||
        run._count.knowledgeRuns > 0
      ) taint.add("KNOWLEDGE");
      if (run._count.searchRunBindings > 0 || run._count.searchRuns > 0) {
        taint.add("SEARCH");
      }
      if (
        run._count.mcpRunBindings > 0 ||
        run._count.toolCalls > 0 ||
        run.toolLoopState !== null
      ) taint.add("TOOL");
      if (attachmentMessageIds.has(run.userMessageId)) taint.add("ATTACHMENT");
      if (memoryBoundRunIds.has(run.id)) taint.add("PROVIDER_PAYLOAD");
      if (run.assistantId && !ownedAssistantIds.has(run.assistantId)) {
        taint.add("DEVELOPER");
      }
    }
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
        taintSources: [...taint].sort()
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
  const chunks = chunkMemoryRecallProjection(safeSnapshot, undefined, {
    excludedMessageIds: admission.excludedMessageIds,
    sourceCreatedAtCutoff: admission.sourceCreatedAtCutoff
  }).map((chunk): MemoryHistoryPreparedChunk => ({
    ...chunk,
    id: memoryHistoryChunkId(sourceIdentity, chunk)
  }));
  return {
    plan: {
      chunks,
      resultHash: memoryHistoryIndexResultHash(
        sourceIdentity,
        chunks,
        admission.suppressionIdentitySnapshot
      ),
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
    safeSearchText: normalizeMemorySearchText(chunk.safeProjectedText),
    safeSearchTextYoNormalized: normalizeMemorySearchTextYo(chunk.safeProjectedText),
    safetyIdentitySnapshot: memorySha256({
      policyVersion: chunk.sourceProjectionVersion,
      redactionReasonCodes: chunk.redactionReasonCodes,
      redactionState: chunk.redactionState,
      safetyClass: chunk.safetyClass
    }),
    sourceIdentitySnapshot: memorySha256({
      branchGeneration: chunk.branchGeneration,
      chatId: chunk.chatId,
      contentHash: chunk.contentHash,
      messageJoins: chunk.messageJoins,
      sourceHash: plan.source.sourceHash,
      sourceRevision: chunk.sourceRevision,
      userId: chunk.userId
    }),
    suppressionIdentitySnapshot: plan.suppressionIdentitySnapshot
  };
}

function chunkMatches(left: CurrentChunkRow, right: MemoryHistoryPreparedChunk): boolean {
  return left.id === right.id &&
    left.branchGeneration === right.branchGeneration &&
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
    left.sourceRevisionAtCreation === right.sourceRevision &&
    left.state === "ACTIVE";
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
    checkpoint.activeLeafMessageId !== plan.source.activeLeafMessageId ||
    checkpoint.branchGeneration !== plan.source.branchGeneration ||
    checkpoint.sourceContentHash !== plan.source.sourceHash ||
    checkpoint.sourceRevision !== plan.source.sourceRevision ||
    checkpoint.lastIndexedMessageId !== plan.source.activeLeafMessageId
  ) return false;

  const chunks = await tx.memoryRecallChunk.findMany({
    where: {
      chatId: plan.source.chatId,
      state: "ACTIVE",
      userId: plan.source.userId
    }
  });
  if (
    chunks.length !== plan.chunks.length ||
    plan.chunks.some((chunk) => {
      const current = chunks.find((candidate) => candidate.id === chunk.id);
      return !current || !chunkMatches(current, chunk);
    })
  ) return false;
  if (plan.chunks.length === 0) return true;

  const activeIndex = await requireActiveMemoryIndex(tx, settings);
  if (!activeIndex) return false;
  const chunkIds = plan.chunks.map((chunk) => chunk.id);
  const joins = await tx.memoryRecallChunkMessage.findMany({
    orderBy: [{ chunkId: "asc" }, { ordinal: "asc" }],
    where: { chunkId: { in: chunkIds }, userId: plan.source.userId }
  });
  const expectedJoins = plan.chunks.flatMap((chunk) =>
    chunk.messageJoins.map((join) => ({
      chatId: chunk.chatId,
      chunkId: chunk.id,
      endOffset: join.endOffset,
      messageId: join.messageId,
      ordinal: join.ordinal,
      role: join.role,
      startOffset: join.startOffset,
      userId: chunk.userId
    }))).sort((left, right) =>
      left.chunkId.localeCompare(right.chunkId) || left.ordinal - right.ordinal);
  if (
    joins.length !== expectedJoins.length ||
    expectedJoins.some((expected, index) => {
      const current = joins[index];
      return !current ||
        current.chatId !== expected.chatId ||
        current.chunkId !== expected.chunkId ||
        current.endOffset !== expected.endOffset ||
        current.messageId !== expected.messageId ||
        current.ordinal !== expected.ordinal ||
        current.role !== expected.role ||
        current.startOffset !== expected.startOffset ||
        current.userId !== expected.userId;
    })
  ) return false;

  const entries = await tx.memorySearchEntry.findMany({
    where: {
      indexGenerationId: activeIndex.id,
      itemType: "RECALL_CHUNK",
      recallChunkId: { in: chunkIds },
      userId: plan.source.userId
    }
  });
  if (entries.length !== plan.chunks.length) return false;
  return plan.chunks.every((chunk) => {
    const entry = entries.find((candidate) => candidate.recallChunkId === chunk.id);
    const expected = expectedSearchEntry(plan, chunk);
    return Boolean(entry) &&
      embeddingStateMatchesIndex(activeIndex.indexMode, entry!.embeddingState) &&
      entry!.languageCode === expected.languageCode &&
      entry!.safeContentHash === expected.safeContentHash &&
      entry!.safeSearchText === expected.safeSearchText &&
      entry!.safeSearchTextYoNormalized === expected.safeSearchTextYoNormalized &&
      entry!.safetyIdentitySnapshot === expected.safetyIdentitySnapshot &&
      entry!.sourceIdentitySnapshot === expected.sourceIdentitySnapshot &&
      entry!.suppressionIdentitySnapshot === expected.suppressionIdentitySnapshot;
  });
}

async function persistChunk(
  tx: MemoryTransaction,
  activeIndex: MemoryActiveIndex,
  plan: MemoryHistoryIndexPlan,
  chunk: MemoryHistoryPreparedChunk
): Promise<Readonly<{ embeddingState: MemoryEmbeddingState; id: string }>> {
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
      state: "ACTIVE",
      userId: chunk.userId
    },
    update: {
      branchGeneration: chunk.branchGeneration,
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
      sourceRevisionAtCreation: chunk.sourceRevision,
      state: "ACTIVE"
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
      startOffset: join.startOffset,
      userId: chunk.userId
    }))
  });
  await tx.memorySearchEntry.deleteMany({
    where: {
      indexGenerationId: activeIndex.id,
      recallChunkId: chunk.id,
      userId: chunk.userId
    }
  });
  const expected = expectedSearchEntry(plan, chunk);
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
      safeSearchText: expected.safeSearchText,
      safeSearchTextYoNormalized: expected.safeSearchTextYoNormalized,
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

async function applyPlan(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  plan: MemoryHistoryIndexPlan,
  now: Date
): Promise<void> {
  if (
    !memoryHistoryIndexClaimIsValid(claim) ||
    plan.source.activeLeafMessageId !== claim.activeLeafMessageId ||
    plan.source.branchGeneration !== claim.branchGeneration ||
    plan.source.chatId !== claim.chatId ||
    plan.source.sourceHash !== claim.sourceHash ||
    plan.source.sourceRevision !== claim.sourceRevision ||
    plan.source.userId !== claim.userId ||
    memoryHistoryIndexResultHash(
      plan.source,
      plan.chunks,
      plan.suppressionIdentitySnapshot
    ) !== plan.resultHash
  ) {
    throw new MemoryCoordinatorError("memory_history_plan_invalid", false);
  }
  const settings = await lockMemorySettings(tx, claim.userId, false);
  if (!settings.referenceChatHistory) return;
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: claim.chatId,
    lock: "SHARE",
    userId: claim.userId
  });
  if (
    settings.memoryGeneration !== claim.memoryGenerationSnapshot ||
    !sourceMatchesJob(source, claim)
  ) {
    throw new MemoryCoordinatorError("memory_source_stale", false);
  }
  const currentPrepared = await prepareWith(tx, claim, now);
  if (
    "decision" in currentPrepared ||
    currentPrepared.plan.resultHash !== plan.resultHash
  ) {
    throw new MemoryCoordinatorError("memory_history_plan_stale", true);
  }
  if (await planAlreadyApplied(tx, settings, plan)) {
    const pendingEntries = await tx.memorySearchEntry.findMany({
      select: { embeddingState: true, id: true },
      where: {
        embeddingState: "PENDING",
        indexGenerationId: settings.activeIndexGenerationId!,
        itemType: "RECALL_CHUNK",
        recallChunkId: { in: plan.chunks.map((chunk) => chunk.id) },
        userId: plan.source.userId
      }
    });
    for (const entry of pendingEntries) {
      await enqueueChunkEmbedding(tx, settings, entry, plan.resultHash);
    }
    if (plan.chunks.length > 0) {
      await enqueueMemoryJob(tx, settings, {
        idempotencyFingerprint: memoryEpisodeExtractionJobFingerprint(plan.source),
        kind: "EXTRACT_EPISODE",
        pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
        source: {
          activeLeafMessageId: plan.source.activeLeafMessageId,
          branchGeneration: plan.source.branchGeneration,
          chatId: plan.source.chatId,
          sourceHash: plan.source.sourceHash,
          sourceRevision: plan.source.sourceRevision
        }
      });
    }
    return;
  }

  const activeChunks = await tx.memoryRecallChunk.findMany({
    select: { id: true },
    where: {
      chatId: claim.chatId,
      state: "ACTIVE",
      userId: claim.userId
    }
  });
  const visibilityChanged = activeChunks.length > 0 || plan.chunks.length > 0;
  let activeIndex: MemoryActiveIndex | null = null;
  if (visibilityChanged) {
    await advanceMemoryMutation(tx, settings, "CHUNK_OR_EPISODE_VISIBILITY_CHANGE");
    activeIndex = await requireActiveMemoryIndex(tx, settings);
    if (!activeIndex) {
      throw new MemoryCoordinatorError("memory_active_generation_invalid", false);
    }
  }
  if (activeChunks.length > 0) {
    const ids = activeChunks.map((chunk) => chunk.id);
    await tx.memorySearchEntry.deleteMany({
      where: { recallChunkId: { in: ids }, userId: claim.userId }
    });
    await tx.memoryRecallChunk.updateMany({
      data: { invalidatedAt: now, state: "INVALIDATED" },
      where: { id: { in: ids }, state: "ACTIVE", userId: claim.userId }
    });
  }
  if (plan.chunks.length > 0 && !activeIndex) {
    throw new MemoryCoordinatorError("memory_active_generation_invalid", false);
  }
  for (const chunk of plan.chunks) {
    const entry = await persistChunk(tx, activeIndex!, plan, chunk);
    await enqueueChunkEmbedding(
      tx,
      settings,
      entry,
      plan.resultHash
    );
  }
  await tx.chatMemoryCheckpoint.upsert({
    create: {
      activeLeafMessageId: plan.source.activeLeafMessageId,
      branchGeneration: plan.source.branchGeneration,
      chatId: plan.source.chatId,
      lastIndexedMessageId: plan.source.activeLeafMessageId,
      lastDreamedMessageId: plan.chunks.length === 0
        ? plan.source.activeLeafMessageId
        : null,
      lastSucceededAt: now,
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
      lastDreamedMessageId: plan.chunks.length === 0
        ? plan.source.activeLeafMessageId
        : null,
      lastSucceededAt: now,
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
  if (plan.chunks.length > 0) {
    await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryEpisodeExtractionJobFingerprint(plan.source),
      kind: "EXTRACT_EPISODE",
      pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
      source: {
        activeLeafMessageId: plan.source.activeLeafMessageId,
        branchGeneration: plan.source.branchGeneration,
        chatId: plan.source.chatId,
        sourceHash: plan.source.sourceHash,
        sourceRevision: plan.source.sourceRevision
      }
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
