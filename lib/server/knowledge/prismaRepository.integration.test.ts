import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaAdminRepository } from "../auth/adminRepository";
import { createPrismaKnowledgeRepository } from "./prismaRepository";

const enabled = process.env.AIQSA_KNOWLEDGE_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const repository = createPrismaKnowledgeRepository(database);
const suffix = randomUUID();
const ownerId = `knowledge-owner-${suffix}`;
const memberId = `knowledge-member-${suffix}`;
const outsiderId = `knowledge-outsider-${suffix}`;
const adminId = `knowledge-admin-${suffix}`;
const staleOwnerId = `knowledge-stale-owner-${suffix}`;
const groupId = `knowledge-group-${suffix}`;
const otherGroupId = `knowledge-group-other-${suffix}`;
const connectionId = `knowledge-connection-${suffix}`;
const supportedModelId = `knowledge-embedding-1536-${suffix}`;
const unsupportedModelId = `knowledge-embedding-768-${suffix}`;

function embeddingActiveConfig(targetDimension: number) {
  return {
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    capabilities: {
      contextWindow: 32768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: targetDimension,
      providerFamily: "openai_compatible",
      queryInstructionTemplate: null,
      supportsMrl: false,
      targetDimension
    },
    modelClass: "embedding",
    upstreamModelId: `embedding-${targetDimension}`
  };
}

