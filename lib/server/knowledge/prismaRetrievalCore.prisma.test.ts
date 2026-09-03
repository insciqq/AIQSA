import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { createKnowledgeOpenSearchTransport } from "../search/opensearch/transport";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION } from "./hierarchicalIndex";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { readKnowledgeSearchHealth } from "./searchHealth";
import {
  deleteKnowledgeSearchArtifacts,
  inspectKnowledgeSearchIntegrity,
  rebuildKnowledgeSearchProjections,
  runKnowledgeSearchProjectionPass
} from "./searchProjection";
import { createPrismaKnowledgeSearchWorkerHeartbeat } from
  "./searchWorkerHeartbeat";

const fingerprint = "f".repeat(64);

function basisVector(axis: number): number[] {
  return Array.from({ length: 1_024 }, (_, index) => index === axis ? 1 : 0);
}

type Fixture = Readonly<{
  artifactId: string;
  chatId: string;
  hierarchyId: string;
  passageIds: readonly [string, string, string];
  profileBindingId: string;
  profileRevisionId: string;
  runId: string;
  sourceId: string;
  sourceVersionId: string;
  userId: string;
}>;

async function withCleanupOnFailure<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  try {
    return await operation();
  } catch (operationError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        "knowledge_search_fixture_setup_cleanup_failed"
      );
    }
    throw operationError;
  }
}

