import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import type {
  MemoryLaneCandidate,
  MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import type { NormalizedRunRequest } from "../../providers/types";
import type { MemoryPreparingSettingsSnapshot } from "../../runs/preparingRun";
import type { PrismaLocalMemoryRetrievalRepository } from "./localRepository";
import {
  createMemoryRunRetrievalService,
  type MemoryRunRetrievalExpectedSnapshot
} from "./runAdmission";
import type { MemoryRunUtilityService } from "./runUtilities";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  type MemoryVectorProfile
} from "./vector";

const now = new Date("2026-08-10T12:00:00.000Z");

const settings: MemoryPreparingSettingsSnapshot = Object.freeze({
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: "generation-1",
  learnAutomatically: false,
  memoryConsentRevision: 0,
  referenceChatHistory: true,
  schemaVersion: 1,
  settingsRevision: 3,
  useMemoryFacts: true
});

const expected: MemoryRunRetrievalExpectedSnapshot = Object.freeze({
  activeIndexGenerationId: "generation-1",
  assistantId: null,
  chatMemoryMode: "NORMAL",
  folderId: null,
  memoryGeneration: 2,
  memoryRevision: 4,
  settings
});

function request(
  text: string,
  options: Readonly<{ externalTools?: boolean }> = {}
): NormalizedRunRequest {
  const content = textMessageContent(text);
  return {
    attachmentIds: [],
    chatId: "chat-current",
    content,
    context: {
      messages: [{ content, id: "current", role: "user" }],
      mode: "branch_path"
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: options.externalTools === true,
      vision: false
    },
    modelId: "model-1",
    params: {},
    prompt: { developer: null, system: null },
    provider: "provider-1",
    searchStrategy: options.externalTools ? "external-search" : null,
    ...(options.externalTools ? { toolMode: "auto" as const } : {})
  };
}

function snapshot(indexMode: "HYBRID" | "LEXICAL_ONLY" = "LEXICAL_ONLY") {
  return {
    activeGenerationId: "generation-1",
    assistantId: null,
    chatId: "chat-current",
    chatMemoryMode: "NORMAL" as const,
    folderId: null,
    historySuppressionIdentitySnapshot: "a".repeat(64),
    indexMode,
    memoryGeneration: 2,
    memoryRevision: 4,
    reason: "ready",
    referenceChatHistory: true,
    repositoryVersion: "test-repository-v1",
    settingsRevision: 3,
    status: "READY" as const,
    useMemoryFacts: true,
    userId: "user-1"
  };
}

function chunkCandidate(
  index: number,
  lane: "HISTORY_RECALL_FTS_ENGLISH" | "HISTORY_RECALL_VECTOR" =
    "HISTORY_RECALL_FTS_ENGLISH"
): MemoryLaneCandidate {
  const occurredFrom = new Date(`2026-08-0${index}T10:00:00.000Z`);
  const occurredTo = new Date(`2026-08-0${index}T11:00:00.000Z`);
  return {
    entryId: `entry-${index}`,
    hardFilterPassed: true,
    itemId: `chunk-${index}`,
    itemType: "RECALL_CHUNK",
    lane,
    metadata: {
      canonicalKey: null,
      category: null,
      confidence: 0.9,
      conflict: false,
      current: false,
      dedupeKey: `chunk:${index}`,
      directness: null,
      factId: null,
      historical: true,
      historySafetyClass: "NORMAL",
      importance: 0.7,
      languageCode: "en",
      modality: null,
      occurredFrom,
      occurredTo,
      pinned: false,
      scopeAffinity: 0.7,
      scopeType: null,
      sensitivityClass: null,
      sourceAssistantId: null,
      sourceChatId: `chat-source-${index}`,
      sourceFolderId: null,
      sourceMode: null,
      systemFrom: null,
      temperatureClass: null,
      validFrom: null,
      validTo: null
    },
    rawScore: 1 - index / 100
  };
}

