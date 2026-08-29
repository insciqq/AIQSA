import { describe, expect, it, vi } from "vitest";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import {
  KNOWLEDGE_SIGNAL_RANK_MAX,
  type KnowledgeRetrievalLane
} from "./retrievalRanking";
import { knowledgeLexicalBackendEvidenceFixture } from "./searchRetrieval.testFixtures";

type CoreClient = Parameters<typeof executeKnowledgeRetrievalCore>[0];
type MockCoreClient = CoreClient & Readonly<{
  $queryRaw: ReturnType<typeof vi.fn>;
  vectors: readonly Readonly<{
    bindingOrdinal: number;
    indexGenerationId: string;
    knowledgeBaseId: string;
    targetDimension: 1_024;
    vector: readonly number[];
  }>[];
}>;

function scope(bindingOrdinal: number, baseName: string, knowledgeBaseId: string) {
  return {
    acceptedIndexArtifactIds: [],
    baseName,
    bindingOrdinal,
    eligibleRows: 1,
    indexGenerationId: `generation-${bindingOrdinal}`,
    knowledgeBaseId,
    projectionComplete: true,
    targetDimension: 1_024
  };
}

function row(input: Readonly<{
  artifactId: string;
  baseName: string;
  bindingOrdinal: number;
  chunkId: string;
  chunkIndex?: number;
  contributingBindingOrdinals?: readonly number[];
  contentHash?: string;
  documentContext?: unknown;
  knowledgeBaseId: string;
  lane?: KnowledgeRetrievalLane;
  laneRank?: number;
  layoutKind?: "body" | "field_ambiguous" | "field_pair" | "table_ambiguous" |
    "table_row" | "table_row_projection";
  sourceId: string;
  sourceName?: string;
  sourceVersionId: string;
  text?: string;
  versionNumber?: number;
  rawScore?: number;
  searchIndexArtifactId?: string;
  vectorDistance?: number;
}>) {
  return {
    baseName: input.baseName,
    bindingOrdinal: input.bindingOrdinal,
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex ?? 0,
    contributingBindingOrdinals: input.contributingBindingOrdinals ?? [input.bindingOrdinal],
    contentHash: input.contentHash ?? "a".repeat(64),
    documentId: input.sourceId,
    documentContext: input.documentContext ?? null,
    documentVersionId: input.sourceVersionId,
    documentVersionNumber: input.versionNumber ?? 1,
    exactKind: input.lane === "exact" ? "identifier" : null,
    fileName: "shared-name.txt",
    headingPath: ["Policy"],
    knowledgeBaseId: input.knowledgeBaseId,
    lane: input.lane ?? "passage_bm25",
    laneRank: input.laneRank ?? 1,
    layoutKind: input.layoutKind ?? "body",
    page: 1,
    rawScore: input.rawScore ?? 1,
    ...(input.searchIndexArtifactId
      ? { searchIndexArtifactId: input.searchIndexArtifactId }
      : {}),
    sectionId: "section-1",
    sourceArtifactId: input.artifactId,
    sourceName: input.sourceName ?? "Shared name",
    text: input.text ?? "Canonical source evidence.",
    vectorDistance: input.vectorDistance ?? null,
    vectorMode: input.lane === "passage_semantic" ? "ann" : null
  };
}

function mockClient(scopes: readonly unknown[], rows: readonly unknown[]): MockCoreClient {
  const vectors = scopes.map((value) => {
    const accepted = value as ReturnType<typeof scope>;
    return {
      bindingOrdinal: accepted.bindingOrdinal,
      indexGenerationId: accepted.indexGenerationId,
      knowledgeBaseId: accepted.knowledgeBaseId,
      targetDimension: 1_024 as const,
      vector: Array.from({ length: 1_024 }, () => 0)
    };
  });
  return {
    $queryRaw: vi.fn(async () => [{ candidates: [...rows], scopes: [...scopes] }]),
    vectors
  } as unknown as MockCoreClient;
}

function sqlText(value: unknown): string {
  return (value as { strings: readonly string[] }).strings.join("?");
}

