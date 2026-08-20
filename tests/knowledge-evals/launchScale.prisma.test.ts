import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaKnowledgeRepository } from "../../lib/server/knowledge/prismaRepository";
import {
  createPrismaKnowledgeSourceLibraryRepository
} from "../../lib/server/knowledge/sourceLibraryRepository";
import { prisma } from "../../lib/server/prisma";

const SOURCE_COUNT = 500;
const PRIVATE_BASE_COUNT = 64;
const SAMPLE_COUNT = 10;
const LIST_P95_GATE_MS = 500;
const fingerprint = "e".repeat(64);

type ScaleFixture = Readonly<{
  allBaseIds: readonly string[];
  allOwnerIds: readonly string[];
  artifactIds: readonly string[];
  connectionId: string;
  generationIds: readonly string[];
  modelId: string;
  ownerBaseIds: readonly string[];
  ownerUserId: string;
  profileId: string;
  profileRevisionId: string;
  sourceIds: readonly string[];
  sourceVersionIds: readonly string[];
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function updateInBatches<T>(
  values: readonly T[],
  operation: (value: T) => Promise<unknown>
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += 100) {
    await Promise.all(values.slice(offset, offset + 100).map(operation));
  }
}

async function createFixture(): Promise<ScaleFixture> {
  const prefix = `knowledge-launch-scale-${randomUUID()}`;
  const ownerUserId = `${prefix}-owner`;
  const privateOwnerIds = Array.from(
    { length: PRIVATE_BASE_COUNT },
    (_, index) => `${prefix}-private-owner-${index}`
  );
  const allOwnerIds = [ownerUserId, ...privateOwnerIds];
  const connectionId = `${prefix}-connection`;
  const modelId = `${prefix}-model`;
  const profileId = `${prefix}-profile`;
  const profileRevisionId = `${prefix}-profile-revision`;
  const ownerBaseIds = Array.from({ length: 4 }, (_, index) => `${prefix}-base-${index}`);
  const privateBaseIds = privateOwnerIds.map((_, index) => `${prefix}-private-base-${index}`);
  const allBaseIds = [...ownerBaseIds, ...privateBaseIds];
  const generationIds = allBaseIds.map((_, index) => `${prefix}-generation-${index}`);
  const ownerSourceIds = Array.from(
    { length: SOURCE_COUNT },
    (_, index) => `${prefix}-source-${index}`
  );
  const privateSourceIds = privateOwnerIds.map((_, index) => `${prefix}-private-source-${index}`);
  const sourceIds = [...ownerSourceIds, ...privateSourceIds];
  const sourceVersionIds = sourceIds.map((_, index) => `${prefix}-version-${index}`);
  const artifactIds = sourceIds.map((_, index) => `${prefix}-artifact-${index}`);
  const now = new Date("2026-08-19T00:00:00.000Z");

  await prisma.user.createMany({
    data: allOwnerIds.map((id, index) => ({
      displayName: index === 0 ? "Launch scale owner" : `Private owner ${index}`,
      id,
      status: "active" as const
    }))
  });
  await prisma.providerConnection.create({
    data: { displayName: "Launch scale embeddings", family: "test", id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Launch scale embedding model",
      id: modelId,
      modelClass: "embedding",
      modelId: `${prefix}-embedding`,
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
      targetDimension: 1024,
      vectorSpaceFingerprint: fingerprint
    }
  });
  await prisma.knowledgeIndexProfile.update({
    data: { activeRevisionId: profileRevisionId },
    where: { id: profileId }
  });
  await prisma.knowledgeBase.createMany({
    data: allBaseIds.map((id, index) => ({
      id,
      name: index < ownerBaseIds.length
        ? `Launch Base ${index + 1}`
        : `Private Base ${index - ownerBaseIds.length + 1}`,
      ownerUserId: index < ownerBaseIds.length
        ? ownerUserId
        : privateOwnerIds[index - ownerBaseIds.length]!
    }))
  });
  await prisma.knowledgeIndexGeneration.createMany({
    data: allBaseIds.map((knowledgeBaseId, index) => ({
      activatedAt: now,
      chunkingProfileVersion: 1,
      embeddingConfiguration: {},
      embeddingProviderModelId: modelId,
      id: generationIds[index]!,
      indexedContentRevision: 0,
      knowledgeBaseId,
      profileRevisionId,
      readyAt: now,
      status: "active" as const,
      targetDimension: 1024,
      vectorSpaceFingerprint: fingerprint
    }))
  });
  await updateInBatches(allBaseIds, (id) => prisma.knowledgeBase.update({
    data: { activeIndexGenerationId: generationIds[allBaseIds.indexOf(id)]! },
    where: { id }
  }));

  const sourceOwners = [
    ...ownerSourceIds.map(() => ownerUserId),
    ...privateOwnerIds
  ];
  await prisma.knowledgeSource.createMany({
    data: sourceIds.map((id, index) => ({
      description: "Synthetic launch-scale source",
      id,
      name: index < SOURCE_COUNT
        ? `Launch Source ${String(index + 1).padStart(4, "0")}`
        : `Private Source ${index - SOURCE_COUNT + 1}`,
      ownerUserId: sourceOwners[index]!,
      tags: ["launch-scale"]
    }))
  });
  await prisma.knowledgeSourceVersion.createMany({
    data: sourceVersionIds.map((id, index) => ({
      byteSize: 128,
      checksum: sha256(`${prefix}:source:${index}`),
      fileName: `source-${index + 1}.txt`,
      id,
      mimeType: "text/plain",
      ownerUserId: sourceOwners[index]!,
      sourceId: sourceIds[index]!,
      versionNumber: 1
    }))
  });
  await updateInBatches(sourceIds, (id) => prisma.knowledgeSource.update({
    data: { currentVersionId: sourceVersionIds[sourceIds.indexOf(id)]! },
    where: { id }
  }));
  await prisma.knowledgeSourceIndexArtifact.createMany({
    data: artifactIds.map((id, index) => ({
      chunkCount: 1,
      embeddedPassageCount: 1,
      id,
      normalizedTextByteSize: 64,
      normalizedTextChecksum: sha256(`${prefix}:normalized:${index}`),
      normalizedTextStorageKey: `${prefix}/normalized/${index}.json`,
      pageCount: 1,
      profileRevisionId,
      readyAt: now,
      sourceVersionId: sourceVersionIds[index]!,
      state: "ready" as const
    }))
  });
  const ownerMemberships = ownerSourceIds.flatMap((sourceId, index) => [
    { knowledgeBaseId: ownerBaseIds[0]!, ownerUserId, sourceId },
    ...(index % 2 === 0
      ? [{ knowledgeBaseId: ownerBaseIds[1]!, ownerUserId, sourceId }]
      : []),
    ...(index % 4 === 0
      ? [{ knowledgeBaseId: ownerBaseIds[2]!, ownerUserId, sourceId }]
      : []),
    ...(index % 8 === 0
      ? [{ knowledgeBaseId: ownerBaseIds[3]!, ownerUserId, sourceId }]
      : [])
  ]);
  await prisma.knowledgeBaseSource.createMany({
    data: [
      ...ownerMemberships,
      ...privateSourceIds.map((sourceId, index) => ({
        knowledgeBaseId: privateBaseIds[index]!,
        ownerUserId: privateOwnerIds[index]!,
        sourceId
      }))
    ]
  });

  return {
    allBaseIds,
    allOwnerIds,
    artifactIds,
    connectionId,
    generationIds,
    modelId,
    ownerBaseIds,
    ownerUserId,
    profileId,
    profileRevisionId,
    sourceIds,
    sourceVersionIds
  };
}

