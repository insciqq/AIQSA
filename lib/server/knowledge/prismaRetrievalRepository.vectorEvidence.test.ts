import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { KnowledgeOperationKind } from "./knowledgeBudget";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";

vi.mock(import("./prismaRetrievalCore"), async (importOriginal) => ({
  ...await importOriginal(),
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
      excludedOccurrenceKeys: [],
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
      excludedOccurrenceKeys: [],
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

  it("installs the PostgreSQL statement deadline before each retrieval query", async () => {
    const executeRaw = vi.fn(async (
      _strings: TemplateStringsArray,
      ..._values: unknown[]
    ) => 1);
    const queryRaw = vi.fn(async (_query: Prisma.Sql) => []);
    const transaction = vi.fn(async (
      operation: (tx: Readonly<{
        $executeRaw: typeof executeRaw;
        $queryRaw: typeof queryRaw;
      }>) => Promise<unknown>
    ) => operation({ $executeRaw: executeRaw, $queryRaw: queryRaw }));
    vi.mocked(executeKnowledgeRetrievalCore).mockImplementationOnce(async (coreClient) => {
      await coreClient.$queryRaw(Prisma.sql`SELECT 1`);
      return {
        bindingCount: 1,
        candidateCount: 0,
        candidateCounts: { 0: 0 },
        canonicalSourceProvenance: [],
        lexicalBackendEvidence,
        passages: [],
        rankingEvidence: {} as never,
        vectorSearchEvidence
      };
    });
    const store = createPrismaKnowledgeRetrievalStore({ $transaction: transaction } as never);

    await store.hybridSearch({
      candidateLimit: 8,
      excludedOccurrenceKeys: [],
      operation: "automatic_search",
      query: "bounded retrieval",
      resultLimit: 4,
      runId: "run-1",
      userId: "user-1",
      vectors: []
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 50_000
    });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    const [timeoutStrings, ...timeoutValues] = executeRaw.mock.calls[0]!;
    expect(Array.from(timeoutStrings as TemplateStringsArray).join("?"))
      .toContain("statement_timeout");
    expect(timeoutValues).toContain("45000");
    expect(executeRaw.mock.invocationCallOrder[0])
      .toBeLessThan(queryRaw.mock.invocationCallOrder[0]!);
    expect(executeRaw.mock.invocationCallOrder[1])
      .toBeLessThan(queryRaw.mock.invocationCallOrder[0]!);
  });

  it("keeps the vector planner preference inside its own bounded transaction", async () => {
    const statements: string[][] = [];
    const text = (sql: Prisma.Sql | TemplateStringsArray) => Array.isArray(sql)
      ? sql.join("?") : (sql as Prisma.Sql).text;
    const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const current: string[] = [];
      statements.push(current);
      return operation({
        $executeRaw: async (sql: Prisma.Sql | TemplateStringsArray) => {
          current.push(text(sql));
          return 1;
        },
        $queryRaw: async (sql: Prisma.Sql) => {
          current.push(text(sql));
          return [];
        }
      });
    });
    vi.mocked(executeKnowledgeRetrievalCore).mockImplementationOnce(async (coreClient) => {
      await coreClient.$queryRaw(Prisma.sql`SELECT 'scope'`);
      await coreClient.$querySemantic!(Prisma.sql`SELECT 'semantic'`);
      await coreClient.$queryRaw(Prisma.sql`SELECT 'canonical'`);
      return {
        bindingCount: 1, candidateCount: 0, candidateCounts: { 0: 0 },
        canonicalSourceProvenance: [], lexicalBackendEvidence, passages: [],
        rankingEvidence: {} as never, vectorSearchEvidence
      };
    });
    await createPrismaKnowledgeRetrievalStore({ $transaction: transaction } as never).hybridSearch({
      candidateLimit: 64, excludedOccurrenceKeys: [], operation: "automatic_search",
      query: "bounded retrieval", resultLimit: 16, runId: "run-1", userId: "user-1", vectors: []
    });

    expect(statements).toHaveLength(3);
    expect(statements.map(group => group.some(statement => statement.includes("enable_seqscan"))))
      .toEqual([false, true, false]);
    for (const [index, name] of ["scope", "semantic", "canonical"].entries()) {
      expect(statements[index]![0]).toContain("statement_timeout");
      expect(statements[index]![1]).toContain("hnsw.iterative_scan");
      expect(statements[index]!.at(-1)).toBe(`SELECT '${name}'`);
      expect(transaction.mock.calls[index]).toEqual([expect.any(Function), { maxWait: 5_000, timeout: 50_000 }]);
    }
    expect(statements[1]![2]).toBe("SET LOCAL enable_seqscan = off");
  });

  it("classifies a semantic statement timeout and stops before the next query", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError("synthetic timeout", {
      code: "P2010", clientVersion: "test", meta: { code: "57014" }
    });
    const transaction = vi.fn(async () => { throw failure; });
    vi.mocked(executeKnowledgeRetrievalCore).mockImplementationOnce(async (coreClient) => {
      await coreClient.$querySemantic!(Prisma.sql`SELECT 'semantic'`);
      await coreClient.$queryRaw(Prisma.sql`SELECT 'canonical'`);
      throw new Error("unexpected_query_after_timeout");
    });
    await expect(createPrismaKnowledgeRetrievalStore({ $transaction: transaction } as never).hybridSearch({
      candidateLimit: 64, excludedOccurrenceKeys: [], operation: "automatic_search",
      query: "bounded retrieval", resultLimit: 16, runId: "run-1", userId: "user-1", vectors: []
    })).rejects.toMatchObject({ message: "knowledge_retrieval_query_timed_out", cause: failure });
    expect(transaction).toHaveBeenCalledOnce();
  });
});
