import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { textMessageContent } from "../../../domain/content";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import { createPrismaMemoryFactExtractionRepository } from "../learning/extraction/repository";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, memoryFactExtractionJobFingerprint } from "../learning/extraction/contract";
import { enqueueMemoryCommand } from "./repository";

async function fixture() {
  const userId = `memory-command-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, displayName: "Command fixture", status: "active" } });
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic command fixture" } });
  const first = await prisma.message.create({ data: { chatId: chat.id, role: "user",
    content: textMessageContent("Remember the synthetic test preference") } });
  const second = await prisma.message.create({ data: { chatId: chat.id, role: "user",
    parentMessageId: first.id, content: textMessageContent("Forget the synthetic test preference") } });
  await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: second.id } });
  return {
    userId, chat, first, second,
    enqueue: (sourceMessageId: string) => withLockedMemoryTransaction(prisma, userId,
      (tx, settings) => enqueueMemoryCommand(tx, settings, {
        activeLeafMessageId: second.id, branchGeneration: 0, chatId: chat.id,
        sourceHash: "a".repeat(64), sourceMessageId, sourceRevision: 0
      })),
    extraction: async () => {
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const source = { userId, chatId: chat.id, sourceMessageId: first.id,
        activeLeafMessageId: second.id, branchGeneration: 0, sourceRevision: 0,
        sourceHash: "a".repeat(64), memoryGenerationSnapshot: settings.memoryGeneration };
      return prisma.memoryJob.create({ data: {
        ...source, kind: "EXTRACT_FACTS", pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        idempotencyFingerprint: memoryFactExtractionJobFingerprint(source),
        memoryRevisionSnapshot: settings.memoryRevision
      } });
    },
    cleanup: async () => {
      await prisma.memoryJob.deleteMany({ where: { userId } });
      await prisma.chat.delete({ where: { id: chat.id } });
      await prisma.user.delete({ where: { id: userId } });
    }
  };
}

describe("Memory command durable ordering", () => {
  afterAll(() => prisma.$disconnect());

  it.each(["failure", "pause"] as const)("erases private checkpoints on terminal %s", async (boundary) => {
    const f = await fixture();
    try {
      const command = await f.enqueue(f.first.id);
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const now = new Date();
      const claimed = await repository.claimJob({ claimToken: randomUUID(), kinds: ["MEMORY_COMMAND"],
        now, leaseExpiresAt: new Date(now.getTime() + 30_000) });
      expect(claimed).toMatchObject({ id: command.id });
      await prisma.memoryJob.update({ where: { id: command.id }, data: {
        commandIntent: { statement: "Synthetic private checkpoint" },
        commandResult: { targetSelection: { candidate: "synthetic" } }
      } });
      if (boundary === "failure") {
        expect(await repository.terminalJob({ claim: claimed!, now, errorCode: "memory_job_failed" })).toBe(true);
      } else {
        const settings = await prisma.userMemorySettings.update({ where: { userId: f.userId },
          data: { useMemoryFacts: true } });
        await createPrismaMemorySettingsRepository(prisma).patch(f.userId, {
          expectedMemoryRevision: settings.memoryRevision,
          expectedSettingsRevision: settings.settingsRevision, useMemoryFacts: false
        });
      }
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({
        commandIntent: null, commandResult: null,
        state: boundary === "failure" ? "TERMINAL_FAILED" : "CANCELLED"
      });
    } finally { await f.cleanup(); }
  });

  it("serializes concurrent owner enqueue and replays the same message once", async () => {
    const f = await fixture();
    try {
      const commands = await Promise.all([f.enqueue(f.first.id), f.enqueue(f.second.id)]);
      expect(new Set(commands.map((command) => command.id)).size).toBe(2);
      const rows = await prisma.memoryJob.findMany({ where: { userId: f.userId },
        orderBy: { commandSequence: "asc" } });
      expect(rows.map((row) => row.commandSequence)).toEqual([1, 2]);
      expect(await f.enqueue(f.first.id)).toMatchObject({ created: false, id: commands[0]!.id });
      expect(await prisma.memoryJob.count({ where: { userId: f.userId } })).toBe(2);
    } finally { await f.cleanup(); }
  });

  it("prevents two workers from claiming a successor until the predecessor settles", async () => {
    const f = await fixture();
    try {
      const first = await f.enqueue(f.first.id);
      const second = await f.enqueue(f.second.id);
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const now = new Date();
      const claims = await Promise.all([1, 2].map(() => repository.claimJob({
        claimToken: randomUUID(), kinds: ["MEMORY_COMMAND"], now,
        leaseExpiresAt: new Date(now.getTime() + 30_000)
      })));
      expect(claims.filter(Boolean).map((claim) => claim!.id)).toEqual([first.id]);
      await prisma.memoryJob.update({ where: { id: first.id }, data: {
        state: "SUCCEEDED", commandStatus: "COMMITTED", commandOperation: "SAVE",
        completedAt: now, leaseToken: null, leaseExpiresAt: null
      } });
      expect(await repository.claimJob({ claimToken: randomUUID(), kinds: ["MEMORY_COMMAND"], now,
        leaseExpiresAt: new Date(now.getTime() + 30_000) })).toMatchObject({ id: second.id });
    } finally { await f.cleanup(); }
  });

  it("keeps automatic extraction behind its source command", async () => {
    const f = await fixture();
    try {
      const command = await f.enqueue(f.first.id);
      const extraction = await f.extraction();
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const now = new Date();
      const claim = () => repository.claimJob({ claimToken: randomUUID(), kinds: ["EXTRACT_FACTS"],
        now, leaseExpiresAt: new Date(now.getTime() + 30_000) });
      expect(await claim()).toBeNull();
      await prisma.memoryJob.update({ where: { id: command.id }, data: {
        state: "SUCCEEDED", commandStatus: "REJECTED", completedAt: now,
        commandResult: { classification: "NONE" }
      } });
      const claimed = await claim();
      expect(claimed).toMatchObject({ id: extraction.id });
      expect(await createPrismaMemoryFactExtractionRepository(prisma).preflight(claimed!))
        .toEqual({ status: "READY" });
    } finally { await f.cleanup(); }
  });

  it.each([
    ["missing", Prisma.DbNull],
    ["JSON null", Prisma.JsonNull],
    ["empty", {}],
    ["LIST", { classification: "LIST" }],
    ["SEARCH", { classification: "SEARCH" }],
    ["RESET", { classification: "RESET" }],
    ["uncertain", { classification: "NONE", uncertain: true }]
  ] as const)("excludes a rejected command with %s classification evidence", async (_label, commandResult) => {
    const f = await fixture();
    try {
      const command = await f.enqueue(f.first.id);
      const extraction = await f.extraction();
      const now = new Date();
      await prisma.memoryJob.update({ where: { id: command.id }, data: {
        state: "SUCCEEDED", commandStatus: "REJECTED", completedAt: now, commandResult
      } });
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const claimed = await repository.claimJob({ claimToken: randomUUID(), kinds: ["EXTRACT_FACTS"],
        now, leaseExpiresAt: new Date(now.getTime() + 30_000) });
      expect(claimed).toMatchObject({ id: extraction.id });
      const extractionRepository = createPrismaMemoryFactExtractionRepository(prisma);
      const excluded = { status: "CANCELLED", errorCode: "memory_fact_source_command_excluded" };
      expect(await extractionRepository.preflight(claimed!)).toEqual(excluded);
      expect(await extractionRepository.prepare(claimed!)).toEqual({ decision: excluded });
      expect(await prisma.memoryExecutionBinding.count({ where: { userId: f.userId } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it.each([
    ["COMMITTED", "SAVE"], ["REJECTED", "FORGET"], ["AMBIGUOUS", "UPDATE"],
    ["UNKNOWN", "UNKNOWN"], ["FAILED", "UNKNOWN"], ["STALE", "UNKNOWN"]
  ] as const)("finishes excluded extraction after a %s/%s command", async (commandStatus, commandOperation) => {
    const f = await fixture();
    try {
      const command = await f.enqueue(f.first.id);
      const extraction = await f.extraction();
      const now = new Date();
      await prisma.memoryJob.update({ where: { id: command.id }, data: {
        state: "SUCCEEDED", commandStatus, commandOperation, completedAt: now
      } });
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const claimed = await repository.claimJob({ claimToken: randomUUID(), kinds: ["EXTRACT_FACTS"],
        now, leaseExpiresAt: new Date(now.getTime() + 30_000) });
      expect(claimed).toMatchObject({ id: extraction.id });
      const decision = await createPrismaMemoryFactExtractionRepository(prisma).preflight(claimed!);
      expect(decision).toEqual({ status: "CANCELLED", errorCode: "memory_fact_source_command_excluded" });
      if (decision.status === "READY") throw new Error("memory_test_extraction_unexpectedly_ready");
      expect(await repository.settleJobGate({ claim: claimed!, decision, now })).toBe(true);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: extraction.id } }))
        .toMatchObject({ state: "CANCELLED", completedAt: now, leaseToken: null });
      expect(await prisma.memoryExecutionBinding.count({ where: { userId: f.userId } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("settles a committed Forget after its own generation change and a normal append", async () => {
    const f = await fixture();
    try {
      const command = await f.enqueue(f.first.id);
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const now = new Date();
      const claimed = await repository.claimJob({ claimToken: randomUUID(), kinds: ["MEMORY_COMMAND"],
        now, leaseExpiresAt: new Date(now.getTime() + 30_000) });
      expect(claimed).toMatchObject({ id: command.id });
      await prisma.memoryJob.update({ where: { id: command.id }, data: {
        commandStatus: "COMMITTED", commandOperation: "FORGET"
      } });
      await prisma.userMemorySettings.update({ where: { userId: f.userId },
        data: { memoryGeneration: { increment: 1 } } });
      await prisma.chat.update({ where: { id: f.chat.id }, data: { memorySourceRevision: { increment: 1 } } });
      const input = { acceptedResultHash: "b".repeat(64), claim: claimed!, now, stage: "command_committed",
        apply: async () => { throw new Error("memory_test_command_replayed"); } };
      expect(await repository.commitJobSuccess(input)).toBe(true);
      expect(await repository.commitJobSuccess(input)).toBe(false);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: command.id } }))
        .toMatchObject({ state: "SUCCEEDED", commandStatus: "COMMITTED", commandOperation: "FORGET",
          completedAt: now, leaseToken: null });
    } finally { await f.cleanup(); }
  });

  it.each(["PENDING", "RUNNING"] as const)("does not accept a %s command as completed", async (commandStatus) => {
    const f = await fixture();
    try {
      const command = await f.enqueue(f.first.id);
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const now = new Date();
      const claimed = await repository.claimJob({ claimToken: randomUUID(), kinds: ["MEMORY_COMMAND"],
        now, leaseExpiresAt: new Date(now.getTime() + 30_000) });
      await prisma.memoryJob.update({ where: { id: command.id }, data: { commandStatus } });
      expect(await repository.commitJobSuccess({ acceptedResultHash: "b".repeat(64), claim: claimed!, now, stage: null }))
        .toBe(false);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: command.id } }))
        .toMatchObject({ state: "CLAIMED", commandStatus, completedAt: null });
    } finally { await f.cleanup(); }
  });

  it("protects accepted command identity and never revives a released sequence slot", async () => {
    const f = await fixture();
    try {
      const command = await f.enqueue(f.first.id);
      await expect(prisma.memoryJob.update({ where: { id: command.id },
        data: { sourceMessageId: f.second.id } })).rejects.toThrow();
      await expect(prisma.memoryJob.update({ where: { id: command.id },
        data: { commandSequence: 9 } })).rejects.toThrow();
      const now = new Date();
      await prisma.memoryJob.update({ where: { id: command.id }, data: {
        state: "TERMINAL_FAILED", commandStatus: "FAILED", errorCode: "memory_job_commit_timeout",
        completedAt: new Date(now.getTime() - 600_000)
      } });
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      expect(await repository.recoverEligibleJobs({ limit: 8, now })).toBe(0);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: command.id } }))
        .toMatchObject({ state: "TERMINAL_FAILED", commandStatus: "FAILED" });
    } finally { await f.cleanup(); }
  });
});
