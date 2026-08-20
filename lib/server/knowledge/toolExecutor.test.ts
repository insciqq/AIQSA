import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  createKnowledgeToolExecutor,
  type KnowledgeEmbeddingRuntimeResolver,
  type KnowledgeRetrievalStore,
  type KnowledgeScopeAlias
} from "./toolExecutor";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeAcceptedBinding,
  type KnowledgeHybridPassage,
  type KnowledgeRetrievalEvidence,
  type KnowledgeVectorSearchEvidence
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
import type { KnowledgeBudgetReservationRepository } from "./knowledgeBudgetReservationRepository";
import { createKnowledgeOperationRequestV2 } from "./knowledgeOperationRequest";
import {
  createKnowledgeTableDocumentContext,
  knowledgeTableRowId
} from "./documentContext";

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
const explicitProfileRevisionId = "11111111-1111-4111-8111-111111111111";
const explicitSourceId = "22222222-2222-4222-8222-222222222222";
const explicitSourceVersionId = "33333333-3333-4333-8333-333333333333";
const explicitSourceArtifactId = "44444444-4444-4444-8444-444444444444";
const otherSourceId = "55555555-5555-4555-8555-555555555555";
const otherSourceVersionId = "66666666-6666-4666-8666-666666666666";
const otherSourceArtifactId = "77777777-7777-4777-8777-777777777777";

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

function explicitScope(label: string): Readonly<{
  aliases: KnowledgeScopeAlias[];
  bindings: KnowledgeAcceptedBinding[];
}> {
  return {
    aliases: [{
      alias: "S1",
      bindingOrdinal: 0,
      bindingOrdinals: [0],
      kind: "source",
      label,
      sourceArtifactId: explicitSourceArtifactId,
      sourceId: explicitSourceId,
      sourceVersionId: explicitSourceVersionId
    }],
    bindings: [binding({
      executionScope: "profile",
      includeWholeBase: false,
      profileRevisionId: explicitProfileRevisionId,
      selectedSourceIds: [explicitSourceId]
    })]
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
    sourceArtifactId: "artifact-private-sentinel",
    sourceName: "Source label",
    text,
    vectorDistance: 0.1,
    vectorScore: 0.9
  };
}

function exactPassage(text = "exact value"): KnowledgeHybridPassage {
  return {
    ...passage(text),
    annRank: null,
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    vectorDistance: null,
    vectorScore: null
  };
}

function sourceRowPassage(
  documentContext: ReturnType<typeof createKnowledgeTableDocumentContext>,
  index: number,
  text: string
): KnowledgeHybridPassage {
  return {
    ...passage(text),
    annRank: null,
    chunkId: `row-projection-${index}`,
    chunkIndex: 4 + index,
    contentHash: String(index + 1).repeat(64),
    documentContext,
    documentId: "source-private-sentinel",
    ftsRank: index + 1,
    ftsScore: 1,
    fusedScore: 1 / (61 + index),
    headingPath: ["Results"],
    layoutKind: documentContext.locator.kind,
    sectionId: "row-section-private-sentinel",
    sourceArtifactId: "artifact-private-sentinel",
    sourceName: "Dated report",
    vectorDistance: null,
    vectorScore: null
  };
}

function automaticArguments(query: string) {
  return {
    coverage: { expectedPassageCount: null, mode: "partial" },
    exactTerms: [],
    lanes: ["exact", "lexical", "metadata", "semantic"],
    operation: "automatic_search",
    phaseOrdinal: 0,
    plannerVersion: 2,
    purpose: "answer",
    query: query.replace(/\s+/gu, " ").trim(),
    strategy: "focused",
    subqueryOrdinal: 0,
    targetNames: [],
    targetResolution: null,
    targetSourceIds: []
  };
}

function automaticAnalysisArguments(
  operation: "structured_analysis" | "visual_analysis",
  query: string,
  targetSourceId: string
) {
  const common = {
    coverage: { expectedPassageCount: null, mode: "partial" },
    exactTerms: [],
    lanes: [],
    operation,
    phaseOrdinal: 0,
    plannerVersion: 2,
    purpose: "answer",
    query,
    strategy: operation === "structured_analysis" ? "structured_data" : "focused",
    subqueryOrdinal: 0,
    targetNames: ["Selected Source"],
    targetResolution: {
      outcome: "resolved",
      targetSourceIds: [targetSourceId],
      targets: [{
        candidateSourceIds: [targetSourceId],
        matchKind: "source_name",
        outcome: "resolved",
        targetName: "Selected Source"
      }]
    },
    targetSourceIds: [targetSourceId]
  } as const;
  return operation === "structured_analysis"
    ? {
        ...common,
        structured: {
          query,
          selector: {
            columns: [],
            includeHidden: false,
            operation: null,
            range: null,
            sheet: null
          },
          targetSourceIds: [targetSourceId]
        }
      }
    : {
        ...common,
        visual: { query, selector: null, targetSourceIds: [targetSourceId] }
      };
}