async function execute(
  client: MockCoreClient,
  overrides: Partial<Parameters<typeof executeKnowledgeRetrievalCore>[1]> = {}
) {
  return executeKnowledgeRetrievalCore(client, {
    candidateLimit: 64,
    excludedContentHashes: [],
    query: "canonical source evidence",
    resultLimit: 8,
    runId: "run-1",
    userId: "user-1",
    vectors: client.vectors,
    ...overrides
  });
}

describe("Prisma retrieval core canonical Source identity", () => {
  it("uses only canonically revalidated OpenSearch identities for the BM25 lane", async () => {
    const indexArtifactId = "hierarchy-1";
    const contentHash = "b".repeat(64);
    const admitted = {
      ...scope(0, "Policies", "base-policies"),
      acceptedIndexArtifactIds: [indexArtifactId]
    };
    const client = mockClient([admitted], []);
    client.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ candidates: [], scopes: [admitted] }])
      .mockResolvedValueOnce([row({
        artifactId: "source-artifact-1",
        baseName: "Policies",
        bindingOrdinal: 0,
        chunkId: "passage-1",
        contentHash,
        knowledgeBaseId: "base-policies",
        searchIndexArtifactId: indexArtifactId,
        sourceId: "source-1",
        sourceVersionId: "source-version-1",
        text: "Canonically revalidated BM25 evidence."
      })]);
    const lexicalSearch = vi.fn(async () => ({
      evidence: knowledgeLexicalBackendEvidenceFixture(),
      hits: [{
        contentHash,
        indexArtifactId,
        passageId: "passage-1",
        rank: 1,
        score: 0.42,
        sourceVersionId: "source-version-1"
      }]
    }));

    const result = await execute(client, { lexicalSearch });

    expect(lexicalSearch).toHaveBeenCalledOnce();
    expect(client.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlText(client.$queryRaw.mock.calls[1]![0])).toContain(
      'chunk."indexArtifactId" = hit."indexArtifactId"'
    );
    expect(result.passages).toMatchObject([{
      chunkId: "passage-1",
      signals: [{ lane: "passage_bm25", rank: 1 }]
    }]);
    expect(result.lexicalBackendEvidence.backendKind).toBe("opensearch_bm25_v1");
  });

  it("fails closed when the OpenSearch projection is incomplete", async () => {
    const admitted = {
      ...scope(0, "Policies", "base-policies"),
      acceptedIndexArtifactIds: ["hierarchy-1"],
      projectionComplete: false
    };
    const client = mockClient([admitted], []);
    const lexicalSearch = vi.fn();

    await expect(execute(client, { lexicalSearch })).rejects.toThrow(
      "knowledge_search_projection_incomplete"
    );
    expect(lexicalSearch).not.toHaveBeenCalled();
    expect(client.$queryRaw).toHaveBeenCalledOnce();
  });

  it("fails closed on an unavailable OpenSearch request without a PostgreSQL lexical retry", async () => {
    const admitted = {
      ...scope(0, "Policies", "base-policies"),
      acceptedIndexArtifactIds: ["hierarchy-1"]
    };
    const client = mockClient([admitted], []);
    const lexicalSearch = vi.fn(async () => {
      throw new Error("opensearch_connection_failed");
    });

    await expect(execute(client, { lexicalSearch })).rejects.toThrow(
      "opensearch_connection_failed"
    );
    expect(lexicalSearch).toHaveBeenCalledOnce();
    expect(client.$queryRaw).toHaveBeenCalledOnce();
  });

  it("fails closed when any OpenSearch identity misses canonical revalidation", async () => {
    const admitted = {
      ...scope(0, "Policies", "base-policies"),
      acceptedIndexArtifactIds: ["hierarchy-1"]
    };
    const client = mockClient([admitted], []);
    client.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ candidates: [], scopes: [admitted] }])
      .mockResolvedValueOnce([]);
    const lexicalSearch = vi.fn(async () => ({
      evidence: knowledgeLexicalBackendEvidenceFixture(),
      hits: [{
        contentHash: "b".repeat(64),
        indexArtifactId: "hierarchy-1",
        passageId: "foreign-passage",
        rank: 1,
        score: 0.42,
        sourceVersionId: "foreign-source-version"
      }]
    }));

    await expect(execute(client, { lexicalSearch })).rejects.toThrow(
      "knowledge_search_candidate_revalidation_failed"
    );
    expect(client.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("enforces fixed limits while treating a scope without vector rows as available lexical work", async () => {
    const admitted = scope(0, "Base A", "base-a");
    const client = mockClient([admitted], []);

    await expect(execute(client, { candidateLimit: 39 })).rejects.toThrow(
      "knowledge_retrieval_request_invalid"
    );
    await expect(execute(mockClient([admitted], []), { resultLimit: 16 }))
      .resolves.toMatchObject({ candidateCount: 0, passages: [] });
    await expect(execute(mockClient([admitted], []), { resultLimit: 9 })).rejects.toThrow(
      "knowledge_retrieval_request_invalid"
    );
    await expect(execute(mockClient([{ ...admitted, eligibleRows: 0 }], []), {
      vectors: []
    })).resolves.toMatchObject({
      bindingCount: 1,
      candidateCount: 0,
      passages: [],
      vectorSearchEvidence: [{ eligibleRows: 0, mode: "unavailable" }]
    });
  });

  it("routes identifier and date values through the ordinary set-based exact lane", async () => {
    const client = mockClient([scope(0, "Policies", "base-policies")], [row({
      artifactId: "artifact-policy",
      baseName: "Policies",
      bindingOrdinal: 0,
      chunkId: "chunk-policy",
      knowledgeBaseId: "base-policies",
      lane: "exact",
      sourceId: "source-policy",
      sourceVersionId: "version-policy",
      text: "The requested policy evidence."
    })]);

    const result = await execute(client, {
      anchorQuery: "What changed in SAFE-2718 on 2026-08-20?",
      query: "policy event details",
      vectors: []
    });

    expect(client.$queryRaw).toHaveBeenCalledOnce();
    const query = client.$queryRaw.mock.calls[0]![0] as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    const queryText = sqlText(query);
    expect(queryText).toContain("exact_query_values AS MATERIALIZED");
    expect(queryText).toContain("exact_match_frequencies AS MATERIALIZED");
    expect(queryText).toContain('PARTITION BY exact_match."bindingOrdinal", exact_match."normalizedValue"');
    expect(queryText).toContain('sum(1.0 / exact_match."matchFrequency")');
    expect(queryText).toContain("KnowledgeArtifactExactEntry");
    expect(queryText).toContain("unnest(");
    expect(queryText).toContain('"modelSimpleQuery"');
    expect(queryText).toContain('"anchorSimpleQuery"');
    expect(query.values).toEqual(expect.arrayContaining(["safe-2718", "2026-08-20"]));
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]).toMatchObject({
      chunkId: "chunk-policy",
      signals: [{ exactKind: "identifier", lane: "exact", rank: 1, rawScore: 1 }]
    });
    expect(result.vectorSearchEvidence).toMatchObject([{
      candidateCount: 0,
      mode: "unavailable"
    }]);
  });

  it("filters a weak nearest neighbor before fusion and returns an empty ranking", async () => {
    const result = await execute(mockClient([scope(0, "Policies", "base-policies")], [row({
      artifactId: "artifact-policy",
      baseName: "Policies",
      bindingOrdinal: 0,
      chunkId: "chunk-weak",
      knowledgeBaseId: "base-policies",
      lane: "passage_semantic",
      rawScore: 0.2,
      sourceId: "source-policy",
      sourceVersionId: "version-policy",
      vectorDistance: 0.8
    })]));

    expect(result).toMatchObject({
      candidateCount: 0,
      candidateCounts: { 0: 0 },
      passages: [],
      rankingEvidence: { candidateOrder: [] }
    });
  });

  it("returns novel evidence on later calls without reattaching excluded prior context", async () => {
    const admitted = scope(0, "Policies", "base-policies");
    const client = mockClient([admitted], [
      row({
        artifactId: "artifact-policy",
        baseName: "Policies",
        bindingOrdinal: 0,
        chunkId: "chunk-prior",
        chunkIndex: 0,
        contentHash: "a".repeat(64),
        knowledgeBaseId: "base-policies",
        lane: "exact",
        sourceId: "source-policy",
        sourceVersionId: "version-policy"
      }),
      row({
        artifactId: "artifact-policy",
        baseName: "Policies",
        bindingOrdinal: 0,
        chunkId: "chunk-novel",
        chunkIndex: 1,
        contentHash: "b".repeat(64),
        knowledgeBaseId: "base-policies",
        laneRank: 2,
        sourceId: "source-policy",
        sourceVersionId: "version-policy"
      })
    ]);

    const result = await execute(client, {
      excludedContentHashes: ["a".repeat(64)]
    });

    expect(result).toMatchObject({
      candidateCount: 1,
      passages: [{ chunkId: "chunk-novel" }],
      rankingEvidence: { candidateOrder: ["chunk-novel"] }
    });
    expect(result.passages[0]).not.toHaveProperty("expandedContext");
    await expect(execute(client, {
      excludedContentHashes: ["not-a-content-hash"]
    })).rejects.toThrow("knowledge_retrieval_exclusion_invalid");
  });

  it("returns one non-inflated candidate for the same artifact admitted through Bases A+B", async () => {
    const contributingBindingOrdinals = [0, 1];
    const baseA = row({
      artifactId: "artifact-x",
      baseName: "Base A",
      bindingOrdinal: 0,
      chunkId: "chunk-x",
      contributingBindingOrdinals,
      knowledgeBaseId: "base-a",
      laneRank: 6,
      sourceId: "source-x",
      sourceVersionId: "version-x"
    });
    const baseB = row({
      artifactId: "artifact-x",
      baseName: "Base B",
      bindingOrdinal: 1,
      chunkId: "chunk-x",
      contributingBindingOrdinals,
      knowledgeBaseId: "base-b",
      lane: "exact",
      sourceId: "source-x",
      sourceVersionId: "version-x"
    });
    const combined = await execute(mockClient([
      scope(0, "Base A", "base-a"),
      scope(1, "Base B", "base-b")
    ], [baseA, baseB]));
    const baseAOnly = await execute(mockClient([
      scope(0, "Base A", "base-a")
    ], [{ ...baseA, contributingBindingOrdinals: [0] }]));
    const secondaryOnly = execute(mockClient([
      scope(0, "Base A", "base-a"),
      scope(1, "Base B", "base-b")
    ], [baseB]));

    expect(combined.candidateCount).toBe(1);
    expect(combined.candidateCounts).toEqual({ 0: 1, 1: 0 });
    expect(combined.passages).toHaveLength(1);
    expect(combined.passages[0]).toMatchObject({
      baseName: "Base A",
      bindingOrdinal: 0,
      chunkId: "chunk-x",
      knowledgeBaseId: "base-a",
      signals: [{ lane: "passage_bm25", rank: 6 }]
    });
    expect(combined.passages[0]!.fusedScore).toBe(baseAOnly.passages[0]!.fusedScore);
    await expect(secondaryOnly).rejects.toThrow("knowledge_canonical_source_candidate_conflict");
    expect(combined.canonicalSourceProvenance).toEqual([{
      artifactId: "artifact-x",
      bindings: [
        { baseName: "Base A", bindingOrdinal: 0, knowledgeBaseId: "base-a" },
        { baseName: "Base B", bindingOrdinal: 1, knowledgeBaseId: "base-b" }
      ],
      primaryBindingOrdinal: 0,
      sourceId: "source-x",
      sourceVersionId: "version-x"
    }]);
  });

  it("keeps same-name evidence separate when Source versions and artifacts differ", async () => {
    const result = await execute(mockClient([
      scope(0, "Base A", "base-a"),
      scope(1, "Base B", "base-b")
    ], [
      row({
        artifactId: "artifact-v1",
        baseName: "Base A",
        bindingOrdinal: 0,
        chunkId: "chunk-v1",
        contentHash: "a".repeat(64),
        knowledgeBaseId: "base-a",
        sourceId: "source-shared",
        sourceVersionId: "version-1",
        text: "Version one evidence."
      }),
      row({
        artifactId: "artifact-v2",
        baseName: "Base B",
        bindingOrdinal: 1,
        chunkId: "chunk-v2",
        contentHash: "b".repeat(64),
        knowledgeBaseId: "base-b",
        sourceId: "source-shared",
        sourceVersionId: "version-2",
        text: "Version two evidence.",
        versionNumber: 2
      })
    ]));

    expect(result.candidateCount).toBe(2);
    expect(result.passages.map((passage) => passage.chunkId).sort()).toEqual([
      "chunk-v1",
      "chunk-v2"
    ]);
    expect(result.canonicalSourceProvenance.map((entry) => entry.sourceVersionId)).toEqual([
      "version-1",
      "version-2"
    ]);
  });

  it("propagates typed row context and limits neighbor SQL to the same structural identity", async () => {
    const documentContext = createKnowledgeTableDocumentContext({
      blockId: "block-results",
      cells: [{ columnEnd: 0, columnStart: 0, text: "5.4" }],
      headerLineage: [{
        columnEnd: 0,
        columnStart: 0,
        rowIndex: 0,
        text: "Actual"
      }],
      rowIndex: 1
    });
    const client = mockClient([scope(0, "Lab", "base-lab")], [row({
      artifactId: "artifact-lab",
      baseName: "Lab",
      bindingOrdinal: 0,
      chunkId: "chunk-lab-row",
      documentContext,
      knowledgeBaseId: "base-lab",
      layoutKind: "table_row",
      sourceId: "source-lab",
      sourceVersionId: "version-lab"
    })]);

    const result = await execute(client);

    expect(result.passages[0]!.documentContext).toEqual(documentContext);
    expect(result.passages[0]!.layoutKind).toBe("table_row");
    expect(client.$queryRaw).toHaveBeenCalledOnce();
    const neighborSql = sqlText(client.$queryRaw.mock.calls[0]![0]);
    // One generic language-neutral lexical configuration only (FR-9).
    expect(neighborSql).toContain("websearch_to_tsquery('simple'::regconfig");
    expect(neighborSql).not.toContain("'english'::regconfig");
    expect(neighborSql).not.toContain("'russian'::regconfig");
    expect(neighborSql).toContain("<=>");
    expect(neighborSql).toContain(`60.0 + candidate."laneRank"`);
    expect(neighborSql).toContain(
      `source."documentContext" IS NULL AND neighbor."documentContext" IS NULL`
    );
    expect(neighborSql).toContain(
      `neighbor."documentContext"->'locator'->>'rowId' =`
    );
    expect(neighborSql).toContain(
      `neighbor."documentContext"->'locator'->>'blockId' =`
    );
    expect(neighborSql).toContain(
      `(neighbor."documentContext"->'locator'->>'rowIndex')::integer`
    );
    expect(neighborSql).toContain("BETWEEN 1 AND");
    expect(neighborSql).toContain(
      `neighbor."documentContext"->'locator'->>'fieldGroupId' =`
    );
    expect(neighborSql).toContain('FROM ranked_neighbor_candidates AS neighbor');
    expect(neighborSql).toContain('WHERE neighbor."laneRank" <=');
    expect((client.$queryRaw.mock.calls[0]![0] as { values: readonly unknown[] }).values)
      .toContain(KNOWLEDGE_SIGNAL_RANK_MAX);
  });

  it("accepts only neighbor provenance inside the shared bounded rank window", async () => {
    const common = {
      artifactId: "artifact-rank-bound",
      baseName: "Policies",
      bindingOrdinal: 0,
      chunkId: "chunk-rank-bound",
      knowledgeBaseId: "base-policies",
      lane: "neighbor" as const,
      sourceId: "source-policy",
      sourceVersionId: "version-policy"
    };

    await expect(execute(mockClient([scope(0, "Policies", "base-policies")], [row({
      ...common,
      laneRank: KNOWLEDGE_SIGNAL_RANK_MAX
    })]))).resolves.toMatchObject({ candidateCount: 0, passages: [] });
    await expect(execute(mockClient([scope(0, "Policies", "base-policies")], [row({
      ...common,
      laneRank: KNOWLEDGE_SIGNAL_RANK_MAX + 1
    })]))).rejects.toThrow("knowledge_retrieval_candidate_invalid");
  });

  it("attaches bounded same-Source neighbors as context without promoting them to primaries", async () => {
    const common = {
      artifactId: "artifact-neighbors",
      baseName: "Policies",
      bindingOrdinal: 0,
      knowledgeBaseId: "base-policies",
      sourceId: "source-policies",
      sourceVersionId: "version-policies"
    } as const;
    const result = await execute(mockClient([scope(0, "Policies", "base-policies")], [
      row({
        ...common,
        chunkId: "chunk-primary",
        chunkIndex: 4,
        contentHash: "1".repeat(64),
        text: "Primary evidence."
      }),
      row({
        ...common,
        chunkId: "chunk-previous",
        chunkIndex: 3,
        contentHash: "2".repeat(64),
        lane: "neighbor",
        text: "Previous context."
      }),
      row({
        ...common,
        chunkId: "chunk-next",
        chunkIndex: 5,
        contentHash: "3".repeat(64),
        lane: "neighbor",
        text: "Next context."
      }),
      row({
        ...common,
        artifactId: "artifact-other",
        chunkId: "chunk-other-source",
        chunkIndex: 5,
        contentHash: "4".repeat(64),
        lane: "neighbor",
        sourceId: "source-other",
        sourceVersionId: "version-other",
        text: "Must not leak."
      })
    ]));

    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]).toMatchObject({
      chunkId: "chunk-primary",
      expandedContext: [
        "Previous same-Source context:\nPrevious context.",
        "Next same-Source context:\nNext context."
      ].join("\n\n")
    });
    expect(result.passages[0]?.expandedContext).not.toContain("Must not leak");
  });

  it("keeps independently selected table rows out of another primary's context", async () => {
    const common = {
      artifactId: "artifact-table",
      baseName: "Metrics",
      bindingOrdinal: 0,
      knowledgeBaseId: "base-metrics",
      layoutKind: "table_row" as const,
      sourceId: "source-metrics",
      sourceVersionId: "version-metrics"
    };
    const tableContext = (blockId: string, rowIndex: number) =>
      createKnowledgeTableDocumentContext({
        blockId,
        cells: [{ columnEnd: 1, columnStart: 0, text: `row-${rowIndex}` }],
        headerLineage: [],
        rowIndex
      });
    const result = await execute(mockClient([scope(0, "Metrics", "base-metrics")], [
      row({
        ...common,
        chunkId: "row-4",
        chunkIndex: 4,
        contentHash: "f".repeat(64),
        documentContext: tableContext("table-a", 4),
        lane: "exact",
        text: "Primary row."
      }),
      ...[0, 1, 2, 3, 5, 6, 7, 8, 9].map((rowIndex) => row({
        ...common,
        chunkId: `row-${rowIndex}`,
        chunkIndex: rowIndex,
        contentHash: String(rowIndex).repeat(64),
        documentContext: tableContext("table-a", rowIndex),
        lane: rowIndex === 6 ? "passage_bm25" : "neighbor",
        laneRank: rowIndex === 6 ? 40 : 1,
        text: `Complete row ${rowIndex}.`
      })),
      row({
        ...common,
        chunkId: "other-table-row",
        chunkIndex: 3,
        contentHash: "a".repeat(64),
        documentContext: tableContext("table-b", 3),
        lane: "neighbor",
        text: "Other table must not leak."
      })
    ]));

    expect(result.passages).toHaveLength(2);
    const primary = result.passages.find((passage) => passage.chunkId === "row-4");
    expect(primary?.expandedContext).toBe([
      "Previous complete row in the same table:\nComplete row 0.",
      "Previous complete row in the same table:\nComplete row 1.",
      "Previous complete row in the same table:\nComplete row 2.",
      "Previous complete row in the same table:\nComplete row 3.",
      "Next complete row in the same table:\nComplete row 5.",
      "Next complete row in the same table:\nComplete row 7.",
      "Next complete row in the same table:\nComplete row 8."
    ].join("\n\n"));
    expect(primary?.expandedContext).not.toContain("Complete row 6");
    expect(result.passages.find((passage) => passage.chunkId === "row-6")?.text)
      .toBe("Complete row 6.");
    expect(primary?.expandedContext).not.toContain("Complete row 9");
    expect(primary?.expandedContext).not.toContain("Other table must not leak");
  });

  it("supplements a selected table Source with independently eligible rows below the global pool", async () => {
    const targetContext = createKnowledgeTableDocumentContext({
      blockId: "table-a",
      cells: [{ columnEnd: 1, columnStart: 0, text: "Target A" }],
      headerLineage: [],
      rowIndex: 1
    });
    const supplementalContext = createKnowledgeTableDocumentContext({
      blockId: "table-b",
      cells: [{ columnEnd: 1, columnStart: 0, text: "Target B" }],
      headerLineage: [],
      rowIndex: 0
    });
    const target = {
      artifactId: "artifact-target",
      baseName: "Metrics",
      bindingOrdinal: 0,
      knowledgeBaseId: "base-metrics",
      layoutKind: "table_row" as const,
      sourceId: "source-target",
      sourceVersionId: "version-target"
    };
    const result = await execute(mockClient([scope(0, "Metrics", "base-metrics")], [
      row({
        ...target,
        chunkId: "target-primary",
        contentHash: "d".repeat(64),
        documentContext: targetContext,
        lane: "exact",
        laneRank: 1,
        text: "Primary matching row."
      }),
      ...Array.from({ length: 64 }, (_, index) => row({
        artifactId: `artifact-distractor-${index}`,
        baseName: "Metrics",
        bindingOrdinal: 0,
        chunkId: `distractor-${index}`,
        contentHash: index.toString(16).padStart(64, "0"),
        knowledgeBaseId: "base-metrics",
        lane: "exact",
        laneRank: index + 2,
        sourceId: `source-distractor-${index}`,
        sourceVersionId: `version-distractor-${index}`
      })),
      row({
        ...target,
        chunkId: "target-supplemental",
        chunkIndex: 10,
        contentHash: "e".repeat(64),
        documentContext: supplementalContext,
        laneRank: 66,
        rawScore: 0.11,
        text: "Independently matching complete row."
      })
    ]));

    expect(result.candidateCount).toBe(64);
    expect(result.rankingEvidence.candidateOrder).not.toContain("target-supplemental");
    expect(result.passages.find((passage) => passage.chunkId === "target-primary"))
      .toMatchObject({
        expandedContext: [
          "Additional independently matched complete row from the same Source:",
          "Independently matching complete row."
        ].join("\n")
      });
  });

  it("caps the canonical RRF pool at the profile lane limit inside the one focused operation", async () => {
    const acceptedScope = scope(0, "Lab", "base-lab");
    const rows = Array.from({ length: 70 }, (_, index) => row({
      artifactId: `artifact-${index}`,
      baseName: "Lab",
      bindingOrdinal: 0,
      chunkId: `chunk-${index}`,
      contentHash: index.toString(16).padStart(64, "0"),
      knowledgeBaseId: "base-lab",
      laneRank: index + 1,
      sourceId: `source-${index}`,
      sourceVersionId: `version-${index}`
    }));
    const client = mockClient([acceptedScope], rows);

    const result = await execute(client);

    expect(client.$queryRaw).toHaveBeenCalledOnce();
    expect(result.candidateCount).toBe(64);
    expect(result.candidateCounts).toEqual({ 0: 64 });
    expect(result.passages).toHaveLength(8);
  });

  it("fails closed when a retrieval row carries malformed document context", async () => {
    const documentContext = createKnowledgeTableDocumentContext({
      blockId: "block-results",
      cells: [{ columnEnd: 0, columnStart: 0, text: "5.4" }],
      headerLineage: [],
      rowIndex: 1
    });

    await expect(execute(mockClient([scope(0, "Lab", "base-lab")], [row({
      artifactId: "artifact-lab",
      baseName: "Lab",
      bindingOrdinal: 0,
      chunkId: "chunk-malformed",
      documentContext: { ...documentContext, unexpected: true },
      knowledgeBaseId: "base-lab",
      sourceId: "source-lab",
      sourceVersionId: "version-lab"
    })]))).rejects.toThrow("knowledge_retrieval_candidate_invalid");
  });
});
