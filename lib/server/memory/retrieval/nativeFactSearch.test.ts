import { describe, expect, it, vi } from "vitest";
import type {
  MemoryCandidateMetadata,
  MemoryExpandedCandidate,
  MemoryLaneCandidate,
  MemoryRankedCandidate,
  MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import { MEMORY_DECAY_POLICY_VERSION } from "../../../domain/memory/retrieval";
import { memoryDetailFixture, memorySummaryFixture } from "../../../../tests/support/memoryFixtures";
import type { MemoryConsumerRefService } from "../consumer/ref";
import { MemoryConsumerServiceError } from "../consumer/service";
import type { MemoryRunUtilityService } from "./runUtilities";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  type MemoryVectorProfile
} from "./vector";
import {
  createMemoryNativeFactSearchService,
  type MemoryNativeFactSearchDependencies
} from "./nativeFactSearch";

const now = new Date("2026-09-03T10:00:00.000Z");
const signal = new AbortController().signal;
const profile: MemoryVectorProfile = Object.freeze({
  configurationFingerprint: "a".repeat(64),
  connectionId: "connection-1",
  dimension: 1_024,
  generationId: "generation-1",
  minimumSimilarity: 0.55,
  providerModelId: "embedding-model-1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  vectorSpaceFingerprint: "b".repeat(64)
});

function metadata(factId: string): MemoryCandidateMetadata {
  return {
    canonicalKey: null,
    category: "about_you",
    confidence: 1,
    conflict: false,
    coreEligible: false,
    coreSalience: "NONE",
    current: true,
    dedupeKey: factId,
    directness: "DIRECT",
    dimensionKey: null,
    entityIds: [],
    expectedAt: null,
    expiresAt: null,
    factId,
    historical: false,
    historySafetyClass: null,
    identityKind: "PROPOSITION",
    importance: 0,
    languageCode: "ru",
    lastConfirmedAt: now,
    lastUsedAt: null,
    lifecycleState: "ACTIVE",
    matchedEntityRole: null,
    modality: "STATE",
    observedAt: now,
    occurredAt: null,
    occurredFrom: null,
    occurredTo: null,
    pinned: false,
    predicateKey: null,
    relationDepth: 0,
    scopeAffinity: 0,
    scopeType: "GLOBAL_USER",
    sensitivityClass: "NORMAL",
    sourceAssistantId: null,
    sourceAuthority: "EXPLICIT",
    sourceChatId: null,
    sourceFolderId: null,
    sourceMode: "EXPLICIT",
    subjectKey: null,
    synthesisDepth: 0,
    systemFrom: now,
    temperatureClass: null,
    temperatureScore: 0,
    validFrom: null,
    validTo: null
  };
}

function factCandidate(
  factId: string,
  versionId: string,
  lane: MemoryLaneCandidate["lane"] = "FACT_VECTOR"
): MemoryLaneCandidate {
  return {
    entryId: `entry-${versionId}`,
    hardFilterPassed: true,
    itemId: versionId,
    itemType: "FACT_VERSION",
    lane,
    metadata: metadata(factId),
    rawScore: 0.8
  };
}

function historyCandidate(): MemoryLaneCandidate {
  return {
    ...factCandidate("not-a-fact", "history-version", "HISTORY_RECALL_VECTOR"),
    itemType: "RECALL_CHUNK",
    metadata: {
      ...metadata("not-a-fact"),
      factId: null,
      historySafetyClass: "NORMAL",
      lifecycleState: null,
      sourceAuthority: "PAST_CHAT",
      sourceChatId: "past-chat",
      sourceMode: null
    }
  };
}

function expansion(candidate: MemoryRankedCandidate): MemoryExpandedCandidate {
  return {
    itemId: candidate.itemId,
    itemType: "FACT_VERSION",
    occurredFrom: null,
    occurredTo: null,
    projectionKind: "FACT_DISPLAY_TEXT",
    safeText: candidate.metadata.factId === "fact-target"
      ? "Меня зовут Дмитрий."
      : `Fact ${candidate.metadata.factId}`,
    sourceChatId: null,
    supportingItemId: null
  };
}

function snapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    activeGenerationId: "generation-1",
    assistantId: null,
    chatId: null,
    chatMemoryMode: "NORMAL" as const,
    contextualKeyPolicyVersion: "contextual-key-v1",
    decayEnabled: false,
    decayPolicyVersion: null,
    folderId: null,
    historyAuthorityRevision: null,
    indexMode: "HYBRID" as const,
    memoryGeneration: 2,
    memoryRevision: 4,
    reason: "ready",
    referenceChatHistory: false,
    repositoryVersion: "native-fact-search-test",
    roundProjectionVersion: "round-v1",
    roundSegmentProjectionVersion: "round-segment-v1",
    settingsRevision: 3,
    status: "READY" as const,
    useMemoryFacts: true,
    userId: "user-1",
    ...overrides
  };
}