function searchArguments(query: string, sourceAliases: readonly string[] | null = null) {
  return {
    coverage: null,
    exactTerms: null,
    purpose: null,
    query,
    sourceAliases
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

const canonicalProvenance = Object.freeze([Object.freeze({
  artifactId: "artifact-private-sentinel",
  bindings: Object.freeze([Object.freeze({
    baseName: "BASE-NAME-PRIVATE-SENTINEL",
    bindingOrdinal: 0,
    knowledgeBaseId: "base-id-private-sentinel"
  })]),
  primaryBindingOrdinal: 0,
  sourceId: "document-id-private-sentinel",
  sourceVersionId: "version-id-private-sentinel"
})]);

function harness(input: Readonly<{
  aliases?: KnowledgeScopeAlias[];
  bindings?: KnowledgeAcceptedBinding[];
  budgetReservations?: KnowledgeBudgetReservationRepository;
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
  replayEvidence?: KnowledgeRetrievalEvidence;
  runtimeFailure?: Error;
  structuredFailure?: Error;
  structuredResult?: StructuredKnowledgeSearchResult;
  vectorSearchEvidence?: readonly KnowledgeVectorSearchEvidence[];
  visualResult?: KnowledgeVisualSearchResult;
  visualFailure?: Error;
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
      passages: input.passages ?? [passage()],
      ...(input.vectorSearchEvidence
        ? { vectorSearchEvidence: input.vectorSearchEvidence }
        : {})
    })),
    findExact: vi.fn(async () => ({
      bindingCount: (input.bindings ?? [binding()]).length,
      candidateCount: 1,
      candidateCounts: { 0: 1 },
      fields: ["body" as const],
      nextCursor: null,
      passages: [exactPassage()],
      scannedBytes: 128,
      scanTruncated: false
    })),
    discoverSources: vi.fn(async () => ({
      bindingCount: (input.bindings ?? [binding()]).length,
      candidateCount: 1,
      candidateCounts: { 0: 1 },
      nextCursor: null,
      sources: [{
        ambiguous: false,
        fileName: "FILE-NAME-PRIVATE-SENTINEL.pdf",
        matchedFields: ["source_name" as const],
        readiness: "ready" as const,
        sourceAlias: "S1",
        sourceName: "Source label",
        sourceVersionNumber: 3
      }]
    })),
    invocationOrdinal: vi.fn(async () => input.invocationOrdinal ?? 1),
    ...(input.replayEvidence ? {
      loadReceipt: vi.fn(async () => input.replayEvidence!)
    } : {}),
    loadBindings: vi.fn(async () => input.bindings ?? [binding()]),
    loadScopeAliases: vi.fn(async () => input.aliases ?? [{
      alias: "S1",
      bindingOrdinal: 0,
      kind: "source" as const,
      label: "Source label",
      sourceArtifactId: "artifact-private-sentinel",
      sourceId: "document-id-private-sentinel",
      sourceVersionId: "version-id-private-sentinel"
    }]),
    ...(input.readResult ? { readSource: vi.fn(async () => input.readResult!) } : {}),
    persistReceipt: vi.fn(async (receipt) => {
      receipts.push(receipt);
    }),
    ...(input.structuredResult || input.structuredFailure ? {
      structuredSearch: vi.fn(async () => {
        if (input.structuredFailure) throw input.structuredFailure;
        return input.structuredResult!;
      })
    } : {}),
    ...(input.visualResult || input.visualFailure ? {
      visualSearch: vi.fn(async () => {
        if (input.visualFailure) throw input.visualFailure;
        return input.visualResult!;
      })
    } : {})
  };
  return {
    embed,
    embeddingRuntime,
    executor: createKnowledgeToolExecutor({
      ...(input.budgetReservations ? { budgetReservations: input.budgetReservations } : {}),
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
    arguments: automaticArguments(query),
    id: "provider-call-1",
    name: "retrieve_knowledge"
  }, {
    persistedToolCallId: "tool-call-row-1",
    request: {} as never,
    runId: "run-1",
    userId: "user-1"
  });
}

function budgetReservationHarness() {
  const estimate = Object.freeze({
    candidateCount: 40,
    costMicros: 0,
    followUpOperationSlots: 0,
    latencyMs: 1_000,
    operationSlots: 1,
    queryEmbeddingCalls: 1,
    repairCalls: 0,
    rerankerCalls: 1,
    retrievedTokens: 4_096,
    searchPhaseSlots: 1,
    subquerySlots: 1,
    validationCalls: 0
  });
  const reservedRecord = {
    leaseToken: "lease-token-00000001",
    modelRunId: "run-1",
    modelRunToolCallId: "tool-call-row-1",
    operationRequest: null as never,
    purgedAt: null,
    reservation: {
      createdAt: "2026-08-19T20:00:00.000Z",
      estimate,
      followUp: false,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      idempotencyKey: "knowledge-operation:tool-call-row-1",
      leaseExpiresAt: "2026-08-19T20:01:00.000Z",
      operationOrdinal: 1,
      phaseOrdinal: 0,
      requestHash: "a".repeat(64),
      state: "reserved" as const,
      subqueryOrdinal: 0,
      version: 1 as const
    }
  };
  let reserveCount = 0;
  const reserve = vi.fn<KnowledgeBudgetReservationRepository["reserve"]>(async () => {
    reserveCount += 1;
    return reserveCount === 1
      ? {
          chargeAfter: estimate,
          chargeBefore: {
            ...estimate,
            candidateCount: 0,
            latencyMs: 0,
            operationSlots: 0,
            queryEmbeddingCalls: 0,
            rerankerCalls: 0,
            retrievedTokens: 0,
            searchPhaseSlots: 0,
            subquerySlots: 0
          },
          kind: "admitted" as const,
          record: reservedRecord,
          roundIndex: 0
        }
      : {
          chargeAfter: estimate,
          kind: "idempotent" as const,
          record: reservedRecord,
          roundIndex: 0
        };
  });
  const claimDispatch = vi.fn<KnowledgeBudgetReservationRepository["claimDispatch"]>(async () => ({
    kind: "transitioned" as const,
    record: reservedRecord as never
  }));
  const markAmbiguous = vi.fn<KnowledgeBudgetReservationRepository["markAmbiguous"]>(async () => ({
    kind: "transitioned" as const,
    record: reservedRecord as never
  }));
  const release = vi.fn<KnowledgeBudgetReservationRepository["release"]>(async () => ({
    kind: "transitioned" as const,
    record: reservedRecord as never
  }));
  const settle = vi.fn<KnowledgeBudgetReservationRepository["settle"]>(async () => ({
    kind: "transitioned" as const,
    record: reservedRecord as never
  }));
  return {
    claimDispatch,
    markAmbiguous,
    release,
    repository: { claimDispatch, markAmbiguous, release, reserve, settle },
    reserve,
    settle
  } satisfies Readonly<{
    claimDispatch: typeof claimDispatch;
    markAmbiguous: typeof markAmbiguous;
    release: typeof release;
    repository: KnowledgeBudgetReservationRepository;
    reserve: typeof reserve;
    settle: typeof settle;
  }>;
}

function durableRequestFromLastReservation(
  reservations: ReturnType<typeof budgetReservationHarness>
) {
  const input = reservations.reserve.mock.calls.at(-1)?.[0];
  if (!input) throw new Error("knowledge_reservation_call_missing");
  return createKnowledgeOperationRequestV2({
    ...input.operationRequest,
    idempotencyKey: input.idempotencyKey,
    originalQuery: {
      reference: "88888888-8888-4888-8888-888888888888",
      sha256: input.originalQuerySha256
    },
    phaseOrdinal: 0,
    profileRevisionNumber: 1,
    reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    subqueryOrdinal: 0,
    version: 2
  });
}

