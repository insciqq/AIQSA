import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  createKnowledgeToolExecutor,
  type KnowledgeEmbeddingRuntimeResolver,
  type KnowledgeRetrievalStore
} from "./toolExecutor";
import type { KnowledgeAcceptedBinding, KnowledgeHybridPassage } from "./retrievalTypes";
import {
  decodeKnowledgeRetrievalEvidence,
  knowledgeEvidenceFromToolResult,
  knowledgeToolResultText,
  knowledgeUsageAttributionsFromToolResult
} from "./toolResult";
import {
  parsePersistedToolExecutionResult,
  snapshotToolExecutionResult
} from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";

const configuration = {
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
    queryInstructionTemplate: "Represent this query: {text}",
    supportsMrl: false,
    targetDimension: 1_024
  },
  modelClass: "embedding",
  upstreamModelId: "embedding-v1"
} as const;

const snapshot = {
  connection: {
    allowPrivateNetwork: false,
    apiRoot: "https://embedding.example.test/v1"
  },
  connectionDisplayName: "Embedding endpoint",
  connectionId: "connection-private-sentinel",
  credentialId: "credential-private-sentinel",
  credentialVersionId: "credential-version-private-sentinel",
  model: configuration,
  modelDisplayName: "Embedding model",
  providerFamily: "openai_compatible",
  providerModelId: "embedding-deployment-private-sentinel",
  version: 1
} as const;

const pin = createKnowledgeVectorSpacePin({
  configuration,
  deploymentId: snapshot.providerModelId
})!;

function binding(overrides: Partial<KnowledgeAcceptedBinding> = {}): KnowledgeAcceptedBinding {
  return {
    baseContentRevision: 2,
    baseName: "BASE-NAME-PRIVATE-SENTINEL",
    embeddingConnectionId: snapshot.connectionId,
    embeddingCredentialId: snapshot.credentialId,
    embeddingCredentialSource: "default",
    embeddingCredentialVersionId: snapshot.credentialVersionId,
    embeddingExecutionSnapshot: snapshot,
    embeddingProviderModelId: snapshot.providerModelId,
    indexedContentRevision: 2,
    indexGenerationId: "generation-private-sentinel",
    knowledgeBaseId: "base-id-private-sentinel",
    ordinal: 0,
    targetDimension: 1024,
    vectorSpaceFingerprint: pin.fingerprint,
    ...overrides
  };
}

function passage(text = "The retained private passage."): KnowledgeHybridPassage {
  return {
    annRank: 1,
    baseName: "BASE-NAME-PRIVATE-SENTINEL",
    bindingOrdinal: 0,
    chunkId: "chunk-id-private-sentinel",
    chunkIndex: 4,
    documentId: "document-id-private-sentinel",
    documentVersionId: "version-id-private-sentinel",
    documentVersionNumber: 3,
    fileName: "FILE-NAME-PRIVATE-SENTINEL.pdf",
    ftsRank: 1,
    ftsScore: 0.8,
    fusedScore: 2 / 61,
    knowledgeBaseId: "base-id-private-sentinel",
    page: 7,
    text,
    vectorDistance: 0.1,
    vectorScore: 0.9
  };
}

function harness(input: Readonly<{
  bindings?: KnowledgeAcceptedBinding[];
  candidateCount?: number;
  invocationOrdinal?: number;
  passages?: KnowledgeHybridPassage[];
  policy?: { candidateLimit: number; resultLimit: number; scoreThreshold: number };
  runtimeFailure?: Error;
}> = {}) {
  const embed = vi.fn(async (request: { mode: "document" | "query"; texts: readonly string[] }) => ({
    model: "embedding-v1",
    requestId: "embedding-request-1",
    usage: { inputTokens: 7, totalTokens: 7 },
    vectors: [Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)]
  }));
  const embeddingRuntime: KnowledgeEmbeddingRuntimeResolver = {
    resolve: vi.fn(async () => {
      if (input.runtimeFailure) throw input.runtimeFailure;
      return {
        adapter: { embed },
        configuration,
        provider: "openai_compatible",
        providerModelId: snapshot.providerModelId
      };
    })
  };
  const receipts: unknown[] = [];
  const store: KnowledgeRetrievalStore = {
    hybridSearch: vi.fn(async () => ({
      bindingCount: (input.bindings ?? [binding()]).length,
      candidateCount: input.candidateCount ?? 1,
      candidateCounts: { 0: input.candidateCount ?? 1 },
      passages: input.passages ?? [passage()]
    })),
    invocationOrdinal: vi.fn(async () => input.invocationOrdinal ?? 1),
    loadBindings: vi.fn(async () => input.bindings ?? [binding()]),
    persistReceipt: vi.fn(async (receipt) => {
      receipts.push(receipt);
    })
  };
  return {
    embed,
    embeddingRuntime,
    executor: createKnowledgeToolExecutor({
      embeddingRuntime,
      ...(input.policy ? { policy: { resolve: vi.fn(async () => input.policy!) } } : {}),
      store
    }),
    receipts,
    store
  };
}

async function execute(value: ReturnType<typeof harness>, query = "retained passage") {
  return value.executor.execute({
    arguments: { query },
    id: "provider-call-1",
    name: "retrieve_knowledge"
  }, {
    persistedToolCallId: "tool-call-row-1",
    request: {} as never,
    runId: "run-1",
    userId: "user-1"
  });
}

