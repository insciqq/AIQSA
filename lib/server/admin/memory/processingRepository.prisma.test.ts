import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { MemoryJobKind, MemoryJobState } from "@prisma/client";
import { prisma } from "../../prisma";
import { readAdminMemoryProcessing } from "./processingRepository";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { adminMemoryStatusForAttention } from "../../../domain/adminMemoryProcessing";

const resolution = vi.hoisted(() => ({ available: true }));
vi.mock("../../providerRuntime/memoryUtilityModelRole", () => ({
  createMemoryUtilityModelRoleResolver: () => ({ resolve: async () => ({ ok: resolution.available }) })
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
    return { userId, chatId: chat.id, sourceMessageId: source.id, leafMessageId: leaf.id, now, job, cleanup: () => prisma.user.delete({ where: { id: userId } }) };
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

  it("reports background maintenance under its own stage and never retired Dream synthesis", async () => {
    const f = await fixture();
    try {
      resolution.available = true;
      // Maintenance is the only SYNTHESIZE_MEMORIES pipeline; it owns no chat source.
      const synthesizeJob = (pipelineVersion: string) => prisma.memoryJob.create({ data: {
        userId: f.userId, state: "TERMINAL_FAILED", kind: "SYNTHESIZE_MEMORIES", pipelineVersion,
        memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0, idempotencyFingerprint: randomUUID(),
        createdAt: new Date(f.now.getTime() - 1865 * 1000), completedAt: new Date(f.now.getTime() - 60_000)
      } });
      await synthesizeJob("memory-synthesis-v2");
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
      await synthesizeJob("memory-maintenance-v1");
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([
        expect.objectContaining({ stage: "MAINTENANCE", reason: "PROCESSING_FAILED", severity: "bad", count: 1 })
      ]);
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

  it("reports a stalled claim even while other work in the same stage completes", async () => {
    const f = await fixture();
    try {
      resolution.available = true;
      const stalled = await f.job("CLAIMED", { kind: "EMBED_ITEMS" });
      await f.job("SUCCEEDED", { kind: "EMBED_ITEMS", age: 20 });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toContainEqual(
        expect.objectContaining({ stage: "INDEXING", reason: "STALLED", count: 1 }));
      await prisma.memoryJob.update({ where: { id: stalled.id }, data: { progressAt: f.now } });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it.each([
    { state: "PENDING", nextMinutes: null, progressMinutes: null, reason: "STALLED" },
    { state: "RETRY_WAIT", nextMinutes: null, progressMinutes: null, reason: "STALLED" },
    { state: "PENDING", nextMinutes: -20, progressMinutes: -1, reason: null },
    { state: "RUNNING", nextMinutes: null, progressMinutes: -20, reason: "STALLED" },
    { state: "RUNNING", nextMinutes: 60, progressMinutes: -20, reason: "STALLED" },
    { state: "RUNNING", nextMinutes: null, progressMinutes: -1, reason: null },
    { state: "BLOCKED_REQUIRES_ADMIN", nextMinutes: 60, progressMinutes: null, reason: "PROCESSING_FAILED" },
    { state: "SUCCEEDED", nextMinutes: null, progressMinutes: null, reason: null },
    { state: "CANCELLED", nextMinutes: null, progressMinutes: null, reason: null }
  ] as const)("preserves deletion diagnostics for $state with next=$nextMinutes and progress=$progressMinutes", async (entry) => {
    const f = await fixture();
    try {
      resolution.available = true;
      await prisma.memoryDeletionOutbox.create({ data: {
        userId: f.userId, state: entry.state, memoryGeneration: 0, operation: "TEMPORARY_DELETE",
        targetType: "TEMPORARY_CHAT@temporary-24h-v1", targetId: f.chatId,
        createdAt: new Date(f.now.getTime() - 60 * 60_000),
        nextAttemptAt: entry.nextMinutes === null ? null : new Date(f.now.getTime() + entry.nextMinutes * 60_000),
        progressAt: entry.progressMinutes === null ? null : new Date(f.now.getTime() + entry.progressMinutes * 60_000),
        ...(entry.state === "RUNNING" ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(f.now.getTime() + 60_000) } : {}),
        ...(entry.state === "SUCCEEDED" ? { completedAt: f.now, lastAuditAt: f.now } : {}),
        ...(entry.state === "CANCELLED" ? { completedAt: f.now, errorCode: "memory_deletion_failed" } : {})
      } });
      const issues = (await readAdminMemoryProcessing(prisma, f.now)).issues.filter(({ stage }) => stage === "DELETION");
      expect(issues).toEqual(entry.reason === null ? [] : [expect.objectContaining({
        reason: entry.reason, count: 1, severity: entry.reason === "STALLED" ? "warn" : "bad"
      })]);
    } finally {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: f.userId } });
      await f.cleanup();
    }
  });

  it("counts 24-hour command and search failures as warn-only content-free aggregates", async () => {
    const f = await fixture();
    try {
      resolution.available = true;
      const hour = 60 * 60_000;
      let sequence = 0;
      const command = async (commandStatus: "COMMITTED" | "FAILED" | "PENDING" | "REJECTED" | "UNKNOWN",
        state: MemoryJobState, ageMs: number) => {
        const created = await prisma.memoryJob.create({ data: {
          userId: f.userId, state, kind: "MEMORY_COMMAND", pipelineVersion: "processing-fixture-v1",
          memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0, idempotencyFingerprint: randomUUID(),
          chatId: f.chatId, sourceMessageId: f.sourceMessageId, activeLeafMessageId: f.leafMessageId,
          branchGeneration: 0, sourceRevision: 0, sourceHash: "a".repeat(64),
          errorMessage: "private fixture content must never be projected",
          commandSequence: ++sequence, commandStatus, commandOperation: "SAVE",
          commandResult: { statement: "private fixture command content" },
          ...(state === "TERMINAL_FAILED" || state === "SUCCEEDED" ? { completedAt: f.now } : {})
        } });
        // updatedAt is maintained by Prisma; set the terminal time directly.
        await prisma.$executeRaw`UPDATE "MemoryJob" SET "updatedAt" = ${new Date(f.now.getTime() - ageMs)} WHERE id = ${created.id}`;
      };
      await command("FAILED", "SUCCEEDED", 2 * hour);
      await command("UNKNOWN", "SUCCEEDED", hour);
      await command("PENDING", "TERMINAL_FAILED", 30 * 60_000);
      await command("PENDING", "SUCCEEDED", 10 * 60_000);
      await command("FAILED", "SUCCEEDED", 25 * hour);
      await command("COMMITTED", "SUCCEEDED", hour);
      await command("REJECTED", "SUCCEEDED", hour);
      const search = async (state: "CANCELLED" | "COMPLETE" | "ERROR",
        outcome: "DEGRADED" | "EMPTY" | "FAILED" | "RESULTS", ageMs: number) => {
        const at = new Date(f.now.getTime() - ageMs);
        const user = await prisma.message.create({ data: { chatId: f.chatId, role: "user",
          content: textMessageContent("Synthetic private search question") } });
        const run = await prisma.modelRun.create({ data: { chatId: f.chatId, userId: f.userId, userMessageId: user.id,
          status: "complete", normalizedRequest: {}, modelId: providerTemplateIds.fakeModel,
          provider: providerTemplateIds.fakeConnection } });
        const toolCall = await prisma.modelRunToolCall.create({ data: { modelRunId: run.id, ordinal: 0,
          providerCallId: randomUUID(), roundIndex: 0, state: "complete", toolName: "memory_search",
          arguments: { query: "private fixture query", comparison: false } } });
        await prisma.memoryHistoryRun.create({ data: { userId: f.userId, modelRunId: run.id,
          modelRunToolCallId: toolCall.id, invocationOrdinal: 1, query: "private fixture query",
          queryHash: "b".repeat(64), receiptVersion: "memory-search-v1", privateRequest: { version: "memory-search-v1" },
          state, outcome, errorCode: state === "COMPLETE" ? null : state === "ERROR"
            ? "memory_search_retrieval_failed" : "memory_search_cancelled",
          ...(state === "COMPLETE" ? { resultCount: outcome === "RESULTS" ? 1 : 0, results: { version: "memory-search-v1",
            results: outcome === "RESULTS" ? [{ includedText: "private fixture evidence" }] : [] } } : {}),
          providerResult: { content: "private fixture provider result" }, resultHash: "c".repeat(64),
          createdAt: at, completedAt: at, durationMs: 1 } });
      };
      await search("ERROR", "FAILED", 3 * hour);
      await search("ERROR", "FAILED", hour);
      await search("COMPLETE", "DEGRADED", 4 * hour);
      await search("CANCELLED", "FAILED", hour);
      await search("COMPLETE", "RESULTS", hour);
      await search("COMPLETE", "EMPTY", hour);
      await search("ERROR", "FAILED", 30 * hour);

      const result = await readAdminMemoryProcessing(prisma, f.now);
      const recent = result.issues.filter(({ stage }) => stage === "COMMAND" || stage === "SEARCH");
      expect(recent).toEqual([
        { stage: "COMMAND", reason: "COMMAND_FAILED", severity: "warn", count: 2, oldestAgeSeconds: 7200 },
        { stage: "COMMAND", reason: "COMMAND_UNKNOWN", severity: "warn", count: 2, oldestAgeSeconds: 3600 },
        { stage: "SEARCH", reason: "SEARCH_FAILED", severity: "warn", count: 2, oldestAgeSeconds: 10800 },
        { stage: "SEARCH", reason: "SEARCH_DEGRADED", severity: "warn", count: 1, oldestAgeSeconds: 14400 }
      ]);
      expect(recent.every((issue) => Object.keys(issue).sort().join() ===
        "count,oldestAgeSeconds,reason,severity,stage")).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/private|memory-status|fixture|memory_search_retrieval/u);
      const attention = adminMemoryStatusForAttention({ processing: result } as Parameters<typeof adminMemoryStatusForAttention>[0]);
      expect(attention.processing.issues.some(({ stage }) => stage === "COMMAND" || stage === "SEARCH")).toBe(false);
      await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
      expect((await readAdminMemoryProcessing(prisma, f.now)).issues
        .filter(({ stage }) => stage === "COMMAND" || stage === "SEARCH")).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("counts 24-hour preparation fallbacks and safe stops by allowlisted codes for active owners only", async () => {
    const f = await fixture();
    try {
      resolution.available = true;
      const hour = 60 * 60_000;
      // The aggregate spans every active owner; a future window excludes runs
      // that concurrent stateful suites settle in real time.
      const now = new Date(f.now.getTime() + 400 * 24 * hour);
      const run = async (status: "complete" | "error" | "preparing", code?: string, ageMs = hour) => {
        const created = await prisma.modelRun.create({ data: { chatId: f.chatId, userId: f.userId,
          userMessageId: f.sourceMessageId, status, normalizedRequest: {}, modelId: providerTemplateIds.fakeModel,
          provider: providerTemplateIds.fakeConnection,
          ...(code ? { errorPayload: { code, message: "private fixture failure text" } } : {}) } });
        await prisma.$executeRaw`UPDATE "ModelRun" SET "updatedAt" = ${new Date(now.getTime() - ageMs)} WHERE id = ${created.id}`;
        return created.id;
      };
      const receipt = async (degradationCode: string | null, outcome: "FAILED_SAFE" | "EMPTY", ageMs: number) => {
        const runId = await run("complete");
        const finalizedAt = new Date(now.getTime() - ageMs);
        const attempt = await prisma.memoryRetrievalAttempt.create({ data: {
          admissionKind: "NORMAL_SEND", admittedAssistantLeafMessageId: f.leafMessageId,
          admittedUserMessageId: f.sourceMessageId, attemptOrdinal: 0, baseRequestHash: "d".repeat(64),
          boundedPrivateBaseRequestSnapshot: { request: "private fixture base request" }, budgetSnapshot: {},
          chatId: f.chatId, chatMemoryModeSnapshot: "NORMAL", consumedAt: finalizedAt,
          expiresAt: new Date(Date.now() + hour), externalRolesUsed: [],
          memoryGenerationSnapshot: 0, modelRunId: runId, queryHash: "e".repeat(64), retrievalRevisionSnapshot: 0,
          settingsSnapshot: {}, state: "CONSUMED", outcome, degradationCode, userId: f.userId, utilityEgressMode: "LOCAL_ONLY"
        } });
        await prisma.modelRunMemoryBinding.create({ data: { userId: f.userId, modelRunId: runId,
          retrievalAttemptId: attempt.id, memoryGenerationSnapshot: 0, retrievalRevisionSnapshot: 0,
          finalizedRevisionSnapshot: 0, settingsSnapshot: {}, queryHash: "e".repeat(64),
          queryPlannerVersion: "fixture", retrievalPipelineVersion: "fixture", contextTextHash: "f".repeat(64),
          contextTokenCount: 0, outcome, degradationCode, finalizedAt } });
      };
      await receipt("memory_preparation_skipped", "FAILED_SAFE", 2 * hour);
      await receipt("memory_admission_deadline_exceeded", "FAILED_SAFE", hour);
      await receipt("memory_admission_settings_changed", "FAILED_SAFE", 30 * 60_000);
      // Retrieval-level optional fallbacks, ordinary receipts and old receipts are not counted.
      await receipt(null, "FAILED_SAFE", hour);
      await receipt(null, "EMPTY", hour);
      await receipt("memory_preparation_skipped", "FAILED_SAFE", 25 * hour);
      await run("error", "memory_preparing_failed", 3 * hour);
      await run("error", "memory_source_stale", hour);
      await run("error", "memory_source_deleted", hour);
      await run("error", "memory_item_forgotten", 10 * 60_000);
      // Post-dispatch, non-Memory, non-terminal and old failures are not preparation failures.
      await run("error", "memory_answer_model_tools_retired", hour);
      await run("error", "memory_egress_changed", hour);
      await run("error", "provider_admission_changed", hour);
      await run("complete", "memory_preparing_failed", hour);
      await run("error", "memory_preparing_failed", 25 * hour);

      const result = await readAdminMemoryProcessing(prisma, now);
      const preparation = result.issues.filter(({ stage }) => stage === "PREPARATION");
      expect(preparation).toEqual([
        { stage: "PREPARATION", reason: "PREPARATION_FAILED", severity: "warn", count: 4, oldestAgeSeconds: 10800 },
        { stage: "PREPARATION", reason: "PREPARATION_SKIPPED", severity: "warn", count: 3, oldestAgeSeconds: 7200 }
      ]);
      expect(JSON.stringify(result)).not.toMatch(/private|memory-status|fixture|memory_prep|memory_source/u);
      const attention = adminMemoryStatusForAttention({ processing: result } as Parameters<typeof adminMemoryStatusForAttention>[0]);
      expect(attention.processing.issues.some(({ stage }) => stage === "PREPARATION")).toBe(false);
      await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
      expect((await readAdminMemoryProcessing(prisma, now)).issues
        .filter(({ stage }) => stage === "PREPARATION")).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
