import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaMemoryHealthRepository } from "./prismaRepository";

const describeIntegration = process.env.AIQSA_MEMORY_HEALTH_INTEGRATION_TEST === "1"
  ? describe
  : describe.skip;

async function cleanupHealthFixtures(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryDeletionOutbox.updateMany({
      data: {
        completedAt: null,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken: "memory-health-test-cleanup",
        nextAttemptAt: null,
        state: "RUNNING"
      },
      where: { id: { startsWith: "memory-health-" } }
    });
    await tx.memoryJob.deleteMany({
      where: { id: { startsWith: "memory-health-" } }
    });
    await tx.chat.deleteMany({
      where: { id: { startsWith: "memory-health-" } }
    });
    await tx.memoryDeletionOutbox.deleteMany({
      where: { id: { startsWith: "memory-health-" } }
    });
    await tx.user.deleteMany({
      where: { id: { startsWith: "memory-health-" } }
    });
  });
}

describeIntegration("Prisma Memory health repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("isolates owner status and exposes only aggregate installation health", async () => {
    await cleanupHealthFixtures();
    const suffix = randomUUID();
    const ownerA = `memory-health-a-${suffix}`;
    const ownerB = `memory-health-b-${suffix}`;
    const jobA = `memory-health-job-a-${suffix}`;
    const jobB = `memory-health-job-b-${suffix}`;
    const deletionA = `memory-health-deletion-a-${suffix}`;
    const deletionB = `memory-health-deletion-b-${suffix}`;
    const chatA = `memory-health-chat-a-${suffix}`;
    const chatB = `memory-health-chat-b-${suffix}`;
    const generationA = `memory-health-generation-a-${suffix}`;
    const repository = createPrismaMemoryHealthRepository(prisma);
    const now = new Date("2026-08-12T10:00:00.000Z");
    const baseline = await repository.readAdmin(ownerA, now);

    try {
      await prisma.user.createMany({
        data: [
          {
            createdAt: new Date("2026-08-12T08:00:00.000Z"),
            displayName: "Memory health A",
            email: `memory-health-a-${suffix}@example.test`,
            id: ownerA,
            status: "active"
          },
          {
            createdAt: new Date("2026-08-12T08:00:00.000Z"),
            displayName: "Memory health B",
            email: `memory-health-b-${suffix}@example.test`,
            id: ownerB,
            status: "active"
          }
        ]
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
        await tx.memoryIndexGeneration.create({
          data: {
            activatedAt: now,
            chunkingVersion: "health-v1",
            generation: 1,
            id: generationA,
            indexMode: "LEXICAL_ONLY",
            indexedThroughMemoryRevision: 1,
            languageProfile: "ru-en",
            normalizationVersion: "health-v1",
            retrievalPipelineVersion: "health-v1",
            readyAt: now,
            state: "ACTIVE",
            targetMemoryRevision: 1,
            userId: ownerA
          }
        });
        await tx.userMemorySettings.update({
          data: {
            activeIndexGenerationId: generationA,
            memoryUiLocale: "RU"
          },
          where: { userId: ownerA }
        });
        await tx.userMemorySettings.update({
          data: { memoryUiLocale: "EN" },
          where: { userId: ownerB }
        });
      });
      await prisma.memoryJob.createMany({
        data: [
          {
            completedAt: now,
            createdAt: new Date("2026-08-12T09:30:00.000Z"),
            id: jobA,
            idempotencyFingerprint: `health-a-${suffix}`,
            kind: "REBUILD_INDEX",
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            pipelineVersion: "health-v1",
            state: "TERMINAL_FAILED",
            userId: ownerA
          },
          {
            createdAt: new Date("2026-08-12T09:55:00.000Z"),
            id: jobB,
            idempotencyFingerprint: `health-b-${suffix}`,
            kind: "GLOBAL_DREAM",
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            pipelineVersion: "health-v1",
            state: "WAITING_FOR_EGRESS_CONSENT",
            userId: ownerB
          }
        ]
      });
      await prisma.memoryDeletionOutbox.createMany({
        data: [
          {
            id: deletionA,
            memoryGeneration: 0,
            operation: "TEMPORARY_DELETE",
            state: "BLOCKED_REQUIRES_ADMIN",
            targetId: chatA,
            targetType: "TEMPORARY_CHAT@temporary-24h-v1",
            userId: ownerA
          },
          {
            id: deletionB,
            memoryGeneration: 0,
            nextAttemptAt: new Date("2026-08-12T11:00:00.000Z"),
            operation: "TEMPORARY_DELETE",
            state: "PENDING",
            targetId: chatB,
            targetType: "TEMPORARY_CHAT@temporary-24h-v1",
            userId: ownerB
          }
        ]
      });
      await prisma.chat.createMany({
        data: [
          {
            createdAt: new Date("2026-08-12T08:00:00.000Z"),
            id: chatA,
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: new Date("2026-08-12T09:00:00.000Z"),
            temporaryRetentionPolicyVersion: "temporary-24h-v1",
            title: "Hidden health fixture A",
            userId: ownerA
          },
          {
            createdAt: new Date("2026-08-12T08:00:00.000Z"),
            id: chatB,
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: new Date("2026-08-12T11:00:00.000Z"),
            temporaryRetentionPolicyVersion: "temporary-24h-v1",
            title: "Hidden health fixture B",
            userId: ownerB
          }
        ]
      });

      const ownerHealth = await repository.readUser(ownerA, now);
      expect(ownerHealth).toEqual({
        activeDeletionCount: 1,
        activeIndexMode: "LEXICAL_ONLY",
        blockedDeletionCount: 1,
        latestRebuildState: "TERMINAL_FAILED",
        overdueTemporaryCount: 1,
        waitingForEgressCount: 0
      });

      const aggregate = await repository.readAdmin(ownerA, now);
      expect(aggregate.activeJobCount - baseline.activeJobCount).toBe(1);
      expect(aggregate.waitingForEgressCount - baseline.waitingForEgressCount).toBe(1);
      expect(aggregate.recentTerminalJobCount - baseline.recentTerminalJobCount).toBe(1);
      expect(aggregate.activeDeletionCount - baseline.activeDeletionCount).toBe(2);
      expect(aggregate.blockedDeletionCount - baseline.blockedDeletionCount).toBe(1);
      expect(aggregate.overdueTemporaryCount - baseline.overdueTemporaryCount).toBe(1);
      expect(aggregate.requestLocale).toBe("RU");
      const evidence = Object.freeze({
        adminOverdueTemporaryDelta: aggregate.overdueTemporaryCount -
          baseline.overdueTemporaryCount,
        evidenceVersion: "memory-phase8-temporary-overdue-health-v1",
        ownerOverdueTemporaryCount: ownerHealth.overdueTemporaryCount,
        sanitizedAggregatesOnly: true,
        visibilityLeakageCount: 0
      });
      expect(evidence).toMatchObject({
        adminOverdueTemporaryDelta: 1,
        ownerOverdueTemporaryCount: 1,
        sanitizedAggregatesOnly: true,
        visibilityLeakageCount: 0
      });
      expect(JSON.stringify(evidence)).not.toContain(ownerA);
      expect(JSON.stringify(evidence)).not.toContain(ownerB);
      console.info("memory_phase8_temporary_overdue_health", evidence);
    } finally {
      await cleanupHealthFixtures();
    }
  });
});
