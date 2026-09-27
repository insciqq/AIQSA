import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  KNOWLEDGE_SEARCH_BACKEND_KIND,
  KNOWLEDGE_SEARCH_MAPPING_VERSION,
  knowledgeSearchProjectionFingerprint
} from "../search/opensearch/contract";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION } from "./hierarchicalIndex";
import { readKnowledgeSearchHealth } from "./searchHealth";
import { retryFailedKnowledgeSearchProjections } from "./searchProjection";

const checksum = "a".repeat(64);
const rollback = "knowledge_search_projection_fixture_rollback";

type SourceFixture = Readonly<{ indexArtifactId: string; sourceId: string }>;

async function createSource(tx: Prisma.TransactionClient, input: Readonly<{
  now: Date;
  ownerUserId: string;
  profileRevisionId: string;
  state: "FAILED" | "READY";
  trashed?: boolean;
}>): Promise<SourceFixture> {
  const suffix = randomUUID();
  const sourceId = randomUUID();
  const sourceVersionId = randomUUID();
  const sourceArtifactId = randomUUID();
  const indexArtifactId = `knowledge-search-retry-hierarchy-${suffix}`;
  await tx.knowledgeSource.create({ data: {
    id: sourceId, name: "Synthetic retry Source", ownerUserId: input.ownerUserId,
    ...(input.trashed ? { trashedAt: input.now } : {})
  } });
  await tx.knowledgeSourceVersion.create({ data: {
    byteSize: 128, checksum, fileName: "synthetic.md", id: sourceVersionId,
    mimeType: "text/markdown", ownerUserId: input.ownerUserId, sourceId, versionNumber: 1
  } });
  await tx.knowledgeSource.update({ data: { currentVersionId: sourceVersionId }, where: { id: sourceId } });
  await tx.knowledgeSourceIndexArtifact.create({ data: {
    chunkCount: 1, embeddedPassageCount: 1, id: sourceArtifactId, normalizedTextByteSize: 128,
    normalizedTextChecksum: checksum, normalizedTextStorageKey: `knowledge-search-retry/${suffix}/normalized`,
    pageCount: 1, profileRevisionId: input.profileRevisionId, readyAt: input.now, sourceVersionId, state: "ready"
  } });
  await tx.knowledgeHierarchicalIndexArtifact.create({ data: {
    checksum, derivationMode: "normalized_v2", documentCount: 1, exactEntryCount: 1, id: indexArtifactId,
    passageCount: 1, readyAt: input.now, schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
    sectionCount: 1, sourceArtifactId, sourceVersionId, state: "ready"
  } });
  await tx.knowledgeSearchProjection.create({ data: {
    attemptCount: input.state === "FAILED" ? 24 : 1,
    backendKind: KNOWLEDGE_SEARCH_BACKEND_KIND, expectedPassageCount: 1, indexArtifactId,
    indexedPassageCount: input.state === "READY" ? 1 : 0,
    lastErrorCode: input.state === "FAILED" ? "opensearch_rate_limited" : null,
    mappingVersion: KNOWLEDGE_SEARCH_MAPPING_VERSION, projectionFingerprint: knowledgeSearchProjectionFingerprint({
      hierarchicalChecksum: checksum, indexArtifactId, passageCount: 1
    }),
    readyAt: input.state === "READY" ? input.now : null, state: input.state
  } });
  return { indexArtifactId, sourceId };
}

