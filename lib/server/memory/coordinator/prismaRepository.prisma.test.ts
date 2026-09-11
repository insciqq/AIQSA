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

  it("normalizes legacy waiting, resumes once, and preserves owner, source and terminal fences", async () => {
    const userId = `memory-waiting-${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, displayName: "Waiting fixture",
      email: `${userId}@example.test`, status: "active" } });
    try {
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const now = new Date();
      const states = ["WAITING_FOR_EGRESS_CONSENT", "WAITING_FOR_CONFIGURATION", "SUCCEEDED", "TERMINAL_FAILED", "CLAIMED"] as const;
      const jobs = await Promise.all(states.map((state) => prisma.memoryJob.create({ data: {
        userId, state, kind: "EMBED_ITEMS", pipelineVersion: "waiting-fixture-v1",
        idempotencyFingerprint: randomUUID(), memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        ...(state === "SUCCEEDED" || state === "TERMINAL_FAILED" ? { completedAt: now } : {}),
        ...(state === "CLAIMED" ? { leaseToken: randomUUID(), leaseExpiresAt: now } : {})
      } })));
      const waiting = (await repository.listWaitingJobs({ kinds: ["EMBED_ITEMS"], limit: 100 }))
        .filter((job) => job.userId === userId);
      expect(waiting.map(({ id }) => id).sort()).toEqual(jobs.slice(0, 2).map(({ id }) => id).sort());
      const legacy = waiting.find(({ id }) => id === jobs[0]!.id)!;
      await expect(repository.resolveWaitingJob({ job: legacy, now,
        decision: { status: "WAITING_FOR_CONFIGURATION", errorCode: "memory_execution_capability_unavailable" }
      })).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: legacy.id } })).resolves.toMatchObject({
        state: "WAITING_FOR_CONFIGURATION", errorCode: "memory_execution_capability_unavailable",
        leaseToken: null, completedAt: null, nextAttemptAt: null, attemptCount: 0
      });
      const resolutions = await Promise.all([1, 2].map(() => repository.resolveWaitingJob({
        job: legacy, now, decision: { status: "READY" }
      })));
      expect(resolutions.sort()).toEqual([false, true]);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: legacy.id } })).resolves.toMatchObject({
        state: "QUEUED", errorCode: null, attemptCount: 0
      });
      const remaining = waiting.find(({ id }) => id === jobs[1]!.id)!;
      await prisma.user.update({ where: { id: userId }, data: { status: "disabled" } });
      await expect(repository.resolveWaitingJob({ job: remaining, now, decision: { status: "READY" } })).resolves.toBe(false);
      await prisma.user.update({ where: { id: userId }, data: { status: "active" } });
      await expect(repository.resolveWaitingJob({ job: { ...remaining, memoryGenerationSnapshot: settings.memoryGeneration + 1 },
        now, decision: { status: "READY" } })).resolves.toBe(false);
      await prisma.memoryJob.update({ where: { id: remaining.id }, data: {
        state: "CANCELLED", completedAt: now, errorCode: "memory_owner_paused"
      } });
      await expect(repository.resolveWaitingJob({ job: remaining, now, decision: { status: "READY" } })).resolves.toBe(false);
      for (const terminal of jobs.slice(2)) {
        await expect(repository.resolveWaitingJob({ job: terminal, now, decision: { status: "READY" } })).resolves.toBe(false);
        await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: terminal.id } })).resolves.toMatchObject({ state: terminal.state });
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
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