function refs(): MemoryConsumerRefService {
  return {
    mintCursor: vi.fn(() => "mcm1.cursor"),
    mintItem: vi.fn((_userId, value) => `mcm1.${value.factId}`),
    resolveCursor: vi.fn(() => null),
    resolveItem: vi.fn(() => null)
  };
}

function detail(factId: string, versionId: string) {
  return memoryDetailFixture(memorySummaryFixture({
    category: "about_you",
    createdAt: now.toISOString(),
    currentVersionId: versionId,
    displayText: factId === "fact-target"
      ? "Меня зовут Дмитрий."
      : `Fact ${factId}`,
    id: factId,
    indexingState: "HYBRID_READY",
    lastConfirmedAt: now.toISOString(),
    sourceMode: "EXPLICIT",
    updatedAt: now.toISOString()
  }));
}

describe("native facts-only Memory search", () => {
  it("uses native hybrid ranking for a vector-only semantic match", async () => {
    const target = factCandidate("fact-target", "version-target");
    const distractor = factCandidate("fact-distractor", "version-distractor");
    const state = snapshot({
      decayEnabled: true,
      decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION
    });
    const retrieve = vi.fn(async (input: Readonly<{
      plan: MemoryRetrievalPlan;
      vector?: unknown;
    }>) => ({
      core: [],
      laneResults: [{ candidates: [distractor, target], lane: "FACT_VECTOR" as const }],
      lexicalEvidence: [],
      lexicalFailures: [],
      lexicalState: "READY" as const,
      snapshot: state,
      vectorEvidence: [],
      vectorState: "READY" as const,
      input
    }));
    const expand = vi.fn(async (
      _snapshot: unknown,
      _plan: MemoryRetrievalPlan,
      ranked: readonly MemoryRankedCandidate[]
    ) => ranked.map(expansion));
    const embedQuery = vi.fn(async () => ({
      bindingId: "embedding-binding",
      profile,
      status: "READY" as const,
      vector: [0.1, 0.2, 0.3]
    }));
    const rerank = vi.fn(async (
      input: Parameters<MemoryRunUtilityService["rerank"]>[0]
    ) => ({
      bindingId: "rerank-binding",
      decisions: input.candidates.map((candidate) => ({
        applicable: null,
        current: null,
        handle: candidate.handle,
        reasonCode: "SCORE_ONLY" as const,
        relevanceScore: candidate.text === "Меня зовут Дмитрий." ? 0.98 : 0.7
      })),
      status: "READY" as const
    }));
    const get = vi.fn(async (_userId: string, factId: string) =>
      detail(factId, factId === "fact-target"
        ? "version-target"
        : "version-distractor"));
    const scheduleTouch = vi.fn();
    const service = createMemoryNativeFactSearchService({
      clock: () => now,
      explicitService: { get },
      refs: refs(),
      repository: {
        expand,
        retrieve,
        snapshot: vi.fn(async () => state)
      } as MemoryNativeFactSearchDependencies["repository"],
      scheduleTouch,
      utilities: { embedQuery, rerank },
      vectorRepository: {
        resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const }))
      }
    });

    const result = await service.search("user-1", {
      limit: 1,
      query: "What should I call you?",
      requestId: "request-1",
      signal
    });

    expect(result.items.map(({ statement }) => statement)).toEqual([
      "Меня зовут Дмитрий."
    ]);
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: null,
      chatId: null,
      userId: "user-1",
      vector: expect.objectContaining({ profile, vector: [0.1, 0.2, 0.3] })
    }));
    const retrievalInput = retrieve.mock.calls[0]?.[0];
    expect(retrievalInput?.plan).toMatchObject({
      aggregationRequested: false,
      applyResponsePreferences: false,
      includePatterns: false,
      mode: "TARGETED_CURRENT",
      profileRequested: false,
      recencyRequested: false,
      temporalIntent: "ANY"
    });
    expect(retrievalInput?.plan.filters.sourceKinds).toEqual(["FACT"]);
    expect(retrievalInput?.plan.semanticQueryVariants).toEqual([{
      kind: "ORIGINAL",
      text: "What should I call you?"
    }]);
    expect(embedQuery).toHaveBeenCalledWith(expect.objectContaining({
      owner: {
        inboundMcpRequestId: "request-1",
        type: "INBOUND_MCP_REQUEST"
      },
      query: "What should I call you?",
      userId: "user-1"
    }));
    expect(rerank).toHaveBeenCalledWith(expect.objectContaining({
      owner: {
        inboundMcpRequestId: "request-1",
        type: "INBOUND_MCP_REQUEST"
      },
      query: "What should I call you?",
      retrievalMode: "TARGETED_CURRENT",
      userId: "user-1"
    }));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("user-1", "fact-target");
    expect(scheduleTouch).toHaveBeenCalledWith({
      facts: [{ factId: "fact-target", factVersionId: "version-target" }],
      now,
      userId: "user-1"
    });
  });

  it("falls back to fused order while keeping final fact authority fail-closed", async () => {
    const first = factCandidate("fact-first", "version-first", "FACT_LEXICAL_UNICODE");
    const stale = factCandidate("fact-stale", "version-stale", "FACT_LEXICAL_UNICODE");
    const changed = factCandidate("fact-changed", "version-old", "FACT_LEXICAL_UNICODE");
    const history = historyCandidate();
    const state = snapshot();
    let expansionCall = 0;
    const expand = vi.fn(async (
      _snapshot: unknown,
      _plan: MemoryRetrievalPlan,
      ranked: readonly MemoryRankedCandidate[]
    ) => {
      expansionCall += 1;
      return ranked
        .filter((candidate) => expansionCall === 1 || candidate.itemId !== "version-stale")
        .map(expansion);
    });
    const embedQuery = vi.fn(async () => ({
      reason: "embedding_provider_unavailable",
      status: "UNAVAILABLE" as const
    }));
    const rerank = vi.fn(async () => ({
      reason: "reranker_provider_unavailable",
      status: "UNAVAILABLE" as const
    }));
    const get = vi.fn(async (_userId: string, factId: string) =>
      detail(factId, factId === "fact-changed" ? "version-new" : `version-${factId.slice(5)}`));
    const service = createMemoryNativeFactSearchService({
      clock: () => now,
      explicitService: { get },
      refs: refs(),
      repository: {
        expand,
        retrieve: vi.fn(async () => ({
          core: [],
          laneResults: [{
            candidates: [first, stale, changed],
            lane: "FACT_LEXICAL_UNICODE" as const
          }, {
            candidates: [history],
            lane: "HISTORY_RECALL_VECTOR" as const
          }],
          lexicalEvidence: [],
          lexicalFailures: [],
          lexicalState: "READY" as const,
          snapshot: state,
          vectorEvidence: [],
          vectorState: "DEGRADED" as const
        })),
        snapshot: vi.fn(async () => state)
      } as MemoryNativeFactSearchDependencies["repository"],
      utilities: { embedQuery, rerank },
      vectorRepository: {
        resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const }))
      }
    });

    const result = await service.search("user-1", {
      limit: 20,
      query: "ordinary retrieval",
      requestId: "request-2",
      signal
    });

    expect(result.items.map(({ statement }) => statement)).toEqual(["Fact fact-first"]);
    expect(expand).toHaveBeenCalledTimes(2);
    expect(expand.mock.calls[0]?.[2].map(({ itemId }) => itemId)).toEqual([
      "version-first", "version-stale", "version-old"
    ]);
    expect(expand.mock.calls[1]?.[2].map(({ itemId }) => itemId)).toEqual([
      "version-first", "version-stale", "version-old"
    ]);
    expect(get).toHaveBeenCalledWith("user-1", "fact-first");
    expect(get).toHaveBeenCalledWith("user-1", "fact-changed");
    expect(get).not.toHaveBeenCalledWith("user-1", "fact-stale");
  });

  it("rejects settings or generation drift before projecting any result", async () => {
    const initial = snapshot();
    const changed = snapshot({ memoryRevision: 5 });
    const snapshotRead = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    const get = vi.fn();
    const service = createMemoryNativeFactSearchService({
      clock: () => now,
      explicitService: { get },
      refs: refs(),
      repository: {
        expand: vi.fn(async (
          _snapshot: unknown,
          _plan: MemoryRetrievalPlan,
          ranked: readonly MemoryRankedCandidate[]
        ) => ranked.map(expansion)),
        retrieve: vi.fn(async () => ({
          core: [],
          laneResults: [{
            candidates: [factCandidate("fact-target", "version-target")],
            lane: "FACT_VECTOR" as const
          }],
          lexicalEvidence: [],
          lexicalFailures: [],
          lexicalState: "READY" as const,
          snapshot: initial,
          vectorEvidence: [],
          vectorState: "READY" as const
        })),
        snapshot: snapshotRead
      } as MemoryNativeFactSearchDependencies["repository"],
      utilities: {
        embedQuery: vi.fn(async () => ({
          bindingId: "embedding-binding",
          profile,
          status: "READY" as const,
          vector: [0.1, 0.2, 0.3]
        })),
        rerank: vi.fn(async () => ({
          reason: "reranker_provider_unavailable",
          status: "UNAVAILABLE" as const
        }))
      },
      vectorRepository: {
        resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const }))
      }
    });

    await expect(service.search("user-1", {
      limit: 20,
      query: "What should I call you?",
      requestId: "request-3",
      signal
    })).rejects.toMatchObject({
      code: "memory_unavailable"
    } satisfies Partial<MemoryConsumerServiceError>);
    expect(get).not.toHaveBeenCalled();
  });
});
