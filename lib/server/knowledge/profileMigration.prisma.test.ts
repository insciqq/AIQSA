import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaKnowledgeSourceIngestionRepository } from "./prismaSourceIngestionRepository";
import {
  scheduleKnowledgeProfileMigration,
  type KnowledgeProfileMigrationResult
} from "./profileMigration";
import { materializeKnowledgeBaseSnapshot } from "./sourcePersistence";

const checksum = "a".repeat(64);
const normalizedChecksum = "b".repeat(64);

async function createReadyHierarchy(input: Readonly<{
  artifactId: string;
  sourceVersionId: string;
}>): Promise<void> {
  await prisma.knowledgeHierarchicalIndexArtifact.create({
    data: {
      checksum,
      derivationMode: "normalized_v2",
      documentCount: 1,
      exactEntryCount: 1,
      id: `profile-shadow-hierarchy-${randomUUID()}`,
      passageCount: 1,
      readyAt: new Date(),
      schemaVersion: 2,
      sectionCount: 1,
      sourceArtifactId: input.artifactId,
      sourceVersionId: input.sourceVersionId,
      state: "ready"
    }
  });
}

describe("Knowledge profile shadow migration", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps the old snapshot live, admits shadow work, cuts over atomically, and rolls back safely", async () => {
    const suffix = randomUUID();
    const now = new Date("2026-08-19T03:00:00.000Z");
    const ownerUserId = `000-profile-shadow-owner-${suffix}`;
    const connectionId = `profile-shadow-connection-${suffix}`;
    const providerModelId = `profile-shadow-model-${suffix}`;
    const profileId = `profile-shadow-profile-${suffix}`;
    const oldProfileRevisionId = `profile-shadow-old-${suffix}`;
    const targetProfileRevisionId = `profile-shadow-target-${suffix}`;

    await prisma.user.create({
      data: { displayName: "Profile shadow owner", id: ownerUserId, status: "active" }
    });
    await prisma.providerConnection.create({
      data: { displayName: "Profile shadow provider", family: "test", id: connectionId }
    });
    await prisma.providerModel.create({
      data: {
        capabilities: {},
        connectionId,
        defaultParams: {},
        displayName: "Profile shadow embedding model",
        id: providerModelId,
        modelClass: "embedding",
        modelId: `embedding-${suffix}`,
        provider: "test"
      }
    });
    await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
    await prisma.knowledgeIndexProfileRevision.createMany({
      data: [{
        activatedAt: now,
        chunkingProfileVersion: 1,
        egressPolicy: {},
        embeddingConfiguration: { profile: "old" },
        embeddingProviderModelId: providerModelId,
        executionAuthority: "installation",
        id: oldProfileRevisionId,
        preflightCheckedAt: now,
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint: "c".repeat(64)
      }, {
        activatedAt: now,
        chunkingProfileVersion: 2,
        egressPolicy: {},
        embeddingConfiguration: { profile: "target" },
        embeddingProviderModelId: providerModelId,
        executionAuthority: "installation",
        id: targetProfileRevisionId,
        preflightCheckedAt: now,
        preflightStatus: "ready",
        profileConfiguration: {},
        profileId,
        revisionNumber: 2,
        targetDimension: 1024,
        vectorSpaceFingerprint: "d".repeat(64)
      }]
    });
    await prisma.knowledgeIndexProfile.update({
      data: { activeRevisionId: oldProfileRevisionId },
      where: { id: profileId }
    });

    const base = await prisma.knowledgeBase.create({
      data: { name: "Profile shadow base", ownerUserId },
      select: { id: true }
    });
    const oldGeneration = await prisma.knowledgeIndexGeneration.create({
      data: {
        activatedAt: now,
        chunkingProfileVersion: 1,
        embeddingConfiguration: { profile: "old" },
        embeddingProviderModelId: providerModelId,
        indexedContentRevision: 0,
        knowledgeBaseId: base.id,
        profileRevisionId: oldProfileRevisionId,
        readyAt: now,
        status: "active",
        targetDimension: 1024,
        vectorSpaceFingerprint: "c".repeat(64)
      },
      select: { id: true }
    });
    await prisma.knowledgeBase.update({
      data: { activeIndexGenerationId: oldGeneration.id },
      where: { id: base.id }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Profile shadow source", ownerUserId },
      select: { id: true }
    });
    const version = await prisma.knowledgeSourceVersion.create({
      data: {
        byteSize: 512,
        checksum,
        fileName: "profile-shadow.md",
        mimeType: "text/markdown",
        originalStorageKey: `profile-shadow/${suffix}/original`,
        ownerUserId,
        sourceId: source.id,
        versionNumber: 1
      },
      select: { id: true }
    });
    const oldArtifact = await prisma.knowledgeSourceIndexArtifact.create({
      data: {
        chunkCount: 1,
        embeddedPassageCount: 1,
        normalizedTextByteSize: 256,
        normalizedTextChecksum: normalizedChecksum,
        normalizedTextStorageKey: `profile-shadow/${suffix}/old-normalized`,
        pageCount: 1,
        profileRevisionId: oldProfileRevisionId,
        readyAt: now,
        sourceVersionId: version.id,
        state: "ready"
      },
      select: { id: true }
    });
    await createReadyHierarchy({ artifactId: oldArtifact.id, sourceVersionId: version.id });
    await prisma.knowledgeSource.update({
      data: { currentVersionId: version.id },
      where: { id: source.id }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    const initialSnapshot = await prisma.$transaction((tx) =>
      materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: oldGeneration.id,
        knowledgeBaseId: base.id
      }));

    await prisma.knowledgeIndexProfile.update({
      data: { activeRevisionId: targetProfileRevisionId, version: { increment: 1 } },
      where: { id: profileId }
    });
    const scheduled = await prisma.$transaction((tx) =>
      scheduleKnowledgeProfileMigration(tx, {
        knowledgeBaseIds: [base.id],
        now,
        profileRevisionId: targetProfileRevisionId
      }));
    expect(scheduled).toMatchObject({
      activatedBases: 0,
      buildingBases: 1,
      createdGenerations: 1,
      queuedArtifacts: 1
    });
    await expect(prisma.knowledgeBase.findUniqueOrThrow({
      select: { activeIndexGenerationId: true },
      where: { id: base.id }
    })).resolves.toEqual({ activeIndexGenerationId: oldGeneration.id });
    await expect(prisma.knowledgeBaseSnapshot.findUniqueOrThrow({
      include: { sources: true },
      where: { id: initialSnapshot.snapshotId }
    })).resolves.toMatchObject({
      indexGenerationId: oldGeneration.id,
      sources: [{ artifactId: oldArtifact.id }]
    });

    const firstShadow = await prisma.knowledgeIndexGeneration.findFirstOrThrow({
      select: { id: true },
      where: {
        knowledgeBaseId: base.id,
        profileRevisionId: targetProfileRevisionId,
        status: "building"
      }
    });
    await prisma.knowledgeBase.update({
      data: {
        sourceRevision: { increment: 1 },
        version: { increment: 1 }
      },
      where: { id: base.id }
    });
    const retargeted = await prisma.$transaction((tx) =>
      scheduleKnowledgeProfileMigration(tx, {
        knowledgeBaseIds: [base.id],
        now: new Date(now.getTime() + 500),
        profileRevisionId: targetProfileRevisionId
      }));
    expect(retargeted).toMatchObject({
      buildingBases: 1,
      createdGenerations: 1,
      queuedArtifacts: 0,
      supersededGenerations: 1
    });
    await expect(prisma.knowledgeIndexGeneration.findUniqueOrThrow({
      select: { lastErrorCode: true, status: true },
      where: { id: firstShadow.id }
    })).resolves.toEqual({
      lastErrorCode: "knowledge_profile_superseded",
      status: "failed"
    });

    await prisma.documentProcessingFairnessCursor.upsert({
      create: { lastGrantedOwnerUserId: null, pipeline: "knowledge" },
      update: { lastGrantedOwnerUserId: null },
      where: { pipeline: "knowledge" }
    });
    const repository = createPrismaKnowledgeSourceIngestionRepository(prisma);
    const claim = await repository.claim({
      claimToken: `profile-shadow-claim-${suffix}`,
      now,
      staleBefore: new Date(now.getTime() - 30_000)
    });
    expect(claim).toMatchObject({
      artifact: { profileRevisionId: targetProfileRevisionId },
      knowledgeBaseId: base.id,
      sourceVersionId: version.id
    });
    if (!claim || !("artifact" in claim)) throw new Error("profile_shadow_claim_missing");
    await createReadyHierarchy({
      artifactId: claim.artifact.id,
      sourceVersionId: version.id
    });
    await prisma.knowledgeSourceIndexArtifact.update({
      data: {
        chunkCount: 1,
        claimToken: null,
        claimedAt: null,
        embeddedPassageCount: 1,
        normalizedTextByteSize: 256,
        normalizedTextChecksum: normalizedChecksum,
        normalizedTextStorageKey: `profile-shadow/${suffix}/target-normalized`,
        pageCount: 1,
        processingStage: null,
        readyAt: new Date(now.getTime() + 1_000),
        state: "ready"
      },
      where: { id: claim.artifact.id }
    });

    const activated = await prisma.$transaction((tx) =>
      scheduleKnowledgeProfileMigration(tx, {
        knowledgeBaseIds: [base.id],
        now: new Date(now.getTime() + 2_000),
        profileRevisionId: targetProfileRevisionId
      }));
    expect(activated).toMatchObject({ activatedBases: 1, buildingBases: 0 });
    const targetBase = await prisma.knowledgeBase.findUniqueOrThrow({
      include: { activeIndexGeneration: true },
      where: { id: base.id }
    });
    expect(targetBase.activeIndexGeneration).toMatchObject({
      profileRevisionId: targetProfileRevisionId,
      status: "active"
    });
    expect(targetBase.activeIndexGenerationId).not.toBe(oldGeneration.id);
    await expect(prisma.knowledgeIndexGeneration.findUniqueOrThrow({
      select: { status: true },
      where: { id: oldGeneration.id }
    })).resolves.toEqual({ status: "retired" });
    const snapshotsAfterCutover = await prisma.knowledgeBaseSnapshot.findMany({
      include: { sources: true },
      orderBy: { createdAt: "asc" },
      where: { knowledgeBaseId: base.id }
    });
    expect(snapshotsAfterCutover).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: initialSnapshot.snapshotId,
        indexGenerationId: oldGeneration.id,
        sources: [expect.objectContaining({ artifactId: oldArtifact.id })]
      }),
      expect.objectContaining({
        indexGenerationId: targetBase.activeIndexGenerationId,
        profileRevisionId: targetProfileRevisionId,
        sources: [expect.objectContaining({ artifactId: claim.artifact.id })]
      })
    ]));

    await prisma.knowledgeIndexProfile.update({
      data: { activeRevisionId: oldProfileRevisionId, version: { increment: 1 } },
      where: { id: profileId }
    });
    const rolledBack: KnowledgeProfileMigrationResult = await prisma.$transaction((tx) =>
      scheduleKnowledgeProfileMigration(tx, {
        knowledgeBaseIds: [base.id],
        now: new Date(now.getTime() + 3_000),
        profileRevisionId: oldProfileRevisionId
      }));
    expect(rolledBack).toMatchObject({
      activatedBases: 1,
      createdGenerations: 1,
      queuedArtifacts: 0
    });
    const rollbackBase = await prisma.knowledgeBase.findUniqueOrThrow({
      include: { activeIndexGeneration: true },
      where: { id: base.id }
    });
    expect(rollbackBase.activeIndexGeneration).toMatchObject({
      profileRevisionId: oldProfileRevisionId,
      sourceIndexGenerationId: targetBase.activeIndexGenerationId,
      status: "active"
    });
    expect(rollbackBase.activeIndexGenerationId).not.toBe(oldGeneration.id);
    await expect(prisma.knowledgeBaseSnapshot.count({
      where: { knowledgeBaseId: base.id }
    })).resolves.toBe(3);
  });
});
