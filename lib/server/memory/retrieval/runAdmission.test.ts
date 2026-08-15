import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import type {
  MemoryCandidateMetadata,
  MemoryCoreCandidate,
  MemoryLaneCandidate,
  MemoryRankedCandidate,
  MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import type { NormalizedRunRequest } from "../../providers/types";
import type { MemoryPreparingSettingsSnapshot } from "../../runs/preparingRun";
import type { PrismaLocalMemoryRetrievalRepository } from "./localRepository";
import { createMemoryRunRetrievalService, type MemoryRunRetrievalExpectedSnapshot } from "./runAdmission";
import type { MemoryRunUtilityService } from "./runUtilities";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT, type MemoryVectorProfile } from "./vector";

const now = new Date("2026-08-13T10:00:00.000Z");

function settings(activeIndexGenerationId: string | null): MemoryPreparingSettingsSnapshot {
  return {
    acceptedUtilityEgressFingerprint: null,
    acceptedUtilityPolicyVersion: null,
    activeIndexGenerationId,
    learnAutomatically: true,
    memoryConsentRevision: 0,
    referenceChatHistory: true,
    schemaVersion: 1,
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
    knowledgePlan: { baseIds: [] },
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
    factId: history ? null : id, historical: false,
    historySafetyClass: history ? "NORMAL" : null, importance: 0, languageCode: "und",
    modality: history ? null : "PREFERENCE", occurredFrom: history ? now : null,
    occurredTo: history ? new Date(now.getTime() + 60_000) : null,
    pinned: false, scopeAffinity: 0,
    scopeType: history ? null : "GLOBAL_USER", sensitivityClass: history ? null : "NORMAL",
    sourceAssistantId: null, sourceChatId: history ? "chat-source" : null,
    sourceFolderId: null, sourceMode: history ? null : "AUTOMATIC", systemFrom: now,
    temperatureClass: null, validFrom: null, validTo: null
  };
}

function laneCandidate(id: string): MemoryLaneCandidate {
  return {
    entryId: `entry-${id}`, hardFilterPassed: true, itemId: id,
    itemType: "RECALL_CHUNK", lane: "HISTORY_RECALL_VECTOR",
    metadata: metadata(id, true), rawScore: 0.2
  };
}

