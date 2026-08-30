import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaRetentionRepository } from "../retention/prune";
import { createPrismaKnowledgeDeletionProcessor } from "./deletionProcessor";
import { createPrismaKnowledgeLifecycleRepository } from "./lifecycleRepository";
import {
  backfillV1KnowledgeSources,
  materializeKnowledgeBackfillSnapshots,
  materializeKnowledgeBaseSnapshot,
  reconcileKnowledgeSourcePersistence
} from "./sourcePersistence";

const checksum = "b".repeat(64);
const normalizedChecksum = "c".repeat(64);
const vectorSpaceFingerprint = "d".repeat(64);
const fixtureConnectionId = "knowledge-source-persistence-test-connection-v1";
const fixtureProfileId = "knowledge-source-persistence-test-profile-v1";
const fixtureProfileRevisionId = "knowledge-source-persistence-test-profile-revision-v1";
const fixtureProfileRevisionV2Id = "knowledge-source-persistence-test-profile-revision-v2";
const fixtureProviderModelId = "knowledge-source-persistence-test-model-v1";

type Fixture = Readonly<{
  baseId: string;
  generationId: string;
  ownerUserId: string;
  processingDocumentId: string;
  profileId: string;
  profileRevisionId: string;
  providerModelId: string;
  readyDocumentId: string;
}>;

type ReconciliationReport = Awaited<
  ReturnType<typeof reconcileKnowledgeSourcePersistence>
>;

function scopedSnapshotBackfillClient(fixture: Fixture): typeof prisma {
  return {
    $queryRaw: async () => [{
      indexGenerationId: fixture.generationId,
      knowledgeBaseId: fixture.baseId
    }],
    $transaction: prisma.$transaction.bind(prisma)
  } as unknown as typeof prisma;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: fixture.baseId }
    });
    const [documentStorage, sourceStorage, artifactStorage] = await Promise.all([
      tx.knowledgeDocumentVersion.findMany({
        select: { normalizedTextStorageKey: true, originalStorageKey: true },
        where: { knowledgeBaseId: fixture.baseId }
      }),
      tx.knowledgeSourceVersion.findMany({
        select: { originalStorageKey: true },
        where: { ownerUserId: fixture.ownerUserId }
      }),
      tx.knowledgeSourceIndexArtifact.findMany({
        select: { normalizedTextStorageKey: true },
        where: { sourceVersion: { ownerUserId: fixture.ownerUserId } }
      })
    ]);
    const storageKeys = [...new Set([
      ...documentStorage.flatMap((row) => [
        row.normalizedTextStorageKey,
        row.originalStorageKey
      ]),
      ...sourceStorage.map((row) => row.originalStorageKey),
      ...artifactStorage.map((row) => row.normalizedTextStorageKey)
    ].filter((value): value is string => Boolean(value)))];

    await tx.knowledgeDeletionJob.deleteMany({
      where: { ownerUserId: fixture.ownerUserId }
    });
    if (storageKeys.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({
        where: { storageKey: { in: storageKeys } }
      });
    }
    await tx.knowledgeBaseSnapshotSource.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeBaseSnapshot.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeV1GenerationArtifactMap.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeV1DocumentVersionSourceMap.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeV1DocumentSourceMap.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeGenerationDocument.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeChunk.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeDocumentVersion.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeDocument.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: fixture.baseId } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { ownerUserId: fixture.ownerUserId }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersion: { ownerUserId: fixture.ownerUserId } }
    });
    await tx.knowledgeSourceVersion.deleteMany({
      where: { ownerUserId: fixture.ownerUserId }
    });
    await tx.knowledgeSource.deleteMany({
      where: { ownerUserId: fixture.ownerUserId }
    });
    await tx.user.deleteMany({ where: { id: fixture.ownerUserId } });
  });
}

async function claimOwnedKnowledgeDeletionJob(jobId: string) {
  const claimToken = randomUUID();
  const now = new Date();
  const claimed = await prisma.knowledgeDeletionJob.updateMany({
    data: {
      attemptCount: { increment: 1 },
      claimedAt: now,
      claimToken,
      lastAttemptAt: now,
      lastErrorCode: null,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      state: "RUNNING"
    },
    where: { id: jobId, state: { in: ["PENDING", "RETRY_WAIT"] } }
  });
  expect(claimed.count).toBe(1);
  const job = await prisma.knowledgeDeletionJob.findUniqueOrThrow({
    select: { id: true, ownerUserId: true, targetId: true, targetType: true },
    where: { id: jobId }
  });
  return { ...job, claimToken };
}

