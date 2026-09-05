import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeParentContextError,
  type KnowledgeParentContextRow
} from "./parentContextExpansion";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { createPrismaKnowledgeParentContextLoader } from "./prismaRetrievalRepository";
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
  chunkId: string;
  chunkIndex?: number;
  contentHash: string;
  lane?: KnowledgeRetrievalLane;
  laneRank?: number;
  sectionId?: string | null;
  text?: string;
}>) {
  return {
    baseName: "Base",
    bindingOrdinal: 0,
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex ?? 0,
    contributingBindingOrdinals: [0],
    contentHash: input.contentHash,
    documentId: "source-1",
    documentContext: null,
    documentVersionId: "version-1",
    documentVersionNumber: 1,
    exactKind: null,
    fileName: "shared-name.txt",
    headingPath: ["Policy"],
    knowledgeBaseId: "base-1",
    lane: input.lane ?? "passage_bm25",
    laneRank: input.laneRank ?? 1,
    layoutKind: "body",
    page: 1,
    rawScore: 1,
    sectionId: input.sectionId === undefined ? "section-1" : input.sectionId,
    sourceArtifactId: "artifact-1",
    sourceName: "Shared name",
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
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([...scopes])
      .mockResolvedValueOnce([{ candidates: [...rows], scopes: [...scopes] }]),
    vectors
  } as unknown as MockCoreClient;
}

async function execute(
  client: MockCoreClient,
  overrides: Partial<Parameters<typeof executeKnowledgeRetrievalCore>[1]> = {}
) {
  return executeKnowledgeRetrievalCore(client, {
    candidateLimit: 64,
    excludedOccurrenceKeys: [],
    query: "canonical source evidence",
    resultLimit: 8,
    runId: "run-1",
    userId: "user-1",
    vectors: client.vectors,
    ...overrides
  });
}

function windowRow(input: Readonly<{
  contentHash: string;
  id: string;
  ordinal: number;
  text: string;
}>): KnowledgeParentContextRow {
  return {
    contentHash: input.contentHash,
    documentContext: null,
    id: input.id,
    layoutKind: "body",
    ordinal: input.ordinal,
    page: 1,
    sectionId: "section-1",
    text: input.text
  };
}