describe("Knowledge retrieval tool executor", () => {
  it("embeds in query mode, returns opaque citations, and persists exact private evidence", async () => {
    const value = harness();
    const result = await execute(value, "  retained\npassage ");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const evidence = knowledgeEvidenceFromToolResult(result);

    expect(value.embed).toHaveBeenCalledWith({ mode: "query", texts: ["retained passage"] });
    expect(value.store.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: "retained passage",
      runId: "run-1",
      userId: "user-1",
      vectors: [expect.objectContaining({ bindingOrdinal: 0, targetDimension: 1024 })]
    }));
    expect(result.status).toBe("complete");
    expect(text).toContain("[K1.1] page 7\nThe retained private passage.");
    for (const sentinel of [
      "BASE-NAME-PRIVATE-SENTINEL",
      "FILE-NAME-PRIVATE-SENTINEL",
      "base-id-private-sentinel",
      "version-id-private-sentinel",
      "chunk-id-private-sentinel"
    ]) expect(text).not.toContain(sentinel);
    expect(evidence).toMatchObject({
      candidateCount: 1,
      outcome: "complete",
      query: "retained passage",
      results: [{
        baseName: "BASE-NAME-PRIVATE-SENTINEL",
        documentVersionId: "version-id-private-sentinel",
        documentVersionNumber: 3,
        handle: "K1.1",
        page: 7
      }]
    });
    expect(value.receipts).toHaveLength(1);
    expect(knowledgeUsageAttributionsFromToolResult(result)).toEqual([{
      modelId: "embedding-v1",
      provider: "openai_compatible",
      usage: { inputTokens: 7, outputTokens: 0, reasoningTokens: 0, totalTokens: 7 }
    }]);

    const stored = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
    expect(stored).not.toBeNull();
    const rehydrated = parsePersistedToolExecutionResult(
      { id: "provider-call-1", name: "retrieve_knowledge" },
      stored
    );
    expect(rehydrated).toEqual(result);
  });

  it("resolves the current installation retrieval policy and snapshots it in the receipt", async () => {
    const value = harness({
      policy: { candidateLimit: 12, resultLimit: 3, scoreThreshold: 0.02 }
    });
    const result = await execute(value);

    expect(value.store.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      candidateLimit: 12,
      resultLimit: 3,
      threshold: 0.02
    }));
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      candidateLimit: 12,
      resultLimit: 3,
      threshold: 0.02
    });
  });

  it("rejects canonical evidence whose opaque handle disagrees with its invocation", async () => {
    const evidence = knowledgeEvidenceFromToolResult(await execute(harness()))!;
    const malformed = {
      ...evidence,
      results: [{ ...evidence.results[0]!, handle: "K2.1" }]
    };

    expect(decodeKnowledgeRetrievalEvidence({
      ...malformed,
      providerText: knowledgeToolResultText(malformed)
    })).toBeNull();
  });

  it("bounds UTF-8 provider text and records honest per-passage truncation", async () => {
    const source = "🧭".repeat(20_000);
    const value = harness({ passages: [passage(source)] });
    const result = await execute(value);
    const evidence = knowledgeEvidenceFromToolResult(result)!;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(evidence.results[0]).toMatchObject({
      sourceTextBytes: Buffer.byteLength(source, "utf8"),
      textTruncated: true
    });
    expect(Buffer.byteLength(evidence.results[0]!.includedText, "utf8"))
      .toBe(evidence.results[0]!.includedTextBytes);
    expect(evidence.results[0]!.includedText).not.toContain("�");
    expect(text).toContain("[passage truncated]");
  });

  it.each([
    ["base_empty", 0, []],
    ["zero_above_threshold", 2, []]
  ] as const)("persists the %s negative outcome", async (outcome, candidateCount, passages) => {
    const value = harness({ candidateCount, passages: [...passages] });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({ outcome, results: [] });
    expect(result.status).toBe("complete");
    expect(value.receipts).toHaveLength(1);
  });

  it("records indexing lag without embedding or retrieval", async () => {
    const value = harness({ bindings: [binding({ indexedContentRevision: 1 })] });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      bases: [{ state: "indexing" }],
      outcome: "base_indexing"
    });
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
  });

  it("records unavailable accepted embedding evidence before retrieval", async () => {
    const error = Object.assign(new Error("credential_revoked"), { code: "credential_revoked" });
    const value = harness({ runtimeFailure: error });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      embeddingExecutions: [{ status: "error" }],
      failureCode: "credential_revoked",
      outcome: "embedding_model_unavailable"
    });
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
  });

  it("settles an invalid accepted snapshot without inventing an embedding call", async () => {
    const value = harness({ bindings: [binding({ embeddingExecutionSnapshot: {} })] });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      embeddingExecutions: [],
      failureCode: "provider_execution_snapshot_invalid",
      outcome: "embedding_model_unavailable"
    });
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(value.receipts).toHaveLength(1);
  });

  it("enforces the persisted-call invocation rank before external I/O", async () => {
    const value = harness({ invocationOrdinal: 4 });
    const result = await execute(value);
    expect(result).toMatchObject({ status: "error" });
    expect(result.rawPreview?.finalProviderResponsePreview).toEqual({
      error: "knowledge_invocation_limit_reached"
    });
    expect(value.store.loadBindings).not.toHaveBeenCalled();
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.receipts).toHaveLength(0);
  });
});
