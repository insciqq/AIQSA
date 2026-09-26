import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaKnowledgeSourceIngestionRepository } from "./prismaSourceIngestionRepository";
import {
  scheduleKnowledgeProfileMigration,
  type KnowledgeProfileMigrationResult
} from "./profileMigration";
import { materializeKnowledgeBaseSnapshot } from "./sourcePersistence";

const checksum = "a".repeat(64);
const normalizedChecksum = "b".repeat(64);
// Profile revisions are immutable (no purge bypass) and pin their embedding
// model and connection, so these installation rows are stable, idempotently
// created fixtures rather than per-run rows. Bump the suffix when their
// content changes.
const connectionId = "knowledge-profile-migration-test-connection-v1";
const providerModelId = "knowledge-profile-migration-test-model-v1";
const profileId = "knowledge-profile-migration-test-profile-v1";
const oldProfileRevisionId = "knowledge-profile-migration-test-revision-old-v1";
const targetProfileRevisionId = "knowledge-profile-migration-test-revision-target-v1";

// Deletes every owner-scoped row this test or the migration code under test
// creates, in foreign-key order. Each step is a filtered deleteMany or
// updateMany so a fixture abandoned at any point mid-test is still removed.
async function cleanupOwnedFixture(ownerUserId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    const baseIds = (await tx.knowledgeBase.findMany({
      select: { id: true },
      where: { ownerUserId }
    })).map((base) => base.id);
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { ownerUserId }
    });
    await tx.knowledgeBaseSnapshotSource.deleteMany({ where: { ownerUserId } });
    await tx.knowledgeBaseSnapshot.deleteMany({ where: { ownerUserId } });
    await tx.knowledgeBaseSource.deleteMany({ where: { ownerUserId } });
    // A rollback generation references the generation it was derived from,
    // so remove underived generations first until none remain.
    for (;;) {
      const deleted = await tx.knowledgeIndexGeneration.deleteMany({
        where: { derivedIndexGenerations: { none: {} }, knowledgeBaseId: { in: baseIds } }
      });
      if (deleted.count === 0) break;
    }
    await tx.knowledgeBase.deleteMany({ where: { ownerUserId } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { ownerUserId }
    });
    await tx.knowledgeHierarchicalIndexArtifact.deleteMany({
      where: { sourceArtifact: { sourceVersion: { ownerUserId } } }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersion: { ownerUserId } }
    });
    await tx.knowledgeSourceVersion.deleteMany({ where: { ownerUserId } });
    await tx.knowledgeSource.deleteMany({ where: { ownerUserId } });
    // The running application's Memory coordinator may enqueue work for the
    // active owner; those rows cascade with the user, the outbox restricts it.
    await tx.memoryDeletionOutbox.deleteMany({ where: { userId: ownerUserId } });
    await tx.memoryJob.deleteMany({ where: { userId: ownerUserId } });
    await tx.user.deleteMany({ where: { id: ownerUserId } });
    await tx.documentProcessingFairnessCursor.updateMany({
      data: { lastGrantedOwnerUserId: null },
      where: { lastGrantedOwnerUserId: ownerUserId, pipeline: "knowledge" }
    });
  });
}

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
  let ownedOwnerUserId: string | null = null;

  afterEach(async () => {
    const ownerUserId = ownedOwnerUserId;
    ownedOwnerUserId = null;
    if (ownerUserId) await cleanupOwnedFixture(ownerUserId);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps the old snapshot live, admits shadow work, cuts over atomically, and rolls back safely", async () => {
    const suffix = randomUUID();
    const now = new Date("2026-08-19T03:00:00.000Z");
    const ownerUserId = `000-profile-shadow-owner-${suffix}`;
    ownedOwnerUserId = ownerUserId;
    const pdfSnapshot = (effort: string) => ({
      connection: { allowPrivateNetwork: false, apiRoot: "https://api.openai.com/v1", authenticationMode: "bearer", responseTimeoutMs: 300_000 },
      connectionDisplayName: "Synthetic reader", connectionId, credentialId: "reader-key-v1",
      credentialVersionId: "reader-key-version-v1", modelDisplayName: "Synthetic reader", providerFamily: "openai",
      providerModelId: "reader-v1", version: 1,
      model: { adapterKind: "openai_responses_native", answerSelectable: true, modelClass: "answer", upstreamModelId: "reader",
        capabilities: { nativePdfInput: true, nativeSearch: false, pdf: true, reasoning: true, vision: true },
        defaultParams: { reasoning: { effort } } }
    });

    await prisma.user.create({
      data: { displayName: "Profile shadow owner", id: ownerUserId, status: "active" }
    });
    await prisma.providerConnection.upsert({
      create: { displayName: "Profile shadow provider", family: "test", id: connectionId },
      update: {},
      where: { id: connectionId }
    });
    await prisma.providerModel.upsert({
      create: {
        capabilities: {},
        connectionId,
        defaultParams: {},
        displayName: "Profile shadow embedding model",
        id: providerModelId,
        modelClass: "embedding",
        modelId: "knowledge-profile-migration-test-embedding-v1",
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
    await prisma.knowledgeIndexProfileRevision.createMany({
      skipDuplicates: true,
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
        pdfProcessingMode: "system_model_vision",
        pdfSystemModelPolicyVersion: 1,
        pdfSystemModelSnapshot: pdfSnapshot("high"),
        profileConfiguration: { pdfReasoningEffort: "high" },
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
        pdfProcessingMode: "system_model_vision",
        pdfSystemModelPolicyVersion: 1,
        pdfSystemModelSnapshot: pdfSnapshot("low"),
        profileConfiguration: { pdfReasoningEffort: "low" },
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
      artifact: { profileRevisionId: targetProfileRevisionId,
        pdfSystemModelSnapshot: { model: { defaultParams: { reasoning: { effort: "low" } } } } },
      knowledgeBaseId: base.id,
      sourceVersionId: version.id
    });
    if (!claim || !("artifact" in claim)) throw new Error("profile_shadow_claim_missing");
    const recoveredClaim = await repository.claim({ claimToken: `profile-shadow-recovered-${suffix}`,
      now: new Date(now.getTime() + 1000), staleBefore: new Date(now.getTime() + 1) });
    expect(recoveredClaim).toMatchObject({ artifact: {
      id: claim.artifact.id, profileRevisionId: targetProfileRevisionId,
      pdfSystemModelSnapshot: { model: { defaultParams: { reasoning: { effort: "low" } } } }
    } });
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
    // Moving the active profile and completing its shadow does not rewrite
    // the configuration bound to either earlier snapshot or accepted claim.
    expect(claim.artifact.pdfSystemModelSnapshot).toMatchObject({
      model: { defaultParams: { reasoning: { effort: "low" } } }
    });
    for (const [id, effort] of [[oldProfileRevisionId, "high"], [targetProfileRevisionId, "low"]]) {
      await expect(prisma.knowledgeIndexProfileRevision.findUniqueOrThrow({
        where: { id }, select: { pdfSystemModelSnapshot: true, profileConfiguration: true }
      })).resolves.toMatchObject({ pdfSystemModelSnapshot: { model: { defaultParams: { reasoning: { effort } } } },
        profileConfiguration: { pdfReasoningEffort: effort } });
    }
    expect(rollbackBase.activeIndexGenerationId).not.toBe(oldGeneration.id);
    await expect(prisma.knowledgeBaseSnapshot.count({
      where: { knowledgeBaseId: base.id }
    })).resolves.toBe(3);
  });
});
