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
    stage: null
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
  const resultHash = memoryHistoryIndexResultHash(
    source,
    chunks,
    suppressionIdentitySnapshot
  );
  return {
    classificationPolicyVersion: null,
    chunks,
    preparedResultHash: resultHash,
    resultHash,
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
  it("drops secret or uncertain chunks and canonicalizes legacy sensitive output", () => {
    const current = plan([chunk("chunk-sensitive", 0), chunk("chunk-secret", 1)]);
    const classified = applyMemoryHistoryClassifications(current, {
      decisions: [
        { chunkId: "chunk-sensitive", sensitivity: "SENSITIVE" },
        { chunkId: "chunk-secret", sensitivity: "SECRET" }
      ],
      policyVersion: "memory-history-safety-policy-test"
    });

    expect(classified.chunks).toMatchObject([{
      id: "chunk-sensitive",
      safetyClass: "NORMAL"
    }]);
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
});
