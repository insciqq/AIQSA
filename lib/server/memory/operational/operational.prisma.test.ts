import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { memorySha256 } from "../persistence/lexical";
import { MEMORY_OPERATIONAL_COUNTER_KEYS } from "./counters";

afterAll(async () => {
  await prisma.$disconnect();
});

async function createOwner(): Promise<string> {
  const marker = `memory-operational-private-${randomUUID()}`;
  await prisma.user.create({
    data: {
      displayName: marker,
      email: `${marker}@example.test`,
      id: marker,
      status: "active"
    }
  });
  return marker;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

describe("Memory operational PostgreSQL contracts", () => {
  it("commits every current operational counter with the completed job", async () => {
    const userId = await createOwner();
    const jobId = randomUUID();
    const counters = Object.fromEntries(
      MEMORY_OPERATIONAL_COUNTER_KEYS.map((key) => [key, 1])
    );
    try {
      await prisma.memoryJob.create({
        data: {
          id: jobId,
          idempotencyFingerprint: memorySha256({ jobId, userId }),
          kind: "CONSOLIDATE_CANDIDATE",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "memory-operational-test-v1",
          state: "QUEUED",
          userId
        }
      });
      await prisma.memoryJob.update({
        data: {
          completedAt: new Date(),
          operationalCounters: counters,
          state: "SUCCEEDED"
        },
        where: { id: jobId }
      });
      const persisted = await prisma.memoryJob.findUniqueOrThrow({
        select: { operationalCounters: true, state: true },
        where: { id: jobId }
      });
      expect(persisted).toEqual({
        operationalCounters: counters,
        state: "SUCCEEDED"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects unknown or invalid durable operational values at the DB boundary", async () => {
    const userId = await createOwner();
    try {
      for (const operationalCounters of [{
        privateContent: "must-not-persist"
      }, {
        contextualGeneratedEn: 1
      }, {
        contextualFallbackGroundingInvalid: -1
      }, {
        contextualFallbackGroundingInvalid: 0.5
      }, {
        contextualFallbackSemanticallyUnsupported: 2_147_483_648
      }, {
        contextualFallbackSemanticallyUnsupported: "1"
      }]) {
        const jobId = randomUUID();
        await expect(prisma.memoryJob.create({
          data: {
            id: jobId,
            idempotencyFingerprint: memorySha256({ jobId, userId }),
            kind: "INDEX_HISTORY",
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            operationalCounters: operationalCounters as Prisma.InputJsonObject,
            pipelineVersion: "memory-operational-test-v1",
            state: "SUCCEEDED",
            userId
          }
        })).rejects.toThrow(/MemoryJob_operational_counters_check/u);
      }
    } finally {
      await cleanupOwner(userId);
    }
  });
});
