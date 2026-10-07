import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import { readMemoryRecoveryStatus } from "./recoveryStatus";
import { MEMORY_RECOVERY_DELAYS_MS } from "./recoveryPolicy";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { repairFencedMemoryHistoryJobs } from "../history/fenceRepair";
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
      await prisma.usageEvent.deleteMany({ where: { userId } });
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  };
}

async function currentHistorySource(f: Awaited<ReturnType<typeof fixture>>) {
  const chat = await prisma.chat.create({ data: { userId: f.userId, title: "Synthetic history source" } });
  const message = await prisma.message.create({ data: { chatId: chat.id, role: "user",
    content: textMessageContent("Synthetic user statement"), createdAt: new Date(f.now.getTime() - 700_000) } });
  await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: message.id } });
  const source = await prisma.$transaction((tx) => loadMemorySourceSnapshot(tx, { chatId: chat.id, userId: f.userId }));
  if (!source) throw new Error("memory_recovery_fixture_source_missing");
  return { chat, job: (overrides: Partial<Prisma.MemoryJobUncheckedCreateInput> = {}) => f.job({
    kind: "INDEX_HISTORY", chatId: chat.id, activeLeafMessageId: message.id,
    branchGeneration: source.memoryBranchGeneration, sourceRevision: source.memorySourceRevision,
    sourceHash: source.sourceHash, pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    stage: "source_snapshot", errorCode: "memory_history_chunk_limit_exceeded", ...overrides
  }) };
}

