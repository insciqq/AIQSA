import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaKnowledgeSourceLibraryRepository } from "./sourceLibraryRepository";

const checksum = "a".repeat(64);
const normalizedChecksum = "b".repeat(64);
const fingerprint = "c".repeat(64);
const fixtureConnectionId = "source-library-test-connection-v1";
const fixtureModelId = "source-library-test-model-v1";
const fixtureProfileId = "source-library-test-profile-v1";
const fixtureProfileRevisionId = "source-library-test-profile-revision-v1";

type Fixture = Readonly<{
  baseAId: string;
  baseBId: string;
  baseCId: string;
  intruderUserId: string;
  ownerUserId: string;
  profileRevisionId: string;
  sharedUserId: string;
  sourceId: string;
}>;

async function cleanupFixture(fixture: Fixture): Promise<void> {
  const baseIds = [fixture.baseAId, fixture.baseBId, fixture.baseCId];
  const ownerUserIds = [fixture.ownerUserId, fixture.intruderUserId];
  const ownedBases = await prisma.knowledgeBase.findMany({
    select: { id: true },
    where: { ownerUserId: { in: ownerUserIds } }
  });
  const allBaseIds = [...new Set([
    ...baseIds,
    ...ownedBases.map(({ id }) => id)
  ])];

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.knowledgeBasePublication.deleteMany({
      where: { knowledgeBaseId: { in: allBaseIds } }
    });
    await tx.knowledgeBaseSnapshotSource.deleteMany({
      where: { knowledgeBaseId: { in: allBaseIds } }
    });
    await tx.knowledgeBaseSnapshot.deleteMany({
      where: { knowledgeBaseId: { in: allBaseIds } }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: { in: allBaseIds } }
    });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: allBaseIds } }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: { in: allBaseIds } }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: { in: allBaseIds } } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { ownerUserId: { in: ownerUserIds } }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersion: { ownerUserId: { in: ownerUserIds } } }
    });
    await tx.knowledgeSourceVersion.deleteMany({
      where: { ownerUserId: { in: ownerUserIds } }
    });
    await tx.knowledgeSource.deleteMany({
      where: { ownerUserId: { in: ownerUserIds } }
    });
    await tx.user.deleteMany({
      where: {
        id: {
          in: [fixture.ownerUserId, fixture.sharedUserId, fixture.intruderUserId]
        }
      }
    });
  });
}