describe("Knowledge search projection targeted recovery", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("re-queues only failed projections of live sources and attributes failures to Sources and Bases", async () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    const search = { checkKnowledgeIndex: async () => undefined };
    await expect(prisma.$transaction(async (tx) => {
      const suffix = randomUUID();
      const ownerUserId = `knowledge-search-retry-owner-${suffix}`;
      const connectionId = `knowledge-search-retry-connection-${suffix}`;
      const modelId = randomUUID();
      const profileId = `knowledge-search-retry-profile-${suffix}`;
      const profileRevisionId = randomUUID();
      await tx.providerConnection.create({ data: { displayName: "Retry provider", family: "test", id: connectionId } });
      await tx.providerModel.create({ data: {
        capabilities: {}, connectionId, defaultParams: {}, displayName: "Retry embedding model", id: modelId,
        modelClass: "embedding", modelId: `retry-embedding-${suffix}`, provider: "test"
      } });
      await tx.knowledgeIndexProfile.create({ data: { id: profileId } });
      await tx.knowledgeIndexProfileRevision.create({ data: {
        activatedAt: now, chunkingProfileVersion: 1, egressPolicy: {}, embeddingConfiguration: {},
        embeddingProviderModelId: modelId, executionAuthority: "installation", id: profileRevisionId,
        preflightCheckedAt: now, preflightStatus: "ready", profileConfiguration: {}, profileId,
        revisionNumber: 1, targetDimension: 1_024, vectorSpaceFingerprint: "b".repeat(64)
      } });
      await tx.user.create({ data: { displayName: "Retry owner", id: ownerUserId, status: "active" } });
      const common = { now, ownerUserId, profileRevisionId };
      const healthy = await createSource(tx, { ...common, state: "READY" });
      const broken = await createSource(tx, { ...common, state: "READY" });
      const trashed = await createSource(tx, { ...common, state: "FAILED", trashed: true });
      for (const members of [[broken], [healthy, broken], [healthy]]) {
        const base = await tx.knowledgeBase.create({
          data: { name: "Synthetic retry Base", ownerUserId }, select: { id: true }
        });
        for (const member of members) {
          await tx.knowledgeBaseSource.create({
            data: { knowledgeBaseId: base.id, ownerUserId, sourceId: member.sourceId }
          });
        }
      }
      const client = tx as unknown as PrismaClient;
      const before = await readKnowledgeSearchHealth(tx as never, { now, search });

      await tx.knowledgeSearchProjection.update({
        data: { attemptCount: 24, indexedPassageCount: 0, lastErrorCode: "opensearch_rate_limited",
          readyAt: null, state: "FAILED" },
        where: { indexArtifactId: broken.indexArtifactId }
      });
      const failed = await readKnowledgeSearchHealth(tx as never, { now, search });
      expect(failed.failedProjections).toBe(before.failedProjections + 1);
      expect(failed.failedSources).toBe(before.failedSources + 1);
      expect(failed.failedBases).toBe(before.failedBases + 2);
      expect(failed.readyProjections).toBe(before.readyProjections - 1);

      const healthyBefore = await tx.knowledgeSearchProjection.findUniqueOrThrow({
        where: { indexArtifactId: healthy.indexArtifactId }
      });
      await expect(retryFailedKnowledgeSearchProjections(client, {
        indexArtifactIds: [healthy.indexArtifactId, broken.indexArtifactId, trashed.indexArtifactId],
        now
      })).resolves.toEqual({ retried: 1 });

      await expect(tx.knowledgeSearchProjection.findUniqueOrThrow({
        select: { attemptCount: true, lastErrorCode: true, nextAttemptAt: true, state: true },
        where: { indexArtifactId: broken.indexArtifactId }
      })).resolves.toEqual({ attemptCount: 0, lastErrorCode: null, nextAttemptAt: now, state: "PENDING" });
      await expect(tx.knowledgeSearchProjection.findUniqueOrThrow({
        where: { indexArtifactId: healthy.indexArtifactId }
      })).resolves.toEqual(healthyBefore);
      await expect(tx.knowledgeSearchProjection.findUniqueOrThrow({
        select: { state: true }, where: { indexArtifactId: trashed.indexArtifactId }
      })).resolves.toEqual({ state: "FAILED" });

      const recovered = await readKnowledgeSearchHealth(tx as never, { now, search });
      expect(recovered.failedProjections).toBe(before.failedProjections);
      expect(recovered.failedSources).toBe(before.failedSources);
      expect(recovered.failedBases).toBe(before.failedBases);
      expect(recovered.pendingProjections).toBe(before.pendingProjections + 1);
      throw new Error(rollback);
    }, { maxWait: 10_000, timeout: 60_000 })).rejects.toThrow(rollback);
  });
});
