import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  createKnowledgeToolExecutor,
  type KnowledgeRetrievalStore
} from "./toolExecutor";
import {
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeAcceptedBinding,
  type KnowledgeHybridSearchResult
} from "./retrievalTypes";
import {
  KNOWLEDGE_RERANK_ADAPTER_VERSION,
  knowledgeRerankerUnavailableEvidence,
  type KnowledgeRerankPin
} from "./rerankExecution";
import { KNOWLEDGE_RERANKER_EVIDENCE_VERSION } from "./rerankEvidence";
import { knowledgeLexicalBackendEvidenceFixture } from "./searchRetrieval.testFixtures";
import type { KnowledgeRerankerRoleResolution } from "./rerankerRuntime";
import {
  decodeKnowledgeRetrievalEvidence,
  knowledgeEvidenceFromToolResult
} from "./toolResult";
import type { ProviderRunRequest } from "../providers/types";

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

function request(): ProviderRunRequest {
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
    toolMode: "none"
  };
}

const pin: KnowledgeRerankPin = Object.freeze({
  adapterVersion: KNOWLEDGE_RERANK_ADAPTER_VERSION,
  candidateFormatterVersion: 1,
  connectionSnapshotId: "reranker-connection-1#v1",
  credentialSnapshotRef: "reranker-credential-version-1",
  policyVersion: 4,
  provider: "openrouter",
  providerModelId: "reranker-deployment-1",
  upstreamModelId: "qwen/qwen3-reranker-8b"
});

function rerankedSearchResult(): KnowledgeHybridSearchResult {
  return {
    bindingCount: 1,
    candidateCount: 1,
    candidateCounts: { 0: 1 },
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
      rerankScore: 0.93,
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
      text: "Reranked evidence.",
      vectorDistance: 0.1,
      vectorScore: 0.9
    }],
    rankingEvidence: {
      candidateOrder: ["chunk-1"],
      fusion: "weighted_rrf_v2" as const
    },
    rerankerBinding: {
      adapterVersion: pin.adapterVersion,
      candidateFormatterVersion: pin.candidateFormatterVersion,
      connectionSnapshotId: pin.connectionSnapshotId,
      credentialSnapshotRef: pin.credentialSnapshotRef,
      durationMs: 40,
      fallbackReason: null,
      inputCandidateCount: 2,
      orderedCandidateChunkIds: ["chunk-1", "chunk-2"],
      outputOrder: ["chunk-1", "chunk-2"],
      policyVersion: pin.policyVersion,
      provider: "openrouter",
      providerModelId: pin.providerModelId,
      providerRequestId: "req-7",
      rankingProfileVersion: 4,
      relevanceScores: [0.93, 0.2],
      status: "complete" as const,
      timedOut: false,
      upstreamModelId: pin.upstreamModelId,
      usage: { searchUnits: 1, totalTokens: 80 },
      version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
    },
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
  };
}

function embeddingRuntime() {
  return {
    resolve: vi.fn(async () => ({
      adapter: {
        embed: vi.fn(async () => ({
          model: "embedding-upstream",
          requestId: "embedding-request-1",
          usage: { inputTokens: 2, totalTokens: 2 },
          vectors: [Array.from({ length: 1_024 }, () => 0.03125)]
        }))
      },
      configuration: embeddingConfiguration,
      provider: "openai_compatible",
      providerModelId: "embedding-model-1"
    }))
  };
}