async function drainOwnedKnowledgeDeletionJob(jobId: string): Promise<string[]> {
  const processor = createPrismaKnowledgeDeletionProcessor(prisma);
  let firstResult: Awaited<ReturnType<typeof processor.process>> | null = null;
  for (let attempt = 0; attempt < 5 && firstResult === null; attempt += 1) {
    const claim = await claimOwnedKnowledgeDeletionJob(jobId);
    try {
      firstResult = await processor.process(claim);
    } catch (error) {
      if (!(
        typeof error === "object" && error !== null &&
        "code" in error && error.code === "P2034"
      ) || attempt === 4) throw error;
    }
  }
  expect(firstResult).toBe("waiting_for_objects");
  const pendingObjects = await prisma.knowledgeDeletionObject.findMany({
    orderBy: { storageKey: "asc" },
    select: { storageKey: true },
    where: { disposition: "PENDING", knowledgeDeletionJobId: jobId }
  });
  expect(pendingObjects.length).toBeGreaterThan(0);

  const retention = createPrismaRetentionRepository(prisma);
  const deletedKeys: string[] = [];
  for (const { storageKey } of pendingObjects) {
    const attachmentJob = await prisma.attachmentDeletionJob.findUniqueOrThrow({
      select: { id: true },
      where: { storageKey }
    });
    const claimToken = randomUUID();
    const now = new Date();
    const claimed = await prisma.attachmentDeletionJob.updateMany({
      data: {
        attemptCount: { increment: 1 },
        claimedAt: now,
        claimToken,
        lastAttemptAt: now,
        lastErrorCode: null
      },
      where: { id: attachmentJob.id }
    });
    expect(claimed.count).toBe(1);
    deletedKeys.push(storageKey);
    await expect(retention.completeAttachmentDeletionJob({
      claimToken,
      id: attachmentJob.id
    })).resolves.toBe(true);
  }

  const finalClaim = await claimOwnedKnowledgeDeletionJob(jobId);
  await expect(processor.process(finalClaim)).resolves.toBe("completed");
  return deletedKeys;
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const ownerUserId = `knowledge-source-owner-${suffix}`;
  const providerModelId = fixtureProviderModelId;
  const profileId = fixtureProfileId;
  const profileRevisionId = fixtureProfileRevisionId;
  await prisma.user.create({
    data: {
      displayName: "Knowledge source owner",
      id: ownerUserId,
      status: "active"
    }
  });
  await prisma.providerConnection.upsert({
    create: {
      displayName: "Knowledge source embeddings",
      family: "test",
      id: fixtureConnectionId
    },
    update: {},
    where: { id: fixtureConnectionId }
  });
  await prisma.providerModel.upsert({
    create: {
      capabilities: {},
      connectionId: fixtureConnectionId,
      defaultParams: {},
      displayName: "Knowledge source embedding model",
      id: providerModelId,
      modelClass: "embedding",
      modelId: "knowledge-source-persistence-test-embedding-v1",
      provider: "test"
    },
    update: {},
    where: { id: providerModelId }
  });
  await prisma.knowledgeIndexProfile.upsert({
    create: { id: profileId },
    update: {},
    where: { id: profileId }
  });
  const existingProfileRevision = await prisma.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: profileRevisionId }
  });
  if (!existingProfileRevision) {
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(0),
        chunkingProfileVersion: 1,
        egressPolicy: {},
        embeddingConfiguration: {},
        embeddingProviderModelId: providerModelId,
        executionAuthority: "installation",
        id: profileRevisionId,
        preflightCheckedAt: new Date(0),
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint
      }
    });
  }
  const base = await prisma.knowledgeBase.create({
    data: {
      description: "Source persistence fixture",
      name: "Source persistence",
      ownerUserId
    },
    select: { id: true }
  });
  const generation = await prisma.knowledgeIndexGeneration.create({
    data: {
      activatedAt: new Date(),
      chunkingProfileVersion: 1,
      embeddingConfiguration: {},
      embeddingProviderModelId: providerModelId,
      indexedContentRevision: 1,
      knowledgeBaseId: base.id,
      profileRevisionId,
      readyAt: new Date(),
      status: "active",
      targetDimension: 1024,
      vectorSpaceFingerprint
    },
    select: { id: true }
  });
  await prisma.knowledgeBase.update({
    data: { activeIndexGenerationId: generation.id, contentRevision: 1 },
    where: { id: base.id }
  });

  const readyDocument = await prisma.knowledgeDocument.create({
    data: { knowledgeBaseId: base.id },
    select: { id: true }
  });
  const readyVersion = await prisma.knowledgeDocumentVersion.create({
    data: {
      byteSize: 256,
      checksum,
      documentId: readyDocument.id,
      fileName: "shared-checksum-ready.md",
      ingestChunkCount: 2,
      ingestCompletedAt: new Date(),
      ingestGenerationId: generation.id,
      ingestState: "ready",
      ingestWarningCodes: ["partial_parse", "unreadable_pages"],
      knowledgeBaseId: base.id,
      mimeType: "text/markdown",
      normalizedTextByteSize: 128,
      normalizedTextChecksum: normalizedChecksum,
      normalizedTextStorageKey: `knowledge-source/${suffix}/ready-normalized`,
      originalStorageKey: `knowledge-source/${suffix}/ready-original`,
      ownerUserId,
      pageCount: 1,
      versionNumber: 1
    },
    select: { id: true }
  });
  await prisma.knowledgeDocument.update({
    data: { currentVersionId: readyVersion.id },
    where: { id: readyDocument.id }
  });

  const processingDocument = await prisma.knowledgeDocument.create({
    data: { knowledgeBaseId: base.id },
    select: { id: true }
  });
  await prisma.knowledgeDocumentVersion.create({
    data: {
      byteSize: 256,
      checksum,
      documentId: processingDocument.id,
      fileName: "shared-checksum-processing.md",
      ingestGenerationId: generation.id,
      ingestNextAttemptAt: new Date("2098-01-01T00:00:00.000Z"),
      ingestState: "queued",
      knowledgeBaseId: base.id,
      mimeType: "text/markdown",
      originalStorageKey: `knowledge-source/${suffix}/processing-original`,
      ownerUserId,
      versionNumber: 1
    }
  });

  return {
    baseId: base.id,
    generationId: generation.id,
    ownerUserId,
    processingDocumentId: processingDocument.id,
    profileId,
    profileRevisionId,
    providerModelId,
    readyDocumentId: readyDocument.id
  };
}

