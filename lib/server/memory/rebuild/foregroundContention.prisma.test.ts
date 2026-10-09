// @vitest-environment node
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { normalizeTokenUsage } from "../../../domain/usage";
import { databaseFailureKind } from "../../observability/databaseFailure";
import { prisma } from "../../prisma";
import { createPrismaRunRepository } from "../../runs/prismaRepository";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import {
  claimContentionJob,
  cleanupContentionOwner,
  configureContentionEmbedding,
  contentionUploadHandler,
  contentionUploadRequest,
  createContentionOwner,
  createForegroundRun,
  mutateContentionSource,
  settled,
  syntheticText
} from "@/tests/support/memoryForegroundContention";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import { createPrismaMemoryHistoryIndexHandler } from "../history/handler";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_RECLASSIFICATION_PIPELINE_VERSION } from "../reclassification/classifier";
import { parseMemoryRebuildJobFingerprint } from "./contract";
import { createMemoryRebuildHandler } from "./handler";
import { createPrismaMemoryRebuildRepository } from "./repository";
import { wakeCurrentMemoryShadowRebuildInTransaction } from "./wake";

// Production (2026-10-08): an owner's re-embedding rebuild held the owner row
// for up to 20 s per catch-up pass, so usage settlement, uploads and the GET
// chat reconcile of the same owner expired their 5 s Prisma transactions
// (P2028). This owner's history is large enough that the unbounded pass held
// the owner for 9 s (first pass) and 5 s (each later pass) on the disposable
// database, measured before the fix.
const HISTORY_CHATS = 60;
const HISTORY_TURNS = 10;

/** One settled personal chat whose turns the real history indexer projects. */
async function seedChat(userId: string, ordinal: number, turns: number, answerCharacters: number): Promise<void> {
  const chat = await prisma.chat.create({ data: { title: `Contention ${ordinal}`, userId } });
  const base = Date.UTC(2026, 6, 1) + ordinal * 3_600_000;
  let parentMessageId: string | null = null;
  let last = { assistantMessageId: "", runId: "" };
  for (let turn = 0; turn < turns; turn += 1) {
    const createdAt = new Date(base + turn * 120_000);
    const answeredAt = new Date(createdAt.getTime() + 1_000);
    const question: { id: string } = await prisma.message.create({ data: { chatId: chat.id,
      content: textMessageContent(syntheticText(ordinal * 1_000 + turn, 280, `Question ${ordinal}-${turn}.`)),
      createdAt, parentMessageId, role: "user", status: "complete", updatedAt: createdAt } });
    const answer: { id: string } = await prisma.message.create({ data: { chatId: chat.id,
      content: textMessageContent(syntheticText(ordinal * 1_000 + turn + 500, answerCharacters, `Answer ${ordinal}-${turn}.`)),
      createdAt: answeredAt, modelId: "contention-model", parentMessageId: question.id, provider: "contention-provider",
      role: "assistant", status: "complete", updatedAt: answeredAt } });
    const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id,
      modelId: "contention-model", provider: "contention-provider", status: "complete", userId, userMessageId: question.id,
      normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } } } } });
    parentMessageId = answer.id;
    last = { assistantMessageId: answer.id, runId: run.id };
  }
  await mutateContentionSource(userId, chat.id, { mutations: ["NORMAL_APPEND"],
    patch: { activeLeafMessageId: last.assistantMessageId } });
  await mutateContentionSource(userId, chat.id, { mutations: ["TERMINAL_SETTLEMENT"], terminalSettlement: {
    assistantMessageId: last.assistantMessageId, runId: last.runId, status: "complete"
  } });
}

