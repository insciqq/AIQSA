import { describe, expect, it, vi } from "vitest";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import type { KnowledgeRetrievalLane } from "./retrievalRanking";

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
    baseName,
    bindingOrdinal,
    eligibleRows: 1,
    indexGenerationId: `generation-${bindingOrdinal}`,
    knowledgeBaseId,
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
    lane: input.lane ?? "passage_lexical",
    laneRank: input.laneRank ?? 1,
    layoutKind: input.layoutKind ?? "body",
    page: 1,
    rawScore: 1,
    sectionId: "section-1",
    sourceArtifactId: input.artifactId,
    sourceName: input.sourceName ?? "Shared name",
    text: input.text ?? "Canonical source evidence.",
    vectorDistance: null,
    vectorMode: null
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
    candidateLimit: 40,
    query: "canonical source evidence",
    resultLimit: 8,
    runId: "run-1",
    userId: "user-1",
    vectors: client.vectors,
    ...overrides
  });
}

describe("Prisma retrieval core canonical Source identity", () => {
  it("enforces the fixed focused limits and fails closed without vector rows", async () => {
    const admitted = scope(0, "Base A", "base-a");
    const client = mockClient([admitted], []);

    await expect(execute(client, { candidateLimit: 39 })).rejects.toThrow(
      "knowledge_retrieval_request_invalid"
    );
    await expect(execute(mockClient([{ ...admitted, eligibleRows: 0 }], []))).rejects.toThrow(
      "knowledge_retrieval_vector_unavailable"
    );
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
      signals: [{ lane: "passage_lexical", rank: 6 }]
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
    expect(neighborSql).toContain("websearch_to_tsquery('simple'::regconfig");
    expect(neighborSql).toContain("websearch_to_tsquery('english'::regconfig");
    expect(neighborSql).toContain("websearch_to_tsquery('russian'::regconfig");
    expect(neighborSql).toContain("<=>");
    expect(neighborSql).toContain(`60.0 + candidate."laneRank"`);
    expect(neighborSql).toContain(
      `source."documentContext" IS NULL AND neighbor."documentContext" IS NULL`
    );
    expect(neighborSql).toContain(
      `neighbor."documentContext"->'locator'->>'rowId' =`
    );
    expect(neighborSql).toContain(
      `neighbor."documentContext"->'locator'->>'fieldGroupId' =`
    );
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

  it("caps the canonical RRF pool at forty chunks inside the one focused operation", async () => {
    const acceptedScope = scope(0, "Lab", "base-lab");
    const rows = Array.from({ length: 50 }, (_, index) => row({
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
    expect(result.candidateCount).toBe(40);
    expect(result.candidateCounts).toEqual({ 0: 40 });
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