async function createReadySource(input: Readonly<{
  name: string;
  ownerUserId: string;
  profileRevisionId: string;
  sourceId: string;
}>): Promise<void> {
  await prisma.knowledgeSource.create({
    data: {
      description: "Canonical reusable guide",
      id: input.sourceId,
      name: input.name,
      ownerUserId: input.ownerUserId,
      tags: ["product", "guide"]
    }
  });
  const failedVersion = await prisma.knowledgeSourceVersion.create({
    data: {
      byteSize: 512,
      checksum: "d".repeat(64),
      fileName: "old-guide.md",
      mimeType: "text/markdown",
      ownerUserId: input.ownerUserId,
      sourceId: input.sourceId,
      versionNumber: 1
    },
    select: { id: true }
  });
  await prisma.knowledgeSourceIndexArtifact.create({
    data: {
      errorCode: "private_provider_failure",
      profileRevisionId: input.profileRevisionId,
      sourceVersionId: failedVersion.id,
      state: "failed"
    }
  });
  const readyVersion = await prisma.knowledgeSourceVersion.create({
    data: {
      byteSize: 2_048,
      checksum,
      fileName: "guide.md",
      mimeType: "text/markdown",
      originalStorageKey: `source-library/${input.sourceId}/original`,
      ownerUserId: input.ownerUserId,
      sourceId: input.sourceId,
      versionNumber: 2
    },
    select: { id: true }
  });
  await prisma.knowledgeSourceIndexArtifact.create({
    data: {
      chunkCount: 2,
      embeddedPassageCount: 2,
      normalizedTextByteSize: 1_024,
      normalizedTextChecksum: normalizedChecksum,
      normalizedTextStorageKey: `source-library/${input.sourceId}/normalized`,
      pageCount: 4,
      profileRevisionId: input.profileRevisionId,
      readyAt: new Date(),
      sourceVersionId: readyVersion.id,
      state: "ready",
      warningCodes: ["partial_parse"]
    }
  });
  await prisma.knowledgeSource.update({
    data: { currentVersionId: readyVersion.id },
    where: { id: input.sourceId }
  });
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const ownerUserId = `source-library-owner-${suffix}`;
  const sharedUserId = `source-library-shared-${suffix}`;
  const intruderUserId = `source-library-intruder-${suffix}`;
  const profileRevisionId = fixtureProfileRevisionId;
  await prisma.user.createMany({
    data: [
      { displayName: "Source owner", id: ownerUserId, status: "active" },
      { displayName: "Shared viewer", id: sharedUserId, status: "active" },
      { displayName: "Unrelated viewer", id: intruderUserId, status: "active" }
    ]
  });
  await prisma.providerConnection.upsert({
    create: {
      displayName: "Source Library embeddings",
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
      displayName: "Source Library embedding model",
      id: fixtureModelId,
      modelClass: "embedding",
      modelId: "source-library-test-embedding-v1",
      provider: "test"
    },
    update: {},
    where: { id: fixtureModelId }
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
        chunkingProfileVersion: 1,
        egressPolicy: {},
        embeddingConfiguration: {},
        embeddingProviderModelId: fixtureModelId,
        executionAuthority: "installation",
        id: profileRevisionId,
        preflightCheckedAt: new Date(0),
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId: fixtureProfileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint: fingerprint
      }
    });
  }
  const [baseA, baseB, baseC, otherBase] = await Promise.all([
    prisma.knowledgeBase.create({
      data: { name: "Product", ownerUserId },
      select: { id: true }
    }),
    prisma.knowledgeBase.create({
      data: { name: "Support", ownerUserId },
      select: { id: true }
    }),
    prisma.knowledgeBase.create({
      data: { name: "Operations", ownerUserId },
      select: { id: true }
    }),
    prisma.knowledgeBase.create({
      data: { name: "Private unrelated", ownerUserId: intruderUserId },
      select: { id: true }
    })
  ]);
  await Promise.all([baseA, baseB, baseC, otherBase].map(async (base) => {
    const generation = await prisma.knowledgeIndexGeneration.create({
      data: {
        activatedAt: new Date(),
        chunkingProfileVersion: 1,
        embeddingConfiguration: {},
        embeddingProviderModelId: fixtureModelId,
        indexedContentRevision: 0,
        knowledgeBaseId: base.id,
        profileRevisionId,
        readyAt: new Date(),
        status: "active",
        targetDimension: 1024,
        vectorSpaceFingerprint: fingerprint
      },
      select: { id: true }
    });
    await prisma.knowledgeBase.update({
      data: { activeIndexGenerationId: generation.id },
      where: { id: base.id }
    });
  }));
  await prisma.knowledgeBasePublication.create({
    data: { knowledgeBaseId: baseA.id, scope: "installation" }
  });
  const sourceId = `source-library-source-${suffix}`;
  await createReadySource({
    name: "Product guide",
    ownerUserId,
    profileRevisionId,
    sourceId
  });
  await prisma.knowledgeBaseSource.create({
    data: { knowledgeBaseId: baseA.id, ownerUserId, sourceId }
  });
  const unrelatedSourceId = `source-library-unrelated-${suffix}`;
  await createReadySource({
    name: "Unrelated duplicate",
    ownerUserId: intruderUserId,
    profileRevisionId,
    sourceId: unrelatedSourceId
  });
  await prisma.knowledgeBaseSource.create({
    data: {
      knowledgeBaseId: otherBase.id,
      ownerUserId: intruderUserId,
      sourceId: unrelatedSourceId
    }
  });
  return {
    baseAId: baseA.id,
    baseBId: baseB.id,
    baseCId: baseC.id,
    intruderUserId,
    ownerUserId,
    profileRevisionId,
    sharedUserId,
    sourceId
  };
}

