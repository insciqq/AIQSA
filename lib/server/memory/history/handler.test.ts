import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";
import type { MemoryHistorySafetyClassifier } from "./classifier";
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
  applyMemoryHistoryClassifications,
  attachMemoryContextualKeys,
  createMemoryHistoryIndexHandler
} from "./handler";
import { memoryQualificationLanguageBucket } from "./language";
import {
  MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION,
  MemoryChatDigestError,
  MemoryChatDigestOutputError
} from "./digest";
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
  const rawSafeText = `User: contextual history ${ordinal}\n\nAssistant: acknowledged`;
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
  rounds: MemoryHistoryIndexPlan["rounds"] = []
): MemoryHistoryIndexPlan {
  const suppressionIdentitySnapshot = "b".repeat(64);
  const checkpointMessages: MemoryHistoryIndexPlan["checkpointMessages"] = [];
  const rebuiltChunkIds = chunks.map(({ id }) => id);
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
    digest: null,
    digestPolicyVersion: null,
    incremental,
    preparedResultHash: resultHash,
    rebuiltChunkIds,
    rebuiltRoundIds,
    resultHash,
    reusedChunkIds: [],
    reusedRoundIds: [],
    rounds,
    source,
    suppressionIdentitySnapshot,
    timeZone: "UTC",
    toolEvents: [],
    work: EMPTY_MEMORY_HISTORY_WORK_COUNTERS
  };
}

function classifier(): MemoryHistorySafetyClassifier {
  return {
    classify: vi.fn(async () => ({
      decisions: [],
      policyVersion: "memory-history-safety-policy-test"
    }))
  };
}

function context() {
  return {
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    setStage: vi.fn(async (_stage: string) => undefined),
    signal: new AbortController().signal
  };
}