function repository(
  candidates: readonly MemoryLaneCandidate[],
  indexMode: "HYBRID" | "LEXICAL_ONLY" = "LEXICAL_ONLY",
  options: Readonly<{
    lexicalState?: "DEGRADED" | "DISABLED" | "FAILED" | "READY";
    vectorState?: "DEGRADED" | "DISABLED" | "NOT_CONFIGURED" | "READY";
  }> = {}
) {
  const state = snapshot(indexMode);
  const retrieve = vi.fn(async (input: { plan: MemoryRetrievalPlan; vector?: unknown }) => ({
    laneResults: candidates.length > 0
      ? [{ candidates, lane: candidates[0]!.lane }]
      : [],
    lexicalFailures: options.lexicalState === "FAILED"
      ? ["HISTORY_RECALL_FTS_ENGLISH" as const]
      : [],
    lexicalState: options.lexicalState ?? "READY" as const,
    snapshot: state,
    vectorEvidence: [],
    vectorState: options.vectorState ??
      (input.vector ? "READY" as const : "NOT_CONFIGURED" as const)
  }));
  const value = {
    expand: vi.fn(async () => candidates.map((candidate, index) => ({
      itemId: candidate.itemId,
      itemType: "RECALL_CHUNK" as const,
      occurredFrom: candidate.metadata.occurredFrom,
      occurredTo: candidate.metadata.occurredTo,
      projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT" as const,
      safeText: `Prior conversation evidence number ${index + 1}.`,
      sourceChatId: candidate.metadata.sourceChatId,
      supportingItemId: null
    }))),
    retrieve,
    snapshot: vi.fn(async () => state)
  } as unknown as PrismaLocalMemoryRetrievalRepository;
  return { retrieve, value };
}

function input(normalizedRequest: NormalizedRunRequest) {
  return {
    attemptId: "attempt-1",
    chatId: "chat-current",
    expected,
    normalizedRequest,
    now,
    userId: "user-1"
  };
}

const vectorProfile: MemoryVectorProfile = Object.freeze({
  configurationFingerprint: "b".repeat(64),
  connectionId: "connection-1",
  dimension: 1_024,
  generationId: "generation-1",
  providerModelId: "embedding-model-1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  vectorSpaceFingerprint: "c".repeat(64)
});

