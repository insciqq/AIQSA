// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { prisma } from "../prisma";
import { createPrismaRetentionRepository } from "../retention/prune";
import { createFileSystemStorageAdapter, createS3StorageAdapter } from "../uploads/storage";
import { measureObservationJson } from "./codec";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import { createToolObservationRepository, ObservationStoreError, type ObservationActor } from "./repository";
import { mcpObservationMaximumBytes, observationFailure, TOOL_OBSERVATION_LIMITS } from "./contract";
import { createToolObservationService } from "./service";
import { createObservationAdmission } from "./admission";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function fixture() {
  const user = await prisma.user.create({ data: { id: randomUUID(), displayName: "Synthetic observation owner", status: "active" } });
  const chat = await prisma.chat.create({ data: { title: "Synthetic observation chat", userId: user.id } });
  cleanups.push(async () => {
    const observations = await prisma.toolObservation.findMany({ where: { modelRun: { chatId: chat.id } }, select: { storageKey: true } });
    await prisma.modelRun.deleteMany({ where: { chatId: chat.id } });
    await prisma.chat.updateMany({ where: { id: chat.id }, data: { activeLeafMessageId: null } });
    await prisma.message.deleteMany({ where: { chatId: chat.id } });
    await prisma.chat.deleteMany({ where: { id: chat.id } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: user.id, targetId: chat.id } });
    await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: observations.flatMap(row => row.storageKey ? [row.storageKey] : []) } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });
  const makeRun = async (parent: string | null = null, normalizedRequest: Prisma.InputJsonValue = {}) => {
    const question = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete", parentMessageId: parent,
      content: textMessageContent("Read the exact accepted result") } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", status: "streaming", parentMessageId: question.id,
      content: textMessageContent("") } });
    const run = await prisma.modelRun.create({ data: { chatId: chat.id, userId: user.id, userMessageId: question.id,
      assistantMessageId: answer.id, provider: "fake", modelId: "fake-qsa", normalizedRequest, status: "in_progress" } });
    return { ...run, actor: { runId: run.id, userId: user.id } };
  };
  const run = await makeRun();
  let ordinal = 0;
  const call = async (actor: ObservationActor = run.actor) => {
    const row = await prisma.modelRunToolCall.create({ data: { modelRunId: actor.runId, roundIndex: 1,
      ordinal: ordinal++, providerCallId: randomUUID(), toolName: "synthetic_tool", arguments: {}, state: "running" } });
    return { ...actor, toolCallId: row.id };
  };
  const authorizeSource = vi.fn(async () => undefined);
  const loadSource = vi.fn(async (): Promise<unknown> => ({ retained: "source original" }));
  const repository = createToolObservationRepository({ prisma, authorizeSource, loadSource });
  const storage = createMemoryStorageAdapter();
  const service = createToolObservationService({ repository, storage });
  const write = async (original: unknown = { accepted: "original" }) => {
    const producer = await call();
    const result = await service.withReservation({ producer, source: "workspace", maximumBytes: 1024 * 1024 },
      receipt => receipt.store({ original, outcome: "complete", sourceTruncated: true, maskable: true }));
    await prisma.modelRunToolCall.update({ where: { id: producer.toolCallId }, data: { state: "complete", result: { observation: result.observation } } });
    return { producer, result, id: result.observation.handle.slice(5) };
  };
  return { user, chat, run, call, makeRun, repository, service, storage, write, authorizeSource, loadSource };
}