/** Indexes every settled chat through the production handler and commit. */
async function indexHistory(userId: string): Promise<void> {
  const handler = createPrismaMemoryHistoryIndexHandler(prisma);
  const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
  for (;;) {
    const job = await prisma.memoryJob.findFirst({
      orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
      where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
    });
    if (!job) return;
    // The newest turn supersedes every older queued turn of its chat.
    if (job.chatId) {
      await prisma.memoryJob.updateMany({ data: { errorCode: "memory_source_stale", state: "STALE" },
        where: { chatId: job.chatId, id: { not: job.id }, kind: "INDEX_HISTORY", state: "QUEUED", userId } });
    }
    const claim = await claimContentionJob(job.id);
    const decision = await handler.preflight(claim);
    if (decision.status !== "READY") {
      await coordinator.settleJobGate({ claim, decision, now: new Date() });
      continue;
    }
    const now = new Date();
    const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
      signal: new AbortController().signal });
    expect(await coordinator.commitJobSuccess({ acceptedResultHash: result.acceptedResultHash, apply: result.apply,
      claim, now, stage: result.stage ?? null })).toBe(true);
  }
}

async function seedHistory(userId: string, chats: number, turns: number, answerCharacters: number): Promise<void> {
  for (let chat = 0; chat < chats; chat += 1) {
    await seedChat(userId, chat, turns, answerCharacters);
    if (chat % 10 === 9) await indexHistory(userId);
  }
  await indexHistory(userId);
  // Autovacuum statistics a long-lived installation has; a fresh bulk set
  // would otherwise plan the source guards and enumeration without them.
  await prisma.$executeRawUnsafe(`ANALYZE "Chat", "Message", "ModelRun", "ChatMemoryCheckpoint", ` +
    `"ChatMemoryCheckpointMessage", "MemoryRecallChunk", "MemoryRecallChunkMessage", "MemoryRecallRound", ` +
    `"MemoryRecallRoundMessage", "MemoryRecallRoundSegment", "MemoryRecallRoundSegmentMessage", "MemorySearchEntry"`);
}