function store(hybridSearch: KnowledgeRetrievalStore["hybridSearch"]) {
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

function call(id = "call-1") {
  return {
    arguments: { query: "Question", sourceAliases: [] },
    id,
    name: KNOWLEDGE_SEARCH_TOOL_NAME
  };
}

function context(persistedToolCallId = "tool-call-1") {
  return {
    persistedToolCallId,
    request: request(),
    runId: "run-1",
    userId: "user-1"
  };
}

describe("Knowledge executor hosted rerank wiring", () => {
  it("resolves the role once, passes one rerank executor, and persists the pinned evidence", async () => {
    const hybridSearch = vi.fn<KnowledgeRetrievalStore["hybridSearch"]>(
      async () => rerankedSearchResult()
    );
    const { persistReceipt, store: retrievalStore } = store(hybridSearch);
    const resolve = vi.fn(async (): Promise<KnowledgeRerankerRoleResolution> => ({
      adapter: { rerank: vi.fn() },
      kind: "ready",
      pin
    }));
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: embeddingRuntime(),
      rerankerRuntime: { resolve },
      store: retrievalStore
    });
    const result = await runtime.execute(call(), context());
    expect(result.status).toBe("complete");
    expect(resolve).toHaveBeenCalledOnce();
    expect(hybridSearch).toHaveBeenCalledOnce();
    expect(hybridSearch.mock.calls[0]![0]).toMatchObject({
      rerank: { executor: expect.any(Function) }
    });
    const persisted = persistReceipt.mock.calls[0]![0].evidence;
    expect(persisted.rerankerBinding).toMatchObject({
      policyVersion: 4,
      providerModelId: "reranker-deployment-1",
      status: "complete",
      upstreamModelId: "qwen/qwen3-reranker-8b",
      version: 2
    });
    expect(persisted.results[0]).toMatchObject({ rerankScore: 0.93 });
    // The persisted receipt round-trips through the strict evidence decoder.
    const decoded = knowledgeEvidenceFromToolResult(result);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(decodeKnowledgeRetrievalEvidence(decoded));
  });

  it("records disabled evidence without an executor when the role is absent", async () => {
    const base = rerankedSearchResult();
    const deterministic: KnowledgeHybridSearchResult = {
      ...base,
      passages: base.passages.map((passage) => {
        const { rerankScore: _rerankScore, ...rest } = passage;
        return rest;
      })
    };
    delete (deterministic as { rerankerBinding?: unknown }).rerankerBinding;
    const hybridSearch = vi.fn<KnowledgeRetrievalStore["hybridSearch"]>(
      async () => deterministic
    );
    const { persistReceipt, store: retrievalStore } = store(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: embeddingRuntime(),
      rerankerRuntime: { resolve: vi.fn(async () => ({ kind: "absent" as const })) },
      store: retrievalStore
    });
    const result = await runtime.execute(call(), context());
    expect(result.status).toBe("complete");
    expect(hybridSearch.mock.calls[0]![0]).not.toHaveProperty("rerank");
    expect(persistReceipt.mock.calls[0]![0].evidence.rerankerBinding).toMatchObject({
      inputCandidateCount: 0,
      status: "disabled"
    });
    const decoded = knowledgeEvidenceFromToolResult(result);
    expect(decoded).not.toBeNull();
  });

  it("records degraded fallback evidence when the configured role is unavailable", async () => {
    const base = rerankedSearchResult();
    const deterministic: KnowledgeHybridSearchResult = {
      ...base,
      passages: base.passages.map((passage) => {
        const { rerankScore: _rerankScore, ...rest } = passage;
        return rest;
      })
    };
    delete (deterministic as { rerankerBinding?: unknown }).rerankerBinding;
    const hybridSearch = vi.fn<KnowledgeRetrievalStore["hybridSearch"]>(
      async () => deterministic
    );
    const { persistReceipt, store: retrievalStore } = store(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: embeddingRuntime(),
      rerankerRuntime: {
        resolve: vi.fn(async () => ({
          kind: "unavailable" as const,
          selectedProviderModelId: "reranker-deployment-1"
        }))
      },
      store: retrievalStore
    });
    const result = await runtime.execute(call(), context());
    expect(result.status).toBe("complete");
    expect(hybridSearch.mock.calls[0]![0]).not.toHaveProperty("rerank");
    expect(persistReceipt.mock.calls[0]![0].evidence.rerankerBinding).toMatchObject({
      fallbackReason: "reranker_model_unavailable",
      providerModelId: "reranker-deployment-1",
      status: "degraded"
    });
    const decoded = knowledgeEvidenceFromToolResult(result);
    expect(decoded).not.toBeNull();
  });

  it("replays an accepted receipt without repeating the provider call", async () => {
    const hybridSearch = vi.fn();
    const { store: retrievalStore } = store(hybridSearch);
    const resolve = vi.fn();
    const replay = rerankedSearchResult();
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: embeddingRuntime(),
      rerankerRuntime: { resolve },
      store: {
        ...retrievalStore,
        loadReceipt: vi.fn(async () => ({
          bases: [],
          candidateCount: replay.candidateCount,
          candidateLimit: 64,
          durationMs: 5,
          embeddingExecutions: [],
          fusion: "weighted_rrf_v2" as const,
          invocationOrdinal: 1,
          operation: "automatic_search" as const,
          outcome: "complete" as const,
          providerText: "replayed",
          query: "Question",
          resultLimit: 16,
          results: [],
          version: 2 as const
        }))
      }
    });
    const result = await runtime.execute(call(), context());
    expect(result.status).toBe("complete");
    expect(resolve).not.toHaveBeenCalled();
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("pins the policy at operation time so changes affect only future operations", async () => {
    const hybridSearch = vi.fn(
      async (input: Parameters<KnowledgeRetrievalStore["hybridSearch"]>[0]) => {
        const stage = await input.rerank!.executor({ candidates: [] });
        const base = rerankedSearchResult();
        const deterministic = {
          ...base,
          candidateCount: 0,
          candidateCounts: { 0: 0 },
          passages: [],
          rankingEvidence: { candidateOrder: [], fusion: "weighted_rrf_v2" as const },
          rerankerBinding: stage.evidence
        };
        return deterministic;
      }
    );
    const { persistReceipt, store: retrievalStore } = store(hybridSearch);
    let policyVersion = 1;
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: embeddingRuntime(),
      rerankerRuntime: {
        resolve: vi.fn(async (): Promise<KnowledgeRerankerRoleResolution> => ({
          adapter: { rerank: vi.fn() },
          kind: "ready",
          pin: { ...pin, policyVersion: policyVersion++ }
        }))
      },
      store: retrievalStore
    });
    await runtime.execute(call("call-1"), context("tool-call-1"));
    await runtime.execute(call("call-2"), context("tool-call-2"));
    expect(persistReceipt.mock.calls[0]![0].evidence.rerankerBinding)
      .toMatchObject({ policyVersion: 1 });
    expect(persistReceipt.mock.calls[1]![0].evidence.rerankerBinding)
      .toMatchObject({ policyVersion: 2 });
  });

  it("never resolves the reranker for deterministic Source-local reads", async () => {
    const hybridSearch = vi.fn();
    const { store: retrievalStore } = store(hybridSearch);
    const resolve = vi.fn();
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: embeddingRuntime(),
      rerankerRuntime: { resolve },
      store: retrievalStore
    });
    const result = await runtime.execute({
      arguments: {
        direction: "self",
        locator: "page 1",
        sourceAlias: "S1",
        window: 1
      },
      id: "call-read",
      name: "read_source"
    }, context());
    expect(result.status).toBe("error");
    expect(resolve).not.toHaveBeenCalled();
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("keeps the full-context answering path free of any reranker dependency", () => {
    const source = readFileSync(join(__dirname, "fullContext.ts"), "utf8");
    expect(source).not.toMatch(/rerank/iu);
  });

  it("rejects mismatched rerank evidence in the strict receipt decoder", async () => {
    const hybridSearch = vi.fn<KnowledgeRetrievalStore["hybridSearch"]>(
      async () => rerankedSearchResult()
    );
    const { store: retrievalStore } = store(hybridSearch);
    const runtime = createKnowledgeToolExecutor({
      embeddingRuntime: embeddingRuntime(),
      rerankerRuntime: {
        resolve: vi.fn(async (): Promise<KnowledgeRerankerRoleResolution> => ({
          adapter: { rerank: vi.fn() },
          kind: "ready",
          pin
        }))
      },
      store: retrievalStore
    });
    const decoded = knowledgeEvidenceFromToolResult(
      await runtime.execute(call(), context())
    )!;
    expect(decoded).not.toBeNull();
    // Legacy planner-era V1 shapes never enter a current V2 receipt.
    expect(decodeKnowledgeRetrievalEvidence({
      ...decoded,
      rerankerBinding: {
        egress: "none",
        kind: "deterministic_token_vector_heuristic",
        languages: ["en", "ru"],
        profile: "deterministic-token-vector-heuristic-v1",
        status: "complete",
        version: 1
      }
    })).toBeNull();
    // Scored results require a scoring V2 binding.
    const { rerankerBinding: _binding, ...withoutBinding } = decoded;
    expect(decodeKnowledgeRetrievalEvidence(withoutBinding)).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...decoded,
      rerankerBinding: knowledgeRerankerUnavailableEvidence({
        selectedProviderModelId: null
      })
    })).toBeNull();
  });
});
