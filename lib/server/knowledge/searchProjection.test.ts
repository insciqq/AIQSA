import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  knowledgeSearchProjectionFingerprint
} from "../search/opensearch/contract";
import {
  OpenSearchTransportError,
  type AiqsaOpenSearchTransport
} from "../search/opensearch/transport";
import {
  inspectKnowledgeSearchIntegrity,
  rebuildKnowledgeSearchProjections,
  resetKnowledgeSearchProjections,
  runKnowledgeSearchProjectionPass
} from "./searchProjection";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { knowledgeLexicalBackendEvidenceFixture } from "./searchRetrieval.testFixtures";

const checksum = "a".repeat(64);
const projectionFingerprint = knowledgeSearchProjectionFingerprint({
  hierarchicalChecksum: checksum,
  indexArtifactId: "hierarchy-1",
  passageCount: 1
});

type SearchProjectionRecord = Readonly<{
  backendKind: string;
  expectedPassageCount: number;
  indexedPassageCount: number;
  indexArtifactId: string;
  mappingVersion: number;
  projectionFingerprint: string;
  state: string;
}>;

function clientFixture() {
  const knowledgeSearchProjection = {
    createMany: vi.fn(async () => ({ count: 1 })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => [] as SearchProjectionRecord[]),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 }))
  };
  const hierarchy = {
    checksum,
    id: "hierarchy-1",
    passageCount: 1,
    passageIndexes: [{
      contentHash: "b".repeat(64),
      contextPrefix: "",
      documentContext: null,
      headingPath: ["Annual report"],
      id: "passage-1",
      layoutKind: "body",
      text: "Canonical PostgreSQL passage."
    }],
    sourceArtifact: {
      sourceVersion: {
        id: "source-version-1",
        ownerUserId: "owner-1",
        source: { deletionRequestedAt: null, trashedAt: null }
      },
      state: "ready"
    },
    state: "ready"
  } as const;
  const knowledgeHierarchicalIndexArtifact = {
    findMany: vi.fn(async (input?: { where?: { id?: unknown } }) =>
      input?.where?.id
        ? [hierarchy]
        : [{
            checksum,
            id: "hierarchy-1",
            passageCount: 1,
            sourceArtifactId: "source-artifact-1"
          }]),
    findUnique: vi.fn(async () => hierarchy)
  };
  const queryRaw = vi.fn(async () => [{
    attemptCount: 1,
    expectedPassageCount: 1,
    id: "projection-1",
    indexArtifactId: "hierarchy-1",
    projectionFingerprint
  }]);
  const client = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: queryRaw,
    knowledgeHierarchicalIndexArtifact,
    knowledgeSearchProjection
  } as unknown as PrismaClient;
  return {
    client,
    knowledgeHierarchicalIndexArtifact,
    knowledgeSearchProjection,
    queryRaw
  };
}

function searchFixture(overrides: Readonly<{
  bulkFailure?: Error;
}> = {}) {
  const mocks = {
    bulkUpsertKnowledgeDocuments: overrides.bulkFailure
      ? vi.fn(async () => { throw overrides.bulkFailure; })
      : vi.fn(async () => undefined),
    countKnowledgeArtifact: vi.fn(async () => 1),
    countKnowledgeArtifacts: vi.fn(async () => ([{
      count: 1,
      indexArtifactId: "hierarchy-1"
    }])),
    deleteKnowledgeArtifact: vi.fn(async () => undefined),
    ensureKnowledgeIndex: vi.fn(async () => undefined),
    inspectKnowledgeIndex: vi.fn(async () => ({
      artifactCounts: [{ count: 1, indexArtifactId: "hierarchy-1" }],
      currentMappingDocumentCount: 1,
      staleMappingDocumentCount: 0
    })),
    recreateKnowledgeIndex: vi.fn(async () => undefined),
    refreshKnowledgeIndex: vi.fn(async () => undefined)
  };
  return {
    mocks,
    search: mocks as unknown as AiqsaOpenSearchTransport
  };
}