async function createBase(name: string): Promise<string> {
  const result = await repository.create(ownerId, {
    description: `${name} description`,
    embeddingDeploymentId: supportedModelId,
    name
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("knowledge base creation failed");
  return result.id;
}

integration("Knowledge Base Prisma repository", () => {
  beforeAll(async () => {
    await database.user.createMany({
      data: [
        {
          displayName: "Knowledge owner",
          email: `${ownerId}@example.test`,
          id: ownerId,
          role: "admin",
          status: "active"
        },
        {
          displayName: "Knowledge member",
          email: `${memberId}@example.test`,
          id: memberId,
          status: "active"
        },
        {
          displayName: "Knowledge outsider",
          email: `${outsiderId}@example.test`,
          id: outsiderId,
          status: "active"
        },
        {
          displayName: "Unrelated admin",
          email: `${adminId}@example.test`,
          id: adminId,
          role: "admin",
          status: "active"
        },
        {
          displayName: "Disabled Knowledge owner",
          email: `${staleOwnerId}@example.test`,
          id: staleOwnerId,
          status: "disabled"
        }
      ]
    });
    await database.group.createMany({
      data: [
        { id: groupId, name: `Knowledge group ${suffix}` },
        { id: otherGroupId, name: `Other Knowledge group ${suffix}` }
      ]
    });
    await database.userGroup.createMany({
      data: [
        { groupId, userId: ownerId },
        { groupId, userId: memberId }
      ]
    });
    const now = new Date();
    await database.providerConnection.create({
      data: {
        activatedAt: now,
        activeConfig: {
          allowPrivateNetwork: false,
          apiRoot: "https://embedding.example.test/v1"
        },
        activeVersion: 1,
        displayName: "Knowledge embedding destination",
        draftConfig: {},
        enabled: true,
        family: "openai_compatible",
        id: connectionId
      }
    });
    for (const [id, dimension] of [
      [supportedModelId, 1536],
      [unsupportedModelId, 768]
    ] as const) {
      await database.providerModel.create({
        data: {
          activatedAt: now,
          activeConfig: embeddingActiveConfig(dimension),
          activeVersion: 1,
          capabilities: embeddingActiveConfig(dimension).capabilities,
          connectionId,
          defaultParams: {},
          displayName: `Embedding ${dimension}`,
          draftConfig: {},
          enabled: true,
          id,
          modelClass: "embedding",
          modelId: `embedding-${dimension}`,
          provider: "openai_compatible"
        }
      });
    }
    await database.accessGrant.createMany({
      data: [
        { enabled: true, providerModelId: supportedModelId, userId: ownerId },
        { enabled: true, providerModelId: unsupportedModelId, userId: ownerId },
        { enabled: true, providerModelId: supportedModelId, userId: staleOwnerId }
      ]
    });
  });

  afterAll(async () => {
    const baseIds = (await database.knowledgeBase.findMany({
      select: { id: true },
      where: { ownerUserId: { in: [ownerId, staleOwnerId] } }
    })).map((base) => base.id);
    if (baseIds.length > 0) {
      await database.knowledgeBasePublication.deleteMany({
        where: { knowledgeBaseId: { in: baseIds } }
      });
      await database.knowledgeBase.updateMany({
        data: { activeIndexGenerationId: null },
        where: { id: { in: baseIds } }
      });
      await database.knowledgeDocument.updateMany({
        data: { currentVersionId: null },
        where: { knowledgeBaseId: { in: baseIds } }
      });
      await database.knowledgeChunk.deleteMany({
        where: { knowledgeBaseId: { in: baseIds } }
      });
      await database.knowledgeDocumentVersion.deleteMany({
        where: { knowledgeBaseId: { in: baseIds } }
      });
      await database.knowledgeDocument.deleteMany({
        where: { knowledgeBaseId: { in: baseIds } }
      });
      await database.knowledgeIndexGeneration.deleteMany({
        where: { knowledgeBaseId: { in: baseIds } }
      });
      await database.knowledgeBase.deleteMany({ where: { id: { in: baseIds } } });
    }
    await database.accessGrant.deleteMany({
      where: { userId: { in: [ownerId, memberId, outsiderId, adminId, staleOwnerId] } }
    });
    await database.providerModel.deleteMany({
      where: { id: { in: [supportedModelId, unsupportedModelId] } }
    });
    await database.providerConnection.deleteMany({ where: { id: connectionId } });
    await database.userGroup.deleteMany({
      where: { groupId: { in: [groupId, otherGroupId] } }
    });
    await database.group.deleteMany({ where: { id: { in: [groupId, otherGroupId] } } });
    await database.user.deleteMany({
      where: { id: { in: [ownerId, memberId, outsiderId, adminId, staleOwnerId] } }
    });
    await database.$disconnect();
  });

  it("requires an entitled embedding deployment and a committed index dimension", async () => {
    const ownerDeployments = await repository.listEmbeddingDeployments(ownerId);
    expect(ownerDeployments.map(({ id, indexSupported }) => ({ id, indexSupported })))
      .toEqual([
        { id: supportedModelId, indexSupported: true },
        { id: unsupportedModelId, indexSupported: false }
      ]);
    await expect(repository.listEmbeddingDeployments(outsiderId)).resolves.toEqual([]);
    await expect(repository.create(outsiderId, {
      description: "",
      embeddingDeploymentId: supportedModelId,
      name: "Not entitled"
    })).resolves.toEqual({ kind: "embedding_not_available" });
    await expect(repository.create(ownerId, {
      description: "",
      embeddingDeploymentId: unsupportedModelId,
      name: "Unsupported dimension"
    })).resolves.toEqual({ kind: "embedding_dimension_not_supported" });

    const baseId = await createBase("Pinned vector space");
    const detail = await repository.getDetail(ownerId, baseId);
    expect(detail).toMatchObject({
      activeGeneration: {
        embeddingDeployment: { id: supportedModelId, targetDimension: 1536 },
        indexedContentRevision: 0,
        vectorSpaceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u)
      },
      contentRevision: 0,
      owned: true,
      version: 1
    });
    expect(await database.knowledgeIndexGeneration.count({
      where: { knowledgeBaseId: baseId, status: "active" }
    })).toBe(1);
  });

  it("enforces private, group, installation, archive, and optimistic-version semantics", async () => {
    const baseId = await createBase("ACL matrix");
    await expect(repository.getDetail(memberId, baseId)).resolves.toBeNull();
    await expect(repository.getDetail(outsiderId, baseId)).resolves.toBeNull();
    await expect(repository.getDetail(adminId, baseId)).resolves.toBeNull();
    await expect(repository.update(outsiderId, baseId, {
      expectedVersion: 1,
      name: "Forbidden"
    })).resolves.toEqual({ kind: "not_found" });

    await expect(repository.publish({
      actorIsAdmin: false,
      groupId: otherGroupId,
      knowledgeBaseId: baseId,
      scope: "group",
      userId: ownerId
    })).resolves.toEqual({ kind: "forbidden" });
    const groupPublication = await repository.publish({
      actorIsAdmin: true,
      groupId,
      knowledgeBaseId: baseId,
      scope: "group",
      userId: ownerId
    });
    expect(groupPublication.kind).toBe("ok");
    expect((await repository.getDetail(memberId, baseId))?.owned).toBe(false);
    await expect(repository.getDetail(outsiderId, baseId)).resolves.toBeNull();
    await expect(repository.getDetail(adminId, baseId)).resolves.toBeNull();

    await database.group.update({ data: { archivedAt: new Date() }, where: { id: groupId } });
    await expect(repository.getDetail(memberId, baseId)).resolves.toBeNull();
    await database.group.update({ data: { archivedAt: null }, where: { id: groupId } });

    await expect(repository.update(ownerId, baseId, {
      archived: true,
      expectedVersion: 99
    })).resolves.toEqual({ kind: "version_conflict" });
    await expect(repository.update(ownerId, baseId, {
      archived: true,
      expectedVersion: 1
    })).resolves.toEqual({ kind: "ok" });
    await expect(repository.getDetail(memberId, baseId)).resolves.toBeNull();
    expect((await repository.getDetail(ownerId, baseId))?.archived).toBe(true);
    expect((await repository.listForUser(ownerId)).some((base) =>
      base.id === baseId && base.archived)).toBe(true);
    await expect(repository.update(ownerId, baseId, {
      archived: false,
      expectedVersion: 2,
      name: "ACL matrix restored"
    })).resolves.toEqual({ kind: "ok" });

    const installationPublication = await repository.publish({
      actorIsAdmin: true,
      groupId: null,
      knowledgeBaseId: baseId,
      scope: "installation",
      userId: ownerId
    });
    expect(installationPublication.kind).toBe("ok");
    expect(await repository.getDetail(outsiderId, baseId)).not.toBeNull();
    expect(await repository.getDetail(adminId, baseId)).not.toBeNull();
    if (installationPublication.kind !== "ok") throw new Error("installation publish failed");
    await expect(repository.revokePublication({
      actorIsAdmin: true,
      knowledgeBaseId: baseId,
      publicationId: installationPublication.publication.id,
      userId: adminId
    })).resolves.toEqual({ kind: "ok" });
    await expect(repository.getDetail(outsiderId, baseId)).resolves.toBeNull();
    await expect(repository.getDetail(adminId, baseId)).resolves.toBeNull();

    if (groupPublication.kind !== "ok") throw new Error("group publish failed");
    await expect(repository.revokePublication({
      actorIsAdmin: false,
      knowledgeBaseId: baseId,
      publicationId: groupPublication.publication.id,
      userId: memberId
    })).resolves.toEqual({ kind: "not_found" });
    await expect(repository.revokePublication({
      actorIsAdmin: false,
      knowledgeBaseId: baseId,
      publicationId: groupPublication.publication.id,
      userId: ownerId
    })).resolves.toEqual({ kind: "ok" });
    await expect(repository.getDetail(memberId, baseId)).resolves.toBeNull();
  });

  it("resolves historical document sets from visibility bounds, never the mutable pointer", async () => {
    const baseId = await createBase("Temporal revisions");
    const documentA = await database.knowledgeDocument.create({
      data: { knowledgeBaseId: baseId },
      select: { id: true }
    });
    const documentB = await database.knowledgeDocument.create({
      data: { knowledgeBaseId: baseId },
      select: { id: true }
    });
    const versionA1 = await database.knowledgeDocumentVersion.create({
      data: {
        byteSize: 10,
        checksum: "1".repeat(64),
        documentId: documentA.id,
        fileName: "a-v1.txt",
        ingestCompletedAt: new Date(),
        ingestState: "ready",
        knowledgeBaseId: baseId,
        mimeType: "text/plain",
        ownerUserId: ownerId,
        originalStorageKey: `knowledge/${suffix}/a-v1`,
        versionNumber: 1,
        visibleFromRevision: 1,
        visibleUntilRevision: 2
      }
    });
    const versionA2 = await database.knowledgeDocumentVersion.create({
      data: {
        byteSize: 11,
        checksum: "2".repeat(64),
        documentId: documentA.id,
        fileName: "a-v2.txt",
        ingestCompletedAt: new Date(),
        ingestState: "ready",
        knowledgeBaseId: baseId,
        mimeType: "text/plain",
        ownerUserId: ownerId,
        originalStorageKey: `knowledge/${suffix}/a-v2`,
        versionNumber: 2,
        visibleFromRevision: 2
      }
    });
    const versionB1 = await database.knowledgeDocumentVersion.create({
      data: {
        byteSize: 12,
        checksum: "3".repeat(64),
        documentId: documentB.id,
        fileName: "b-v1.txt",
        ingestCompletedAt: new Date(),
        ingestState: "ready",
        knowledgeBaseId: baseId,
        mimeType: "text/plain",
        ownerUserId: ownerId,
        originalStorageKey: `knowledge/${suffix}/b-v1`,
        versionNumber: 1,
        visibleFromRevision: 1
      }
    });
    await database.knowledgeDocument.update({
      data: { currentVersionId: versionA2.id },
      where: { id: documentA.id }
    });
    await database.knowledgeDocument.update({
      data: { currentVersionId: versionB1.id },
      where: { id: documentB.id }
    });
    await database.knowledgeBase.update({
      data: { contentRevision: 2 },
      where: { id: baseId }
    });

    expect((await repository.listVisibleDocumentVersions(baseId, 1)).map(({ id }) => id).sort())
      .toEqual([versionA1.id, versionB1.id].sort());
    expect((await repository.listVisibleDocumentVersions(baseId, 2)).map(({ id }) => id).sort())
      .toEqual([versionA2.id, versionB1.id].sort());

    await database.knowledgeDocument.update({
      data: { currentVersionId: versionA1.id },
      where: { id: documentA.id }
    });
    expect((await repository.listVisibleDocumentVersions(baseId, 2)).map(({ id }) => id).sort())
      .toEqual([versionA2.id, versionB1.id].sort());
  });

  it("blocks actual admin hard deletes for owned bases and base publications", async () => {
    const adminRepository = createPrismaAdminRepository(database);
    const owned = await repository.create(staleOwnerId, {
      description: "Hard-delete guard",
      embeddingDeploymentId: supportedModelId,
      name: "Retained Knowledge"
    });
    expect(owned.kind).toBe("ok");
    if (owned.kind !== "ok") throw new Error("guard fixture base creation failed");

    await expect(adminRepository.deleteStaleUser({
      actingAdminUserId: adminId,
      userId: staleOwnerId
    })).resolves.toBe("user_has_owned_data");
    expect(await database.user.count({ where: { id: staleOwnerId } })).toBe(1);

    const publication = await database.knowledgeBasePublication.create({
      data: {
        groupId: otherGroupId,
        knowledgeBaseId: owned.id,
        publishedByUserId: staleOwnerId,
        scope: "group"
      }
    });
    await expect(adminRepository.deleteEmptyGroup(otherGroupId)).resolves.toBe("group_has_grants");
    expect(await database.group.count({ where: { id: otherGroupId } })).toBe(1);
    await database.knowledgeBasePublication.delete({ where: { id: publication.id } });
  });
});