function atomicBudgetExecutionHarness() {
  const profileRevisionId = "11111111-1111-4111-8111-111111111111";
  const sourceId = "22222222-2222-4222-8222-222222222222";
  const sourceVersionId = "33333333-3333-4333-8333-333333333333";
  const sourceArtifactId = "44444444-4444-4444-8444-444444444444";
  const reservations = budgetReservationHarness();
  const value = harness({
    aliases: [{
      alias: "S1",
      bindingOrdinal: 0,
      bindingOrdinals: [0],
      kind: "source",
      label: "Source label",
      sourceArtifactId,
      sourceId,
      sourceVersionId
    }],
    bindings: [binding({
      executionScope: "profile",
      includeWholeBase: false,
      profileRevisionId,
      selectedSourceIds: [sourceId]
    })],
    budgetReservations: reservations.repository,
    passages: [{
      ...passage(),
      documentId: sourceId,
      documentVersionId: sourceVersionId,
      sourceArtifactId
    }]
  });
  return {
    call: {
      arguments: automaticArguments("retained passage"),
      id: "provider-call-1",
      name: "retrieve_knowledge"
    },
    context: {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    },
    profileRevisionId,
    reservations,
    sourceId,
    value
  };
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
    expect(text).toContain("--- BEGIN SOURCE EVIDENCE K1 ---");
    expect(text).toContain("[K1] [S1]");
    expect(text).toContain("Source: Source label");
    expect(text).toContain("Version/date: version 3");
    expect(text).toContain("File: FILE-NAME-PRIVATE-SENTINEL.pdf");
    expect(text).toContain("Page: 7");
    expect(text).toContain("Heading: document root");
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
      structuredResult: {
        canonicalSourceProvenance: canonicalProvenance,
        kind: "complete",
        passage: structuredPassage()
      }
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
    expect(value.receipts[0]).toMatchObject({
      canonicalSourceProvenance: canonicalProvenance
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
      visualResult: {
        canonicalSourceProvenance: canonicalProvenance,
        kind: "complete",
        passage: visual
      }
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
    expect(value.receipts[0]).toMatchObject({
      canonicalSourceProvenance: canonicalProvenance
    });
    expect(snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes)).not.toBeNull();
  });

  it("dispatches the exact explicit structured operation, reservation, and replay receipt", async () => {
    const scope = explicitScope("Sales workbook");
    const reservations = budgetReservationHarness();
    const query = "Calculate median Revenue in Sales.xlsx";
    const call = {
      arguments: automaticAnalysisArguments("structured_analysis", query, explicitSourceId),
      id: "provider-call-1",
      name: "retrieve_knowledge"
    };
    const context = {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    };
    const value = harness({
      ...scope,
      budgetReservations: reservations.repository,
      structuredResult: {
        kind: "complete",
        passage: {
          ...structuredPassage(),
          documentId: explicitSourceId,
          documentVersionId: explicitSourceVersionId,
          sourceArtifactId: explicitSourceArtifactId
        }
      }
    });

    await expect(value.executor.preflight!(call, context)).resolves.toEqual({ kind: "admitted" });
    const result = await value.executor.execute(call, context);
    const evidence = knowledgeEvidenceFromToolResult(result)!;

    expect(reservations.reserve).toHaveBeenLastCalledWith(expect.objectContaining({
      estimate: expect.objectContaining({ queryEmbeddingCalls: 0, rerankerCalls: 0 }),
      operationRequest: {
        operation: "structured_analysis",
        plan: {
          allowedLanes: [],
          coverage: { expectedPassageCount: null, mode: "partial" },
          exactTerms: [],
          rewrittenQuery: query,
          strategy: "structured_data",
          targetNames: ["Selected Source"],
          targetSourceIds: [explicitSourceId]
        },
        plannerVersion: 2,
        profileRevisionId: explicitProfileRevisionId,
        purpose: "answer",
        resolvedSourceIds: [explicitSourceId],
        sourceAliases: [],
        structured: {
          query,
          selector: {
            columns: [],
            includeHidden: false,
            operation: null,
            range: null,
            sheet: null
          },
          targetSourceIds: [explicitSourceId]
        }
      }
    }));
    expect(value.store.structuredSearch).toHaveBeenCalledWith(expect.objectContaining({
      query,
      selector: {
        columns: [],
        includeHidden: false,
        operation: null,
        range: null,
        sheet: null
      },
      sourceArtifactIds: [explicitSourceArtifactId],
      targetSourceIds: [explicitSourceId]
    }));
    expect(value.embed).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      embeddingExecutions: [],
      operation: "structured_analysis",
      outcome: "complete",
      structured: { status: "complete", version: 1 }
    });
    expect(value.receipts[0]).toMatchObject({
      evidence: { structured: { status: "complete", version: 1 } }
    });
    const structuredMarkerDropped = { ...evidence, structured: undefined };
    expect(decodeKnowledgeRetrievalEvidence({
      ...structuredMarkerDropped,
      providerText: knowledgeToolResultText(structuredMarkerDropped)
    })).toBeNull();

    const replay = harness({ replayEvidence: evidence });
    const replayed = await replay.executor.execute(call, context);
    expect(knowledgeEvidenceFromToolResult(replayed)).toEqual(evidence);
    expect(replay.store.loadBindings).not.toHaveBeenCalled();
    expect(replay.store.structuredSearch).toBeUndefined();
    expect(replay.embed).not.toHaveBeenCalled();
    expect(replay.store.hybridSearch).not.toHaveBeenCalled();
  });

  it("dispatches the exact explicit visual selector and target without hybrid retrieval", async () => {
    const scope = explicitScope("Quarterly report");
    const reservations = budgetReservationHarness();
    const query = "What does the revenue chart show?";
    const call = {
      arguments: automaticAnalysisArguments("visual_analysis", query, explicitSourceId),
      id: "provider-call-1",
      name: "retrieve_knowledge"
    };
    const context = {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    };
    const value = harness({
      ...scope,
      budgetReservations: reservations.repository,
      visualResult: {
        kind: "complete",
        passage: {
          ...visualPassage(),
          documentId: explicitSourceId,
          documentVersionId: explicitSourceVersionId,
          sourceArtifactId: explicitSourceArtifactId
        }
      }
    });
    await expect(value.executor.preflight!(call, context)).resolves.toEqual({ kind: "admitted" });
    const result = await value.executor.execute(call, context);
    const evidence = knowledgeEvidenceFromToolResult(result)!;

    expect(reservations.reserve).toHaveBeenLastCalledWith(expect.objectContaining({
      estimate: expect.objectContaining({ queryEmbeddingCalls: 0, rerankerCalls: 0 }),
      operationRequest: {
        operation: "visual_analysis",
        plan: {
          allowedLanes: [],
          coverage: { expectedPassageCount: null, mode: "partial" },
          exactTerms: [],
          rewrittenQuery: query,
          strategy: "focused",
          targetNames: ["Selected Source"],
          targetSourceIds: [explicitSourceId]
        },
        plannerVersion: 2,
        profileRevisionId: explicitProfileRevisionId,
        purpose: "answer",
        resolvedSourceIds: [explicitSourceId],
        sourceAliases: [],
        visual: { query, selector: null, targetSourceIds: [explicitSourceId] }
      }
    }));
    expect(value.store.visualSearch).toHaveBeenCalledWith(expect.objectContaining({
      query,
      selector: null,
      sourceArtifactIds: [explicitSourceArtifactId],
      targetSourceIds: [explicitSourceId]
    }));
    expect(value.embed).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      embeddingExecutions: [],
      operation: "visual_analysis",
      outcome: "complete",
      visual: { status: "available", version: 1 }
    });
    expect(value.receipts[0]).toMatchObject({
      evidence: { visual: { status: "available", version: 1 } }
    });
    const visualMarkerDropped = { ...evidence, visual: undefined };
    expect(decodeKnowledgeRetrievalEvidence({
      ...visualMarkerDropped,
      providerText: knowledgeToolResultText(visualMarkerDropped)
    })).toBeNull();
  });

  it("never falls through explicit analysis not-applicable or error outcomes", async () => {
    const scope = explicitScope("Selected Source");
    const structured = harness({
      ...scope,
      structuredResult: { kind: "not_applicable" }
    });
    const visual = harness({
      ...scope,
      visualFailure: new Error("visual_runtime_unavailable")
    });
    const context = {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    };
    const structuredResult = await structured.executor.execute({
      arguments: automaticAnalysisArguments(
        "structured_analysis",
        "Calculate median Revenue",
        explicitSourceId
      ),
      id: "provider-call-1",
      name: "retrieve_knowledge"
    }, context);
    const visualResult = await visual.executor.execute({
      arguments: automaticAnalysisArguments(
        "visual_analysis",
        "What does this chart show?",
        explicitSourceId
      ),
      id: "provider-call-1",
      name: "retrieve_knowledge"
    }, context);

    expect(knowledgeEvidenceFromToolResult(structuredResult)).toMatchObject({
      embeddingExecutions: [],
      failureCode: "knowledge_structured_not_applicable",
      operation: "structured_analysis",
      outcome: "base_empty",
      results: []
    });
    expect(knowledgeEvidenceFromToolResult(visualResult)).toMatchObject({
      embeddingExecutions: [],
      failureCode: "knowledge_visual_analysis_unavailable",
      operation: "visual_analysis",
      outcome: "base_empty",
      results: []
    });
    for (const candidate of [structured, visual]) {
      expect(candidate.embed).not.toHaveBeenCalled();
      expect(candidate.store.hybridSearch).not.toHaveBeenCalled();
      expect(candidate.receipts).toHaveLength(1);
    }
  });

  it("rejects explicit analysis evidence from a different admitted Source", async () => {
    const scope = explicitScope("Selected Source");
    const aliases: KnowledgeScopeAlias[] = [...scope.aliases, {
      alias: "S2",
      bindingOrdinal: 0,
      bindingOrdinals: [0],
      kind: "source",
      label: "Other Source",
      sourceArtifactId: otherSourceArtifactId,
      sourceId: otherSourceId,
      sourceVersionId: otherSourceVersionId
    }];
    const bindings = scope.bindings.map((candidate) => ({
      ...candidate,
      selectedSourceIds: [explicitSourceId, otherSourceId]
    }));
    const structured = harness({
      aliases,
      bindings,
      structuredResult: {
        kind: "complete",
        passage: {
          ...structuredPassage(),
          documentId: otherSourceId,
          documentVersionId: otherSourceVersionId,
          sourceArtifactId: otherSourceArtifactId
        }
      }
    });
    const visual = harness({
      aliases,
      bindings,
      visualResult: {
        kind: "complete",
        passage: {
          ...visualPassage(),
          documentId: otherSourceId,
          documentVersionId: otherSourceVersionId,
          sourceArtifactId: otherSourceArtifactId
        }
      }
    });
    const context = {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    };

    await expect(structured.executor.execute({
      arguments: automaticAnalysisArguments(
        "structured_analysis",
        "Calculate median Revenue",
        explicitSourceId
      ),
      id: "provider-call-1",
      name: "retrieve_knowledge"
    }, context)).rejects.toThrow("knowledge_structured_result_invalid");
    await expect(visual.executor.execute({
      arguments: automaticAnalysisArguments(
        "visual_analysis",
        "What does this chart show?",
        explicitSourceId
      ),
      id: "provider-call-2",
      name: "retrieve_knowledge"
    }, context)).rejects.toThrow("knowledge_visual_result_invalid");
    for (const candidate of [structured, visual]) {
      expect(candidate.embed).not.toHaveBeenCalled();
      expect(candidate.store.hybridSearch).not.toHaveBeenCalled();
      expect(candidate.receipts).toHaveLength(0);
    }
  });

  it.each([{
    match: "phrase" as const,
    value: "retention period"
  }, {
    match: "pattern" as const,
    value: "API-\\d{4}"
  }])("durably reserves dedicated $match exact semantics", async ({ match, value }) => {
    const reservations = budgetReservationHarness();
    const scoped = explicitScope("Selected Source");
    const candidate = harness({
      ...scoped,
      budgetReservations: reservations.repository
    });
    const context = {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    };

    await expect(candidate.executor.preflight!({
      arguments: {
        caseMode: "sensitive",
        cursor: null,
        field: "body",
        limit: 17,
        match,
        sourceAliases: null,
        value
      },
      id: "provider-call-1",
      name: KNOWLEDGE_EXACT_TOOL_NAME
    }, context)).resolves.toEqual({ kind: "admitted" });

    expect(durableRequestFromLastReservation(reservations)).toMatchObject({
      exact: { caseMode: "sensitive", field: "body", limit: 17, match, value },
      operation: "find_exact",
      plan: {
        allowedLanes: ["exact"],
        exactTerms: [value],
        rewrittenQuery: value,
        strategy: "focused",
        targetNames: [],
        targetSourceIds: []
      },
      purpose: "follow_up"
    });
    expect(reservations.reserve).toHaveBeenCalledWith(expect.objectContaining({
      estimate: expect.objectContaining({
        candidateCount: 17,
        queryEmbeddingCalls: 0,
        rerankerCalls: 0,
        retrievedTokens: 17 * 512
      })
    }));
    expect(candidate.embed).not.toHaveBeenCalled();
    expect(candidate.store.hybridSearch).not.toHaveBeenCalled();
  });

  it("reserves the bounded discovery result limit without embedding or reranking budget", async () => {
    const reservations = budgetReservationHarness();
    const scoped = explicitScope("Selected Source");
    const candidate = harness({
      ...scoped,
      budgetReservations: reservations.repository
    });

    await expect(candidate.executor.preflight!({
      arguments: {
        cursor: null,
        fields: ["filename", "source_name"],
        limit: 5,
        query: "source label"
      },
      id: "provider-call-1",
      name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    })).resolves.toEqual({ kind: "admitted" });

    expect(durableRequestFromLastReservation(reservations)).toMatchObject({
      discovery: {
        fields: ["filename", "source_name"],
        limit: 5,
        query: "source label"
      },
      operation: "discover_sources"
    });
    expect(reservations.reserve).toHaveBeenCalledWith(expect.objectContaining({
      estimate: expect.objectContaining({
        candidateCount: 5,
        queryEmbeddingCalls: 0,
        rerankerCalls: 0,
        retrievedTokens: 5 * 512
      })
    }));
    expect(candidate.embed).not.toHaveBeenCalled();
    expect(candidate.store.hybridSearch).not.toHaveBeenCalled();
  });

  it("durably reserves comparison follow-up strategy without inventing targets", async () => {
    const reservations = budgetReservationHarness();
    const scoped = explicitScope("Selected Source");
    const candidate = harness({
      ...scoped,
      budgetReservations: reservations.repository
    });

    await expect(candidate.executor.preflight!({
      arguments: {
        coverage: "comparison",
        exactTerms: null,
        purpose: "follow_up",
        query: "Compare the returned passages",
        sourceAliases: null
      },
      id: "provider-call-1",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    })).resolves.toEqual({ kind: "admitted" });

    expect(durableRequestFromLastReservation(reservations)).toMatchObject({
      operation: "search_knowledge",
      purpose: "follow_up",
      search: {
        rewrittenQuery: "Compare the returned passages",
        strategy: "comparison",
        targetNames: [],
        targetSourceIds: []
      }
    });
  });

  it.each(["exhaustive", "corpus_summary"] as const)(
    "reserves the complete bounded dispatch for %s before retrieval",
    async (strategy) => {
      const reservations = budgetReservationHarness();
      const scoped = explicitScope("Selected Source");
      const candidate = harness({
        ...scoped,
        budgetReservations: reservations.repository
      });
      const argumentsValue = {
        ...automaticArguments(`Run ${strategy}`),
        coverage: {
          expectedPassageCount: strategy === "exhaustive" ? null : 100,
          mode: strategy === "exhaustive" ? "verified_only" as const : "partial" as const
        },
        purpose: strategy === "exhaustive" ? "coverage" as const : "summary" as const,
        strategy
      };

      await expect(candidate.executor.preflight!({
        arguments: argumentsValue,
        id: "provider-call-1",
        name: "retrieve_knowledge"
      }, {
        persistedToolCallId: "tool-call-row-1",
        request: {} as never,
        runId: "run-1",
        userId: "user-1"
      })).resolves.toEqual({ kind: "admitted" });

      expect(reservations.reserve).toHaveBeenCalledWith(expect.objectContaining({
        estimate: expect.objectContaining({
          candidateCount: 100,
          retrievedTokens: 100 * 512
        })
      }));
    }
  );

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
    expect(text).toContain("Truncated: yes");
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
    expect(value.store.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      operation: "automatic_search",
      vectors: []
    }));
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

  it("rejects an exhausted dynamic budget before retrieval or receipt persistence", async () => {
    const value = harness({ budgetStopReason: "candidate_budget", invocationOrdinal: 7 });
    const admission = await value.executor.preflight!({
      arguments: automaticArguments("retained passage"),
      id: "provider-call-1",
      name: "retrieve_knowledge"
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });
    const result = await execute(value);

    expect(admission).toMatchObject({
      kind: "rejected",
      result: {
        rawPreview: {
          knowledgeAdmission: {
            reasonCode: "knowledge_budget_exhausted",
            stopReason: "candidate_budget"
          },
          providerCall: false
        },
        status: "error"
      }
    });
    expect(result).toMatchObject({ status: "error" });
    expect(knowledgeEvidenceFromToolResult(result)).toBeNull();
    expect(value.store.loadBindings).not.toHaveBeenCalled();
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(value.receipts).toHaveLength(0);
  });

  it("reserves atomically in preflight, claims once before retrieval, and attaches actual usage", async () => {
    const { call, context, profileRevisionId, reservations, sourceId, value } =
      atomicBudgetExecutionHarness();

    await expect(value.executor.preflight!(call, context)).resolves.toEqual({ kind: "admitted" });
    const result = await value.executor.execute(call, context);

    expect(result.status).toBe("complete");
    expect(reservations.reserve).toHaveBeenCalledTimes(2);
    expect(reservations.reserve).toHaveBeenLastCalledWith(expect.objectContaining({
      idempotencyKey: "knowledge-operation:tool-call-row-1",
      operationRequest: expect.objectContaining({
        operation: "automatic_search",
        profileRevisionId,
        resolvedSourceIds: [sourceId],
        search: expect.objectContaining({
          allowedLanes: ["exact", "lexical", "metadata", "semantic"],
          rewrittenQuery: "retained passage",
          targetSourceIds: []
        }),
        sourceAliases: []
      })
    }));
    expect(reservations.claimDispatch).toHaveBeenCalledOnce();
    expect(value.receipts).toEqual([expect.objectContaining({
      budgetReservation: {
        actual: expect.objectContaining({
          candidateCount: 1,
          queryEmbeddingCalls: 1,
          repairCalls: 0,
          validationCalls: 0
        }),
        leaseToken: "lease-token-00000001",
        reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }
    })]);
    expect(reservations.settle).not.toHaveBeenCalled();
    expect(reservations.release).not.toHaveBeenCalled();
    expect(reservations.markAmbiguous).not.toHaveBeenCalled();
  });

  it("releases a reserved operation cancelled before its first side effect", async () => {
    const { call, context, reservations, value } = atomicBudgetExecutionHarness();
    const controller = new AbortController();

    await expect(value.executor.preflight!(call, context)).resolves.toEqual({ kind: "admitted" });
    controller.abort();

    await expect(value.executor.execute(call, context, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(reservations.reserve).toHaveBeenCalledTimes(2);
    expect(reservations.release).toHaveBeenCalledOnce();
    expect(reservations.release).toHaveBeenCalledWith(expect.objectContaining({
      reason: "operation_cancelled",
      reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    }));
    expect(reservations.claimDispatch).not.toHaveBeenCalled();
    expect(reservations.markAmbiguous).not.toHaveBeenCalled();
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
  });

  it("marks a claimed reservation ambiguous when retrieval fails after dispatch", async () => {
    const { call, context, reservations, value } = atomicBudgetExecutionHarness();
    vi.mocked(value.store.hybridSearch).mockRejectedValueOnce(new Error("retrieval_side_effect_lost"));

    await expect(value.executor.preflight!(call, context)).resolves.toEqual({ kind: "admitted" });
    await expect(value.executor.execute(call, context)).rejects.toThrow("retrieval_side_effect_lost");

    expect(reservations.claimDispatch).toHaveBeenCalledOnce();
    expect(reservations.markAmbiguous).toHaveBeenCalledOnce();
    expect(reservations.markAmbiguous).toHaveBeenCalledWith(expect.objectContaining({
      reason: "operation_dispatch_failed",
      reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    }));
    expect(reservations.release).not.toHaveBeenCalled();
    expect(value.receipts).toHaveLength(0);
  });

  it.each([
    { expected: "admitted", invocationOrdinal: 4 },
    { expected: "admitted", invocationOrdinal: 8 },
    { expected: "admitted", invocationOrdinal: 14 },
    { expected: "rejected", invocationOrdinal: 15 }
  ] as const)(
    "applies the default operation policy before side effects at ordinal $invocationOrdinal",
    async ({ expected, invocationOrdinal }) => {
      const value = harness({ invocationOrdinal });
      const admission = await value.executor.preflight!({
        arguments: automaticArguments("operation boundary"),
        id: `provider-call-${invocationOrdinal}`,
        name: "retrieve_knowledge"
      }, {
        persistedToolCallId: `tool-call-row-${invocationOrdinal}`,
        request: {} as never,
        runId: "run-1",
        userId: "user-1"
      });

      expect(admission.kind).toBe(expected);
      if (invocationOrdinal === 15) {
        expect(admission).toMatchObject({
          kind: "rejected",
          result: {
            rawPreview: {
              knowledgeAdmission: {
                reasonCode: "knowledge_budget_exhausted",
                stopReason: "operation_budget"
              },
              providerCall: false
            }
          }
        });
      }
      expect(value.store.loadBindings).not.toHaveBeenCalled();
      expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
      expect(value.store.hybridSearch).not.toHaveBeenCalled();
      expect(value.receipts).toHaveLength(0);
    }
  );

  it("replays a committed receipt before budget, bindings, embedding, or retrieval", async () => {
    const original = knowledgeEvidenceFromToolResult(await execute(harness()))!;
    const value = harness({ replayEvidence: original });
    const call = {
      arguments: searchArguments("retained passage"),
      id: "provider-call-1",
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    };
    const context = {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    };

    const admission = await value.executor.preflight!(call, context);
    const result = await value.executor.execute(call, context);

    expect(admission).toMatchObject({ kind: "replayed" });
    expect(knowledgeEvidenceFromToolResult(result)).toEqual(original);
    expect(value.store.invocationOrdinal).not.toHaveBeenCalled();
    expect(value.store.loadBindings).not.toHaveBeenCalled();
    expect(value.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    expect(value.receipts).toHaveLength(0);
  });

  it("resolves one exact Source alias across every admitted Base containing its tuple", async () => {
    const scopedPassage = {
      ...passage(),
      contentHash: "a".repeat(64),
      sourceArtifactId: "artifact-private-sentinel",
      sourceName: "Source label"
    };
    const value = harness({
      aliases: [{
        alias: "S1",
        bindingOrdinal: 0,
        bindingOrdinals: [0, 1],
        kind: "source",
        label: "Source label",
        sourceArtifactId: "artifact-private-sentinel",
        sourceId: "source-private-sentinel",
        sourceVersionId: "version-id-private-sentinel"
      }],
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
        }),
        binding({
          baseName: "OLDER-TUPLE-BASE-PRIVATE-SENTINEL",
          includeWholeBase: false,
          indexGenerationId: "generation-3-private-sentinel",
          knowledgeBaseId: "base-3-private-sentinel",
          knowledgeBaseSnapshotId: "snapshot-3-private-sentinel",
          ordinal: 2,
          selectedSourceIds: ["source-private-sentinel"]
        })
      ],
      hybridBindingCount: 2,
      passages: [scopedPassage]
    });
    const result = await value.executor.execute({
      arguments: searchArguments("retained passage", ["S1"]),
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
      bindingOrdinals: [0, 1],
      sourceIds: ["source-private-sentinel"]
    }));
    expect(text).toContain("[K1] [S1]");
    expect(text).toContain("Source: Source label");
    expect(text).toContain("File: FILE-NAME-PRIVATE-SENTINEL.pdf");
    expect(text).toContain("Page: 7");
    expect(text).toContain("Heading: document root");
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
        sourceId: "source-private-sentinel",
        sourceVersionId: "version-id-private-sentinel"
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
      read: expect.objectContaining({
        direction: "around",
        embedding: "forbidden",
        locator: "page 7",
        resolution: "exact",
        target: { kind: "page", page: 7 },
        window: 3
      }),
      sourceArtifactId: "artifact-private-sentinel",
      sourceId: "source-private-sentinel"
    }));
    expect(value.embed).not.toHaveBeenCalled();
    expect(value.store.hybridSearch).not.toHaveBeenCalled();
    const evidence = knowledgeEvidenceFromToolResult(result)!;
    expect(evidence).toMatchObject({
      embeddingExecutions: [],
      operation: "read_source",
      outcome: "complete",
      read: {
        resolvedSource: {
          sourceAlias: "S1",
          sourceArtifactId: "artifact-private-sentinel",
          sourceId: "source-private-sentinel",
          sourceVersionId: "version-id-private-sentinel"
        }
      },
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

  it("keeps a complete row projection group atomic for row locators and evidence handles", async () => {
    const blockId = `b_${"3".repeat(24)}_24`;
    const rowId = knowledgeTableRowId(blockId, 2);
    const first = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 0, columnStart: 0, text: "Pressure" }],
      columnEnd: 0,
      columnStart: 0,
      headerLineage: [{ columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" }],
      projectionCount: 2,
      projectionIndex: 0,
      rowIndex: 2
    });
    const second = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 1, columnStart: 1, text: "20" }],
      columnEnd: 1,
      columnStart: 1,
      headerLineage: [{ columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Value" }],
      projectionCount: 2,
      projectionIndex: 1,
      rowIndex: 2
    });
    const passages = [
      sourceRowPassage(first, 0, "Metric / Value\nPressure"),
      sourceRowPassage(second, 1, "Metric / Value\n20")
    ];
    const targets = [
      { locator: `row:${rowId}`, target: { kind: "row", rowId } },
      { locator: "K1", target: { handle: "K1", kind: "evidence_handle" } }
    ] as const;
    for (const [index, target] of targets.entries()) {
      const value = harness({
        aliases: [{
          alias: "S1",
          bindingOrdinal: 0,
          kind: "source",
          label: "Dated report",
          sourceArtifactId: "artifact-private-sentinel",
          sourceId: "source-private-sentinel",
          sourceVersionId: "version-id-private-sentinel"
        }],
        policy: { candidateLimit: 40, resultLimit: 1, scoreThreshold: 0.01 },
        readResult: {
          bindingCount: 1,
          candidateCount: 2,
          candidateCounts: { 0: 2 },
          passages
        }
      });
      const result = await value.executor.execute({
        arguments: {
          direction: "around",
          locator: target.locator,
          sourceAlias: "S1",
          window: 1
        },
        id: `provider-call-row-${index}`,
        name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
      }, {
        persistedToolCallId: `tool-call-row-${index}`,
        request: {} as never,
        runId: "run-1",
        userId: "user-1"
      });

      const evidence = knowledgeEvidenceFromToolResult(result);
      expect(evidence).toMatchObject({
        candidateCount: 2,
        read: {
          target: target.target,
          window: 1
        },
        resultLimit: 2,
        results: [
          { documentContext: { locator: { projectionIndex: 0, rowId } }, handle: "K1" },
          { documentContext: { locator: { projectionIndex: 1, rowId } }, handle: "K2" }
        ]
      });
      expect(evidence?.results).toHaveLength(2);
      expect(evidence?.providerText).toContain(`Read locator: row:${rowId}`);
      expect(value.embed).not.toHaveBeenCalled();
      expect(value.store.hybridSearch).not.toHaveBeenCalled();
    }
  });

  it("uses the aggregate excerpt budget for one uneven complete atomic row", async () => {
    const blockId = `b_${"8".repeat(24)}_28`;
    const rowId = knowledgeTableRowId(blockId, 2);
    const passages = Array.from({ length: 8 }, (_, projectionIndex) => {
      const value = projectionIndex === 0
        ? `Narrative ${"word ".repeat(1_100).trim()}`
        : `Value ${projectionIndex}`;
      return sourceRowPassage(createKnowledgeTableDocumentContext({
        blockId,
        cells: [{
          columnEnd: projectionIndex,
          columnStart: projectionIndex,
          text: value.slice(0, 4_096)
        }],
        columnEnd: projectionIndex,
        columnStart: projectionIndex,
        headerLineage: [{
          columnEnd: projectionIndex,
          columnStart: projectionIndex,
          rowIndex: 0,
          text: projectionIndex === 0 ? "Metric" : "Actual"
        }],
        projectionCount: 8,
        projectionIndex,
        rowIndex: 2
      }), projectionIndex, value);
    });
    expect(passages.reduce((total, entry) =>
      total + Buffer.byteLength(entry.text, "utf8"), 0)).toBeLessThanOrEqual(32 * 1_024);
    expect(Buffer.byteLength(passages[0]!.text, "utf8")).toBeGreaterThan(4 * 1_024);
    const value = harness({
      aliases: [{
        alias: "S1",
        bindingOrdinal: 0,
        kind: "source",
        label: "Dated report",
        sourceArtifactId: "artifact-private-sentinel",
        sourceId: "source-private-sentinel",
        sourceVersionId: "version-id-private-sentinel"
      }],
      policy: { candidateLimit: 40, resultLimit: 1, scoreThreshold: 0.01 },
      readResult: {
        bindingCount: 1,
        candidateCount: passages.length,
        candidateCounts: { 0: passages.length },
        passages
      }
    });

    const result = await value.executor.execute({
      arguments: {
        direction: "around",
        locator: `row:${rowId}`,
        sourceAlias: "S1",
        window: 1
      },
      id: "provider-call-row-aggregate-budget",
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-aggregate-budget",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });

    const evidence = knowledgeEvidenceFromToolResult(result);
    expect(evidence?.results).toHaveLength(8);
    expect(evidence?.results.every((entry) => entry.textTruncated === false)).toBe(true);
    expect(evidence?.providerText).toContain(`row:${rowId}: ` +
      Array.from({ length: 8 }, (_, index) => `[K${index + 1}]`).join(" "));
  });

  it("rejects incomplete and over-limit row groups instead of silently slicing them", async () => {
    const blockId = `b_${"4".repeat(24)}_25`;
    const rowId = knowledgeTableRowId(blockId, 3);
    const incompleteContext = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 0, columnStart: 0, text: "Only first" }],
      columnEnd: 0,
      columnStart: 0,
      headerLineage: [],
      projectionCount: 2,
      projectionIndex: 0,
      rowIndex: 3
    });
    const aliases: KnowledgeScopeAlias[] = [{
      alias: "S1",
      bindingOrdinal: 0,
      kind: "source",
      label: "Dated report",
      sourceArtifactId: "artifact-private-sentinel",
      sourceId: "source-private-sentinel",
      sourceVersionId: "version-id-private-sentinel"
    }];
    const incomplete = harness({
      aliases,
      readResult: {
        bindingCount: 1,
        candidateCount: 1,
        candidateCounts: { 0: 1 },
        passages: [sourceRowPassage(incompleteContext, 0, "Only first")]
      }
    });
    await expect(incomplete.executor.execute({
      arguments: { direction: "around", locator: `row:${rowId}`, sourceAlias: "S1", window: 1 },
      id: "provider-call-incomplete-row",
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-incomplete-row",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_source_read_row_result_invalid");

    if (incompleteContext.locator.kind !== "table_row_projection") {
      throw new Error("missing_projection_test_fixture");
    }
    const overLimitPassages = Array.from({ length: 9 }, (_, index) => {
      const context = {
        ...incompleteContext,
        locator: {
          ...incompleteContext.locator,
          columnEnd: index,
          columnStart: index,
          projectionCount: 9,
          projectionIndex: index
        }
      };
      return {
        ...sourceRowPassage(context, index, String(index)),
        contentHash: index.toString(16).repeat(64)
      };
    });
    const overLimit = harness({
      aliases,
      readResult: {
        bindingCount: 1,
        candidateCount: 9,
        candidateCounts: { 0: 9 },
        passages: overLimitPassages
      }
    });
    await expect(overLimit.executor.execute({
      arguments: { direction: "around", locator: `row:${rowId}`, sourceAlias: "S1", window: 8 },
      id: "provider-call-over-limit-row",
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-over-limit-row",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_source_read_row_result_invalid");
  });

  it("persists an exact Source-location miss without misreporting the admitted Base as empty", async () => {
    const aliases = [{
      alias: "S1",
      bindingOrdinal: 0,
      kind: "source" as const,
      label: "Dated report",
      sourceArtifactId: "artifact-private-sentinel",
      sourceId: "source-private-sentinel",
      sourceVersionId: "version-id-private-sentinel"
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
      read: {
        resolvedSource: {
          sourceAlias: "S1",
          sourceArtifactId: "artifact-private-sentinel",
          sourceId: "source-private-sentinel",
          sourceVersionId: "version-id-private-sentinel"
        }
      },
      results: []
    });
    expect(knowledgeEvidenceFromToolResult(result)?.scopeAliases).toContainEqual({
      alias: "S1",
      kind: "source",
      label: "Dated report"
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
        sourceId: "source-private-sentinel",
        sourceVersionId: "version-id-private-sentinel"
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
    const exact = harness();
    const exactResult = await exact.executor.execute({
      arguments: {
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 8,
        match: "phrase",
        sourceAliases: null,
        value: "exact value"
      },
      id: "provider-call-1",
      name: KNOWLEDGE_EXACT_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-1",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });
    expect(knowledgeEvidenceFromToolResult(exactResult)).toMatchObject({
      embeddingExecutions: [],
      exact: {
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 8,
        match: "phrase",
        matches: [{ field: "body", resultOrdinal: 0 }],
        nextCursor: null,
        scannedBytes: 128,
        scanTruncated: false,
        value: "exact value",
        version: 1
      },
      fusion: "none",
      operation: "find_exact",
      outcome: "complete",
      results: [{ sourceAlias: "S1" }]
    });
    expect(exact.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(exact.store.findExact).toHaveBeenCalledWith({
      request: {
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 8,
        match: "phrase",
        value: "exact value"
      },
      runId: "run-1",
      sourceArtifactIds: ["artifact-private-sentinel"],
      userId: "user-1"
    });
    expect(exact.store.hybridSearch).not.toHaveBeenCalled();

    const discovery = harness();
    const discoveryResult = await discovery.executor.execute({
      arguments: {
        cursor: null,
        fields: ["source_name", "filename"],
        limit: 5,
        query: "source label"
      },
      id: "provider-call-2",
      name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
    }, {
      persistedToolCallId: "tool-call-row-2",
      request: {} as never,
      runId: "run-1",
      userId: "user-1"
    });
    const discoveryEvidence = knowledgeEvidenceFromToolResult(discoveryResult);
    expect(discoveryEvidence).toMatchObject({
      candidateCount: 1,
      discovery: {
        cursor: null,
        fields: ["filename", "source_name"],
        limit: 5,
        nextCursor: null,
        query: "source label",
        sources: [{
          ambiguous: false,
          fileName: "FILE-NAME-PRIVATE-SENTINEL.pdf",
          matchedFields: ["source_name"],
          readiness: "ready",
          sourceAlias: "S1",
          sourceName: "Source label",
          sourceVersionNumber: 3
        }],
        version: 1
      },
      embeddingExecutions: [],
      fusion: "none",
      operation: "discover_sources",
      results: []
    });
    expect(discovery.store.discoverSources).toHaveBeenCalledWith({
      request: {
        cursor: null,
        fields: ["filename", "source_name"],
        limit: 5,
        query: "source label"
      },
      runId: "run-1",
      sourceArtifactIds: ["artifact-private-sentinel"],
      userId: "user-1"
    });
    expect(discovery.embeddingRuntime.resolve).not.toHaveBeenCalled();
    expect(discovery.store.hybridSearch).not.toHaveBeenCalled();
    expect(discoveryEvidence?.providerText).toContain("metadata only");
    expect(discoveryEvidence?.providerText).not.toContain("The retained private passage");

    const unknown = harness({ aliases: [] });
    const rejected = await unknown.executor.execute({
      arguments: searchArguments("query", ["S1"]),
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