describe("Knowledge OpenSearch projection lifecycle", () => {
  it("repairs the same failed projection, permits search only after READY, and does not claim it twice", async () => {
    const fixture = clientFixture();
    const { mocks, search } = searchFixture();
    let state = "FAILED";
    fixture.knowledgeSearchProjection.findMany.mockImplementation(async () => [{
      backendKind: "opensearch_bm25_v1", expectedPassageCount: 1, indexedPassageCount: state === "READY" ? 1 : 0,
      indexArtifactId: "hierarchy-1", mappingVersion: 1, projectionFingerprint, state
    }]);
    fixture.queryRaw.mockImplementation(async () => {
      if (state !== "PENDING") return [];
      state = "BUILDING";
      return [{ attemptCount: 1, expectedPassageCount: 1, id: "projection-1", indexArtifactId: "hierarchy-1", projectionFingerprint }];
    });
    fixture.knowledgeSearchProjection.updateMany.mockImplementation(async (value?: unknown) => {
      const update = value as { data: { state: string }; where: { state?: string; projectionFingerprint?: string } };
      if (update.where.state && update.where.state !== state ||
        update.where.projectionFingerprint && update.where.projectionFingerprint !== projectionFingerprint) return { count: 0 };
      state = update.data.state;
      return { count: 1 };
    });
    const lexicalSearch = vi.fn(async () => ({ evidence: knowledgeLexicalBackendEvidenceFixture(), hits: [] }));
    const retrieve = () => {
      const scopes = [{ acceptedIndexArtifactIds: ["hierarchy-1"], baseName: "Synthetic Base", bindingOrdinal: 0,
        eligibleRows: 1, indexGenerationId: "generation-1", knowledgeBaseId: "base-1", projectionComplete: state === "READY", targetDimension: 1_024 }];
      const client = { $queryRaw: vi.fn().mockResolvedValueOnce(scopes).mockResolvedValueOnce([{ candidates: [], scopes }]) };
      return executeKnowledgeRetrievalCore(client, { candidateLimit: 64, excludedOccurrenceKeys: [], lexicalSearch,
        query: "synthetic fact", resultLimit: 8, runId: "run-1", userId: "owner-1", vectors: [] });
    };
    await expect(retrieve()).rejects.toThrow("knowledge_search_projection_incomplete");
    expect(lexicalSearch).not.toHaveBeenCalled();
    await resetKnowledgeSearchProjections(fixture.client);
    expect(state).toBe("PENDING");
    await expect(retrieve()).rejects.toThrow("knowledge_search_projection_incomplete");
    await expect(runKnowledgeSearchProjectionPass({ client: fixture.client, search })).resolves.toEqual({
      claimed: 1, failed: 0, projected: 1, seeded: 0
    });
    expect(state).toBe("READY");
    await expect(retrieve()).resolves.toMatchObject({ lexicalBackendEvidence: { status: "complete" } });
    await expect(runKnowledgeSearchProjectionPass({ client: fixture.client, search })).resolves.toEqual({
      claimed: 0, failed: 0, projected: 0, seeded: 0
    });
    expect(mocks.bulkUpsertKnowledgeDocuments).toHaveBeenCalledOnce();
    expect(mocks.bulkUpsertKnowledgeDocuments.mock.calls[0]).toEqual([[expect.objectContaining({
      indexArtifactId: "hierarchy-1", sourceVersionId: "source-version-1", ownerUserId: "owner-1"
    })]]);
  });

  it("rejects a changed canonical fingerprint before index mutation", async () => {
    const fixture = clientFixture();
    const hierarchy = await fixture.knowledgeHierarchicalIndexArtifact.findUnique();
    fixture.knowledgeHierarchicalIndexArtifact.findUnique.mockResolvedValue({ ...hierarchy, checksum: "c".repeat(64) });
    const { mocks, search } = searchFixture();
    await expect(runKnowledgeSearchProjectionPass({ client: fixture.client, search })).resolves.toMatchObject({ failed: 1, projected: 0 });
    expect(mocks.deleteKnowledgeArtifact).not.toHaveBeenCalled();
    expect(mocks.bulkUpsertKnowledgeDocuments).not.toHaveBeenCalled();
    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastErrorCode: "knowledge_search_projection_source_invalid", state: "RETRY_WAIT" })
    }));
  });

  it("does not store code-shaped private error messages as projection reasons", async () => {
    const fixture = clientFixture();
    const { search } = searchFixture({ bulkFailure: new Error("private_secret_value") });
    await runKnowledgeSearchProjectionPass({ client: fixture.client, search });
    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastErrorCode: "knowledge_search_projection_failed" })
    }));
  });

  it("projects only canonical PostgreSQL passages and settles exact count", async () => {
    const { client, knowledgeSearchProjection } = clientFixture();
    const { mocks, search } = searchFixture();

    await expect(runKnowledgeSearchProjectionPass({ client, limit: 1, search }))
      .resolves.toEqual({ claimed: 1, failed: 0, projected: 1, seeded: 1 });

    expect(mocks.ensureKnowledgeIndex).toHaveBeenCalledOnce();
    expect(mocks.deleteKnowledgeArtifact).toHaveBeenCalledWith("hierarchy-1");
    expect(mocks.bulkUpsertKnowledgeDocuments).toHaveBeenCalledWith([{
      body: "Canonical PostgreSQL passage.",
      contentHash: "b".repeat(64),
      heading: "Annual report",
      indexArtifactId: "hierarchy-1",
      layoutKind: "body",
      ownerUserId: "owner-1",
      passageId: "passage-1",
      sourceVersionId: "source-version-1",
      tableContext: ""
    }]);
    expect(mocks.deleteKnowledgeArtifact.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.bulkUpsertKnowledgeDocuments.mock.invocationCallOrder[0]!);
    expect(mocks.refreshKnowledgeIndex).toHaveBeenCalledOnce();
    expect(mocks.countKnowledgeArtifact).toHaveBeenCalledWith("hierarchy-1");
    expect(knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ indexedPassageCount: 1, state: "READY" }),
        where: expect.objectContaining({
          id: "projection-1",
          projectionFingerprint,
          state: "BUILDING"
        })
      })
    );
  });

  it("persists a classified retry instead of pretending a partial projection is ready", async () => {
    const { client, knowledgeSearchProjection } = clientFixture();
    const { mocks, search } = searchFixture({
      bulkFailure: new OpenSearchTransportError("opensearch_bulk_item_failed")
    });

    await expect(runKnowledgeSearchProjectionPass({ client, limit: 1, search }))
      .resolves.toEqual({ claimed: 1, failed: 1, projected: 0, seeded: 1 });

    expect(mocks.refreshKnowledgeIndex).not.toHaveBeenCalled();
    expect(knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: "opensearch_bulk_item_failed",
          state: "RETRY_WAIT"
        }),
        where: expect.objectContaining({ id: "projection-1", state: "BUILDING" })
      })
    );
  });

  it("resets READY and terminal rows only through the explicit rebuild command boundary", async () => {
    const { client, knowledgeSearchProjection } = clientFixture();
    const now = new Date("2026-08-29T12:00:00.000Z");

    await expect(resetKnowledgeSearchProjections(client, now)).resolves.toEqual({
      removed: 0,
      reset: 1
    });

    expect(knowledgeSearchProjection.deleteMany).not.toHaveBeenCalled();
    expect(knowledgeSearchProjection.updateMany).toHaveBeenCalledWith({
      data: {
        attemptCount: 0,
        claimToken: null,
        indexedPassageCount: 0,
        lastErrorCode: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        readyAt: null,
        startedAt: null,
        state: "PENDING"
      },
      where: { indexArtifactId: { in: ["hierarchy-1"] } }
    });
  });

  it("rebuilds a fresh index with one refresh and aggregate settlement per claim batch", async () => {
    const { client, queryRaw } = clientFixture();
    queryRaw
      .mockResolvedValueOnce([{
        attemptCount: 1,
        expectedPassageCount: 1,
        id: "projection-1",
        indexArtifactId: "hierarchy-1",
        projectionFingerprint
      }])
      .mockResolvedValueOnce([]);
    const { mocks, search } = searchFixture();

    await expect(rebuildKnowledgeSearchProjections({ client, search })).resolves.toEqual({
      claimed: 1,
      failed: 0,
      projected: 1,
      removed: 0,
      reset: 1,
      seeded: 1
    });

    expect(mocks.recreateKnowledgeIndex).toHaveBeenCalledOnce();
    expect(mocks.deleteKnowledgeArtifact).not.toHaveBeenCalled();
    expect(mocks.bulkUpsertKnowledgeDocuments).toHaveBeenCalledOnce();
    expect(mocks.refreshKnowledgeIndex).toHaveBeenCalledOnce();
    expect(mocks.countKnowledgeArtifacts).toHaveBeenCalledWith(["hierarchy-1"]);
  });

  it("reports only content-free aggregate integrity facts", async () => {
    const { client, knowledgeSearchProjection } = clientFixture();
    knowledgeSearchProjection.findMany.mockResolvedValueOnce([{
      backendKind: "opensearch_bm25_v1",
      expectedPassageCount: 1,
      indexedPassageCount: 1,
      indexArtifactId: "hierarchy-1",
      mappingVersion: 1,
      projectionFingerprint,
      state: "READY"
    }]);
    const { search } = searchFixture();

    await expect(inspectKnowledgeSearchIntegrity({ client, search })).resolves.toEqual({
      currentMappingDocumentCount: 1,
      expectedArtifactCount: 1,
      expectedPassageCount: 1,
      healthy: true,
      incompleteProjectionCount: 0,
      missingProjectionCount: 0,
      orphanDocumentCount: 0,
      projectionCountMismatchCount: 0,
      projectionFingerprintMismatchCount: 0,
      readyProjectionCount: 1,
      staleMappingDocumentCount: 0,
      staleProjectionCount: 0,
      totalProjectionCount: 1,
      version: 1
    });
  });
});
