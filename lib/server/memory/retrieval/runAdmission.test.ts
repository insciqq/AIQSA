import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import type {
  MemoryCandidateMetadata,
  MemoryCoreCandidate,
  MemoryExpandedCandidate,
  MemoryLaneCandidate,
  MemoryRankedCandidate,
  MemoryRetrievalLane,
  MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import {
  MEMORY_DECAY_POLICY_VERSION,
  planMemoryRetrieval
} from "../../../domain/memory/retrieval";
import type { NormalizedRunRequest } from "../../providers/types";
import { MEMORY_ACTION_NO_COMMIT_RESULT } from "../../providers/memoryActionAnswer";
import {
  validateMemoryPreparingAttemptResult,
  type MemoryPreparingSettingsSnapshot
} from "../../runs/preparingRun";
import type { PrismaLocalMemoryRetrievalRepository } from "./localRepository";
import type { MemoryControlService } from "../actions/controlRuntime";
import {
  applyMemoryRelevance,
  createMemoryRunRetrievalService,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS,
  MEMORY_AGGREGATION_OPTIONAL_MAXIMUM_MS,
  MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS,
  MEMORY_RERANK_OPTIONAL_MAXIMUM_MS,
  memoryRelevanceCandidates,
  selectMemoryAggregationRawCandidates,
  type MemoryRunControlCache,
  type MemoryRunRetrievalExpectedSnapshot
} from "./runAdmission";
import type { MemoryRunUtilityService } from "./runUtilities";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT, type MemoryVectorProfile } from "./vector";

const now = new Date("2026-08-13T10:00:00.000Z");
const currentControlContract = Object.freeze({
  aggregationRequested: false,
  retrievalMode: "TARGETED_CURRENT" as const,
  temporalAsOf: null,
  temporalFrom: null,
  temporalIntent: "CURRENT" as const,
  temporalTo: null
});

function settings(activeIndexGenerationId: string | null): MemoryPreparingSettingsSnapshot {
  return {
    acceptedUtilityEgressFingerprint: null,
    acceptedUtilityPolicyVersion: null,
    activeIndexGenerationId,
    decayEnabled: false,
    decayPolicyVersion: null,
    learnAutomatically: true,
    memoryConsentRevision: 0,
    referenceChatHistory: true,
    schemaVersion: 2,
    settingsRevision: 3,
    useMemoryFacts: true
  };
}

function expected(activeIndexGenerationId: string | null): MemoryRunRetrievalExpectedSnapshot {
  return {
    activeIndexGenerationId,
    assistantId: null,
    chatMemoryMode: "NORMAL",
    folderId: null,
    memoryGeneration: 2,
    memoryRevision: 4,
    settings: settings(activeIndexGenerationId)
  };
}

function request(text: string): NormalizedRunRequest {
  const content = textMessageContent(text);
  return {
    attachmentIds: [], chatId: "chat-current", content,
    context: { messages: [{ content, id: "current", role: "user" }], mode: "branch_path" },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false,
      reasoning: false, toolCalling: true, vision: false },
    modelId: "model-1", params: {}, prompt: { developer: null, system: null },
    provider: "provider-1", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
}

function metadata(id: string, history = false): MemoryCandidateMetadata {
  return {
    canonicalKey: null, category: history ? null : "memory", confidence: 0,
    conflict: false, coreEligible: !history, coreSalience: history ? "NONE" : "HIGH",
    current: true, dedupeKey: id, directness: history ? null : "DIRECT",
    dimensionKey: null, entityIds: [], expectedAt: null, expiresAt: null,
    factId: history ? null : id, historical: false,
    historySafetyClass: history ? "NORMAL" : null, importance: 0, languageCode: "und",
    identityKind: history ? null : "PROPOSITION",
    lastConfirmedAt: null, lastUsedAt: null,
    lifecycleState: history ? null : "ACTIVE", matchedEntityRole: null,
    modality: history ? null : "PREFERENCE", observedAt: null, occurredAt: null,
    occurredFrom: history ? now : null,
    occurredTo: history ? new Date(now.getTime() + 60_000) : null,
    pinned: false, predicateKey: null, relationDepth: 0, scopeAffinity: 0,
    scopeType: history ? null : "GLOBAL_USER", sensitivityClass: history ? null : "NORMAL",
    sourceAssistantId: null, sourceChatId: history ? "chat-source" : null,
    sourceFolderId: null, sourceMode: history ? null : "EXPLICIT", systemFrom: now,
    sourceAuthority: history ? "PAST_CHAT" : "EXPLICIT", subjectKey: null,
    synthesisDepth: 0, temperatureClass: null, temperatureScore: 0,
    validFrom: null, validTo: null
  };
}

function laneCandidate(id: string): MemoryLaneCandidate {
  return {
    entryId: `entry-${id}`, hardFilterPassed: true, itemId: id,
    itemType: "RECALL_CHUNK", lane: "HISTORY_RECALL_VECTOR",
    metadata: metadata(id, true), rawScore: 0.2
  };
}

function factLaneCandidate(id: string, rawScore: number): MemoryLaneCandidate {
  return {
    entryId: `entry-${id}`,
    hardFilterPassed: true,
    itemId: id,
    itemType: "FACT_VERSION",
    lane: "FACT_VECTOR",
    metadata: {
      ...metadata(id),
      category: "identity",
      coreEligible: false,
      languageCode: "en",
      modality: "STATE"
    },
    rawScore
  };
}

function profileFactLaneCandidate(id: string, rawScore: number): MemoryLaneCandidate {
  return {
    ...factLaneCandidate(id, rawScore),
    deterministicMatch: "PROFILE",
    entryId: null,
    lane: "FACT_PROFILE"
  };
}

function rankedHistory(
  id: string,
  historySafetyClass: "NORMAL" | "SENSITIVE"
): MemoryRankedCandidate {
  return {
    entryId: `entry-${id}`,
    featureSnapshot: {
      authorityRank: 0, fusionVersion: "rrf", laneCount: 1,
      temporalFit: 1, tier: "DYNAMIC"
    },
    finalScore: 0.2,
    itemId: id,
    itemType: "RECALL_CHUNK",
    laneRanks: { HISTORY_RECALL_VECTOR: 1 },
    metadata: { ...metadata(id, true), historySafetyClass },
    rrfScore: 0.2,
    selectionReason: "rrf"
  };
}

function expandedHistory(id: string): MemoryExpandedCandidate {
  return {
    itemId: id,
    itemType: "RECALL_CHUNK",
    occurredFrom: now,
    occurredTo: new Date(now.getTime() + 60_000),
    projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
    safeText: `history ${id}`,
    sourceChatId: "chat-source",
    supportingItemId: null
  };
}

function core(id = "core-version"): MemoryCoreCandidate {
  const candidate: MemoryRankedCandidate = {
    entryId: null,
    featureSnapshot: {
      authorityRank: 3, fusionVersion: "rrf", laneCount: 0,
      temporalFit: 1, tier: "CORE"
    },
    finalScore: 0, itemId: id, itemType: "FACT_VERSION", laneRanks: {},
    metadata: metadata(id), rrfScore: 0, selectionReason: "core.high"
  };
  return {
    candidate,
    expansion: { itemId: id, itemType: "FACT_VERSION", occurredFrom: null,
      occurredTo: null, projectionKind: "FACT_DISPLAY_TEXT",
      safeText: "User prefers concise answers", sourceChatId: null, supportingItemId: null }
  };
}

function responsePreferenceCore(id = "core-version"): MemoryCoreCandidate {
  const value = core(id);
  return {
    ...value,
    candidate: {
      ...value.candidate,
      metadata: { ...value.candidate.metadata, category: "preferences" }
    }
  };
}

function snapshot(activeIndexGenerationId: string | null) {
  return {
    activeGenerationId: activeIndexGenerationId, assistantId: null, chatId: "chat-current",
    chatMemoryMode: "NORMAL" as const, folderId: null,
    decayEnabled: false, decayPolicyVersion: null,
    historySuppressionIdentitySnapshot: "a".repeat(64),
    indexMode: activeIndexGenerationId ? "HYBRID" as const : null,
    memoryGeneration: 2, memoryRevision: 4,
    reason: activeIndexGenerationId ? "ready" : "memory_index_unavailable",
    referenceChatHistory: true, repositoryVersion: "test", settingsRevision: 3,
    status: "READY" as const, useMemoryFacts: true, userId: "user-1"
  };
}

function repository(options: Readonly<{
  activeIndexGenerationId?: string | null;
  candidates?: readonly MemoryLaneCandidate[];
  core?: readonly MemoryCoreCandidate[];
  decayEnabled?: boolean;
  lexicalFailures?: readonly MemoryRetrievalLane[];
  lexicalState?: "DEGRADED" | "DISABLED" | "FAILED" | "READY";
  projectAggregationSessions?: (
    ranked: readonly MemoryRankedCandidate[]
  ) => readonly MemoryRankedCandidate[];
  vectorState?: "DEGRADED" | "DISABLED" | "NOT_CONFIGURED" | "READY";
}> = {}) {
  const activeIndexGenerationId = options.activeIndexGenerationId === undefined
    ? "generation-1" : options.activeIndexGenerationId;
  const state = {
    ...snapshot(activeIndexGenerationId),
    decayEnabled: options.decayEnabled ?? false,
    decayPolicyVersion: options.decayEnabled ? MEMORY_DECAY_POLICY_VERSION : null
  };
  const candidates = options.candidates ?? [];
  const retrieve = vi.fn(async (_input: { plan: MemoryRetrievalPlan; vector?: unknown }) => ({
    core: options.core ?? [],
    laneResults: [...new Set(candidates.map(({ lane }) => lane))].map((lane) => ({
      candidates: candidates.filter((candidate) => candidate.lane === lane),
      lane
    })),
    lexicalFailures: options.lexicalFailures ?? [],
    lexicalState: options.lexicalState ??
      (activeIndexGenerationId ? "READY" as const : "DISABLED" as const),
    snapshot: state, vectorEvidence: [],
    vectorState: options.vectorState ??
      (activeIndexGenerationId ? "READY" as const : "NOT_CONFIGURED" as const)
  }));
  const coreByKey = new Map((options.core ?? []).map((entry) => [
    `${entry.candidate.itemType}:${entry.candidate.itemId}`,
    entry.expansion
  ]));
  const projectAggregationSessions = vi.fn(async (
    _snapshot: unknown,
    _plan: MemoryRetrievalPlan,
    ranked: readonly MemoryRankedCandidate[]
  ) => options.projectAggregationSessions?.(ranked) ?? ranked);
  const expand = vi.fn(async (
    _snapshot: unknown,
    _plan: MemoryRetrievalPlan,
    ranked: readonly MemoryRankedCandidate[]
  ) => ranked.map((candidate): MemoryExpandedCandidate => {
    const coreExpansion = coreByKey.get(`${candidate.itemType}:${candidate.itemId}`);
    if (coreExpansion) return coreExpansion;
    return candidate.itemType === "RECALL_CHUNK"
      ? {
          itemId: candidate.itemId,
          itemType: "RECALL_CHUNK",
          occurredFrom: now,
          occurredTo: new Date(now.getTime() + 60_000),
          projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
          safeText: `relevant text ${candidate.itemId}`,
          sourceChatId: candidate.metadata.sourceChatId,
          supportingItemId: null
        }
      : {
          itemId: candidate.itemId,
          itemType: "FACT_VERSION",
          occurredFrom: null,
          occurredTo: null,
          projectionKind: "FACT_DISPLAY_TEXT",
          safeText: `relevant text ${candidate.itemId}`,
          sourceChatId: null,
          supportingItemId: null
        };
  }));
  const value = {
    expand,
    expandAggregationNavigation: expand,
    projectAggregationSessions,
    retrieve,
    snapshot: vi.fn(async () => state)
  } as unknown as PrismaLocalMemoryRetrievalRepository;
  return { projectAggregationSessions, retrieve, value };
}

function runInput(text: string, activeIndexGenerationId: string | null = "generation-1") {
  return { attemptId: "attempt-1", chatId: "chat-current",
    expected: expected(activeIndexGenerationId), modelRunId: "run-1",
    normalizedRequest: request(text), now, userId: "user-1" };
}

const profile: MemoryVectorProfile = {
  configurationFingerprint: "b".repeat(64), connectionId: "connection-1",
  dimension: 1_024, generationId: "generation-1", providerModelId: "embedding-1",
  minimumSimilarity: 0.55,
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  vectorSpaceFingerprint: "c".repeat(64)
};

