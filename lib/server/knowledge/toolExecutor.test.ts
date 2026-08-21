import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { createKnowledgeFocusedRequest } from "./focusedRequest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
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
          priorContentHashes: [],
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
      arguments: { query: "Question" },
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
      candidateLimit: 40,
      operation: "automatic_search",
      query: "Question",
      resultLimit: 8,
      vectors: [
        expect.objectContaining({ bindingOrdinal: 0 }),
        expect.objectContaining({ bindingOrdinal: 1 }),
        expect.objectContaining({ bindingOrdinal: 2 }),
        expect.objectContaining({ bindingOrdinal: 3 })
      ]
    }));
    expect(persistReceipt).toHaveBeenCalledOnce();
  });
});