async function runFixtureCleanupSteps(
  searchCleanup: () => Promise<void>,
  databaseCleanup: () => Promise<void>
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await searchCleanup();
  } catch (error) {
    errors.push(error);
  }
  try {
    await databaseCleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "knowledge_search_fixture_cleanup_failed");
  }
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const now = new Date("2026-08-26T06:30:00.000Z");
  const userId = `knowledge-exact-owner-${suffix}`;
  const connectionId = `knowledge-exact-connection-${suffix}`;
  const modelId = `knowledge-exact-model-${suffix}`;
  const credentialId = `knowledge-exact-credential-${suffix}`;
  const credentialVersionId = `knowledge-exact-credential-version-${suffix}`;
  const profileId = `knowledge-exact-profile-${suffix}`;
  const profileRevisionId = `knowledge-exact-profile-revision-${suffix}`;
  const sourceId = `knowledge-exact-source-${suffix}`;
  const sourceVersionId = `knowledge-exact-source-version-${suffix}`;
  const artifactId = `knowledge-exact-artifact-${suffix}`;
  const hierarchyId = `knowledge-exact-hierarchy-${suffix}`;
  const sectionId = `knowledge-exact-section-${suffix}`;
  const passageIds = [
    `knowledge-exact-passage-zero-${suffix}`,
    `knowledge-exact-passage-one-${suffix}`,
    `knowledge-exact-passage-two-${suffix}`
  ] as const;

  await prisma.user.create({
    data: { displayName: "Knowledge exact owner", id: userId, status: "active" }
  });
  await prisma.providerConnection.create({
    data: { displayName: "Knowledge exact embeddings", family: "test", id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Knowledge exact embedding model",
      id: modelId,
      modelClass: "embedding",
      modelId: `embedding-${suffix}`,
      provider: "test"
    }
  });
  await prisma.providerCredential.create({
    data: {
      connectionId,
      enabled: true,
      id: credentialId,
      label: "Knowledge exact embedding credential"
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId,
      id: credentialVersionId,
      testEvidence: { authenticationMode: "none", synthetic: true },
      testedAt: now,
      version: 1
    }
  });
  await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
  await prisma.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 6,
      egressPolicy: {},
      embeddingConfiguration: {},
      embeddingProviderModelId: modelId,
      executionAuthority: "installation",
      id: profileRevisionId,
      preflightCheckedAt: now,
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId,
      revisionNumber: 1,
      targetDimension: 1_024,
      vectorSpaceFingerprint: fingerprint
    }
  });

  const chat = await prisma.chat.create({
    data: { title: "Knowledge exact retrieval", userId },
    select: { id: true }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: { blocks: [{ text: "Find exact policy evidence", type: "text" }] },
      role: "user"
    },
    select: { id: true }
  });
  const run = await prisma.modelRun.create({
    data: {
      chatId: chat.id,
      modelId: "knowledge-exact-answer",
      normalizedRequest: {},
      provider: "test",
      status: "in_progress",
      userId,
      userMessageId: message.id
    },
    select: { id: true }
  });
  await prisma.knowledgeRunScope.create({
    data: {
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      modelRunId: run.id,
      resolvedBaseCount: 0,
      resolvedSourceCount: 1,
      selection: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 }
    }
  });
  const profileBinding = await prisma.knowledgeRunProfileBinding.create({
    data: {
      embeddingConnectionId: connectionId,
      embeddingCredentialId: credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: credentialVersionId,
      embeddingExecutionSnapshot: { synthetic: true },
      embeddingProviderModelId: modelId,
      modelRunId: run.id,
      ordinal: 0,
      profileRevisionId,
      targetDimension: 1_024,
      vectorSpaceFingerprint: fingerprint
    },
    select: { id: true }
  });

  await prisma.knowledgeSource.create({
    data: { id: sourceId, name: "Exact policy source", ownerUserId: userId }
  });
  await prisma.knowledgeSourceVersion.create({
    data: {
      byteSize: 256,
      checksum: "a".repeat(64),
      fileName: "opaque-reference.bin",
      id: sourceVersionId,
      mimeType: "application/octet-stream",
      ownerUserId: userId,
      sourceId,
      versionNumber: 1
    }
  });
  await prisma.knowledgeSource.update({
    data: { currentVersionId: sourceVersionId },
    where: { id: sourceId }
  });
  await prisma.knowledgeSourceIndexArtifact.create({
    data: {
      chunkCount: 3,
      embeddedPassageCount: 3,
      id: artifactId,
      normalizedTextByteSize: 128,
      normalizedTextChecksum: "6".repeat(64),
      normalizedTextStorageKey: `knowledge-exact/${suffix}/normalized`,
      pageCount: 3,
      processingStage: "embedding",
      profileRevisionId,
      sourceVersionId
    }
  });
  await prisma.knowledgeHierarchicalIndexArtifact.create({
    data: {
      derivationMode: "normalized_v2",
      id: hierarchyId,
      schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
      sourceArtifactId: artifactId,
      sourceVersionId
    }
  });
  await prisma.knowledgeArtifactDocumentIndex.create({
    data: {
      contentHash: "c".repeat(64),
      documentType: "application/octet-stream",
      fileName: "opaque-reference.bin",
      indexArtifactId: hierarchyId,
      pageCount: 3,
      sourceName: "Exact policy source"
    }
  });
  await prisma.knowledgeArtifactSectionIndex.create({
    data: {
      contentHash: "d".repeat(64),
      fileName: "opaque-reference.bin",
      id: sectionId,
      indexArtifactId: hierarchyId,
      label: "Opaque section",
      ordinal: 0,
      page: 1,
      pageEnd: 3,
      passageEnd: 2,
      passageStart: 0
    }
  });
  await prisma.knowledgeArtifactPassageIndex.createMany({
    data: passageIds.map((id, ordinal) => ({
      contentHash: (ordinal === 0 ? "e" : ordinal === 1 ? "f" : "0").repeat(64),
      embeddingTextHash: (ordinal === 0 ? "1" : ordinal === 1 ? "2" : "9").repeat(64),
      fileName: "opaque-reference.bin",
      id,
      indexArtifactId: hierarchyId,
      ordinal,
      page: ordinal + 1,
      pageEnd: ordinal + 1,
      sectionId,
      sourceBlockEnd: ordinal,
      sourceBlockIds: [`block-${ordinal}`],
      sourceBlockStart: ordinal,
      sourceName: "Exact policy source",
      text: ordinal === 0
        ? "Opaque alpha evidence."
        : ordinal === 1 ? "Opaque beta evidence." : "Opaque gamma evidence.",
      tokenCount: 4
    }))
  });
  await prisma.knowledgeArtifactExactEntry.createMany({
    data: [{
      id: `knowledge-exact-filename-${suffix}`,
      indexArtifactId: hierarchyId,
      kind: "filename",
      normalizedValue: "policy.pdf",
      ordinal: 0,
      value: "policy.pdf",
      valueHash: "3".repeat(64)
    }, {
      id: `knowledge-exact-title-${suffix}`,
      indexArtifactId: hierarchyId,
      kind: "title",
      normalizedValue: "acme invoice 2024 final.pdf",
      ordinal: 1,
      value: "acme invoice 2024 final.pdf",
      valueHash: "4".repeat(64)
    }, {
      id: `knowledge-exact-heading-${suffix}`,
      indexArtifactId: hierarchyId,
      kind: "heading",
      normalizedValue: "release schedule",
      ordinal: 2,
      page: 1,
      pageEnd: 2,
      sectionId,
      value: "Release Schedule",
      valueHash: "5".repeat(64)
    }, {
      id: `knowledge-exact-date-${suffix}`,
      indexArtifactId: hierarchyId,
      kind: "date",
      normalizedValue: "2026-08-20",
      ordinal: 3,
      page: 1,
      pageEnd: 1,
      passageId: passageIds[0],
      sectionId,
      value: "2026-08-20",
      valueHash: "6".repeat(64)
    }, {
      id: `knowledge-exact-identifier-${suffix}`,
      indexArtifactId: hierarchyId,
      kind: "identifier",
      normalizedValue: "safe-2718",
      ordinal: 4,
      page: 2,
      pageEnd: 2,
      passageId: passageIds[1],
      sectionId,
      value: "SAFE-2718",
      valueHash: "7".repeat(64)
    }, {
      id: `knowledge-exact-date-repeat-${suffix}`,
      indexArtifactId: hierarchyId,
      kind: "date",
      normalizedValue: "2026-08-20",
      ordinal: 5,
      page: 3,
      pageEnd: 3,
      passageId: passageIds[2],
      sectionId,
      value: "2026-08-20",
      valueHash: "8".repeat(64)
    }]
  });
  const alphaVector = `[${basisVector(0).join(",")}]`;
  const betaVector = `[${basisVector(1).join(",")}]`;
  const gammaVector = `[${basisVector(2).join(",")}]`;
  await prisma.$executeRaw`
    INSERT INTO "KnowledgeArtifactPassageEmbedding" (
      "passageId", "indexArtifactId", "embeddingTextHash", "embeddingDimension", "embedding"
    ) VALUES (
      ${passageIds[0]}, ${hierarchyId}, ${"1".repeat(64)}, 1024, ${alphaVector}::vector
    )
  `;
  await prisma.$executeRaw`
    INSERT INTO "KnowledgeArtifactPassageEmbedding" (
      "passageId", "indexArtifactId", "embeddingTextHash", "embeddingDimension", "embedding"
    ) VALUES (
      ${passageIds[1]}, ${hierarchyId}, ${"2".repeat(64)}, 1024, ${betaVector}::vector
    )
  `;
  await prisma.$executeRaw`
    INSERT INTO "KnowledgeArtifactPassageEmbedding" (
      "passageId", "indexArtifactId", "embeddingTextHash", "embeddingDimension", "embedding"
    ) VALUES (
      ${passageIds[2]}, ${hierarchyId}, ${"9".repeat(64)}, 1024, ${gammaVector}::vector
    )
  `;
  await prisma.knowledgeHierarchicalIndexArtifact.update({
    data: {
      checksum: "b".repeat(64),
      documentCount: 1,
      exactEntryCount: 6,
      passageCount: 3,
      readyAt: now,
      sectionCount: 1,
      state: "ready"
    },
    where: { id: hierarchyId }
  });
  await prisma.knowledgeSourceIndexArtifact.update({
    data: {
      embeddedPassageCount: 3,
      processingStage: null,
      readyAt: now,
      state: "ready"
    },
    where: { id: artifactId }
  });
  const fixture = {
    artifactId,
    chatId: chat.id,
    hierarchyId,
    passageIds,
    profileBindingId: profileBinding.id,
    profileRevisionId,
    runId: run.id,
    sourceId,
    sourceVersionId,
    userId
  };
  return withCleanupOnFailure(async () => {
    const projection = await runKnowledgeSearchProjectionPass({ client: prisma, limit: 16 });
    if (projection.projected < 1) throw new Error("knowledge_search_projection_fixture_failed");
    await prisma.knowledgeRunSourceBinding.create({
      data: {
        directSelected: true,
        fileNameSnapshot: "opaque-reference.bin",
        modelRunId: run.id,
        ordinal: 0,
        profileBindingId: profileBinding.id,
        readinessState: "ready",
        selectionKind: "direct",
        sourceAlias: "S1",
        sourceArtifactId: artifactId,
        sourceId,
        sourceNameSnapshot: "Exact policy source",
        sourceVersionId,
        sourceVersionNumber: 1
      }
    });
    return fixture;
  }, () => cleanupFixture(fixture));
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await runFixtureCleanupSteps(
    () => deleteKnowledgeSearchArtifacts({ indexArtifactIds: [fixture.hierarchyId] }),
    () => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
      await tx.modelRun.deleteMany({ where: { id: fixture.runId } });
      await tx.chat.deleteMany({ where: { id: fixture.chatId } });
      await tx.knowledgeSourceIndexArtifact.deleteMany({ where: { id: fixture.artifactId } });
      await tx.knowledgeSource.updateMany({
        data: { currentVersionId: null },
        where: { id: fixture.sourceId }
      });
      await tx.knowledgeSourceVersion.deleteMany({ where: { id: fixture.sourceVersionId } });
      await tx.knowledgeSource.deleteMany({ where: { id: fixture.sourceId } });
      await tx.user.deleteMany({ where: { id: fixture.userId } });
    })
  );
}

