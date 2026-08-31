import { describe, expect, it, vi } from "vitest";
import type { MemoryOpenSearchClient } from
  "../../search/opensearch/memoryClient";
import { OpenSearchTransportError } from
  "../../search/opensearch/coreTransport";
import {
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchProjectionFingerprint
} from "../../search/opensearch/memoryContract";
import type {
  MemoryLexicalProjectionClaim,
  MemoryLexicalProjectionStore
} from "./repository";
import {
  auditMemoryLexicalProjection,
  MEMORY_LEXICAL_PROJECTION_MAX_DEFERRED_VERIFICATION_PASSES,
  memoryLexicalProjectionWorkerConfigurationFromEnv,
  nextMemoryLexicalProjectionDeferredVerificationPasses,
  rebuildMemoryLexicalProjection,
  runMemoryLexicalProjectionPass,
  shouldDeferMemoryLexicalProjectionVerification,
  shouldRunMemoryLexicalProjectionMaintenance
} from "./worker";

const env: NodeJS.ProcessEnv = {
  AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: Buffer.alloc(32, 12).toString("base64"),
  NODE_ENV: "test"
};
const openSearchConfiguration = memoryOpenSearchConfigurationFromEnv(env);
const workerConfiguration = memoryLexicalProjectionWorkerConfigurationFromEnv(env);
const now = new Date("2026-08-31T03:00:00.000Z");

function claim(
  operation: MemoryLexicalProjectionClaim["operation"] = "SYNC_ENTRY"
): MemoryLexicalProjectionClaim {
  return Object.freeze({
    attemptCount: 1,
    id: "10000000-0000-4000-8000-000000000001",
    indexGenerationId: operation === "PURGE_USER" ? null : "generation-1",
    leaseToken: "lease-1",
    memoryRevisionSnapshot: 7,
    operation,
    searchEntryId: operation === "PURGE_USER" || operation === "PURGE_GENERATION"
      ? null
      : "entry-1",
    sequence: 17n,
    userId: "private-user-1"
  });
}

function store(
  overrides: Partial<MemoryLexicalProjectionStore> = {}
): MemoryLexicalProjectionStore {
  return {
    claim: vi.fn(async () => []),
    enqueueUserPurge: vi.fn(async () => 1n),
    expectedGeneration: vi.fn(async () => null),
    inspect: vi.fn(async () => ({
      blockedEvents: 0,
      claimedEvents: 0,
      degradedGenerations: 0,
      outstandingEvents: 0,
      readyGenerations: 0,
      retiredGenerations: 0,
      totalGenerations: 0,
      version: 1 as const
    })),
    listIntegrityCandidates: vi.fn(async () => []),
    listVerificationCandidates: vi.fn(async () => []),
    loadCanonicalEntry: vi.fn(async () => null),
    markVerificationFailure: vi.fn(async () => undefined),
    purgeFenceExists: vi.fn(async () => true),
    reset: vi.fn(async () => ({
      eventsReset: 0,
      statesReset: 0,
      syncEventsCreated: 0
    })),
    retryBlocked: vi.fn(async () => 0),
    settleFailure: vi.fn(async () => undefined),
    settleIntegrity: vi.fn(async () => false),
    settleSuccess: vi.fn(async () => undefined),
    ...overrides
  };
}

function search(
  overrides: Partial<MemoryOpenSearchClient> = {}
): MemoryOpenSearchClient {
  return {
    activateReplacementIndex: vi.fn(async () => undefined),
    applyMutations: vi.fn(async () => ({ applied: 1, opaqueId: "opaque", superseded: 0 })),
    ensureIndex: vi.fn(async () => undefined),
    inspectGeneration: vi.fn(async () => ({
      documentCount: 0,
      fingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    })),
    purgeGeneration: vi.fn(async () => undefined),
    purgeUser: vi.fn(async () => undefined),
    prepareReplacementIndex: vi.fn(async () => undefined),
    refreshIndex: vi.fn(async () => undefined),
    searchLexical: vi.fn(async () => {
      throw new Error("unexpected_memory_lexical_search");
    }),
    ...overrides
  };
}

