import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryJobFencedError } from "../coordinator/errors";
import type { MemoryJobClaim } from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import {
  EMPTY_MEMORY_HISTORY_WORK_COUNTERS,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryIndexJobFingerprint,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan,
  type MemoryHistoryIndexSourceIdentity
} from "./contract";
import {
  applyMemoryHistorySafetyLite,
  createMemoryHistoryIndexHandler
} from "./handler";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "./rounds";
import type { MemoryHistoryIndexRepository } from "./repository";

const source: MemoryHistoryIndexSourceIdentity = Object.freeze({
  activeLeafMessageId: "assistant-1",
  branchGeneration: 3,
  chatId: "chat-1",
  sourceHash: "a".repeat(64),
  sourceRevision: 7,
  userId: "user-1"
});

function claim(): MemoryJobClaim {
  return {
    ...source,
    attemptCount: 1,
    claimToken: randomUUID(),
    id: randomUUID(),
    idempotencyFingerprint: memoryHistoryIndexJobFingerprint({
      activeLeafMessageId: source.activeLeafMessageId,
      id: source.chatId,
      memoryBranchGeneration: source.branchGeneration,
      memorySourceRevision: source.sourceRevision,
      sourceHash: source.sourceHash,
      userId: source.userId
    }),
    kind: "INDEX_HISTORY",
    leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
    memoryGenerationSnapshot: 2,
    memoryRevisionSnapshot: 5,
    pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    recoveredLease: false,
    sourceMessageId: null,
    stage: null,
    targetFactVersionId: null
  };
}

function chunk(id: string, ordinal: number): MemoryHistoryIndexPlan["chunks"][number] {
  const text = `User: history ${ordinal}\n\nAssistant: acknowledged`;
  return {
    approxTokens: 8,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
    contentHash: String(ordinal + 1).repeat(64),
    folderId: null,
    id,
    languageCode: "en",
    messageJoins: [],
    normalizedSafeSearchText: text.toLocaleLowerCase("und"),
    occurredFrom: "2026-08-10T10:00:00.000Z",
    occurredTo: "2026-08-10T10:01:00.000Z",
    ordinal,
    overlapFromPreviousTurnGroupIds: [],
    publicationState: "ACTIVE",
    providerSafeText: text,
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED",
    safeProjectedText: text,
    safetyClass: "NORMAL",
    sourceAssistantId: null,
    sourceContentHash: source.sourceHash,
    sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    sourceRevision: source.sourceRevision,
    turnGroupIds: [`turn-${ordinal}`],
    userId: source.userId
  };
}

function round(
  id: string,
  parentChunkId: string,
  ordinal: number
): MemoryHistoryIndexPlan["rounds"][number] {
  const rawSafeText = `User: round history ${ordinal}\n\nAssistant: acknowledged`;
  return {
    approxTokens: 8,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    contextualKeyPolicyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
    contextualKeyState: "RAW_FALLBACK",
    contextualNarrativeText: rawSafeText,
    contextualSearchHash: memorySha256(rawSafeText.toLocaleLowerCase("und")),
    contextualSearchText: rawSafeText.toLocaleLowerCase("und"),
    contentHash: memorySha256({ id, rawSafeText }),
    evidenceRootHash: memorySha256({ id, type: "evidence-root" }),
    folderId: null,
    groupId: `turn-${ordinal}`,
    groupKind: "TURN",
    id,
    languageCode: "en",
    messageJoins: [],
    occurredFrom: "2026-08-10T10:00:00.000Z",
    occurredTo: "2026-08-10T10:01:00.000Z",
    ordinal,
    parentChunkId,
    projectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
    publicationState: "ACTIVE",
    rawSafeText,
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED",
    safetyClass: "NORMAL",
    sourceAssistantId: null,
    sourceContentHash: source.sourceHash,
    sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    sourceRevision: source.sourceRevision,
    supportingRoundIds: [],
    userId: source.userId
  };
}

