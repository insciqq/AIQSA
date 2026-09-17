import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaAdminMemoryStatusRepository } from "./statusRepository";

vi.mock("./processingRepository", () => ({
  readAdminMemoryProcessing: async () => ({ enabled: true, issues: [] })
}));

describe("administrator Memory queue aggregates", () => {
  afterAll(() => prisma.$disconnect());

  it.each(["disabled", "pending", "denied"] as const)(
    "excludes an unavailable index for a %s owner until activation without changing retained settings",
    async (status) => {
      const userId = `memory-index-status-${randomUUID()}`;
      const repository = createPrismaAdminMemoryStatusRepository(prisma, async () => undefined);
      const now = new Date();
      const before = await repository.read(now);
      await prisma.user.create({ data: { id: userId, displayName: "Index status fixture", status } });
      try {
        const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
        expect((await repository.read(now)).index).toEqual(before.index);

        await prisma.user.update({ where: { id: userId }, data: { status: "active" } });
        const active = await repository.read(now);
        expect(active.index.ownerCount).toBe(before.index.ownerCount + 1);
        expect(active.index.requiresRebuild).toBe(true);
        expect(active.index.rebuildCandidates).toContainEqual(expect.objectContaining({
          operation: "REBUILD_SEARCH_INDEX", userId
        }));

        await prisma.user.update({ where: { id: userId }, data: { status } });
        expect((await repository.read(now)).index).toEqual(before.index);
        expect(await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } })).toEqual(settings);
      } finally {
        await prisma.user.delete({ where: { id: userId } });
      }
    }
  );

  it("partitions durable jobs and deletions into waiting and in-flight work with only waiting age", async () => {
    const userId = `memory-queue-${randomUUID()}`;
    const now = new Date();
    const waitingAt = new Date(now.getTime() - 60_000);
    const runningAt = new Date(now.getTime() - 300_000);
    const repository = createPrismaAdminMemoryStatusRepository(prisma, async () => undefined);
    const before = await repository.read(now);
    await prisma.user.create({ data: { id: userId, displayName: "Queue fixture", status: "active" } });
    try {
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const jobStates = [
        "QUEUED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT",
        "RETRYABLE_FAILED", "CLAIMED", "SUCCEEDED", "TERMINAL_FAILED", "STALE", "CANCELLED"
      ] as const;
      for (const state of jobStates) {
        await prisma.memoryJob.create({ data: {
          userId, state, kind: "EMBED_ITEMS", pipelineVersion: "queue-fixture-v1",
          idempotencyFingerprint: randomUUID(), memoryGenerationSnapshot: settings.memoryGeneration,
          memoryRevisionSnapshot: settings.memoryRevision,
          createdAt: state === "CLAIMED" ? runningAt : waitingAt,
          ...(state === "CLAIMED" ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 60_000) } : {}),
          ...(["SUCCEEDED", "TERMINAL_FAILED", "STALE", "CANCELLED"].includes(state) ? { completedAt: now } : {})
        } });
      }
      const deletionStates = ["PENDING", "RETRY_WAIT", "BLOCKED_REQUIRES_ADMIN", "RUNNING", "SUCCEEDED", "CANCELLED"] as const;
      for (const state of deletionStates) {
        await prisma.memoryDeletionOutbox.create({ data: {
          userId, state, memoryGeneration: settings.memoryGeneration, operation: "TEMPORARY_DELETE",
          targetType: "CHAT", targetId: randomUUID(), createdAt: state === "RUNNING" ? runningAt : waitingAt,
          ...(state === "RUNNING" ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 60_000) } : {}),
          ...(state === "SUCCEEDED" ? { completedAt: now, lastAuditAt: now } : {}),
          ...(state === "CANCELLED" ? { completedAt: now, errorCode: "memory_deletion_failed" } : {})
        } });
      }
      const current = await repository.read(now);
      expect(current.inProgressCount - before.inProgressCount).toBe(2);
      expect(current.queueLength - before.queueLength).toBe(7);
      expect(current.oldestQueuedAt).toEqual(before.oldestQueuedAt && before.oldestQueuedAt < waitingAt
        ? before.oldestQueuedAt : waitingAt);
      expect(JSON.stringify({
        inProgress: current.inProgressCount, waiting: current.queueLength, oldestQueuedAt: current.oldestQueuedAt
      })).not.toContain(userId);

      expect(current.workerHasStalledClaims).toBe(false);
      await prisma.memoryJob.updateMany({ where: { userId, state: "SUCCEEDED" }, data: { progressAt: now } });
      await prisma.memoryJob.updateMany({ where: { userId, state: "CLAIMED" },
        data: { progressAt: new Date(now.getTime() - 1200_000) } });
      expect(await repository.read(now)).toMatchObject({
        workerHasStalledClaims: true, workerLastProgressAt: now
      });
      await prisma.memoryJob.updateMany({ where: { userId, state: "CLAIMED" }, data: { progressAt: now } });
      expect((await repository.read(now)).workerHasStalledClaims).toBe(false);

      // Claim every remaining fixture item. No running item may keep a waiting
      // count or waiting age alive, even when its creation predates the backlog.
      await prisma.memoryJob.updateMany({
        where: { userId, state: { in: ["QUEUED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT", "RETRYABLE_FAILED"] } },
        data: { state: "CLAIMED", leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 60_000) }
      });
      await prisma.memoryDeletionOutbox.updateMany({
        where: { userId, state: { in: ["PENDING", "RETRY_WAIT", "BLOCKED_REQUIRES_ADMIN"] } },
        data: { state: "RUNNING", leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 60_000) }
      });
      const claimed = await repository.read(now);
      expect(claimed).toMatchObject({
        inProgressCount: before.inProgressCount + 9,
        oldestQueuedAt: before.oldestQueuedAt,
        queueLength: before.queueLength
      });
      await prisma.memoryJob.updateMany({ where: { userId, state: "CLAIMED" },
        data: { state: "SUCCEEDED", completedAt: now, leaseToken: null, leaseExpiresAt: null } });
      await prisma.memoryDeletionOutbox.updateMany({ where: { userId, state: "RUNNING" },
        data: { state: "SUCCEEDED", completedAt: now, lastAuditAt: now, leaseToken: null, leaseExpiresAt: null } });
      expect(await repository.read(now)).toMatchObject({
        inProgressCount: before.inProgressCount,
        oldestQueuedAt: before.oldestQueuedAt,
        queueLength: before.queueLength
      });
    } finally {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  });
});