describe("Prisma Knowledge ordinary exact retrieval", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("runs database fixture cleanup after setup and search cleanup both fail", async () => {
    const setupFailure = new Error("projection_setup_failed");
    const searchCleanupFailure = new Error("search_cleanup_failed");
    const databaseCleanup = vi.fn(async () => undefined);

    const failure = await withCleanupOnFailure(
      async () => { throw setupFailure; },
      () => runFixtureCleanupSteps(
        async () => { throw searchCleanupFailure; },
        databaseCleanup
      )
    ).catch((error: unknown) => error);

    expect(databaseCleanup).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      setupFailure,
      searchCleanupFailure
    ]);
  });

  it("projects real projection states and a persisted worker heartbeat into search health", async () => {
    const fixture = await createFixture();
    const now = new Date();
    const search = { checkKnowledgeIndex: async () => undefined };

    try {
      await expect(prisma.$transaction(async (tx) => {
        const heartbeat = createPrismaKnowledgeSearchWorkerHeartbeat(tx as never, {
          instanceId: `knowledge-health-${randomUUID()}`,
          startedAt: now
        });
        await heartbeat.beat(now);
        await expect(readKnowledgeSearchHealth(tx as never, { now, search }))
          .resolves.toMatchObject({
            backendState: "available",
            workerLastSeenAt: now.toISOString(),
            workerState: "healthy"
          });
        throw new Error("knowledge_search_health_fixture_rollback");
      })).rejects.toThrow("knowledge_search_health_fixture_rollback");

      const ready = await readKnowledgeSearchHealth(prisma, { now, search });
      expect(ready.expectedProjections).toBeGreaterThanOrEqual(1);
      expect(ready.readyProjections).toBeGreaterThanOrEqual(1);

      await prisma.knowledgeSearchProjection.update({
        data: { state: "FAILED" },
        where: { indexArtifactId: fixture.hierarchyId }
      });
      const failed = await readKnowledgeSearchHealth(prisma, { now, search });
      expect(failed.failedProjections).toBeGreaterThanOrEqual(1);
      expect(failed.readyProjections).toBe(ready.readyProjections - 1);

      await prisma.knowledgeSearchProjection.update({
        data: {
          nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"),
          state: "RETRY_WAIT"
        },
        where: { indexArtifactId: fixture.hierarchyId }
      });
      const pending = await readKnowledgeSearchHealth(prisma, { now, search });
      expect(pending.pendingProjections).toBeGreaterThanOrEqual(1);
      expect(pending.readyProjections).toBe(ready.readyProjections - 1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("proves query-first pg_trgm containment for beginning and middle metadata queries", async () => {
    const storedValue = "acme invoice 2024 final.pdf";
    const [scores] = await prisma.$queryRaw<Array<{
      beginning: number;
      irrelevant: number;
      middle: number;
      reversedMiddle: number;
    }>>`
      SELECT
        word_similarity(${"acme invoice"}, ${storedValue})::double precision AS "beginning",
        word_similarity(${"quarterly report"}, ${storedValue})::double precision AS "irrelevant",
        word_similarity(${"invoice 2024"}, ${storedValue})::double precision AS "middle",
        word_similarity(${storedValue}, ${"invoice 2024"})::double precision AS "reversedMiddle"
    `;

    expect(scores?.beginning).toBe(1);
    expect(scores?.middle).toBe(1);
    expect(scores?.reversedMiddle).toBeLessThan(0.5);
    expect(scores?.irrelevant).toBe(0);
  });

  it("keeps filename routing in the coarse document lane, not the passage BM25 vote", async () => {
    const fixture = await createFixture();
    try {
      const result = await executeKnowledgeRetrievalCore(prisma, {
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "reference",
        resultLimit: 16,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });

      expect(result.passages).toHaveLength(1);
      expect(result.passages[0]?.chunkId).toBe(fixture.passageIds[0]);
      expect(result.passages[0]?.signals).toEqual(expect.arrayContaining([
        expect.objectContaining({ lane: "document_lexical" })
      ]));
      expect(result.passages[0]?.signals).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ lane: "passage_bm25" })
      ]));
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("fails closed when the canonical scope is missing its projection row", async () => {
    const fixture = await createFixture();
    try {
      await prisma.knowledgeSearchProjection.delete({
        where: { indexArtifactId: fixture.hierarchyId }
      });

      await expect(executeKnowledgeRetrievalCore(prisma, {
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "SAFE-2718",
        resultLimit: 16,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      })).rejects.toThrow("knowledge_search_projection_incomplete");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("fails closed and reports pending health for a stale projection fingerprint", async () => {
    const fixture = await createFixture();
    const now = new Date();
    const search = { checkKnowledgeIndex: async () => undefined };
    try {
      await expect(prisma.$transaction(async (tx) => {
        await tx.knowledgeSearchProjection.update({
          data: { projectionFingerprint: "0".repeat(64) },
          where: { indexArtifactId: fixture.hierarchyId }
        });

        await expect(readKnowledgeSearchHealth(tx as never, { now, search }))
          .resolves.toMatchObject({
            failedProjections: 0,
            pendingProjections: expect.any(Number),
            readyProjections: expect.any(Number)
          });
        const stale = await readKnowledgeSearchHealth(tx as never, { now, search });
        expect(stale.pendingProjections).toBeGreaterThanOrEqual(1);

        await expect(executeKnowledgeRetrievalCore(tx as never, {
          candidateLimit: 64,
          excludedContentHashes: [],
          query: "SAFE-2718",
          resultLimit: 16,
          runId: fixture.runId,
          userId: fixture.userId,
          vectors: []
        })).rejects.toThrow("knowledge_search_projection_incomplete");
        throw new Error("knowledge_search_stale_projection_fixture_rollback");
      })).rejects.toThrow("knowledge_search_stale_projection_fixture_rollback");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("rebuilds the physical index from canonical passages and detects orphan documents", async () => {
    const fixture = await createFixture();
    const search = createKnowledgeOpenSearchTransport();
    try {
      await expect(inspectKnowledgeSearchIntegrity({ client: prisma, search }))
        .resolves.toMatchObject({
          currentMappingDocumentCount: 3,
          expectedArtifactCount: 1,
          healthy: true,
          orphanDocumentCount: 0
        });

      await search.bulkUpsertKnowledgeDocuments([{
        body: "Synthetic orphan used only for content-free integrity proof.",
        contentHash: "9".repeat(64),
        heading: "",
        indexArtifactId: `orphan-${randomUUID()}`,
        layoutKind: "body",
        ownerUserId: fixture.userId,
        passageId: `orphan-passage-${randomUUID()}`,
        sourceVersionId: fixture.sourceVersionId,
        tableContext: ""
      }]);
      await search.refreshKnowledgeIndex();
      await expect(inspectKnowledgeSearchIntegrity({ client: prisma, search }))
        .resolves.toMatchObject({
          currentMappingDocumentCount: 4,
          healthy: false,
          orphanDocumentCount: 1
        });

      await expect(rebuildKnowledgeSearchProjections({ client: prisma, search }))
        .resolves.toMatchObject({ failed: 0, projected: 1, reset: 1 });
      await expect(inspectKnowledgeSearchIntegrity({ client: prisma, search }))
        .resolves.toMatchObject({
          currentMappingDocumentCount: 3,
          expectedPassageCount: 3,
          healthy: true,
          orphanDocumentCount: 0,
          staleMappingDocumentCount: 0
        });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("maps document, section, and passage exact entries without duplicate passage rows", async () => {
    const fixture = await createFixture();
    try {
      const result = await executeKnowledgeRetrievalCore(prisma, {
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "Find SAFE-2718 from 2026-08-20 in policy.pdf under \"Release Schedule\"",
        resultLimit: 16,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });

      expect(result.candidateCount).toBe(3);
      expect(result.passages.map((passage) => passage.chunkId).sort()).toEqual(
        [...fixture.passageIds].sort()
      );
      const byChunkId = new Map(result.passages.map((passage) => [passage.chunkId, passage]));
      expect(byChunkId.get(fixture.passageIds[0])?.signals.filter((signal) =>
        signal.lane === "exact")).toEqual([expect.objectContaining({
        exactKind: "filename",
        rawScore: expect.any(Number)
      })]);
      expect(byChunkId.get(fixture.passageIds[1])?.signals.filter((signal) =>
        signal.lane === "exact")).toEqual([expect.objectContaining({
        exactKind: "identifier",
        rawScore: expect.any(Number)
      })]);

      const discriminating = await executeKnowledgeRetrievalCore(prisma, {
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "SAFE-2718 2026-08-20",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });
      expect(discriminating.passages[0]?.chunkId).toBe(fixture.passageIds[1]);
      expect(new Set(discriminating.passages.slice(1).map((passage) => passage.chunkId)))
        .toEqual(new Set([fixture.passageIds[0], fixture.passageIds[2]]));
      expect(discriminating.passages[0]?.signals).toEqual(expect.arrayContaining([
        expect.objectContaining({ exactKind: "identifier", lane: "exact", rank: 1 })
      ]));

      const anchored = await executeKnowledgeRetrievalCore(prisma, {
        anchorQuery: "What changed for SAFE-2718 on 2026-08-20?",
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "policy event details",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });
      expect(anchored.passages.map((passage) => passage.chunkId).sort()).toEqual(
        [...fixture.passageIds].sort()
      );

      const anchorLexical = await executeKnowledgeRetrievalCore(prisma, {
        anchorQuery: "Find the opaque beta evidence",
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "policy event details",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });
      expect(anchorLexical.passages.map((passage) => passage.chunkId)).toContain(
        fixture.passageIds[1]
      );

      const modelLexical = await executeKnowledgeRetrievalCore(prisma, {
        anchorQuery: "unrelated current request framing",
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "Find the opaque alpha evidence",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });
      expect(modelLexical.passages.map((passage) => passage.chunkId)).toContain(
        fixture.passageIds[0]
      );

      const semanticFusion = await executeKnowledgeRetrievalCore(prisma, {
        anchorQuery: "second latent concept",
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "first latent concept",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: [{
          bindingOrdinal: 0,
          indexGenerationId: fixture.profileRevisionId,
          knowledgeBaseId: fixture.profileBindingId,
          targetDimension: 1_024,
          vector: basisVector(0)
        }, {
          bindingOrdinal: 0,
          indexGenerationId: fixture.profileRevisionId,
          knowledgeBaseId: fixture.profileBindingId,
          targetDimension: 1_024,
          vector: Array.from({ length: 1_024 }, (_, index) => index < 2 ? 1 : 0)
        }]
      });
      expect(semanticFusion.candidateCount).toBe(2);
      expect(new Set(semanticFusion.passages.map((passage) => passage.chunkId))).toEqual(
        new Set([fixture.passageIds[0], fixture.passageIds[1]])
      );
      expect(semanticFusion.passages.every((passage) => passage.signals.filter((signal) =>
        signal.lane === "passage_semantic").length === 1)).toBe(true);

      for (const query of ["acme invoice", "invoice 2024"]) {
        const metadata = await executeKnowledgeRetrievalCore(prisma, {
          candidateLimit: 64,
          excludedContentHashes: [],
          query,
          resultLimit: 8,
          runId: fixture.runId,
          userId: fixture.userId,
          vectors: []
        });
        expect(metadata.passages).toHaveLength(1);
        expect(metadata.passages[0]?.signals.filter((signal) =>
          signal.lane === "metadata")).toEqual([expect.objectContaining({
          exactKind: "title",
          rawScore: 1
        })]);
      }

      await expect(executeKnowledgeRetrievalCore(prisma, {
        candidateLimit: 64,
        excludedContentHashes: [],
        query: "quarterly report",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      })).resolves.toMatchObject({ candidateCount: 0, passages: [] });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