describe("Knowledge Source V1 persistence and snapshots", () => {
  let fixture: Fixture;
  let reconciliationBeforeFixture: ReconciliationReport;

  beforeAll(async () => {
    reconciliationBeforeFixture = await reconcileKnowledgeSourcePersistence(prisma);
    fixture = await createFixture();
  });

  afterAll(async () => {
    if (fixture) await cleanupFixture(fixture);
    await prisma.$disconnect();
  });

  it("resumes an interrupted backfill without merging equal document checksums", async () => {
    const first = await backfillV1KnowledgeSources({
      knowledgeBaseId: fixture.baseId,
      limit: 1
    }, prisma);
    expect(first).toEqual({
      processedDocuments: 1,
      remainingDocuments: 1,
      skippedProfilelessCandidates: 0
    });

    const second = await backfillV1KnowledgeSources({
      knowledgeBaseId: fixture.baseId,
      limit: 1
    }, prisma);
    expect(second).toEqual({
      processedDocuments: 1,
      remainingDocuments: 0,
      skippedProfilelessCandidates: 0
    });
    await expect(backfillV1KnowledgeSources({
      knowledgeBaseId: fixture.baseId,
      limit: 10
    }, prisma)).resolves.toEqual({
      processedDocuments: 0,
      remainingDocuments: 0,
      skippedProfilelessCandidates: 0
    });

    const mappings = await prisma.knowledgeV1DocumentSourceMap.findMany({
      select: { documentId: true, sourceId: true },
      where: { knowledgeBaseId: fixture.baseId }
    });
    expect(mappings).toHaveLength(2);
    expect(new Set(mappings.map(({ sourceId }) => sourceId)).size).toBe(2);
    expect(new Set(mappings.map(({ documentId }) => documentId))).toEqual(new Set([
      fixture.processingDocumentId,
      fixture.readyDocumentId
    ]));
    const artifactStates = await prisma.knowledgeSourceIndexArtifact.groupBy({
      _count: { _all: true },
      by: ["state"],
      where: {
        sourceVersion: {
          source: { baseMemberships: { some: { knowledgeBaseId: fixture.baseId } } }
        }
      }
    });
    expect(artifactStates).toEqual(expect.arrayContaining([
      { _count: { _all: 1 }, state: "pending" },
      { _count: { _all: 1 }, state: "processing" }
    ]));
    await expect(prisma.knowledgeSourceIndexArtifact.findFirstOrThrow({
      select: { processingStage: true, state: true, warningCodes: true },
      where: {
        sourceVersion: {
          fileName: "shared-checksum-ready.md",
          source: { baseMemberships: { some: { knowledgeBaseId: fixture.baseId } } }
        }
      }
    })).resolves.toEqual({
      processingStage: "chunking",
      state: "processing",
      warningCodes: ["partial_parse", "unreadable_pages"]
    });

    const processingVersion = await prisma.knowledgeDocumentVersion.findFirstOrThrow({
      select: { id: true },
      where: {
        documentId: fixture.processingDocumentId,
        knowledgeBaseId: fixture.baseId
      }
    });
    const failedAt = new Date(Date.now() + 10_000);
    await prisma.$transaction([
      prisma.knowledgeDocumentVersion.update({
        data: {
          ingestClaimToken: null,
          ingestClaimedAt: null,
          ingestErrorCode: "knowledge_source_test_failure",
          ingestState: "failed",
          updatedAt: failedAt
        },
        where: { id: processingVersion.id }
      }),
      prisma.knowledgeGenerationDocument.updateMany({
        data: {
          claimedAt: null,
          claimToken: null,
          errorCode: "knowledge_source_test_failure",
          state: "failed",
          updatedAt: failedAt
        },
        where: {
          documentVersionId: processingVersion.id,
          indexGenerationId: fixture.generationId
        }
      })
    ]);
    await expect(backfillV1KnowledgeSources({
      knowledgeBaseId: fixture.baseId,
      limit: 10
    }, prisma)).resolves.toEqual({
      processedDocuments: 1,
      remainingDocuments: 0,
      skippedProfilelessCandidates: 0
    });
    const failedArtifactMapping = await prisma.knowledgeV1GenerationArtifactMap.findUniqueOrThrow({
      select: { artifactId: true },
      where: {
        indexGenerationId_documentVersionId: {
          documentVersionId: processingVersion.id,
          indexGenerationId: fixture.generationId
        }
      }
    });
    await expect(prisma.knowledgeSourceIndexArtifact.findUniqueOrThrow({
      select: { errorCode: true, state: true },
      where: { id: failedArtifactMapping.artifactId }
    })).resolves.toEqual({
      errorCode: "knowledge_source_test_failure",
      state: "failed"
    });

    const report = await reconcileKnowledgeSourcePersistence(prisma);
    expect(Object.keys(report).sort()).toEqual([
      "discrepancies",
      "invalidArtifactMappings",
      "invalidDocumentMappings",
      "invalidVersionMappings",
      "mappedDocuments",
      "mappedGenerationCandidates",
      "mappedVersions",
      "memberships",
      "snapshots",
      "sources",
      "v1Documents",
      "v1GenerationCandidates",
      "v1Versions"
    ]);
    expect(report.mappedDocuments).toBeGreaterThanOrEqual(2);
    expect(report.mappedVersions).toBeGreaterThanOrEqual(2);
    expect(report.discrepancies).toBe(reconciliationBeforeFixture.discrepancies);
    expect(report.invalidArtifactMappings).toBe(
      reconciliationBeforeFixture.invalidArtifactMappings
    );
    expect(report.invalidDocumentMappings).toBe(
      reconciliationBeforeFixture.invalidDocumentMappings
    );
    expect(report.invalidVersionMappings).toBe(
      reconciliationBeforeFixture.invalidVersionMappings
    );
    const snapshotClient = scopedSnapshotBackfillClient(fixture);
    await expect(materializeKnowledgeBackfillSnapshots(snapshotClient)).resolves.toMatchObject({
      materializedBases: expect.any(Number),
      readySources: expect.any(Number),
      sources: expect.any(Number)
    });
    const snapshotCount = await prisma.knowledgeBaseSnapshot.count({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await materializeKnowledgeBackfillSnapshots(snapshotClient);
    await expect(prisma.knowledgeBaseSnapshot.count({
      where: { knowledgeBaseId: fixture.baseId }
    })).resolves.toBe(snapshotCount);
  });

  it("excludes trashed Sources from new snapshots while preserving membership for Restore", async () => {
    const mapping = await prisma.knowledgeV1DocumentSourceMap.findUniqueOrThrow({
      select: { sourceId: true },
      where: {
        knowledgeBaseId_documentId: {
          documentId: fixture.readyDocumentId,
          knowledgeBaseId: fixture.baseId
        }
      }
    });
    const source = await prisma.knowledgeSource.findUniqueOrThrow({
      select: { version: true },
      where: { id: mapping.sourceId }
    });
    const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
    const beforeTrash = await prisma.$transaction((tx) =>
      materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: fixture.generationId,
        knowledgeBaseId: fixture.baseId
      })
    );

    await expect(lifecycle.trashSource(
      fixture.ownerUserId,
      mapping.sourceId,
      source.version
    )).resolves.toEqual({ kind: "ok" });
    const whileTrashed = await prisma.$transaction((tx) =>
      materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: fixture.generationId,
        knowledgeBaseId: fixture.baseId
      })
    );
    expect(whileTrashed).toMatchObject({ readySourceCount: 0, sourceCount: 1 });
    expect(whileTrashed.snapshotId).not.toBe(beforeTrash.snapshotId);
    await expect(prisma.knowledgeBaseSource.count({
      where: {
        knowledgeBaseId: fixture.baseId,
        removedAt: null,
        sourceId: mapping.sourceId
      }
    })).resolves.toBe(1);

    await expect(lifecycle.restoreSource(
      fixture.ownerUserId,
      mapping.sourceId,
      source.version + 1
    )).resolves.toEqual({ kind: "ok" });
    const afterRestore = await prisma.$transaction((tx) =>
      materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: fixture.generationId,
        knowledgeBaseId: fixture.baseId
      })
    );
    expect(afterRestore).toMatchObject({ readySourceCount: 0, sourceCount: 2 });
    expect(afterRestore.snapshotId).not.toBe(beforeTrash.snapshotId);
    expect(afterRestore.snapshotId).not.toBe(whileTrashed.snapshotId);
    await expect(prisma.knowledgeBaseSnapshot.findUniqueOrThrow({
      select: { sourceCount: true },
      where: { id: beforeTrash.snapshotId }
    })).resolves.toEqual({ sourceCount: 2 });
  });

  it("keeps accepted evidence immutable while removals affect only future snapshots", async () => {
    const first = await prisma.$transaction((tx) =>
      materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: fixture.generationId,
        knowledgeBaseId: fixture.baseId
      })
    );
    expect(first).toMatchObject({ readySourceCount: 0, sourceCount: 2 });
    const firstSources = await prisma.knowledgeBaseSnapshotSource.findMany({
      where: { snapshotId: first.snapshotId }
    });
    expect(firstSources).toHaveLength(0);

    const readyMapping = await prisma.knowledgeV1DocumentSourceMap.findUniqueOrThrow({
      select: { sourceId: true },
      where: {
        knowledgeBaseId_documentId: {
          documentId: fixture.readyDocumentId,
          knowledgeBaseId: fixture.baseId
        }
      }
    });
    await prisma.knowledgeBaseSource.update({
      data: { removedAt: new Date() },
      where: {
        knowledgeBaseId_sourceId: {
          knowledgeBaseId: fixture.baseId,
          sourceId: readyMapping.sourceId
        }
      }
    });
    const second = await prisma.$transaction((tx) =>
      materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: fixture.generationId,
        knowledgeBaseId: fixture.baseId
      })
    );
    expect(second).toMatchObject({ readySourceCount: 0, sourceCount: 1 });
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const nextProfileRevisionId = fixtureProfileRevisionV2Id;
    const existingNextProfileRevision = await prisma.knowledgeIndexProfileRevision.findUnique({
      select: { id: true },
      where: { id: nextProfileRevisionId }
    });
    if (!existingNextProfileRevision) {
      await prisma.knowledgeIndexProfileRevision.create({
        data: {
          activatedAt: new Date(0),
          chunkingProfileVersion: 2,
          egressPolicy: {},
          embeddingConfiguration: {},
          embeddingProviderModelId: fixture.providerModelId,
          executionAuthority: "installation",
          id: nextProfileRevisionId,
          preflightCheckedAt: new Date(0),
          preflightStatus: "ready",
          profileConfiguration: {},
          profileId: fixture.profileId,
          revisionNumber: 2,
          targetDimension: 1024,
          vectorSpaceFingerprint: "e".repeat(64)
        }
      });
    }
    const nextGeneration = await prisma.$transaction(async (tx) => {
      await tx.knowledgeIndexGeneration.update({
        data: { retiredAt: new Date(), status: "retired" },
        where: { id: fixture.generationId }
      });
      const generation = await tx.knowledgeIndexGeneration.create({
        data: {
          activatedAt: new Date(),
          chunkingProfileVersion: 2,
          embeddingConfiguration: {},
          embeddingProviderModelId: fixture.providerModelId,
          indexedContentRevision: 1,
          knowledgeBaseId: fixture.baseId,
          profileRevisionId: nextProfileRevisionId,
          readyAt: new Date(),
          status: "active",
          targetDimension: 1024,
          vectorSpaceFingerprint: "e".repeat(64)
        },
        select: { id: true }
      });
      await tx.knowledgeBase.update({
        data: { activeIndexGenerationId: generation.id },
        where: { id: fixture.baseId }
      });
      return generation;
    });
    const afterProfileChange = await prisma.$transaction((tx) =>
      materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: nextGeneration.id,
        knowledgeBaseId: fixture.baseId
      })
    );
    expect(afterProfileChange).toMatchObject({ readySourceCount: 0, sourceCount: 1 });
    expect(afterProfileChange.snapshotId).not.toBe(second.snapshotId);
    await expect(prisma.knowledgeBaseSnapshot.findUniqueOrThrow({
      select: { profileRevisionId: true },
      where: { id: afterProfileChange.snapshotId }
    })).resolves.toEqual({ profileRevisionId: nextProfileRevisionId });
    await expect(prisma.knowledgeBaseSnapshot.findUniqueOrThrow({
      select: { readySourceCount: true, sourceCount: true },
      where: { id: first.snapshotId }
    })).resolves.toEqual({ readySourceCount: 0, sourceCount: 2 });
    await expect(prisma.knowledgeBaseSnapshotSource.count({
      where: { snapshotId: first.snapshotId }
    })).resolves.toBe(0);

    await expect(prisma.knowledgeBaseSnapshot.update({
      data: { sourceCount: 99 },
      where: { id: first.snapshotId }
    })).rejects.toThrow(/knowledge_base_snapshot_immutable/u);
    const immutableVersion = await prisma.knowledgeSourceVersion.findFirstOrThrow({
      where: { sourceId: readyMapping.sourceId }
    });
    await expect(prisma.knowledgeSourceVersion.update({
      data: { fileName: "mutated.md" },
      where: { id: immutableVersion.id }
    })).rejects.toThrow(/knowledge_source_version_immutable/u);
  });

  it("removes a purged Source from accepted snapshot evidence without deleting the Base", async () => {
    const mapping = await prisma.knowledgeV1DocumentSourceMap.findUniqueOrThrow({
      select: { sourceId: true },
      where: {
        knowledgeBaseId_documentId: {
          documentId: fixture.readyDocumentId,
          knowledgeBaseId: fixture.baseId
        }
      }
    });
    const source = await prisma.knowledgeSource.findUniqueOrThrow({
      select: { ownerUserId: true, version: true },
      where: { id: mapping.sourceId }
    });
    const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
    await expect(lifecycle.trashSource(
      source.ownerUserId,
      mapping.sourceId,
      source.version
    )).resolves.toEqual({ kind: "ok" });
    await expect(lifecycle.permanentlyDeleteSource(
      source.ownerUserId,
      mapping.sourceId,
      source.version + 1
    )).resolves.toEqual({ kind: "pending" });
    const deletionJob = await prisma.knowledgeDeletionJob.findUniqueOrThrow({
      select: { id: true },
      where: {
        targetType_targetId: { targetId: mapping.sourceId, targetType: "SOURCE" }
      }
    });
    const deletedKeys = await drainOwnedKnowledgeDeletionJob(deletionJob.id);
    expect(deletedKeys).not.toEqual([]);
    await expect(prisma.knowledgeSource.findUnique({ where: { id: mapping.sourceId } }))
      .resolves.toBeNull();
    await expect(prisma.knowledgeBaseSnapshotSource.count({
      where: { sourceId: mapping.sourceId }
    })).resolves.toBe(0);
    await expect(prisma.knowledgeBase.findUnique({ where: { id: fixture.baseId } }))
      .resolves.toMatchObject({ id: fixture.baseId });
  });
});
