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
