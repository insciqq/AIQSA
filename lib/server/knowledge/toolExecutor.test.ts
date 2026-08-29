import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { EmbeddingAdapterError } from "../providers/embeddings";
import type { ProviderRunRequest } from "../providers/types";
import { createKnowledgeFocusedRequest } from "./focusedRequest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import { knowledgeLexicalBackendEvidenceFixture } from "./searchRetrieval.testFixtures";
import { decodeKnowledgeRetrievalEvidence } from "./toolResult";
import { createKnowledgeToolExecutor, type KnowledgeRetrievalStore } from "./toolExecutor";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeAcceptedBinding
} from "./retrievalTypes";

const embeddingConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    contextWindow: 32_768,
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 1_024,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_024
  },
  modelClass: "embedding",
  upstreamModelId: "embedding-upstream"
} as const;

const embeddingPin = createKnowledgeVectorSpacePin({
  configuration: embeddingConfiguration,
  deploymentId: "embedding-model-1"
})!;

const acceptedBinding = {
  baseContentRevision: 1,
  baseName: "Base",
  embeddingConnectionId: "embedding-connection-1",
  embeddingCredentialId: "embedding-credential-1",
  embeddingCredentialSource: "default",
  embeddingCredentialVersionId: "embedding-credential-version-1",
  embeddingExecutionSnapshot: {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://embedding.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    },
    connectionDisplayName: "Embedding",
    connectionId: "embedding-connection-1",
    credentialId: "embedding-credential-1",
    credentialVersionId: "embedding-credential-version-1",
    model: embeddingConfiguration,
    modelDisplayName: "Embedding model",
    providerFamily: "openai_compatible",
    providerModelId: "embedding-model-1",
    version: 1
  },
  embeddingProviderModelId: "embedding-model-1",
  includeWholeBase: true,
  indexedContentRevision: 1,
  indexGenerationId: "generation-1",
  knowledgeBaseId: "base-1",
  knowledgeBaseSnapshotId: "snapshot-1",
  ordinal: 0,
  selectedSourceIds: [],
  targetDimension: 1_024,
  vectorSpaceFingerprint: embeddingPin.fingerprint
} satisfies KnowledgeAcceptedBinding;

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Question", type: "text" }] },
    knowledgePlan: { baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1 },
    modelCapabilities: {
      contextWindow: 32_000,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: false,
      vision: false
    },
    modelId: "model",
    params: {},
    prompt: { developer: null, system: null },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "none",
    ...overrides
  };
}

function executor() {
  const store = {
    hybridSearch: vi.fn(),
    invocationOrdinal: vi.fn(),
    loadBindings: vi.fn(),
    persistReceipt: vi.fn()
  } satisfies KnowledgeRetrievalStore;
  return {
    runtime: createKnowledgeToolExecutor({
      embeddingRuntime: { resolve: vi.fn() },
      store
    }),
    store
  };
}

function automaticStore(hybridSearch: KnowledgeRetrievalStore["hybridSearch"]) {
  const persistReceipt = vi.fn(async (
    input: Parameters<KnowledgeRetrievalStore["persistReceipt"]>[0]
  ) => input.evidence);
  return {
    persistReceipt,
    store: {
      hybridSearch,
      invocationOrdinal: vi.fn(async () => 1),
      loadBindings: vi.fn(async () => [acceptedBinding]),
      loadScopeAliases: vi.fn(async () => [{
        alias: "B1",
        bindingOrdinal: 0,
        kind: "base" as const,
        label: "Base"
      }, {
        alias: "S1",
        bindingOrdinal: 0,
        kind: "source" as const,
        label: "Source",
        sourceArtifactId: "artifact-1",
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }]),
      persistReceipt
    } satisfies KnowledgeRetrievalStore
  };
}

