import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  createPrismaRetentionRepository,
  drainDeletionObligations
} from "../retention/prune";
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

type Fixture = Readonly<{
  baseId: string;
  generationId: string;
  processingDocumentId: string;
  profileId: string;
  profileRevisionId: string;
  providerModelId: string;
  readyDocumentId: string;
}>;

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const ownerUserId = `knowledge-source-owner-${suffix}`;
  const connectionId = `knowledge-source-connection-${suffix}`;
  const providerModelId = `knowledge-source-model-${suffix}`;
  const profileId = `knowledge-source-profile-${suffix}`;
  const profileRevisionId = `knowledge-source-profile-revision-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Knowledge source owner",
      id: ownerUserId,
      status: "active"
    }
  });
  await prisma.providerConnection.create({
    data: {
      displayName: "Knowledge source embeddings",
      family: "test",
      id: connectionId
    }
  });
  await prisma.providerModel.create({
    data: {
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Knowledge source embedding model",
      id: providerModelId,
      modelClass: "embedding",
      modelId: `embedding-${suffix}`,
      provider: "test"
    }
  });
  await prisma.knowledgeIndexProfile.create({
    data: { id: profileId }
  });
  await prisma.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: new Date(),
      chunkingProfileVersion: 1,
      egressPolicy: {},
      embeddingConfiguration: {},
      embeddingProviderModelId: providerModelId,
      executionAuthority: "installation",
      id: profileRevisionId,
      preflightCheckedAt: new Date(),
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId,
      revisionNumber: 1,
      targetDimension: 1024,
      vectorSpaceFingerprint
    }
  });
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
    processingDocumentId: processingDocument.id,
    profileId,
    profileRevisionId,
    providerModelId,
    readyDocumentId: readyDocument.id
  };
}

describe("Knowledge Source V1 persistence and snapshots", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture();
  });

  afterAll(async () => {
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
    expect(report.discrepancies).toBe(0);
    await expect(materializeKnowledgeBackfillSnapshots(prisma)).resolves.toMatchObject({
      materializedBases: expect.any(Number),
      readySources: expect.any(Number),
      sources: expect.any(Number)
    });
    const snapshotCount = await prisma.knowledgeBaseSnapshot.count({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await materializeKnowledgeBackfillSnapshots(prisma);
    await expect(prisma.knowledgeBaseSnapshot.count({
      where: { knowledgeBaseId: fixture.baseId }
    })).resolves.toBe(snapshotCount);
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

    const nextProfileRevisionId = `knowledge-source-profile-revision-${randomUUID()}`;
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(),
        chunkingProfileVersion: 2,
        egressPolicy: {},
        embeddingConfiguration: {},
        embeddingProviderModelId: fixture.providerModelId,
        executionAuthority: "installation",
        id: nextProfileRevisionId,
        preflightCheckedAt: new Date(),
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId: fixture.profileId,
        revisionNumber: 2,
        targetDimension: 1024,
        vectorSpaceFingerprint: "e".repeat(64)
      }
    });
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
    const deletedKeys: string[] = [];
    const drained = await drainDeletionObligations({
      repository: createPrismaRetentionRepository(prisma),
      storage: {
        async deleteObject(storageKey) {
          deletedKeys.push(storageKey);
        }
      }
    });
    expect(drained.knowledgeJobs.failed).toBe(0);
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