describe("Memory background commits and the owner's foreground writes", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps usage settlement, an upload and a stale-run failure writable during every rebuild pass", async () => {
    const userId = await createContentionOwner("rebuild");
    let provider: Awaited<ReturnType<typeof configureContentionEmbedding>> | null = null;
    try {
      await seedHistory(userId, HISTORY_CHATS, HISTORY_TURNS, 5_200);
      provider = await configureContentionEmbedding(userId);
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const rebuild = createPrismaMemoryRebuildRepository(prisma);
      const admitted = await rebuild.admit(userId, { embeddingDeploymentId: provider.modelId,
        expectedMemoryRevision: settings.memoryRevision, expectedSettingsRevision: settings.settingsRevision,
        operation: "REEMBED", pin: provider.pin, requestIdentity: { nonce: "contention" } });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const identity = parseMemoryRebuildJobFingerprint((await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId } })).idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("memory_contention_shadow_missing");
      const eligibleEntries = await prisma.memorySearchEntry.count({
        where: { indexGenerationId: settings.activeIndexGenerationId!, userId } });

      const runs = createPrismaRunRepository(prisma);
      const storage = createMemoryStorageAdapter();
      const POST = contentionUploadHandler(userId, storage);
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      const handler = createMemoryRebuildHandler(rebuild);
      const usage = normalizeTokenUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
      const evidence: Array<Readonly<{ maintenance: boolean }>> = [];
      const fixtures: Array<{ failed: { assistantMessageId: string; runId: string };
        usage: { chatId: string; runId: string } }> = [];
      for (let pass = 0; pass < 30; pass += 1) {
        const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: admitted.jobId } });
        const generation = await prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: identity.generationId } });
        // Every window pass while the entry set is built, then one embedding
        // progress pass of the completed set, woken as an embedding would.
        if (job.state === "SUCCEEDED") {
          if (evidence.some(({ maintenance }) => maintenance)) break;
          expect(generation.state).toBe("CATCHING_UP");
          await expect(prisma.$transaction((tx) => wakeCurrentMemoryShadowRebuildInTransaction(tx, userId)))
            .resolves.toBe(1);
        } else {
          // An unfinished entry set records no caught-up revision.
          expect([job.state, generation.state, generation.indexedThroughMemoryRevision])
            .toEqual(["QUEUED", "BUILDING", 0]);
        }
        const fixture = { failed: await createForegroundRun(runs, userId, `Stale ${pass}`),
          usage: await createForegroundRun(runs, userId, `Usage ${pass}`) };
        fixtures.push(fixture);
        const claim = await claimContentionJob(admitted.jobId);
        await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
        const now = new Date();
        const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
          signal: new AbortController().signal });
        let ownerHeld!: () => void;
        const held = new Promise<void>((resolve) => { ownerHeld = resolve; });
        const origin = performance.now();
        const commit = settled(coordinator.commitJobSuccess({
          acceptedResultHash: result.acceptedResultHash,
          // The coordinator calls apply once it holds the owner lock.
          apply: async (tx, committedClaim) => { ownerHeld(); return result.apply!(tx, committedClaim); },
          claim, now, stage: result.stage ?? null
        }), origin);
        await held;
        const [recorded, uploaded, failed] = await Promise.all([
          settled(runs.recordRunUsageEvents({ chatId: fixture.usage.chatId, runId: fixture.usage.runId, userId,
            usageAttributions: [{ modelId: "fake-qsa", provider: "fake", purpose: "chat_answer", usage }] }), origin),
          settled(POST(contentionUploadRequest()).then((response) => response.status), origin),
          // The GET chat reconcile ends an orphaned run through this write.
          settled(runs.failRun(fixture.failed.runId, fixture.failed.assistantMessageId,
            { code: "run_orphaned", message: "Run stopped reporting progress and was marked failed." }), origin)
        ]);
        const memory = await commit;
        const outcome = { failed, maintenance: job.state === "SUCCEEDED", memory, pass, recorded, uploaded };
        evidence.push(outcome);
        console.info("memory_foreground_contention_pass", JSON.stringify(outcome));
        expect({ failed, memory, recorded, uploaded }).toEqual({
          failed: expect.objectContaining({ ok: true, value: true }),
          memory: expect.objectContaining({ ok: true, value: true }),
          recorded: expect.objectContaining({ ok: true, value: true }),
          uploaded: expect.objectContaining({ ok: true, value: 200 })
        });
      }
      console.info("memory_foreground_contention", JSON.stringify({ eligibleEntries, passes: evidence.length }));

      // Each pass wrote at most one window; the completed shadow holds every
      // eligible item once and waits for its vectors.
      expect(evidence.filter(({ maintenance }) => !maintenance).length)
        .toBe(Math.ceil(eligibleEntries / 500));
      expect(evidence.filter(({ maintenance }) => maintenance)).toHaveLength(1);
      const shadow = await prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: identity.generationId } });
      expect(shadow.state).toBe("CATCHING_UP");
      expect(shadow.indexedThroughMemoryRevision).toBeGreaterThanOrEqual(settings.memoryRevision);
      await expect(prisma.memorySearchEntry.count({ where: { indexGenerationId: identity.generationId, userId } }))
        .resolves.toBe(eligibleEntries);
      // Provider-reported usage persisted exactly once per run; every stale
      // run ended once, and every uploaded object has its attachment row.
      for (const fixture of fixtures) {
        await expect(prisma.usageEvent.count({ where: { modelRunId: fixture.usage.runId, purpose: "chat_answer" } }))
          .resolves.toBe(1);
        await expect(prisma.modelRun.findUniqueOrThrow({ select: { errorPayload: true, status: true },
          where: { id: fixture.failed.runId } })).resolves.toMatchObject({
          errorPayload: { code: "run_orphaned" }, status: "error" });
      }
      const attachments = await prisma.attachment.findMany({ select: { storageKey: true }, where: { userId } });
      expect(attachments.map(({ storageKey }) => storageKey).sort()).toEqual([...storage.objects.keys()].sort());
      expect(attachments).toHaveLength(fixtures.length);
    } finally {
      await cleanupContentionOwner(userId);
      await provider?.cleanup();
    }
  }, 600_000);

  it("never makes a foreign-key insert wait for a held Memory owner lock, yet still orders explicit owner locks", async () => {
    const userId = await createContentionOwner("foreign-key");
    try {
      let ownerHeld!: () => void;
      const held = new Promise<void>((resolve) => { ownerHeld = resolve; });
      let releasedAt = 0;
      const memory = withLockedMemoryTransaction(prisma, userId, async () => {
        ownerHeld();
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        releasedAt = performance.now();
      }, { interactiveBounds: { maxWaitMs: 2_000, timeoutMs: 15_000 } });
      await held;
      const done = (operation: Promise<unknown>) => operation.then(() => performance.now());
      const [attachmentAt, chatAt, ownerLockAt] = await Promise.all([
        done(prisma.attachment.create({ data: { byteSize: 1, checksum: "0".repeat(64), fileName: "fk.png",
          kind: "image", metadata: {}, mimeType: "image/png", processingJob: { create: { ownerUserId: userId } },
          status: "processing", storageKey: `${userId}/${randomUUID()}-fk.png`, userId } })),
        done(prisma.chat.create({ data: { title: "Foreign key", userId } })),
        // Run settlement still serializes with Memory through the owner row.
        done(prisma.$transaction((tx) => tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
        `), { timeout: 15_000, maxWait: 2_000 }))
      ]);
      await memory;
      expect(attachmentAt).toBeLessThan(releasedAt);
      expect(chatAt).toBeLessThan(releasedAt);
      expect(ownerLockAt).toBeGreaterThanOrEqual(releasedAt);
    } finally {
      await cleanupContentionOwner(userId);
    }
  }, 60_000);

  it("yields a background commit's owner wait to a foreground holder and retries a usage write past one", async () => {
    const userId = await createContentionOwner("yield");
    const writer = vi.spyOn(process.stdout, "write");
    try {
      const runs = createPrismaRunRepository(prisma);
      const usageRun = await createForegroundRun(runs, userId, "Usage behind a long owner lock");
      const exhaustedRun = await createForegroundRun(runs, userId, "Usage behind a longer owner lock");
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const job = await prisma.memoryJob.create({ data: {
        idempotencyFingerprint: `memory-contention-yield-${randomUUID()}`, kind: "RECLASSIFY_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION, userId
      } });
      const holdOwner = (milliseconds: number) => {
        let ownerHeld!: () => void;
        const held = new Promise<void>((resolve) => { ownerHeld = resolve; });
        const holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`);
          ownerHeld();
          await new Promise((resolve) => setTimeout(resolve, milliseconds));
        }, { maxWait: 2_000, timeout: milliseconds + 5_000 });
        return { held, holder };
      };
      writer.mockImplementation(() => true);

      const first = holdOwner(2_500);
      await first.held;
      const usage = normalizeTokenUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
      const claim = await claimContentionJob(job.id);
      const [committed, recorded] = await Promise.all([
        createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({ acceptedResultHash: "c".repeat(64), claim,
          now: new Date(), stage: "contention_settled" }),
        runs.recordRunUsageEvents({ chatId: usageRun.chatId, runId: usageRun.runId, userId,
          usageAttributions: [{ modelId: "fake-qsa", provider: "fake", purpose: "chat_answer", usage }] })
      ]);
      await first.holder;
      expect([committed, recorded]).toEqual([true, true]);
      const records = writer.mock.calls.flatMap(([chunk]) => {
        try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
      });
      expect(records).toContainEqual(expect.objectContaining({ event: "job_persistence", stage: "complete",
        action: "retry", prisma_code: "P2010", db_failure: "lock_timeout" }));
      await expect(prisma.usageEvent.count({ where: { modelRunId: usageRun.runId } })).resolves.toBe(1);

      // Past three bounded waits the rolled-back write ends with its lock
      // timeout instead of an expired transaction, and writes nothing.
      const second = holdOwner(7_500);
      await second.held;
      const exhausted = await runs.recordRunUsageEvents({ chatId: exhaustedRun.chatId, runId: exhaustedRun.runId,
        userId, usageAttributions: [{ modelId: "fake-qsa", provider: "fake", purpose: "chat_answer", usage }] })
        .catch((error: unknown) => error);
      await second.holder;
      expect(exhausted).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(databaseFailureKind(exhausted)).toBe("lock_timeout");
      await expect(prisma.usageEvent.count({ where: { modelRunId: exhaustedRun.runId } })).resolves.toBe(0);
    } finally {
      writer.mockRestore();
      await cleanupContentionOwner(userId);
    }
  }, 60_000);

  it("writes a large catch-up diff in requeued windows and leaves exact round segments untouched", async () => {
    const userId = await createContentionOwner("window");
    try {
      await seedHistory(userId, 3, 2, 400);
      const segmentRows = () => prisma.$queryRaw<Array<{ id: string; version: string }>>(Prisma.sql`
        SELECT segment."id", segment."xmin"::text AS "version" FROM "MemoryRecallRoundSegment" AS segment
        WHERE segment."userId" = ${userId} ORDER BY segment."id"
      `);
      const segmentsBefore = await segmentRows();
      expect(segmentsBefore.length).toBeGreaterThan(0);
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const repository = createPrismaMemoryRebuildRepository(prisma, { catchUpWriteWindow: 2 });
      const admitted = await repository.admit(userId, { expectedMemoryRevision: settings.memoryRevision,
        expectedSettingsRevision: settings.settingsRevision, operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "window" } });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const identity = parseMemoryRebuildJobFingerprint((await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId } })).idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("memory_contention_shadow_missing");
      const eligible = await prisma.memorySearchEntry.findMany({
        select: { itemType: true, recallChunkId: true, recallRoundSegmentId: true },
        where: { indexGenerationId: settings.activeIndexGenerationId!, userId }
      });
      const handler = createMemoryRebuildHandler(repository);
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      const entryCounts: number[] = [];
      for (let pass = 0; pass < 40; pass += 1) {
        const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: admitted.jobId } });
        if (job.state !== "QUEUED") break;
        const claim = await claimContentionJob(job.id);
        await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
        const now = new Date();
        const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
          signal: new AbortController().signal });
        expect(await coordinator.commitJobSuccess({ acceptedResultHash: result.acceptedResultHash,
          apply: result.apply, claim, now, stage: result.stage ?? null })).toBe(true);
        entryCounts.push(await prisma.memorySearchEntry.count({ where: { indexGenerationId: identity.generationId, userId } }));
        const generation = await prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: identity.generationId } });
        if (generation.state !== "ACTIVE") expect(generation.state).toBe("BUILDING");
      }
      // Two entry writes per pass, each pass queued again; the pass that
      // writes the last window proves the whole set and cuts over.
      expect(entryCounts).toEqual(Array.from({ length: Math.ceil(eligible.length / 2) },
        (_, index) => Math.min(eligible.length, 2 * (index + 1))));
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ activeIndexGenerationId: identity.generationId });
      const published = await prisma.memorySearchEntry.findMany({
        select: { itemType: true, recallChunkId: true, recallRoundSegmentId: true },
        where: { indexGenerationId: identity.generationId, userId }
      });
      const key = (entry: (typeof eligible)[number]) =>
        `${entry.itemType}:${entry.recallChunkId ?? ""}:${entry.recallRoundSegmentId ?? ""}`;
      expect(published.map(key).sort()).toEqual(eligible.map(key).sort());
      await expect(segmentRows()).resolves.toEqual(segmentsBefore);
    } finally {
      await cleanupContentionOwner(userId);
    }
  }, 120_000);
});
