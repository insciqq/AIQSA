import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  createKnowledgeToolExecutor,
  type KnowledgeEmbeddingRuntimeResolver,
  type KnowledgeRetrievalStore,
  type KnowledgeScopeAlias
} from "./toolExecutor";
import {
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeAcceptedBinding,
  type KnowledgeHybridPassage
} from "./retrievalTypes";
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
import {
  DEFAULT_KNOWLEDGE_BUDGET_POLICY,
  type KnowledgeBudgetStopReason
} from "./knowledgeBudget";
import type { StructuredKnowledgeSearchResult } from "./structuredRetrieval";
import type { KnowledgeVisualSearchResult } from "./visualEvidence";

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
    apiRoot: "https://embedding.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 300_000
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
    includeWholeBase: true,
    indexedContentRevision: 2,
    indexGenerationId: "generation-private-sentinel",
    knowledgeBaseId: "base-id-private-sentinel",
    knowledgeBaseSnapshotId: "snapshot-private-sentinel",
    ordinal: 0,
    selectedSourceIds: [],
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

function structuredPassage(): KnowledgeHybridPassage {
  return {
    annRank: null,
    baseName: "BASE-NAME-PRIVATE-SENTINEL",
    bindingOrdinal: 0,
    chunkId: "structured-passage-private-sentinel",
    chunkIndex: 0,
    contentHash: "c".repeat(64),
    documentId: "document-id-private-sentinel",
    documentVersionId: "version-id-private-sentinel",
    documentVersionNumber: 3,
    fileName: "sales.xlsx",
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    headingPath: ["Sales", "B2:B3"],
    knowledgeBaseId: "base-id-private-sentinel",
    page: 1,
    rerankScore: null,
    sectionId: "section-private-sentinel",
    sourceArtifactId: "artifact-private-sentinel",
    sourceName: "Sales workbook",
    structuredAnalysis: {
      columns: ["sum Revenue"],
      receipt: {
        formulaCellsUsed: 0,
        hiddenRowsExcluded: 0,
        inputRanges: [{
          range: "B2:B3",
          role: "value",
          sheet: "Sales",
          sheetIndex: 0
        }],
        operation: "aggregate",
        operationSummary: "sum Revenue",
        outputRows: 1,
        plan: {
          aggregate: "sum",
          filters: [],
          groupBy: [],
          includeHidden: false,
          limit: 50,
          operation: "aggregate",
          select: [],
          target: { range: "A1:B3", sheet: "Sales" },
          valueColumn: "Revenue",
          version: 1
        },
        rowsMatched: 2,
        rowsScanned: 2,
        warnings: []
      },
      rows: [[300]]
    },
    text: "Operation: sum Revenue\nInput ranges: Sales!B2:B3 (value)\n\n| sum Revenue |\n| --- |\n| 300 |",
    vectorDistance: null,
    vectorScore: null
  };
}

function visualPassage(): KnowledgeHybridPassage {
  return {
    annRank: null,
    baseName: "BASE-NAME-PRIVATE-SENTINEL",
    bindingOrdinal: 0,
    chunkId: "visual:block-1:asset-1",
    chunkIndex: 2,
    contentHash: "d".repeat(64),
    documentId: "document-id-private-sentinel",
    documentVersionId: "version-id-private-sentinel",
    documentVersionNumber: 3,
    fileName: "report.pdf",
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    headingPath: ["Results"],
    knowledgeBaseId: "base-id-private-sentinel",
    page: 2,
    rerankScore: null,
    sectionId: null,
    sourceArtifactId: "artifact-private-sentinel",
    sourceName: "Quarterly report",
    text: "Visual evidence: Quarterly revenue\nOriginal region: page 2.\nBounded visual analysis: North increased.",
    vectorDistance: null,
    vectorScore: null,
    visualAnalysis: {
      assetId: "asset-1",
      blockId: "block-1",
      boundingBoxes: [{
        bottom: 80,
        coordinateOrigin: "top_left",
        left: 10,
        page: 2,
        right: 90,
        top: 20
      }],
      caption: "Quarterly revenue",
      description: "North increased.",
      headingPath: ["Results"],
      kind: "chart",
      label: "Quarterly revenue",
      page: 2,
      provider: {
        modelId: "vision-upstream-1",
        profileRevisionId: "profile-revision-1",
        provider: "openai",
        providerModelId: "vision-model-1",
        usage: {
          cachedInputTokens: 2,
          inputTokens: 20,
          outputTokens: 8,
          reasoningTokens: 0,
          totalTokens: 28
        }
      },
      status: "available",
      version: 1,
      warnings: []
    }
  };
}

