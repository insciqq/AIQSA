import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import { readMemoryRecoveryStatus } from "./recoveryStatus";
import { MEMORY_RECOVERY_DELAYS_MS } from "./recoveryPolicy";
import { loadMemorySourceSnapshot } from "../sourceState";
import { textMessageContent } from "../../../domain/content";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority } from "@/tests/support/providerExecutionAuthority";

async function fixture() {
  const userId = `memory-recovery-${randomUUID()}`;
  const now = new Date();
  await prisma.user.create({ data: { id: userId, displayName: "Recovery fixture", status: "active" } });
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  return {
    userId, now,
    repository: createPrismaMemoryCoordinatorRepository(prisma),
    job: (overrides: Partial<Prisma.MemoryJobUncheckedCreateInput> = {}) => prisma.memoryJob.create({ data: {
      userId, kind: "RECLASSIFY_FACTS", state: "TERMINAL_FAILED", attemptCount: 5,
      pipelineVersion: "recovery-fixture-v1", idempotencyFingerprint: randomUUID(),
      memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
      errorCode: "memory_job_commit_timeout", errorMessage: "Private failure details",
      createdAt: new Date(now.getTime() - 3600_000), completedAt: new Date(now.getTime() - 600_000),
      ...overrides
    } }),
    cleanup: async () => {
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  };
}

describe("Memory terminal recovery persistence", () => {
  afterAll(() => prisma.$disconnect());

  it("has one winner under concurrent recovery and retains the original failure and attempt history", async () => {
    const f = await fixture();
    try {
      const job = await f.job();
      const counts = await Promise.all([1, 2].map(() => f.repository.recoverEligibleJobs({ limit: 8, now: f.now })));
      expect(counts.reduce((total, count) => total + count, 0)).toBe(1);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        state: "QUEUED", recoveryCount: 1, lastRecoveryAt: f.now, recoveryErrorCode: job.errorCode,
        errorCode: job.errorCode, attemptCount: 5, completedAt: null
      });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      const claims = await Promise.all([1, 2].map(() => f.repository.claimJob({
        claimToken: randomUUID(), kinds: ["RECLASSIFY_FACTS"], now: f.now,
        leaseExpiresAt: new Date(f.now.getTime() + 60_000)
      })));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)).toMatchObject({ id: job.id, attemptCount: 6 });
      expect(await prisma.memoryJob.count({ where: { userId: f.userId } })).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("persists increasing cooldowns across restart and ends automatic recovery without resetting attempts", async () => {
    const f = await fixture();
    try {
      const job = await f.job({ completedAt: f.now });
      let now = f.now;
      for (let index = 0; index < MEMORY_RECOVERY_DELAYS_MS.length; index += 1) {
        now = new Date(now.getTime() + MEMORY_RECOVERY_DELAYS_MS[index]!);
        const restarted = createPrismaMemoryCoordinatorRepository(prisma);
        expect(await restarted.recoverEligibleJobs({ limit: 8, now: new Date(now.getTime() - 1) })).toBe(0);
        expect(await readMemoryRecoveryStatus(prisma, new Date(now.getTime() - 1))).toMatchObject({ scheduled: 1, nextRetrySeconds: 1 });
        expect(await restarted.recoverEligibleJobs({ limit: 8, now })).toBe(1);
        await prisma.memoryJob.update({ where: { id: job.id }, data: { state: "TERMINAL_FAILED", completedAt: now } });
      }
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: new Date(now.getTime() + 86400_000) })).toBe(0);
      expect(await readMemoryRecoveryStatus(prisma, now)).toMatchObject({ exhausted: 1, eligible: 0, scheduled: 0, nextRetrySeconds: null });
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ attemptCount: 5, recoveryCount: 3 });
    } finally { await f.cleanup(); }
  });

  it("never replays settled or ambiguous provider executions and leaves unknown failures visible", async () => {
    const f = await fixture();
    const authority = await createTestProviderExecutionAuthority(prisma, "memory-recovery");
    try {
      for (const state of ["SUCCEEDED", "OUTCOME_UNKNOWN"] as const) {
        const job = await f.job();
        await prisma.memoryExecutionBinding.create({ data: {
          ...authority,
          userId: f.userId, memoryJobId: job.id, ownerType: "JOB", state, ordinal: 0,
          logicalRole: "MEMORY_CLASSIFIER", destinationFingerprint: "d".repeat(64), inputHash: "a".repeat(64),
          acceptedOutputHash: state === "SUCCEEDED" ? "b".repeat(64) : null,
          policyVersion: "fixture-v1", promptVersion: "fixture-v1", schemaVersion: "fixture-v1",
          pipelineVersion: "recovery-fixture-v1", secretFreeExecutionSnapshot: {},
          providerId: "openai_compatible", createdAt: job.createdAt, startedAt: job.createdAt,
          completedAt: f.now, recoverableUntil: new Date(f.now.getTime() + 86400_000)
        } });
      }
      await f.job({ errorCode: "memory_model_output_invalid" });
      await f.job({ kind: "CONSOLIDATE_CANDIDATE" });
      await f.job({ state: "WAITING_FOR_CONFIGURATION", completedAt: null });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      const status = await readMemoryRecoveryStatus(prisma, f.now);
      expect(status).toMatchObject({ protected: 2, permanent: 2, configurationRequired: 1, eligible: 0 });
      expect(JSON.stringify(status)).not.toMatch(/Private|memory-recovery|fixture|memory_job/u);
    } finally {
      await f.cleanup();
      await deleteTestProviderExecutionAuthority(prisma, authority);
    }
  });

  it("rechecks owner, pause, generation and revision authority", async () => {
    const f = await fixture();
    try {
      await f.job({ memoryGenerationSnapshot: 99 });
      await f.job({ memoryRevisionSnapshot: 99 });
      const job = await f.job();
      await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { useMemoryFacts: false } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { useMemoryFacts: true } });
      await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      await prisma.user.update({ where: { id: f.userId }, data: { status: "active" } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(1);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: "QUEUED" });
    } finally { await f.cleanup(); }
  });

  it("keeps each admission bounded and excludes a later successful replacement", async () => {
    const f = await fixture();
    try {
      await Promise.all(Array.from({ length: 10 }, () => f.job()));
      expect(await f.repository.recoverEligibleJobs({ limit: 3, now: f.now })).toBe(3);
      expect(await prisma.memoryJob.count({ where: { userId: f.userId, state: "TERMINAL_FAILED" } })).toBe(7);
      await f.job({ state: "SUCCEEDED", completedAt: new Date(f.now.getTime() - 1000), acceptedResultHash: "b".repeat(64) });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ obsolete: 7, eligible: 0 });
    } finally { await f.cleanup(); }
  });

  it("does not backfill a past pause interval or cross a deletion cutoff after preferences resume", async () => {
    const f = await fixture();
    try {
      await f.job();
      const pause = await prisma.memoryPauseInterval.create({ data: { userId: f.userId, scope: "MASTER",
        memoryGeneration: 0, pausedAt: new Date(f.now.getTime() - 7200_000),
        resumedAt: new Date(f.now.getTime() - 1800_000) } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      await prisma.memoryPauseInterval.delete({ where: { id: pause.id } });
      await prisma.memorySourceBarrier.create({ data: { userId: f.userId, kind: "ALL_REUSABLE",
        memoryGeneration: 0, sourceCreatedAtCutoff: f.now } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ obsolete: 1, eligible: 0 });
    } finally { await f.cleanup(); }
  });

  it("reproves the exact history source and excludes a changed branch before requeue", async () => {
    const f = await fixture();
    try {
      const chat = await prisma.chat.create({ data: { userId: f.userId, title: "Synthetic source" } });
      const message = await prisma.message.create({ data: { chatId: chat.id, role: "user",
        content: textMessageContent("Synthetic user statement"), createdAt: new Date(f.now.getTime() - 700_000) } });
      await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: message.id } });
      const source = await prisma.$transaction((tx) => loadMemorySourceSnapshot(tx, { chatId: chat.id, userId: f.userId }));
      expect(source).not.toBeNull();
      const job = await f.job({ kind: "INDEX_HISTORY", chatId: chat.id, sourceMessageId: message.id,
        activeLeafMessageId: message.id, branchGeneration: source!.memoryBranchGeneration,
        sourceRevision: source!.memorySourceRevision, sourceHash: "f".repeat(64),
        completedAt: new Date(f.now.getTime() - 600_001) });
      const current = await f.job();
      expect(await f.repository.recoverEligibleJobs({ limit: 1, now: f.now })).toBe(0);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        state: "STALE", errorCode: "memory_job_commit_timeout", recoveryCount: 0, attemptCount: 5
      });
      expect(await f.repository.recoverEligibleJobs({ limit: 1, now: f.now })).toBe(1);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({ state: "QUEUED" });
      await f.job({ kind: "INDEX_HISTORY", chatId: chat.id, sourceMessageId: message.id,
        activeLeafMessageId: message.id, branchGeneration: source!.memoryBranchGeneration,
        sourceRevision: source!.memorySourceRevision, sourceHash: source!.sourceHash });
      await prisma.chat.update({ where: { id: chat.id }, data: { memoryBranchGeneration: { increment: 1 } } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ obsolete: 2, eligible: 0 });
    } finally { await f.cleanup(); }
  });

  it("does not treat renewable leases as job progress", async () => {
    const f = await fixture();
    try {
      const job = await f.job({ kind: "EMBED_ITEMS", state: "QUEUED", completedAt: null });
      const claim = await f.repository.claimJob({ claimToken: randomUUID(), kinds: ["EMBED_ITEMS"],
        leaseExpiresAt: new Date(f.now.getTime() + 60_000), now: f.now });
      expect(claim?.id).toBe(job.id);
      expect(await f.repository.heartbeatJob({ claim: claim!, now: new Date(f.now.getTime() + 1000),
        leaseExpiresAt: new Date(f.now.getTime() + 120_000) })).toBe(true);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ progressAt: f.now });
      const progressedAt = new Date(f.now.getTime() + 2000);
      expect(await f.repository.setJobStage({ claim: claim!, now: progressedAt, stage: "fixture_apply" })).toBe(true);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ progressAt: progressedAt });
    } finally { await f.cleanup(); }
  });
});
