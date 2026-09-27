import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  knowledgeSearchProjectionFingerprint,
  type KnowledgeSearchDocument
} from "../search/opensearch/contract";
import {
  OpenSearchTransportError,
  type AiqsaOpenSearchTransport
} from "../search/opensearch/transport";
import {
  inspectKnowledgeSearchIntegrity,
  rebuildKnowledgeSearchProjections,
  resetKnowledgeSearchProjections,
  retryFailedKnowledgeSearchProjections,
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
    bulkUpsertKnowledgeDocuments: vi.fn(async (documents: readonly KnowledgeSearchDocument[]): Promise<void> => {
      if (overrides.bulkFailure) throw overrides.bulkFailure;
      expect(documents.length).toBeGreaterThan(0);
    }),
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
  afterEach(() => vi.restoreAllMocks());

  it.each(["lost", "rejected"] as const)("preserves the processing cause when retry persistence is %s", async outcome => {
    const records: Record<string, unknown>[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(line => { records.push(JSON.parse(String(line))); return true; });
    const fixture = clientFixture();
    const persistenceError = new Error("PRIVATE_DATABASE_CANARY");
    fixture.knowledgeSearchProjection.updateMany.mockImplementation(async () => {
      expect(records.at(-1)).toMatchObject({ event: "job_attempt", code: "opensearch_bulk_item_failed", outcome: "failed" });
      if (outcome === "rejected") throw persistenceError;
      return { count: 0 };
    });
    const { search } = searchFixture({ bulkFailure: new OpenSearchTransportError("opensearch_bulk_item_failed") });
    const result = runKnowledgeSearchProjectionPass({ client: fixture.client, search });
    if (outcome === "rejected") await expect(result).rejects.toBe(persistenceError);
    else await expect(result).resolves.toMatchObject({ failed: 1 });
    expect(records.at(-1)).toMatchObject({ event: "job_persistence", job_id: "projection-1", stage: "retry", outcome: outcome === "rejected" ? "unconfirmed" : "not_applied" });
    expect(records.at(-1)).not.toHaveProperty("retry_at");
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_DATABASE|Canonical PostgreSQL|owner-1|hierarchy-1/);
  });

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
      const client = { $queryRaw: vi.fn().mockResolvedValueOnce(scopes).mockResolvedValueOnce([
        { candidates: [], scopeVerified: true, semanticRevalidatedCount: 0 }
      ]) };
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

  it("marks source_invalid permanent on first failure, before index mutation", async () => {
    const fixture = clientFixture();
    const hierarchy = await fixture.knowledgeHierarchicalIndexArtifact.findUnique();
    fixture.knowledgeHierarchicalIndexArtifact.findUnique.mockResolvedValue({ ...hierarchy, checksum: "c".repeat(64) });
    const { mocks, search } = searchFixture();
    await expect(runKnowledgeSearchProjectionPass({ client: fixture.client, search })).resolves.toMatchObject({ failed: 1, projected: 0 });
    expect(mocks.deleteKnowledgeArtifact).not.toHaveBeenCalled();
    expect(mocks.bulkUpsertKnowledgeDocuments).not.toHaveBeenCalled();
    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastErrorCode: "knowledge_search_projection_source_invalid", state: "FAILED" }),
      where: expect.objectContaining({ id: "projection-1", state: "BUILDING" })
    }));
  });

  it.each([
    ["opensearch_rate_limited", new OpenSearchTransportError("opensearch_rate_limited")],
    ["opensearch_timeout", new OpenSearchTransportError("opensearch_timeout", true)],
    ["opensearch_unavailable", new OpenSearchTransportError("opensearch_unavailable")],
    ["opensearch_bulk_item_failed", new OpenSearchTransportError("opensearch_bulk_item_failed")]
  ])("keeps transient OpenSearch failures retryable (%s)", async (code, failure) => {
    vi.useFakeTimers({ now: new Date("2026-09-27T00:00:00.000Z"), toFake: ["Date"] });
    try {
      const fixture = clientFixture();
      // The fifth attempt was terminal before; transient failures now keep backing off.
      fixture.queryRaw.mockResolvedValue([{ attemptCount: 5, expectedPassageCount: 1,
        id: "projection-1", indexArtifactId: "hierarchy-1", projectionFingerprint }]);
      const { search } = searchFixture({ bulkFailure: failure });
      await expect(runKnowledgeSearchProjectionPass({ client: fixture.client, search }))
        .resolves.toMatchObject({ failed: 1 });
      expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: code,
          // 30 s doubling per attempt: the fifth retry waits 8 minutes.
          nextAttemptAt: new Date("2026-09-27T00:08:00.000Z"),
          state: "RETRY_WAIT"
        })
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps transient backoff and fails only after the long retry horizon", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-27T00:00:00.000Z"), toFake: ["Date"] });
    try {
      const fixture = clientFixture();
      fixture.queryRaw.mockResolvedValue([{ attemptCount: 23, expectedPassageCount: 1,
        id: "projection-1", indexArtifactId: "hierarchy-1", projectionFingerprint }]);
      const { mocks, search } = searchFixture();
      mocks.countKnowledgeArtifact.mockResolvedValue(0);
      await runKnowledgeSearchProjectionPass({ client: fixture.client, search });
      expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: "knowledge_search_projection_count_mismatch",
          nextAttemptAt: new Date("2026-09-27T00:15:00.000Z"),
          state: "RETRY_WAIT"
        })
      }));
      fixture.queryRaw.mockResolvedValue([{ attemptCount: 24, expectedPassageCount: 1,
        id: "projection-1", indexArtifactId: "hierarchy-1", projectionFingerprint }]);
      await runKnowledgeSearchProjectionPass({ client: fixture.client, search });
      expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: "knowledge_search_projection_count_mismatch",
          state: "FAILED"
        })
      }));
      const claimSql = fixture.queryRaw.mock.calls[0] as unknown as [{ values: unknown[] }];
      expect(claimSql[0].values).toContain(24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normal pass bisects an oversized bulk request", async () => {
    const fixture = clientFixture();
    const passages = Array.from({ length: 3 }, (_, index) => ({
      contentHash: String(index).repeat(64), contextPrefix: "", documentContext: null,
      headingPath: ["Wide table"], id: `passage-${index}`, layoutKind: "table_row", text: `Row ${index}`
    }));
    const wideFingerprint = knowledgeSearchProjectionFingerprint({
      hierarchicalChecksum: checksum, indexArtifactId: "hierarchy-1", passageCount: 3
    });
    const hierarchy = await fixture.knowledgeHierarchicalIndexArtifact.findUnique();
    fixture.knowledgeHierarchicalIndexArtifact.findUnique.mockResolvedValue({
      ...hierarchy, passageCount: 3, passageIndexes: passages
    } as unknown as typeof hierarchy);
    fixture.queryRaw.mockResolvedValue([{ attemptCount: 1, expectedPassageCount: 3,
      id: "projection-1", indexArtifactId: "hierarchy-1", projectionFingerprint: wideFingerprint }]);
    const { mocks, search } = searchFixture();
    mocks.bulkUpsertKnowledgeDocuments.mockImplementation(async (documents: unknown) => {
      if ((documents as unknown[]).length > 1) {
        throw new OpenSearchTransportError("opensearch_response_too_large");
      }
    });
    mocks.countKnowledgeArtifact.mockResolvedValue(3);

    await expect(runKnowledgeSearchProjectionPass({ client: fixture.client, search }))
      .resolves.toMatchObject({ failed: 0, projected: 1 });
    expect(mocks.bulkUpsertKnowledgeDocuments.mock.calls.map(([documents]) =>
      (documents as unknown as Array<{ passageId: string }>).map(({ passageId }) => passageId)))
      .toEqual([
        ["passage-0", "passage-1", "passage-2"],
        ["passage-0", "passage-1"],
        ["passage-0"],
        ["passage-1"],
        ["passage-2"]
      ]);
    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ indexedPassageCount: 3, state: "READY" })
    }));
  });

  it("marks one document that alone exceeds the bulk bound permanent on first failure", async () => {
    const fixture = clientFixture();
    const { mocks, search } = searchFixture({
      bulkFailure: new OpenSearchTransportError("opensearch_response_too_large")
    });
    await expect(runKnowledgeSearchProjectionPass({ client: fixture.client, search }))
      .resolves.toMatchObject({ failed: 1, projected: 0 });
    expect(mocks.bulkUpsertKnowledgeDocuments).toHaveBeenCalledOnce();
    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastErrorCode: "opensearch_response_too_large", state: "FAILED" })
    }));
  });

  it("retries only FAILED rows without recreating the index or resetting READY rows", async () => {
    const fixture = clientFixture();
    const now = new Date("2026-09-27T12:00:00.000Z");
    fixture.knowledgeSearchProjection.findMany.mockResolvedValue([
      { indexArtifact: { sourceArtifactId: "source-artifact-1" }, indexArtifactId: "hierarchy-1" },
      { indexArtifact: { sourceArtifactId: "source-artifact-2" }, indexArtifactId: "hierarchy-superseded" }
    ] as never);
    const { mocks } = searchFixture();

    await expect(retryFailedKnowledgeSearchProjections(fixture.client, { now }))
      .resolves.toEqual({ retried: 1 });

    expect(fixture.knowledgeSearchProjection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { state: "FAILED" }
    }));
    expect(fixture.knowledgeHierarchicalIndexArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sourceArtifactId: { in: ["source-artifact-1", "source-artifact-2"] }
      })
    }));
    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenCalledOnce();
    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenCalledWith({
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
      where: { indexArtifactId: { in: ["hierarchy-1"] }, state: "FAILED" }
    });
    expect(fixture.knowledgeSearchProjection.deleteMany).not.toHaveBeenCalled();
    expect(mocks.recreateKnowledgeIndex).not.toHaveBeenCalled();
    expect(mocks.deleteKnowledgeArtifact).not.toHaveBeenCalled();
  });

  it("bounds a targeted retry to the requested artifacts and rejects invalid lists", async () => {
    const fixture = clientFixture();
    await expect(retryFailedKnowledgeSearchProjections(fixture.client, {
      indexArtifactIds: ["hierarchy-1"]
    })).resolves.toEqual({ retried: 0 });
    expect(fixture.knowledgeSearchProjection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { indexArtifactId: { in: ["hierarchy-1"] }, state: "FAILED" }
    }));
    expect(fixture.knowledgeSearchProjection.updateMany).not.toHaveBeenCalled();
    for (const indexArtifactIds of [[], ["a", "a"], [""], Array.from({ length: 1_001 }, (_, i) => `a-${i}`)]) {
      await expect(retryFailedKnowledgeSearchProjections(fixture.client, { indexArtifactIds }))
        .rejects.toThrow("knowledge_search_projection_limit_invalid");
    }
  });

  it("settles a source-invalid rebuild claim alone without aborting its batch", async () => {
    const fixture = clientFixture();
    const secondFingerprint = knowledgeSearchProjectionFingerprint({
      hierarchicalChecksum: checksum, indexArtifactId: "hierarchy-2", passageCount: 1
    });
    const valid = await fixture.knowledgeHierarchicalIndexArtifact.findUnique();
    fixture.knowledgeHierarchicalIndexArtifact.findMany.mockImplementation(async (input?: { where?: { id?: unknown } }) =>
      input?.where?.id ? [valid, { ...valid, id: "hierarchy-2", state: "failed" }] as never : []);
    fixture.queryRaw
      .mockResolvedValueOnce([
        { attemptCount: 1, expectedPassageCount: 1, id: "projection-1", indexArtifactId: "hierarchy-1", projectionFingerprint },
        { attemptCount: 1, expectedPassageCount: 1, id: "projection-2", indexArtifactId: "hierarchy-2",
          projectionFingerprint: secondFingerprint }
      ])
      .mockResolvedValueOnce([]);
    const { mocks, search } = searchFixture();

    await expect(rebuildKnowledgeSearchProjections({ client: fixture.client, search }))
      .resolves.toMatchObject({ claimed: 2, failed: 1, projected: 1 });

    expect(fixture.knowledgeSearchProjection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastErrorCode: "knowledge_search_projection_source_invalid", state: "FAILED" }),
      where: expect.objectContaining({ id: "projection-2", state: "BUILDING" })
    }));
    expect(mocks.bulkUpsertKnowledgeDocuments).toHaveBeenCalledOnce();
    expect(mocks.bulkUpsertKnowledgeDocuments.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ indexArtifactId: "hierarchy-1" })
    ]);
    expect(mocks.countKnowledgeArtifacts).toHaveBeenCalledWith(["hierarchy-1"]);
    expect(fixture.client.$executeRaw).toHaveBeenCalledOnce();
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
