import { describe, expect, it, vi } from "vitest";
import { EmbeddingAdapterError } from "../providers/embeddings";
import type { ProviderRunRequest } from "../providers/types";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import { renderKnowledgeParentExpansionUnits } from "./parentContextExpansion";
import { knowledgeLexicalBackendEvidenceFixture } from "./searchRetrieval.testFixtures";
import { createKnowledgeToolExecutor, type KnowledgeRetrievalStore } from "./toolExecutor";
import {
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeAcceptedBinding,
  type KnowledgeHybridPassage,
  type KnowledgeParentExpansion,
  type KnowledgeParentExpansionUnit
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
      }, {
        alias: "S2",
        bindingOrdinal: 0,
        kind: "source" as const,
        label: "Second source",
        sourceArtifactId: "artifact-2",
        sourceId: "source-2",
        sourceVersionId: "source-version-2"
      }]),
      persistReceipt
    } satisfies KnowledgeRetrievalStore
  };
}

function runtimeFor(store: KnowledgeRetrievalStore) {
  return createKnowledgeToolExecutor({
    embeddingRuntime: {
      resolve: vi.fn(async () => ({
        adapter: {
          embed: vi.fn(async () => {
            throw new EmbeddingAdapterError("embedding_request_timed_out", {});
          })
        },
        configuration: embeddingConfiguration,
        provider: "openai_compatible",
        providerModelId: "embedding-model-1"
      }))
    },
    store
  });
}

function unit(input: Readonly<{
  chunkId: string;
  chunkIndex: number;
  position: "next" | "previous";
  rank: number;
  text: string;
}>): KnowledgeParentExpansionUnit {
  return {
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex,
    contentHash: input.chunkId.slice(-1).repeat(64),
    label: input.position === "previous"
      ? "Previous same-Source context"
      : "Next same-Source context",
    origin: "section",
    position: input.position,
    rank: input.rank,
    text: input.text,
    tokens: Math.max(1, Math.ceil(input.text.length / 4))
  };
}

function passage(input: Readonly<{
  chunkId: string;
  expansion?: KnowledgeParentExpansion;
  ordinal: number;
  sourceOrdinal?: number;
  text: string;
}>): KnowledgeHybridPassage {
  const source = input.sourceOrdinal ?? 1;
  return {
    annRank: null,
    baseName: "Base",
    bindingOrdinal: 0,
    chunkId: input.chunkId,
    chunkIndex: input.ordinal,
    contentHash: input.chunkId.slice(-1).repeat(64),
    documentId: `source-${source}`,
    documentVersionId: `source-version-${source}`,
    documentVersionNumber: 1,
    ...(input.expansion && input.expansion.units.length > 0
      ? { expandedContext: renderKnowledgeParentExpansionUnits(input.expansion.units) }
      : {}),
    ...(input.expansion ? { expansion: input.expansion } : {}),
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
    sourceArtifactId: `artifact-${source}`,
    sourceName: "Source",
    text: input.text,
    vectorDistance: null,
    vectorScore: null
  };
}