describe("Memory terminal recovery persistence", () => {
  afterAll(() => prisma.$disconnect());

  it("recovers only the due chunk-limit job once, keeping its ID, failure evidence and retry budget", async () => {
    const f = await fixture();
    try {
      const history = await currentHistorySource(f);
      const job = await history.job({ completedAt: f.now });
      let now = f.now;
      for (let index = 0; index < MEMORY_RECOVERY_DELAYS_MS.length; index += 1) {
        now = new Date(now.getTime() + MEMORY_RECOVERY_DELAYS_MS[index]!);
        expect(await readMemoryRecoveryStatus(prisma, new Date(now.getTime() - 1)))
          .toMatchObject({ eligible: 0, scheduled: 1, nextRetrySeconds: 1 });
        expect(await f.repository.recoverEligibleJobs({ limit: 8, now: new Date(now.getTime() - 1) })).toBe(0);
        expect(await readMemoryRecoveryStatus(prisma, now)).toMatchObject({ eligible: 1, scheduled: 0 });
        const winners = await Promise.all([1, 2].map(() => f.repository.recoverEligibleJobs({ limit: 8, now })));
        expect(winners.reduce((sum, count) => sum + count, 0)).toBe(1);
        expect(await f.repository.recoverEligibleJobs({ limit: 8, now })).toBe(0);
        expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
          state: "QUEUED", recoveryCount: index + 1, lastRecoveryAt: now,
          recoveryErrorCode: "memory_history_chunk_limit_exceeded",
          errorCode: "memory_history_chunk_limit_exceeded", attemptCount: 5, completedAt: null
        });
        expect(await prisma.memoryJob.count({ where: { userId: f.userId } })).toBe(1);
        await prisma.memoryJob.update({ where: { id: job.id }, data: { state: "TERMINAL_FAILED", completedAt: now } });
      }
      expect(await readMemoryRecoveryStatus(prisma, now)).toMatchObject({ exhausted: 1, eligible: 0 });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: new Date(now.getTime() + 86400_000) })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("does not admit chunk-limit failures with a different kind, stage, version or error", async () => {
    const f = await fixture();
    try {
      const history = await currentHistorySource(f);
      await history.job({ kind: "RECLASSIFY_FACTS" });
      await history.job({ stage: "lexical_apply" });
      await history.job({ pipelineVersion: "memory-history-incremental-v9" });
      await history.job({ errorCode: "memory_history_path_limit_exceeded" });
      await history.job({ errorCode: "memory_history_job_invalid" });
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ permanent: 5, eligible: 0 });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("recovers a chunk-limit job whatever earlier history call it holds, changing none of them", async () => {
    const f = await fixture();
    const authority = await createTestProviderExecutionAuthority(prisma, "history-chunk-limit-recovery");
    try {
      for (const state of ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"] as const) {
        const job = await (await currentHistorySource(f)).job();
        const binding = await prisma.memoryExecutionBinding.create({ data: {
          ...authority, userId: f.userId, memoryJobId: job.id, ownerType: "JOB", state, ordinal: 0,
          logicalRole: "MEMORY_HISTORY_CLASSIFY", destinationFingerprint: "d".repeat(64),
          inputHash: "a".repeat(64), acceptedOutputHash: state === "SUCCEEDED" ? "b".repeat(64) : null,
          policyVersion: "fixture-v1", promptVersion: "fixture-v1", schemaVersion: "fixture-v1",
          pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION, secretFreeExecutionSnapshot: {},
          providerId: "openai_compatible", createdAt: job.createdAt,
          startedAt: state === "PENDING" ? null : job.createdAt,
          completedAt: state === "PENDING" || state === "RUNNING" ? null : f.now,
          recoverableUntil: new Date(f.now.getTime() + 86400_000)
        } });
        if (state === "SUCCEEDED") await prisma.usageEvent.create({ data: {
          memoryExecutionBindingId: binding.id, modelId: authority.providerModelId, purpose: "memory_processing",
          provider: "openai_compatible", providerModelId: authority.providerModelId, userId: f.userId
        } });
      }
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ eligible: 6, permanent: 0, protected: 0 });
      const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(6);
      expect(await prisma.memoryJob.count({ where: { userId: f.userId, state: "QUEUED", recoveryCount: 1 } })).toBe(6);
      // History recovery rebuilds raw history locally and never dispatches.
      expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } }))
        .toEqual(bindings);
    } finally {
      await f.cleanup();
      await deleteTestProviderExecutionAuthority(prisma, authority);
    }
  });

  it.each([
    "disabled_owner", "paused_setting", "master_pause", "history_pause", "generation",
    "excluded", "deleted", "branch", "active_leaf", "source_hash", "deletion_barrier"
  ] as const)("fences a chunk-limit job across %s", async (fence) => {
    const f = await fixture();
    try {
      const history = await currentHistorySource(f);
      const job = await history.job();
      if (fence === "disabled_owner") await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
      if (fence === "paused_setting") await prisma.userMemorySettings.update({
        where: { userId: f.userId }, data: { referenceChatHistory: false }
      });
      if (fence === "master_pause" || fence === "history_pause") await prisma.memoryPauseInterval.create({ data: {
        userId: f.userId, scope: fence === "master_pause" ? "MASTER" : "SEARCH_HISTORY",
        memoryGeneration: job.memoryGenerationSnapshot,
        pausedAt: new Date(job.createdAt.getTime() - 1), resumedAt: f.now
      } });
      if (fence === "generation") await prisma.userMemorySettings.update({
        where: { userId: f.userId }, data: { memoryGeneration: { increment: 1 } }
      });
      if (fence === "excluded") await prisma.chat.update({
        where: { id: history.chat.id }, data: { memoryMode: "EXCLUDED" }
      });
      if (fence === "deleted") {
        const deletion = await prisma.memoryDeletionOutbox.create({ data: {
          userId: f.userId, operation: "SOURCE_PURGE", targetType: "CHAT@memory-chat-delete-v1",
          targetId: history.chat.id, memoryGeneration: job.memoryGenerationSnapshot,
          admissionAuthorizationId: randomUUID(), admittedChatSourceRevision: job.sourceRevision,
          alsoForgetOriginMemories: false
        } });
        await prisma.chat.update({
          where: { id: history.chat.id }, data: {
            archived: true, memoryMode: "EXCLUDED", permanentDeletionAt: f.now,
            permanentDeletionOperationId: deletion.id
          }
        });
      }
      if (fence === "branch") await prisma.chat.update({
        where: { id: history.chat.id }, data: { memoryBranchGeneration: { increment: 1 } }
      });
      if (fence === "active_leaf") await prisma.chat.update({
        where: { id: history.chat.id }, data: { activeLeafMessageId: null }
      });
      if (fence === "source_hash") await prisma.memoryJob.update({
        where: { id: job.id }, data: { sourceHash: "f".repeat(64) }
      });
      if (fence === "deletion_barrier") await prisma.memorySourceBarrier.create({ data: {
        userId: f.userId, kind: "HISTORY_INDEX", memoryGeneration: job.memoryGenerationSnapshot,
        sourceCreatedAtCutoff: f.now
      } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ obsolete: 1, eligible: 0 });
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        state: fence === "source_hash" ? "STALE" : "TERMINAL_FAILED",
        recoveryCount: 0
      });
    } finally {
      await prisma.memoryJob.deleteMany({ where: { userId: f.userId } });
      await prisma.chat.updateMany({ where: { userId: f.userId }, data: { activeLeafMessageId: null } });
      await prisma.message.deleteMany({ where: { chat: { userId: f.userId } } });
      await prisma.chat.deleteMany({ where: { userId: f.userId } });
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: f.userId } });
      await f.cleanup();
    }
  });

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

  it("releases a history fence casualty that recovery never retries, keeping its evidence and budget", async () => {
    const f = await fixture();
    try {
      const history = await currentHistorySource(f);
      const casualty = await history.job({ errorCode: "memory_history_job_invalid", stage: "digest_generation" });
      const chunkLimit = await history.job();
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ eligible: 1, permanent: 1 });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(1);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: casualty.id } }))
        .toMatchObject({ state: "TERMINAL_FAILED", recoveryCount: 0 });
      expect(await repairFencedMemoryHistoryJobs(prisma, { now: f.now })).toBe(1);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: casualty.id } })).toMatchObject({
        state: "STALE", errorCode: "memory_history_job_invalid", completedAt: casualty.completedAt,
        stage: "digest_generation", attemptCount: 5, recoveryCount: 0, lastRecoveryAt: null,
        recoveryErrorCode: null, progressAt: f.now
      });
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: chunkLimit.id } }))
        .toMatchObject({ state: "QUEUED", recoveryCount: 1 });
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ eligible: 0, permanent: 0, obsolete: 1 });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      expect(await repairFencedMemoryHistoryJobs(prisma, { now: f.now })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("bounds each fence repair pass and gives every casualty exactly one winner", async () => {
    const f = await fixture();
    try {
      const history = await currentHistorySource(f);
      const failedAt = new Date("2000-01-01T00:00:00.000Z");
      const casualties = await Promise.all(Array.from({ length: 10 }, () =>
        history.job({ errorCode: "memory_history_job_invalid", completedAt: failedAt })));
      const concurrent = await Promise.all([1, 2].map(() => repairFencedMemoryHistoryJobs(prisma, { now: f.now })));
      expect(Math.max(...concurrent)).toBeLessThanOrEqual(8);
      let repaired = concurrent[0]! + concurrent[1]!;
      for (let pass = 0; pass < 3 && repaired < casualties.length; pass += 1) {
        repaired += await repairFencedMemoryHistoryJobs(prisma, { now: f.now });
      }
      expect(repaired).toBe(casualties.length);
      expect(await prisma.memoryJob.count({
        where: { userId: f.userId, state: "STALE", errorCode: "memory_history_job_invalid", completedAt: failedAt }
      })).toBe(casualties.length);
      expect(await repairFencedMemoryHistoryJobs(prisma, { now: f.now })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("never releases legacy-pipeline, genuine or inactive-owner history failures; earlier calls protect none", async () => {
    const f = await fixture();
    const inactive = await fixture();
    const authority = await createTestProviderExecutionAuthority(prisma, "history-fence-repair");
    const binding = (jobId: string, createdAt: Date, state: "OUTCOME_UNKNOWN" | "RUNNING") =>
      prisma.memoryExecutionBinding.create({ data: {
        ...authority, userId: f.userId, memoryJobId: jobId, ownerType: "JOB", state, ordinal: 0,
        logicalRole: "MEMORY_HISTORY_CLASSIFY", destinationFingerprint: "d".repeat(64),
        inputHash: "a".repeat(64), acceptedOutputHash: null,
        policyVersion: "fixture-v1", promptVersion: "fixture-v1", schemaVersion: "fixture-v1",
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION, secretFreeExecutionSnapshot: {},
        providerId: "openai_compatible", createdAt, startedAt: createdAt,
        completedAt: state === "RUNNING" ? null : f.now,
        recoverableUntil: new Date(f.now.getTime() + 86400_000)
      } });
    try {
      const casualty = { errorCode: "memory_history_job_invalid" };
      const ambiguousSource = await currentHistorySource(f);
      const ambiguous = await ambiguousSource.job(casualty);
      await binding(ambiguous.id, ambiguous.createdAt, "OUTCOME_UNKNOWN");
      const runningSource = await currentHistorySource(f);
      const besideRunning = await runningSource.job(casualty);
      const running = await runningSource.job({ state: "CLAIMED", errorCode: null, completedAt: null,
        leaseToken: randomUUID(), leaseExpiresAt: new Date(f.now.getTime() + 60_000) });
      await binding(running.id, running.createdAt, "RUNNING");
      const legacy = await (await currentHistorySource(f)).job({ ...casualty,
        pipelineVersion: "memory-history-incremental-v9" });
      const genuine = await (await currentHistorySource(f)).job({
        errorCode: "memory_history_classification_unavailable" });
      const disabled = await (await currentHistorySource(inactive)).job(casualty);
      await prisma.user.update({ where: { id: inactive.userId }, data: { status: "disabled" } });
      const released = await (await currentHistorySource(f)).job(casualty);

      expect(await repairFencedMemoryHistoryJobs(prisma, { now: f.now })).toBe(3);
      for (const casualtyJob of [released, ambiguous, besideRunning]) {
        expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: casualtyJob.id } }))
          .toMatchObject({ state: "STALE", errorCode: "memory_history_job_invalid" });
      }
      for (const kept of [legacy, genuine, disabled]) {
        expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: kept.id } }))
          .toMatchObject({ state: "TERMINAL_FAILED", errorCode: kept.errorCode });
      }
    } finally {
      await f.cleanup();
      await inactive.cleanup();
      await deleteTestProviderExecutionAuthority(prisma, authority);
    }
  });

  it("recovers a protected history failure whatever earlier calls it holds, settling none of them", async () => {
    const f = await fixture();
    const authority = await createTestProviderExecutionAuthority(prisma, "history-orphan-recovery");
    type BindingState = "RUNNING" | "SUCCEEDED" | "OUTCOME_UNKNOWN";
    const binding = async (job: { id: string; createdAt: Date }, ordinal: number, state: BindingState,
      options: Readonly<{ receipt?: boolean }> = {}) => {
      const created = await prisma.memoryExecutionBinding.create({ data: {
        ...authority, userId: f.userId, memoryJobId: job.id, ownerType: "JOB", state, ordinal,
        logicalRole: "MEMORY_HISTORY_CLASSIFY", destinationFingerprint: "d".repeat(64),
        inputHash: ordinal.toString(16).padStart(64, "0"),
        acceptedOutputHash: state === "SUCCEEDED" ? "b".repeat(64) : null,
        policyVersion: "fixture-v1", promptVersion: "fixture-v1", schemaVersion: "fixture-v1",
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION, secretFreeExecutionSnapshot: {},
        providerId: "openai_compatible", createdAt: job.createdAt, startedAt: job.createdAt,
        completedAt: state === "RUNNING" ? null : job.createdAt,
        recoverableUntil: state === "RUNNING" ? null : new Date(f.now.getTime() + 86400_000)
      } });
      if (options.receipt ?? state !== "RUNNING") await prisma.usageEvent.create({ data: {
        memoryExecutionBindingId: created.id, modelId: authority.providerModelId, purpose: "memory_processing",
        provider: "openai_compatible", providerModelId: authority.providerModelId, userId: f.userId
      } });
    };
    // The previous release failed the next attempt at its recovery snapshot.
    const protectedFailure = { errorCode: "memory_history_execution_protected", attemptCount: 2 };
    try {
      const orphaned = await (await currentHistorySource(f)).job(protectedFailure);
      await binding(orphaned, 0, "SUCCEEDED");
      await binding(orphaned, 1, "RUNNING");
      const ambiguous = await (await currentHistorySource(f)).job(protectedFailure);
      await binding(ambiguous, 0, "OUTCOME_UNKNOWN");
      const missingReceipt = await (await currentHistorySource(f)).job(protectedFailure);
      await binding(missingReceipt, 0, "SUCCEEDED", { receipt: false });
      const laterStage = await (await currentHistorySource(f)).job({
        ...protectedFailure, stage: "contextual_key_generation" });
      const legacy = await (await currentHistorySource(f)).job({
        ...protectedFailure, pipelineVersion: "memory-history-incremental-v9" });
      const changed = await (await currentHistorySource(f)).job(protectedFailure);
      await prisma.chat.update({ where: { id: changed.chatId! }, data: { memoryBranchGeneration: { increment: 1 } } });

      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({
        eligible: 3, protected: 0, permanent: 2, obsolete: 1
      });
      const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(3);
      for (const job of [orphaned, ambiguous, missingReceipt]) {
        expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
          state: "QUEUED", recoveryCount: 1, recoveryErrorCode: "memory_history_execution_protected",
          attemptCount: 2, completedAt: null
        });
      }
      for (const kept of [laterStage, legacy, changed]) {
        expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: kept.id } }))
          .toMatchObject({ state: "TERMINAL_FAILED", recoveryCount: 0 });
      }
      // Admission changes no execution evidence; a revived job never dispatches.
      expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } }))
        .toEqual(bindings);
      expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now })).toBe(0);
      expect(await readMemoryRecoveryStatus(prisma, f.now)).toMatchObject({ eligible: 0, protected: 0, permanent: 2 });
    } finally {
      await f.cleanup();
      await deleteTestProviderExecutionAuthority(prisma, authority);
    }
  });
});