function plan(
  chunks: MemoryHistoryIndexPlan["chunks"] = [],
  rounds: MemoryHistoryIndexPlan["rounds"] = [],
  reusedChunkIds: readonly string[] = []
): MemoryHistoryIndexPlan {
  const suppressionIdentitySnapshot = "b".repeat(64);
  const checkpointMessages: MemoryHistoryIndexPlan["checkpointMessages"] = [];
  const reused = new Set(reusedChunkIds);
  const rebuiltChunkIds = chunks.flatMap(({ id }) => reused.has(id) ? [] : [id]);
  const rebuiltRoundIds = rounds.map(({ id }) => id);
  const incremental = {
    commonPathMessageCount: 0,
    mode: "FULL_REBUILD" as const,
    rebuildFromMessageOrdinal: 0
  };
  const resultHash = memoryHistoryIndexResultHash(
    source,
    chunks,
    suppressionIdentitySnapshot,
    null,
    "UTC",
    {
      checkpointMessages,
      incremental,
      rebuiltChunkIds,
      rebuiltRoundIds,
      reusedChunkIds,
      reusedRoundIds: [],
      rounds,
      toolEvents: [],
      work: EMPTY_MEMORY_HISTORY_WORK_COUNTERS
    }
  );
  return {
    classificationPolicyVersion: null,
    checkpointMessages,
    chunks,
    incremental,
    preparedResultHash: resultHash,
    rebuiltChunkIds,
    rebuiltRoundIds,
    resultHash,
    reusedChunkIds,
    reusedRoundIds: [],
    rounds,
    source,
    suppressionIdentitySnapshot,
    timeZone: "UTC",
    toolEvents: [],
    work: EMPTY_MEMORY_HISTORY_WORK_COUNTERS
  };
}

function context() {
  return {
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    setStage: vi.fn(async (_stage: string) => undefined),
    signal: new AbortController().signal
  };
}

function handlerFor(currentPlan: MemoryHistoryIndexPlan, apply = vi.fn(async () => undefined)) {
  return createMemoryHistoryIndexHandler({
    repository: {
      apply,
      preflight: vi.fn(async () => ({ status: "READY" as const })),
      prepare: vi.fn(async () => ({ plan: currentPlan }))
    } as unknown as MemoryHistoryIndexRepository
  });
}

