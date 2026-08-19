import { describe, expect, it, vi } from "vitest";
import type { KnowledgeAcceptedBinding } from "./retrievalTypes";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";

const binding = {
  baseContentRevision: 1,
  baseName: "Reports",
  embeddingConnectionId: "connection-1",
  embeddingCredentialId: "credential-1",
  embeddingCredentialSource: "default",
  embeddingCredentialVersionId: "credential-version-1",
  embeddingExecutionSnapshot: {},
  embeddingProviderModelId: "embedding-1",
  includeWholeBase: true,
  indexedContentRevision: 1,
  indexGenerationId: "generation-1",
  knowledgeBaseId: "base-1",
  knowledgeBaseSnapshotId: "snapshot-1",
  ordinal: 0,
  selectedSourceIds: [],
  targetDimension: 1024,
  vectorSpaceFingerprint: "a".repeat(64)
} satisfies KnowledgeAcceptedBinding;

function client(input: Readonly<{
  anchor?: { ordinal: number; page: number } | null;
  evidenceItem?: { page: number; passageId: string } | null;
}> = {}) {
  const passageFindFirst = vi.fn(async () => input.anchor === undefined
    ? { ordinal: 4, page: 7 }
    : input.anchor);
  const passageFindMany = vi.fn(async () => input.anchor === null ? [] : [{
    contentHash: "b".repeat(64),
    contextPrefix: "Evidence layout: table_row_v1\nSource: report.pdf",
    headingPath: ["Results"],
    id: "passage-4",
    ordinal: 4,
    page: 7,
    sectionId: "section-1",
    sourceName: "Dated report",
    text: "Metric\t35.4"
  }]);
  return {
    knowledgeArtifactPassageIndex: {
      findFirst: passageFindFirst,
      findMany: passageFindMany
    },
    knowledgeEvidenceItem: { findFirst: vi.fn(async () => input.evidenceItem ?? null) },
    knowledgeSourceIndexArtifact: {
      findFirst: vi.fn(async () => ({
        hierarchicalIndexes: [{ id: "hierarchy-1" }],
        sourceVersion: {
          fileName: "05.03.2030-synthetic-report.pdf",
          id: "source-version-1",
          source: { name: "Dated report" },
          versionNumber: 1
        }
      }))
    },
    passageFindFirst,
    passageFindMany
  };
}

describe("Prisma Knowledge deterministic source read", () => {
  it("resolves a page inside one admitted Source and returns only a bounded neighbor window", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      direction: "around",
      locator: "page 7",
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1",
      window: 3
    });

    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        indexArtifactId: "hierarchy-1",
        page: { lte: 7 },
        pageEnd: { gte: 7 }
      })
    }));
    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 3,
      where: {
        indexArtifactId: "hierarchy-1",
        ordinal: { gte: 3, lte: 5 }
      }
    }));
    expect(result).toMatchObject({
      bindingCount: 1,
      candidateCount: 1,
      passages: [{
        documentVersionId: "source-version-1",
        layoutKind: "table_row",
        page: 7,
        sourceArtifactId: "artifact-1",
        text: "Metric\t35.4"
      }]
    });
  });

  it("returns a successful empty lookup when the exact Source location is absent", async () => {
    const mocked = client({ anchor: null });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      direction: "after",
      locator: "heading: Missing",
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1",
      window: 2
    });

    expect(result).toMatchObject({ candidateCount: 0, candidateCounts: { 0: 0 }, passages: [] });
    expect(mocked.passageFindMany).not.toHaveBeenCalled();
  });

  it("normalizes a displayed heading path but does not use a partial-heading fallback", async () => {
    const mocked = client({ anchor: null });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      direction: "around",
      locator: "heading: Lab › Results",
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1",
      window: 3
    });

    expect(mocked.passageFindFirst).toHaveBeenCalledOnce();
    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        headingText: { equals: "Lab Results", mode: "insensitive" },
        indexArtifactId: "hierarchy-1"
      }
    }));
  });

  it("binds an evidence handle to the same run and Source before reading neighbors", async () => {
    const mocked = client({ evidenceItem: { page: 7, passageId: "passage-4" } });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      direction: "before",
      locator: "K4",
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1",
      window: 2
    });

    expect(mocked.knowledgeEvidenceItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        handle: "K4",
        retrievalSession: { modelRun: { id: "run-1", userId: "user-1" } },
        sourceArtifactId: "artifact-1",
        state: "available"
      }
    }));
    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "passage-4", indexArtifactId: "hierarchy-1" }
    }));
    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { indexArtifactId: "hierarchy-1", ordinal: { gte: 3, lte: 4 } }
    }));
  });

  it("retains read-only support for a legacy evidence handle", async () => {
    const mocked = client({ evidenceItem: { page: 7, passageId: "passage-4" } });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      direction: "around",
      locator: "K4.1",
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1",
      window: 1
    });

    expect(mocked.knowledgeEvidenceItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ handle: "K4.1" })
    }));
  });

  it("fails closed for an empty heading locator", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      direction: "around",
      locator: "heading:",
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1",
      window: 3
    });

    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
    expect(mocked.passageFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a Source outside an explicitly selected binding before repository lookup", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding: { ...binding, includeWholeBase: false, selectedSourceIds: ["source-2"] },
      direction: "around",
      locator: "page 7",
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1",
      window: 3
    });

    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
    expect(mocked.knowledgeSourceIndexArtifact.findFirst).not.toHaveBeenCalled();
  });
});
