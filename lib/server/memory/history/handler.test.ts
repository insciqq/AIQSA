import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import type { MemoryHistorySafetyClassifier } from "./classifier";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import {
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryIndexJobFingerprint,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan,
  type MemoryHistoryIndexSourceIdentity
} from "./contract";
import {
  applyMemoryHistoryClassifications,
  createMemoryHistoryIndexHandler
} from "./handler";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";
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

function plan(chunks: MemoryHistoryIndexPlan["chunks"] = []): MemoryHistoryIndexPlan {
  const suppressionIdentitySnapshot = "b".repeat(64);
  const checkpointMessages: MemoryHistoryIndexPlan["checkpointMessages"] = [];
  const rebuiltChunkIds = chunks.map(({ id }) => id);
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
    { checkpointMessages, incremental, rebuiltChunkIds }
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
    resultHash,
    reusedChunkIds: [],
    source,
    suppressionIdentitySnapshot
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
    const executionResults = [{
      acceptedOutputHash: "c".repeat(64),
      bindingId: "history-classifier-binding-1"
    }];
    const repository = {
      apply,
      preflight: vi.fn(async () => ({ status: "READY" as const })),
      prepare: vi.fn(async () => ({ plan: currentPlan }))
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({
      authorizeResults,
      classifier: {
        classify: vi.fn(async () => ({
          decisions: [],
          executions: executionResults,
          policyVersion: "memory-history-safety-policy-test"
        }))
      },
      repository
    });
    const executionContext = context();

    const result = await handler.execute(currentClaim, executionContext);

    expect(result).toMatchObject({
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
    expect(authorizeResults).toHaveBeenCalledWith(
      tx,
      { userId: source.userId },
      source.userId,
      currentClaim.id,
      executionResults
    );
    expect(apply).toHaveBeenCalledWith(
      tx,
      currentClaim,
      expect.objectContaining({
        classificationPolicyVersion: "memory-history-safety-policy-test",
        preparedResultHash: currentPlan.resultHash,
        resultHash: result.acceptedResultHash
      }),
      new Date("2026-08-10T12:00:00.000Z")
    );
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
      {
        checkpointMessages: basePlan.checkpointMessages,
        incremental,
        rebuiltChunkIds: ["chunk-tail"],
        reusedChunkIds: ["chunk-stable"]
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
      languageCode: "en",
      occurredFrom: "2026-08-10T10:00:00.000Z",
      occurredTo: "2026-08-10T10:01:00.000Z",
      openLoops: ["Confirm rollout"],
      safeDigestText: "Summary: Deployment options were compared.",
      sourceChunkIds: ["chunk-stable", "chunk-tail"],
      sourceMessageIds: ["user-1", "assistant-1"],
      summary: "Deployment options were compared.",
      topics: ["Deployment"]
    } as const;
    const classifier = {
      classify: vi.fn()
        .mockResolvedValueOnce({
          decisions: [{ chunkId: "chunk-tail", sensitivity: "NORMAL" }],
          executions: [{
            acceptedOutputHash: "a".repeat(64),
            bindingId: "tail-classification"
          }],
          policyVersion: "memory-history-safety-policy-test"
        })
        .mockResolvedValueOnce({
          decisions: [{ chunkId: digest.id, sensitivity: "NORMAL" }],
          executions: [{
            acceptedOutputHash: "b".repeat(64),
            bindingId: "digest-classification"
          }],
          policyVersion: "memory-history-digest-safety-test"
        })
    };
    const digestGenerator = {
      generate: vi.fn(async () => ({
        digest,
        executions: [{
          acceptedOutputHash: "c".repeat(64),
          bindingId: "digest-generation"
        }],
        policyVersion: "memory-chat-digest-policy-test"
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

    expect(classifier.classify.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: "chunk-tail" })
    ]);
    expect(classifier.classify.mock.calls[1]?.[0]).toEqual([{
      id: "digest-1",
      safeProjectedText: digest.safeDigestText
    }]);
    expect(digestGenerator.generate).toHaveBeenCalledWith(
      source,
      expect.arrayContaining([
        expect.objectContaining({ id: "chunk-stable" }),
        expect.objectContaining({ id: "chunk-tail" })
      ]),
      expect.objectContaining({ jobId: currentClaim.id, userId: source.userId })
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
        expect.objectContaining({ bindingId: "tail-classification" }),
        expect.objectContaining({ bindingId: "digest-generation" }),
        expect.objectContaining({ bindingId: "digest-classification" })
      ])
    );
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      currentClaim,
      expect.objectContaining({
        digest,
        digestPolicyVersion:
          "memory-chat-digest-policy-test:memory-history-digest-safety-test",
        rebuiltChunkIds: ["chunk-tail"],
        reusedChunkIds: ["chunk-stable"]
      }),
      new Date("2026-08-10T12:00:00.000Z")
    );
  });
});
