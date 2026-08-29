import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  KNOWLEDGE_SEARCH_BACKEND_KIND,
  KNOWLEDGE_SEARCH_MAPPING_VERSION
} from "../search/opensearch/contract";
import { createPrismaKnowledgeDeletionProcessor } from "./deletionProcessor";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION } from "./hierarchicalIndex";

const checksum = "a".repeat(64);

describe("Knowledge OpenSearch projection deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps canonical Source state retryable until OpenSearch deletion succeeds", async () => {
    const suffix = randomUUID();
    const now = new Date("2026-08-29T12:00:00.000Z");
    const ownerUserId = `knowledge-search-delete-owner-${suffix}`;
    const connectionId = `knowledge-search-delete-connection-${suffix}`;
    const modelId = randomUUID();
    const profileId = `knowledge-search-delete-profile-${suffix}`;
    const profileRevisionId = randomUUID();
    const sourceId = randomUUID();
    const sourceVersionId = randomUUID();
    const sourceArtifactId = randomUUID();
    const indexArtifactId = `knowledge-search-delete-hierarchy-${suffix}`;
    const deletionJobId = randomUUID();
    const normalizedStorageKey = `knowledge-search-delete/${suffix}/normalized`;
    const firstClaimToken = randomUUID();

    await prisma.providerConnection.create({
      data: { displayName: "Search deletion provider", family: "test", id: connectionId }
    });
    await prisma.providerModel.create({
      data: {
        capabilities: {},
        connectionId,
        defaultParams: {},
        displayName: "Search deletion embedding model",
        id: modelId,
        modelClass: "embedding",
        modelId: `search-deletion-embedding-${suffix}`,
        provider: "test"
      }
    });
    await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: now,
        chunkingProfileVersion: 1,
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
        vectorSpaceFingerprint: "b".repeat(64)
      }
    });
    await prisma.user.create({
      data: { displayName: "Search deletion owner", id: ownerUserId, status: "active" }
    });
    await prisma.knowledgeSource.create({
      data: {
        deletionRequestedAt: now,
        id: sourceId,
        name: "Search deletion Source",
        ownerUserId,
        trashedAt: now
      }
    });
    await prisma.knowledgeSourceVersion.create({
      data: {
        byteSize: 128,
        checksum,
        fileName: "search-deletion.md",
        id: sourceVersionId,
        mimeType: "text/markdown",
        ownerUserId,
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
        chunkCount: 1,
        embeddedPassageCount: 1,
        id: sourceArtifactId,
        normalizedTextByteSize: 128,
        normalizedTextChecksum: checksum,
        normalizedTextStorageKey: normalizedStorageKey,
        pageCount: 1,
        profileRevisionId,
        readyAt: now,
        sourceVersionId,
        state: "ready"
      }
    });
    await prisma.knowledgeHierarchicalIndexArtifact.create({
      data: {
        checksum,
        derivationMode: "normalized_v2",
        documentCount: 1,
        exactEntryCount: 1,
        id: indexArtifactId,
        passageCount: 1,
        readyAt: now,
        schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
        sectionCount: 1,
        sourceArtifactId,
        sourceVersionId,
        state: "ready"
      }
    });
    await prisma.knowledgeSearchProjection.create({
      data: {
        backendKind: KNOWLEDGE_SEARCH_BACKEND_KIND,
        expectedPassageCount: 1,
        indexArtifactId,
        indexedPassageCount: 1,
        mappingVersion: KNOWLEDGE_SEARCH_MAPPING_VERSION,
        projectionFingerprint: "c".repeat(64),
        readyAt: now,
        state: "READY"
      }
    });
    await prisma.knowledgeDeletionJob.create({
      data: {
        attemptCount: 1,
        claimedAt: now,
        claimToken: firstClaimToken,
        id: deletionJobId,
        lastAttemptAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        nextAttemptAt: now,
        ownerUserId,
        state: "RUNNING",
        targetId: sourceId,
        targetType: "SOURCE"
      }
    });

    const searchDeletionCalls: string[][] = [];
    try {
      const failing = createPrismaKnowledgeDeletionProcessor(prisma, async (ids) => {
        searchDeletionCalls.push([...ids]);
        throw new Error("opensearch_unavailable");
      });
      await expect(failing.process({
        claimToken: firstClaimToken,
        id: deletionJobId,
        ownerUserId,
        targetId: sourceId,
        targetType: "SOURCE"
      }, now)).rejects.toThrow("opensearch_unavailable");

      await expect(prisma.knowledgeDeletionJob.findUnique({
        select: { claimToken: true, lastErrorCode: true, state: true },
        where: { id: deletionJobId }
      })).resolves.toEqual({
        claimToken: null,
        lastErrorCode: "knowledge_purge_failed",
        state: "RETRY_WAIT"
      });
      await expect(prisma.knowledgeSource.findUnique({
        select: { currentVersionId: true },
        where: { id: sourceId }
      })).resolves.toEqual({ currentVersionId: sourceVersionId });
      await expect(prisma.knowledgeSearchProjection.findUnique({
        select: { state: true },
        where: { indexArtifactId }
      })).resolves.toEqual({ state: "DELETING" });

      const retryClaimToken = randomUUID();
      const retryAt = new Date(now.getTime() + 60_000);
      await prisma.knowledgeDeletionJob.update({
        data: {
          claimedAt: retryAt,
          claimToken: retryClaimToken,
          lastAttemptAt: retryAt,
          lastErrorCode: null,
          leaseExpiresAt: new Date(retryAt.getTime() + 60_000),
          state: "RUNNING"
        },
        where: { id: deletionJobId }
      });
      const succeeding = createPrismaKnowledgeDeletionProcessor(prisma, async (ids) => {
        searchDeletionCalls.push([...ids]);
      });
      await expect(succeeding.process({
        claimToken: retryClaimToken,
        id: deletionJobId,
        ownerUserId,
        targetId: sourceId,
        targetType: "SOURCE"
      }, retryAt)).resolves.toBe("waiting_for_objects");

      expect(searchDeletionCalls).toEqual([[indexArtifactId], [indexArtifactId]]);
      await expect(prisma.knowledgeSource.findUnique({ where: { id: sourceId } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeSearchProjection.findUnique({
        where: { indexArtifactId }
      })).resolves.toBeNull();
      await expect(prisma.knowledgeDeletionObject.findMany({
        select: { disposition: true, storageKey: true },
        where: { knowledgeDeletionJobId: deletionJobId }
      })).resolves.toEqual([{ disposition: "PENDING", storageKey: normalizedStorageKey }]);
    } finally {
      await prisma.knowledgeDeletionObject.deleteMany({
        where: { knowledgeDeletionJobId: deletionJobId }
      });
      await prisma.knowledgeDeletionJob.deleteMany({ where: { id: deletionJobId } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: normalizedStorageKey } });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
        await tx.knowledgeSource.updateMany({
          data: { currentVersionId: null, pendingVersionId: null },
          where: { id: sourceId }
        });
        await tx.knowledgeHierarchicalIndexArtifact.deleteMany({
          where: { sourceArtifactId }
        });
        await tx.knowledgeSourceIndexArtifact.deleteMany({ where: { id: sourceArtifactId } });
        await tx.knowledgeSourceVersion.deleteMany({ where: { id: sourceVersionId } });
        await tx.knowledgeSource.deleteMany({ where: { id: sourceId } });
        await tx.user.deleteMany({ where: { id: ownerUserId } });
      });
    }
  });
});