describe("Memory lexical projection worker", () => {
  it("projects one canonical entry with opaque routing through one bulk request", async () => {
    const current = claim();
    const projectionStore = store({
      claim: vi.fn(async () => [current]),
      loadCanonicalEntry: vi.fn(async () => ({
        indexGenerationId: "generation-1",
        itemType: "RECALL_ROUND" as const,
        lexicalText: "safe multilingual projection 東京",
        safeContentHash: "a".repeat(64),
        searchEntryId: "entry-1",
        sourceChatId: "chat-1",
        userId: "private-user-1"
      }))
    });
    const projectionSearch = search();

    await expect(runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    })).resolves.toEqual({
      claimed: 1,
      failed: 0,
      integrityFailed: 0,
      projected: 1,
      purged: 0,
      verifiedReady: 0
    });

    expect(projectionSearch.applyMutations).toHaveBeenCalledOnce();
    const [mutations, refresh] = vi.mocked(
      projectionSearch.applyMutations
    ).mock.calls[0]!;
    expect(refresh).toBe("NONE");
    expect(mutations[0]).toMatchObject({
      document: {
        generationId: "generation-1",
        lexicalText: "safe multilingual projection 東京",
        projectionSequence: 17n,
        userScope: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      operation: "UPSERT",
      sequence: 17n
    });
    expect(JSON.stringify(mutations, (_, value) =>
      typeof value === "bigint" ? value.toString() : value
    )).not.toContain("private-user-1");
    expect(projectionStore.settleSuccess).toHaveBeenCalledWith(current, now);
  });

  it("turns a stale sync event into a versioned delete", async () => {
    const current = claim();
    const projectionStore = store({
      claim: vi.fn(async () => [current]),
      loadCanonicalEntry: vi.fn(async () => null)
    });
    const projectionSearch = search();

    await runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    });

    expect(projectionSearch.applyMutations).toHaveBeenCalledWith([{
      operation: "DELETE",
      routing: expect.stringMatching(/^[a-f0-9]{64}$/u),
      searchEntryId: "entry-1",
      sequence: 17n
    }], "NONE");
  });

  it("projects independent owners in one bulk request", async () => {
    const first = claim();
    const second = Object.freeze({
      ...claim(),
      id: "20000000-0000-4000-8000-000000000002",
      leaseToken: "lease-2",
      searchEntryId: "entry-2",
      sequence: 18n,
      userId: "private-user-2"
    });
    const projectionStore = store({
      claim: vi.fn(async () => [first, second]),
      loadCanonicalEntry: vi.fn(async (current) => ({
        indexGenerationId: "generation-1",
        itemType: "RECALL_ROUND" as const,
        lexicalText: `safe projection ${current.searchEntryId}`,
        safeContentHash: "a".repeat(64),
        searchEntryId: current.searchEntryId!,
        sourceChatId: "chat-1",
        userId: current.userId
      }))
    });
    const projectionSearch = search({
      applyMutations: vi.fn(async () => ({
        applied: 2,
        opaqueId: "opaque",
        superseded: 0
      }))
    });

    await expect(runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    })).resolves.toMatchObject({ claimed: 2, failed: 0, projected: 2 });

    expect(projectionSearch.applyMutations).toHaveBeenCalledOnce();
    expect(vi.mocked(projectionSearch.applyMutations).mock.calls[0]![0])
      .toHaveLength(2);
    expect(projectionSearch.applyMutations).toHaveBeenCalledWith(
      expect.any(Array),
      "NONE"
    );
    expect(projectionStore.settleSuccess).toHaveBeenCalledTimes(2);
  });

  it("persists a typed retry when one external operation fails", async () => {
    const current = claim("DELETE_ENTRY");
    const projectionStore = store({
      claim: vi.fn(async () => [current])
    });
    const projectionSearch = search({
      applyMutations: vi.fn(async () => {
        throw new OpenSearchTransportError("opensearch_timeout", true);
      })
    });

    const result = await runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    });

    expect(result).toMatchObject({ claimed: 1, failed: 1, projected: 0 });
    expect(projectionStore.settleFailure).toHaveBeenCalledWith(current, {
      errorCode: "opensearch_timeout",
      maximumAttempts: 8,
      now
    });
    expect(projectionStore.settleSuccess).not.toHaveBeenCalled();
  });

  it("requires a canonical tombstone before a routed purge", async () => {
    const current = claim("PURGE_GENERATION");
    const projectionStore = store({
      claim: vi.fn(async () => [current]),
      purgeFenceExists: vi.fn(async () => false)
    });
    const projectionSearch = search();

    await runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    });

    expect(projectionSearch.purgeGeneration).not.toHaveBeenCalled();
    expect(projectionStore.settleFailure).toHaveBeenCalledWith(current, {
      errorCode: "memory_lexical_projection_generation_purge_fence_missing",
      maximumAttempts: 8,
      now
    });
  });

  it("refreshes and compares both content fingerprints before READY", async () => {
    const emptyFingerprint =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const candidate = { indexGenerationId: "generation-1", userId: "private-user-1" };
    const projectionStore = store({
      expectedGeneration: vi.fn(async () => ({
        analysisProfile: "memory-unicode-icu-v1",
        backendKind: "opensearch_icu_lexical_v1",
        documentCount: 0,
        enqueuedThroughSequence: 0n,
        fingerprint: emptyFingerprint,
        mappingVersion: "memory-lexical-mapping-v1",
        normalizationVersion: "memory-unicode-query-analysis-v1",
        projectionFingerprint: null,
        retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
        targetMemoryRevision: 0,
        visibleThroughSequence: 0n
      })),
      listVerificationCandidates: vi.fn(async () => [candidate]),
      settleIntegrity: vi.fn(async () => true)
    });
    const projectionSearch = search();

    const result = await runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    });

    expect(result.verifiedReady).toBe(1);
    expect(projectionSearch.refreshIndex).toHaveBeenCalledOnce();
    expect(projectionStore.settleIntegrity).toHaveBeenCalledWith(expect.objectContaining({
      expected: expect.objectContaining({ fingerprint: emptyFingerprint }),
      visibleFingerprint: emptyFingerprint
    }));
  });

  it("defers expensive generation verification while an ordered queue is active", async () => {
    const current = claim();
    const projectionStore = store({
      claim: vi.fn(async () => [current]),
      listVerificationCandidates: vi.fn(async () => [{
        indexGenerationId: "unrelated-generation",
        userId: "unrelated-user"
      }]),
      loadCanonicalEntry: vi.fn(async () => null)
    });
    const projectionSearch = search();

    await expect(runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      deferVerification: true,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      skipIndexValidation: true,
      store: projectionStore
    })).resolves.toMatchObject({ claimed: 1, projected: 1, verifiedReady: 0 });

    expect(projectionStore.listVerificationCandidates).not.toHaveBeenCalled();
    expect(projectionSearch.ensureIndex).not.toHaveBeenCalled();
    expect(projectionSearch.refreshIndex).not.toHaveBeenCalled();
  });

  it("never defers verification once the projection queue is idle", async () => {
    const emptyFingerprint =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const projectionStore = store({
      expectedGeneration: vi.fn(async () => ({
        analysisProfile: "memory-unicode-icu-v1",
        backendKind: "opensearch_icu_lexical_v1",
        documentCount: 0,
        enqueuedThroughSequence: 0n,
        fingerprint: emptyFingerprint,
        mappingVersion: "memory-lexical-mapping-v1",
        normalizationVersion: "memory-unicode-query-analysis-v1",
        projectionFingerprint: null,
        retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
        targetMemoryRevision: 0,
        visibleThroughSequence: 0n
      })),
      listVerificationCandidates: vi.fn(async () => [{
        indexGenerationId: "generation-idle",
        userId: "private-user-idle"
      }]),
      settleIntegrity: vi.fn(async () => true)
    });
    const projectionSearch = search();

    await expect(runMemoryLexicalProjectionPass({
      configuration: workerConfiguration,
      deferVerification: true,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    })).resolves.toMatchObject({ claimed: 0, verifiedReady: 1 });

    expect(projectionStore.listVerificationCandidates).toHaveBeenCalledOnce();
    expect(projectionSearch.refreshIndex).toHaveBeenCalledOnce();
    expect(MEMORY_LEXICAL_PROJECTION_MAX_DEFERRED_VERIFICATION_PASSES).toBe(64);
  });

  it("forces bounded verification during a continuously active queue", () => {
    expect(shouldDeferMemoryLexicalProjectionVerification(0)).toBe(true);
    expect(shouldDeferMemoryLexicalProjectionVerification(63)).toBe(true);
    expect(shouldDeferMemoryLexicalProjectionVerification(64)).toBe(false);
    expect(nextMemoryLexicalProjectionDeferredVerificationPasses(0, 3)).toBe(1);
    expect(nextMemoryLexicalProjectionDeferredVerificationPasses(63, 3)).toBe(64);
    expect(nextMemoryLexicalProjectionDeferredVerificationPasses(64, 3)).toBe(0);
    expect(nextMemoryLexicalProjectionDeferredVerificationPasses(12, 0)).toBe(0);
    expect(shouldRunMemoryLexicalProjectionMaintenance(false, 0)).toBe(true);
    expect(shouldRunMemoryLexicalProjectionMaintenance(true, 0)).toBe(false);
    expect(shouldRunMemoryLexicalProjectionMaintenance(true, 64)).toBe(true);
    expect(() => shouldDeferMemoryLexicalProjectionVerification(-1))
      .toThrow("memory_lexical_projection_verification_schedule_invalid");
  });

  it("builds a fresh physical index before atomically activating its aliases", async () => {
    const projectionStore = store();
    const projectionSearch = search();

    await expect(rebuildMemoryLexicalProjection({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    })).resolves.toMatchObject({
      failed: 0,
      projected: 0,
      purged: 0
    });

    expect(projectionStore.reset).toHaveBeenCalledWith({ mode: "REBUILD", now });
    expect(projectionSearch.prepareReplacementIndex).toHaveBeenCalledOnce();
    expect(projectionSearch.ensureIndex).not.toHaveBeenCalled();
    expect(projectionSearch.activateReplacementIndex).toHaveBeenCalledOnce();
    expect(vi.mocked(projectionSearch.prepareReplacementIndex).mock.invocationCallOrder[0])
      .toBeLessThan(
        vi.mocked(projectionStore.reset).mock.invocationCallOrder[0]!
      );
    expect(vi.mocked(projectionStore.reset).mock.invocationCallOrder[0])
      .toBeLessThan(
        vi.mocked(projectionSearch.activateReplacementIndex).mock.invocationCallOrder[0]!
      );
  });

  it("preserves projection readiness when replacement preflight rejects the build", async () => {
    const projectionStore = store();
    const projectionSearch = search({
      prepareReplacementIndex: vi.fn(async () => {
        throw new Error("opensearch_rebuild_requires_fresh_index");
      })
    });

    await expect(rebuildMemoryLexicalProjection({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    })).rejects.toThrow("opensearch_rebuild_requires_fresh_index");

    expect(projectionStore.reset).not.toHaveBeenCalled();
    expect(projectionSearch.activateReplacementIndex).not.toHaveBeenCalled();
  });

  it("audits every active generation against the refreshed physical index", async () => {
    const emptyFingerprint =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const candidates = [1, 2, 3].map((ordinal) => ({
      indexGenerationId: `generation-${ordinal}`,
      userId: `private-user-${ordinal}`
    }));
    const projectionStore = store({
      expectedGeneration: vi.fn(async () => ({
        analysisProfile: "memory-unicode-icu-v1",
        backendKind: "opensearch_icu_lexical_v1",
        documentCount: 0,
        enqueuedThroughSequence: 0n,
        fingerprint: emptyFingerprint,
        mappingVersion: "memory-lexical-mapping-v1",
        normalizationVersion: "memory-unicode-query-analysis-v1",
        projectionFingerprint: memoryOpenSearchProjectionFingerprint(
          openSearchConfiguration
        ),
        retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
        targetMemoryRevision: 0,
        visibleThroughSequence: 0n
      })),
      listIntegrityCandidates: vi.fn(async ({ after }) => after === null
        ? candidates.slice(0, 2)
        : after === candidates[1] ? candidates.slice(2) : [])
    });
    const projectionSearch = search();

    await expect(auditMemoryLexicalProjection({
      configuration: { ...workerConfiguration, verificationBatch: 2 },
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    })).resolves.toMatchObject({
      checkedGenerations: 3,
      mismatchedGenerations: 0
    });
    expect(projectionSearch.ensureIndex).toHaveBeenCalledOnce();
    expect(projectionSearch.refreshIndex).toHaveBeenCalledOnce();
    expect(projectionSearch.inspectGeneration).toHaveBeenCalledTimes(3);
  });

  it("does not switch aliases when rebuild integrity remains incomplete", async () => {
    const projectionStore = store({
      inspect: vi.fn(async () => ({
        blockedEvents: 0,
        claimedEvents: 0,
        degradedGenerations: 0,
        outstandingEvents: 1,
        readyGenerations: 0,
        retiredGenerations: 0,
        totalGenerations: 1,
        version: 1 as const
      }))
    });
    const projectionSearch = search();

    await expect(rebuildMemoryLexicalProjection({
      configuration: workerConfiguration,
      now,
      openSearchConfiguration,
      search: projectionSearch,
      store: projectionStore
    })).rejects.toThrow("memory_lexical_projection_rebuild_incomplete");
    expect(projectionSearch.activateReplacementIndex).not.toHaveBeenCalled();
  });

  it("fails closed on unbounded worker settings", () => {
    expect(() => memoryLexicalProjectionWorkerConfigurationFromEnv({
      AIQSA_MEMORY_OPENSEARCH_PROJECTION_BATCH: "101"
    })).toThrow("memory_lexical_projection_worker_configuration_invalid");
  });
});
