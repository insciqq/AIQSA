import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { memorySha256 } from "../persistence/lexical";
import { loadMemorySemanticCutoverInventory } from "./cutover";
import { loadMemoryOperationalSnapshot } from "./snapshot";

const from = new Date("2099-01-01T00:00:00.000Z");
const completedAt = new Date("2099-01-01T00:00:03.000Z");
const to = new Date("2099-01-01T00:01:00.000Z");

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
  it("reports only aggregate counters and inventories retired work", async () => {
    const userId = await createOwner();
    const jobId = randomUUID();
    try {
      const beforeInventory = await loadMemorySemanticCutoverInventory(prisma);
      await prisma.memoryJob.create({
        data: {
          createdAt: new Date("2099-01-01T00:00:01.000Z"),
          id: jobId,
          idempotencyFingerprint: memorySha256({ jobId, userId }),
          kind: "CONSOLIDATE_CANDIDATE",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "memory-operational-private-pipeline-v1",
          state: "QUEUED",
          userId
        }
      });

      const queuedInventory = await loadMemorySemanticCutoverInventory(prisma);
      expect(queuedInventory.legacyNonterminalJobs)
        .toBe(beforeInventory.legacyNonterminalJobs + 1);
      expect(queuedInventory.total).toBe(beforeInventory.total + 1);

      await prisma.memoryJob.update({
        data: {
          completedAt,
          operationalCounters: {
            digestIncremental: 1,
            digestNoop: 2,
            historyChunksBuilt: 3,
            historyChunksReplaced: 4,
            historyMessagesProjected: 5
          },
          state: "SUCCEEDED"
        },
        where: { id: jobId }
      });

      const snapshot = await loadMemoryOperationalSnapshot(prisma, { from, to });
      expect(snapshot.history).toEqual({
        chunksBuilt: 3,
        chunksReplaced: 4,
        digestFullRebuild: 0,
        digestIncremental: 1,
        digestNoop: 2,
        messagesProjected: 5
      });
      expect(snapshot.latencies).toContainEqual({
        p50Ms: 2_000,
        p95Ms: 2_000,
        samples: 1,
        stage: "job.CONSOLIDATE_CANDIDATE"
      });
      const serialized = JSON.stringify({ queuedInventory, snapshot });
      expect(serialized).not.toContain(userId);
      expect(serialized).not.toContain("memory-operational-private-pipeline-v1");
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects non-allowlisted durable operational values at the DB boundary", async () => {
    const userId = await createOwner();
    const jobId = randomUUID();
    try {
      await expect(prisma.memoryJob.create({
        data: {
          id: jobId,
          idempotencyFingerprint: memorySha256({ jobId, userId }),
          kind: "INDEX_HISTORY",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          operationalCounters: {
            privateContent: "must-not-persist"
          } as Prisma.InputJsonObject,
          pipelineVersion: "memory-operational-test-v1",
          state: "SUCCEEDED",
          userId
        }
      })).rejects.toThrow(/MemoryJob_operational_counters_check/u);
    } finally {
      await cleanupOwner(userId);
    }
  });
});