describe("retrieval core child-to-parent context expansion", () => {
  it("expands a body hit with its canonical-section window after final selection", async () => {
    const client = mockClient([scope(0, "Base", "base-1")], [row({
      chunkId: "chunk-10",
      chunkIndex: 10,
      contentHash: "0".repeat(64),
      text: "Atomic passage."
    })]);
    const loader = vi.fn(async () => new Map([["chunk-10", [
      windowRow({ contentHash: "8".repeat(64), id: "chunk-8", ordinal: 8, text: "Earlier." }),
      windowRow({ contentHash: "9".repeat(64), id: "chunk-9", ordinal: 9, text: "Before." }),
      windowRow({
        contentHash: "0".repeat(64),
        id: "chunk-10",
        ordinal: 10,
        text: "Atomic passage."
      }),
      windowRow({ contentHash: "1".repeat(64), id: "chunk-11", ordinal: 11, text: "After." })
    ]]]));

    const result = await execute(client, { parentContextLoader: loader });

    expect(loader).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
      chunkId: "chunk-10",
      chunkIndex: 10,
      documentVersionId: "version-1",
      fromOrdinal: 2,
      sectionId: "section-1",
      sourceArtifactId: "artifact-1",
      toOrdinal: 18
    })]);
    const passage = result.passages[0]!;
    expect(passage.expandedContext).toBe([
      "Previous same-Source context:\nEarlier.\nBefore.",
      "Next same-Source context:\nAfter."
    ].join("\n\n"));
    expect(passage.expansion).toMatchObject({ state: "expanded" });
    expect(passage.expansion!.units).toHaveLength(3);
    // The citation keeps pointing at the atomic passage and its canonical
    // locator: identity, locator, and Source Version fields are untouched.
    expect(passage).toMatchObject({
      chunkId: "chunk-10",
      chunkIndex: 10,
      documentId: "source-1",
      documentVersionId: "version-1",
      documentVersionNumber: 1,
      page: 1,
      sectionId: "section-1",
      text: "Atomic passage."
    });
  });

  it("never double-ships text owned by the pre-existing neighbor lane", async () => {
    const client = mockClient([scope(0, "Base", "base-1")], [
      row({
        chunkId: "chunk-10",
        chunkIndex: 10,
        contentHash: "0".repeat(64),
        text: "Atomic passage."
      }),
      row({
        chunkId: "chunk-11",
        chunkIndex: 11,
        contentHash: "1".repeat(64),
        lane: "neighbor",
        text: "After."
      })
    ]);
    const loader = vi.fn(async () => new Map([["chunk-10", [
      windowRow({
        contentHash: "0".repeat(64),
        id: "chunk-10",
        ordinal: 10,
        text: "Atomic passage."
      }),
      windowRow({ contentHash: "1".repeat(64), id: "chunk-11", ordinal: 11, text: "After." })
    ]]]));

    const result = await execute(client, { parentContextLoader: loader });

    const passage = result.passages[0]!;
    const occurrences = passage.expandedContext!.split("After.").length - 1;
    expect(occurrences).toBe(1);
    expect(passage.expansion!.units).toHaveLength(1);
  });

  it("degrades to atomic evidence plus the candidate-pool fallback on a classified load failure", async () => {
    const client = mockClient([scope(0, "Base", "base-1")], [
      row({
        chunkId: "chunk-10",
        chunkIndex: 10,
        contentHash: "0".repeat(64),
        text: "Atomic passage."
      }),
      row({
        chunkId: "chunk-11",
        chunkIndex: 11,
        contentHash: "1".repeat(64),
        lane: "neighbor",
        text: "Neighbor."
      })
    ]);
    const loader = vi.fn(async () => {
      throw new KnowledgeParentContextError("parent_context_load_failed");
    });

    const result = await execute(client, { parentContextLoader: loader });

    const passage = result.passages[0]!;
    expect(passage.text).toBe("Atomic passage.");
    expect(passage.expandedContext).toBe("Next same-Source context:\nNeighbor.");
    expect(passage.expansion).toMatchObject({
      reason: "parent_context_load_failed",
      state: "degraded"
    });
  });

  it("propagates unclassified loader failures instead of masking them", async () => {
    const client = mockClient([scope(0, "Base", "base-1")], [row({
      chunkId: "chunk-10",
      chunkIndex: 10,
      contentHash: "0".repeat(64)
    })]);
    const loader = vi.fn(async () => {
      throw new Error("database_connection_lost");
    });

    await expect(execute(client, { parentContextLoader: loader }))
      .rejects.toThrow("database_connection_lost");
  });

  it("keeps production parent-window database failures unclassified", async () => {
    const failure = new Error("database_connection_lost");
    const loader = createPrismaKnowledgeParentContextLoader({
      knowledgeArtifactPassageIndex: { findMany: vi.fn() },
      knowledgeSourceIndexArtifact: {
        findMany: vi.fn().mockRejectedValue(failure)
      }
    } as never);

    await expect(loader([{
      chunkId: "chunk-10",
      chunkIndex: 10,
      documentVersionId: "version-1",
      fromOrdinal: 2,
      sectionId: "section-1",
      sourceArtifactId: "artifact-1",
      toOrdinal: 18
    }])).rejects.toBe(failure);
  });

  it("marks legacy rows without a canonical section and skips the window read", async () => {
    const client = mockClient([scope(0, "Base", "base-1")], [row({
      chunkId: "chunk-10",
      chunkIndex: 10,
      contentHash: "0".repeat(64),
      sectionId: null
    })]);
    const loader = vi.fn(async () => new Map<string, KnowledgeParentContextRow[]>());

    const result = await execute(client, { parentContextLoader: loader });

    expect(loader).not.toHaveBeenCalled();
    expect(result.passages[0]!.expansion).toMatchObject({ state: "legacy" });
  });

  it("keeps the exact legacy path when no parent-context loader is configured", async () => {
    const client = mockClient([scope(0, "Base", "base-1")], [
      row({
        chunkId: "chunk-10",
        chunkIndex: 10,
        contentHash: "0".repeat(64)
      }),
      row({
        chunkId: "chunk-11",
        chunkIndex: 11,
        contentHash: "1".repeat(64),
        lane: "neighbor",
        text: "Neighbor."
      })
    ]);

    const result = await execute(client);

    const passage = result.passages[0]!;
    expect(passage.expansion).toBeUndefined();
    expect(passage.expandedContext).toBe("Next same-Source context:\nNeighbor.");
  });
});
