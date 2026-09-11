import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { MemoryJobKind, MemoryJobState } from "@prisma/client";
import { prisma } from "../../prisma";
import { readAdminMemoryProcessing } from "./processingRepository";
import { textMessageContent } from "../../../domain/content";

const resolution = vi.hoisted(() => ({ available: true }));
vi.mock("../../providerRuntime/systemModelRole", () => ({
  createSystemModelRoleResolver: () => ({ resolve: async () => ({ ok: resolution.available }) })
}));

describe("administrator Memory processing aggregates", () => {
  afterAll(() => prisma.$disconnect());

  async function fixture() {
    const userId = `memory-status-${randomUUID()}`;
    const now = new Date();
    await prisma.user.create({ data: { id: userId, displayName: "Processing fixture", status: "active" } });
    const chat = await prisma.chat.create({ data: { userId, title: "Private processing fixture" } });
    const source = await prisma.message.create({ data: { chatId: chat.id, role: "user",
      content: textMessageContent("Synthetic private fact"), createdAt: new Date(now.getTime() - 2000_000) } });
    const leaf = await prisma.message.create({ data: { chatId: chat.id, parentMessageId: source.id,
      role: "assistant", content: textMessageContent("Synthetic reply") } });
    await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: leaf.id } });
    const job = (state: MemoryJobState, options: { age?: number; errorCode?: string; kind?: MemoryJobKind; generation?: number } = {}) =>
      prisma.memoryJob.create({ data: {
        userId, state, kind: options.kind ?? "EXTRACT_FACTS", pipelineVersion: "processing-fixture-v1",
        memoryGenerationSnapshot: options.generation ?? 0, memoryRevisionSnapshot: 0,
        idempotencyFingerprint: randomUUID(), errorCode: options.errorCode ?? null,
        chatId: chat.id, sourceMessageId: source.id, activeLeafMessageId: leaf.id,
        branchGeneration: 0, sourceRevision: 0, sourceHash: "a".repeat(64),
        errorMessage: "private fixture content must never be projected",
        createdAt: new Date(now.getTime() - (options.age ?? 1865) * 1000),
        ...(state === "TERMINAL_FAILED" || state === "SUCCEEDED" ? { completedAt: new Date(now.getTime() - 60_000) } : {}),
        ...(state === "CLAIMED" ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 60_000) } : {})
      } });
    return { userId, chatId: chat.id, now, job, cleanup: () => prisma.user.delete({ where: { id: userId } }) };
  }

  it("counts waiting work with its actual reason and age; excludes disabled owners, pause and old generations", async () => {
    const f = await fixture();
    try {
      resolution.available = true;
      await f.job("WAITING_FOR_EGRESS_CONSENT", { errorCode: "memory_execution_capability_unavailable" });
      await f.job("WAITING_FOR_CONFIGURATION", { errorCode: "memory_execution_capability_unavailable" });
      await f.job("WAITING_FOR_CONFIGURATION", { errorCode: "memory_execution_capability_unavailable" });
      await f.job("WAITING_FOR_CONFIGURATION", { generation: 99 });
      const before = await prisma.memoryJob.findMany({ where: { userId: f.userId } });
      const result = await readAdminMemoryProcessing(prisma, f.now);
      expect(result.issues).toContainEqual({ stage: "LEARNING", reason: "CAPABILITY_UNAVAILABLE", severity: "bad", count: 3, oldestAgeSeconds: 1865 });
      expect(JSON.stringify(result)).not.toMatch(/private|memory-status|fixture|memory_execution/u);
      expect(await prisma.memoryJob.findMany({ where: { userId: f.userId } })).toEqual(before);
      resolution.available = false;
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual(result.issues);
      resolution.available = true;
      await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { learnAutomatically: false } });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
      await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { learnAutomatically: true } });
      await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { useMemoryFacts: false } });
      await f.job("WAITING_FOR_CONFIGURATION", { kind: "INDEX_HISTORY" });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
      await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { useMemoryFacts: true } });
      await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
      await prisma.user.update({ where: { id: f.userId }, data: { status: "active" } });
      await prisma.chat.update({ where: { id: f.chatId }, data: { memorySourceRevision: { increment: 1 } } });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("keeps terminal failures outside the queue until a later successful operation confirms recovery", async () => {
    const f = await fixture();
    try {
      resolution.available = true;
      const failed = await f.job("TERMINAL_FAILED");
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toContainEqual(
        expect.objectContaining({ reason: "PROCESSING_FAILED", count: 1, severity: "bad" }));
      const recovered = await f.job("SUCCEEDED", { age: 20 });
      await prisma.memoryJob.update({ where: { id: recovered.id }, data: { completedAt: new Date(failed.completedAt!.getTime() + 1) } });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("distinguishes stalled backlog from progress, ordinary retry and optional indexing degradation", async () => {
    const f = await fixture();
    try {
      resolution.available = true;
      const waiting = await f.job("QUEUED");
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toContainEqual(
        expect.objectContaining({ reason: "STALLED", severity: "warn", count: 1 }));
      await f.job("SUCCEEDED", { age: 20 });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
      await prisma.memoryJob.update({ where: { id: waiting.id }, data: { state: "RETRYABLE_FAILED", createdAt: new Date(f.now.getTime() - 1000) } });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
      await f.job("TERMINAL_FAILED", { kind: "EMBED_ITEMS" });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toContainEqual(
        expect.objectContaining({ stage: "INDEXING", reason: "PROCESSING_FAILED", severity: "warn" }));
    } finally { await f.cleanup(); }
  });

  it("detects a missing current model before queueing and clears only after authoritative readiness", async () => {
    const f = await fixture();
    try {
      resolution.available = false;
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toContainEqual(
        { stage: "LEARNING", reason: "MODEL_UNAVAILABLE", count: 0, oldestAgeSeconds: null, severity: "bad" });
      resolution.available = true;
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
    } finally { resolution.available = true; await f.cleanup(); }
  });
});