describe("Memory INDEX_HISTORY handler", () => {
  it("suppresses secret chunks and canonicalizes legacy sensitive output", () => {
    const current = plan([chunk("chunk-sensitive", 0), chunk("chunk-secret", 1)]);
    const classified = applyMemoryHistoryClassifications(current, {
      decisions: [
        { chunkId: "chunk-sensitive", sensitivity: "SENSITIVE" },
        { chunkId: "chunk-secret", sensitivity: "SECRET" }
      ],
      policyVersion: "memory-history-safety-policy-test"
    });

    expect(classified.chunks).toMatchObject([
      { id: "chunk-sensitive", publicationState: "ACTIVE", safetyClass: "NORMAL" },
      {
        id: "chunk-secret",
        publicationState: "SUPPRESSED",
        redactionState: "EXCLUDED",
        safetyClass: "SECRET_TAINTED"
      }
    ]);
    expect(classified.preparedResultHash).toBe(current.resultHash);
    expect(classified.resultHash).not.toBe(current.resultHash);
  });

  it("rejects malformed jobs before repository access", async () => {
    const repository = {
      apply: vi.fn(),
      preflight: vi.fn(),
      prepare: vi.fn()
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({ classifier: classifier(), repository });

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
    const handler = createMemoryHistoryIndexHandler({ classifier: classifier(), repository });

    await expect(handler.preflight(current)).resolves.toEqual({ status: "READY" });
    expect(preflight).toHaveBeenCalledWith(current);
  });

  it("returns one atomic apply closure for the exact prepared plan", async () => {
    const currentClaim = claim();
    const currentPlan = plan();
    const apply = vi.fn(async () => undefined);
    const authorizeResults = vi.fn(async () => undefined);
    const classify = vi.fn();
    const repository = {
      apply,
      preflight: vi.fn(async () => ({ status: "READY" as const })),
      prepare: vi.fn(async () => ({ plan: currentPlan }))
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({
      authorizeResults,
      classifier: { classify },
      repository
    });
    const executionContext = context();

    const result = await handler.execute(currentClaim, executionContext);

    expect(result).toMatchObject({
      operationalCounters: {
        digestFullRebuild: 0,
        digestIncremental: 0,
        digestNoop: 0,
        historyChunksBuilt: 0,
        historyChunksReplaced: 0,
        historyMessagesProjected: 0
      },
      stage: "lexical_ready"
    });
    expect(result.acceptedResultHash).not.toBe(currentPlan.resultHash);
    expect(executionContext.setStage.mock.calls.map(([stage]) => stage)).toEqual([
      "source_snapshot",
      "safety_classification",
      "lexical_apply"
    ]);
    expect(result.apply).toBeTypeOf("function");
    const tx = {
      $queryRaw: vi.fn(async () => [{ ownerStatus: "active", userId: source.userId }])
    };
    await result.apply?.(tx as never, currentClaim);
    expect(classify).not.toHaveBeenCalled();
    expect(authorizeResults).not.toHaveBeenCalled();
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

  it("retries active raw-fallback contextual keys and authorizes the output", async () => {
    const currentClaim = claim();
    const parent = chunk("chunk-round-parent", 0);
    const projectedRound = round("round-1", parent.id, 0);
    const rebuilt = plan([parent], [projectedRound]);
    const currentPlan: MemoryHistoryIndexPlan = {
      ...rebuilt,
      rebuiltRoundIds: [],
      reusedRoundIds: [projectedRound.id]
    };
    const apply = vi.fn(async () => undefined);
    const authorizeResults = vi.fn(async () => undefined);
    const contextualKeyGenerator = {
      generate: vi.fn(async () => ({
        executions: [{
          acceptedOutputHash: "c".repeat(64),
          bindingId: "contextual-generation"
        }],
        fallbackRoundIds: [],
        outputs: [{
          languageCode: "en",
          roundId: projectedRound.id,
          statements: [{
            sourceRoundIds: [projectedRound.id],
            text: "User contextual history 0"
          }]
        }],
        policyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION as
          typeof MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
        providerRequests: 1
      }))
    };
    const executionContext = context();
    const handler = createMemoryHistoryIndexHandler({
      authorizeResults,
      contextualKeyGenerator,
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        prepare: vi.fn(async () => ({ plan: currentPlan }))
      } as unknown as MemoryHistoryIndexRepository
    });

    const result = await handler.execute(currentClaim, executionContext);

    expect(contextualKeyGenerator.generate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: projectedRound.id })]),
      [projectedRound.id],
      expect.objectContaining({ jobId: currentClaim.id, userId: source.userId })
    );
    expect(executionContext.setStage.mock.calls.map(([stage]) => stage)).toEqual([
      "source_snapshot",
      "safety_classification",
      "contextual_key_generation",
      "lexical_apply"
    ]);
    expect(result.operationalCounters).toMatchObject({
      contextualGeneratedEn: 1,
      contextualProviderRequests: 1,
      contextualRoundsFallback: 0,
      contextualRoundsGenerated: 1,
      historyRoundsBuilt: 0
    });
    await result.apply?.({
      $queryRaw: vi.fn(async () => [{ ownerStatus: "active", userId: source.userId }])
    } as never, currentClaim);
    expect(authorizeResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      source.userId,
      currentClaim.id,
      [{
        acceptedOutputHash: "c".repeat(64),
        bindingId: "contextual-generation"
      }]
    );
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      currentClaim,
      expect.objectContaining({
        rounds: [expect.objectContaining({
          contextualKeyState: "GENERATED",
          contextualNarrativeText: "User contextual history 0",
          id: projectedRound.id
        })]
      }),
      new Date("2026-08-10T12:00:00.000Z")
    );
  });

  it("records typed contextual fallback and content-free language counters", () => {
    const parent = chunk("chunk-contextual-fallback", 0);
    const projectedRound = round("round-contextual-fallback", parent.id, 0);
    const attached = attachMemoryContextualKeys(
      plan([parent], [projectedRound]),
      {
        executions: [],
        fallbackDiagnostics: [{
          reason: "UNSUPPORTED_NUMBER",
          roundId: projectedRound.id
        }],
        fallbackRoundIds: [projectedRound.id],
        outputs: [],
        policyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
        providerRequests: 1
      },
      [projectedRound.id]
    );

    expect(attached.work).toMatchObject({
      contextualFallbackReasonCounts: { UNSUPPORTED_NUMBER: 1 },
      contextualLanguageCounts: { fallback: { en: 1 }, generated: {} },
      contextualRoundsFallback: 1,
      contextualRoundsGenerated: 0
    });
    expect(memoryQualificationLanguageBucket("en-US")).toBe("en");
    expect(memoryQualificationLanguageBucket("ru")).toBe("ru");
    expect(memoryQualificationLanguageBucket("es")).toBe("other");
    expect(memoryQualificationLanguageBucket("sr-Cyrl")).toBe("other");
    expect(memoryQualificationLanguageBucket("mixed")).toBe("mixed");
    expect(memoryQualificationLanguageBucket("mul")).toBe("mixed");
    expect(memoryQualificationLanguageBucket("und")).toBe("und");
    expect(memoryQualificationLanguageBucket("not_a_language")).toBe("und");
    expect(JSON.stringify(attached.work)).not.toContain(projectedRound.rawSafeText);
  });

  it("classifies only the rebuilt tail and safety-checks the bounded digest", async () => {
    const currentClaim = claim();
    const basePlan = plan([chunk("chunk-stable", 0), chunk("chunk-tail", 1)]);
    const incremental = {
      commonPathMessageCount: 4,
      mode: "APPEND" as const,
      rebuildFromMessageOrdinal: 2
    };
    const rawResultHash = memoryHistoryIndexResultHash(
      source,
      basePlan.chunks,
      basePlan.suppressionIdentitySnapshot,
      null,
      basePlan.timeZone,
      {
        checkpointMessages: basePlan.checkpointMessages,
        incremental,
        rebuiltChunkIds: ["chunk-tail"],
        reusedChunkIds: ["chunk-stable"],
        work: basePlan.work
      }
    );
    const currentPlan: MemoryHistoryIndexPlan = {
      ...basePlan,
      incremental,
      preparedResultHash: rawResultHash,
      rebuiltChunkIds: ["chunk-tail"],
      resultHash: rawResultHash,
      reusedChunkIds: ["chunk-stable"]
    };
    const digest = {
      anchorChunkId: "chunk-tail",
      contentHash: "d".repeat(64),
      decisions: ["Use cedar deployment"],
      id: "digest-1",
      incrementalDepth: 0,
      inputFingerprint: "e".repeat(64),
      languageCode: "en",
      occurredFrom: "2026-08-10T10:00:00.000Z",
      occurredTo: "2026-08-10T10:01:00.000Z",
      openLoops: ["Confirm rollout"],
      redactionState: "NOT_NEEDED",
      rebuildPolicyVersion: MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION,
      safeDigestText: "Summary: Deployment options were compared.",
      sourceChunkIds: ["chunk-stable", "chunk-tail"],
      sourceFingerprint: "f".repeat(64),
      sourceMessageIds: ["user-1", "assistant-1"],
      summary: "Deployment options were compared.",
      topics: ["Deployment"],
      updateMode: "FULL_REBUILD"
    } as const;
    const classifier = { classify: vi.fn() };
    const digestGenerator = {
      generate: vi.fn(async () => ({
        classificationRequired: true,
        digest,
        executions: [{
          acceptedOutputHash: "c".repeat(64),
          bindingId: "digest-generation"
        }],
        policyVersion: "memory-chat-digest-policy-test",
        work: {
          digestSegmentsProcessed: 1,
          digestSourceChunksProcessed: 1
        }
      }))
    };
    const apply = vi.fn(async () => undefined);
    const authorizeResults = vi.fn(async () => undefined);
    const handler = createMemoryHistoryIndexHandler({
      authorizeResults,
      classifier,
      digestGenerator,
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        prepare: vi.fn(async () => ({ plan: currentPlan }))
      } as unknown as MemoryHistoryIndexRepository
    });
    const result = await handler.execute(currentClaim, context());

    expect(result.operationalCounters).toMatchObject({
      digestFullRebuild: 1,
      digestIncremental: 0,
      digestNoop: 0,
      digestSegmentsProcessed: 1,
      digestSourceChunksProcessed: 1
    });

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(digestGenerator.generate).toHaveBeenCalledWith(
      source,
      expect.arrayContaining([
        expect.objectContaining({ id: "chunk-stable" }),
        expect.objectContaining({ id: "chunk-tail" })
      ]),
      expect.objectContaining({
        jobId: currentClaim.id,
        timeZone: "UTC",
        userId: source.userId
      })
    );
    await result.apply?.({
      $queryRaw: vi.fn(async () => [{ ownerStatus: "active", userId: source.userId }])
    } as never, currentClaim);
    expect(authorizeResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      source.userId,
      currentClaim.id,
      expect.arrayContaining([
        expect.objectContaining({ bindingId: "digest-generation" })
      ])
    );
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      currentClaim,
      expect.objectContaining({
        digest,
        digestPolicyVersion:
          `memory-chat-digest-policy-test:${MEMORY_SAFETY_LITE_POLICY_VERSION}`,
        rebuiltChunkIds: ["chunk-tail"],
        reusedChunkIds: ["chunk-stable"]
      }),
      new Date("2026-08-10T12:00:00.000Z")
    );
  });

  it("commits safe chunks when only the derived digest output is invalid", async () => {
    const currentClaim = claim();
    const currentPlan = plan([chunk("chunk-safe", 0)]);
    const apply = vi.fn(async () => undefined);
    const authorizeResults = vi.fn(async () => undefined);
    const classifier = { classify: vi.fn() };
    const executionContext = context();
    const handler = createMemoryHistoryIndexHandler({
      authorizeResults,
      classifier,
      digestGenerator: {
        generate: vi.fn(async () => {
          throw new MemoryChatDigestOutputError("aggregate_limit");
        })
      },
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        prepare: vi.fn(async () => ({ plan: currentPlan }))
      } as unknown as MemoryHistoryIndexRepository
    });

    const result = await handler.execute(currentClaim, executionContext);

    expect(result).toMatchObject({
      operationalCounters: {
        digestFullRebuild: 0,
        digestIncremental: 0,
        digestNoop: 0
      },
      stage: "lexical_ready:digest_aggregate_limit"
    });
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(executionContext.setStage.mock.calls.map(([stage]) => stage)).toEqual([
      "source_snapshot",
      "safety_classification",
      "digest_generation",
      "lexical_apply"
    ]);
    const tx = {
      $queryRaw: vi.fn(async () => [{ ownerStatus: "active", userId: source.userId }])
    };
    await result.apply?.(tx as never, currentClaim);
    expect(authorizeResults).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(
      tx,
      currentClaim,
      expect.objectContaining({
        digest: null,
        digestPolicyVersion:
          "memory-chat-digest-output-degraded-v1:aggregate_limit"
      }),
      new Date("2026-08-10T12:00:00.000Z")
    );
  });

  it("commits safe chunks when optional digest generation is unavailable", async () => {
    const currentClaim = claim();
    const currentPlan = plan([chunk("chunk-safe", 0)]);
    const apply = vi.fn(async () => undefined);
    const handler = createMemoryHistoryIndexHandler({
      classifier: {
        classify: vi.fn(async () => ({
          decisions: [{ chunkId: "chunk-safe", sensitivity: "NORMAL" as const }],
          policyVersion: "memory-history-safety-policy-test"
        }))
      },
      digestGenerator: {
        generate: vi.fn(async () => {
          throw new MemoryChatDigestError("memory_chat_digest_unavailable");
        })
      },
      repository: {
        apply,
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        prepare: vi.fn(async () => ({ plan: currentPlan }))
      } as unknown as MemoryHistoryIndexRepository
    });

    const result = await handler.execute(currentClaim, context());
    expect(result).toMatchObject({
      stage: "lexical_ready:digest_unavailable"
    });
    await result.apply?.({
      $queryRaw: vi.fn(async () => [{ ownerStatus: "active", userId: source.userId }])
    } as never, currentClaim);
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      currentClaim,
      expect.objectContaining({
        digest: null,
        digestPolicyVersion:
          "memory-chat-digest-output-degraded-v1:unavailable"
      }),
      new Date("2026-08-10T12:00:00.000Z")
    );
  });

  it("does not invoke digest classification for a fingerprint no-op", async () => {
    const currentClaim = claim();
    const currentPlan = plan([chunk("chunk-stable", 0)]);
    const classify = vi.fn(async () => ({
      decisions: [{ chunkId: "chunk-stable", sensitivity: "NORMAL" as const }],
      policyVersion: "memory-history-safety-policy-test"
    }));
    const digest = {
      anchorChunkId: "chunk-stable",
      contentHash: "d".repeat(64),
      decisions: [],
      id: "digest-noop",
      incrementalDepth: 2,
      inputFingerprint: "e".repeat(64),
      languageCode: "en",
      occurredFrom: "2026-08-10T10:00:00.000Z",
      occurredTo: "2026-08-10T10:01:00.000Z",
      openLoops: [],
      redactionState: "NOT_NEEDED" as const,
      rebuildPolicyVersion: MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION,
      safeDigestText: "Summary: Existing safe digest.",
      sourceChunkIds: ["chunk-stable"],
      sourceFingerprint: "f".repeat(64),
      sourceMessageIds: ["user-1", "assistant-1"],
      summary: "Existing safe digest.",
      topics: [],
      updateMode: "UNCHANGED" as const
    };
    const handler = createMemoryHistoryIndexHandler({
      classifier: { classify },
      digestGenerator: {
        generate: vi.fn(async () => ({
          classificationRequired: false,
          digest,
          executions: [],
          policyVersion: "prior-generator:prior-classifier",
          work: {
            digestSegmentsProcessed: 0,
            digestSourceChunksProcessed: 0
          }
        }))
      },
      repository: {
        apply: vi.fn(async () => undefined),
        preflight: vi.fn(async () => ({ status: "READY" as const })),
        prepare: vi.fn(async () => ({ plan: currentPlan }))
      } as unknown as MemoryHistoryIndexRepository
    });

    const result = await handler.execute(currentClaim, context());

    expect(classify).not.toHaveBeenCalled();
    expect(result.operationalCounters).toMatchObject({
      digestFullRebuild: 0,
      digestIncremental: 0,
      digestNoop: 1,
      digestSegmentsProcessed: 0,
      digestSourceChunksProcessed: 0
    });
  });
});