describe("Memory INDEX_HISTORY handler", () => {
  it("publishes rebuilt chunks under Safety Lite and keeps a suppressed parent's rounds suppressed", () => {
    const secret = {
      ...chunk("chunk-secret", 0),
      publicationState: "SUPPRESSED" as const,
      redactionReasonCodes: ["semantic_secret"],
      redactionState: "EXCLUDED" as const,
      safetyClass: "SECRET_TAINTED" as const
    };
    const current = plan(
      [secret, chunk("chunk-new", 1)],
      [round("round-secret", secret.id, 0), round("round-new", "chunk-new", 1)],
      [secret.id]
    );

    const classified = applyMemoryHistorySafetyLite(current);

    expect(classified.chunks).toMatchObject([
      { id: "chunk-secret", publicationState: "SUPPRESSED", safetyClass: "SECRET_TAINTED" },
      { id: "chunk-new", publicationState: "ACTIVE", safetyClass: "NORMAL" }
    ]);
    expect(classified.rounds).toMatchObject([
      {
        id: "round-secret",
        publicationState: "SUPPRESSED",
        redactionReasonCodes: ["semantic_secret"],
        redactionState: "EXCLUDED",
        safetyClass: "SECRET_TAINTED"
      },
      { id: "round-new", publicationState: "ACTIVE", safetyClass: "NORMAL" }
    ]);
    expect(classified.classificationPolicyVersion).toBe(MEMORY_SAFETY_LITE_POLICY_VERSION);
    expect(classified.preparedResultHash).toBe(current.resultHash);
    expect(classified.resultHash).not.toBe(current.resultHash);
  });

  it("rejects a plan whose rebuilt chunks or round parents are missing", () => {
    const current = plan([chunk("chunk-0", 0)]);
    expect(() => applyMemoryHistorySafetyLite({
      ...current,
      rebuiltChunkIds: [...current.rebuiltChunkIds, "chunk-missing"]
    })).toThrow(expect.objectContaining({
      code: "memory_history_classification_invalid",
      retryable: true
    }));
    expect(() => applyMemoryHistorySafetyLite({
      ...current,
      rounds: [round("round-orphan", "chunk-missing", 0)]
    })).toThrow(expect.objectContaining({ code: "memory_history_classification_invalid" }));
  });

  it("rejects malformed jobs before repository access", async () => {
    const repository = {
      apply: vi.fn(),
      preflight: vi.fn(),
      prepare: vi.fn()
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({ repository });

    await expect(handler.preflight({
      ...claim(),
      idempotencyFingerprint: "index-history:wrong"
    })).resolves.toEqual({
      errorCode: "memory_history_job_invalid",
      status: "CANCELLED"
    });
    expect(repository.preflight).not.toHaveBeenCalled();
  });

  it("delegates local gating without consulting learning state", async () => {
    const current = claim();
    const preflight = vi.fn(async () => ({ status: "READY" as const }));
    const repository = {
      apply: vi.fn(),
      preflight,
      prepare: vi.fn()
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({ repository });

    await expect(handler.preflight(current)).resolves.toEqual({ status: "READY" });
    expect(preflight).toHaveBeenCalledWith(current);
  });

  it("returns one atomic apply closure for the exact prepared plan", async () => {
    const currentClaim = claim();
    const currentPlan = plan();
    const apply = vi.fn(async () => undefined);
    const handler = handlerFor(currentPlan, apply);
    const executionContext = context();

    const result = await handler.execute(currentClaim, executionContext);

    expect(result).toMatchObject({
      operationalCounters: {
        historyChunksBuilt: 0,
        historyChunksReplaced: 0,
        historyMessagesProjected: 0
      },
      stage: "lexical_ready"
    });
    expect(Object.keys(result.operationalCounters ?? {})
      .every((key) => key.startsWith("history"))).toBe(true);
    expect(result.acceptedResultHash).not.toBe(currentPlan.resultHash);
    expect(executionContext.setStage.mock.calls.map(([stage]) => stage)).toEqual([
      "source_snapshot",
      "safety_classification",
      "lexical_apply"
    ]);
    const tx = {
      $queryRaw: vi.fn(async () => [{ ownerStatus: "active", userId: source.userId }])
    };
    await result.apply?.(tx as never, currentClaim);
    expect(apply).toHaveBeenCalledWith(
      tx,
      currentClaim,
      expect.objectContaining({
        classificationPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        preparedResultHash: currentPlan.resultHash,
        resultHash: result.acceptedResultHash
      }),
      new Date("2026-08-10T12:00:00.000Z")
    );
  });

  it("marks a partial page and a truncated message in the completion stage", async () => {
    const cursor = [{
      createdAt: "2026-08-10T10:00:00.000Z",
      messageId: "user-1",
      ordinal: 0,
      sourceMessageUpdatedAt: "2026-08-10T10:00:00.000Z"
    }];
    const partial = await handlerFor({ ...plan([chunk("chunk-0", 0)]), checkpointMessages: cursor })
      .execute(claim(), context());
    expect(partial.stage).toBe("lexical_ready:history_page_partial");

    const truncated = await handlerFor({
      ...plan([chunk("chunk-0", 0)]),
      checkpointMessages: cursor,
      incremental: {
        commonPathMessageCount: 0,
        mode: "FULL_REBUILD",
        rebuildFromMessageOrdinal: 0,
        truncatedMessageIds: ["user-1"]
      }
    }).execute(claim(), context());
    expect(truncated.stage).toBe("lexical_ready:history_message_truncated");
  });

  it("hands a fence raised while staging the apply to the coordinator", async () => {
    const fence = new MemoryJobFencedError("memory_history_job_invalid", {
      errorCode: "memory_source_stale", status: "STALE"
    });
    const parent = chunk("chunk-fenced", 0);
    const apply = vi.fn();
    const handler = handlerFor(plan([parent], [round("round-fenced", parent.id, 0)]), apply);
    const executionContext = context();
    executionContext.setStage.mockImplementation(async (stage: string) => {
      if (stage === "lexical_apply") throw fence;
    });

    await expect(handler.execute(claim(), executionContext)).rejects.toBe(fence);
    expect(apply).not.toHaveBeenCalled();
  });
});
