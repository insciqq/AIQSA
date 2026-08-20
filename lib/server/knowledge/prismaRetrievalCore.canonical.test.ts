import { describe, expect, it, vi } from "vitest";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import type {
  KnowledgeCandidateReranker,
  KnowledgeRetrievalLane
} from "./retrievalRanking";

type CoreClient = Parameters<typeof executeKnowledgeRetrievalCore>[0];
type MockCoreClient = CoreClient & Readonly<{
  $queryRaw: ReturnType<typeof vi.fn>;
}>;

const reranker: KnowledgeCandidateReranker = {
  async rerank(input) {
    return input.candidates.map((candidate) => ({ chunkId: candidate.chunkId, score: 0.9 }));
  }
};

function scope(bindingOrdinal: number, baseName: string, knowledgeBaseId: string) {
  return {
    baseName,
    bindingOrdinal,
    eligibleRows: 0,
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
    chunkIndex: 0,
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
  const responses = [[...scopes], [...rows], []] as unknown[][];
  return {
    $queryRaw: vi.fn(async () => responses.shift() ?? []),
    $transaction: vi.fn()
  } as unknown as MockCoreClient;
}

function sqlText(value: unknown): string {
  return (value as { strings: readonly string[] }).strings.join("?");
}

async function execute(client: CoreClient) {
  return executeKnowledgeRetrievalCore(client, {
    candidateLimit: 40,
    query: "canonical source evidence",
    reranker,
    resultLimit: 8,
    runId: "run-1",
    scoreThreshold: 0.01,
    userId: "user-1",
    vectors: []
  });
}

describe("Prisma retrieval core canonical Source identity", () => {
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
    expect(client.$queryRaw).toHaveBeenCalledTimes(3);
    const neighborSql = sqlText(client.$queryRaw.mock.calls[2]![0]);
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
