import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import {
  createPrismaMemoryCoordinatorRepository,
  preflightPrismaMemoryJobLifecycle
} from "./prismaRepository";
import {
  MEMORY_COORDINATOR_JOB_KINDS,
  MEMORY_COORDINATOR_ORPHANED_JOB_KINDS
} from "./registry";

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

  it("[GATE] terminalizes every retired job kind without claiming it", async () => {
    const suffix = randomUUID();
    const userId = `memory-retired-job-${suffix}`;
    await prisma.user.create({
      data: {
        displayName: "Memory retired job fixture",
        email: `${userId}@example.test`,
        id: userId,
        status: "active"
      }
    });
    try {
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await prisma.memoryJob.createMany({
        data: MEMORY_COORDINATOR_ORPHANED_JOB_KINDS.map((kind) => ({
          idempotencyFingerprint: `${kind.toLowerCase()}-${suffix}`,
          kind,
          memoryGenerationSnapshot: settings.memoryGeneration,
          memoryRevisionSnapshot: settings.memoryRevision,
          pipelineVersion: "memory-retired-job-test-v1",
          userId
        }))
      });
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const terminalizedAt = new Date();
      await expect(repository.terminalUnavailableJobs?.({
        now: terminalizedAt,
        supportedKinds: MEMORY_COORDINATOR_JOB_KINDS
      })).resolves.toBe(MEMORY_COORDINATOR_ORPHANED_JOB_KINDS.length);
      const retiredJobs = await prisma.memoryJob.findMany({
        orderBy: { kind: "asc" },
        select: {
          completedAt: true,
          errorCode: true,
          kind: true,
          leaseToken: true,
          state: true
        },
        where: { userId }
      });
      expect(retiredJobs).toHaveLength(MEMORY_COORDINATOR_ORPHANED_JOB_KINDS.length);
      expect(retiredJobs).toEqual(expect.arrayContaining(
        MEMORY_COORDINATOR_ORPHANED_JOB_KINDS.map((kind) => ({
          completedAt: terminalizedAt,
          errorCode: "memory_job_handler_unavailable",
          kind,
          leaseToken: null,
          state: "TERMINAL_FAILED"
        }))
      ));
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
