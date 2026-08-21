import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { preflightPrismaMemoryJobLifecycle } from "./prismaRepository";

describe("Prisma Memory coordinator startup lifecycle preflight", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rolls back a real queued, claimed, heartbeat, and succeeded transition", async () => {
    const suffix = randomUUID();
    const userId = `memory-preflight-${suffix}`;
    const probeId = `memory-preflight-job-${suffix}`;
    await prisma.user.create({
      data: {
        displayName: "Memory preflight fixture",
        email: `${userId}@example.test`,
        id: userId,
        status: "active"
      }
    });
    try {
      const [settingsBefore, cursorBefore, jobCountBefore] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryGeneration: true, memoryRevision: true },
          where: { userId }
        }),
        prisma.documentProcessingFairnessCursor.findUnique({
          where: { pipeline: "memory-job" }
        }),
        prisma.memoryJob.count({ where: { userId } })
      ]);

      await preflightPrismaMemoryJobLifecycle(prisma, {
        now: new Date("2026-08-21T09:30:00.000Z"),
        ownerUserId: userId,
        probeId
      });

      const [settingsAfter, cursorAfter, jobCountAfter, residue] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryGeneration: true, memoryRevision: true },
          where: { userId }
        }),
        prisma.documentProcessingFairnessCursor.findUnique({
          where: { pipeline: "memory-job" }
        }),
        prisma.memoryJob.count({ where: { userId } }),
        prisma.memoryJob.findUnique({ where: { id: probeId } })
      ]);
      expect(settingsAfter).toEqual(settingsBefore);
      expect(cursorAfter).toEqual(cursorBefore);
      expect(jobCountAfter).toBe(jobCountBefore);
      expect(residue).toBeNull();
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
