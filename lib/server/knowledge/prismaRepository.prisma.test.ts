import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaKnowledgeRepository } from "./prismaRepository";

const checksum = "b".repeat(64);
const fingerprint = "a".repeat(64);

async function cleanupKnowledgeFixture(input: Readonly<{
  knowledgeBaseId: string;
  ownerUserId: string;
}>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: input.knowledgeBaseId }
    });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: input.knowledgeBaseId }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: input.knowledgeBaseId }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: input.knowledgeBaseId } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { ownerUserId: input.ownerUserId }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersion: { ownerUserId: input.ownerUserId } }
    });
    await tx.knowledgeSourceVersion.deleteMany({
      where: { ownerUserId: input.ownerUserId }
    });
    await tx.knowledgeSource.deleteMany({ where: { ownerUserId: input.ownerUserId } });
  });
}

describe("Prisma Knowledge user-safe projection", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("projects V2 Source readiness without V1 documents or processing internals", async () => {
    const suffix = randomUUID();
    const ownerUserId = `knowledge-projection-owner-${suffix}`;
    const connectionId = `knowledge-projection-connection-${suffix}`;
    const providerModelId = `knowledge-projection-model-${suffix}`;
    const profileId = `knowledge-projection-profile-${suffix}`;
    const profileRevisionId = `knowledge-projection-profile-revision-${suffix}`;
    let knowledgeBaseId: string | null = null;

    await prisma.user.create({
      data: { displayName: "Knowledge projection owner", id: ownerUserId, status: "active" }
    });
    await prisma.providerConnection.create({
      data: { displayName: "Knowledge projection provider", family: "test", id: connectionId }
    });
    await prisma.providerModel.create({
      data: {
        capabilities: {},
        connectionId,
        defaultParams: {},
        displayName: "Knowledge projection model",
        id: providerModelId,
        modelClass: "embedding",
        modelId: `model-${suffix}`,
        provider: "test"
      }
    });
    await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
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
        vectorSpaceFingerprint: fingerprint
      }
    });

    try {
      const base = await prisma.knowledgeBase.create({
        data: {
          description: "Current operational references",
          name: "Projection fixture",
          ownerUserId
        },
        select: { id: true }
      });
      knowledgeBaseId = base.id;
      const generation = await prisma.knowledgeIndexGeneration.create({
        data: {
          activatedAt: new Date(),
          chunkingProfileVersion: 1,
          embeddingConfiguration: {},
          embeddingProviderModelId: providerModelId,
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

      for (const [ordinal, artifactState, errorCode] of [
        [1, "ready", null],
        [2, "processing", null],
        [3, "failed", "provider_payload_private"]
      ] as const) {
        const source = await prisma.knowledgeSource.create({
          data: { name: `Source ${ordinal}`, ownerUserId },
          select: { id: true }
        });
        const version = await prisma.knowledgeSourceVersion.create({
          data: {
            byteSize: ordinal * 100,
            checksum,
            fileName: `source-${ordinal}.md`,
            mimeType: "text/markdown",
            originalStorageKey: `knowledge-projection/${suffix}/${ordinal}`,
            ownerUserId,
            sourceId: source.id,
            versionNumber: 1
          },
          select: { id: true }
        });
        await prisma.knowledgeSourceIndexArtifact.create({
          data: artifactState === "ready" ? {
            chunkCount: 1,
            embeddedPassageCount: 1,
            normalizedTextByteSize: ordinal * 100,
            normalizedTextChecksum: checksum,
            normalizedTextStorageKey: `knowledge-projection/${suffix}/${ordinal}/normalized`,
            pageCount: 1,
            profileRevisionId,
            readyAt: new Date(),
            sourceVersionId: version.id,
            state: artifactState,
            warningCodes: ["partial_parse"]
          } : {
            errorCode,
            processingStage: artifactState === "processing" ? "queued" : undefined,
            profileRevisionId,
            sourceVersionId: version.id,
            state: artifactState
          }
        });
        await prisma.knowledgeSource.update({
          data: artifactState === "ready"
            ? { currentVersionId: version.id }
            : { pendingVersionId: version.id },
          where: { id: source.id }
        });
        await prisma.knowledgeBaseSource.create({
          data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
        });
      }

      const repository = createPrismaKnowledgeRepository(prisma);
      const projected = (await repository.listForUser(ownerUserId)).find(
        (entry) => entry.id === base.id
      );
      expect(projected).toMatchObject({
        sourceCount: 3,
        owned: true,
        purgeScheduledAt: null,
        readiness: {
          attentionSources: 1,
          processingSources: 1,
          readySources: 1,
          state: "needs_attention",
          supportReference: expect.stringMatching(/^K-[A-F0-9]{12}$/u),
          totalSources: 3
        },
        trashedAt: null
      });
      expect(Object.keys(projected ?? {}).sort()).toEqual([
        "archived",
        "deletionPending",
        "description",
        "id",
        "installationScope",
        "memberGroupNames",
        "name",
        "owned",
        "ownerDisplayName",
        "purgeScheduledAt",
        "readiness",
        "sourceCount",
        "trashed",
        "trashedAt",
        "updatedAt",
        "version"
      ]);
      const detail = await repository.getDetail(ownerUserId, base.id);
      expect(detail).toMatchObject({ publications: [], readiness: projected?.readiness });
      expect(JSON.stringify({ detail, projected })).not.toContain("provider_payload_private");
      expect(JSON.stringify({ detail, projected })).not.toContain(providerModelId);
      expect(JSON.stringify({ detail, projected })).not.toContain(generation.id);
      await expect(prisma.knowledgeDocument.count({
        where: { knowledgeBaseId: base.id }
      })).resolves.toBe(0);
    } finally {
      if (knowledgeBaseId) {
        await cleanupKnowledgeFixture({ knowledgeBaseId, ownerUserId });
      }
      // Profile revisions are intentionally immutable; the disposable stateful-test
      // database owns this profile fixture after its mutable Source/Base rows are removed.
      await prisma.user.deleteMany({ where: { id: ownerUserId } });
    }
  });
});