async function cleanupFixture(fixture: ScaleFixture): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { id: { in: [...fixture.artifactIds] } }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: { in: [...fixture.allBaseIds] } }
    });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: [...fixture.allBaseIds] } }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { id: { in: [...fixture.generationIds] } }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: { in: [...fixture.allBaseIds] } } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null },
      where: { id: { in: [...fixture.sourceIds] } }
    });
    await tx.knowledgeSourceVersion.deleteMany({
      where: { id: { in: [...fixture.sourceVersionIds] } }
    });
    await tx.knowledgeSource.deleteMany({ where: { id: { in: [...fixture.sourceIds] } } });
    await tx.user.deleteMany({ where: { id: { in: [...fixture.allOwnerIds] } } });
  }, { timeout: 120_000 });
}

describe("Knowledge launch-scale catalog", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps 500 Sources and many private Bases responsive and scope-isolated", async () => {
    const fixture = await createFixture();
    try {
      const sourceRepository = createPrismaKnowledgeSourceLibraryRepository(prisma);
      const baseRepository = createPrismaKnowledgeRepository(prisma);
      const listSources = () => sourceRepository.listForUser({
        filter: "all",
        page: 1,
        pageSize: 50,
        query: "Launch Source",
        userId: fixture.ownerUserId
      });

      const warmSources = await listSources();
      const warmBases = await baseRepository.listForUser(fixture.ownerUserId);
      expect(warmSources).toMatchObject({
        pagination: { totalItems: SOURCE_COUNT, totalPages: 10 }
      });
      expect(warmSources.sources).toHaveLength(50);
      expect(warmBases.filter(({ id }) => fixture.ownerBaseIds.includes(id)))
        .toHaveLength(fixture.ownerBaseIds.length);
      expect(warmBases.some(({ id }) => fixture.allBaseIds
        .slice(fixture.ownerBaseIds.length).includes(id))).toBe(false);
      await expect(sourceRepository.listForUser({
        filter: "all",
        page: 1,
        pageSize: 50,
        query: "Private Source",
        userId: fixture.ownerUserId
      })).resolves.toMatchObject({ pagination: { totalItems: 0 }, sources: [] });
      expect(warmBases.find(({ id }) => id === fixture.ownerBaseIds[0])).toMatchObject({
        readiness: { readySources: SOURCE_COUNT, state: "ready", totalSources: SOURCE_COUNT },
        sourceCount: SOURCE_COUNT
      });

      const sourceLatencies: number[] = [];
      const baseLatencies: number[] = [];
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        let startedAt = performance.now();
        await listSources();
        sourceLatencies.push(performance.now() - startedAt);
        startedAt = performance.now();
        await baseRepository.listForUser(fixture.ownerUserId);
        baseLatencies.push(performance.now() - startedAt);
      }
      const sourceP95Ms = percentile(sourceLatencies, 0.95);
      const baseP95Ms = percentile(baseLatencies, 0.95);
      expect(sourceP95Ms).toBeLessThanOrEqual(LIST_P95_GATE_MS);
      expect(baseP95Ms).toBeLessThanOrEqual(LIST_P95_GATE_MS);
      const privateOwnerBases = await baseRepository.listForUser(fixture.allOwnerIds[1]!);
      expect(privateOwnerBases.filter(({ id }) => fixture.allBaseIds.includes(id))).toEqual([
        expect.objectContaining({
          id: fixture.allBaseIds[fixture.ownerBaseIds.length],
          owned: true,
          sourceCount: 1
        })
      ]);

      console.info("knowledge_launch_scale", {
        baseListP95Ms: round(baseP95Ms),
        ownerBaseCount: fixture.ownerBaseIds.length,
        privateBaseCount: PRIVATE_BASE_COUNT,
        samples: SAMPLE_COUNT,
        sourceCount: SOURCE_COUNT,
        sourceListP95Ms: round(sourceP95Ms)
      });
    } finally {
      await cleanupFixture(fixture);
    }
  }, 120_000);
});