describe("Prisma Knowledge Source Library", () => {
  let fixture: Fixture;
  const repository = createPrismaKnowledgeSourceLibraryRepository(prisma);

  beforeAll(async () => {
    fixture = await createFixture();
  });

  afterAll(async () => {
    if (fixture) await cleanupFixture(fixture);
    await prisma.$disconnect();
  });

  it("lists safe owner/shared projections and keeps duplicate checks owner-bound", async () => {
    const ownerList = await repository.listForUser({
      filter: "yours",
      page: 99,
      pageSize: 25,
      query: "product",
      userId: fixture.ownerUserId
    });
    expect(ownerList).toMatchObject({
      pagination: { page: 1, totalItems: 1, totalPages: 1 },
      sources: [{ membershipCount: 1, name: "Product guide", owned: true }]
    });
    expect(JSON.stringify(ownerList)).not.toMatch(
      /artifactId|normalizedText|private_provider_failure|profileRevision/u
    );
    await expect(repository.listForUser({
      baseId: fixture.baseAId,
      filter: "all",
      page: 1,
      pageSize: 25,
      query: "",
      userId: fixture.ownerUserId
    })).resolves.toMatchObject({
      pagination: { totalItems: 1 },
      sources: [{ id: fixture.sourceId }]
    });
    const ownerDetail = await repository.getDetail(fixture.ownerUserId, fixture.sourceId);
    expect(ownerDetail).toMatchObject({
      memberships: [{ id: fixture.baseAId, name: "Product" }],
      readiness: { state: "ready", warningCodes: ["partial_parse"] },
      versions: [
        {
          fileName: "guide.md",
          isCurrent: true,
          readiness: { state: "ready", warningCodes: ["partial_parse"] },
          versionNumber: 2
        },
        {
          fileName: "old-guide.md",
          isCurrent: false,
          readiness: { state: "needs_attention", warningCodes: [] },
          versionNumber: 1
        }
      ]
    });
    expect(ownerDetail?.eligibleBases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.baseBId, name: "Support" }),
      expect.objectContaining({ id: fixture.baseCId, name: "Operations" })
    ]));

    const sharedList = await repository.listForUser({
      baseId: fixture.baseAId,
      filter: "shared",
      page: 1,
      pageSize: 25,
      query: "",
      userId: fixture.sharedUserId
    });
    expect(sharedList.sources).toEqual([
      expect.objectContaining({ id: fixture.sourceId, membershipCount: 1, owned: false })
    ]);
    const sharedDetail = await repository.getDetail(fixture.sharedUserId, fixture.sourceId);
    expect(sharedDetail).toMatchObject({
      eligibleBases: [],
      memberships: [{ id: fixture.baseAId }],
      owned: false,
      versions: [{ isCurrent: true, versionNumber: 2 }]
    });
    expect(sharedDetail?.versions).toHaveLength(1);
    await expect(repository.update(fixture.sharedUserId, fixture.sourceId, {
      expectedVersion: 1,
      name: "Not allowed"
    })).resolves.toEqual({ kind: "not_found" });
    await expect(repository.addMemberships(
      fixture.sharedUserId,
      fixture.sourceId,
      [fixture.baseBId]
    )).resolves.toEqual({ kind: "not_found" });

    await expect(repository.findOwnedDuplicate(fixture.ownerUserId, {
      byteSize: 2_048,
      checksum
    })).resolves.toMatchObject({ id: fixture.sourceId, owned: true });
    await expect(repository.findOwnedDuplicate(fixture.sharedUserId, {
      byteSize: 2_048,
      checksum
    })).resolves.toBeNull();
    await expect(repository.findOwnedDuplicate("missing-owner", {
      byteSize: 2_048,
      checksum
    })).resolves.toBeNull();
  });

  it("reuses one Source across Bases while Add, Move, and Remove stay distinct", async () => {
    const beforeCounts = await Promise.all([
      prisma.knowledgeSourceVersion.count({ where: { sourceId: fixture.sourceId } }),
      prisma.knowledgeSourceIndexArtifact.count({
        where: { sourceVersion: { sourceId: fixture.sourceId } }
      })
    ]);
    await expect(repository.addMemberships(
      fixture.ownerUserId,
      fixture.sourceId,
      [fixture.baseBId]
    )).resolves.toEqual({ kind: "ok" });
    let detail = await repository.getDetail(fixture.ownerUserId, fixture.sourceId);
    expect(detail?.memberships.map(({ id }) => id).sort()).toEqual(
      [fixture.baseAId, fixture.baseBId].sort()
    );
    await expect(Promise.all([
      prisma.knowledgeSourceVersion.count({ where: { sourceId: fixture.sourceId } }),
      prisma.knowledgeSourceIndexArtifact.count({
        where: { sourceVersion: { sourceId: fixture.sourceId } }
      })
    ])).resolves.toEqual(beforeCounts);

    await expect(repository.moveMembership(
      fixture.ownerUserId,
      fixture.sourceId,
      fixture.baseAId,
      fixture.baseCId
    )).resolves.toEqual({ kind: "ok" });
    detail = await repository.getDetail(fixture.ownerUserId, fixture.sourceId);
    expect(detail?.memberships.map(({ id }) => id).sort()).toEqual(
      [fixture.baseBId, fixture.baseCId].sort()
    );
    await expect(repository.getDetail(fixture.sharedUserId, fixture.sourceId)).resolves.toBeNull();

    await expect(repository.removeMembership(
      fixture.ownerUserId,
      fixture.sourceId,
      fixture.baseBId
    )).resolves.toEqual({ kind: "ok" });
    await expect(repository.removeMembership(
      fixture.ownerUserId,
      fixture.sourceId,
      fixture.baseBId
    )).resolves.toEqual({ kind: "ok" });
    detail = await repository.getDetail(fixture.ownerUserId, fixture.sourceId);
    expect(detail?.memberships).toEqual([
      expect.objectContaining({ id: fixture.baseCId, name: "Operations" })
    ]);

    const updated = await repository.update(fixture.ownerUserId, fixture.sourceId, {
      description: "Updated reusable guide",
      expectedVersion: detail!.version,
      name: "Reusable guide",
      tags: ["support", "canonical"]
    });
    expect(updated).toEqual({ kind: "ok" });
    await expect(repository.getDetail(fixture.ownerUserId, fixture.sourceId)).resolves.toMatchObject({
      description: "Updated reusable guide",
      name: "Reusable guide",
      tags: ["support", "canonical"]
    });
  });

  it("creates and retries a Source-scoped replacement without legacy document rows", async () => {
    const sourceVersionId = `source-library-replacement-${randomUUID()}`;
    const beforeRevision = await prisma.knowledgeBase.findUniqueOrThrow({
      select: { sourceRevision: true },
      where: { id: fixture.baseCId }
    });
    await expect(repository.createVersion({
      byteSize: 1_024,
      checksum: "e".repeat(64),
      fileName: "replacement.md",
      mimeType: "text/markdown",
      now: new Date(),
      originalStorageKey: `source-library/${fixture.sourceId}/replacement`,
      sourceId: fixture.sourceId,
      sourceVersionId,
      userId: fixture.ownerUserId
    })).resolves.toEqual({ kind: "ok", sourceVersionId });

    const artifact = await prisma.knowledgeSourceIndexArtifact.findFirstOrThrow({
      where: { profileRevisionId: fixture.profileRevisionId, sourceVersionId }
    });
    expect(artifact).toMatchObject({
      processingStage: "queued",
      state: "pending"
    });
    expect(artifact.normalizedTextStorageKey).toContain("normalized-v2.json");
    await expect(Promise.all([
      prisma.knowledgeDocument.count({ where: { knowledgeBaseId: fixture.baseCId } }),
      prisma.knowledgeDocumentVersion.count({ where: { knowledgeBaseId: fixture.baseCId } })
    ])).resolves.toEqual([0, 0]);
    await expect(prisma.knowledgeBase.findUniqueOrThrow({
      select: { sourceRevision: true },
      where: { id: fixture.baseCId }
    })).resolves.toEqual(beforeRevision);

    await prisma.knowledgeSourceIndexArtifact.update({
      data: {
        errorCode: "embedding_unavailable",
        processingStage: null,
        state: "failed"
      },
      where: { id: artifact.id }
    });
    await expect(repository.reprocess(
      fixture.ownerUserId,
      fixture.sourceId,
      new Date()
    )).resolves.toEqual({ kind: "ok" });
    await expect(prisma.knowledgeSourceIndexArtifact.findUniqueOrThrow({
      where: { id: artifact.id }
    })).resolves.toMatchObject({
      errorCode: null,
      processingStage: "queued",
      state: "pending"
    });

    await prisma.knowledgeSourceIndexArtifact.update({
      data: {
        errorCode: "chunking_failed",
        normalizedTextByteSize: 2_048,
        normalizedTextChecksum: normalizedChecksum,
        processingStage: null,
        state: "failed"
      },
      where: { id: artifact.id }
    });
    await expect(repository.reprocess(
      fixture.ownerUserId,
      fixture.sourceId,
      new Date()
    )).resolves.toEqual({ kind: "ok" });
    await expect(prisma.knowledgeSourceIndexArtifact.findUniqueOrThrow({
      where: { id: artifact.id }
    })).resolves.toMatchObject({
      errorCode: null,
      normalizedTextByteSize: 2_048,
      normalizedTextChecksum: normalizedChecksum,
      processingStage: "chunking",
      state: "pending"
    });
  });
});
