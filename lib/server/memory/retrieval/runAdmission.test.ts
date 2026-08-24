import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import type {
  MemoryCandidateMetadata,
  MemoryCoreCandidate,
  MemoryExpandedCandidate,
  MemoryLaneCandidate,
  MemoryRankedCandidate,
  MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import {
  MEMORY_DECAY_POLICY_VERSION,
  planMemoryRetrieval
} from "../../../domain/memory/retrieval";
import type { NormalizedRunRequest } from "../../providers/types";
import { MEMORY_ACTION_NO_COMMIT_RESULT } from "../../providers/memoryActionAnswer";
import type { MemoryPreparingSettingsSnapshot } from "../../runs/preparingRun";
import type { PrismaLocalMemoryRetrievalRepository } from "./localRepository";
import type { MemoryControlService } from "../actions/controlRuntime";
import {
  applyMemoryRelevance,
  createMemoryRunRetrievalService,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS,
  memoryRelevanceCandidates,
  type MemoryRunControlCache,
  type MemoryRunRetrievalExpectedSnapshot
} from "./runAdmission";
import type { MemoryRunUtilityService } from "./runUtilities";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT, type MemoryVectorProfile } from "./vector";

const now = new Date("2026-08-13T10:00:00.000Z");
const currentControlContract = Object.freeze({
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
    laneResults: candidates.length ? [{ candidates, lane: "HISTORY_RECALL_VECTOR" as const }] : [],
    lexicalFailures: [], lexicalState: activeIndexGenerationId ? "READY" as const : "DISABLED" as const,
    snapshot: state, vectorEvidence: [],
    vectorState: activeIndexGenerationId ? "READY" as const : "NOT_CONFIGURED" as const
  }));
  const coreByKey = new Map((options.core ?? []).map((entry) => [
    `${entry.candidate.itemType}:${entry.candidate.itemId}`,
    entry.expansion
  ]));
  const value = {
    expand: vi.fn(async (
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
            sourceChatId: "chat-source",
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
    })),
    retrieve,
    snapshot: vi.fn(async () => state)
  } as unknown as PrismaLocalMemoryRetrievalRepository;
  return { retrieve, value };
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
          applyResponsePreferences: true,
          category: null,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
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
          applyResponsePreferences: false,
          category: null,
          categoryHint: null,
          confidenceBand: "HIGH" as const,
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
  it("fails safe at the single hard deadline when control is still pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({});
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

      await vi.advanceTimersByTimeAsync(24);
      expect(receivedSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(receivedSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "memory_admission_deadline_exceeded"
        },
        items: [],
        outcome: "FAILED_SAFE",
        preparedContext: null
      });
      expect(base.utilities.embedQuery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same deadline signal and fails safe while query embedding is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const local = repository({});
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

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(controlSignals[0]).toBe(embeddingSignals[0]);
      expect(embeddingSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          reason: "memory_admission_deadline_exceeded",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        },
        items: [],
        outcome: "FAILED_SAFE"
      });
      expect(local.retrieve).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same deadline signal and fails safe while reranking is pending", async () => {
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

      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(controlSignals[0]).toBe(embeddingSignals[0]);
      expect(embeddingSignals[0]).toBe(rerankSignals[0]);
      expect(rerankSignals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({
        budgetSnapshot: {
          reason: "memory_admission_deadline_exceeded",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        },
        items: [],
        outcome: "FAILED_SAFE"
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

  it("uses the exact outer administrator-selected deadline", async () => {
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

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toMatchObject({
        budgetSnapshot: { reason: "memory_admission_deadline_exceeded" },
        outcome: "FAILED_SAFE"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds semantic reranking to 20 facts, 10 history chunks, and 30 stable handles", () => {
    const facts = Array.from({ length: 21 }, (_, index) => core(`fact-${index}`));
    const history = Array.from({ length: 11 }, (_, index) =>
      rankedHistory(`history-${index}`, "NORMAL"));
    const candidates = memoryRelevanceCandidates(
      [...facts.map(({ candidate }) => candidate), ...history],
      [...facts.map(({ expansion }) => expansion),
        ...history.map(({ itemId }) => expandedHistory(itemId))]
    );

    expect(candidates).toHaveLength(30);
    expect(candidates.filter(({ candidate }) =>
      candidate.itemType === "FACT_VERSION")).toHaveLength(20);
    expect(candidates.filter(({ candidate }) =>
      candidate.itemType === "RECALL_CHUNK")).toHaveLength(10);
    expect(candidates.map(({ handle }) => handle)).toEqual(
      Array.from({ length: 30 }, (_, index) => `c${index}`)
    );
    expect(candidates.some(({ candidate }) => candidate.itemId === "fact-20")).toBe(false);
    expect(candidates.some(({ candidate }) => candidate.itemId === "history-10")).toBe(false);
  });

  it("deduplicates only byte-identical history projections before bounded reranking", () => {
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
      "fact", "history-best", "history-distinct"
    ]);
    expect(candidates.map(({ handle }) => handle)).toEqual(["c0", "c1", "c2"]);
    expect(candidates.filter(({ sourceKind }) => sourceKind === "HISTORY")).toHaveLength(2);
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

  it("orders accepted historical fact states chronologically after reranking", () => {
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
      "ordered-macbook",
      "current-macbook"
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
    const local = repository({});
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
    expect(result).toMatchObject({ outcome: "FAILED_SAFE" });
    expect(result.budgetSnapshot).toMatchObject({
      memoryActionAnswerResult: { operation: "NONE", status: "UNAVAILABLE", version: 1 }
    });
    expect(actionExecutor.execute).not.toHaveBeenCalled();
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
          version: 4
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

  it("consumes the bounded reranker retry budget once for the whole answer", async () => {
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
    expect(retry).toMatchObject({
      budgetSnapshot: { reason: "memory_control_retry_not_reused" },
      outcome: "FAILED_SAFE"
    });
    expect(options.utilities.rerank).toHaveBeenCalledOnce();
    expect(retry.budgetSnapshot).toMatchObject({
      utilityEgressMode: "LOCAL_ONLY"
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

  it("admits the past-chat lane independently when fact retrieval is vetoed", async () => {
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

  it("fails safe instead of throwing when a control decision violates planner semantics", async () => {
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
      budgetSnapshot: { reason: "memory_plan_invalid" },
      items: [],
      outcome: "FAILED_SAFE",
      querySnapshot: null
    });
    expect(local.retrieve).not.toHaveBeenCalled();
    expect(options.utilities.embedQuery).not.toHaveBeenCalled();
    expect(options.utilities.rerank).not.toHaveBeenCalled();
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
      plan: { applyResponsePreferences: true, filterSourceKinds: [] }
    });
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

  it("carries trusted recency intent but excludes a recent irrelevant candidate", async () => {
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
    expect(result.items).toEqual([]);
    expect(result.budgetSnapshot).toMatchObject({
      plan: { recencyRequested: true }
    });
  });

  it("packs only the relevance model's ordered subset", async () => {
    const local = repository({ candidates: [laneCandidate("a"), laneCandidate("b")] });
    const result = await createMemoryRunRetrievalService(local.value, {
      ...retrievalOptions(["c1"])
    }).retrieve(runInput("cross language query"));
    expect(result.items).toEqual([expect.objectContaining({ recallChunkId: "b" })]);
    expect(result.items?.[0]?.selectionReason).toContain("direct_relevance");
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

  it("fails a broad profile safe when no usable local index is available", async () => {
    const local = repository({ activeIndexGenerationId: null });
    const options = intentOptions({
      memoryUseful: true,
      pastChatsUseful: false,
      profileRequested: true,
      retrievalMode: "CURRENT_PROFILE"
    });

    const result = await createMemoryRunRetrievalService(local.value, options)
      .retrieve(runInput("Что ты обо мне знаешь?", null));

    expect(result).toMatchObject({
      budgetSnapshot: { reason: "memory_index_unavailable" },
      items: [],
      outcome: "FAILED_SAFE",
      preparedContext: null
    });
    expect(local.retrieve).not.toHaveBeenCalled();
    expect(options.utilities.embedQuery).not.toHaveBeenCalled();
    expect(options.utilities.rerank).not.toHaveBeenCalled();
  });

  it("fails a broad profile safe when the local index becomes unavailable", async () => {
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

    expect(result).toMatchObject({
      budgetSnapshot: { reason: "memory_index_unavailable" },
      items: [],
      outcome: "FAILED_SAFE",
      preparedContext: null
    });
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

  it("requires relevance strictly above the configured floor", () => {
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
    expect(decide(0.6)).toEqual([]);
    expect(decide(0.600_001)).toHaveLength(1);
  });

  it("returns zero items on abstention and fails closed on relevance failure", async () => {
    for (const decision of [[], null] as const) {
      const local = repository({ candidates: [laneCandidate("a")], core: [core()] });
      const result = await createMemoryRunRetrievalService(
        local.value,
        retrievalOptions(decision)
      ).retrieve(runInput("unrelated question"));
      expect(result.items).toEqual([]);
      if (decision === null) expect(result).toMatchObject({
        outcome: "FAILED_SAFE"
      });
      else expect(result.outcome).toBe("EMPTY");
    }
  });

  it("blocks recognizable-secret input before local or provider retrieval", async () => {
    const local = repository({ core: [core()] });
    const result = await createMemoryRunRetrievalService(local.value, retrievalOptions(null))
      .retrieve(runInput("sk-abcdefghijklmnopqrstuvwxyz123456"));
    expect(local.retrieve).not.toHaveBeenCalled();
    expect(result.querySnapshot).toBeNull();
    expect(result.queryHash).toMatch(/^[a-f0-9]{64}$/u);
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
      expect.objectContaining({ factVersionId: "saved-name" })
    ]);
    expect(result.items?.some((item) =>
      item.itemType === "FACT_VERSION" && item.factVersionId === "arbitrary-fact"))
      .toBe(false);
  });
});