describe("durable tool observation ownership", () => {
  it("bounds a parallel batch of large originals while retaining exact filesystem recall", async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-observation-resource-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filesystem = createFileSystemStorageAdapter(directory);
    // Count storage phases, not business calls: only uploads hold capacity.
    let uploading = 0, peakUploading = 0;
    const storage = { ...filesystem, async putObjectStream(value: Parameters<NonNullable<typeof filesystem.putObjectStream>>[0]) {
      uploading++; peakUploading = Math.max(peakUploading, uploading);
      try { return await filesystem.putObjectStream!(value); } finally { uploading--; }
    } };
    // Two 8 MiB-class originals may stream at once; business calls are not gated.
    const admission = createObservationAdmission(2 * (6 * 1024 * 1024 + 1024), 64);
    const service = createToolObservationService({ repository: f.repository, storage, admission });
    const producers = await Promise.all(Array.from({ length: 4 }, () => f.call()));
    const baselineRss = process.memoryUsage().rss;
    let active = 0, peakActive = 0, peakRss = baselineRss, dispatched = 0;
    const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
    const timer = setInterval(sample, 10);
    let release!: () => void;
    const allDispatched = new Promise<void>(resolve => { release = resolve; });
    try {
      const results = await Promise.all(producers.map(async (producer, index) => {
        const result = await service.withReservation({ producer, source: "mcp", maximumBytes: 8 * 1024 * 1024 }, async receipt => {
          active++; peakActive = Math.max(peakActive, active); dispatched++;
          if (dispatched === producers.length) release();
          try {
            await allDispatched;
            const original = { text: ["x".repeat(6 * 1024 * 1024) + `rare_tail=${index}`], structuredContent: null,
              isError: false, unsupportedContentTypes: [] };
            const projection = await receipt.store({ original, outcome: "complete", sourceTruncated: false, maskable: true });
            sample();
            return projection;
          } finally { active--; }
        });
        await prisma.modelRunToolCall.update({ where: { id: producer.toolCallId }, data: { state: "complete" } });
        return result;
      }));
      const retained = await prisma.toolObservation.findMany({ where: { modelRunId: f.run.id } });
      expect(dispatched).toBe(4);
      expect(peakActive).toBe(4);
      expect(peakUploading).toBeLessThanOrEqual(2);
      expect(active).toBe(0);
      expect(retained).toHaveLength(4);
      expect(retained.every(row => row.storageMode === "OBJECT" && row.state === "READY")).toBe(true);
      const projectionBytes = Buffer.byteLength(JSON.stringify(results));
      expect(projectionBytes).toBeLessThan(12 * 1024);
      const restarted = createToolObservationService({ repository: f.repository, storage: createFileSystemStorageAdapter(directory) });
      for (const [index, result] of results.entries()) {
        const fragment = await restarted.read(f.run.actor, { handle: result.observation.handle, query: "rare_tail", maxBytes: 128 });
        expect(fragment.fragment).toContain(`rare_tail=${index}`);
      }
      process.stdout.write(JSON.stringify({ observationResource: { calls: dispatched, peakActive, peakUploading,
        originalsBytes: retained.reduce((sum, row) => sum + row.byteSize!, 0), projectionBytes,
        baselineRssBytes: baselineRss, peakRssBytes: peakRss, processMaxRssKiB: process.resourceUsage().maxRSS } }) + "\n");
    } finally { clearInterval(timer); }
  });

  it("reserves one producer under competing claims and degrades a call beyond the aggregate space before dispatch", async () => {
    // At the default wire cap the run bound is exactly its 64 MiB budget.
    vi.stubEnv("AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES", String(8 * 1024 * 1024));
    cleanups.push(async () => { vi.unstubAllEnvs(); });
    const f = await fixture();
    const producer = await f.call();
    const claims = await Promise.all([f.repository.reserve(producer, "mcp", 32 * 1024 * 1024),
      f.repository.reserve(producer, "mcp", 32 * 1024 * 1024)]);
    expect(claims.filter(claim => claim.claimed)).toHaveLength(1);
    expect(new Set(claims.map(claim => claim.observation.id)).size).toBe(1);
    await f.repository.reserve(await f.call(), "mcp", 32 * 1024 * 1024);
    // Beyond the run's space the call is still claimed, reserving nothing.
    expect(await f.repository.reserve(await f.call(), "mcp", 1)).toMatchObject({ claimed: true, degraded: true,
      observation: { state: "RESERVED", reservedBytes: 0 } });
    expect(await prisma.toolObservation.count({ where: { modelRunId: f.run.id } })).toBe(3);
  });

  it("recalls only settled results on the accepted branch, without a Workspace session", async () => {
    const f = await fixture();
    const saved = await f.write();
    expect(await f.service.read(f.run.actor, { handle: saved.result.observation.handle })).toMatchObject({
      fragment: '{"accepted":"original"}', observation: { sourceTruncated: true } });
    await prisma.modelRunToolCall.update({ where: { id: saved.producer.toolCallId }, data: { state: "running" } });
    await expect(f.repository.read(f.run.actor, saved.id)).rejects.toThrow("tool_observation_unavailable");
    await prisma.modelRunToolCall.update({ where: { id: saved.producer.toolCallId }, data: { state: "complete" } });
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "complete" } });
    const next = await f.makeRun(f.run.assistantMessageId);
    expect((await f.repository.read(next.actor, saved.id)).checksum).toBe(saved.result.observation.checksum);
    await prisma.modelRun.update({ where: { id: next.id }, data: { status: "complete" } });
    // Another edit of the question never reads the original branch.
    const sibling = await f.makeRun(null);
    await expect(f.repository.read(sibling.actor, saved.id)).rejects.toThrow("tool_observation_unavailable");
    await prisma.modelRun.update({ where: { id: sibling.id }, data: { status: "complete" } });
    // A regeneration of the same question reads its earlier attempt's results.
    const regenerated = await prisma.message.create({ data: { chatId: f.chat.id, role: "assistant", status: "streaming",
      parentMessageId: f.run.userMessageId, content: textMessageContent("") } });
    const attempt = await prisma.modelRun.create({ data: { chatId: f.chat.id, userId: f.user.id, userMessageId: f.run.userMessageId,
      assistantMessageId: regenerated.id, provider: "fake", modelId: "fake-qsa", normalizedRequest: {}, status: "in_progress" } });
    expect((await f.repository.read({ runId: attempt.id, userId: f.user.id }, saved.id)).checksum).toBe(saved.result.observation.checksum);
  });

  it("rejects copied handles in another chat/owner and suppresses revoked source access", async () => {
    const f = await fixture();
    const other = await fixture();
    const saved = await f.write();
    await expect(f.repository.read(other.run.actor, saved.id)).rejects.toThrow("tool_observation_unavailable");
    await expect(f.repository.read({ ...f.run.actor, userId: other.user.id }, saved.id)).rejects.toThrow("tool_observation_unavailable");
    f.authorizeSource.mockRejectedValue(new ObservationStoreError("tool_observation_unavailable"));
    await expect(f.repository.read(f.run.actor, saved.id)).rejects.toThrow("tool_observation_unavailable");
  });

  it("checks a branch's handle set in one authorization-only transaction without object reads", async () => {
    const f = await fixture();
    const inline = await f.write({ accepted: "inline" });
    const external = await f.write({ accepted: "external ".repeat(20_000) });
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "complete" } });
    const next = await f.makeRun(f.run.assistantMessageId);
    const handles = [inline.result.observation.handle, external.result.observation.handle];
    f.authorizeSource.mockClear();
    const reads = vi.spyOn(f.storage, "getObjectStream");
    const transactions = vi.spyOn(prisma, "$transaction");
    try {
      await expect(f.service.available(next.actor, handles)).resolves.toBe(true);
      expect(transactions).toHaveBeenCalledOnce();
    } finally {
      transactions.mockRestore();
    }
    expect(reads).not.toHaveBeenCalled();
    expect(f.authorizeSource).toHaveBeenCalledTimes(2);
    f.authorizeSource.mockRejectedValueOnce(new McpToolAccessDeniedError());
    await expect(f.service.available(next.actor, handles)).resolves.toBe(false);
    await prisma.modelRunToolCall.update({ where: { id: external.producer.toolCallId }, data: { state: "running" } });
    await expect(f.service.available(next.actor, handles)).resolves.toBe(false);
    await prisma.modelRunToolCall.update({ where: { id: external.producer.toolCallId }, data: { state: "complete" } });
    await expect(f.service.available(next.actor, handles)).resolves.toBe(true);
    await prisma.modelRun.update({ where: { id: next.id }, data: { status: "complete" } });
    const sibling = await f.makeRun(null);
    await expect(f.service.available(sibling.actor, handles)).resolves.toBe(false);
  });

  it("retains the tool loop's recoverable-error authority and fences a terminal error", async () => {
    const f = await fixture();
    const saved = await f.write();
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "error",
      errorPayload: { code: "provider_request_failed", message: "Synthetic recoverable failure" } } });
    expect((await f.service.restore(saved.producer)).projection.observation).toEqual(saved.result.observation);
    expect((await f.service.read(f.run.actor, { handle: saved.result.observation.handle })).fragment).toContain("original");
    await prisma.modelRun.update({ where: { id: f.run.id }, data: {
      errorPayload: { code: "provider_request_failed", message: "Synthetic terminal failure", recoveryTerminal: true } } });
    await expect(f.service.restore(saved.producer)).rejects.toThrow("tool_observation_unavailable");
    await expect(f.service.read(f.run.actor, { handle: saved.result.observation.handle })).rejects.toThrow("tool_observation_unavailable");
  });

  it.each(["archive", "purge", "user", "stop"])("applies current %s lifecycle to every read", async boundary => {
    const f = await fixture();
    const saved = await f.write();
    if (boundary === "archive") await prisma.chat.update({ where: { id: f.chat.id }, data: { archived: true } });
    if (boundary === "purge") await prisma.$transaction(async tx => {
      const deletion = await tx.memoryDeletionOutbox.create({ data: { userId: f.user.id, operation: "SOURCE_PURGE",
        targetType: "CHAT@memory-chat-delete-v1", targetId: f.chat.id, memoryGeneration: 0,
        admissionAuthorizationId: randomUUID(), admittedChatSourceRevision: f.chat.memorySourceRevision, alsoForgetOriginMemories: false } });
      await tx.chat.update({ where: { id: f.chat.id }, data: { archived: true, memoryMode: "EXCLUDED",
        permanentDeletionAt: new Date(), permanentDeletionOperationId: deletion.id } });
    });
    if (boundary === "user") await prisma.user.update({ where: { id: f.user.id }, data: { status: "disabled" } });
    if (boundary === "stop") await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
    await expect(f.repository.read(f.run.actor, saved.id)).rejects.toThrow("tool_observation_unavailable");
  });

  it("prevents cross-run relational ownership", async () => {
    const f = await fixture();
    const other = await fixture();
    const call = await other.call();
    await expect(prisma.toolObservation.create({ data: { id: randomUUID().replaceAll("-", ""), modelRunId: f.run.id,
      toolCallId: call.toolCallId, sourceKind: "mcp", reservedBytes: 100 } })).rejects.toThrow();
  });

  it("publishes only verified objects, protects live references and leaves cleanup after row deletion", async () => {
    const f = await fixture();
    const saved = await f.write({ text: "x".repeat(20000) });
    const row = await f.repository.read(f.run.actor, saved.id);
    expect(row.storageMode).toBe("OBJECT");
    const job = await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: row.storageKey! } });
    expect(job.claimToken).toBeNull();
    const retention = createPrismaRetentionRepository(prisma);
    const options = { now: new Date(Date.now() + 300000), claimableBefore: new Date(Date.now() + 300000), limit: 1000 };
    expect(await retention.findClaimableAttachmentDeletionJobIds(options)).not.toContain(job.id);
    await prisma.modelRun.delete({ where: { id: f.run.id } });
    expect(await prisma.toolObservation.count({ where: { id: row.id } })).toBe(0);
    expect(await retention.findClaimableAttachmentDeletionJobIds(options)).toContain(job.id);
    // Cleanup remains possible even after its relation has gone.
    await prisma.attachmentDeletionJob.delete({ where: { id: job.id } });
  });

  it("guards immutability and keeps a lost write acknowledgement from invalidating READY", async () => {
    const f = await fixture();
    const saved = await f.write({ text: "x".repeat(10000) });
    await f.repository.unavailable(saved.producer, "tool_observation_unavailable", "stale-token");
    await f.repository.recordOutcome(saved.producer, "unknown");
    expect((await f.repository.read(f.run.actor, saved.id)).executionOutcome).toBe("complete");
    for (const data of [{ checksum: "b".repeat(64) }, { state: "UNAVAILABLE" }, { sourceTruncated: false }, { projection: Prisma.JsonNull }]) {
      await expect(prisma.toolObservation.update({ where: { id: saved.id }, data })).rejects.toThrow();
    }
  });

  it("recalls exact original bytes through the disposable S3 streaming backend", async () => {
    const f = await fixture();
    const storage = createS3StorageAdapter();
    const getBuffer = vi.spyOn(storage, "getObject").mockRejectedValue(new Error("buffer_fallback_forbidden"));
    const putBuffer = vi.spyOn(storage, "putObject").mockRejectedValue(new Error("buffer_fallback_forbidden"));
    const service = createToolObservationService({ repository: f.repository, storage });
    const producer = await f.call();
    const original = { rows: "padding ".repeat(20000), tail: { marker: "unique-S3-Я😀", count: 314159 } };
    let storageKey: string | null = null;
    try {
      const projection = await service.withReservation({ producer, source: "mcp", maximumBytes: 1024 * 1024 },
        receipt => receipt.store({ original, outcome: "complete", sourceTruncated: false, maskable: true }));
      await prisma.modelRunToolCall.update({ where: { id: producer.toolCallId }, data: { state: "complete" } });
      storageKey = (await prisma.toolObservation.findUniqueOrThrow({ where: { toolCallId: producer.toolCallId } })).storageKey;
      const another = createToolObservationService({ repository: f.repository, storage: createS3StorageAdapter() });
      const read = await another.read(f.run.actor, { handle: projection.observation.handle, query: "unique-S3-Я😀" });
      expect(read.fragment).toContain('"count":314159');
      expect(read.fragment).toBe(Buffer.from(JSON.stringify(original)).subarray(read.offset, read.endOffset).toString());
      expect(getBuffer).not.toHaveBeenCalled();
      expect(putBuffer).not.toHaveBeenCalled();
    } finally {
      storageKey ??= (await prisma.toolObservation.findUnique({ where: { toolCallId: producer.toolCallId } }))?.storageKey ?? null;
      if (storageKey) await storage.deleteObject(storageKey);
    }
  });

  it("keeps an orphan obligation before upload and rejects Stop or stale lease publication", async () => {
    const f = await fixture();
    const producer = await f.call();
    await f.repository.reserve(producer, "mcp", 20000);
    await f.repository.recordOutcome(producer, "complete");
    const identity = measureObservationJson({ text: "x".repeat(10000) }, 20000, 0);
    const storing = await f.repository.beginWrite(producer, { byteSize: identity.byteSize, checksum: identity.checksum,
      inlineText: null, storageMode: "OBJECT", projection: null, sourceTruncated: false, maskable: true });
    const job = await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: storing.storageKey! } });
    expect(job.claimToken).toBe(storing.leaseToken);
    await expect(f.repository.finishWrite(producer, "stale-token")).rejects.toThrow("tool_observation_conflict");
    f.authorizeSource.mockRejectedValueOnce(new ObservationStoreError("tool_observation_unavailable"));
    await expect(f.repository.finishWrite(producer, storing.leaseToken!)).rejects.toThrow("tool_observation_unavailable");
    expect(await prisma.toolObservation.findUnique({ where: { id: storing.id } })).toMatchObject({ state: "STORING" });
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
    await expect(f.repository.finishWrite(producer, storing.leaseToken!)).rejects.toThrow("tool_observation_unavailable");
    await f.repository.unavailable(producer, "tool_observation_unavailable", storing.leaseToken!);
    expect(await prisma.toolObservation.findUnique({ where: { id: storing.id } })).toMatchObject({
      state: "UNAVAILABLE", reservedBytes: 0, executionOutcome: "complete" });
    expect(await prisma.attachmentDeletionJob.findUnique({ where: { id: job.id } })).toMatchObject({ claimToken: null });
    await expect(prisma.toolObservation.update({ where: { id: storing.id }, data: { state: "RESERVED" } })).rejects.toThrow();
  });

  it("releases dead reservations while retaining the original execution identity and late outcome", async () => {
    const f = await fixture();
    const producer = await f.call();
    const reserved = await f.repository.reserve(producer, "mcp", 32 * 1024 * 1024);
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "error",
      errorPayload: { code: "provider_request_failed", message: "Synthetic terminal failure", recoveryTerminal: true } } });
    const next = await f.makeRun(f.run.assistantMessageId);
    await f.repository.reserve(await f.call(next.actor), "mcp", 32 * 1024 * 1024);
    expect(await prisma.toolObservation.findUnique({ where: { id: reserved.observation.id } })).toMatchObject({
      state: "UNAVAILABLE", reservedBytes: 0, executionOutcome: "unknown" });
    await f.repository.recordOutcome(producer, "complete");
    expect(await prisma.toolObservation.findUnique({ where: { id: reserved.observation.id } })).toMatchObject({
      state: "UNAVAILABLE", executionOutcome: "complete" });
  });

  it("verifies an existing source owner before publishing without copying its body", async () => {
    const f = await fixture();
    const producer = await f.call();
    const original = await f.loadSource();
    const identity = measureObservationJson(original, 4096, 0);
    await f.repository.reserve(producer, "knowledge", 4096);
    await f.repository.recordOutcome(producer, "complete");
    const value = { byteSize: identity.byteSize, checksum: identity.checksum, inlineText: null, storageMode: "SOURCE" as const,
      projection: null, sourceTruncated: false, maskable: true };
    await expect(f.repository.beginWrite(producer, { ...value, checksum: "b".repeat(64) })).rejects.toThrow("tool_observation_conflict");
    const saved = await f.repository.beginWrite(producer, value);
    await prisma.modelRunToolCall.update({ where: { id: producer.toolCallId }, data: { state: "complete" } });
    expect(saved).toMatchObject({ state: "READY", storageKey: null, inlineText: null, storageMode: "SOURCE" });
    expect((await f.repository.readSource(f.run.actor, saved.id)).original).toEqual(original);
  });

  it("keeps parallel reservations of a recoverable-error run live, as the tool loop does", async () => {
    const f = await fixture();
    const first = await f.call();
    const reserved = await f.repository.reserve(first, "mcp", 1024 * 1024);
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "error",
      errorPayload: { code: "provider_request_failed", message: "Synthetic recoverable failure" } } });
    // Recovery executes another call of the same run while the first is in flight.
    await f.repository.reserve(await f.call(), "mcp", 1024 * 1024);
    expect(await prisma.toolObservation.findUniqueOrThrow({ where: { id: reserved.observation.id } }))
      .toMatchObject({ state: "RESERVED", reservedBytes: 1024 * 1024, executionOutcome: null });
    await f.repository.recordOutcome(first, "complete");
    const identity = measureObservationJson({ accepted: "late result" }, 1024 * 1024, 8192);
    const ready = await f.repository.beginWrite(first, { byteSize: identity.byteSize, checksum: identity.checksum,
      inlineText: identity.inline, storageMode: "INLINE", projection: null, sourceTruncated: false, maskable: true });
    expect(ready).toMatchObject({ state: "READY", reservedBytes: identity.byteSize });
  });

  it("claims an unpublished Skill producer again but never a generic or retired producer", async () => {
    const f = await fixture();
    const skill = await f.call();
    const first = await f.repository.reserve(skill, "skill", 4096);
    expect(await f.repository.reserve(skill, "skill", 4096)).toMatchObject({ claimed: true, observation: { id: first.observation.id } });
    const generic = await f.call();
    await f.repository.reserve(generic, "mcp", 4096);
    expect((await f.repository.reserve(generic, "mcp", 4096)).claimed).toBe(false);
    await f.repository.unavailable(skill, "tool_observation_unavailable");
    expect((await f.repository.reserve(skill, "skill", 4096)).claimed).toBe(false);
  });

  it("does not exhaust run or branch space with small, source-owned or unavailable observations", async () => {
    const f = await fixture();
    for (let index = 0; index < 100; index++) await f.write({ index });
    // Source-owned receipts (75 MiB counted by size) and retired producers
    // exceed the run's byte and row limits unless only store bytes count.
    const calls = Array.from({ length: 450 }, (_, index) => ({ id: randomUUID(), modelRunId: f.run.id, roundIndex: 2,
      ordinal: index, providerCallId: randomUUID(), toolName: "synthetic_tool", arguments: {}, state: "complete" as const }));
    await prisma.modelRunToolCall.createMany({ data: calls });
    await prisma.toolObservation.createMany({ data: calls.map((call, index) => index < 300 ? {
      id: randomUUID().replaceAll("-", ""), modelRunId: f.run.id, toolCallId: call.id, sourceKind: "knowledge", state: "READY",
      executionOutcome: "complete", reservedBytes: 256 * 1024, byteSize: 256 * 1024, checksum: "c".repeat(64), storageMode: "SOURCE"
    } : {
      id: randomUUID().replaceAll("-", ""), modelRunId: f.run.id, toolCallId: call.id, sourceKind: "mcp", state: "UNAVAILABLE",
      executionOutcome: "unknown", reservedBytes: 0
    }) });
    const reserved = await f.repository.reserve(await f.call(), "mcp", 8 * 1024 * 1024 + 64 * 1024);
    expect(reserved).toEqual({ claimed: true, observation: expect.objectContaining({ reservedBytes: 8 * 1024 * 1024 + 64 * 1024 }) });
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "complete" } });
    const next = await f.makeRun(f.run.assistantMessageId);
    expect(await f.repository.reserve(await f.call(next.actor), "search", 8 * 1024 * 1024))
      .toEqual({ claimed: true, observation: expect.objectContaining({ reservedBytes: 8 * 1024 * 1024 }) });
  });

  it("admits new calls on a branch of 5000 small inline results while externalized bytes stay bounded", async () => {
    vi.stubEnv("AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES", String(8 * 1024 * 1024));
    cleanups.push(async () => { vi.unstubAllEnvs(); });
    const f = await fixture();
    const MiB = 1024 * 1024;
    let round = 10;
    const inline = async (runId: string, count: number) => {
      const roundIndex = round++;
      const calls = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), modelRunId: runId, roundIndex,
        ordinal: index, providerCallId: randomUUID(), toolName: "synthetic_tool", arguments: {}, state: "complete" as const }));
      await prisma.modelRunToolCall.createMany({ data: calls });
      const identity = measureObservationJson({ small: "inline result" }, 8192, 8192);
      await prisma.toolObservation.createMany({ data: calls.map(call => ({ id: randomUUID().replaceAll("-", ""), modelRunId: runId,
        toolCallId: call.id, sourceKind: "mcp", state: "READY", executionOutcome: "complete", reservedBytes: identity.byteSize,
        byteSize: identity.byteSize, checksum: identity.checksum, storageMode: "INLINE", inlineText: identity.inline })) });
    };
    // Beyond the former 512-per-run and 4096-per-branch row limits.
    await inline(f.run.id, 2500);
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "complete" } });
    const next = await f.makeRun(f.run.assistantMessageId);
    await inline(next.id, 2500);
    for (const source of ["mcp", "workspace", "search"] as const) {
      expect(await f.repository.reserve(await f.call(next.actor), source, mcpObservationMaximumBytes()))
        .toEqual({ claimed: true, observation: expect.objectContaining({ reservedBytes: mcpObservationMaximumBytes() }) });
    }
    // Retained objects of the branch still consume its byte budget.
    const objects = Array.from({ length: 7 }, (_, index) => ({ id: randomUUID(), modelRunId: f.run.id, roundIndex: round,
      ordinal: index, providerCallId: randomUUID(), toolName: "synthetic_tool", arguments: {}, state: "complete" as const }));
    await prisma.modelRunToolCall.createMany({ data: objects });
    await prisma.toolObservation.createMany({ data: objects.map(call => {
      const id = randomUUID().replaceAll("-", "");
      return { id, modelRunId: f.run.id, toolCallId: call.id, sourceKind: "mcp", state: "READY", executionOutcome: "complete",
        reservedBytes: 32 * MiB, byteSize: 32 * MiB, checksum: "d".repeat(64), storageMode: "OBJECT",
        storageKey: `tool-observations/v1/${id}/${"e".repeat(32)}` };
    }) });
    // Beyond it a call is still claimed, reserving nothing; a smaller one fits.
    expect(await f.repository.reserve(await f.call(next.actor), "mcp", mcpObservationMaximumBytes()))
      .toMatchObject({ claimed: true, degraded: true, observation: { reservedBytes: 0 } });
    expect(await f.repository.reserve(await f.call(next.actor), "mcp", MiB))
      .toEqual({ claimed: true, observation: expect.objectContaining({ reservedBytes: MiB }) });
  });

  it("admits a full parallel MCP batch at the 16 MiB wire cap with nothing retained", async () => {
    vi.stubEnv("AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES", String(16 * 1024 * 1024));
    cleanups.push(async () => { vi.unstubAllEnvs(); });
    const f = await fixture();
    const ceiling = mcpObservationMaximumBytes();
    expect(ceiling).toBe(16 * 1024 * 1024 + 64 * 1024);
    const producers = await Promise.all(Array.from({ length: TOOL_OBSERVATION_LIMITS.concurrentCalls }, () => f.call()));
    const claims = await Promise.all(producers.map(producer => f.repository.reserve(producer, "mcp", ceiling)));
    expect(claims.every(claim => claim.claimed && !claim.degraded && claim.observation.reservedBytes === ceiling)).toBe(true);
    // A call beyond the accepted concurrency is claimed, reserving nothing.
    expect(await f.repository.reserve(await f.call(), "mcp", ceiling)).toMatchObject({ claimed: true, degraded: true });
    // Publication releases the ceiling down to the exact inline size.
    await f.repository.recordOutcome(producers[0]!, "complete");
    const identity = measureObservationJson({ accepted: "small" }, ceiling, 8192);
    await f.repository.beginWrite(producers[0]!, { byteSize: identity.byteSize, checksum: identity.checksum,
      inlineText: identity.inline, storageMode: "INLINE", projection: null, sourceTruncated: false, maskable: true });
    expect(await f.repository.reserve(await f.call(), "mcp", ceiling))
      .toEqual({ claimed: true, observation: expect.objectContaining({ reservedBytes: ceiling }) });
  });

  it("reports a reservation refused by run or call authority as not started", async () => {
    const f = await fixture();
    const settled = await f.call();
    await prisma.modelRunToolCall.update({ where: { id: settled.toolCallId }, data: { state: "complete" } });
    await expect(f.repository.reserve(settled, "mcp", 4096)).rejects.toMatchObject({ code: "tool_observation_not_started" });
    const pending = await f.call();
    await prisma.modelRun.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
    const business = vi.fn();
    const refused = await f.service.withReservation({ producer: pending, source: "mcp", maximumBytes: 4096 }, business)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "tool_observation_not_started" });
    expect(business).not.toHaveBeenCalled();
    expect(observationFailure(refused)?.message).not.toMatch(/may have completed/iu);
    expect(await prisma.toolObservation.count({ where: { modelRunId: f.run.id } })).toBe(0);
  });

  it("reads and restores without waiting for settlement row locks", async () => {
    const f = await fixture();
    const saved = await f.write({ text: "x".repeat(20000) });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.user.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${f.chat.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${f.run.id} FOR UPDATE`;
      locked();
      await held;
    }, { timeout: 30_000 });
    await acquired;
    const withinDeadline = <T>(operation: Promise<T>) => Promise.race([operation, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("observation_read_waited_for_row_lock")), 5_000))]);
    try {
      expect((await withinDeadline(f.service.read(f.run.actor, { handle: saved.result.observation.handle }))).fragment).toContain("xxxx");
      expect((await withinDeadline(f.service.restore(saved.producer))).projection.observation).toEqual(saved.result.observation);
    } finally {
      release();
      await holder;
    }
  });

  it("keeps a cleanup obligation for an interrupted filesystem upload and reclaims its temporary file", async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-observation-upload-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const storage = createFileSystemStorageAdapter(directory);
    const producer = await f.call();
    await f.repository.reserve(producer, "mcp", 20000);
    await f.repository.recordOutcome(producer, "complete");
    const identity = measureObservationJson({ text: "x".repeat(10000) }, 20000, 0);
    const storing = await f.repository.beginWrite(producer, { byteSize: identity.byteSize, checksum: identity.checksum,
      inlineText: null, storageMode: "OBJECT", projection: null, sourceTruncated: false, maskable: true });
    // A process crash mid-upload leaves only the adapter's exact-key sibling.
    const temporary = join(directory, `${storing.storageKey!}.upload-${randomUUID()}`);
    await mkdir(dirname(temporary), { recursive: true });
    await writeFile(temporary, "partial original");
    const job = await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: storing.storageKey! } });
    const retention = createPrismaRetentionRepository(prisma);
    const now = new Date();
    expect(await retention.findClaimableAttachmentDeletionJobIds({ now, claimableBefore: now, limit: 1000 })).not.toContain(job.id);
    const afterLease = new Date(Date.now() + TOOL_OBSERVATION_LIMITS.storageLeaseMs + 60_000);
    expect(await retention.findClaimableAttachmentDeletionJobIds({ now: afterLease, claimableBefore: afterLease, limit: 1000 })).toContain(job.id);
    await storage.deleteObject(storing.storageKey!);
    expect(await readdir(dirname(temporary))).toEqual([]);
  });
});