describe("Memory run retrieval admission", () => {
  it("packs a locally retrieved history chunk without utility egress", async () => {
    const local = repository([chunkCandidate(1)]);
    const service = createMemoryRunRetrievalService(local.value);
    const result = await service.retrieve(input(request(
      "What did we discuss in the previous chat?"
    )));
    expect(result).toMatchObject({
      items: [{ itemType: "RECALL_CHUNK", recallChunkId: "chunk-1" }],
      outcome: "USED",
      querySnapshot: expect.any(String)
    });
    expect(result.preparedContext?.text).toContain("Prior conversation evidence number 1.");
    expect(result.budgetSnapshot).toMatchObject({
      utilityEgressMode: "LOCAL_ONLY",
      vectorState: "NOT_CONFIGURED"
    });
  });

  it("degrades a HYBRID index to FTS when query embedding is unavailable", async () => {
    const local = repository([chunkCandidate(1)], "HYBRID");
    const utilities = {
      embedQuery: vi.fn(async () => ({
        reason: "memory_execution_qualification_required",
        status: "UNAVAILABLE" as const
      })),
      expandQuery: vi.fn(),
      rerank: vi.fn()
    } as unknown as MemoryRunUtilityService;
    const service = createMemoryRunRetrievalService(local.value, {
      utilities,
      vectorRepository: { resolveActiveProfile: vi.fn(async () => ({
        profile: vectorProfile,
        status: "READY" as const
      })) }
    });
    const result = await service.retrieve(input(request(
      "What did we discuss in the previous chat?"
    )));
    expect(result).toMatchObject({
      degradationCode: "memory_query_embedding_unavailable",
      outcome: "DEGRADED"
    });
    expect(local.retrieve.mock.calls[0]?.[0]).not.toHaveProperty("vector");
    expect(result.budgetSnapshot).toMatchObject({ utilityEgressMode: "LOCAL_ONLY" });
  });

  it("records vector-only, vector-failure, empty, and total-failure outcomes", async () => {
    const utilities = {
      embedQuery: vi.fn(async () => ({
        bindingId: "binding-embed",
        profile: vectorProfile,
        status: "READY" as const,
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      })),
      expandQuery: vi.fn(),
      rerank: vi.fn()
    } as unknown as MemoryRunUtilityService;
    const vectorRepository = { resolveActiveProfile: vi.fn(async () => ({
      profile: vectorProfile,
      status: "READY" as const
    })) };

    const vectorOnly = await createMemoryRunRetrievalService(
      repository(
        [chunkCandidate(1, "HISTORY_RECALL_VECTOR")],
        "HYBRID",
        { lexicalState: "FAILED", vectorState: "READY" }
      ).value,
      { utilities, vectorRepository }
    ).retrieve(input(request("What did we discuss in the previous chat?")));
    expect(vectorOnly).toMatchObject({
      degradationCode: "memory_fts_unavailable",
      outcome: "DEGRADED"
    });

    const vectorFailed = await createMemoryRunRetrievalService(
      repository(
        [chunkCandidate(2)],
        "HYBRID",
        { vectorState: "DEGRADED" }
      ).value,
      { utilities, vectorRepository }
    ).retrieve(input(request("What did we discuss in the previous chat?")));
    expect(vectorFailed).toMatchObject({
      degradationCode: "memory_vector_unavailable",
      outcome: "DEGRADED"
    });

    const empty = await createMemoryRunRetrievalService(
      repository([], "LEXICAL_ONLY").value
    ).retrieve(input(request("What did we discuss in the previous chat?")));
    expect(empty).toMatchObject({ outcome: "EMPTY", preparedContext: null });

    const failed = await createMemoryRunRetrievalService(
      repository([], "LEXICAL_ONLY", { lexicalState: "FAILED" }).value
    ).retrieve(input(request("What did we discuss in the previous chat?")));
    expect(failed).toMatchObject({
      budgetSnapshot: { reason: "memory_local_retrieval_unavailable" },
      outcome: "FAILED_SAFE",
      preparedContext: null
    });
  });

  it("falls back to deterministic fused order when the admitted reranker fails", async () => {
    const candidates = [1, 2, 3, 4, 5].map((index) => chunkCandidate(index));
    const local = repository(candidates);
    const utilities = {
      embedQuery: vi.fn(),
      expandQuery: vi.fn(),
      rerank: vi.fn(async () => ({
        bindingId: "binding-rerank",
        reason: "memory_reranker_unavailable",
        status: "UNAVAILABLE" as const
      }))
    } as unknown as MemoryRunUtilityService;
    const result = await createMemoryRunRetrievalService(local.value, {
      enableRemoteRerank: true,
      utilities
    }).retrieve(input(request(
      "What did we discuss in the previous chat about migrations?"
    )));

    expect(result).toMatchObject({
      degradationCode: "memory_reranker_unavailable",
      outcome: "DEGRADED"
    });
    expect(utilities.rerank).toHaveBeenCalledOnce();
    expect(result.items?.[0]).toMatchObject({
      recallChunkId: "chunk-1",
      selectionReason: "history_recall_fts_english"
    });
  });

  it("uses bound expansion, query embedding, and permutation-only reranking evidence", async () => {
    const candidates = [1, 2, 3, 4, 5].map((index) => chunkCandidate(index));
    const local = repository(candidates, "HYBRID");
    const utilities: MemoryRunUtilityService = {
      embedQuery: vi.fn(async () => ({
        bindingId: "binding-embed",
        profile: vectorProfile,
        status: "READY" as const,
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      })),
      expandQuery: vi.fn(async () => ({
        bindingId: "binding-expand",
        status: "READY" as const,
        terms: ["postgres migration"]
      })),
      rerank: vi.fn(async (rerankInput) => ({
        bindingId: "binding-rerank",
        orderedHandles: [...rerankInput.candidates].reverse().map(({ handle }) => handle),
        status: "READY" as const
      }))
    };
    const service = createMemoryRunRetrievalService(local.value, {
      enableQueryExpansion: true,
      enableRemoteRerank: true,
      utilities,
      vectorRepository: { resolveActiveProfile: vi.fn(async () => ({
        profile: vectorProfile,
        status: "READY" as const
      })) }
    });
    const result = await service.retrieve(input(request(
      "What did we discuss in the previous chat about migrations?"
    )));
    expect(utilities.expandQuery).toHaveBeenCalledOnce();
    expect(utilities.embedQuery).toHaveBeenCalledOnce();
    expect(utilities.rerank).toHaveBeenCalledOnce();
    expect(local.retrieve.mock.calls[0]?.[0]).toHaveProperty("vector");
    expect(result.items?.[0]).toMatchObject({
      recallChunkId: "chunk-5",
      selectionReason: expect.stringContaining("remote_rerank")
    });
    expect(result.budgetSnapshot).toMatchObject({
      utilityEgressMode: "CONSENTED_EXTERNAL",
      utilityExecutions: [
        { role: "MEMORY_QUERY_EXPAND", state: "READY" },
        { role: "MEMORY_QUERY_EMBED", state: "READY" },
        { role: "MEMORY_RERANK", state: "READY" }
      ]
    });
  });

  it("blocks external-tool and secret-bearing requests before retrieval or utility calls", async () => {
    const local = repository([chunkCandidate(1)]);
    const utilities = {
      embedQuery: vi.fn(),
      expandQuery: vi.fn(),
      rerank: vi.fn()
    } as unknown as MemoryRunUtilityService;
    const service = createMemoryRunRetrievalService(local.value, { utilities });
    const external = await service.retrieve(input(request(
      "What did we discuss before?",
      { externalTools: true }
    )));
    const secret = await service.retrieve(input(request(
      "My API key is sk-abcdefghijklmnopqrstuvwxyz123456, what did we discuss?"
    )));
    expect(external).toMatchObject({ outcome: "DISABLED" });
    expect(secret).toMatchObject({ outcome: "FAILED_SAFE", queryHash: expect.any(String) });
    expect(local.retrieve).not.toHaveBeenCalled();
    expect(utilities.embedQuery).not.toHaveBeenCalled();
  });

  it("never carries a secret-bearing prior user turn into an anaphoric query", async () => {
    const local = repository([chunkCandidate(1)]);
    const utilities = {
      embedQuery: vi.fn(),
      expandQuery: vi.fn(async () => ({
        bindingId: "binding-expand",
        status: "READY" as const,
        terms: []
      })),
      rerank: vi.fn()
    } as unknown as MemoryRunUtilityService;
    const normalized = request("That — what did we discuss?");
    normalized.context = {
      messages: [{
        content: textMessageContent(
          "My API key is sk-abcdefghijklmnopqrstuvwxyz123456 and this is the migration topic."
        ),
        id: "prior-secret",
        role: "user"
      }, {
        content: normalized.content,
        id: "current",
        role: "user"
      }],
      mode: "branch_path"
    };
    const result = await createMemoryRunRetrievalService(local.value, {
      enableQueryExpansion: true,
      utilities
    }).retrieve(input(normalized));

    expect(result).toMatchObject({ outcome: "USED" });
    expect(result.querySnapshot).toBe("that — what did we discuss?");
    expect(utilities.expandQuery).toHaveBeenCalledWith(expect.objectContaining({
      query: "that — what did we discuss?"
    }));
  });
});
