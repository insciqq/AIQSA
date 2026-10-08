import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import {
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "../../memory/persistence/lexical";
import { parseMemoryRebuildJobFingerprint } from "../../memory/rebuild/contract";
import { createPrismaMemoryRebuildRepository } from "../../memory/rebuild/repository";
import { readMemoryRebuildLoad } from "./memoryRebuilds";

const DAY_MS = 24 * 3_600_000;
const rebuilds = createPrismaMemoryRebuildRepository(prisma);

async function createOwner(label: string): Promise<string> {
  const suffix = randomUUID();
  const userId = `health-memory-rebuilds-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Health Memory rebuilds",
      email: `health-memory-rebuilds-${label}-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  return userId;
}

/** One admitted full rebuild, cancelled so that the next one can be admitted. */
async function admitRebuild(userId: string): Promise<string> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const admitted = await rebuilds.admit(userId, {
    expectedMemoryRevision: settings.memoryRevision,
    expectedSettingsRevision: settings.settingsRevision,
    operation: "REBUILD_SEARCH_INDEX",
    requestIdentity: { nonce: randomUUID() }
  });
  if (admitted.kind !== "ok") throw new Error(`health_rebuild_${admitted.kind}`);
  await rebuilds.cancel(userId, admitted.jobId);
  const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: admitted.jobId } });
  const identity = parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint);
  if (!identity) throw new Error("health_rebuild_generation_missing");
  return identity.generationId;
}

function load(now: Date) {
  return readMemoryRebuildLoad(prisma, { now, threshold: 3, windowMs: DAY_MS });
}

describe("Health Memory rebuild counts", () => {
  const owners: string[] = [];

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await prisma.$disconnect();
  });

  it("counts admitted rebuilds per owner inside the window, never compatible clones", async () => {
    const before = await load(new Date());
    const repeated = await createOwner("repeated");
    const single = await createOwner("single");
    owners.push(repeated, single);

    const backdated = await admitRebuild(repeated);
    await admitRebuild(repeated);
    await admitRebuild(repeated);
    await admitRebuild(repeated);
    await admitRebuild(single);
    await prisma.memoryIndexGeneration.update({
      data: { createdAt: new Date(Date.now() - DAY_MS - 60_000) },
      where: { id: backdated }
    });
    // A shadow without a REBUILD_INDEX admission, as a compatible clone leaves one.
    const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: single } });
    const highest = await prisma.memoryIndexGeneration.aggregate({
      _max: { generation: true },
      where: { userId: single }
    });
    await prisma.memoryIndexGeneration.create({
      data: {
        chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
        generation: (highest._max.generation ?? 0) + 1,
        indexMode: "LEXICAL_ONLY",
        indexedThroughMemoryRevision: 0,
        languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
        normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
        retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
        sourceIndexGenerationId: settings.activeIndexGenerationId,
        state: "CANCELLED",
        targetMemoryRevision: settings.memoryRevision,
        userId: single
      }
    });

    // Five admissions and a clone: the backdated admission and the clone stay out.
    const after = await load(new Date());
    expect(after.rebuilds - before.rebuilds).toBe(4);
    expect(after.owners - before.owners).toBe(2);
    expect(after.ownersAtThreshold - before.ownersAtThreshold).toBe(1);
    expect(after.maxPerOwner).toBeGreaterThanOrEqual(3);
  });
});