function harness(input: Readonly<{
  aliases?: KnowledgeScopeAlias[];
  bindings?: KnowledgeAcceptedBinding[];
  budgetStopReason?: KnowledgeBudgetStopReason;
  candidateCount?: number;
  hybridBindingCount?: number;
  invocationOrdinal?: number;
  passages?: KnowledgeHybridPassage[];
  policy?: { candidateLimit: number; resultLimit: number; scoreThreshold: number };
  readResult?: Readonly<{
    bindingCount: number;
    candidateCount: number;
    candidateCounts: Readonly<Record<number, number>>;
    passages: readonly KnowledgeHybridPassage[];
  }>;
  runtimeFailure?: Error;
  structuredResult?: StructuredKnowledgeSearchResult;
  visualResult?: KnowledgeVisualSearchResult;
}> = {}) {
  const embed = vi.fn(async (_request: { mode: "document" | "query"; texts: readonly string[] }) => ({
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
    ...(input.budgetStopReason ? {
      budgetState: vi.fn(async () => ({
        invocationOrdinal: input.invocationOrdinal ?? 1,
        policy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
        priorContentHashes: [],
        stopReason: input.budgetStopReason!,
        usage: {
          cumulativeCandidates: 1_400,
          estimatedCostMicros: 0,
          followUpOperations: 1,
          latencyMs: 0,
          lowNoveltyStreak: 0,
          operations: 1,
          queryEmbeddingCalls: 0,
          rerankerCalls: 0,
          retrievedTokens: 0,
          searchPhases: 1,
          subqueriesInCurrentPhase: 1
        }
      }))
    } : {}),
    hybridSearch: vi.fn(async () => ({
      bindingCount: input.hybridBindingCount ?? (input.bindings ?? [binding()]).length,
      candidateCount: input.candidateCount ?? 1,
      candidateCounts: { 0: input.candidateCount ?? 1 },
      passages: input.passages ?? [passage()]
    })),
    invocationOrdinal: vi.fn(async () => input.invocationOrdinal ?? 1),
    loadBindings: vi.fn(async () => input.bindings ?? [binding()]),
    ...(input.aliases ? { loadScopeAliases: vi.fn(async () => input.aliases!) } : {}),
    ...(input.readResult ? { readSource: vi.fn(async () => input.readResult!) } : {}),
    persistReceipt: vi.fn(async (receipt) => {
      receipts.push(receipt);
    }),
    ...(input.structuredResult ? {
      structuredSearch: vi.fn(async () => input.structuredResult!)
    } : {}),
    ...(input.visualResult ? {
      visualSearch: vi.fn(async () => input.visualResult!)
    } : {})
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
    expect(text).toContain(
      "[K1] source legacy source; name FILE-NAME-PRIVATE-SENTINEL.pdf; " +
        "file FILE-NAME-PRIVATE-SENTINEL.pdf; page 7; heading document root"
    );
    expect(text).toContain("The retained private passage.");
    for (const sentinel of [
      "BASE-NAME-PRIVATE-SENTINEL",
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
        handle: "K1",
        page: 7
      }]
    });
    expect(value.receipts).toHaveLength(1);
    expect(knowledgeUsageAttributionsFromToolResult(result)).toEqual([{
      modelId: "embedding-v1",
      provider: "openai_compatible",
      usage: { inputTokens: 7, outputTokens: 0, reasoningTokens: 0, totalTokens: 7 }
    }]);
    expect(result.rawPreview).toEqual({
      knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
      knowledgeRetrieval: evidence,
      providerCall: true
    });

    const stored = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toMatch(/requestPreview|finalProviderResponsePreview/u);
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

  it("executes structured requests without embeddings and persists the calculation receipt", async () => {
    const value = harness({
      aliases: [{
        alias: "S1",
        bindingOrdinal: 0,
        kind: "source",
        label: "Sales workbook",
        sourceArtifactId: "artifact-private-sentinel",
        sourceId: "source-private-sentinel"
      }],
      structuredResult: { kind: "complete", passage: structuredPassage() }
    });
    const result = await execute(value, "Sum Revenue in Sales");
    const evidence = knowledgeEvidenceFromToolResult(result);

    expect(value.store.structuredSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: "Sum Revenue in Sales",
      sourceArtifactIds: ["artifact-private-sentinel"]
    }));
    expect(value.embed).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      candidateCount: 1,
      embeddingExecutions: [],
      outcome: "complete",
      results: [{
        handle: "K1",
        structuredAnalysis: {
          receipt: { operation: "aggregate", operationSummary: "sum Revenue" },
          rows: [[300]]
        }
      }],
      structured: { status: "complete", version: 1 }
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Structured Knowledge calculation evidence")
    });
    expect(snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes)).not.toBeNull();
  });

  it("returns a durable clarification instead of guessing a structured target", async () => {
    const value = harness({
      structuredResult: {
        kind: "needs_clarification",
        question: "Уточните лист Sales или Forecast."
      }
    });
    const result = await execute(value, "Show this spreadsheet table");

    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      candidateCount: 0,
      embeddingExecutions: [],
      outcome: "structured_clarification_required",
      results: [],
      structured: {
        question: "Уточните лист Sales или Forecast.",
        status: "needs_clarification"
      }
    });
    expect(value.embed).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Do not guess")
    });
  });

  it("persists bounded visual evidence and attributes exact vision usage without embeddings", async () => {
    const visual = visualPassage();
    const value = harness({
      aliases: [{
        alias: "S1",
        bindingOrdinal: 0,
        kind: "source",
        label: "Quarterly report",
        sourceArtifactId: "artifact-private-sentinel",
        sourceId: "source-private-sentinel"
      }],
      visualResult: { kind: "complete", passage: visual }
    });
    const result = await execute(value, "What does the revenue chart show?");
    const evidence = knowledgeEvidenceFromToolResult(result);

    expect(value.store.visualSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: "What does the revenue chart show?",
      sourceArtifactIds: ["artifact-private-sentinel"]
    }));
    expect(value.embed).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      candidateCount: 1,
      embeddingExecutions: [],
      outcome: "complete",
      results: [{
        handle: "K1",
        visualAnalysis: {
          description: "North increased.",
          status: "available"
        }
      }],
      visual: { status: "available", version: 1 }
    });
    expect(knowledgeUsageAttributionsFromToolResult(result)).toEqual([{
      modelId: "vision-upstream-1",
      provider: "openai",
      usage: visual.visualAnalysis?.provider?.usage
    }]);
    expect(result.usage).toMatchObject({
      cachedInputTokens: 2,
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28
    });
    expect(snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes)).not.toBeNull();
  });

  it("falls through to ordinary retrieval when no structured artifact applies", async () => {
    const value = harness({ structuredResult: { kind: "not_applicable" } });
    await execute(value, "Show the retention table");
    expect(value.store.structuredSearch).toHaveBeenCalledOnce();
    expect(value.embed).toHaveBeenCalledOnce();
    expect(value.store.hybridSearch).toHaveBeenCalledOnce();
  });

  it("accepts invocation-independent handles and rejects malformed handles", async () => {
    const evidence = knowledgeEvidenceFromToolResult(await execute(harness()))!;
    const independent = {
      ...evidence,
      results: [{ ...evidence.results[0]!, handle: "K42" }]
    };

    expect(decodeKnowledgeRetrievalEvidence({
      ...independent,
      providerText: knowledgeToolResultText(independent)
    })).not.toBeNull();
    const malformed = {
      ...evidence,
      results: [{ ...evidence.results[0]!, handle: "K0" }]
    };
    expect(decodeKnowledgeRetrievalEvidence({
      ...malformed,
      providerText: knowledgeToolResultText(malformed)
    })).toBeNull();
  });

  it("rejects duplicate or unbound embedding execution ordinals", async () => {
    const evidence = knowledgeEvidenceFromToolResult(await execute(harness()))!;
    const execution = evidence.embeddingExecutions[0]!;

    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      embeddingExecutions: [execution, execution]
    })).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      embeddingExecutions: [{ ...execution, bindingOrdinals: [1] }]
    })).toBeNull();
  });

  it("requires complete embedding coverage unless an explicit lexical fallback is recorded", async () => {
    const evidence = knowledgeEvidenceFromToolResult(await execute(harness()))!;

    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      embeddingExecutions: []
    })).toBeNull();
  });

  it("bounds UTF-8 provider text and records honest per-passage truncation", async () => {
    const source = "🧭".repeat(20_000);
    const value = harness({
      passages: [{
        ...passage(source),
        headingPath: Array.from({ length: 64 }, () => "h".repeat(512))
      }]
    });
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

  it("keeps ready evidence available while a bound base has indexing lag", async () => {
    const value = harness({ bindings: [binding({ indexedContentRevision: 1 })] });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      bases: [{ state: "indexing" }],
      outcome: "complete"
    });
    expect(value.embeddingRuntime.resolve).toHaveBeenCalledOnce();
    expect(value.store.hybridSearch).toHaveBeenCalledOnce();
  });

  it("continues with lexical evidence when query embedding is unavailable", async () => {
    const error = Object.assign(new Error("credential_revoked"), { code: "credential_revoked" });
    const value = harness({ runtimeFailure: error });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      embeddingExecutions: [{ status: "error" }],
      failureCode: "credential_revoked",
      outcome: "complete"
    });
    expect(value.store.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({ vectors: [] }));
  });

  it("uses lexical evidence for an invalid embedding snapshot without inventing a call", async () => {
    const value = harness({ bindings: [binding({ embeddingExecutionSnapshot: {} })] });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      embeddingExecutions: [],
      failureCode: "provider_execution_snapshot_invalid",
      outcome: "complete"
    });
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({ vectors: [] }));
    expect(value.receipts).toHaveLength(1);
  });

  it("reports embedding unavailability only when lexical retrieval also has no evidence", async () => {
    const error = Object.assign(new Error("credential_revoked"), { code: "credential_revoked" });
    const value = harness({ candidateCount: 0, passages: [], runtimeFailure: error });
    const result = await execute(value);
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      failureCode: "credential_revoked",
      outcome: "embedding_model_unavailable",
      results: []
    });
  });

  it("returns a qualified result when the persisted dynamic budget is exhausted", async () => {
    const value = harness({ budgetStopReason: "candidate_budget", invocationOrdinal: 7 });
    const result = await execute(value);

    expect(result).toMatchObject({ status: "complete" });
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      budget: { stopReason: "candidate_budget" },
      invocationOrdinal: 7,
      outcome: "budget_exhausted",
      results: []
    });
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(value.receipts).toHaveLength(1);
  });

  it("resolves model-facing Source aliases only inside the admitted run scope", async () => {
    const scopedPassage = {
      ...passage(),
      contentHash: "a".repeat(64),
      sourceArtifactId: "artifact-private-sentinel",
      sourceName: "Source label"
    };
    const value = harness({
      aliases: [
        {
          alias: "S1",
          bindingOrdinal: 0,
          kind: "source",
          label: "Source label",
          sourceArtifactId: "artifact-private-sentinel",
          sourceId: "source-private-sentinel"
        },
        {
          alias: "S2",
          bindingOrdinal: 1,
          kind: "source",
          label: "Same artifact in another Base",
          sourceArtifactId: "artifact-private-sentinel",
          sourceId: "source-private-sentinel"
        }
      ],
      bindings: [
        binding({ includeWholeBase: false, selectedSourceIds: ["source-private-sentinel"] }),
        binding({
          baseName: "SECOND-BASE-PRIVATE-SENTINEL",
          includeWholeBase: false,
          indexGenerationId: "generation-2-private-sentinel",
          knowledgeBaseId: "base-2-private-sentinel",
          knowledgeBaseSnapshotId: "snapshot-2-private-sentinel",
          ordinal: 1,
          selectedSourceIds: ["source-private-sentinel"]
        })
      ],
      hybridBindingCount: 1,
      passages: [scopedPassage]
    });
    const result = await value.executor.execute({
      arguments: { query: "retained passage", sourceAliases: ["S1"] },
      id: "provider-call-1",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(value.store.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      bindingOrdinals: [0],
      sourceIds: ["source-private-sentinel"]
    }));
    expect(text).toContain("S1 — Source label");
    expect(text).not.toContain("S2 — Same artifact in another Base");
    expect(text).toContain(
      "[K1] source S1; name Source label; file FILE-NAME-PRIVATE-SENTINEL.pdf; " +
        "page 7; heading document root"
    );
    expect(text).not.toContain("source-private-sentinel");
    expect(text).not.toContain("artifact-private-sentinel");
  });

  it("reads one admitted Source deterministically without an embedding call", async () => {
    const sourcePassage: KnowledgeHybridPassage = {
      ...passage("The exact neighboring passage."),
      annRank: null,
      contentHash: "e".repeat(64),
      documentId: "source-private-sentinel",
      ftsRank: 1,
      ftsScore: 1,
      fusedScore: 1 / 61,
      headingPath: ["Results"],
      layoutKind: "body",
      sourceArtifactId: "artifact-private-sentinel",
      sourceName: "Dated report",
      vectorDistance: null,
      vectorScore: null
    };
    const value = harness({
      aliases: [{
        alias: "S1",
        bindingOrdinal: 0,
        kind: "source",
        label: "Dated report",
        sourceArtifactId: "artifact-private-sentinel",
        sourceId: "source-private-sentinel"
      }],
      readResult: {
        bindingCount: 1,
        candidateCount: 1,
        candidateCounts: { 0: 1 },
        passages: [sourcePassage]
      }
    });
    const result = await value.executor.execute({
      arguments: { direction: "around", locator: "page 7", sourceAlias: "S1", window: 3 },
      id: "provider-call-1",
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });

    expect(value.store.readSource).toHaveBeenCalledWith(expect.objectContaining({
      direction: "around",
      locator: "page 7",
      sourceArtifactId: "artifact-private-sentinel",
      sourceId: "source-private-sentinel",
      window: 3
    }));
    expect(value.embed).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    const evidence = knowledgeEvidenceFromToolResult(result)!;
    expect(evidence).toMatchObject({
      embeddingExecutions: [],
      operation: "read_source",
      outcome: "complete",
      results: [{ handle: "K1", sourceAlias: "S1" }]
    });
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      embeddingExecutions: [{
        bindingOrdinals: [0],
        durationMs: 1,
        inputTokens: 1,
        modelId: "embedding-v1",
        provider: "fake",
        providerModelId: "embedding-1",
        requestId: null,
        status: "complete",
        totalTokens: 1
      }]
    })).toBeNull();
  });

  it("persists an exact Source-location miss without misreporting the admitted Base as empty", async () => {
    const aliases = [{
      alias: "S1",
      bindingOrdinal: 0,
      kind: "source" as const,
      label: "Dated report",
      sourceArtifactId: "artifact-private-sentinel",
      sourceId: "source-private-sentinel"
    }];
    const value = harness({
      aliases,
      readResult: {
        bindingCount: 1,
        candidateCount: 0,
        candidateCounts: { 0: 0 },
        passages: []
      }
    });
    const result = await value.executor.execute({
      arguments: { direction: "around", locator: "heading: Missing", sourceAlias: "S1", window: 3 },
      id: "provider-call-1",
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });

    expect(value.embed).not.toHaveBeenCalled();
    expect(knowledgeEvidenceFromToolResult(result)).toMatchObject({
      bases: [{ candidateCount: 0, state: "ready" }],
      embeddingExecutions: [],
      operation: "read_source",
      outcome: "source_location_unavailable",
      results: []
    });
  });

  it("rejects a deterministic read result that crosses its requested Source boundary", async () => {
    const value = harness({
      aliases: [{
        alias: "S1",
        bindingOrdinal: 0,
        kind: "source",
        label: "Dated report",
        sourceArtifactId: "artifact-private-sentinel",
        sourceId: "source-private-sentinel"
      }],
      readResult: {
        bindingCount: 1,
        candidateCount: 1,
        candidateCounts: { 0: 1 },
        passages: [{
          ...passage("Wrong Source passage."),
          documentId: "other-source-private-sentinel",
          sourceArtifactId: "other-artifact-private-sentinel"
        }]
      }
    });

    await expect(value.executor.execute({
      arguments: { direction: "around", locator: "page 7", sourceAlias: "S1", window: 3 },
      id: "provider-call-1",
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_source_read_result_invalid");
    expect(value.embed).not.toHaveBeenCalled();
  });

  it("keeps exact follow-up retrieval local and rejects unknown aliases before search", async () => {
    const exact = harness({ aliases: [] });
    await exact.executor.execute({
      arguments: { match: "phrase", value: "exact value" },
      id: "provider-call-1",
      name: KNOWLEDGE_EXACT_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });
    expect(exact.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(exact.store.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({ vectors: [] }));

    const unknown = harness({ aliases: [] });
    const rejected = await unknown.executor.execute({
      arguments: { query: "query", sourceAliases: ["S1"] },
      id: "provider-call-1",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });
    expect(rejected).toMatchObject({ status: "error" });
    expect(unknown.store.hybridSearch).not.toHaveBeenCalled();
    expect(unknown.embeddingRuntime.resolve).not.toHaveBeenCalled();
  });
});