function utilities(relevantHandles: readonly string[] | null): MemoryRunUtilityService {
  return {
    aggregate: vi.fn(async (
      input: Parameters<MemoryRunUtilityService["aggregate"]>[0]
    ) => ({
      bindingId: "binding-aggregation",
      plan: {
        groups: input.evidence.map((item) => ({
          itemHandles: [item.handle],
          occurrence: item.text,
          quantity: 1,
          quantityEvidence: item.text,
          role: "MEMBER" as const
        })),
        operation: "COUNT" as const,
        resolution: "RESOLVED" as const
      },
      status: "READY" as const
    })),
    embedQuery: vi.fn(async () => ({ bindingId: "binding-embedding", profile,
      status: "READY" as const,
      vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0) })),
    rerank: vi.fn(async (input: Parameters<MemoryRunUtilityService["rerank"]>[0]) => relevantHandles === null
      ? { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" as const }
      : { bindingId: "binding-relevance", decisions: input.candidates.map((candidate) => ({
          applicable: relevantHandles.includes(candidate.handle),
          current: true,
          handle: candidate.handle,
          reasonCode: relevantHandles.includes(candidate.handle)
            ? "DIRECT_RELEVANCE" as const : "NOT_RELEVANT" as const,
          relevanceScore: relevantHandles.includes(candidate.handle) ? 0.9 : 0.1
        })), status: "READY" as const })
  } as MemoryRunUtilityService;
}

function retrievalOptions(
  relevantHandles: readonly string[] | null,
  recencyRequested = false
) {
  return {
    control: {
      decide: vi.fn(async (input: Parameters<MemoryControlService["decide"]>[0]) => ({
        bindingId: "binding-control",
        intent: {
          action: "NONE" as const,
          aggregationRequested: false,
          applyResponsePreferences: true,
          category: null,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
          entityMentions: [],
          includePatterns: false,
          memoryUseful: true,
          pastChatsUseful: true,
          profileRequested: false,
          queryText: input.context.currentUserMessage,
          reasonCode: "none" as const,
          recencyRequested,
          retrievalMode: "TARGETED_CURRENT" as const,
          referencedMemoryRef: null,
          replacementStatement: null,
          responsePreference: false,
          sensitiveDomainHint: null,
          sensitivity: "NORMAL" as const,
          statement: null,
          targetQuery: null,
          temporalAsOf: null,
          temporalFrom: null,
          temporalIntent: "CURRENT" as const,
          temporalTo: null,
          thisChatOnly: false
        },
        status: "READY" as const
      }))
    },
    utilities: utilities(relevantHandles),
    vectorRepository: {
      resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const }))
    }
  };
}

function intentOptions(overrides: Record<string, unknown>) {
  const base = retrievalOptions(["c0"]);
  return {
    ...base,
    control: {
      decide: vi.fn(async (input: Parameters<MemoryControlService["decide"]>[0]) => ({
        bindingId: "binding-control",
        intent: {
          action: "NONE" as const,
          aggregationRequested: false,
          applyResponsePreferences: false,
          category: null,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
          entityMentions: [],
          includePatterns: false,
          memoryUseful: false,
          pastChatsUseful: false,
          profileRequested: false,
          queryText: input.context.currentUserMessage,
          reasonCode: "none" as const,
          recencyRequested: false,
          retrievalMode: "TARGETED_CURRENT" as const,
          referencedMemoryRef: null,
          replacementStatement: null,
          responsePreference: false,
          sensitiveDomainHint: null,
          sensitivity: "NORMAL" as const,
          statement: null,
          targetQuery: null,
          temporalAsOf: null,
          temporalFrom: null,
          temporalIntent: "CURRENT" as const,
          temporalTo: null,
          thisChatOnly: false,
          ...overrides
        },
        status: "READY" as const
      }))
    }
  };
}

function resolveWhenAborted<T>(signal: AbortSignal, value: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(value);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(value), { once: true });
  });
}

