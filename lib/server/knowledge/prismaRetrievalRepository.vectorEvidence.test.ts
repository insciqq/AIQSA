import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeOperationKind } from "./knowledgeBudget";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";

vi.mock("./prismaRetrievalCore", () => ({
  executeKnowledgeRetrievalCore: vi.fn()
}));

const vectorSearchEvidence = [{
  bindingOrdinal: 0,
  candidateCount: 0,
  eligibleRows: 0,
  mode: "unavailable" as const,
  scan: {
    efSearch: null,
    iterativeScan: null,
    maxScanTuples: null,
    retrievalBucket: 0
  },
  targetDimension: 1_024 as const
}];

const lexicalBackendEvidence = {
  analyzerProfile: "standard_v1",
  backendKind: "opensearch_bm25_v1",
  candidateCount: 0,
  canonicalRejectionCount: 0,
  durationMs: 0,
  mappingVersion: 1,
  openSearchVersion: "3.8.0",
  physicalIndexVersion: 1,
  projectionCompleteness: "complete",
  queryVariantCount: 1,
  rankingProfileVersion: 4,
  requestId: null,
  status: "complete",
  timedOut: false,
  version: 1
} as const;

describe("Prisma Knowledge vector evidence projection", () => {
  beforeEach(() => {
    vi.mocked(executeKnowledgeRetrievalCore).mockClear();
    vi.mocked(executeKnowledgeRetrievalCore).mockResolvedValue({
      bindingCount: 1,
      candidateCount: 0,
      candidateCounts: { 0: 0 },
      canonicalSourceProvenance: [],
      lexicalBackendEvidence,
      passages: [],
      rankingEvidence: {} as never,
      vectorSearchEvidence
    });
  });

  it.each([
    ["find_exact", 0],
    ["discover_sources", 0],
    ["automatic_search", 1],
    ["knowledge_focused_v1", 1]
  ] as const)("projects vector evidence for %s", async (operation, expectedLength) => {
    const store = createPrismaKnowledgeRetrievalStore({} as never);
    const result = await store.hybridSearch({
      candidateLimit: 8,
      excludedContentHashes: [],
      operation: operation as KnowledgeOperationKind,
      query: "local deterministic query",
      resultLimit: 4,
      runId: "run-1",
      userId: "user-1",
      vectors: []
    });

    expect(result.vectorSearchEvidence).toHaveLength(expectedLength);
    expect(executeKnowledgeRetrievalCore).toHaveBeenCalledOnce();
  });

  it("preserves expanded same-Source context produced by the retrieval core", async () => {
    vi.mocked(executeKnowledgeRetrievalCore).mockResolvedValue({
      bindingCount: 1,
      candidateCount: 1,
      candidateCounts: { 0: 1 },
      canonicalSourceProvenance: [],
      lexicalBackendEvidence,
      passages: [{
        annRank: null,
        baseName: "Policies",
        bindingOrdinal: 0,
        chunkId: "chunk-1",
        chunkIndex: 1,
        contentHash: "a".repeat(64),
        documentId: "source-1",
        documentVersionId: "version-1",
        documentVersionNumber: 1,
        expandedContext: "Next complete row in the same table:\nRelated row.",
        fileName: "policy.pdf",
        ftsRank: 1,
        ftsScore: 1,
        fusedScore: 1,
        headingPath: ["Policy"],
        knowledgeBaseId: "base-1",
        layoutKind: "table_row",
        page: 1,
        sectionId: "section-1",
        signals: [{
          exactKind: null,
          lane: "passage_bm25",
          rank: 1,
          rawScore: 1,
          vectorDistance: null,
          vectorMode: null
        }],
        sourceArtifactId: "artifact-1",
        sourceName: "Policy",
        text: "Primary row.",
        vectorDistance: null,
        vectorScore: null
      }],
      rankingEvidence: {} as never,
      vectorSearchEvidence
    });

    const store = createPrismaKnowledgeRetrievalStore({} as never);
    const result = await store.hybridSearch({
      candidateLimit: 8,
      excludedContentHashes: [],
      operation: "automatic_search",
      query: "policy row",
      resultLimit: 4,
      runId: "run-1",
      userId: "user-1",
      vectors: []
    });

    expect(result.passages[0]?.expandedContext).toBe(
      "Next complete row in the same table:\nRelated row."
    );
  });
});
