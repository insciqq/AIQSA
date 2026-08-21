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

describe("Prisma Knowledge vector evidence projection", () => {
  beforeEach(() => {
    vi.mocked(executeKnowledgeRetrievalCore).mockClear();
    vi.mocked(executeKnowledgeRetrievalCore).mockResolvedValue({
      bindingCount: 1,
      candidateCount: 0,
      candidateCounts: { 0: 0 },
      canonicalSourceProvenance: [],
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
});