function lexicalSearchResult() {
  return {
    bindingCount: 1,
    candidateCount: 1,
    candidateCounts: { 0: 1 },
    canonicalSourceProvenance: [],
    lexicalBackendEvidence: knowledgeLexicalBackendEvidenceFixture(),
    passages: [{
      annRank: null,
      baseName: "Base",
      bindingOrdinal: 0,
      chunkId: "chunk-lexical",
      chunkIndex: 0,
      contentHash: "b".repeat(64),
      documentId: "source-1",
      documentVersionId: "source-version-1",
      documentVersionNumber: 1,
      expandedContext: "Next complete row in the same table:\nRelated row.",
      fileName: "source.txt",
      ftsRank: 1,
      ftsScore: 1,
      fusedScore: 1,
      headingPath: ["Section"],
      knowledgeBaseId: "base-1",
      layoutKind: "body" as const,
      page: 1,
      sectionId: "section-1",
      signalProvenance: [{
        exactKind: null,
        lane: "passage_bm25" as const,
        rank: 1,
        rawScore: 1,
        vectorDistance: null,
        vectorMode: null
      }],
      sourceArtifactId: "artifact-1",
      sourceName: "Source",
      text: "Lexical evidence.",
      vectorDistance: null,
      vectorScore: null
    }],
    rankingEvidence: {
      candidateOrder: ["chunk-lexical"],
      fusion: "weighted_rrf_v2" as const
    },
    vectorSearchEvidence: [{
      bindingOrdinal: 0,
      candidateCount: 0,
      eligibleRows: 1,
      mode: "unavailable" as const,
      scan: {
        efSearch: null,
        iterativeScan: null,
        maxScanTuples: null,
        retrievalBucket: 0
      },
      targetDimension: 1_024 as const
    }]
  };
}

