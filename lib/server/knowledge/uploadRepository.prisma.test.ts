import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  createPrismaKnowledgeUploadRepository,
  newKnowledgeUploadSettlementIds,
  type KnowledgeUploadAdmissionItem
} from "./uploadRepository";
import { projectKnowledgeUploadBatch, type KnowledgeUploadServiceDeps } from "./uploadService";

type Fixture = Readonly<{
  baseId: string;
  duplicateSourceId: string;
  ownerUserId: string;
  profileRevisionId: string;
}>;

const duplicateChecksum = "a".repeat(64);
const distinctChecksum = "b".repeat(64);
const fixtureConnectionId = "knowledge-upload-test-connection-v1";
const fixtureFailedProfileId = "knowledge-upload-test-failed-profile-v1";
const fixtureFailedProfileRevisionId = "knowledge-upload-test-failed-profile-revision-v1";
const fixtureMismatchedProfileId = "knowledge-upload-test-mismatched-profile-v1";
const fixtureMismatchedProfileRevisionId = "knowledge-upload-test-mismatched-profile-revision-v1";
const fixtureProfileId = "knowledge-upload-test-profile-v1";
const fixtureProfileRevisionId = "knowledge-upload-test-profile-revision-v1";
const fixtureProviderModelId = "knowledge-upload-test-model-v1";
const mismatchedProfileChecksum = "e".repeat(64);

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const ownerUserId = `knowledge-upload-owner-${suffix}`;
  await prisma.user.create({
    data: { displayName: "Knowledge upload owner", id: ownerUserId, status: "active" }
  });
  await prisma.providerConnection.upsert({
    create: {
      displayName: "Upload embeddings",
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
      displayName: "Upload embedding model",
      id: fixtureProviderModelId,
      modelClass: "embedding",
      modelId: "knowledge-upload-test-embedding-v1",
      provider: "test"
    },
    update: {},
    where: { id: fixtureProviderModelId }
  });
  await prisma.knowledgeIndexProfile.upsert({
    create: { id: fixtureProfileId },
    update: {},
    where: { id: fixtureProfileId }
  });
  const existingProfileRevision = await prisma.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: fixtureProfileRevisionId }
  });
  if (!existingProfileRevision) {
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(0),
        chunkingProfileVersion: 2,
        egressPolicy: {},
        embeddingConfiguration: {},
        embeddingProviderModelId: fixtureProviderModelId,
        executionAuthority: "installation",
        id: fixtureProfileRevisionId,
        preflightCheckedAt: new Date(0),
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId: fixtureProfileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint: "c".repeat(64)
      }
    });
  }
  await prisma.knowledgeIndexProfile.upsert({
    create: { id: fixtureMismatchedProfileId },
    update: {},
    where: { id: fixtureMismatchedProfileId }
  });
  const existingMismatchedRevision = await prisma.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: fixtureMismatchedProfileRevisionId }
  });
  if (!existingMismatchedRevision) {
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(0),
        chunkingProfileVersion: 3,
        egressPolicy: {},
        embeddingConfiguration: {},
        embeddingProviderModelId: fixtureProviderModelId,
        executionAuthority: "installation",
        id: fixtureMismatchedProfileRevisionId,
        preflightCheckedAt: new Date(0),
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId: fixtureMismatchedProfileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint: "f".repeat(64)
      }
    });
  }
  await prisma.knowledgeIndexProfile.upsert({
    create: { id: fixtureFailedProfileId },
    update: {},
    where: { id: fixtureFailedProfileId }
  });
  const existingFailedRevision = await prisma.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: fixtureFailedProfileRevisionId }
  });
  if (!existingFailedRevision) {
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(0),
        chunkingProfileVersion: 3,
        egressPolicy: {},
        embeddingConfiguration: {},
        embeddingProviderModelId: fixtureProviderModelId,
        executionAuthority: "installation",
        id: fixtureFailedProfileRevisionId,
        preflightCheckedAt: new Date(0),
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId: fixtureFailedProfileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint: "9".repeat(64)
      }
    });
  }
  const base = await prisma.knowledgeBase.create({
    data: { name: "Bulk upload", ownerUserId },
    select: { id: true }
  });
  const generation = await prisma.knowledgeIndexGeneration.create({
    data: {
      activatedAt: new Date(),
      chunkingProfileVersion: 2,
      embeddingConfiguration: {},
      embeddingProviderModelId: fixtureProviderModelId,
      knowledgeBaseId: base.id,
      profileRevisionId: fixtureProfileRevisionId,
      readyAt: new Date(),
      status: "active",
      targetDimension: 1024,
      vectorSpaceFingerprint: "c".repeat(64)
    },
    select: { id: true }
  });
  await prisma.knowledgeBase.update({
    data: { activeIndexGenerationId: generation.id },
    where: { id: base.id }
  });

  const duplicateSourceId = `knowledge-upload-duplicate-${suffix}`;
  const duplicateVersionId = `knowledge-upload-duplicate-version-${suffix}`;
  await prisma.knowledgeSource.create({
    data: { id: duplicateSourceId, name: "Existing guide", ownerUserId }
  });
  await prisma.knowledgeSourceVersion.create({
    data: {
      byteSize: 12,
      checksum: duplicateChecksum,
      fileName: "existing.md",
      id: duplicateVersionId,
      mimeType: "text/markdown",
      originalStorageKey: `knowledge-upload/${suffix}/existing`,
      ownerUserId,
      sourceId: duplicateSourceId,
      versionNumber: 1
    }
  });
  await prisma.knowledgeSourceIndexArtifact.create({
    data: {
      chunkCount: 1,
      embeddedPassageCount: 1,
      normalizedTextByteSize: 20,
      normalizedTextChecksum: "d".repeat(64),
      normalizedTextStorageKey: `knowledge-upload/${suffix}/normalized`,
      pageCount: 1,
      profileRevisionId: fixtureProfileRevisionId,
      readyAt: new Date(),
      sourceVersionId: duplicateVersionId,
      state: "ready"
    }
  });
  await prisma.knowledgeSource.update({
    data: { currentVersionId: duplicateVersionId },
    where: { id: duplicateSourceId }
  });
  return {
    baseId: base.id,
    duplicateSourceId,
    ownerUserId,
    profileRevisionId: fixtureProfileRevisionId
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
    const uploadBatchIds = await tx.knowledgeUploadBatch.findMany({
      select: { id: true },
      where: { knowledgeBaseId: fixture.baseId }
    });
    if (uploadBatchIds.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({
        where: {
          OR: uploadBatchIds.map(({ id }) => ({
            storageKey: { startsWith: `knowledge/uploads/${id}/` }
          }))
        }
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
    await tx.knowledgeGenerationDocument.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeChunk.deleteMany({ where: { knowledgeBaseId: fixture.baseId } });
    await tx.knowledgeUploadBatch.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeDocumentVersion.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeDocument.deleteMany({ where: { knowledgeBaseId: fixture.baseId } });
    await tx.knowledgeBaseSource.deleteMany({ where: { knowledgeBaseId: fixture.baseId } });
    await tx.knowledgeBase.update({
      data: { activeIndexGenerationId: null },
      where: { id: fixture.baseId }
    });
    await tx.knowledgeIndexGeneration.updateMany({
      data: {
        sourceBaseVersion: null,
        sourceIndexGenerationId: null,
        targetContentRevision: null,
        targetSourceRevision: null
      },
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeBase.delete({ where: { id: fixture.baseId } });
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
    await tx.knowledgeSource.deleteMany({ where: { ownerUserId: fixture.ownerUserId } });
    await tx.user.delete({ where: { id: fixture.ownerUserId } });
  });
}

function admission(input: Readonly<{
  batchId: string;
  checksumHint?: string;
  clientFileId?: string;
  expired?: boolean;
  itemId: string;
  multipart?: boolean;
}>): KnowledgeUploadAdmissionItem {
  return {
    checksumHint: input.checksumHint ?? null,
    clientFileId: input.clientFileId ?? "file-1",
    declaredByteSize: 12,
    declaredMimeType: "text/markdown",
    fileName: "guide.md",
    id: input.itemId,
    multipartUploadId: input.multipart ? `multipart-${input.itemId}` : null,
    normalizedMimeType: "text/markdown",
    parts: input.multipart
      ? [
          { byteOffset: 0, byteSize: 8, partNumber: 1 },
          { byteOffset: 8, byteSize: 4, partNumber: 2 }
        ]
      : [],
    sessionExpiresAt: new Date(Date.now() + (input.expired ? -60_000 : 60_000)),
    storageKey: `knowledge/uploads/${input.batchId}/${input.itemId}`,
    transport: input.multipart ? "MULTIPART" : "PROXY"
  };
}

describe("durable Knowledge upload batches", () => {
  let fixture: Fixture;
  const repository = createPrismaKnowledgeUploadRepository(prisma);

  beforeAll(async () => {
    fixture = await createFixture();
  });

  afterAll(async () => {
    await cleanupFixture(fixture);
    await prisma.$disconnect();
  });

  it("settles a new object into one canonical Source plus its V2 processing artifact", async () => {
    const batchId = randomUUID();
    const itemId = randomUUID();
    const item = admission({ batchId, itemId });
    const created = await repository.createBatch({
      batchId,
      clientBatchId: `batch-created-${batchId}`,
      items: [item],
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    });
    expect(created.kind).toBe("created");
    expect(await repository.start({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      userId: fixture.ownerUserId
    })).toBe("ok");
    await expect(prisma.knowledgeUploadItem.findUnique({
      select: { state: true },
      where: { id: itemId }
    })).resolves.toEqual({ state: "QUEUED" });
    expect(await repository.claimProxyStream({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      storageKey: item.storageKey,
      userId: fixture.ownerUserId
    })).toBe("ok");
    expect(await repository.claimProxyStream({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      storageKey: item.storageKey,
      userId: fixture.ownerUserId
    })).toBe("not_found");
    expect(await repository.markStored({
      attemptNumber: 2,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      storageKey: `${item.storageKey}/superseded`,
      userId: fixture.ownerUserId
    })).toBe(false);
    expect(await repository.markStored({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      storageKey: item.storageKey,
      userId: fixture.ownerUserId
    })).toBe(true);
    const ids = newKnowledgeUploadSettlementIds();
    const result = await repository.settle({
      ...ids,
      attemptNumber: 1,
      batchId,
      byteSize: 12,
      checksum: distinctChecksum,
      fileName: "guide.md",
      itemId,
      knowledgeBaseId: fixture.baseId,
      mimeType: "text/markdown",
      normalizedTextStorageKey: `knowledge/${ids.sourceVersionId}/normalized-v2.json`,
      now: new Date(),
      userId: fixture.ownerUserId
    });
    expect(result).toMatchObject({ kind: "created", sourceId: ids.sourceId });
    await expect(repository.settle({
      ...ids,
      attemptNumber: 1,
      batchId,
      byteSize: 12,
      checksum: distinctChecksum,
      fileName: "guide.md",
      itemId,
      knowledgeBaseId: fixture.baseId,
      mimeType: "text/markdown",
      normalizedTextStorageKey: `knowledge/${ids.sourceVersionId}/normalized-v2.json`,
      now: new Date(),
      userId: fixture.ownerUserId
    })).resolves.toEqual({
      kind: "already_settled",
      sourceId: ids.sourceId
    });
    const [source, mappingCount, upload] = await Promise.all([
      prisma.knowledgeSource.findUnique({
        include: { versions: { include: { artifacts: true } } },
        where: { id: ids.sourceId }
      }),
      prisma.knowledgeV1DocumentVersionSourceMap.count({
        where: { sourceVersionId: ids.sourceVersionId }
      }),
      prisma.knowledgeUploadItem.findUnique({ where: { id: itemId } })
    ]);
    expect(source).toMatchObject({
      currentVersionId: null,
      pendingVersionId: ids.sourceVersionId,
      versions: [{ artifacts: [{ state: "pending" }] }]
    });
    expect(mappingCount).toBe(0);
    expect(upload).toMatchObject({
      documentId: null,
      documentVersionId: null,
      sourceArtifactId: ids.sourceArtifactId,
      sourceId: ids.sourceId,
      sourceVersionId: ids.sourceVersionId,
      state: "PROCESSING",
      storageKey: null
    });
  });

  it("settles an eight-item same-Base burst without surfacing serialization conflicts", async () => {
    const batchId = randomUUID();
    const items = Array.from({ length: 8 }, (_, index) => admission({
      batchId,
      clientFileId: `burst-${index}`,
      itemId: randomUUID()
    }));
    await expect(repository.createBatch({
      batchId,
      clientBatchId: `batch-burst-${batchId}`,
      items,
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    })).resolves.toMatchObject({ kind: "created" });
    await Promise.all(items.map((item) => repository.markStored({
      attemptNumber: 1,
      batchId,
      itemId: item.id,
      knowledgeBaseId: fixture.baseId,
      storageKey: item.storageKey,
      userId: fixture.ownerUserId
    })));
    const baseBefore = await prisma.knowledgeBase.findUniqueOrThrow({
      select: { version: true },
      where: { id: fixture.baseId }
    });
    const settlements = items.map((item, index) => {
      const ids = newKnowledgeUploadSettlementIds();
      return repository.settle({
        ...ids,
        attemptNumber: 1,
        batchId,
        byteSize: 12,
        checksum: index.toString(16).padStart(64, "0"),
        fileName: `burst-${index}.md`,
        itemId: item.id,
        knowledgeBaseId: fixture.baseId,
        mimeType: "text/markdown",
        normalizedTextStorageKey: `knowledge/${ids.sourceVersionId}/normalized-v2.json`,
        now: new Date(),
        userId: fixture.ownerUserId
      });
    });

    await expect(Promise.all(settlements)).resolves.toEqual(
      Array.from({ length: 8 }, () => expect.objectContaining({ kind: "created" }))
    );
    await expect(prisma.knowledgeBase.findUniqueOrThrow({
      select: { version: true },
      where: { id: fixture.baseId }
    })).resolves.toEqual({ version: baseBefore.version + 8 });
  });

  it("projects the upload-created artifact instead of a newer artifact from another profile", async () => {
    const batchId = randomUUID();
    const itemId = randomUUID();
    const item = admission({ batchId, itemId });
    await repository.createBatch({
      batchId,
      clientBatchId: `batch-artifact-status-${batchId}`,
      items: [item],
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    });
    await repository.markStored({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      storageKey: item.storageKey,
      userId: fixture.ownerUserId
    });
    const ids = newKnowledgeUploadSettlementIds();
    await expect(repository.settle({
      ...ids,
      attemptNumber: 1,
      batchId,
      byteSize: 12,
      checksum: "7".repeat(64),
      fileName: "artifact-status.md",
      itemId,
      knowledgeBaseId: fixture.baseId,
      mimeType: "text/markdown",
      normalizedTextStorageKey: `knowledge/${ids.sourceVersionId}/normalized-v2.json`,
      now: new Date(),
      userId: fixture.ownerUserId
    })).resolves.toMatchObject({ kind: "created", sourceId: ids.sourceId });

    const staleIds = newKnowledgeUploadSettlementIds();
    await expect(repository.settle({
      ...staleIds,
      attemptNumber: 2,
      batchId,
      byteSize: 12,
      checksum: "7".repeat(64),
      fileName: "artifact-status.md",
      itemId,
      knowledgeBaseId: fixture.baseId,
      mimeType: "text/markdown",
      normalizedTextStorageKey: `knowledge/${staleIds.sourceVersionId}/normalized-v2.json`,
      now: new Date(),
      userId: fixture.ownerUserId
    })).resolves.toEqual({ kind: "conflict" });
    await expect(prisma.knowledgeUploadItem.findUnique({
      select: { sourceArtifactId: true, sourceVersionId: true },
      where: { id: itemId }
    })).resolves.toEqual({
      sourceArtifactId: ids.sourceArtifactId,
      sourceVersionId: ids.sourceVersionId
    });

    const later = Date.now() + 60_000;
    await prisma.knowledgeSourceIndexArtifact.createMany({
      data: [{
        chunkCount: 1,
        createdAt: new Date(later),
        embeddedPassageCount: 1,
        normalizedTextByteSize: 20,
        normalizedTextChecksum: "8".repeat(64),
        normalizedTextStorageKey: `knowledge/${ids.sourceVersionId}/old-ready.json`,
        pageCount: 1,
        profileRevisionId: fixtureMismatchedProfileRevisionId,
        readyAt: new Date(later),
        sourceVersionId: ids.sourceVersionId,
        state: "ready",
        updatedAt: new Date(later)
      }, {
        createdAt: new Date(later + 1_000),
        errorCode: "parser_unavailable",
        profileRevisionId: fixtureFailedProfileRevisionId,
        sourceVersionId: ids.sourceVersionId,
        state: "failed",
        updatedAt: new Date(later + 1_000)
      }]
    });

    const batch = await repository.getBatch(fixture.ownerUserId, fixture.baseId, batchId);
    expect(batch?.items[0]?.sourceState?.versionStates).toEqual([
      expect.objectContaining({ id: ids.sourceVersionId, state: "pending" })
    ]);
    const projected = await projectKnowledgeUploadBatch({
      storage: {}
    } as unknown as KnowledgeUploadServiceDeps, batch!, {
      config: { maxBatchFiles: 100, multipartPartBytes: 8_388_608, sessionSeconds: 900 },
      now: new Date()
    });
    expect(projected.items[0]).toMatchObject({
      failureCode: null,
      state: "processing"
    });
    expect(projected.items[0]).not.toHaveProperty("sourceArtifactId");
    expect(projected.items[0]).not.toHaveProperty("sourceVersionId");

    await prisma.knowledgeUploadItem.update({
      data: { sourceArtifactId: null },
      where: { id: itemId }
    });
    const legacyBatch = await repository.getBatch(
      fixture.ownerUserId,
      fixture.baseId,
      batchId
    );
    expect(legacyBatch?.items[0]?.sourceState?.versionStates).toEqual([
      expect.objectContaining({ id: ids.sourceVersionId, state: "pending" })
    ]);
  });

  it("marks an exact ready duplicate as reused without creating ingestion work", async () => {
    const batchId = randomUUID();
    const itemId = randomUUID();
    const item = admission({ batchId, itemId });
    await repository.createBatch({
      batchId,
      clientBatchId: `batch-reused-${batchId}`,
      items: [item],
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    });
    await repository.markStored({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      storageKey: item.storageKey,
      userId: fixture.ownerUserId
    });
    const ids = newKnowledgeUploadSettlementIds();
    const result = await repository.settle({
      ...ids,
      attemptNumber: 1,
      batchId,
      byteSize: 12,
      checksum: duplicateChecksum,
      fileName: "guide.md",
      itemId,
      knowledgeBaseId: fixture.baseId,
      mimeType: "text/markdown",
      normalizedTextStorageKey: "unused",
      now: new Date(),
      userId: fixture.ownerUserId
    });
    expect(result).toMatchObject({ kind: "reused", sourceId: fixture.duplicateSourceId });
    await expect(prisma.attachmentDeletionJob.findUnique({
      where: { storageKey: item.storageKey }
    })).resolves.toMatchObject({ multipartUploadId: null });
    expect(await prisma.knowledgeSource.count({ where: { id: ids.sourceId } })).toBe(0);
    await expect(prisma.knowledgeBaseSource.findUnique({
      where: {
        knowledgeBaseId_sourceId: {
          knowledgeBaseId: fixture.baseId,
          sourceId: fixture.duplicateSourceId
        }
      }
    })).resolves.toMatchObject({ removedAt: null });
  });

  it("does not reuse an exact duplicate that is ready only for a different profile", async () => {
    const suffix = randomUUID();
    const existingSourceId = `knowledge-upload-profile-mismatch-${suffix}`;
    const existingVersionId = `knowledge-upload-profile-mismatch-version-${suffix}`;
    await prisma.knowledgeSource.create({
      data: { id: existingSourceId, name: "Old-profile guide", ownerUserId: fixture.ownerUserId }
    });
    await prisma.knowledgeSourceVersion.create({
      data: {
        byteSize: 12,
        checksum: mismatchedProfileChecksum,
        fileName: "old-profile.md",
        id: existingVersionId,
        mimeType: "text/markdown",
        ownerUserId: fixture.ownerUserId,
        sourceId: existingSourceId,
        versionNumber: 1
      }
    });
    await prisma.knowledgeSourceIndexArtifact.create({
      data: {
        chunkCount: 1,
        embeddedPassageCount: 1,
        normalizedTextByteSize: 20,
        normalizedTextChecksum: "1".repeat(64),
        normalizedTextStorageKey: `knowledge-upload/${suffix}/old-profile-normalized`,
        pageCount: 1,
        profileRevisionId: fixtureMismatchedProfileRevisionId,
        readyAt: new Date(),
        sourceVersionId: existingVersionId,
        state: "ready"
      }
    });
    await prisma.knowledgeSource.update({
      data: { currentVersionId: existingVersionId },
      where: { id: existingSourceId }
    });

    const batchId = randomUUID();
    const itemId = randomUUID();
    const item = admission({ batchId, itemId });
    await repository.createBatch({
      batchId,
      clientBatchId: `batch-profile-mismatch-${batchId}`,
      items: [item],
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    });
    await repository.markStored({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      storageKey: item.storageKey,
      userId: fixture.ownerUserId
    });
    const ids = newKnowledgeUploadSettlementIds();
    await expect(repository.settle({
      ...ids,
      attemptNumber: 1,
      batchId,
      byteSize: 12,
      checksum: mismatchedProfileChecksum,
      fileName: "guide.md",
      itemId,
      knowledgeBaseId: fixture.baseId,
      mimeType: "text/markdown",
      normalizedTextStorageKey: `knowledge/${ids.sourceVersionId}/normalized-v2.json`,
      now: new Date(),
      userId: fixture.ownerUserId
    })).resolves.toMatchObject({ kind: "created", sourceId: ids.sourceId });
  });

  it("checkpoints multipart parts and makes cancel idempotently fence settlement", async () => {
    const batchId = randomUUID();
    const itemId = randomUUID();
    await repository.createBatch({
      batchId,
      clientBatchId: `batch-cancel-${batchId}`,
      items: [admission({ batchId, itemId, multipart: true })],
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    });
    await expect(repository.checkpointPart({
      attemptNumber: 2,
      batchId,
      byteSize: 8,
      etag: '"stale-etag"',
      itemId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      partNumber: 1,
      userId: fixture.ownerUserId
    })).resolves.toBe("not_found");
    await expect(repository.checkpointPart({
      attemptNumber: 1,
      batchId,
      byteSize: 8,
      etag: '"etag-1"',
      itemId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      partNumber: 1,
      userId: fixture.ownerUserId
    })).resolves.toBe("ok");
    await expect(repository.getTarget({
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    })).resolves.toMatchObject({ state: "UPLOADING", uploadedByteSize: 8 });
    const first = await repository.cancel({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      userId: fixture.ownerUserId
    });
    expect(first).toMatchObject({
      cleanup: {
        multipartUploadId: `multipart-${itemId}`,
        storageKey: `knowledge/uploads/${batchId}/${itemId}`,
        transport: "MULTIPART"
      },
      kind: "ok"
    });
    await expect(prisma.attachmentDeletionJob.findUnique({
      where: { storageKey: `knowledge/uploads/${batchId}/${itemId}` }
    })).resolves.toMatchObject({ multipartUploadId: `multipart-${itemId}` });
    await expect(repository.cancel({
      attemptNumber: 1,
      batchId,
      itemId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      userId: fixture.ownerUserId
    })).resolves.toEqual({ cleanup: null, kind: "ok" });
  });

  it("retries expired or interrupted proxy work without changing successful siblings", async () => {
    const batchId = randomUUID();
    const interruptedId = randomUUID();
    const retryId = randomUUID();
    const siblingId = randomUUID();
    const interrupted = admission({
      batchId,
      clientFileId: "interrupted",
      itemId: interruptedId
    });
    await repository.createBatch({
      batchId,
      clientBatchId: `batch-retry-${batchId}`,
      items: [
        interrupted,
        admission({ batchId, clientFileId: "retry", expired: true, itemId: retryId }),
        admission({ batchId, clientFileId: "sibling", itemId: siblingId })
      ],
      knowledgeBaseId: fixture.baseId,
      userId: fixture.ownerUserId
    });
    await expect(repository.claimProxyStream({
      attemptNumber: 1,
      batchId,
      itemId: interruptedId,
      knowledgeBaseId: fixture.baseId,
      now: new Date(),
      storageKey: interrupted.storageKey,
      userId: fixture.ownerUserId
    })).resolves.toBe("ok");
    await expect(repository.retry({
      attemptNumber: 1,
      batchId,
      itemId: interruptedId,
      knowledgeBaseId: fixture.baseId,
      multipartUploadId: null,
      now: new Date(),
      parts: [],
      sessionExpiresAt: new Date(Date.now() + 60_000),
      storageKey: `${interrupted.storageKey}/attempt-2`,
      transport: "PROXY",
      userId: fixture.ownerUserId
    })).resolves.toMatchObject({ cleanup: { storageKey: interrupted.storageKey }, kind: "ok" });
    const retried = await repository.retry({
      attemptNumber: 1,
      batchId,
      itemId: retryId,
      knowledgeBaseId: fixture.baseId,
      multipartUploadId: null,
      now: new Date(),
      parts: [],
      sessionExpiresAt: new Date(Date.now() + 60_000),
      storageKey: `knowledge/uploads/${batchId}/${retryId}/attempt-2`,
      transport: "PROXY",
      userId: fixture.ownerUserId
    });
    expect(retried).toMatchObject({ kind: "ok" });
    await expect(repository.retry({
      attemptNumber: 1,
      batchId,
      itemId: retryId,
      knowledgeBaseId: fixture.baseId,
      multipartUploadId: null,
      now: new Date(),
      parts: [],
      sessionExpiresAt: new Date(Date.now() + 60_000),
      storageKey: `knowledge/uploads/${batchId}/${retryId}/stale-attempt`,
      transport: "PROXY",
      userId: fixture.ownerUserId
    })).resolves.toMatchObject({ kind: "conflict" });
    const batch = await repository.getBatch(fixture.ownerUserId, fixture.baseId, batchId);
    expect(batch?.items.find(({ id }) => id === interruptedId)).toMatchObject({
      attemptNumber: 2,
      state: "QUEUED"
    });
    expect(batch?.items.find(({ id }) => id === retryId)).toMatchObject({
      attemptNumber: 2,
      state: "QUEUED"
    });
    expect(batch?.items.find(({ id }) => id === siblingId)).toMatchObject({
      attemptNumber: 1,
      state: "QUEUED"
    });
    await expect(prisma.attachmentDeletionJob.count({
      where: { storageKey: { in: [
        interrupted.storageKey,
        `knowledge/uploads/${batchId}/${retryId}`
      ] } }
    })).resolves.toBe(2);
  });
});
