import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
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
import type {
  MemoryAggregationSessionCompletion,
  PrismaLocalMemoryRetrievalRepository
} from "./localRepository";
import type { MemoryControlResult, MemoryControlService } from "../actions/controlRuntime";
import {
  applyMemoryRelevance,
  createMemoryRunRetrievalService,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS,
  MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS,
  MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
  MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS,
  MEMORY_RERANK_OPTIONAL_MAXIMUM_MS,
  mergeMemoryAggregationSessionCompletion,
  memoryRelevanceCandidates,
  selectMemoryAggregationRawCandidates,
  type MemoryRunControlCache,
  type MemoryRunRetrievalExpectedSnapshot
} from "./runAdmission";
import type {
  MemoryRunRerankResult,
  MemoryRunUtilityService
} from "./runUtilities";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT, type MemoryVectorProfile } from "./vector";

const now = new Date("2026-08-13T10:00:00.000Z");
const currentControlContract = Object.freeze({
  aggregationRequested: false,
  queryDecompositions: [] as string[],
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

function rankedToolEvent(id: string): MemoryRankedCandidate {
  const history = rankedHistory(id, "NORMAL");
  return {
    ...history,
    itemType: "TOOL_EVENT",
    metadata: {
      ...history.metadata,
      modality: "EVENT",
      occurredAt: now,
      occurredFrom: now,
      occurredTo: now,
      sourceAuthority: "TOOL_OBSERVATION"
    }
  };
}

function expandedToolEvent(id: string): MemoryExpandedCandidate {
  return {
    itemId: id,
    itemType: "TOOL_EVENT",
    occurredFrom: now,
    occurredTo: now,
    projectionKind: "TOOL_EVENT_SAFE_TEXT",
    safeText: "Tool file_create completed successfully; filename=report.csv.",
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
  aggregationCandidates?: readonly MemoryLaneCandidate[];
  candidates?: readonly MemoryLaneCandidate[];
  completion?: MemoryAggregationSessionCompletion;
  core?: readonly MemoryCoreCandidate[];
  decayEnabled?: boolean;
  hybridCandidates?: readonly MemoryLaneCandidate[];
  lexicalFailures?: readonly MemoryRetrievalLane[];
  lexicalState?: "DEGRADED" | "DISABLED" | "FAILED" | "READY";
  projectAggregationSessions?: (
    ranked: readonly MemoryRankedCandidate[]
  ) => readonly MemoryRankedCandidate[];
  speculativeBaseline?: boolean;
  speculativeDense?: boolean;
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
  const retrieve = vi.fn(async (_input: { plan: MemoryRetrievalPlan; vector?: unknown }) => {
    const selectedCandidates = _input.plan.aggregationRequested &&
      options.aggregationCandidates
      ? options.aggregationCandidates
      : _input.vector && options.hybridCandidates ? options.hybridCandidates : candidates;
    return ({
    core: options.core ?? [],
    laneResults: [...new Set(selectedCandidates.map(({ lane }) => lane))].map((lane) => ({
      candidates: selectedCandidates.filter((candidate) => candidate.lane === lane),
      lane
    })),
    lexicalFailures: options.lexicalFailures ?? [],
    lexicalState: options.lexicalState ??
      (activeIndexGenerationId ? "READY" as const : "DISABLED" as const),
    snapshot: state, vectorEvidence: [],
    vectorState: options.vectorState ??
      (activeIndexGenerationId ? "READY" as const : "NOT_CONFIGURED" as const)
    });
  });
  const coreByKey = new Map((options.core ?? []).map((entry) => [
    `${entry.candidate.itemType}:${entry.candidate.itemId}`,
    entry.expansion
  ]));
  const projectAggregationSessions = vi.fn(async (
    _snapshot: unknown,
    _plan: MemoryRetrievalPlan,
    ranked: readonly MemoryRankedCandidate[]
  ) => options.projectAggregationSessions?.(ranked) ?? ranked);
  const retrieveSpeculativeBaseline = options.speculativeBaseline
    ? vi.fn(async (input: { plan: MemoryRetrievalPlan }) => ({
        ...await retrieve(input),
        vectorState: "NOT_CONFIGURED" as const
      }))
    : null;
  const retrieveSpeculativeDense = options.speculativeDense
    ? vi.fn(async (input: { plan: MemoryRetrievalPlan; vector: unknown }) => {
        const result = await retrieve(input);
        return {
          ...result,
          core: [],
          laneResults: result.laneResults.filter(({ lane }) =>
            lane === "FACT_VECTOR" || lane === "HISTORY_RECALL_VECTOR"),
          lexicalFailures: [],
          lexicalState: "DISABLED" as const
        };
      })
    : null;
  const expand = vi.fn(async (
    _snapshot: unknown,
    _plan: MemoryRetrievalPlan,
    ranked: readonly MemoryRankedCandidate[]
  ) => ranked.map((candidate): MemoryExpandedCandidate => {
    const coreExpansion = coreByKey.get(`${candidate.itemType}:${candidate.itemId}`);
    if (coreExpansion) return coreExpansion;
    if (candidate.itemType === "RECALL_CHUNK") {
      return {
          itemId: candidate.itemId,
          itemType: "RECALL_CHUNK",
          occurredFrom: now,
          occurredTo: new Date(now.getTime() + 60_000),
          projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
          safeText: `relevant text ${candidate.itemId}`,
          sourceChatId: candidate.metadata.sourceChatId,
          supportingItemId: null
        };
    }
    if (candidate.itemType === "RECALL_ROUND") {
      return {
        itemId: candidate.itemId,
        itemType: "RECALL_ROUND",
        occurredFrom: now,
        occurredTo: new Date(now.getTime() + 60_000),
        projectionKind: candidate.matchedSegmentId
          ? "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT"
          : "RECALL_ROUND_RAW_SAFE_TEXT",
        safeText: `relevant round text ${candidate.matchedSegmentId ?? candidate.itemId}`,
        sourceChatId: candidate.metadata.sourceChatId,
        supportingItemId: candidate.metadata.parentChunkId ?? "parent-chunk"
      };
    }
    return {
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
  const completeAggregationSessionEvidence = options.completion
    ? vi.fn(async () => options.completion!)
    : null;
  const value = {
    expand,
    expandAggregationNavigation: expand,
    ...(completeAggregationSessionEvidence ? { completeAggregationSessionEvidence } : {}),
    projectAggregationSessions,
    retrieve,
    ...(retrieveSpeculativeBaseline ? { retrieveSpeculativeBaseline } : {}),
    ...(retrieveSpeculativeDense ? { retrieveSpeculativeDense } : {}),
    snapshot: vi.fn(async () => state)
  } as unknown as PrismaLocalMemoryRetrievalRepository;
  return {
    completeAggregationSessionEvidence,
    expand,
    projectAggregationSessions,
    retrieve,
    retrieveSpeculativeBaseline,
    retrieveSpeculativeDense,
    state,
    value
  };
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
          memoryUseful: true,
          patternExclusionRequested: false,
          pastChatsUseful: true,
          profileRequested: false,
          queryDecompositions: [],
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
          memoryUseful: false,
          patternExclusionRequested: false,
          pastChatsUseful: false,
          profileRequested: false,
          queryDecompositions: [],
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
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        control: { decide }
      }).retrieve(runInput("What do I prefer?"));

      await vi.advanceTimersByTimeAsync(MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS - 1);
      expect(receivedSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(receivedSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          aggregationState: "READER_REQUIRED",
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          plannerFallbackReason: "memory_action_intent_unavailable"
        },
        items: [{ exactItemId: "control-timeout-local" }],
        outcome: "USED"
      });
      expect(base.utilities.embedQuery).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlaps control and original-query embedding instead of summing their latency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("parallel-read")] });
      const base = retrievalOptions(["c0"]);
      const started: string[] = [];
      const control = {
        decide: vi.fn((input: Parameters<MemoryControlService["decide"]>[0]) =>
          new Promise<Awaited<ReturnType<MemoryControlService["decide"]>>>((resolve) => {
            started.push("control");
            setTimeout(() => void base.control.decide(input).then(resolve), 3_500);
          }))
      };
      const utility = base.utilities;
      const parallelUtilities: MemoryRunUtilityService = {
        ...utility,
        embedQuery: vi.fn((input) =>
          new Promise<Awaited<ReturnType<MemoryRunUtilityService["embedQuery"]>>>(
            (resolve) => {
              started.push("embedding");
              setTimeout(() => void utility.embedQuery(input).then(resolve), 3_500);
            }
          ))
      };
      let settled = false;
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        control,
        monotonicClock: Date.now,
        utilities: parallelUtilities
      }).retrieve(runInput("What do I prefer?"))
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(started.sort()).toEqual(["control", "embedding"]);
      await vi.advanceTimersByTimeAsync(3_499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.outcome).toBe("USED");
      expect(result.budgetSnapshot).toMatchObject({
        controlMs: 3_500,
        memoryPrepareMs: 3_500,
        queryEmbeddingMs: 3_500
      });
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
      baselinePlan: expect.objectContaining({
        filters: expect.objectContaining({
          sourceKinds: ["FACT", "EVENT", "HISTORY"]
        }),
        semanticQueryVariants: [
          { kind: "ORIGINAL", text: "What happened yesterday?" }
        ]
      }),
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
      baselineSourceKinds: ["FACT", "EVENT", "HISTORY"],
      candidateCountsBySourceKind: { EVENT: 0, FACT: 2, HISTORY: 0 },
      plannerExcludedSourceKinds: [],
      plannerPreferredSourceKinds: ["FACT", "EVENT", "HISTORY"],
      rerankCandidateCount: 2,
      rerankCoverageRatio: 0,
      rerankFullFallbackUsed: true,
      searchHitCount: 2,
      searchHitExpandableCount: 2,
      searchHitWithoutExpandableEvidence: 0,
      sourceFamilyHardExclusionReasons: [],
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

  it("records content-free monotonic stage latency and provider call evidence", async () => {
    const local = repository({ candidates: [laneCandidate("timed-memory")] });
    const options = retrievalOptions(["c0"]);
    let tick = 0;
    const result = await createMemoryRunRetrievalService(local.value, {
      ...options,
      monotonicClock: () => {
        tick += 5;
        return tick;
      }
    }).retrieve(runInput("What did I save?"));
    const budget = result.budgetSnapshot as Record<string, unknown>;

    expect(budget).toMatchObject({
      aggregationProviderCalls: 0,
      controlProviderCalls: 1,
      memoryPrepareLatencyBucket: "LT_1S",
      queryEmbeddingProviderCalls: 1,
      rerankProviderCalls: 1
    });
    for (const field of [
      "aggregationProviderMs",
      "controlMs",
      "deterministicAggregationMs",
      "localRetrievalMs",
      "memoryPrepareMs",
      "packerMs",
      "queryEmbeddingMs",
      "rejoinMs",
      "rerankMs",
      "snapshotMs"
    ]) {
      expect(budget[field]).toEqual(expect.any(Number));
      expect(Number(budget[field])).toBeGreaterThanOrEqual(0);
    }
    expect(Number(budget.memoryPrepareMs)).toBeGreaterThan(0);
    expect(JSON.stringify(budget)).not.toContain("What did I save?");
  });

  it("reports exact segment expansion and evidence-root collapse without exposing child ids", async () => {
    const roundId = "round-with-overlap";
    const evidenceRootHash = "e".repeat(64);
    const base = laneCandidate(roundId);
    const segmentCandidate = (
      segmentId: string,
      position: "PREFIX" | "SUFFIX",
      lane: MemoryRetrievalLane
    ): MemoryLaneCandidate => ({
      ...base,
      entryId: `entry-${segmentId}`,
      itemType: "RECALL_ROUND",
      lane,
      matchedSegmentId: segmentId,
      matchedSegmentPosition: position,
      metadata: {
        ...base.metadata,
        evidenceRootHash,
        parentChunkId: "parent-round-chunk"
      }
    });
    const local = repository({
      candidates: [
        segmentCandidate("private-prefix-segment", "PREFIX", "HISTORY_RECALL_FTS_SIMPLE"),
        segmentCandidate("private-suffix-segment", "SUFFIX", "HISTORY_RECALL_VECTOR")
      ]
    });
    const result = await createMemoryRunRetrievalService(
      local.value,
      retrievalOptions(["c0"])
    ).retrieve(runInput("What happened during the rehearsal?"));
    const budget = result.budgetSnapshot as Record<string, unknown>;
    const componentMetrics = budget.componentMetrics as Record<string, number>;

    expect(result.items).toEqual([
      expect.objectContaining({
        exactItemId: roundId,
        itemType: "RECALL_ROUND",
        projectionKind: "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT",
        recallRoundId: roundId,
        recallRoundSegmentId: expect.stringMatching(/^private-(?:prefix|suffix)-segment$/u)
      })
    ]);
    expect(componentMetrics).toMatchObject({
      rawRoundSegmentExpansions: 1,
      readerPackSegmentCount: 1,
      segmentsCollapsedByEvidenceRoot: 1
    });
    expect((componentMetrics.matchedSegmentPrefixHits ?? 0) +
      (componentMetrics.matchedSegmentSuffixHits ?? 0)).toBe(1);
    expect(JSON.stringify(componentMetrics)).not.toContain("private-prefix-segment");
    expect(JSON.stringify(componentMetrics)).not.toContain("private-suffix-segment");
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
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        control,
        utilities: utilitiesWithHangingEmbedding
      }).retrieve(runInput("What do I prefer?"));

      await vi.advanceTimersByTimeAsync(MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS);
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

  it("uses a cooperatively settled local pack at the child deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("deadline-partial-local")] });
      const originalRetrieve = local.retrieve.getMockImplementation()!;
      const retrievalSignals: AbortSignal[] = [];
      local.retrieve.mockImplementation(async (input) => {
        const signal = (input as { settleSignal?: AbortSignal }).settleSignal;
        if (!signal) throw new Error("memory_local_settle_signal_missing");
        retrievalSignals.push(signal);
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return originalRetrieve(input);
      });
      let settled = false;
      const pending = createMemoryRunRetrievalService(local.value, {
        ...retrievalOptions([]),
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        monotonicClock: Date.now
      }).retrieve(runInput("What do I prefer?"))
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(retrievalSignals).toHaveLength(1);
      expect(retrievalSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        items: [{ exactItemId: "deadline-partial-local" }],
        outcome: "USED"
      });
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

      const admittedRoleBudgetMs = MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS;
      await vi.advanceTimersByTimeAsync(admittedRoleBudgetMs - 1);
      expect(settled).toBe(false);
      expect(embeddingSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        budgetSnapshot: { degradationCode: "memory_query_embedding_unavailable" },
        items: [{ exactItemId: "embedding-budget-local" }],
        outcome: "DEGRADED"
      });
      expect(embeddingSignals[0]?.aborted).toBe(true);
      expect(admittedRoleBudgetMs).toBe(4_000);
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
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        control,
        utilities: utilitiesWithHangingRerank
      }).retrieve(runInput("What do I prefer?"));

      await vi.advanceTimersByTimeAsync(MEMORY_RERANK_OPTIONAL_MAXIMUM_MS);
      const result = await pending;

      expect(controlSignals[0]).not.toBe(embeddingSignals[0]);
      expect(embeddingSignals[0]).not.toBe(rerankSignals[0]);
      expect(controlSignals[0]?.aborted).toBe(false);
      expect(embeddingSignals[0]?.aborted).toBe(false);
      expect(rerankSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          utilityEgressMode: "CONSENTED_EXTERNAL"
        },
        items: [{ exactItemId: "pending-rerank" }],
        outcome: "USED"
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
        items: [{ exactItemId: "rerank-budget-local" }],
        outcome: "USED"
      });
      expect(rerankSignals[0]?.aborted).toBe(true);
      expect(MEMORY_RERANK_OPTIONAL_MAXIMUM_MS).toBe(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start reranking after the ten-second soft deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({ candidates: [laneCandidate("soft-deadline-rrf")] });
      const originalRetrieve = local.retrieve.getMockImplementation()!;
      local.retrieve.mockImplementation((input) => new Promise((resolve) => {
        setTimeout(() => void originalRetrieve(input).then(resolve), 1_200);
      }));
      const originalProjection = local.projectAggregationSessions.getMockImplementation()!;
      local.projectAggregationSessions.mockImplementation((...args) =>
        new Promise((resolve) => {
          setTimeout(() => void originalProjection(...args).then(resolve), 1_000);
        }));
      const base = intentOptions({
        aggregationRequested: true,
        memoryUseful: false,
        pastChatsUseful: true,
        retrievalMode: "PAST_CHAT_SEARCH",
        temporalIntent: "ANY"
      });
      const originalControl = base.control.decide;
      const control = {
        decide: vi.fn((input: Parameters<MemoryControlService["decide"]>[0]) =>
          new Promise<Awaited<ReturnType<MemoryControlService["decide"]>>>((resolve) => {
            setTimeout(() => void originalControl(input).then(resolve), 7_900);
          }))
      };
      let settled = false;
      const pending = createMemoryRunRetrievalService(local.value, {
        ...base,
        admissionDeadlineMs: 120_000,
        clock: Date.now,
        control,
        monotonicClock: Date.now
      }).retrieve(runInput("Which releases did I complete?"))
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(10_099);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(base.utilities.rerank).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        budgetSnapshot: {
          aggregationState: "READER_REQUIRED",
          rerankProviderCalls: 0
        },
        items: [{ exactItemId: "soft-deadline-rrf" }],
        outcome: "USED"
      });
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

  it("caps control at eight seconds despite a longer outer deadline", async () => {
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

      await vi.advanceTimersByTimeAsync(MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        budgetSnapshot: {
          plannerFallbackReason: "memory_action_intent_unavailable"
        },
        outcome: "EMPTY"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let administrator headroom extend the interactive control ceiling", async () => {
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
        controlCache: { admissionDeadlineAtMs: now.getTime() + 120_000 }
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        budgetSnapshot: {
          plannerFallbackReason: "memory_action_intent_unavailable"
        },
        outcome: "EMPTY"
      });
      expect(MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS).toBe(8_000);
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

  it("keeps query anchors ahead of source completion and deduplicates evidence roots", () => {
    const anchor = {
      ...rankedHistory("anchor", "NORMAL"),
      metadata: {
        ...rankedHistory("anchor", "NORMAL").metadata,
        evidenceRootHash: "a".repeat(64)
      }
    };
    const duplicate = {
      ...rankedHistory("duplicate-round", "NORMAL"),
      itemType: "RECALL_ROUND" as const,
      metadata: {
        ...rankedHistory("duplicate-round", "NORMAL").metadata,
        evidenceRootHash: "a".repeat(64)
      },
      selectionReason: "aggregation_session_completion"
    };
    const completed = {
      ...rankedHistory("completed-round", "NORMAL"),
      itemType: "RECALL_ROUND" as const,
      metadata: {
        ...rankedHistory("completed-round", "NORMAL").metadata,
        evidenceRootHash: "b".repeat(64)
      },
      selectionReason: "aggregation_session_completion"
    };
    const completionExpansion = (itemId: string): MemoryExpandedCandidate => ({
      itemId,
      itemType: "RECALL_ROUND",
      occurredFrom: now,
      occurredTo: new Date(now.getTime() + 60_000),
      projectionKind: "RECALL_ROUND_RAW_SAFE_TEXT",
      safeText: `completed ${itemId}`,
      sourceChatId: "chat-source",
      supportingItemId: "parent-chunk"
    });
    const completion: MemoryAggregationSessionCompletion = {
      candidates: [duplicate, completed],
      sourceChatCount: 1
    };

    const merged = mergeMemoryAggregationSessionCompletion(
      [anchor],
      [expandedHistory("anchor")],
      completion,
      [
        completionExpansion("duplicate-round"),
        completionExpansion("completed-round")
      ]
    );

    expect(merged.candidates.map(({ itemId }) => itemId)).toEqual([
      "anchor", "completed-round"
    ]);
    expect(merged.expansions.map(({ itemId }) => itemId)).toEqual([
      "anchor", "completed-round"
    ]);
    expect(merged.completionCandidateCount).toBe(1);
  });

  it("makes strong-session completion reachable before the weak-source tail", () => {
    const sourceCandidate = (
      itemId: string,
      sourceChatId: string,
      evidenceRootHash: string
    ): MemoryRankedCandidate => {
      const candidate = rankedHistory(itemId, "NORMAL");
      return {
        ...candidate,
        metadata: {
          ...candidate.metadata,
          dedupeKey: `history:${evidenceRootHash}`,
          evidenceRootHash,
          sourceChatId
        }
      };
    };
    const sourceExpansion = (
      candidate: MemoryRankedCandidate
    ): MemoryExpandedCandidate => ({
      itemId: candidate.itemId,
      itemType: candidate.itemType,
      occurredFrom: now,
      occurredTo: new Date(now.getTime() + 60_000),
      projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
      safeText: `evidence ${candidate.itemId}`,
      sourceChatId: candidate.metadata.sourceChatId,
      supportingItemId: null
    });
    const anchors = [
      sourceCandidate("a-anchor", "chat-a", "a".repeat(64)),
      sourceCandidate("b-anchor", "chat-b", "b".repeat(64)),
      sourceCandidate("c-anchor", "chat-c", "c".repeat(64)),
      sourceCandidate("d-anchor", "chat-d", "d".repeat(64))
    ];
    const aCompletion = sourceCandidate(
      "a-completion",
      "chat-a",
      "e".repeat(64)
    );

    const merged = mergeMemoryAggregationSessionCompletion(
      anchors,
      anchors.map(sourceExpansion),
      { candidates: [aCompletion], sourceChatCount: 1 },
      [sourceExpansion(aCompletion)]
    );

    expect(merged.candidates.map(({ itemId }) => itemId)).toEqual([
      "a-anchor",
      "b-anchor",
      "a-completion",
      "c-anchor",
      "d-anchor"
    ]);
    expect(merged.completionCandidateCount).toBe(1);
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
    })[0]?.selectionReason).toBe("rerank_fallback_rrf");
  });

  it("revalidates exact rerank coverage before applying any semantic score", () => {
    const candidates = memoryRelevanceCandidates(
      [rankedHistory("atomic-a", "NORMAL"), rankedHistory("atomic-b", "NORMAL")],
      [expandedHistory("atomic-a"), expandedHistory("atomic-b")]
    );
    const decision = (handle: string, relevanceScore = 0.9) => ({
      applicable: true,
      current: true,
      handle,
      reasonCode: "DIRECT_RELEVANCE" as const,
      relevanceScore
    });
    const invalidResults: MemoryRunRerankResult[] = [{
      bindingId: "missing",
      decisions: [decision("c0")],
      status: "READY"
    }, {
      bindingId: "duplicate",
      decisions: [decision("c0"), decision("c0", 0.8)],
      status: "READY"
    }, {
      bindingId: "unknown",
      decisions: [decision("c0"), decision("c9")],
      status: "READY"
    }, {
      bindingId: "invalid-score",
      decisions: [decision("c0"), decision("c1", Number.NaN)],
      status: "READY"
    }, {
      bindingId: "invalid-score-only-metadata",
      decisions: [decision("c0"), {
        applicable: true,
        current: true,
        handle: "c1",
        reasonCode: "SCORE_ONLY",
        relevanceScore: 0.8
      }],
      status: "READY"
    }];

    for (const result of invalidResults) {
      const applied = applyMemoryRelevance(candidates, result);
      expect(applied.map(({ itemId }) => itemId)).toEqual(["atomic-a", "atomic-b"]);
      expect(applied.map(({ finalScore }) => finalScore)).toEqual(
        candidates.map(({ candidate }) => candidate.finalScore)
      );
      expect(applied.every(({ selectionReason }) =>
        selectionReason.endsWith("rerank_fallback_rrf"))).toBe(true);
    }
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

  it("preserves typed tool observation authority through rerank admission", () => {
    const candidate = rankedToolEvent("tool-file-create");
    const [relevance] = memoryRelevanceCandidates(
      [candidate],
      [expandedToolEvent(candidate.itemId)]
    );

    expect(relevance).toMatchObject({
      authorityLevel: "SUPPORTING",
      current: true,
      historical: false,
      occurredFrom: now.toISOString(),
      occurredTo: now.toISOString(),
      sourceKind: "TOOL_OBSERVATION",
      speakerScope: "tool"
    });
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
          memoryUseful: false,
          patternExclusionRequested: false,
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
          memoryUseful: false,
          patternExclusionRequested: false,
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
          memoryUseful: false,
          patternExclusionRequested: false,
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
          memoryUseful: false,
          patternExclusionRequested: false,
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
    expect(result).toMatchObject({
      budgetSnapshot: {
        memoryActionAnswerResult: { operation: "SAVE", status: "COMMITTED", version: 1 },
        reason: "memory_action_only"
      },
      outcome: "EMPTY"
    });
  });

  it("uses broad reader fallback on System-Model control outage without invoking an action", async () => {
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
      degradationCode: "memory_query_embedding_unavailable",
      items: [{ exactItemId: "fallback-answer-evidence" }],
      outcome: "DEGRADED",
      querySnapshot: "Remember this and also answer my question."
    });
    expect(result.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: { operation: "NONE", status: "UNAVAILABLE", version: 1 },
      plan: {
        filterSourceKinds: ["HISTORY"],
        temporalIntent: "ANY"
      },
      plannerFallbackReason: "memory_action_intent_unavailable"
    });
    expect(local.retrieve).toHaveBeenCalledOnce();
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it("uses the broad lexical plan when control and query embedding are unavailable", async () => {
    const narrowFact = {
      ...factLaneCandidate("narrow-speculative-fact", 0.9),
      lane: "FACT_FTS_SIMPLE" as const
    };
    const narrowHistory = {
      ...laneCandidate("narrow-speculative-history"),
      lane: "HISTORY_RECALL_FTS_SIMPLE" as const
    };
    const broadFact = {
      ...factLaneCandidate("broad-fallback-fact", 0.9),
      lane: "FACT_FTS_SIMPLE" as const
    };
    const broadHistory = {
      ...laneCandidate("broad-fallback-history"),
      lane: "HISTORY_RECALL_FTS_SIMPLE" as const
    };
    const local = repository({
      aggregationCandidates: [broadFact, broadHistory],
      candidates: [narrowFact, narrowHistory],
      speculativeBaseline: true
    });
    const base = retrievalOptions(["c0", "c1"]);
    let resolveControl: ((value: MemoryControlResult) => void) | undefined;
    const controlResult = new Promise<MemoryControlResult>((resolve) => {
      resolveControl = resolve;
    });
    const pending = createMemoryRunRetrievalService(local.value, {
      ...base,
      control: { decide: vi.fn(() => controlResult) },
      utilities: {
        ...base.utilities,
        embedQuery: vi.fn(async () => ({
          bindingId: "binding-embedding-unavailable",
          reason: "memory_query_embedding_unavailable",
          status: "UNAVAILABLE" as const
        }))
      }
    }).retrieve(runInput("What did I decide across my earlier chats?"));

    await vi.waitFor(() => expect(local.retrieveSpeculativeBaseline).toHaveBeenCalledOnce());
    resolveControl?.({
      reason: "memory_action_intent_unavailable",
      status: "UNAVAILABLE"
    });
    const result = await pending;

    expect(result).toMatchObject({
      budgetSnapshot: {
        broadLexicalFallbackUsed: true,
        componentMetrics: {
          broadLexicalFallbackUsed: true,
          plannerFallbackUsed: true,
          speculativeBaselineUsed: false,
          speculativeHybridUsed: false
        },
        speculativeBaselineUsed: false,
        speculativeHybridUsed: false
      },
      outcome: "USED"
    });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ exactItemId: "broad-fallback-fact" }),
      expect.objectContaining({ exactItemId: "broad-fallback-history" })
    ]));
    expect(result.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ exactItemId: "narrow-speculative-fact" }),
      expect.objectContaining({ exactItemId: "narrow-speculative-history" })
    ]));
    expect(local.retrieveSpeculativeBaseline).toHaveBeenCalledOnce();
    expect(local.retrieve).toHaveBeenCalledTimes(2);
    expect(local.retrieve).toHaveBeenLastCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ aggregationRequested: true })
    }));
    expect(local.retrieve.mock.lastCall?.[0].vector).toBeUndefined();
  });

  it("keeps a ready dense lane when System-Model control falls back", async () => {
    const lexical = {
      ...laneCandidate("current-lexical-evidence"),
      lane: "HISTORY_RECALL_FTS_SIMPLE" as const
    };
    const priorDense = {
      ...laneCandidate("prior-dense-evidence"),
      lane: "HISTORY_RECALL_VECTOR" as const
    };
    const local = repository({
      candidates: [lexical],
      hybridCandidates: [lexical, priorDense],
      speculativeBaseline: true,
      speculativeDense: true
    });
    const base = retrievalOptions(["c0", "c1"]);
    let resolveControl: ((value: MemoryControlResult) => void) | undefined;
    const controlResult = new Promise<MemoryControlResult>((resolve) => {
      resolveControl = resolve;
    });
    const pending = createMemoryRunRetrievalService(local.value, {
      ...base,
      control: {
        decide: vi.fn(() => controlResult)
      }
    }).retrieve(runInput("How did my routine change over time?"));

    await vi.waitFor(() => expect(local.retrieveSpeculativeBaseline).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(local.retrieveSpeculativeDense).toHaveBeenCalledOnce());
    resolveControl?.({
      reason: "memory_action_intent_unavailable",
      status: "UNAVAILABLE"
    });
    const result = await pending;

    expect(local.retrieveSpeculativeDense).toHaveBeenCalledOnce();
    expect(local.retrieveSpeculativeDense).toHaveBeenCalledWith(
      expect.objectContaining({ vector: expect.objectContaining({ vector: expect.any(Array) }) }),
      expect.any(AbortSignal)
    );
    expect(result).toMatchObject({
      budgetSnapshot: {
        componentMetrics: {
          broadLexicalFallbackUsed: false,
          speculativeBaselineUsed: false,
          speculativeHybridUsed: true
        },
        broadLexicalFallbackUsed: false,
        speculativeBaselineUsed: false,
        speculativeHybridUsed: true
      },
      outcome: "USED"
    });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ exactItemId: "prior-dense-evidence" })
    ]));
    expect(local.retrieve.mock.calls.every(([input]) =>
      !input.plan.aggregationRequested)).toBe(true);
  });

  it("keeps a completed primary lane healthy when only fuzzy recovery expires", async () => {
    const lexical = {
      ...laneCandidate("history-primary-evidence"),
      lane: "HISTORY_RECALL_FTS_SIMPLE" as const
    };
    const dense = {
      ...laneCandidate("history-dense-evidence"),
      lane: "HISTORY_RECALL_VECTOR" as const
    };
    const local = repository({
      candidates: [lexical],
      hybridCandidates: [dense],
      speculativeBaseline: true,
      speculativeDense: true
    });
    local.retrieveSpeculativeBaseline?.mockResolvedValueOnce({
      core: [],
      laneResults: [
        { candidates: [], lane: "FACT_FTS_SIMPLE" },
        { candidates: [lexical], lane: "HISTORY_RECALL_FTS_SIMPLE" },
        { candidates: [], lane: "FACT_TRIGRAM" }
      ],
      lexicalFailures: ["FACT_TRIGRAM"],
      lexicalState: "DEGRADED",
      snapshot: local.state,
      vectorEvidence: [],
      vectorState: "NOT_CONFIGURED"
    });
    local.retrieveSpeculativeDense?.mockResolvedValueOnce({
      core: [],
      laneResults: [
        { candidates: [], lane: "FACT_VECTOR" },
        { candidates: [dense], lane: "HISTORY_RECALL_VECTOR" }
      ],
      lexicalFailures: [],
      lexicalState: "DISABLED",
      snapshot: local.state,
      vectorEvidence: [],
      vectorState: "READY"
    });
    const base = retrievalOptions(["c0", "c1"]);

    const result = await createMemoryRunRetrievalService(local.value, {
      ...base,
      control: {
        decide: vi.fn(async () => ({
          reason: "memory_action_intent_unavailable",
          status: "UNAVAILABLE" as const
        }))
      }
    }).retrieve(runInput("How did my routine change over time?"));

    expect(result).toMatchObject({
      budgetSnapshot: {
        lexicalFailures: ["FACT_TRIGRAM"],
        lexicalState: "DEGRADED",
        speculativeHybridUsed: true
      },
      outcome: "USED"
    });
    expect(local.retrieve).not.toHaveBeenCalled();
  });

  it("retries the full hybrid read when a speculative source family is unavailable", async () => {
    const recovered = {
      ...laneCandidate("full-read-recovered-history"),
      lane: "HISTORY_RECALL_FTS_SIMPLE" as const
    };
    const local = repository({
      aggregationCandidates: [recovered],
      candidates: [],
      speculativeBaseline: true,
      speculativeDense: true
    });
    local.retrieveSpeculativeBaseline?.mockResolvedValueOnce({
      core: [],
      laneResults: [
        { candidates: [], lane: "FACT_FTS_SIMPLE" },
        { candidates: [], lane: "HISTORY_RECALL_FTS_SIMPLE" }
      ],
      lexicalFailures: ["FACT_FTS_SIMPLE", "HISTORY_RECALL_FTS_SIMPLE"],
      lexicalState: "FAILED",
      snapshot: local.state,
      vectorEvidence: [],
      vectorState: "NOT_CONFIGURED"
    });
    const base = retrievalOptions(["c0"]);
    let resolveControl: ((value: MemoryControlResult) => void) | undefined;
    const controlResult = new Promise<MemoryControlResult>((resolve) => {
      resolveControl = resolve;
    });
    const pending = createMemoryRunRetrievalService(local.value, {
      ...base,
      control: { decide: vi.fn(() => controlResult) }
    }).retrieve(runInput("How long did my move take?"));

    await vi.waitFor(() => expect(local.retrieveSpeculativeDense).toHaveBeenCalledOnce());
    resolveControl?.({
      reason: "memory_action_intent_unavailable",
      status: "UNAVAILABLE"
    });
    const result = await pending;

    expect(result).toMatchObject({
      budgetSnapshot: {
        broadLexicalFallbackUsed: false,
        componentMetrics: {
          broadLexicalFallbackUsed: false,
          speculativeBaselineUsed: false,
          speculativeHybridUsed: false
        },
        speculativeBaselineUsed: false,
        speculativeHybridUsed: false
      },
      outcome: "USED"
    });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ exactItemId: "full-read-recovered-history" })
    ]));
    expect(local.retrieve.mock.lastCall?.[0]).toMatchObject({
      plan: { aggregationRequested: true },
      vector: { vector: expect.any(Array) }
    });
  });

  it("treats invalid control output as mutation NONE plus broad local read", async () => {
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
      degradationCode: "memory_query_embedding_unavailable",
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
      query: "What did I call it?"
    }));
    expect(options.utilities.rerank).toHaveBeenCalledWith(expect.objectContaining({
      query: "What did I call it?"
    }));
    expect(result.querySnapshot).toBe("What did I call it?");
  });

  it("keeps a history opportunity when valid control prefers only facts", async () => {
    const local = repository({ candidates: [laneCandidate("history-floor-gold")] });
    const options = intentOptions({
      memoryUseful: true,
      pastChatsUseful: false,
      queryText: "current project codename",
      retrievalMode: "TARGETED_CURRENT",
      temporalIntent: "CURRENT"
    });

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("What codename did we use in that earlier chat?"));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      baselinePlan: expect.objectContaining({
        filters: expect.objectContaining({
          sourceKinds: ["FACT", "EVENT", "HISTORY"]
        })
      }),
      plan: expect.objectContaining({
        filters: expect.objectContaining({ sourceKinds: ["FACT", "EVENT"] })
      })
    }));
    expect(local.value.expand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: expect.objectContaining({
          sourceKinds: ["FACT", "EVENT", "HISTORY"]
        })
      }),
      expect.arrayContaining([expect.objectContaining({ itemId: "history-floor-gold" })])
    );
    expect(result).toMatchObject({
      items: [{ exactItemId: "history-floor-gold", itemType: "RECALL_CHUNK" }],
      outcome: "USED"
    });
  });

  it("keeps a current fact opportunity when valid control prefers only history", async () => {
    const local = repository({ candidates: [factLaneCandidate("fact-floor-gold", 1)] });
    const options = intentOptions({
      memoryUseful: false,
      pastChatsUseful: true,
      queryText: "earlier project discussion",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("What is my saved codename and where did we discuss it?"));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      baselinePlan: expect.objectContaining({
        filters: expect.objectContaining({
          sourceKinds: ["FACT", "EVENT", "HISTORY"]
        })
      }),
      plan: expect.objectContaining({
        filters: expect.objectContaining({ sourceKinds: ["HISTORY"] })
      })
    }));
    expect(local.value.expand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: expect.objectContaining({
          sourceKinds: ["FACT", "EVENT", "HISTORY"]
        })
      }),
      expect.arrayContaining([expect.objectContaining({ itemId: "fact-floor-gold" })])
    );
    expect(result).toMatchObject({
      items: [{ factVersionId: "fact-floor-gold", itemType: "FACT_VERSION" }],
      outcome: "USED"
    });
  });

  it("preserves distinct multi-part evidence boundaries in the local query bundle", async () => {
    const local = repository({ candidates: [laneCandidate("multi-part-evidence")] });
    const options = intentOptions({
      aggregationRequested: true,
      memoryUseful: false,
      pastChatsUseful: true,
      queryDecompositions: [
        "when I completed milestone Alpha",
        "when I completed milestone Omega"
      ],
      queryText: "project milestone completion events",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("How much time passed between my two project milestones?"));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        semanticQueryVariants: [
          {
            kind: "ORIGINAL",
            text: "How much time passed between my two project milestones?"
          },
          { kind: "PLANNER_REWRITE", text: "project milestone completion events" },
          { kind: "DECOMPOSED", text: "when I completed milestone Alpha" },
          { kind: "DECOMPOSED", text: "when I completed milestone Omega" }
        ]
      })
    }));
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
          version: 7
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

  it("retains a safe internal expansion failure code without candidate text", async () => {
    const local = repository({ candidates: [laneCandidate("past-chat")] });
    vi.mocked(local.value.expand).mockRejectedValue(
      new Error("memory_expansion_contract_invalid")
    );
    const result = await createMemoryRunRetrievalService(
      local.value,
      intentOptions({
        memoryUseful: false,
        pastChatsUseful: true,
        retrievalMode: "PAST_CHAT_SEARCH"
      })
    ).retrieve(runInput("What did we discuss?"));

    expect(result).toMatchObject({
      budgetSnapshot: {
        failureClass: "INTERNAL",
        failureCode: "memory_expansion_contract_invalid",
        reason: "memory_expansion_unavailable"
      },
      items: [],
      outcome: "FAILED_SAFE"
    });
  });

  it("classifies expansion database failures without retaining database text", async () => {
    const local = repository({ candidates: [laneCandidate("past-chat")] });
    vi.mocked(local.value.expand).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("private database detail", {
        clientVersion: "test",
        code: "P2010"
      })
    );
    const result = await createMemoryRunRetrievalService(
      local.value,
      intentOptions({
        memoryUseful: false,
        pastChatsUseful: true,
        retrievalMode: "PAST_CHAT_SEARCH"
      })
    ).retrieve(runInput("What did we discuss?"));

    expect(result).toMatchObject({
      budgetSnapshot: {
        failureClass: "DATABASE",
        failureCode: "memory_expansion_database_p2010",
        reason: "memory_expansion_unavailable"
      },
      outcome: "FAILED_SAFE"
    });
    expect(JSON.stringify(result.budgetSnapshot)).not.toContain("private database detail");
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

  it("uses a healthy reader-first pack without an aggregation provider call", async () => {
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
    expect(result).toMatchObject({
      budgetSnapshot: {
        aggregationPolicyVersion: "memory-reader-aggregation-policy-v15",
        aggregationProviderCalls: 0,
        aggregationReaderFallbackUsed: true,
        aggregationState: "READER_REQUIRED",
        plan: { aggregationRequested: true, mode: "PAST_CHAT_SEARCH" }
      },
      outcome: "USED"
    });
    expect(result.items).toHaveLength(5);
    expect(result.preparedContext?.text).toContain(
      "scan the entire block through its final item"
    );
    expect(result.preparedContext?.text).toContain("Count only distinct completed members");
    expect(result.preparedContext?.text).toContain(
      "places its completion inside the requested interval"
    );
    expect(result.preparedContext?.text).toContain(
      "Propagate those semantics through arithmetic"
    );
    expect(result.preparedContext?.text).not.toContain("distinct_members=");
    expect(result.budgetSnapshot.utilityExecutions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "MEMORY_AGGREGATE" })])
    );
    expect(() => validateMemoryPreparingAttemptResult(result)).not.toThrow();
  });

  it("does not consult a failing legacy aggregator or degrade reader-first evidence", async () => {
    const local = repository({ candidates: [laneCandidate("release-alpha")] });
    const legacyAggregate = vi.fn(async () => ({
      reason: "memory_run_utility_provider_failed",
      status: "UNAVAILABLE" as const
    }));
    const aggregationUtilities = { ...utilities(["c0"]), aggregate: legacyAggregate };
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

    expect(legacyAggregate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      budgetSnapshot: {
        aggregationProviderCalls: 0,
        aggregationState: "READER_REQUIRED"
      },
      items: [{ exactItemId: "release-alpha" }],
      outcome: "USED"
    });
    expect(result).not.toHaveProperty("degradationCode");
    expect(result.preparedContext?.text).toContain("release-alpha");
    expect(result.preparedContext?.text).toContain("READER-FIRST MEMORY AGGREGATION");
    expect(result.preparedContext?.text).not.toContain("distinct_members=");
  });

  it("authoritatively re-expands source-completion rounds before packing them", async () => {
    const completedRound: MemoryRankedCandidate = {
      ...rankedHistory("completed-round", "NORMAL"),
      entryId: null,
      itemType: "RECALL_ROUND",
      matchedSegmentId: null,
      matchedSegmentPosition: null,
      metadata: {
        ...rankedHistory("completed-round", "NORMAL").metadata,
        dedupeKey: `history:${"b".repeat(64)}`,
        evidenceRootHash: "b".repeat(64),
        parentChunkId: "parent-completed-round",
        sourceChatId: "chat-source"
      },
      selectionReason: "aggregation_session_completion"
    };
    const local = repository({
      candidates: [laneCandidate("query-anchor")],
      completion: {
        candidates: [completedRound],
        sourceChatCount: 1
      }
    });
    const options = intentOptions({
      aggregationRequested: true,
      memoryUseful: false,
      pastChatsUseful: true,
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    });

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("What is the total across all completed trips?"));

    expect(local.completeAggregationSessionEvidence).toHaveBeenCalledOnce();
    expect(local.expand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "PAST_CHAT_SEARCH" }),
      [expect.objectContaining({ itemId: "completed-round", itemType: "RECALL_ROUND" })]
    );
    expect(result).toMatchObject({
      budgetSnapshot: {
        componentMetrics: {
          sessionCompletionCandidateCount: 1,
          sessionCompletionExpandedSourceChatCount: 1,
          sessionCompletionState: "READY"
        }
      },
      items: expect.arrayContaining([
        expect.objectContaining({ exactItemId: "completed-round", itemType: "RECALL_ROUND" })
      ]),
      outcome: "USED"
    });
    expect(result.preparedContext?.text).toContain("relevant round text completed-round");
  });

  it("keeps admitted anchors when optional source completion exhausts its budget", async () => {
    vi.useFakeTimers();
    try {
      const local = repository({
        candidates: [laneCandidate("query-anchor")],
        completion: { candidates: [], sourceChatCount: 0 }
      });
      local.completeAggregationSessionEvidence?.mockImplementation(
        () => new Promise<MemoryAggregationSessionCompletion>(() => undefined)
      );
      const options = intentOptions({
        aggregationRequested: true,
        memoryUseful: false,
        pastChatsUseful: true,
        retrievalMode: "PAST_CHAT_SEARCH",
        temporalIntent: "ANY"
      });

      const pending = createMemoryRunRetrievalService(local.value, options)
        .retrieve(runInput("What happened across my earlier chats?"));
      await vi.waitFor(() =>
        expect(local.completeAggregationSessionEvidence).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS + 1);
      const result = await pending;

      expect(result).toMatchObject({
        budgetSnapshot: {
          componentMetrics: { sessionCompletionState: "UNAVAILABLE" }
        },
        items: [expect.objectContaining({ exactItemId: "query-anchor" })],
        outcome: "USED"
      });
      expect(result).not.toHaveProperty("degradationCode");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the broad reader plan when control violates planner semantics", async () => {
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
        aggregationState: "READER_REQUIRED",
        plan: {
          filterSourceKinds: ["HISTORY"],
          temporalIntent: "ANY"
        },
        plannerFallbackReason: "memory_plan_invalid"
      },
      items: [{ exactItemId: "past-chat" }],
      outcome: "USED",
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
        version: "memory-retrieval-component-metrics-v14"
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

  it("discards a partial relevance result and preserves the complete RRF order", async () => {
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
      expect.objectContaining({ recallChunkId: "a" }),
      expect.objectContaining({ recallChunkId: "b" })
    ]);
    expect(result.items?.every(({ selectionReason }) =>
      selectionReason.includes("rerank_fallback_rrf"))).toBe(true);
    expect(result.outcome).toBe("USED");
    expect(result.budgetSnapshot).toMatchObject({
      componentMetrics: {
        rerankFullFallbackUsed: true,
        rerankerFallbackUsed: true
      }
    });
    expect(result).not.toHaveProperty("degradationCode");
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
    "answers a broad profile from current facts and ignores speculative %s vectors",
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
      expect(options.utilities.embedQuery).toHaveBeenCalledTimes(
        indexMode === "HYBRID" ? 1 : 0
      );
      expect(options.vectorRepository.resolveActiveProfile).toHaveBeenCalledTimes(
        indexMode === "HYBRID" ? 1 : 0
      );
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
    expect(options.utilities.embedQuery).toHaveBeenCalledOnce();
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

  it("rejects only the complete rerank's near-zero junk tail", () => {
    const candidates = memoryRelevanceCandidates([
      rankedHistory("relevant", "NORMAL"),
      rankedHistory("at-floor", "NORMAL"),
      rankedHistory("junk", "NORMAL")
    ], [
      expandedHistory("relevant"),
      expandedHistory("at-floor"),
      expandedHistory("junk")
    ]);
    const ranked = applyMemoryRelevance(candidates, {
      bindingId: "binding-relevance",
      decisions: candidates.map((candidate, index) => ({
        applicable: null,
        current: null,
        handle: candidate.handle,
        reasonCode: "SCORE_ONLY" as const,
        relevanceScore: [0.91, 0.01, 0.0033][index]!
      })),
      relevanceScoreFloor: 0.01,
      status: "READY"
    });

    expect(ranked.map(({ itemId }) => itemId)).toEqual(["relevant", "at-floor"]);
  });

  it("does not invent a junk floor for a deployment without calibration", () => {
    const candidates = memoryRelevanceCandidates(
      [rankedHistory("low-score", "NORMAL")],
      [expandedHistory("low-score")]
    );

    expect(applyMemoryRelevance(candidates, {
      bindingId: "binding-no-floor",
      decisions: [{
        applicable: null,
        current: null,
        handle: "c0",
        reasonCode: "SCORE_ONLY",
        relevanceScore: 0.0033
      }],
      relevanceScoreFloor: null,
      status: "READY"
    })).toMatchObject([{ itemId: "low-score" }]);
  });

  it("keeps exact deterministic anchors below the rerank junk floor", () => {
    const base = rankedHistory("exact-low-score", "NORMAL");
    const exact = {
      ...base,
      featureSnapshot: {
        ...base.featureSnapshot,
        deterministicMatches: ["EXACT_TEXT" as const]
      }
    };
    const candidates = memoryRelevanceCandidates(
      [exact],
      [expandedHistory("exact-low-score")]
    );

    expect(applyMemoryRelevance(candidates, {
      bindingId: "binding-exact-low-score",
      decisions: [{
        applicable: null,
        current: null,
        handle: "c0",
        reasonCode: "SCORE_ONLY",
        relevanceScore: 0
      }],
      relevanceScoreFloor: 0.01,
      status: "READY"
    })).toMatchObject([{ itemId: "exact-low-score" }]);
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
      expect(result.outcome).toBe("USED");
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
      degradationCode: "memory_index_unavailable",
      items: [{
        factVersionId: "exact-current",
        selectionReason: "fact_exact+rerank_fallback_rrf"
      }],
      outcome: "DEGRADED"
    });
  });

  it("admits patterns server-side for an ordinary targeted fact read", async () => {
    const opaqueRef = `mr1.${"a".repeat(500)}`;
    const local = repository({ candidates: [factLaneCandidate("hinted-fact", 0.8)] });
    const options = {
      ...intentOptions({
        entityMentions: [{ occurrenceIndex: 0, resolvedRef: opaqueRef, text: "Acme" }],
        memoryUseful: true,
        patternExclusionRequested: false,
        pastChatsUseful: false,
        queryText: "Acme workflow"
      }),
      controlRefs: { load: vi.fn(async () => [opaqueRef]) }
    };

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("When does my usual Acme preparation begin?"));

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

  it("honors a typed pattern opt-out without parsing user wording", async () => {
    const local = repository({ candidates: [factLaneCandidate("direct-fact", 0.8)] });
    const options = intentOptions({
      memoryUseful: true,
      patternExclusionRequested: true,
      pastChatsUseful: false,
      queryText: "current routine"
    });

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("Use only what I directly stated."));

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ includePatterns: false })
    }));
    expect(result).toMatchObject({
      budgetSnapshot: { plan: { includePatterns: false } },
      items: [{ featureSnapshot: { includePatterns: false } }],
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