describe("Knowledge executor surface", () => {
  it("advertises and accepts only search_knowledge for answer models", () => {
    const { runtime } = executor();
    expect(runtime.tools).toEqual([expect.objectContaining({ name: KNOWLEDGE_SEARCH_TOOL_NAME })]);
    expect(runtime.accepts(KNOWLEDGE_SEARCH_TOOL_NAME)).toBe(true);
    for (const name of [
      KNOWLEDGE_FOCUSED_OPERATION_NAME,
      KNOWLEDGE_EXACT_TOOL_NAME,
      KNOWLEDGE_READ_SOURCE_TOOL_NAME,
      KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
      "retrieve_knowledge",
      "structured_analysis",
      "visual_analysis"]) expect(runtime.accepts(name)).toBe(false);
  });

  it("rejects retired operations without touching retrieval storage", async () => {
    const { runtime, store } = executor();
    const result = await runtime.execute({ id: "call-1", name: "search_knowledge", arguments: {} }, {
      request: request()
    });
    expect(result.status).toBe("error");
    expect(store.hybridSearch).not.toHaveBeenCalled();
  });

  it("requires durable run identity for the server-owned focused checkpoint", async () => {
    const { runtime, store } = executor();
    const focused = createKnowledgeFocusedRequest({ currentUserMessage: "Question" })!;
    const result = await runtime.execute({
      arguments: focused,
      id: "call-1",
      name: KNOWLEDGE_FOCUSED_OPERATION_NAME
    }, { request: request() });
    expect(result.status).toBe("error");
    expect(store.hybridSearch).not.toHaveBeenCalled();
  });

  it("reserves a broad large-corpus search by immutable Base snapshot", async () => {
    const reserve = vi.fn(async () => ({ kind: "conflict", reason: "invalid_payload" } as const));
    const knowledgeBaseId = "11111111-1111-4111-8111-111111111111";
    const profileRevisionId = "22222222-2222-4222-8222-222222222222";
    const knowledgeBaseSnapshotId = `kbs_${"a".repeat(40)}`;
    const runtime = createKnowledgeToolExecutor({
      budgetReservations: { reserve } as never,
      embeddingRuntime: { resolve: vi.fn() },
      store: {
        budgetState: vi.fn(async () => ({
          evidenceCount: 0,
          invocationOrdinal: 1,
          policy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
          priorContentHashes: [],
          priorSourceAliases: [],
          stopReason: null,
          usage: {
            cumulativeCandidates: 0,
            estimatedCostMicros: 0,
            latencyMs: 0,
            operations: 0,
            queryEmbeddingCalls: 0,
            retrievedTokens: 0
          }
        })),
        hybridSearch: vi.fn(),
        invocationOrdinal: vi.fn(),
        loadBindings: vi.fn(async () => [{
          ...acceptedBinding,
          executionScope: "base" as const,
          knowledgeBaseId,
          knowledgeBaseSnapshotId,
          profileRevisionId
        }]),
        loadScopeAliases: vi.fn(async () => [{
          alias: "B1",
          bindingOrdinal: 0,
          bindingOrdinals: [0],
          kind: "base" as const,
          label: "Large corpus"
        }]),
        persistReceipt: vi.fn()
      }
    });

    await runtime.preflight!({
      arguments: { query: "Question", sourceAliases: [] },
      id: "call-large",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-large",
      request: request(),
      runId: "run-large",
      userId: "user-1"
    });

    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      operationRequest: expect.objectContaining({
        profileRevisionId,
        scope: {
          bindings: [{ bindingOrdinal: 0, knowledgeBaseId, knowledgeBaseSnapshotId }],
          kind: "base_snapshots"
        },
        sourceAliases: []
      })
    }));
  });

  it("fans one query embedding across four ready profiles and reports excluded sources", async () => {
    const embed = vi.fn(async () => ({
      model: "embedding-upstream",
      requestId: "embedding-request-1",
      usage: { inputTokens: 2, totalTokens: 2 },
      vectors: [Array.from({ length: 1_024 }, () => 0.03125)]
    }));
    const resolve = vi.fn(async () => ({
      adapter: { embed },
      configuration: embeddingConfiguration,
      provider: "openai_compatible",
      providerModelId: "embedding-model-1"
    }));
    const hybridSearch = vi.fn(async () => ({
      bindingCount: 4,
      candidateCount: 1,
      candidateCounts: { 0: 1, 1: 0, 2: 0, 3: 0 },
      canonicalSourceProvenance: [],
      lexicalBackendEvidence: knowledgeLexicalBackendEvidenceFixture(),
      passages: [{
        annRank: 1,
        baseName: "Base",
        bindingOrdinal: 0,
        chunkId: "chunk-1",
        chunkIndex: 0,
        contentHash: "b".repeat(64),
        documentId: "source-1",
        documentVersionId: "source-version-1",
        documentVersionNumber: 1,
        fileName: "source.txt",
        ftsRank: 1,
        ftsScore: 0.5,
        fusedScore: 1,
        headingPath: ["Section"],
        knowledgeBaseId: "base-1",
        layoutKind: "body" as const,
        page: 1,
        sectionId: "section-1",
        sourceArtifactId: "artifact-1",
        sourceName: "Source",
        text: "Focused evidence.",
        vectorDistance: 0.1,
        vectorScore: 0.9
      }],
      rankingEvidence: {
        candidateOrder: ["chunk-1"],
        fusion: "weighted_rrf_v2" as const
      },
      vectorSearchEvidence: []
    }));
    const persistReceipt = vi.fn(async (
      input: Parameters<KnowledgeRetrievalStore["persistReceipt"]>[0]
    ) => input.evidence);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: { resolve },
      store: {
        budgetState: vi.fn(async () => ({
          evidenceCount: 0,
          excludedResources: 1,
          invocationOrdinal: 1,
          policy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
          priorContentHashes: ["c".repeat(64)],
          priorSourceAliases: [],
          stopReason: null,
          usage: {
            cumulativeCandidates: 0,
            estimatedCostMicros: 0,
            latencyMs: 0,
            operations: 0,
            queryEmbeddingCalls: 0,
            retrievedTokens: 0
          }
        })),
        hybridSearch,
        invocationOrdinal: vi.fn(async () => 1),
        loadBindings: vi.fn(async () => Array.from({ length: 4 }, (_, ordinal) => ({
          ...acceptedBinding,
          baseName: `Base ${ordinal + 1}`,
          indexGenerationId: `generation-${ordinal + 1}`,
          knowledgeBaseId: `base-${ordinal + 1}`,
          knowledgeBaseSnapshotId: `snapshot-${ordinal + 1}`,
          ordinal,
          profileRevisionId: `profile-revision-${ordinal + 1}`
        }))),
        loadScopeAliases: vi.fn(async () => Array.from({ length: 4 }, (_, ordinal) => ({
          alias: `S${ordinal + 1}`,
          bindingOrdinal: ordinal,
          kind: "source" as const,
          label: `Source ${ordinal + 1}`,
          sourceArtifactId: `artifact-${ordinal + 1}`,
          sourceId: `source-${ordinal + 1}`,
          sourceVersionId: `source-version-${ordinal + 1}`
        }))),
        persistReceipt
      }
    });
    const result = await runtime.execute({
      arguments: { query: "Question", sourceAliases: [] },
      id: "call-1",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-1",
      request: request(),
      runId: "run-1",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("partial_sources_ready")
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith({ mode: "query", texts: ["Question"] });
    expect(hybridSearch).toHaveBeenCalledOnce();
    expect(hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      candidateLimit: 64,
      excludedContentHashes: ["c".repeat(64)],
      operation: "automatic_search",
      query: "Question",
      resultLimit: 16,
      vectors: [
        expect.objectContaining({ bindingOrdinal: 0 }),
        expect.objectContaining({ bindingOrdinal: 1 }),
        expect.objectContaining({ bindingOrdinal: 2 }),
        expect.objectContaining({ bindingOrdinal: 3 })
      ]
    }));
    expect(persistReceipt).toHaveBeenCalledOnce();
  });

  it("persists monotonic durations while the host wall clock moves backward", async () => {
    const monotonicTicks = [100.25, 105.5, 112.9, 130.1];
    const monotonicNow = vi.fn(() => {
      const tick = monotonicTicks.shift();
      if (tick === undefined) throw new Error("unexpected_monotonic_clock_read");
      return tick;
    });
    let wallNow = 20_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    try {
      const embed = vi.fn(async () => {
        const wallStartedAt = Date.now();
        wallNow = 10_000;
        await Promise.resolve();
        expect(Date.now()).toBeLessThan(wallStartedAt);
        return {
          model: "embedding-upstream",
          requestId: "embedding-request-clock-step",
          usage: { inputTokens: 1, totalTokens: 1 },
          vectors: [Array.from({ length: 1_024 }, () => 0.03125)]
        };
      });
      const hybridSearch = vi.fn(async () => ({
        ...lexicalSearchResult(),
        vectorSearchEvidence: [{
          bindingOrdinal: 0,
          candidateCount: 0,
          eligibleRows: 1,
          mode: "exact" as const,
          scan: {
            efSearch: null,
            iterativeScan: null,
            maxScanTuples: null,
            retrievalBucket: 0
          },
          targetDimension: 1_024 as const
        }]
      }));
      const { persistReceipt, store } = automaticStore(hybridSearch);
      const runtime = createKnowledgeToolExecutor({
        embeddingRuntime: {
          resolve: vi.fn(async () => ({
            adapter: { embed },
            configuration: embeddingConfiguration,
            provider: "openai_compatible",
            providerModelId: "embedding-model-1"
          }))
        },
        monotonicNow,
        store
      });

      const result = await runtime.execute({
        arguments: { query: "Question", sourceAliases: [] },
        id: "call-clock-step",
        name: KNOWLEDGE_SEARCH_TOOL_NAME
      }, {
        persistedToolCallId: "tool-call-clock-step",
        request: request(),
        runId: "run-clock-step",
        userId: "user-1"
      });

      expect(result.status).toBe("complete");
      expect(monotonicNow).toHaveBeenCalledTimes(4);
      const evidence = persistReceipt.mock.calls[0]![0].evidence;
      expect(evidence.durationMs).toBe(29);
      expect(evidence.embeddingExecutions).toEqual([
        expect.objectContaining({ durationMs: 7, status: "complete" })
      ]);
      expect(decodeKnowledgeRetrievalEvidence(evidence)).not.toBeNull();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("fuses the exact current question with the model query on the first search", async () => {
    const currentQuestion =
      "What changed for SAFE-2718 on 2026-08-20 in the Release Schedule?";
    const modelQuery = "policy event details";
    const embed = vi.fn(async () => ({
      model: "embedding-upstream",
      requestId: "embedding-request-anchor",
      usage: { inputTokens: 2, totalTokens: 2 },
      vectors: [
        Array.from({ length: 1_024 }, () => 0.03125),
        Array.from({ length: 1_024 }, () => 0.0625)
      ]
    }));
    const hybridSearch = vi.fn(async () => lexicalSearchResult());
    const { store } = automaticStore(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({
          adapter: { embed },
          configuration: embeddingConfiguration,
          provider: "openai_compatible",
          providerModelId: "embedding-model-1"
        }))
      },
      store
    });

    const result = await runtime.execute({
      arguments: { query: modelQuery, sourceAliases: [] },
      id: "call-anchor",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-anchor",
      request: request({
        content: { blocks: [{ text: currentQuestion, type: "text" }] }
      }),
      runId: "run-anchor",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(embed).toHaveBeenCalledWith({
      mode: "query",
      texts: [currentQuestion, modelQuery]
    });
    expect(hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      anchorQuery: currentQuestion,
      query: modelQuery,
      vectors: [
        expect.objectContaining({ bindingOrdinal: 0, vector: expect.any(Array) }),
        expect.objectContaining({ bindingOrdinal: 0, vector: expect.any(Array) })
      ]
    }));
  });

  it("keeps the current-question anchor inside disclosed follow-up Source scope", async () => {
    const hybridSearch = vi.fn(async (input) => {
      expect(input).toMatchObject({
        bindingOrdinals: [0],
        sourceIds: ["source-1"]
      });
      return lexicalSearchResult();
    });
    const base = automaticStore(hybridSearch).store;
    const budgetState = vi.fn(async () => ({
      evidenceCount: 8,
      excludedResources: 0,
      invocationOrdinal: 2,
      policy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      priorContentHashes: ["a".repeat(64)],
      priorSourceAliases: ["S1"],
      stopReason: null,
      usage: {
        cumulativeCandidates: 8,
        estimatedCostMicros: 0,
        latencyMs: 10,
        operations: 1,
        queryEmbeddingCalls: 1,
        retrievedTokens: 64
      }
    }));
    const embed = vi.fn(async (input) => ({
      model: "embedding-upstream",
      requestId: "embedding-request-scoped",
      usage: { inputTokens: 1, totalTokens: 1 },
      vectors: input.texts.map(() =>
        Array.from({ length: 1_024 }, () => 0.03125))
    }));
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({
          adapter: { embed },
          configuration: embeddingConfiguration,
          provider: "openai_compatible",
          providerModelId: "embedding-model-1"
        }))
      },
      store: { ...base, budgetState }
    });

    const admitted = await runtime.execute({
      arguments: { query: "Missing row label", sourceAliases: ["S1"] },
      id: "call-source-follow-up",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-source-follow-up",
      request: request(),
      runId: "run-source-follow-up",
      userId: "user-1"
    });
    expect(admitted.status).toBe("complete");
    expect(hybridSearch).toHaveBeenCalledOnce();
    expect(hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      anchorQuery: "Question",
      excludedContentHashes: ["a".repeat(64)],
      resultLimit: 8
    }));
    expect(embed).toHaveBeenCalledWith({
      mode: "query",
      texts: ["Question", "Missing row label"]
    });

    budgetState.mockResolvedValueOnce({
      ...(await budgetState.mock.results[0]!.value),
      evidenceCount: 0,
      invocationOrdinal: 1,
      priorContentHashes: [],
      priorSourceAliases: [],
      usage: {
        cumulativeCandidates: 0,
        estimatedCostMicros: 0,
        latencyMs: 0,
        operations: 0,
        queryEmbeddingCalls: 0,
        retrievedTokens: 0
      }
    });
    const guessed = await runtime.execute({
      arguments: { query: "Guessed Source", sourceAliases: ["S1"] },
      id: "call-source-guessed",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-source-guessed",
      request: request(),
      runId: "run-source-follow-up",
      userId: "user-1"
    });
    expect(guessed.status).toBe("error");
    expect(hybridSearch).toHaveBeenCalledOnce();
  });

  it("materializes a Source alias for selected evidence before provider packaging", async () => {
    const hybridSearch = vi.fn(async () => ({
      ...lexicalSearchResult(),
      canonicalSourceProvenance: [{
        artifactId: "artifact-1",
        bindings: [{
          baseName: "Base",
          bindingOrdinal: 0,
          knowledgeBaseId: "base-1"
        }],
        primaryBindingOrdinal: 0,
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }]
    }));
    const materializeScopeAliases = vi.fn(async () => undefined);
    const loadScopeAliases = vi.fn()
      .mockResolvedValueOnce([{
        alias: "B1",
        bindingOrdinal: 0,
        kind: "base" as const,
        label: "Base"
      }])
      .mockResolvedValueOnce([{
        alias: "B1",
        bindingOrdinal: 0,
        kind: "base" as const,
        label: "Base"
      }, {
        alias: "S1",
        bindingOrdinal: 0,
        bindingOrdinals: [0],
        kind: "source" as const,
        label: "Source",
        sourceArtifactId: "artifact-1",
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }]);
    const persistReceipt = vi.fn(async (
      input: Parameters<KnowledgeRetrievalStore["persistReceipt"]>[0]
    ) => input.evidence);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({
          adapter: {
            embed: vi.fn(async () => ({
              model: "embedding-upstream",
              requestId: "embedding-request-alias",
              usage: { inputTokens: 1, totalTokens: 1 },
              vectors: [Array.from({ length: 1_024 }, () => 0.03125)]
            }))
          },
          configuration: embeddingConfiguration,
          provider: "openai_compatible",
          providerModelId: "embedding-model-1"
        }))
      },
      store: {
        hybridSearch,
        invocationOrdinal: vi.fn(async () => 1),
        loadBindings: vi.fn(async () => [acceptedBinding]),
        loadScopeAliases,
        materializeScopeAliases,
        persistReceipt
      }
    });

    const result = await runtime.execute({
      arguments: { query: "Question", sourceAliases: [] },
      id: "call-lazy-alias",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-lazy-alias",
      request: request(),
      runId: "run-lazy-alias",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(materializeScopeAliases).toHaveBeenCalledWith(expect.objectContaining({
      sourceProvenance: [expect.objectContaining({ sourceId: "source-1" })]
    }));
    expect(persistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        results: [expect.objectContaining({ sourceAlias: "S1" })]
      })
    }));
  });

  it.each([
    ["timeout", () => new EmbeddingAdapterError("embedding_request_timed_out")],
    ["connection failure", () => new EmbeddingAdapterError("embedding_provider_request_failed")],
    ["HTTP 429", () => new EmbeddingAdapterError("embedding_provider_http_error", {
      httpStatus: 429
    })],
    ["provider HTTP 5xx", () => new EmbeddingAdapterError("embedding_provider_http_error", {
      httpStatus: 503
    })],
    ["unavailable model configuration", () => new ProviderAdmissionError("model_not_available")],
    ["unavailable credential configuration", () =>
      new ProviderAdmissionError("credential_active_version_missing")]
  ])("continues exact and lexical retrieval after a classified query-embedding %s", async (
    _label,
    embeddingError
  ) => {
    const embed = vi.fn(async () => {
      throw embeddingError();
    });
    const hybridSearch = vi.fn(async (input) => {
      expect(input.vectors).toEqual([]);
      return lexicalSearchResult();
    });
    const { persistReceipt, store } = automaticStore(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({
          adapter: { embed },
          configuration: embeddingConfiguration,
          provider: "openai_compatible",
          providerModelId: "embedding-model-1"
        }))
      },
      store
    });

    const result = await runtime.execute({
      arguments: { query: "SAFE-2718", sourceAliases: [] },
      id: "call-degraded",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-degraded",
      request: request(),
      runId: "run-degraded",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(hybridSearch).toHaveBeenCalledOnce();
    expect(persistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        embeddingExecutions: [expect.objectContaining({ status: "error" })],
        failureCode: "semantic_retrieval_unavailable",
        outcome: "complete",
        results: [expect.objectContaining({
          expandedContext: "Next complete row in the same table:\nRelated row."
        })]
      })
    }));
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Related row.")
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("semantic_retrieval_unavailable")
    });
  });

  it("does not degrade an unclassified embedding request or response defect", async () => {
    const hybridSearch = vi.fn(async () => lexicalSearchResult());
    const { store } = automaticStore(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({
          adapter: {
            embed: vi.fn(async () => {
              throw new EmbeddingAdapterError("embedding_provider_http_error", {
                httpStatus: 400
              });
            })
          },
          configuration: embeddingConfiguration,
          provider: "openai_compatible",
          providerModelId: "embedding-model-1"
        }))
      },
      store
    });

    await expect(runtime.execute({
      arguments: { query: "Question", sourceAliases: [] },
      id: "call-unclassified-embedding-failure",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-unclassified-embedding-failure",
      request: request(),
      runId: "run-unclassified-embedding-failure",
      userId: "user-1"
    })).rejects.toThrow("embedding_provider_http_error");
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("returns no_relevant_evidence when every candidate is below the retrieval floors", async () => {
    const hybridSearch = vi.fn(async () => ({
      bindingCount: 1,
      candidateCount: 0,
      candidateCounts: { 0: 0 },
      canonicalSourceProvenance: [],
      lexicalBackendEvidence: knowledgeLexicalBackendEvidenceFixture({ candidateCount: 0 }),
      passages: [],
      rankingEvidence: { candidateOrder: [], fusion: "weighted_rrf_v2" as const },
      vectorSearchEvidence: [{
        bindingOrdinal: 0,
        candidateCount: 1,
        eligibleRows: 1,
        mode: "ann" as const,
        scan: {
          efSearch: 400,
          iterativeScan: "strict_order" as const,
          maxScanTuples: 100_000,
          retrievalBucket: 0
        },
        targetDimension: 1_024 as const
      }]
    }));
    const { persistReceipt, store } = automaticStore(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({
          adapter: {
            embed: vi.fn(async (input) => ({
              model: "embedding-upstream",
              requestId: "embedding-request-empty",
              usage: { inputTokens: 1, totalTokens: 1 },
              vectors: input.texts.map(() =>
                Array.from({ length: 1_024 }, () => 0.03125))
            }))
          },
          configuration: embeddingConfiguration,
          provider: "openai_compatible",
          providerModelId: "embedding-model-1"
        }))
      },
      store
    });

    const result = await runtime.execute({
      arguments: { query: "Unrelated question", sourceAliases: [] },
      id: "call-empty",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-empty",
      request: request(),
      runId: "run-empty",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(persistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        candidateCount: 0,
        outcome: "no_relevant_evidence",
        results: []
      })
    }));
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(/no relevant knowledge evidence.*do not.*invent/is)
    });
  });

  it("does not mask a PostgreSQL failure after entering lexical degraded mode", async () => {
    const hybridSearch = vi.fn(async () => {
      throw new Error("database_query_failed");
    });
    const { store } = automaticStore(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: vi.fn(async () => ({
          adapter: {
            embed: vi.fn(async () => {
              throw new EmbeddingAdapterError("embedding_provider_http_error", {
                httpStatus: 503
              });
            })
          },
          configuration: embeddingConfiguration,
          provider: "openai_compatible",
          providerModelId: "embedding-model-1"
        }))
      },
      store
    });

    await expect(runtime.execute({
      arguments: { query: "Question", sourceAliases: [] },
      id: "call-database-failure",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-database-failure",
      request: request(),
      runId: "run-database-failure",
      userId: "user-1"
    })).rejects.toThrow("database_query_failed");
  });
});