function core(id = "core-version"): MemoryCoreCandidate {
  const candidate: MemoryRankedCandidate = {
    entryId: null,
    featureSnapshot: { fusionVersion: "rrf", laneCount: 0, tier: "CORE" },
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

function snapshot(activeIndexGenerationId: string | null) {
  return {
    activeGenerationId: activeIndexGenerationId, assistantId: null, chatId: "chat-current",
    chatMemoryMode: "NORMAL" as const, folderId: null,
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
}> = {}) {
  const activeIndexGenerationId = options.activeIndexGenerationId === undefined
    ? "generation-1" : options.activeIndexGenerationId;
  const state = snapshot(activeIndexGenerationId);
  const candidates = options.candidates ?? [];
  const retrieve = vi.fn(async (_input: { plan: MemoryRetrievalPlan; vector?: unknown }) => ({
    core: options.core ?? [],
    laneResults: candidates.length ? [{ candidates, lane: "HISTORY_RECALL_VECTOR" as const }] : [],
    lexicalFailures: [], lexicalState: activeIndexGenerationId ? "READY" as const : "DISABLED" as const,
    snapshot: state, vectorEvidence: [],
    vectorState: activeIndexGenerationId ? "READY" as const : "NOT_CONFIGURED" as const
  }));
  const value = {
    expand: vi.fn(async () => candidates.map((candidate) => ({
      itemId: candidate.itemId, itemType: "RECALL_CHUNK" as const,
      occurredFrom: now, occurredTo: new Date(now.getTime() + 60_000),
      projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT" as const,
      safeText: `relevant text ${candidate.itemId}`, sourceChatId: "chat-source",
      supportingItemId: null
    }))),
    retrieve,
    snapshot: vi.fn(async () => state)
  } as unknown as PrismaLocalMemoryRetrievalRepository;
  return { retrieve, value };
}

function runInput(text: string, activeIndexGenerationId: string | null = "generation-1") {
  return { attemptId: "attempt-1", chatId: "chat-current",
    expected: expected(activeIndexGenerationId), normalizedRequest: request(text), now, userId: "user-1" };
}

function utilities(relevantHandles: readonly string[] | null): MemoryRunUtilityService {
  return {
    embedQuery: vi.fn(async () => ({ reason: "embedding_unavailable", status: "UNAVAILABLE" as const })),
    expandQuery: vi.fn(),
    rerank: vi.fn(async () => relevantHandles === null
      ? { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" as const }
      : { bindingId: "binding-relevance", relevantHandles, status: "READY" as const })
  } as MemoryRunUtilityService;
}

describe("three-tier Memory run admission", () => {
  it("injects Core without a query, index, or provider call", async () => {
    const local = repository({ activeIndexGenerationId: null, core: [core()] });
    const result = await createMemoryRunRetrievalService(local.value)
      .retrieve(runInput(" ", null));
    expect(result).toMatchObject({
      items: [{ factVersionId: "core-version", selectionReason: "core.high" }],
      outcome: "DEGRADED",
      querySnapshot: null
    });
    expect(result.preparedContext?.text).toContain("User prefers concise answers");
  });

  it.each(["какие ответы я преподчитаю", "ما اسمي", "我的名字", "मेरा नाम", "🧠::x"])(
    "sends every non-empty Unicode query to candidate generation: %s",
    async (text) => {
      const local = repository({ core: [core()] });
      await createMemoryRunRetrievalService(local.value, { utilities: utilities([]) })
        .retrieve(runInput(text));
      expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
        plan: expect.objectContaining({ queryPresent: true })
      }));
    }
  );

  it("packs only the relevance model's ordered subset", async () => {
    const local = repository({ candidates: [laneCandidate("a"), laneCandidate("b")] });
    const result = await createMemoryRunRetrievalService(local.value, {
      utilities: utilities(["c1"])
    }).retrieve(runInput("cross language query"));
    expect(result.items).toEqual([expect.objectContaining({ recallChunkId: "b" })]);
    expect(result.items?.[0]?.selectionReason).toContain("semantic_relevance");
  });

  it("keeps dynamic injection empty on abstention or relevance failure while Core survives", async () => {
    for (const decision of [[], null] as const) {
      const local = repository({ candidates: [laneCandidate("a")], core: [core()] });
      const result = await createMemoryRunRetrievalService(local.value, {
        utilities: utilities(decision)
      }).retrieve(runInput("unrelated question"));
      expect(result.items).toHaveLength(1);
      expect(result.items?.[0]).toMatchObject({ factVersionId: "core-version" });
      if (decision === null) expect(result).toMatchObject({
        degradationCode: "memory_relevance_unavailable", outcome: "DEGRADED"
      });
    }
  });

  it("runs local candidate generation for recognizable-secret input but withholds the query", async () => {
    const local = repository({ core: [core()] });
    const result = await createMemoryRunRetrievalService(local.value, { utilities: utilities(null) })
      .retrieve(runInput("sk-abcdefghijklmnopqrstuvwxyz123456"));
    expect(local.retrieve).toHaveBeenCalledOnce();
    expect(result.querySnapshot).toBeNull();
    expect(result.queryHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("passes the complete cosine range floor to vector retrieval", async () => {
    const profile: MemoryVectorProfile = {
      configurationFingerprint: "b".repeat(64), connectionId: "connection-1",
      dimension: 1_024, generationId: "generation-1", providerModelId: "embedding-1",
      retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
      vectorSpaceFingerprint: "c".repeat(64)
    };
    const local = repository({ core: [core()] });
    const serviceUtilities: MemoryRunUtilityService = {
      ...utilities([]),
      embedQuery: vi.fn(async () => ({ bindingId: "embedding", profile,
        status: "READY" as const,
        vector: Array.from({ length: 1_024 }, (_, i) => i === 0 ? 1 : 0) }))
    };
    await createMemoryRunRetrievalService(local.value, {
      utilities: serviceUtilities,
      vectorRepository: { resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const })) }
    }).retrieve(runInput("query"));
    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      vector: expect.objectContaining({ minimumScore: -1 })
    }));
  });
});