function searchResult(passages: readonly KnowledgeHybridPassage[]) {
  return {
    bindingCount: 1,
    candidateCount: passages.length,
    candidateCounts: { 0: passages.length },
    canonicalSourceProvenance: [],
    lexicalBackendEvidence: knowledgeLexicalBackendEvidenceFixture({
      candidateCount: passages.length
    }),
    passages,
    rankingEvidence: {
      candidateOrder: passages.map((entry) => entry.chunkId),
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

async function executeSearch(store: KnowledgeRetrievalStore) {
  return runtimeFor(store).execute({
    arguments: { query: "Question", sourceAliases: [] },
    id: "call-1",
    name: KNOWLEDGE_SEARCH_TOOL_NAME
  }, {
    persistedToolCallId: "tool-call-1",
    request: request(),
    runId: "run-1",
    userId: "user-1"
  });
}

describe("executor delivery of child-to-parent expansion", () => {
  it("ships expansion clearly separated from the primary excerpt and rides the receipt", async () => {
    const expansion: KnowledgeParentExpansion = {
      state: "expanded",
      units: [
        unit({ chunkId: "chunk-9", chunkIndex: 9, position: "previous", rank: 0, text: "Before." }),
        unit({ chunkId: "chunk-11", chunkIndex: 11, position: "next", rank: 1, text: "After." })
      ]
    };
    const hybridSearch = vi.fn(async () => searchResult([
      passage({ chunkId: "chunk-10", expansion, ordinal: 10, text: "Atomic answer text." })
    ]));
    const { persistReceipt, store } = automaticStore(hybridSearch);

    const result = await executeSearch(store);

    expect(result.status).toBe("complete");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Evidence:\nAtomic answer text.");
    expect(text).toContain(
      "Related same-Source context (each labeled segment is independent evidence):\n" +
      "Previous same-Source context:\nBefore.\n\nNext same-Source context:\nAfter."
    );
    expect(persistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        results: [expect.objectContaining({
          documentVersionId: "source-version-1",
          documentVersionNumber: 1,
          expandedContext: [
            "Previous same-Source context:\nBefore.",
            "Next same-Source context:\nAfter."
          ].join("\n\n"),
          // Tokens cover the exact rendered expansion, including the two
          // provider-visible labels and their separators.
          expansion: { passageCount: 2, state: "expanded", tokens: 16 },
          handle: "K1",
          includedText: "Atomic answer text."
        })]
      })
    }));
  });

  it("shrinks expansions fairly across sources before dropping any of them", async () => {
    const first: KnowledgeParentExpansion = {
      state: "expanded",
      units: [
        unit({
          chunkId: "chunk-9",
          chunkIndex: 9,
          position: "previous",
          rank: 0,
          text: "a".repeat(15_000)
        }),
        unit({
          chunkId: "chunk-11",
          chunkIndex: 11,
          position: "next",
          rank: 1,
          text: "b".repeat(15_000)
        })
      ]
    };
    const second: KnowledgeParentExpansion = {
      state: "expanded",
      units: [unit({
        chunkId: "chunk-21",
        chunkIndex: 21,
        position: "previous",
        rank: 0,
        text: "c".repeat(15_000)
      })]
    };
    const hybridSearch = vi.fn(async () => searchResult([
      passage({ chunkId: "chunk-10", expansion: first, ordinal: 10, text: "First atomic." }),
      passage({
        chunkId: "chunk-20",
        expansion: second,
        ordinal: 20,
        sourceOrdinal: 2,
        text: "Second atomic."
      })
    ]));
    const { persistReceipt, store } = automaticStore(hybridSearch);

    const result = await executeSearch(store);

    expect(result.status).toBe("complete");
    const evidence = persistReceipt.mock.calls[0]![0].evidence;
    const [firstResult, secondResult] = evidence.results;
    // Each primary keeps one expansion slot before any primary keeps two:
    // the second source is not starved by the first primary's second unit.
    expect(firstResult!.expansion).toMatchObject({ passageCount: 1, state: "expanded" });
    expect(firstResult!.expandedContext).toContain("a".repeat(15_000));
    expect(firstResult!.expandedContext).not.toContain("b".repeat(15_000));
    expect(secondResult!.expansion).toMatchObject({ passageCount: 1, state: "expanded" });
    expect(secondResult!.expandedContext).toContain("c".repeat(15_000));
    // Atomic hits are never dropped in favor of expansion.
    expect(firstResult!.includedText).toBe("First atomic.");
    expect(secondResult!.includedText).toBe("Second atomic.");
  });

  it("drops the least relevant expansion entirely only after shrinking, keeping atomic evidence", async () => {
    const first: KnowledgeParentExpansion = {
      state: "expanded",
      units: [unit({
        chunkId: "chunk-9",
        chunkIndex: 9,
        position: "previous",
        rank: 0,
        text: "a".repeat(20_000)
      })]
    };
    const second: KnowledgeParentExpansion = {
      state: "expanded",
      units: [unit({
        chunkId: "chunk-21",
        chunkIndex: 21,
        position: "previous",
        rank: 0,
        text: "c".repeat(20_000)
      })]
    };
    const hybridSearch = vi.fn(async () => searchResult([
      passage({ chunkId: "chunk-10", expansion: first, ordinal: 10, text: "First atomic." }),
      passage({
        chunkId: "chunk-20",
        expansion: second,
        ordinal: 20,
        sourceOrdinal: 2,
        text: "Second atomic."
      })
    ]));
    const { persistReceipt, store } = automaticStore(hybridSearch);

    const result = await executeSearch(store);

    expect(result.status).toBe("complete");
    const evidence = persistReceipt.mock.calls[0]![0].evidence;
    const [firstResult, secondResult] = evidence.results;
    expect(firstResult!.expansion).toMatchObject({ passageCount: 1, state: "expanded" });
    expect(secondResult!.expansion).toMatchObject({ passageCount: 0, state: "expanded" });
    expect(secondResult!.expandedContext).toBeUndefined();
    // The citation-bearing atomic evidence survives with its handle and the
    // exact immutable Source Version binding.
    expect(secondResult!).toMatchObject({
      documentVersionId: "source-version-2",
      documentVersionNumber: 1,
      handle: "K2",
      includedText: "Second atomic."
    });
  });

  it("records content-free degradation facts without inventing context text", async () => {
    const degraded: KnowledgeParentExpansion = {
      reason: "parent_context_load_failed",
      state: "degraded",
      units: []
    };
    const hybridSearch = vi.fn(async () => searchResult([
      passage({ chunkId: "chunk-10", expansion: degraded, ordinal: 10, text: "Atomic only." })
    ]));
    const { persistReceipt, store } = automaticStore(hybridSearch);

    const result = await executeSearch(store);

    expect(result.status).toBe("complete");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Evidence:\nAtomic only.");
    expect(text).not.toContain("Related same-Source context");
    expect(persistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        results: [expect.objectContaining({
          expansion: {
            passageCount: 0,
            reason: "parent_context_load_failed",
            state: "degraded",
            tokens: 0
          },
          includedText: "Atomic only."
        })]
      })
    }));
    expect(persistReceipt.mock.calls[0]![0].evidence.results[0]!.expandedContext)
      .toBeUndefined();
  });
});