describe("Personal Memory v1 run admission", () => {
  it("times out optional control early and keeps deterministic local evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("control-timeout-local")] });
      const base = retrievalOptions([]);
      const receivedSignals: AbortSignal[] = [];
      const decide = vi.fn((input: Parameters<MemoryControlService["decide"]>[0]) => {
        receivedSignals.push(input.signal);
        return resolveWhenAborted(input.signal, {
          reason: "memory_action_intent_unavailable",
          status: "UNAVAILABLE" as const
        });
      });
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        admissionDeadlineMs: 25,
        clock: Date.now,
        control: { decide }
      }).retrieve(runInput("What do I prefer?"));

      await vi.advanceTimersByTimeAsync(11);
      expect(receivedSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(receivedSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          degradationCode: "memory_action_intent_unavailable",
          plannerFallbackReason: "memory_action_intent_unavailable"
        },
        items: [{ exactItemId: "control-timeout-local" }],
        outcome: "DEGRADED"
      });
      expect(base.utilities.embedQuery).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors temporal planning in the accepted zone and emits content-free lane metrics", async () => {
    const filteredBase = factLaneCandidate("temporal-hit", 1);
    const unrestrictedBase = factLaneCandidate("temporal-fallback", 0.5);
    const local = repository({
      candidates: [{
        ...filteredBase,
        lane: "FACT_TEMPORAL_FILTERED",
        metadata: {
          ...filteredBase.metadata,
          occurredAt: new Date("2026-08-12T12:00:00.000Z")
        }
      }, {
        ...unrestrictedBase,
        lane: "FACT_TEMPORAL_UNRESTRICTED",
        metadata: {
          ...unrestrictedBase.metadata,
          occurredAt: new Date("2026-07-01T12:00:00.000Z")
        }
      }]
    });
    const input = runInput("What happened yesterday?");
    input.normalizedRequest = {
      ...input.normalizedRequest,
      prompt: {
        ...input.normalizedRequest.prompt,
        baseline: {
          source: "standard_chat",
          timeZone: "America/Los_Angeles",
          timeZoneSource: "client"
        }
      }
    };
    const result = await createMemoryRunRetrievalService(
      local.value,
      retrievalOptions(null)
    ).retrieve(input);

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        temporalQuery: expect.objectContaining({
          confidence: "HIGH",
          expressionType: "RELATIVE_DAY",
          state: "MATCHED"
        }),
        temporalQueryVariants: [
          { kind: "FILTERED", text: "What happened yesterday?" },
          { kind: "UNRESTRICTED", text: "What happened yesterday?" }
        ]
      })
    }));
    const budget = result.budgetSnapshot as Record<string, unknown>;
    expect(budget.componentMetrics).toMatchObject({
      temporalFilteredCandidateCount: 1,
      temporalParserConfidence: "HIGH",
      temporalParserState: "MATCHED",
      temporalParserType: "RELATIVE_DAY",
      temporalUnrestrictedCandidateCount: 1
    });
    expect(budget.plan).toMatchObject({
      temporalQuery: {
        confidence: "HIGH",
        expressionCount: 1,
        state: "MATCHED",
        type: "RELATIVE_DAY"
      }
    });
    const metricsJson = JSON.stringify(budget.componentMetrics);
    expect(metricsJson).not.toContain("What happened yesterday");
    expect(metricsJson).not.toContain("America/Los_Angeles");
    expect(metricsJson).not.toContain("user-1");
  });

  it("times out optional query embedding without hiding lexical evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("embedding-timeout-local")] });
      const base = retrievalOptions([]);
      const controlSignals: AbortSignal[] = [];
      const embeddingSignals: AbortSignal[] = [];
      const control = {
        decide: vi.fn(async (input: Parameters<MemoryControlService["decide"]>[0]) => {
          controlSignals.push(input.signal);
          return base.control.decide(input);
        })
      };
      const utilitiesWithHangingEmbedding: MemoryRunUtilityService = {
        ...base.utilities,
        embedQuery: vi.fn((input) => {
          embeddingSignals.push(input.signal);
          return resolveWhenAborted(input.signal, {
            bindingId: "binding-embedding",
            reason: "memory_query_embedding_unavailable",
            status: "UNAVAILABLE" as const
          });
        })
      };
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        admissionDeadlineMs: 25,
        clock: Date.now,
        control,
        utilities: utilitiesWithHangingEmbedding
      }).retrieve(runInput("What do I prefer?"));

      await vi.advanceTimersByTimeAsync(8);
      const result = await pending;

      expect(controlSignals[0]).not.toBe(embeddingSignals[0]);
      expect(controlSignals[0]?.aborted).toBe(false);
      expect(embeddingSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          degradationCode: "memory_query_embedding_unavailable",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        },
        items: [{ exactItemId: "embedding-timeout-local" }],
        outcome: "DEGRADED"
      });
      expect(local.retrieve).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("budgets both bounded query-embedding attempts inside one admission deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("embedding-budget-local")] });
      const base = retrievalOptions([]);
      const embeddingSignals: AbortSignal[] = [];
      const utilitiesWithHangingEmbedding: MemoryRunUtilityService = {
        ...base.utilities,
        embedQuery: vi.fn((input) => {
          embeddingSignals.push(input.signal);
          return resolveWhenAborted(input.signal, {
            bindingId: "binding-embedding",
            reason: "memory_query_embedding_unavailable",
            status: "UNAVAILABLE" as const
          });
        })
      };
      let settled = false;
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        utilities: utilitiesWithHangingEmbedding
      }).retrieve(runInput("What do I prefer?"))
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(
        MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS - 1
      );
      expect(settled).toBe(false);
      expect(embeddingSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        budgetSnapshot: { degradationCode: "memory_query_embedding_unavailable" },
        items: [{ exactItemId: "embedding-budget-local" }],
        outcome: "DEGRADED"
      });
      expect(embeddingSignals[0]?.aborted).toBe(true);
      expect(MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS).toBe(16_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out optional reranking and preserves RRF order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("pending-rerank")] });
      const base = retrievalOptions([]);
      const controlSignals: AbortSignal[] = [];
      const embeddingSignals: AbortSignal[] = [];
      const rerankSignals: AbortSignal[] = [];
      const control = {
        decide: vi.fn(async (input: Parameters<MemoryControlService["decide"]>[0]) => {
          controlSignals.push(input.signal);
          return base.control.decide(input);
        })
      };
      const utility = utilities([]);
      const utilitiesWithHangingRerank: MemoryRunUtilityService = {
        ...utility,
        embedQuery: vi.fn(async (input) => {
          embeddingSignals.push(input.signal);
          return utility.embedQuery(input);
        }),
        rerank: vi.fn((input) => {
          rerankSignals.push(input.signal);
          return resolveWhenAborted(input.signal, {
            bindingId: "binding-relevance",
            reason: "memory_relevance_unavailable",
            status: "UNAVAILABLE" as const
          });
        })
      };
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        admissionDeadlineMs: 25,
        clock: Date.now,
        control,
        utilities: utilitiesWithHangingRerank
      }).retrieve(runInput("What do I prefer?"));

      await vi.advanceTimersByTimeAsync(12);
      const result = await pending;

      expect(controlSignals[0]).not.toBe(embeddingSignals[0]);
      expect(embeddingSignals[0]).not.toBe(rerankSignals[0]);
      expect(controlSignals[0]?.aborted).toBe(false);
      expect(embeddingSignals[0]?.aborted).toBe(false);
      expect(rerankSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          degradationCode: "memory_relevance_unavailable",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        },
        items: [{ exactItemId: "pending-rerank" }],
        outcome: "DEGRADED"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("budgets both bounded reranker attempts inside one admission deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("rerank-budget-local")] });
      const base = retrievalOptions([]);
      const rerankSignals: AbortSignal[] = [];
      const utility = utilities([]);
      const utilitiesWithHangingRerank: MemoryRunUtilityService = {
        ...utility,
        rerank: vi.fn((input) => {
          rerankSignals.push(input.signal);
          return resolveWhenAborted(input.signal, {
            bindingId: "binding-relevance",
            reason: "memory_relevance_unavailable",
            status: "UNAVAILABLE" as const
          });
        })
      };
      let settled = false;
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        utilities: utilitiesWithHangingRerank
      }).retrieve(runInput("What do I prefer?"))
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(MEMORY_RERANK_OPTIONAL_MAXIMUM_MS - 1);
      expect(settled).toBe(false);
      expect(rerankSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        budgetSnapshot: { degradationCode: "memory_relevance_unavailable" },
        items: [{ exactItemId: "rerank-budget-local" }],
        outcome: "DEGRADED"
      });
      expect(rerankSignals[0]?.aborted).toBe(true);
      expect(MEMORY_RERANK_OPTIONAL_MAXIMUM_MS).toBe(16_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the admission deadline for an outer preparing retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({});
      vi.mocked(local.value.snapshot)
        .mockResolvedValueOnce({ ...snapshot("generation-1"), reason: "memory_disabled", status: "DISABLED" })
        .mockImplementationOnce(() => new Promise(() => undefined));
      const controlCache: MemoryRunControlCache = {};
      const service = createMemoryRunRetrievalService(local.value, {
        admissionDeadlineMs: 50,
        clock: Date.now
      });
      const first = await service.retrieve({
        ...runInput("What do I prefer?"),
        controlCache
      });
      expect(first.outcome).toBe("DISABLED");
      expect(controlCache.admissionDeadlineAtMs).toBe(now.getTime() + 50);

      await vi.advanceTimersByTimeAsync(30);
      let settled = false;
      const retryPromise = service.retrieve({
        ...runInput("What do I prefer?"),
        attemptId: "attempt-2",
        controlCache
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(19);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const retry = await retryPromise;

      expect(retry).toMatchObject({
        budgetSnapshot: { reason: "memory_admission_deadline_exceeded" },
        outcome: "FAILED_SAFE"
      });
      expect(MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an already-expired retry local-only when the cached control belongs to stale attempt zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({});
      const revisedSnapshot = { ...snapshot("generation-1"), memoryRevision: 5 };
      vi.mocked(local.value.snapshot).mockResolvedValueOnce(snapshot("generation-1"));
      local.retrieve.mockResolvedValueOnce({
        core: [],
        laneResults: [],
        lexicalFailures: [],
        lexicalState: "READY",
        snapshot: revisedSnapshot,
        vectorEvidence: [],
        vectorState: "READY"
      });
      const options = retrievalOptions([]);
      const controlCache: MemoryRunControlCache = {};
      const service = createMemoryRunRetrievalService(local.value, {
        ...options,
        admissionDeadlineMs: 25,
        clock: Date.now
      });
      await expect(service.retrieve({
        ...runInput("What is my name?"),
        controlCache
      })).rejects.toMatchObject({ code: "memory_admission_settings_changed" });

      await vi.advanceTimersByTimeAsync(25);
      const retry = await service.retrieve({
        ...runInput("What is my name?"),
        attemptId: "attempt-2",
        controlCache,
        expected: { ...expected("generation-1"), memoryRevision: 5 }
      });

      expect(retry).toMatchObject({
        budgetSnapshot: {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "memory_admission_deadline_exceeded",
          utilityEgressMode: "LOCAL_ONLY",
          utilityExecutions: []
        },
        outcome: "FAILED_SAFE"
      });
      expect(retry.budgetSnapshot).not.toHaveProperty("readOnlyControlReuse");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves half the administrator-selected deadline for local fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({});
      const base = retrievalOptions([]);
      let settled = false;
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        clock: Date.now,
        control: {
          decide: vi.fn((input: Parameters<MemoryControlService["decide"]>[0]) =>
            resolveWhenAborted(input.signal, {
              reason: "memory_action_intent_unavailable",
              status: "UNAVAILABLE" as const
            }))
        }
      }).retrieve({
        ...runInput("What do I prefer?"),
        controlCache: { admissionDeadlineAtMs: now.getTime() + 30_000 }
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        budgetSnapshot: {
          degradationCode: "memory_action_intent_unavailable",
          plannerFallbackReason: "memory_action_intent_unavailable"
        },
        outcome: "EMPTY"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds semantic reranking to 20 facts, 60 history chunks, and 80 stable handles", () => {
    const facts = Array.from({ length: 21 }, (_, index) => core(`fact-${index}`));
    const history = Array.from({ length: 61 }, (_, index) =>
      rankedHistory(`history-${index}`, "NORMAL"));
    const candidates = memoryRelevanceCandidates(
      [...facts.map(({ candidate }) => candidate), ...history],
      [...facts.map(({ expansion }) => expansion),
        ...history.map(({ itemId }) => expandedHistory(itemId))]
    );

    expect(candidates).toHaveLength(80);
    expect(candidates.filter(({ candidate }) =>
      candidate.itemType === "FACT_VERSION")).toHaveLength(20);
    expect(candidates.filter(({ candidate }) =>
      candidate.itemType === "RECALL_CHUNK")).toHaveLength(60);
    expect(candidates.map(({ handle }) => handle)).toEqual(
      Array.from({ length: 80 }, (_, index) => `c${index}`)
    );
    expect(candidates.some(({ candidate }) => candidate.itemId === "fact-20")).toBe(false);
    expect(candidates.some(({ candidate }) => candidate.itemId === "history-60")).toBe(false);
  });

  it("retains 180 distinct history sources for an aggregation rerank", () => {
    const history = Array.from({ length: 181 }, (_, index) => ({
      ...rankedHistory(`aggregate-${index}`, "NORMAL"),
      metadata: {
        ...rankedHistory(`aggregate-${index}`, "NORMAL").metadata,
        dedupeKey: `aggregate-source-${index}`,
        sourceChatId: `aggregate-chat-${index}`
      }
    }));
    const candidates = memoryRelevanceCandidates(
      history,
      history.map((candidate, index) => ({
        ...expandedHistory(candidate.itemId),
        safeText: "User: completed another matching rehearsal.",
        sourceChatId: `aggregate-chat-${index}`
      })),
      { aggregationRequested: true }
    );

    expect(candidates).toHaveLength(180);
    expect(candidates.map(({ candidate }) => candidate.itemId)).toEqual(
      Array.from({ length: 180 }, (_, index) => `aggregate-${index}`)
    );
  });

  it("expands reranked aggregation sources back to diverse raw evidence", () => {
    const raw = [
      ["alpha-first", "chat-alpha"],
      ["alpha-second", "chat-alpha"],
      ["beta-first", "chat-beta"],
      ["gamma-first", "chat-gamma"]
    ].map(([itemId, sourceChatId], index) => {
      const candidate = rankedHistory(itemId!, "NORMAL");
      return {
        ...candidate,
        finalScore: 1 - index / 10,
        metadata: { ...candidate.metadata, sourceChatId: sourceChatId! }
      };
    });
    const selected = [
      { ...raw[2]!, finalScore: 0.98, itemId: "beta-navigation" },
      { ...raw[0]!, finalScore: 0.91, itemId: "alpha-navigation" }
    ];
    raw[0] = { ...raw[0]!, selectionReason: "r".repeat(120) };

    const expanded = selectMemoryAggregationRawCandidates(raw, selected);

    expect(expanded.map(({ itemId }) => itemId)).toEqual([
      "beta-first",
      "alpha-first",
      "alpha-second"
    ]);
    expect(expanded.map(({ finalScore }) => finalScore)).toEqual([0.98, 0.91, 0.91]);
    expect(expanded.map(({ selectionReason }) => selectionReason)).toEqual([
      expect.stringContaining("aggregation_source_selected"),
      "aggregation_source_selected",
      expect.stringContaining("aggregation_source_selected")
    ]);
    expect(expanded.every(({ selectionReason }) => selectionReason.length <= 128)).toBe(true);
  });

  it("preserves an exact reranked aggregation anchor before source fallback", () => {
    const raw = [
      ["alpha-fused-first", "chat-alpha"],
      ["alpha-navigation-anchor", "chat-alpha"],
      ["beta-fused-first", "chat-beta"]
    ].map(([itemId, sourceChatId], index) => {
      const candidate = rankedHistory(itemId!, "NORMAL");
      return {
        ...candidate,
        finalScore: 1 - index / 10,
        metadata: { ...candidate.metadata, sourceChatId: sourceChatId! }
      };
    });
    const selected = [
      { ...raw[1]!, finalScore: 0.99 },
      { ...raw[2]!, finalScore: 0.8, itemId: "beta-navigation-only" }
    ];

    const expanded = selectMemoryAggregationRawCandidates(raw, selected);

    expect(expanded.map(({ itemId }) => itemId)).toEqual([
      "alpha-navigation-anchor",
      "beta-fused-first",
      "alpha-fused-first"
    ]);
    expect(expanded.map(({ finalScore }) => finalScore)).toEqual([0.99, 0.8, 0.99]);
  });

  it("descends into raw children of strong sessions before the weak-session tail", () => {
    const primary = Array.from({ length: 13 }, (_, index) => {
      const candidate = rankedHistory(`session-${index}-primary`, "NORMAL");
      return {
        ...candidate,
        finalScore: 1 - index / 100,
        metadata: { ...candidate.metadata, sourceChatId: `chat-${index}` }
      };
    });
    const deep = ["second", "third"].map((suffix, index) => {
      const candidate = rankedHistory(`session-2-${suffix}`, "NORMAL");
      return {
        ...candidate,
        finalScore: 0.7 - index / 100,
        metadata: { ...candidate.metadata, sourceChatId: "chat-2" }
      };
    });

    const expanded = selectMemoryAggregationRawCandidates(
      [...primary, ...deep],
      primary.map((candidate, index) => ({
        ...candidate,
        finalScore: 0.99 - index / 100
      }))
    );
    const ids = expanded.map(({ itemId }) => itemId);

    expect(ids.indexOf("session-2-second"))
      .toBeLessThan(ids.indexOf("session-6-primary"));
    expect(ids.at(-1)).toBe("session-12-primary");
    expect(ids).toHaveLength(15);
    expect(new Set(ids)).toHaveLength(15);
  });

  it("uses compatibility model fields only for ordering, never admission", () => {
    const history = ["direct", "coverage", "outdated"].map((id, index) => ({
      ...rankedHistory(id, "NORMAL"),
      metadata: {
        ...rankedHistory(id, "NORMAL").metadata,
        dedupeKey: `aggregate-${id}`,
        sourceChatId: `aggregate-chat-${index}`
      }
    }));
    const fact = core("unrelated-fact");
    const candidates = memoryRelevanceCandidates(
      [...history, fact.candidate],
      [
        ...history.map((candidate, index) => ({
          ...expandedHistory(candidate.itemId),
          sourceChatId: `aggregate-chat-${index}`
        })),
        fact.expansion
      ],
      { aggregationRequested: true }
    );
    const decisions = candidates.map((candidate) => {
      switch (candidate.candidate.itemId) {
        case "direct": return {
          applicable: true,
          current: true,
          handle: candidate.handle,
          reasonCode: "DIRECT_RELEVANCE" as const,
          relevanceScore: 0.95
        };
        case "outdated": return {
          applicable: false,
          current: false,
          handle: candidate.handle,
          reasonCode: "OUTDATED" as const,
          relevanceScore: 0.1
        };
        default: return {
          applicable: false,
          current: false,
          handle: candidate.handle,
          reasonCode: "NOT_RELEVANT" as const,
          relevanceScore: 0.1
        };
      }
    });
    const result = {
      bindingId: "binding-aggregation-coverage",
      decisions,
      status: "READY" as const
    };
    const plan = planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: "List all matching events before the boundary event",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });

    const expectedOrder = ["direct", "unrelated-fact", "coverage", "outdated"];
    expect(applyMemoryRelevance(candidates, result, plan).map(({ itemId }) => itemId))
      .toEqual(expectedOrder);
    expect(applyMemoryRelevance(candidates, result).map(({ itemId }) => itemId))
      .toEqual(expectedOrder);
  });

  it("reviews one candidate per strong source before globally ranked repeats", () => {
    const history = Array.from({ length: 40 }, (_, index) => {
      const sourceIndex = index % 4;
      return {
        ...rankedHistory(`source-${sourceIndex}-chunk-${Math.floor(index / 4)}`, "NORMAL"),
        finalScore: 1 - index / 100,
        metadata: {
          ...rankedHistory(`source-${sourceIndex}-chunk-${Math.floor(index / 4)}`, "NORMAL")
            .metadata,
          dedupeKey: `source-${sourceIndex}-projection-${index}`,
          sourceChatId: `source-chat-${sourceIndex}`
        }
      };
    });
    const candidates = memoryRelevanceCandidates(
      history,
      history.map((candidate) => ({
        ...expandedHistory(candidate.itemId),
        sourceChatId: candidate.metadata.sourceChatId
      })),
      { aggregationRequested: true }
    );

    expect(candidates).toHaveLength(40);
    expect(candidates.slice(0, 4).map(({ candidate }) =>
      candidate.metadata.sourceChatId)).toEqual([
      "source-chat-0", "source-chat-1", "source-chat-2", "source-chat-3"
    ]);
    expect(candidates.filter(({ candidate }) =>
      candidate.metadata.sourceChatId === "source-chat-0")).toHaveLength(10);
  });

  it("compacts fallback reasons when wide multi-lane provenance reaches the frozen limit", () => {
    const base = memoryRelevanceCandidates(
      [rankedHistory("wide-provenance", "NORMAL")],
      [expandedHistory("wide-provenance")]
    );
    const candidates = base.map((entry) => ({
      ...entry,
      candidate: { ...entry.candidate, selectionReason: `h${"x".repeat(127)}` }
    }));

    expect(applyMemoryRelevance(candidates, null)[0]?.selectionReason)
      .toBe("rerank_fallback_rrf");
    expect(applyMemoryRelevance(candidates, {
      bindingId: "binding-partial-wide-provenance",
      decisions: [],
      status: "READY"
    })[0]?.selectionReason).toBe("rerank_partial_rrf");
  });

  it("keeps fact relevance slots while diversifying history sources", () => {
    const fact = core("fact-between");
    const history = [
      ["history-a-1", "chat-a"],
      ["history-a-2", "chat-a"],
      ["history-b", "chat-b"]
    ].map(([id, sourceChatId], index) => ({
      ...rankedHistory(id!, "NORMAL"),
      finalScore: 1 - index / 10,
      metadata: {
        ...rankedHistory(id!, "NORMAL").metadata,
        sourceChatId: sourceChatId!
      }
    }));
    const candidates = memoryRelevanceCandidates(
      [history[0]!, fact.candidate, history[1]!, history[2]!],
      [
        ...history.map((candidate) => ({
          ...expandedHistory(candidate.itemId),
          sourceChatId: candidate.metadata.sourceChatId
        })),
        fact.expansion
      ]
    );

    expect(candidates.map(({ candidate }) => candidate.itemId)).toEqual([
      "history-a-1", "fact-between", "history-b", "history-a-2"
    ]);
  });

  it("preserves byte-identical projections from distinct evidence roots", () => {
    const fact = core("fact");
    const history = [
      rankedHistory("history-best", "NORMAL"),
      rankedHistory("history-duplicate", "NORMAL"),
      rankedHistory("history-distinct", "NORMAL")
    ].map((candidate, index) => ({
      ...candidate,
      metadata: {
        ...candidate.metadata,
        dedupeKey: `history-source-${index}`,
        sourceChatId: `chat-source-${index}`
      }
    }));
    const candidates = memoryRelevanceCandidates(
      [fact.candidate, ...history],
      [
        fact.expansion,
        ...history.map((candidate, index) => ({
          ...expandedHistory(candidate.itemId),
          occurredFrom: new Date(now.getTime() + index * 60_000),
          occurredTo: new Date(now.getTime() + (index + 1) * 60_000),
          safeText: index < 2 ? "User: exact repeated history" : "User: distinct history",
          sourceChatId: `chat-source-${index}`
        }))
      ]
    );

    expect(candidates.map(({ candidate }) => candidate.itemId)).toEqual([
      "fact", "history-best", "history-duplicate", "history-distinct"
    ]);
    expect(candidates.map(({ handle }) => handle)).toEqual(["c0", "c1", "c2", "c3"]);
    expect(candidates.filter(({ sourceKind }) => sourceKind === "HISTORY")).toHaveLength(3);
  });

  it("preserves identical history projections at distinct times for a recency plan", () => {
    const history = [
      rankedHistory("history-earlier", "NORMAL"),
      rankedHistory("history-later", "NORMAL")
    ].map((candidate, index) => ({
      ...candidate,
      metadata: {
        ...candidate.metadata,
        dedupeKey: `history-recency-source-${index}`,
        sourceChatId: `chat-recency-source-${index}`
      }
    }));
    const candidates = memoryRelevanceCandidates(
      history,
      history.map((candidate, index) => ({
        ...expandedHistory(candidate.itemId),
        occurredFrom: new Date(now.getTime() + index * 3_600_000),
        occurredTo: new Date(now.getTime() + index * 3_600_000 + 60_000),
        safeText: "User: exact repeated temporal history",
        sourceChatId: `chat-recency-source-${index}`
      })),
      { recencyRequested: true }
    );

    expect(candidates.map(({ candidate }) => candidate.itemId)).toEqual([
      "history-earlier", "history-later"
    ]);
    expect(candidates.map(({ occurredFrom }) => occurredFrom)).toEqual([
      now.toISOString(),
      new Date(now.getTime() + 3_600_000).toISOString()
    ]);
  });

  it("keeps relevance selection ahead of chronology rendering", () => {
    const current = core("current-macbook").candidate;
    const previousBase = core("ordered-macbook").candidate;
    const previous: MemoryRankedCandidate = {
      ...previousBase,
      metadata: {
        ...previousBase.metadata,
        current: false,
        historical: true,
        lifecycleState: "SUPERSEDED",
        systemFrom: new Date("2025-07-01T00:00:00.000Z"),
        validFrom: new Date("2025-07-01T00:00:00.000Z"),
        validTo: new Date("2025-08-01T00:00:00.000Z")
      }
    };
    const plan = planMemoryRetrieval({
      currentUserText: "How did my MacBook ownership change?",
      filters: { sourceKinds: ["FACT", "EVENT"] },
      mode: "HISTORICAL_MEMORY",
      now,
      temporalIntent: "HISTORICAL"
    });
    const candidates = memoryRelevanceCandidates(
      [current, previous],
      [
        core("current-macbook").expansion,
        core("ordered-macbook").expansion
      ],
      { temporalIntent: "HISTORICAL" }
    );
    const accepted = applyMemoryRelevance(candidates, {
      bindingId: "binding-historical",
      decisions: candidates.map((candidate, index) => ({
        applicable: true,
        current: true,
        handle: candidate.handle,
        reasonCode: "DIRECT_RELEVANCE" as const,
        relevanceScore: index === 0 ? 0.99 : 0.7
      })),
      status: "READY"
    }, plan);

    expect(accepted.map(({ itemId }) => itemId)).toEqual([
      "current-macbook",
      "ordered-macbook"
    ]);
  });

  it("uses stable fused order to break equal reranker scores", () => {
    const domainTime = new Date("2025-07-01T00:00:00.000Z");
    const candidates = [
      ["state-z", "2025-07-03T00:00:00.000Z"],
      ["state-b", "2025-07-02T00:00:00.000Z"],
      ["state-a", "2025-07-02T00:00:00.000Z"]
    ].map(([id, systemFrom]) => {
      const base = core(id!).candidate;
      return {
        ...base,
        metadata: {
          ...base.metadata,
          current: false,
          historical: true,
          lifecycleState: "SUPERSEDED" as const,
          systemFrom: new Date(systemFrom!),
          validFrom: domainTime
        }
      };
    });
    const plan = planMemoryRetrieval({
      currentUserText: "How did this state change?",
      filters: { sourceKinds: ["FACT", "EVENT"] },
      mode: "HISTORICAL_MEMORY",
      now,
      temporalIntent: "HISTORICAL"
    });
    const relevance = memoryRelevanceCandidates(
      candidates,
      candidates.map(({ itemId }) => core(itemId).expansion),
      { temporalIntent: "HISTORICAL" }
    );
    const accepted = applyMemoryRelevance(relevance, {
      bindingId: "binding-historical-ties",
      decisions: relevance.map((candidate) => ({
        applicable: true,
        current: true,
        handle: candidate.handle,
        reasonCode: "DIRECT_RELEVANCE" as const,
        relevanceScore: 0.9
      })),
      status: "READY"
    }, plan);

    expect(accepted.map(({ itemId }) => itemId)).toEqual([
      "state-z", "state-b", "state-a"
    ]);
  });

  it("does not replay a resolved Memory action across a preparing retry", async () => {
    const local = repository({});
    const control = {
      decide: vi.fn(async () => ({
        bindingId: "binding-control",
        intent: {
          ...currentControlContract,
          action: "SAVE" as const,
          applyResponsePreferences: false,
          category: "preferences" as const,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
          entityMentions: [],
          includePatterns: false,
          memoryUseful: false,
          pastChatsUseful: false,
          profileRequested: false,
          queryText: null,
          reasonCode: "save_request" as const,
          recencyRequested: false,
          referencedMemoryRef: null,
          replacementStatement: null,
          responsePreference: true,
          sensitiveDomainHint: null,
          sensitivity: "NORMAL" as const,
          statement: "I prefer concise answers.",
          targetQuery: null,
          thisChatOnly: false
        },
        status: "READY" as const
      }))
    };
    const actionExecutor = {
      execute: vi.fn(async () => ({
        operation: "SAVE" as const,
        status: "REJECTED" as const
      }))
    };
    const controlRefs = {
      load: vi.fn(async () => ["opaque-memory-ref"])
    };
    const controlCache: MemoryRunControlCache = {};
    const service = createMemoryRunRetrievalService(local.value, {
      actionExecutor,
      control,
      controlRefs
    });
    const original = runInput("Remember that I prefer concise answers.");
    const normalizedRequest: NormalizedRunRequest = {
      ...original.normalizedRequest,
      context: {
        messages: [
          { content: textMessageContent("Prior answer."), id: "assistant-prior", role: "assistant" },
          ...(original.normalizedRequest.context?.messages ?? [])
        ],
        mode: "branch_path"
      }
    };

    const first = await service.retrieve({
      ...original,
      normalizedRequest,
      controlCache
    });
    vi.mocked(local.value.snapshot).mockRejectedValueOnce(new Error("snapshot unavailable"));
    const retry = await service.retrieve({
      ...original,
      attemptId: "attempt-2",
      controlCache,
      normalizedRequest
    });

    expect(control.decide).toHaveBeenCalledOnce();
    expect(control.decide).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ memoryRefs: ["opaque-memory-ref"] })
    }));
    expect(controlRefs.load).toHaveBeenCalledOnce();
    expect(controlRefs.load).toHaveBeenCalledWith({
      assistantMessageIds: ["assistant-prior"],
      chatId: "chat-current",
      userId: "user-1"
    });
    expect(actionExecutor.execute).toHaveBeenCalledOnce();
    expect(first.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: { operation: "SAVE", status: "REJECTED", version: 1 },
      memoryActionResult: { operation: "SAVE", status: "REJECTED" }
    });
    expect(retry.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: { operation: "SAVE", status: "REJECTED", version: 1 },
      memoryActionResult: { operation: "SAVE", status: "REJECTED" },
      reason: "memory_control_retry_not_reused",
      utilityEgressMode: "LOCAL_ONLY"
    });
  });

  it.each([
    {
      actionResult: {
        memoryRef: "updated-memory-ref",
        operation: "UPDATE" as const,
        statement: "My name is Dmitry.",
        status: "COMMITTED" as const
      },
      status: "COMMITTED"
    },
    {
      actionResult: {
        candidates: ["first", "second"].map((suffix) => ({
          category: "about_you",
          createdAt: now.toISOString(),
          memoryRef: `${suffix}-memory-ref`,
          provenance: "SAVED" as const,
          sensitivity: "NORMAL" as const,
          statement: `Candidate ${suffix}`
        })),
        operation: "UPDATE" as const,
        statement: "My name is Dmitry.",
        status: "AMBIGUOUS" as const
      },
      status: "AMBIGUOUS"
    }
  ])("keeps a $status action fail-safe instead of replaying it", async ({ actionResult }) => {
    const local = repository({});
    const control = {
      decide: vi.fn(async () => ({
        bindingId: "binding-control",
        intent: {
          ...currentControlContract,
          action: "UPDATE" as const,
          applyResponsePreferences: false,
          category: "about_you" as const,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
          entityMentions: [],
          includePatterns: false,
          memoryUseful: false,
          pastChatsUseful: false,
          profileRequested: false,
          queryText: null,
          reasonCode: "update_request" as const,
          recencyRequested: false,
          referencedMemoryRef: null,
          replacementStatement: "My name is Dmitry.",
          responsePreference: false,
          sensitiveDomainHint: null,
          sensitivity: "NORMAL" as const,
          statement: null,
          targetQuery: "my name",
          thisChatOnly: false
        },
        status: "READY" as const
      }))
    };
    const actionExecutor = { execute: vi.fn(async () => actionResult) };
    const controlCache: MemoryRunControlCache = {};
    const service = createMemoryRunRetrievalService(local.value, {
      actionExecutor,
      control
    });

    await service.retrieve({ ...runInput("Change my name."), controlCache });
    const retry = await service.retrieve({
      ...runInput("Change my name."),
      attemptId: "attempt-2",
      controlCache
    });

    expect(control.decide).toHaveBeenCalledOnce();
    expect(actionExecutor.execute).toHaveBeenCalledOnce();
    expect(retry).toMatchObject({
      budgetSnapshot: { reason: "memory_control_retry_not_reused" },
      items: [],
      outcome: "FAILED_SAFE"
    });
  });

  it("bridges a commit-time lifecycle rejection as a non-committed answer result", async () => {
    const local = repository({});
    const control = {
      decide: vi.fn(async () => ({
        bindingId: "binding-control",
        intent: {
          ...currentControlContract,
          action: "SAVE" as const,
          applyResponsePreferences: false,
          category: "preferences" as const,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
          entityMentions: [],
          includePatterns: false,
          memoryUseful: false,
          pastChatsUseful: false,
          profileRequested: false,
          queryText: null,
          reasonCode: "save_request" as const,
          recencyRequested: false,
          referencedMemoryRef: null,
          replacementStatement: null,
          responsePreference: true,
          sensitiveDomainHint: null,
          sensitivity: "NORMAL" as const,
          statement: "I prefer concise answers.",
          targetQuery: null,
          thisChatOnly: false
        },
        status: "READY" as const
      }))
    };
    const actionExecutor = {
      execute: vi.fn(async () => {
        throw new Error("memory_mutation_authorization_invalid");
      })
    };
    const result = await createMemoryRunRetrievalService(local.value, {
      actionExecutor,
      control
    }).retrieve(runInput("Remember that I prefer concise answers."));

    expect(result.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: { operation: "SAVE", status: "REJECTED", version: 1 },
      memoryActionResult: { operation: "SAVE", status: "REJECTED" }
    });
  });

  it("bridges only the committed action result into the answer contract", async () => {
    const local = repository({});
    const control = {
      decide: vi.fn(async () => ({
        bindingId: "binding-control",
        intent: {
          ...currentControlContract,
          action: "SAVE" as const,
          applyResponsePreferences: false,
          category: "preferences" as const,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
          entityMentions: [],
          includePatterns: false,
          memoryUseful: false,
          pastChatsUseful: false,
          profileRequested: false,
          queryText: null,
          reasonCode: "save_request" as const,
          recencyRequested: false,
          referencedMemoryRef: null,
          replacementStatement: null,
          responsePreference: true,
          sensitiveDomainHint: null,
          sensitivity: "NORMAL" as const,
          statement: "I prefer concise answers.",
          targetQuery: null,
          thisChatOnly: false
        },
        status: "READY" as const
      }))
    };
    const result = await createMemoryRunRetrievalService(local.value, {
      actionExecutor: {
        execute: vi.fn(async () => ({
          memoryRef: "opaque-ref",
          operation: "SAVE" as const,
          statement: "I prefer concise answers.",
          status: "COMMITTED" as const
        }))
      },
      control
    }).retrieve(runInput("Remember that I prefer concise answers."));
    expect(result.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: { operation: "SAVE", status: "COMMITTED", version: 1 }
    });
  });

  it("reports System-Model control outage as unavailable without invoking an action", async () => {
    const local = repository({ candidates: [laneCandidate("fallback-answer-evidence")] });
    const actionExecutor = { execute: vi.fn() };
    const result = await createMemoryRunRetrievalService(local.value, {
      actionExecutor,
      control: {
        decide: vi.fn(async () => ({
          reason: "memory_action_intent_unavailable",
          status: "UNAVAILABLE" as const
        }))
      }
    }).retrieve(runInput("Remember this and also answer my question."));
    expect(result).toMatchObject({
      degradationCode: "memory_action_intent_unavailable",
      items: [{ exactItemId: "fallback-answer-evidence" }],
      outcome: "DEGRADED",
      querySnapshot: "Remember this and also answer my question."
    });
    expect(result.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: { operation: "NONE", status: "UNAVAILABLE", version: 1 },
      plan: {
        filterSourceKinds: ["FACT", "EVENT", "HISTORY"],
        temporalIntent: "ANY"
      },
      plannerFallbackReason: "memory_action_intent_unavailable"
    });
    expect(local.retrieve).toHaveBeenCalledOnce();
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it("treats invalid control output as mutation NONE plus degraded local read", async () => {
    const local = repository({ candidates: [laneCandidate("invalid-control-evidence")] });
    const actionExecutor = { execute: vi.fn() };
    const result = await createMemoryRunRetrievalService(local.value, {
      actionExecutor,
      control: {
        decide: vi.fn(async () => ({
          reason: "memory_action_intent_invalid",
          status: "UNAVAILABLE" as const
        }))
      }
    }).retrieve(runInput("What did I decide?"));

    expect(result).toMatchObject({
      degradationCode: "memory_action_intent_invalid",
      items: [{ exactItemId: "invalid-control-evidence" }],
      outcome: "DEGRADED"
    });
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it("reuses an unavailable control fallback without another control call", async () => {
    const local = repository({ candidates: [laneCandidate("reused-fallback-evidence")] });
    const control = {
      decide: vi.fn(async () => ({
        bindingId: "failed-control-binding",
        reason: "memory_action_intent_unavailable",
        status: "UNAVAILABLE" as const
      }))
    };
    const controlCache: MemoryRunControlCache = {};
    const service = createMemoryRunRetrievalService(local.value, { control });
    await service.retrieve({ ...runInput("What did I decide?"), controlCache });
    const retry = await service.retrieve({
      ...runInput("What did I decide?"),
      attemptId: "attempt-2",
      controlCache
    });

    expect(control.decide).toHaveBeenCalledOnce();
    expect(retry).toMatchObject({
      budgetSnapshot: {
        fallbackControlReuse: {
          reason: "memory_action_intent_unavailable",
          sourceAttemptId: "attempt-1",
          version: 1
        },
        plannerFallbackReason: "memory_action_intent_unavailable",
        utilityEgressMode: "LOCAL_ONLY",
        utilityExecutions: expect.arrayContaining([expect.objectContaining({
          externalCall: false,
          role: "MEMORY_CONTROL",
          state: "UNAVAILABLE"
        })])
      },
      items: [{ exactItemId: "reused-fallback-evidence" }],
      outcome: "DEGRADED"
    });
  });

  it("keeps the no-commit bridge when control returns a false-negative NONE", async () => {
    const local = repository({});
    const options = retrievalOptions([]);
    const actionExecutor = { execute: vi.fn() };
    const result = await createMemoryRunRetrievalService(local.value, {
      ...options,
      actionExecutor
    }).retrieve(runInput("Remember this preference, then answer normally."));

    expect(options.control.decide).toHaveBeenCalledOnce();
    expect(actionExecutor.execute).not.toHaveBeenCalled();
    expect(result.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: {
        operation: "NONE",
        status: "UNAVAILABLE",
        version: 1
      }
    });
  });

  it("does not let a valid useful=false decision disable ordinary raw-query retrieval", async () => {
    const local = repository({ candidates: [laneCandidate("raw-query-evidence")] });
    const options = intentOptions({
      applyResponsePreferences: false,
      memoryUseful: false,
      pastChatsUseful: false,
      queryText: null
    });
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("Which codename did I choose?"));

    expect(result).toMatchObject({
      budgetSnapshot: {
        componentMetrics: { plannerFallbackUsed: true },
        plannerFallbackReason: "memory_control_read_not_requested"
      },
      items: [{ exactItemId: "raw-query-evidence" }],
      outcome: "USED",
      querySnapshot: "Which codename did I choose?"
    });
    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        originalSanitizedQuery: "Which codename did I choose?",
        semanticQueryVariants: [
          { kind: "ORIGINAL", text: "Which codename did I choose?" }
        ]
      })
    }));
  });

  it("supplements the original query with a planner rewrite without replacing it", async () => {
    const local = repository({ candidates: [laneCandidate("rewritten-evidence")] });
    const options = intentOptions({
      memoryUseful: false,
      pastChatsUseful: true,
      queryText: "Helsinki project codename",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("What did I call it?"));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        lexicalQuery: expect.stringMatching(/What.*Helsinki/u),
        originalSanitizedQuery: "What did I call it?",
        semanticQueryVariants: [
          { kind: "ORIGINAL", text: "What did I call it?" },
          { kind: "PLANNER_REWRITE", text: "Helsinki project codename" }
        ]
      })
    }));
    expect(options.utilities.embedQuery).toHaveBeenCalledWith(expect.objectContaining({
      query: "Helsinki project codename"
    }));
    expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
      query: "What did I call it?"
    }));
    expect(result.querySnapshot).toBe("What did I call it?");
  });

  it("keeps Temporary and disabled paths on the no-commit bridge without utility work", async () => {
    const temporaryRepository = repository({});
    const temporaryControl = { decide: vi.fn() };
    const temporaryAction = { execute: vi.fn() };
    const temporary = await createMemoryRunRetrievalService(temporaryRepository.value, {
      actionExecutor: temporaryAction,
      control: temporaryControl as MemoryControlService
    }).retrieve({
      ...runInput("Remember this only here."),
      expected: { ...expected("generation-1"), chatMemoryMode: "TEMPORARY" }
    });

    const disabledRepository = repository({});
    vi.mocked(disabledRepository.value.snapshot).mockResolvedValueOnce({
      ...snapshot("generation-1"),
      reason: "memory_disabled",
      status: "DISABLED"
    });
    const disabledControl = { decide: vi.fn() };
    const disabledAction = { execute: vi.fn() };
    const disabled = await createMemoryRunRetrievalService(disabledRepository.value, {
      actionExecutor: disabledAction,
      control: disabledControl as MemoryControlService
    }).retrieve(runInput("Remember this while Memory is disabled."));

    for (const result of [temporary, disabled]) {
      expect(result.budgetSnapshot).toMatchObject({
        memoryActionAnswerResult: {
          operation: "NONE",
          status: "UNAVAILABLE",
          version: 1
        }
      });
    }
    expect(temporary).toMatchObject({ outcome: "DISABLED" });
    expect(disabled).toMatchObject({ outcome: "DISABLED" });
    expect(temporaryRepository.value.snapshot).not.toHaveBeenCalled();
    expect(temporaryControl.decide).not.toHaveBeenCalled();
    expect(temporaryAction.execute).not.toHaveBeenCalled();
    expect(disabledControl.decide).not.toHaveBeenCalled();
    expect(disabledAction.execute).not.toHaveBeenCalled();
  });

  it("reuses an exact read-only NONE plan after revision drift and returns candidates", async () => {
    const candidate = laneCandidate("name-fact");
    const local = repository({ candidates: [candidate] });
    const revisedSnapshot = { ...snapshot("generation-1"), memoryRevision: 5 };
    vi.mocked(local.value.snapshot)
      .mockResolvedValueOnce(snapshot("generation-1"))
      .mockResolvedValueOnce(revisedSnapshot);
    local.retrieve.mockResolvedValue({
      core: [],
      laneResults: [{ candidates: [candidate], lane: "HISTORY_RECALL_VECTOR" }],
      lexicalFailures: [],
      lexicalState: "READY",
      snapshot: revisedSnapshot,
      vectorEvidence: [],
      vectorState: "READY"
    });
    const options = retrievalOptions(["c0"]);
    const controlCache: MemoryRunControlCache = {};
    const service = createMemoryRunRetrievalService(local.value, options);
    const firstError = await service.retrieve({
      ...runInput("What is my name?"),
      controlCache
    }).catch((error: unknown) => error);
    expect(firstError).toMatchObject({
      code: "memory_admission_settings_changed",
      retryable: true
    });
    expect(controlCache).toMatchObject({
      settingsDriftFailedSafeAttemptId: "attempt-1",
      settingsDriftFailedSafeBudget: {
        memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
        reason: "memory_admission_settings_changed",
        utilityEgressMode: "CONSENTED_EXTERNAL",
        utilityExecutions: [
          { role: "MEMORY_CONTROL", state: "READY" },
          { role: "MEMORY_QUERY_EMBED", state: "READY" }
        ]
      }
    });
    expect(controlCache.settingsDriftFailedSafeBudget)
      .not.toHaveProperty("memoryActionResult");
    const retry = await service.retrieve({
      ...runInput("What is my name?"),
      attemptId: "attempt-2",
      controlCache,
      expected: { ...expected("generation-1"), memoryRevision: 5 }
    });

    expect(options.control.decide).toHaveBeenCalledOnce();
    expect(options.utilities.embedQuery).toHaveBeenCalledTimes(2);
    expect(options.utilities.rerank).toHaveBeenCalledOnce();
    expect(retry).toMatchObject({
      budgetSnapshot: {
        readOnlyControlReuse: {
          acceptedOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          intent: { action: "NONE", queryText: "What is my name?" },
          sourceAttemptId: "attempt-1",
          sourceBindingId: "binding-control",
          version: 6
        },
        utilityEgressMode: "CONSENTED_EXTERNAL"
      },
      items: [{ exactItemId: "name-fact", itemType: "RECALL_CHUNK" }],
      outcome: "USED"
    });
    expect(retry.budgetSnapshot).toMatchObject({
      utilityExecutions: [
        { role: "MEMORY_CONTROL", state: "READY" },
        { role: "MEMORY_QUERY_EMBED", state: "READY" },
        { role: "MEMORY_RERANK", state: "READY" }
      ]
    });
  });

  it("consumes the bounded reranker budget once per preparing attempt", async () => {
    const local = repository({ candidates: [laneCandidate("a")] });
    const options = retrievalOptions(["c0"]);
    const controlCache: MemoryRunControlCache = {};
    const service = createMemoryRunRetrievalService(local.value, options);
    const first = await service.retrieve({
      ...runInput("my preferences"),
      controlCache
    });
    const retry = await service.retrieve({
      ...runInput("my preferences"),
      attemptId: "attempt-2",
      controlCache
    });
    expect(first.outcome).toBe("USED");
    expect(retry).toMatchObject({ outcome: "USED" });
    expect(options.control.decide).toHaveBeenCalledOnce();
    expect(options.utilities.rerank).toHaveBeenCalledTimes(2);
    expect(retry.budgetSnapshot).toMatchObject({
      readOnlyControlReuse: {
        sourceAttemptId: "attempt-1",
        sourceBindingId: "binding-control"
      },
      utilityEgressMode: "CONSENTED_EXTERNAL"
    });
  });

  it("returns zero items without a query/index and never falls back to Core", async () => {
    const local = repository({ activeIndexGenerationId: null, core: [core()] });
    const result = await createMemoryRunRetrievalService(local.value)
      .retrieve(runInput(" ", null));
    expect(result).toMatchObject({
      items: [],
      outcome: "FAILED_SAFE",
      querySnapshot: null
    });
    expect(result.preparedContext).toBeNull();
  });

  it("[E07] keeps the past-chat lane when fact retrieval is unavailable", async () => {
    const local = repository({ candidates: [laneCandidate("past-chat")] });
    const options = intentOptions({
      memoryUseful: false,
      pastChatsUseful: true,
      retrievalMode: "PAST_CHAT_SEARCH"
    });
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("What did we discuss?"));

    expect(result).toMatchObject({
      items: [{ exactItemId: "past-chat", itemType: "RECALL_CHUNK" }],
      outcome: "USED"
    });
    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        filters: expect.objectContaining({ sourceKinds: ["HISTORY"] })
      })
    }));
    expect(options.utilities.embedQuery).toHaveBeenCalledOnce();
    expect(options.utilities.rerank).toHaveBeenCalledOnce();
  });

  it("clamps the prepared reader pack to the admitted model context envelope", async () => {
    const local = repository({ candidates: [laneCandidate("past-chat-bounded")] });
    const options = intentOptions({
      memoryUseful: false,
      pastChatsUseful: true,
      retrievalMode: "PAST_CHAT_SEARCH"
    });
    const base = runInput("What did we discuss?");
    const result = await createMemoryRunRetrievalService(local.value, options).retrieve({
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          contextWindow: 2_000,
          defaultMaxOutputTokens: 0
        }
      }
    });
    const budget = result.budgetSnapshot as Record<string, unknown>;

    expect(result).toMatchObject({
      budgetSnapshot: { budgetProfile: "PAST_CHAT" },
      outcome: "USED"
    });
    expect(budget.providerTokenLimit).toEqual(expect.any(Number));
    expect(Number(budget.providerTokenLimit)).toBeLessThan(10_000);
    expect(budget.hardCapTokens).toBe(budget.providerTokenLimit);
    expect(budget.targetTokens).toBe(budget.providerTokenLimit);
    expect(result.preparedContext!.approxTokens)
      .toBeLessThanOrEqual(Number(budget.providerTokenLimit));
  });

  it("propagates an explicit aggregation plan and a server-computed count", async () => {
    const local = repository({
      candidates: [
        laneCandidate("release-alpha"),
        laneCandidate("release-beta"),
        laneCandidate("release-gamma"),
        laneCandidate("release-delta"),
        laneCandidate("launch-day")
      ]
    });
    const aggregationUtilities = utilities(["c0", "c1", "c2", "c3", "c4"]);
    vi.mocked(aggregationUtilities.aggregate).mockImplementation(async (input) => {
      const group = (occurrence: string, role: "BOUNDARY" | "MEMBER") => ({
        itemHandles: [input.evidence.find(({ text }) =>
          text.includes(occurrence))!.handle],
        occurrence,
        quantity: role === "MEMBER" ? 1 : 0,
        quantityEvidence: role === "MEMBER" ? occurrence : null,
        role
      });
      return {
        bindingId: "binding-aggregation",
        plan: {
          groups: [
            group("release-alpha", "MEMBER"),
            group("release-beta", "MEMBER"),
            group("release-gamma", "MEMBER"),
            group("release-delta", "MEMBER"),
            group("launch-day", "BOUNDARY")
          ],
          operation: "COUNT",
          resolution: "RESOLVED"
        },
        status: "READY"
      };
    });
    const options = {
      ...intentOptions({
      aggregationRequested: true,
      memoryUseful: false,
      pastChatsUseful: true,
      queryText: "completed releases",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
      }),
      utilities: aggregationUtilities
    };
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("How many releases happened before launch day?"));

    expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
      aggregationRequested: true,
      retrievalMode: "PAST_CHAT_SEARCH"
    }));
    expect(local.projectAggregationSessions).toHaveBeenCalledOnce();
    expect(options.utilities.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("release-alpha") }),
        expect.objectContaining({ text: expect.stringContaining("launch-day") })
      ]),
      query: "How many releases happened before launch day?"
    }));
    expect(result).toMatchObject({
      budgetSnapshot: {
        aggregationBoundaryCount: 1,
        aggregationMemberCount: 4,
        aggregationOperation: "COUNT",
        aggregationResolution: "RESOLVED",
        plan: { aggregationRequested: true, mode: "PAST_CHAT_SEARCH" }
      },
      outcome: "USED"
    });
    expect(result.preparedContext?.text).toContain("distinct_members=4; boundary_events=1");
    expect(result.preparedContext?.text).toContain("Counted or enumerated members:");
    expect(result.preparedContext?.text).toContain("Boundary events:");
    expect(() => validateMemoryPreparingAttemptResult(result)).not.toThrow();
  });

  it("keeps the relevant source pack but degrades when global aggregation is unavailable", async () => {
    const local = repository({ candidates: [laneCandidate("release-alpha")] });
    const aggregationUtilities = utilities(["c0"]);
    vi.mocked(aggregationUtilities.aggregate).mockResolvedValue({
      reason: "memory_run_utility_provider_failed",
      status: "UNAVAILABLE"
    });
    const options = {
      ...intentOptions({
        aggregationRequested: true,
        memoryUseful: false,
        pastChatsUseful: true,
        retrievalMode: "PAST_CHAT_SEARCH",
        temporalIntent: "ANY"
      }),
      utilities: aggregationUtilities
    };

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("Which releases did I complete?"));

    expect(result).toMatchObject({
      budgetSnapshot: {
        aggregationReason: "memory_run_utility_provider_failed",
        aggregationState: "UNAVAILABLE",
        degradationCode: "memory_aggregation_unavailable"
      },
      degradationCode: "memory_aggregation_unavailable",
      items: [{ exactItemId: "release-alpha" }],
      outcome: "DEGRADED"
    });
    expect(result.preparedContext?.text).toContain("release-alpha");
    expect(result.preparedContext?.text).toContain(
      "Combine every relevant listed event"
    );
    expect(result.preparedContext?.text).not.toContain("distinct_members=");
  });

  it("times out optional aggregation and keeps the underlying source pack", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("aggregation-timeout-evidence")] });
      const aggregationUtilities = utilities(["c0"]);
      const receivedSignals: AbortSignal[] = [];
      vi.mocked(aggregationUtilities.aggregate).mockImplementation((input) => {
        receivedSignals.push(input.signal);
        return resolveWhenAborted(input.signal, {
          reason: "memory_aggregation_unavailable",
          status: "UNAVAILABLE" as const
        });
      });
      const options = {
        ...intentOptions({
          aggregationRequested: true,
          memoryUseful: false,
          pastChatsUseful: true,
          retrievalMode: "PAST_CHAT_SEARCH",
          temporalIntent: "ANY"
        }),
        admissionDeadlineMs: 40,
        clock: Date.now,
        utilities: aggregationUtilities
      };
      const pending = createMemoryRunRetrievalService(local.value, options)
        .retrieve(runInput("Which releases did I complete?"));

      await vi.advanceTimersByTimeAsync(20);
      const result = await pending;

      expect(receivedSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        degradationCode: "memory_aggregation_unavailable",
        items: [{ exactItemId: "aggregation-timeout-evidence" }],
        outcome: "DEGRADED"
      });
      expect(result.preparedContext?.text).toContain("aggregation-timeout-evidence");
    } finally {
      vi.useRealTimers();
    }
  });

  it("budgets every bounded map and reduce attempt inside one admission deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("aggregation-budget-evidence")] });
      const aggregationUtilities = utilities(["c0"]);
      const receivedSignals: AbortSignal[] = [];
      vi.mocked(aggregationUtilities.aggregate).mockImplementation((input) => {
        receivedSignals.push(input.signal);
        return resolveWhenAborted(input.signal, {
          reason: "memory_aggregation_unavailable",
          status: "UNAVAILABLE" as const
        });
      });
      const options = {
        ...intentOptions({
          aggregationRequested: true,
          memoryUseful: false,
          pastChatsUseful: true,
          retrievalMode: "PAST_CHAT_SEARCH",
          temporalIntent: "ANY"
        }),
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        utilities: aggregationUtilities
      };
      let settled = false;
      const pending = createMemoryRunRetrievalService(local.value, options)
        .retrieve(runInput("Which releases did I complete?"))
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(MEMORY_AGGREGATION_OPTIONAL_MAXIMUM_MS - 1);
      expect(settled).toBe(false);
      expect(receivedSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        degradationCode: "memory_aggregation_unavailable",
        items: [{ exactItemId: "aggregation-budget-evidence" }],
        outcome: "DEGRADED"
      });
      expect(receivedSignals[0]?.aborted).toBe(true);
      expect(MEMORY_AGGREGATION_OPTIONAL_MAXIMUM_MS).toBe(32_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the deterministic base plan when control violates planner semantics", async () => {
    const local = repository({ candidates: [laneCandidate("past-chat")] });
    const options = intentOptions({
      memoryUseful: false,
      pastChatsUseful: true,
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "HISTORICAL"
    });
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("What codename did I choose for that event?"));

    expect(result).toMatchObject({
      budgetSnapshot: {
        degradationCode: "memory_plan_invalid",
        plan: {
          filterSourceKinds: ["FACT", "EVENT", "HISTORY"],
          temporalIntent: "ANY"
        },
        plannerFallbackReason: "memory_plan_invalid"
      },
      items: [{ exactItemId: "past-chat" }],
      outcome: "DEGRADED",
      querySnapshot: "What codename did I choose for that event?"
    });
    expect(local.retrieve).toHaveBeenCalledOnce();
    expect(options.utilities.embedQuery).toHaveBeenCalledOnce();
    expect(options.utilities.rerank).toHaveBeenCalledOnce();
  });

  it("admits only the narrow response-preference lane when dynamic Memory is vetoed", async () => {
    const local = repository({
      candidates: [laneCandidate("past-chat")],
      core: [core("arbitrary-fact"), responsePreferenceCore("response-preference")]
    });
    const options = intentOptions({
      applyResponsePreferences: true,
      memoryUseful: false,
      pastChatsUseful: false
    });
    vi.mocked(options.utilities.rerank).mockImplementation(async (input) => ({
      bindingId: "binding-relevance",
      decisions: input.candidates.map((candidate) => ({
        applicable: true,
        current: true,
        handle: candidate.handle,
        reasonCode: "DIRECT_RELEVANCE" as const,
        relevanceScore: 0.9
      })),
      status: "READY"
    }));
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("Explain this clearly."));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        applyResponsePreferences: true,
        filters: expect.objectContaining({ sourceKinds: [] })
      })
    }));
    expect(local.value.expand).toHaveBeenCalledOnce();
    expect(local.value.expand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      [expect.objectContaining({ itemId: "response-preference" })]
    );
    expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({
        authorityLevel: "SAVED",
        sourceKind: "FACT",
        text: "User prefers concise answers"
      })]
    }));
    expect(result.items).toMatchObject([{
      factVersionId: "response-preference",
      itemType: "FACT_VERSION"
    }]);
    expect(result.budgetSnapshot).toMatchObject({
      componentMetrics: {
        candidatesRetainedAfterRejoin: 1,
        candidatesRetainedAfterReranker: 1,
        candidatesSentToReranker: 1,
        packedEvidenceItems: 1,
        plannerFallbackUsed: false,
        rawRoundExpansions: 0,
        rerankerFallbackUsed: false,
        selectedSourceChats: 0,
        temporalParserState: "NO_MATCH",
        uniqueEvidenceRootsAfterFusion: 0,
        uniqueEvidenceRootsBeforeFusion: 1,
        version: "memory-retrieval-component-metrics-v6"
      },
      plan: { applyResponsePreferences: true, filterSourceKinds: [] }
    });
    expect(JSON.stringify((result.budgetSnapshot as Record<string, unknown>)
      .componentMetrics)).not.toContain("Explain this clearly");
    expect(result.outcome).toBe("USED");
    expect(result.items?.some(({ itemType }) => itemType === "RECALL_CHUNK")).toBe(false);
    expect(result.items?.some((item) =>
      item.itemType === "FACT_VERSION" && item.factVersionId === "arbitrary-fact"))
      .toBe(false);
  });

  it.each(["какие ответы я преподчитаю", "ما اسمي", "我的名字", "मेरा नाम", "🧠::x"])(
    "sends every non-empty Unicode query to candidate generation: %s",
    async (text) => {
      const local = repository({ core: [core()] });
      await createMemoryRunRetrievalService(local.value, retrievalOptions([]))
        .retrieve(runInput(text));
      expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
        plan: expect.objectContaining({ queryPresent: true })
      }));
    }
  );

  it("carries trusted recency intent without making model relevance an admission gate", async () => {
    const local = repository({ candidates: [laneCandidate("recent-irrelevant")] });
    const options = retrievalOptions([], true);
    const result = await createMemoryRunRetrievalService(
      local.value,
      options
    ).retrieve(runInput("What did I mention most recently?"));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ recencyRequested: true })
    }));
    expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({
        handle: "c0",
        text: "relevant text recent-irrelevant"
      })]
    }));
    expect(result.items).toEqual([
      expect.objectContaining({ recallChunkId: "recent-irrelevant" })
    ]);
    expect(result.budgetSnapshot).toMatchObject({
      plan: { recencyRequested: true }
    });
  });

  it("packs the relevance order while retaining lower-scored eligible evidence", async () => {
    const local = repository({ candidates: [laneCandidate("a"), laneCandidate("b")] });
    const options = retrievalOptions(["c1"]);
    vi.mocked(options.utilities.rerank).mockResolvedValue({
      bindingId: "binding-partial-relevance",
      decisions: [{
        applicable: true,
        current: true,
        handle: "c1",
        reasonCode: "DIRECT_RELEVANCE",
        relevanceScore: 0.9
      }],
      status: "READY"
    });
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("cross language query"));
    expect(result.items).toEqual([
      expect.objectContaining({ recallChunkId: "b" }),
      expect.objectContaining({ recallChunkId: "a" })
    ]);
    expect(result.items?.[0]?.selectionReason).toContain("direct_relevance");
    expect(result.items?.[1]?.selectionReason).toContain("rerank_partial_rrf");
    expect(result.budgetSnapshot).toMatchObject({
      componentMetrics: { rerankerFallbackUsed: true }
    });
  });

  it("applies opt-in decay after relevance while preserving baseline scores and items", async () => {
    const candidates = [
      {
        ...factLaneCandidate("old-high-score", 0.99),
        metadata: {
          ...factLaneCandidate("old-high-score", 0.99).metadata,
          observedAt: new Date("2020-01-01T00:00:00.000Z"),
          sourceAuthority: "DIRECT_AUTOMATIC" as const,
          sourceMode: "AUTOMATIC" as const,
          systemFrom: new Date("2020-01-01T00:00:00.000Z")
        }
      },
      {
        ...factLaneCandidate("recently-used", 0.8),
        metadata: {
          ...factLaneCandidate("recently-used", 0.8).metadata,
          lastUsedAt: new Date(now.getTime() - 3_600_000),
          sourceAuthority: "DIRECT_AUTOMATIC" as const,
          sourceMode: "AUTOMATIC" as const,
          temperatureScore: 1
        }
      }
    ];
    const run = async (enabled: boolean) => {
      const state = {
        ...snapshot("generation-1"),
        decayEnabled: enabled,
        decayPolicyVersion: enabled ? MEMORY_DECAY_POLICY_VERSION : null
      };
      const local = {
        expand: vi.fn(async () => candidates.map((candidate) => ({
          itemId: candidate.itemId,
          itemType: "FACT_VERSION" as const,
          occurredFrom: null,
          occurredTo: null,
          projectionKind: "FACT_DISPLAY_TEXT" as const,
          safeText: `fact ${candidate.itemId}`,
          sourceChatId: null,
          supportingItemId: null
        }))),
        retrieve: vi.fn(async () => ({
          core: [],
          laneResults: [{ candidates, lane: "FACT_VECTOR" as const }],
          lexicalFailures: [],
          lexicalState: "READY" as const,
          snapshot: state,
          vectorEvidence: [],
          vectorState: "READY" as const
        })),
        snapshot: vi.fn(async () => state)
      } as unknown as PrismaLocalMemoryRetrievalRepository;
      const options = retrievalOptions(["c0", "c1"]);
      vi.mocked(options.utilities.rerank).mockImplementation(async (input) => ({
        bindingId: "binding-relevance",
        decisions: input.candidates.map((candidate) => ({
          applicable: true,
          current: true,
          handle: candidate.handle,
          reasonCode: "DIRECT_RELEVANCE" as const,
          relevanceScore: candidate.handle === "c0" ? 0.95 : 0.7
        })),
        status: "READY"
      }));
      const base = runInput("Which saved fact is useful?");
      return createMemoryRunRetrievalService(local, options).retrieve({
        ...base,
        expected: {
          ...base.expected,
          settings: {
            ...base.expected.settings,
            decayEnabled: enabled,
            decayPolicyVersion: enabled ? MEMORY_DECAY_POLICY_VERSION : null
          }
        }
      });
    };

    const baseline = await run(false);
    const decayed = await run(true);
    expect(baseline.items?.map((item) =>
      "factVersionId" in item ? item.factVersionId : null)).toEqual([
      "old-high-score",
      "recently-used"
    ]);
    expect(decayed.items?.map((item) =>
      "factVersionId" in item ? item.factVersionId : null)).toEqual([
      "recently-used",
      "old-high-score"
    ]);
    expect(decayed.items?.map(({ finalScore }) => finalScore)).toEqual([0.7, 0.95]);
    expect(decayed.items?.[0]?.featureSnapshot).toMatchObject({
      decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION
    });
    expect(decayed.items).toHaveLength(baseline.items?.length ?? 0);
  });

  it("rejoins the accepted reranker set before decay and never packs a stale candidate", async () => {
    const candidates = [
      factLaneCandidate("still-authoritative", 0.8),
      factLaneCandidate("invalidated-after-rerank", 0.9)
    ];
    const state = {
      ...snapshot("generation-1"),
      decayEnabled: true,
      decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION
    };
    const expansion = (candidate: MemoryRankedCandidate): MemoryExpandedCandidate => ({
      itemId: candidate.itemId,
      itemType: "FACT_VERSION",
      occurredFrom: null,
      occurredTo: null,
      projectionKind: "FACT_DISPLAY_TEXT",
      safeText: `fact ${candidate.itemId}`,
      sourceChatId: null,
      supportingItemId: null
    });
    const expand = vi.fn(async (
      _snapshot: unknown,
      _plan: MemoryRetrievalPlan,
      ranked: readonly MemoryRankedCandidate[]
    ) => expand.mock.calls.length === 1
      ? ranked.map(expansion)
      : ranked.filter(({ itemId }) => itemId === "still-authoritative").map(expansion));
    const local = {
      expand,
      retrieve: vi.fn(async () => ({
        core: [],
        laneResults: [{ candidates, lane: "FACT_VECTOR" as const }],
        lexicalFailures: [],
        lexicalState: "READY" as const,
        snapshot: state,
        vectorEvidence: [],
        vectorState: "READY" as const
      })),
      snapshot: vi.fn(async () => state)
    } as unknown as PrismaLocalMemoryRetrievalRepository;
    const options = retrievalOptions(["c0", "c1"]);
    const base = runInput("Which saved fact is useful?");

    const result = await createMemoryRunRetrievalService(local, options).retrieve({
      ...base,
      expected: {
        ...base.expected,
        settings: {
          ...base.expected.settings,
          decayEnabled: true,
          decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION
        }
      }
    });

    expect(expand).toHaveBeenCalledTimes(2);
    expect(result.items).toEqual([
      expect.objectContaining({ factVersionId: "still-authoritative" })
    ]);
    expect(result.items?.[0]?.featureSnapshot).toMatchObject({
      decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION
    });
  });

  it("applies enabled decay order to admitted Core preferences without changing disabled order", async () => {
    const oldBase = responsePreferenceCore("core-old");
    const usedBase = responsePreferenceCore("core-used");
    const coreCandidates = [
      {
        ...oldBase,
        candidate: {
          ...oldBase.candidate,
          metadata: {
            ...oldBase.candidate.metadata,
            observedAt: new Date("2020-01-01T00:00:00.000Z"),
            systemFrom: new Date("2020-01-01T00:00:00.000Z")
          }
        }
      },
      {
        ...usedBase,
        candidate: {
          ...usedBase.candidate,
          metadata: {
            ...usedBase.candidate.metadata,
            lastUsedAt: new Date(now.getTime() - 3_600_000),
            temperatureScore: 1
          }
        }
      }
    ];
    const run = async (enabled: boolean) => {
      const local = repository({ core: coreCandidates, decayEnabled: enabled });
      const options = retrievalOptions(["c0", "c1"]);
      vi.mocked(options.utilities.rerank).mockImplementation(async (input) => ({
        bindingId: "binding-core-relevance",
        decisions: input.candidates.map((candidate) => ({
          applicable: true,
          current: true,
          handle: candidate.handle,
          reasonCode: "DIRECT_RELEVANCE" as const,
          relevanceScore: candidate.handle === "c0" ? 0.95 : 0.7
        })),
        status: "READY"
      }));
      const base = runInput("How should you respond?");
      return createMemoryRunRetrievalService(local.value, options).retrieve({
        ...base,
        expected: {
          ...base.expected,
          settings: {
            ...base.expected.settings,
            decayEnabled: enabled,
            decayPolicyVersion: enabled ? MEMORY_DECAY_POLICY_VERSION : null
          }
        }
      });
    };

    const baseline = await run(false);
    const decayed = await run(true);
    const ids = (items: typeof baseline.items) => items?.map((item) =>
      "factVersionId" in item ? item.factVersionId : null);
    expect(ids(baseline.items)).toEqual(["core-old", "core-used"]);
    expect(ids(decayed.items)).toEqual(["core-used", "core-old"]);
  });

  it.each(["HYBRID", "LEXICAL_ONLY"] as const)(
    "answers a broad profile from current facts on a usable %s index without query embedding",
    async (indexMode) => {
      const candidates = [
        profileFactLaneCandidate("saved-name", 1),
        profileFactLaneCandidate("saved-city", 0.95)
      ];
      const state = { ...snapshot("generation-1"), indexMode };
      const retrieve = vi.fn(async () => ({
        core: [],
        laneResults: [{ candidates, lane: "FACT_PROFILE" as const }],
        lexicalFailures: [],
        lexicalState: "READY" as const,
        snapshot: state,
        vectorEvidence: [],
        vectorState: "NOT_CONFIGURED" as const
      }));
      const local = {
        expand: vi.fn(async () => [
          {
            itemId: "saved-name",
            itemType: "FACT_VERSION" as const,
            occurredFrom: null,
            occurredTo: null,
            projectionKind: "FACT_DISPLAY_TEXT" as const,
            safeText: "The user's name is Dmitry.",
            sourceChatId: null,
            supportingItemId: null
          },
          {
            itemId: "saved-city",
            itemType: "FACT_VERSION" as const,
            occurredFrom: null,
            occurredTo: null,
            projectionKind: "FACT_DISPLAY_TEXT" as const,
            safeText: "The user lives in Rostov.",
            sourceChatId: null,
            supportingItemId: null
          }
        ]),
        retrieve,
        snapshot: vi.fn(async () => state)
      } as unknown as PrismaLocalMemoryRetrievalRepository;
      const options = intentOptions({
        memoryUseful: true,
        pastChatsUseful: false,
        profileRequested: true,
        retrievalMode: "CURRENT_PROFILE"
      });
      vi.mocked(options.utilities.rerank).mockImplementation(async (input) => ({
        bindingId: "binding-relevance",
        decisions: input.candidates.map((candidate) => ({
          applicable: true,
          current: true,
          handle: candidate.handle,
          reasonCode: "DIRECT_RELEVANCE" as const,
          relevanceScore: 0.9
        })),
        status: "READY"
      }));

      const result = await createMemoryRunRetrievalService(local, options)
        .retrieve(runInput("Что ты обо мне знаешь?"));

      expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
        plan: expect.objectContaining({
          filters: expect.objectContaining({ sourceKinds: ["FACT", "EVENT"] }),
          profileRequested: true
        })
      }));
      expect(retrieve).toHaveBeenCalledWith(expect.not.objectContaining({
        vector: expect.anything()
      }));
      expect(options.utilities.embedQuery).not.toHaveBeenCalled();
      expect(options.vectorRepository.resolveActiveProfile).not.toHaveBeenCalled();
      expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
        candidates: [
          expect.objectContaining({ sourceKind: "FACT", text: "The user's name is Dmitry." }),
          expect.objectContaining({ sourceKind: "FACT", text: "The user lives in Rostov." })
        ],
        profileRequested: true
      }));
      expect(result.outcome).toBe("USED");
      expect(result.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ factVersionId: "saved-name", itemType: "FACT_VERSION" }),
        expect.objectContaining({ factVersionId: "saved-city", itemType: "FACT_VERSION" })
      ]));
      expect(result.items).toHaveLength(2);
      expect(result.items?.some(({ itemType }) => itemType === "RECALL_CHUNK")).toBe(false);
    }
  );

  it("retrieves a broad profile directly when no local index is available", async () => {
    const local = repository({
      activeIndexGenerationId: null,
      candidates: [profileFactLaneCandidate("profile-name", 1)]
    });
    const options = intentOptions({
      memoryUseful: true,
      pastChatsUseful: false,
      profileRequested: true,
      retrievalMode: "CURRENT_PROFILE"
    });

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("Что ты обо мне знаешь?", null));

    expect(result).toMatchObject({
      items: [{ factVersionId: "profile-name", itemType: "FACT_VERSION" }],
      outcome: "USED"
    });
    expect(local.retrieve).toHaveBeenCalledOnce();
    expect(options.utilities.embedQuery).not.toHaveBeenCalled();
    expect(options.utilities.rerank).toHaveBeenCalledOnce();
  });

  it("returns ordinary zero-memory when a direct profile has no candidates", async () => {
    const initialState = snapshot("generation-1");
    const unavailableState = {
      ...initialState,
      indexMode: null,
      reason: "memory_index_unavailable"
    } as const;
    const retrieve = vi.fn(async () => ({
      core: [],
      laneResults: [],
      lexicalFailures: [],
      lexicalState: "DISABLED" as const,
      snapshot: unavailableState,
      vectorEvidence: [],
      vectorState: "NOT_CONFIGURED" as const
    }));
    const local = {
      expand: vi.fn(async () => []),
      retrieve,
      snapshot: vi.fn(async () => initialState)
    } as unknown as PrismaLocalMemoryRetrievalRepository;
    const options = intentOptions({
      memoryUseful: true,
      pastChatsUseful: false,
      profileRequested: true,
      retrievalMode: "CURRENT_PROFILE"
    });

    const result = await createMemoryRunRetrievalService(local, options)
      .retrieve(runInput("Что ты обо мне знаешь?"));

    expect(result).toMatchObject({ items: [], outcome: "EMPTY", preparedContext: null });
    expect(retrieve).toHaveBeenCalledOnce();
    expect(local.expand).not.toHaveBeenCalled();
    expect(options.utilities.embedQuery).not.toHaveBeenCalled();
    expect(options.utilities.rerank).not.toHaveBeenCalled();
  });

  it("reranks legacy sensitive history with the same policy as normal history", () => {
    const candidates = memoryRelevanceCandidates(
      [rankedHistory("sensitive-history", "SENSITIVE")],
      [expandedHistory("sensitive-history")]
    );
    expect(candidates).toMatchObject([{ sensitivityClass: "NORMAL" }]);
    const decide = (reasonCode: "DIRECT_RELEVANCE" | "SUPPORTING_CONTEXT", score: number) =>
      applyMemoryRelevance(candidates, {
        bindingId: "binding-relevance",
        decisions: [{
          applicable: true,
          current: true,
          handle: "c0",
          reasonCode,
          relevanceScore: score
        }],
        status: "READY"
      });

    expect(decide("SUPPORTING_CONTEXT", 0.95)).toMatchObject([
      { itemId: "sensitive-history" }
    ]);
    expect(decide("DIRECT_RELEVANCE", 0.79)).toMatchObject([
      { itemId: "sensitive-history" }
    ]);
    expect(decide("DIRECT_RELEVANCE", 0.8)).toMatchObject([
      { itemId: "sensitive-history" }
    ]);
  });

  it("keeps zero and legacy-floor scores because the junk floor is disabled", () => {
    const candidates = memoryRelevanceCandidates(
      [rankedHistory("at-floor", "NORMAL")],
      [expandedHistory("at-floor")]
    );
    const decide = (score: number) => applyMemoryRelevance(candidates, {
      bindingId: "binding-relevance",
      decisions: [{
        applicable: true,
        current: true,
        handle: "c0",
        reasonCode: "DIRECT_RELEVANCE",
        relevanceScore: score
      }],
      status: "READY"
    });
    expect(decide(0)).toHaveLength(1);
    expect(decide(0.6)).toHaveLength(1);
    expect(decide(0.600_001)).toHaveLength(1);
  });

  it("keeps deterministic sorter bonuses inside the persisted unit-score contract", () => {
    const base = core("exact-unit-score");
    const exact = {
      ...base.candidate,
      featureSnapshot: {
        ...base.candidate.featureSnapshot,
        deterministicMatches: ["EXACT_TEXT" as const]
      }
    };
    const candidates = memoryRelevanceCandidates([exact], [base.expansion]);
    const ranked = applyMemoryRelevance(candidates, {
      bindingId: "binding-unit-score",
      decisions: [{
        applicable: true,
        current: true,
        handle: "c0",
        reasonCode: "DIRECT_RELEVANCE",
        relevanceScore: 1
      }],
      status: "READY"
    });

    expect(ranked).toMatchObject([{ finalScore: 1, itemId: "exact-unit-score" }]);
  });

  it("retains episodic RRF evidence on abstention or unavailable reranking", async () => {
    for (const decision of [[], null] as const) {
      const local = repository({ candidates: [laneCandidate("a")], core: [core()] });
      const result = await createMemoryRunRetrievalService(
        local.value,
        retrievalOptions(decision)
      ).retrieve(runInput("unrelated question"));
      expect(result.items).toEqual([
        expect.objectContaining({ recallChunkId: "a" })
      ]);
      expect(result.outcome).toBe(decision === null ? "DEGRADED" : "USED");
    }
  });

  it("[E07] preserves exact current facts in RRF fallback", async () => {
    const exact: MemoryLaneCandidate = {
      ...factLaneCandidate("exact-current", 1),
      deterministicMatch: "EXACT_TEXT",
      entryId: null,
      lane: "FACT_EXACT"
    };
    const local = repository({ activeIndexGenerationId: null, candidates: [exact] });
    const result = await createMemoryRunRetrievalService(
      local.value,
      retrievalOptions(null)
    ).retrieve(runInput("exact current", null));

    expect(result).toMatchObject({
      degradationCode: "memory_relevance_unavailable",
      items: [{
        factVersionId: "exact-current",
        selectionReason: "fact_exact+rerank_fallback_rrf"
      }],
      outcome: "DEGRADED"
    });
  });

  it("freezes validated pattern and entity hints without granting item authority", async () => {
    const opaqueRef = `mr1.${"a".repeat(500)}`;
    const local = repository({ candidates: [factLaneCandidate("hinted-fact", 0.8)] });
    const options = {
      ...intentOptions({
        entityMentions: [{ occurrenceIndex: 0, resolvedRef: opaqueRef, text: "Acme" }],
        includePatterns: true,
        memoryUseful: true,
        pastChatsUseful: false,
        queryText: "Acme workflow"
      }),
      controlRefs: { load: vi.fn(async () => [opaqueRef]) }
    };

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("Use the relevant context."));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        entityMentions: [{ occurrenceIndex: 0, resolvedRef: opaqueRef, text: "Acme" }],
        includePatterns: true
      })
    }));
    expect(result).toMatchObject({
      budgetSnapshot: {
        plan: {
          entityMentionCount: 1,
          resolvedEntityMentionCount: 1,
          includePatterns: true
        }
      },
      items: [{ featureSnapshot: { includePatterns: true } }],
      outcome: "USED"
    });
  });

  it("[E07] lets mandatory final authority remove a degraded exact candidate", async () => {
    const exact: MemoryLaneCandidate = {
      ...factLaneCandidate("exact-stale", 1),
      deterministicMatch: "EXACT_TEXT",
      entryId: null,
      lane: "FACT_EXACT"
    };
    const local = repository({ activeIndexGenerationId: null, candidates: [exact] });
    vi.mocked(local.value.expand).mockImplementation(async (_snapshot, _plan, ranked) =>
      vi.mocked(local.value.expand).mock.calls.length === 1
        ? ranked.map((candidate) => ({
            itemId: candidate.itemId,
            itemType: "FACT_VERSION" as const,
            occurredFrom: null,
            occurredTo: null,
            projectionKind: "FACT_DISPLAY_TEXT" as const,
            safeText: `relevant text ${candidate.itemId}`,
            sourceChatId: null,
            supportingItemId: null
          }))
        : []);

    const result = await createMemoryRunRetrievalService(
      local.value,
      retrievalOptions(null)
    ).retrieve(runInput("exact stale", null));

    expect(local.value.expand).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ items: [], outcome: "EMPTY", preparedContext: null });
  });

  it.each([
    {
      candidateLane: "FACT_FTS_SIMPLE" as const,
      code: "memory_query_embedding_unavailable",
      embeddingUnavailable: true,
      lexicalFailures: [] as readonly MemoryRetrievalLane[],
      lexicalState: "READY" as const,
      vectorState: "NOT_CONFIGURED" as const
    },
    {
      candidateLane: "FACT_VECTOR" as const,
      code: "memory_fts_unavailable",
      embeddingUnavailable: false,
      lexicalFailures: ["FACT_FTS_SIMPLE"] as readonly MemoryRetrievalLane[],
      lexicalState: "DEGRADED" as const,
      vectorState: "READY" as const
    },
    {
      candidateLane: "FACT_VECTOR" as const,
      code: "memory_fts_unavailable",
      embeddingUnavailable: false,
      lexicalFailures: [
        "FACT_FTS_RUSSIAN", "FACT_TRIGRAM"
      ] as readonly MemoryRetrievalLane[],
      lexicalState: "DEGRADED" as const,
      vectorState: "READY" as const
    },
    {
      candidateLane: "FACT_FTS_SIMPLE" as const,
      code: "memory_entity_unavailable",
      embeddingUnavailable: false,
      lexicalFailures: ["FACT_ENTITY"] as readonly MemoryRetrievalLane[],
      lexicalState: "DEGRADED" as const,
      vectorState: "READY" as const
    },
    {
      candidateLane: "FACT_FTS_SIMPLE" as const,
      code: "memory_vector_unavailable",
      embeddingUnavailable: false,
      lexicalFailures: [] as readonly MemoryRetrievalLane[],
      lexicalState: "READY" as const,
      vectorState: "DEGRADED" as const
    }
  ])("[E07] keeps authoritative candidates when one signal degrades: $code", async (testCase) => {
    const candidate: MemoryLaneCandidate = {
      ...factLaneCandidate(testCase.code, 0.8),
      lane: testCase.candidateLane
    };
    const local = repository({
      candidates: [candidate],
      lexicalFailures: testCase.lexicalFailures,
      lexicalState: testCase.lexicalState,
      vectorState: testCase.vectorState
    });
    const options = retrievalOptions(["c0"]);
    if (testCase.embeddingUnavailable) {
      vi.mocked(options.utilities.embedQuery).mockResolvedValue({
        reason: "memory_query_embedding_unavailable",
        status: "UNAVAILABLE"
      });
    }

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("current fact"));

    expect(result).toMatchObject({
      degradationCode: testCase.code,
      items: [{ factVersionId: testCase.code }],
      outcome: "DEGRADED"
    });
    expect(options.utilities.rerank).toHaveBeenCalledOnce();
  });

  it("returns zero dynamic memory when every ranking signal is absent", async () => {
    const local = repository({
      lexicalFailures: ["FACT_EXACT", "FACT_ENTITY", "FACT_FTS_SIMPLE"],
      lexicalState: "FAILED",
      vectorState: "DEGRADED"
    });
    const options = retrievalOptions(["c0"]);
    vi.mocked(options.utilities.embedQuery).mockResolvedValue({
      reason: "memory_query_embedding_unavailable",
      status: "UNAVAILABLE"
    });

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("current fact"));

    expect(result).toMatchObject({ items: [], outcome: "EMPTY", preparedContext: null });
    expect(options.utilities.rerank).not.toHaveBeenCalled();
  });

  it("redacts recognizable-secret spans and retrieves with the safe remainder", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const local = repository({ candidates: [laneCandidate("safe-query-result")] });
    const options = retrievalOptions(["c0"]);
    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput(`Where do I live? token ${secret}`));

    expect(local.retrieve).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      budgetSnapshot: {
        componentMetrics: {
          safetyFindingCounts: { KNOWN_TOKEN: 1 }
        },
        querySafetyVersion: "memory-read-query-safety-v2"
      },
      items: [{ exactItemId: "safe-query-result" }],
      querySnapshot: "Where do I live? token [REDACTED:TOKEN]"
    });
    expect(options.control.decide).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        currentUserMessage: "Where do I live? token [REDACTED:TOKEN]"
      })
    }));
    expect(options.utilities.embedQuery).toHaveBeenCalledWith(expect.objectContaining({
      query: "Where do I live? token [REDACTED:TOKEN]"
    }));
    expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
      query: "Where do I live? token [REDACTED:TOKEN]"
    }));
    expect(JSON.stringify([
      local.retrieve.mock.calls,
      vi.mocked(options.control.decide).mock.calls,
      vi.mocked(options.utilities.embedQuery).mock.calls,
      vi.mocked(options.utilities.rerank).mock.calls
    ])).not.toContain(secret);
  });

  it("redacts legacy metadata before persisting retrieval diagnostics", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const candidate = factLaneCandidate("safe-fact", 0.9);
    const local = repository({
      candidates: [{
        ...candidate,
        metadata: { ...candidate.metadata, category: `legacy ${secret}` }
      }]
    });
    const result = await createMemoryRunRetrievalService(
      local.value,
      retrievalOptions(["c0"])
    ).retrieve(runInput("What do you remember?"));

    expect(result.budgetSnapshot).toMatchObject({
      relevanceDecisions: [{ category: "legacy [REDACTED:TOKEN]" }]
    });
    expect(JSON.stringify(result.budgetSnapshot)).not.toContain(secret);
  });

  it("sends low-similarity cross-language Saved facts to the mandatory reranker only", async () => {
    const candidates = [
      factLaneCandidate("saved-name", 0.2),
      factLaneCandidate("arbitrary-fact", 0.19)
    ];
    const state = snapshot("generation-1");
    const retrieve = vi.fn(async () => ({
      core: [],
      laneResults: [{ candidates, lane: "FACT_VECTOR" as const }],
      lexicalFailures: [],
      lexicalState: "READY" as const,
      snapshot: state,
      vectorEvidence: [],
      vectorState: "READY" as const
    }));
    const local = {
      expand: vi.fn(async () => [
        {
          itemId: "saved-name",
          itemType: "FACT_VERSION" as const,
          occurredFrom: null,
          occurredTo: null,
          projectionKind: "FACT_DISPLAY_TEXT" as const,
          safeText: "The user's name is Dmitry.",
          sourceChatId: null,
          supportingItemId: null
        },
        {
          itemId: "arbitrary-fact",
          itemType: "FACT_VERSION" as const,
          occurredFrom: null,
          occurredTo: null,
          projectionKind: "FACT_DISPLAY_TEXT" as const,
          safeText: "The user owns a green bicycle.",
          sourceChatId: null,
          supportingItemId: null
        }
      ]),
      retrieve,
      snapshot: vi.fn(async () => state)
    } as unknown as PrismaLocalMemoryRetrievalRepository;
    const options = retrievalOptions(["c0"]);

    const result = await createMemoryRunRetrievalService(local, options)
      .retrieve(runInput("Как меня зовут?"));

    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      vector: expect.objectContaining({ minimumScore: -1 })
    }));
    expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [
        expect.objectContaining({
          authorityLevel: "SAVED",
          handle: "c0",
          text: "The user's name is Dmitry."
        }),
        expect.objectContaining({
          authorityLevel: "SAVED",
          handle: "c1",
          text: "The user owns a green bicycle."
        })
      ],
      query: "Как меня зовут?"
    }));
    expect(result.items).toEqual([
      expect.objectContaining({ factVersionId: "saved-name" }),
      expect.objectContaining({ factVersionId: "arbitrary-fact" })
    ]);
  });
});
