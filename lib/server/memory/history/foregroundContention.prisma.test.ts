// @vitest-environment node
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { normalizeTokenUsage } from "../../../domain/usage";
import { prisma } from "../../prisma";
import { createPrismaRunRepository } from "../../runs/prismaRepository";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import {
  activateContentionVectorIndex,
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
import { createMemoryHistoryIndexHandler } from "./handler";
import { createPrismaMemoryHistoryIndexRepository } from "./repository";

// Production (2026-10-09): the first INDEX_HISTORY commit of a long chat held
// the owner row and the chat FOR SHARE for about 6 s, so the chat's Workspace
// export seal, which takes the chat FOR UPDATE inside Prisma's 5 s
// transaction, expired and a 12-minute run lost its files. On the disposable
// database this chat's first page (150 turns, two settled tool calls each, a
// vector index) held both locks for 16 s in one commit before the fix; the
// chat's FOR UPDATE and the owner's failRun expired (P2028) and usage
// settlement gave up (55P03).
const TURNS = 150;
const QUESTION_CHARACTERS = 1_500;
const ANSWER_CHARACTERS = 5_000;
const TOOL_CALLS = 2;
// The page write budget (600 estimated writes) admits at most fifteen such
// turns (each estimated above 40 writes) plus the two turns an APPEND page
// rewinds for context.
const MAX_MESSAGES_PER_PASS = 34;

type SeededChat = Readonly<{ chatId: string; pathIds: readonly string[]; toolCallIds: readonly string[] }>;

/** A settled personal chat of `turns` turns, each answer from one complete run
 * with `toolCalls` settled calls whose results project as observations. */
async function seedLongChat(userId: string, turns: number, toolCalls: number): Promise<SeededChat> {
  const chat = await prisma.chat.create({ data: { title: "Long history", userId } });
  const base = Date.UTC(2026, 5, 1);
  const messages: Prisma.MessageCreateManyInput[] = [];
  const runs: Prisma.ModelRunCreateManyInput[] = [];
  const calls: Prisma.ModelRunToolCallCreateManyInput[] = [];
  let parent: string | null = null;
  let lastRunId = "";
  for (let turn = 0; turn < turns; turn += 1) {
    const askedAt = new Date(base + turn * 180_000);
    const answeredAt = new Date(askedAt.getTime() + 60_000);
    const questionId = randomUUID();
    const answerId = randomUUID();
    const runId = randomUUID();
    messages.push({ chatId: chat.id, content: textMessageContent(syntheticText(turn, QUESTION_CHARACTERS, `Question ${turn}.`)),
      createdAt: askedAt, id: questionId, parentMessageId: parent, role: "user", status: "complete", updatedAt: askedAt });
    messages.push({ chatId: chat.id,
      content: textMessageContent(syntheticText(turn + 500_000, ANSWER_CHARACTERS, `Answer ${turn}.`)),
      createdAt: answeredAt, id: answerId, modelId: "contention-model", parentMessageId: questionId,
      provider: "contention-provider", role: "assistant", status: "complete", updatedAt: answeredAt });
    runs.push({ assistantMessageId: answerId, chatId: chat.id, createdAt: askedAt, id: runId, modelId: "contention-model",
      normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } } },
      provider: "contention-provider", status: "complete", updatedAt: answeredAt, userId, userMessageId: questionId });
    for (let call = 0; call < toolCalls; call += 1) {
      const completedAt = new Date(askedAt.getTime() + 10_000 + call * 1_000);
      calls.push({ arguments: { query: `lookup ${turn}-${call}` }, completedAt, id: randomUUID(), modelRunId: runId,
        ordinal: call, providerCallId: `call-${turn}-${call}`,
        result: { name: `source ${turn}`, result_count: 3 + call, status: "ok", title: syntheticText(turn * 10 + call, 80, "Result") },
        roundIndex: 0, startedAt: new Date(completedAt.getTime() - 500), state: "complete", toolName: "web_search",
        updatedAt: completedAt });
    }
    parent = answerId;
    lastRunId = runId;
  }
  for (let offset = 0; offset < messages.length; offset += 400) {
    await prisma.message.createMany({ data: messages.slice(offset, offset + 400) });
  }
  for (let offset = 0; offset < runs.length; offset += 400) {
    await prisma.modelRun.createMany({ data: runs.slice(offset, offset + 400) });
  }
  for (let offset = 0; offset < calls.length; offset += 400) {
    await prisma.modelRunToolCall.createMany({ data: calls.slice(offset, offset + 400) });
  }
  await mutateContentionSource(userId, chat.id, { mutations: ["NORMAL_APPEND"], patch: { activeLeafMessageId: parent } });
  await mutateContentionSource(userId, chat.id, { mutations: ["TERMINAL_SETTLEMENT"], terminalSettlement: {
    assistantMessageId: parent!, runId: lastRunId, status: "complete"
  } });
  await prisma.$executeRawUnsafe(`ANALYZE "Chat", "Message", "ModelRun", "ModelRunToolCall"`);
  return { chatId: chat.id, pathIds: messages.map(({ id }) => id!), toolCallIds: calls.map(({ id }) => id!) };
}

/** The chat's newest queued history job; older ones are superseded, as the
 * claim gate would settle them. */
async function currentHistoryJob(userId: string, chatId: string) {
  const job = await prisma.memoryJob.findFirstOrThrow({
    orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
    where: { chatId, kind: "INDEX_HISTORY", state: "QUEUED", userId }
  });
  await prisma.memoryJob.updateMany({ data: { errorCode: "memory_source_stale", state: "STALE" },
    where: { chatId, id: { not: job.id }, kind: "INDEX_HISTORY", state: "QUEUED", userId } });
  return job;
}

describe("INDEX_HISTORY commits and the owner's and the chat's foreground writes", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("indexes a long chat's first page in bounded passes while run settlement, uploads and the chat's own lock proceed", async () => {
    const userId = await createContentionOwner("history");
    const embedding = await configureContentionEmbedding(userId);
    try {
      const generationId = await activateContentionVectorIndex(userId, embedding);
      const { chatId, pathIds, toolCallIds } = await seedLongChat(userId, TURNS, TOOL_CALLS);
      const job = await currentHistoryJob(userId, chatId);
      const handler = createMemoryHistoryIndexHandler({ repository: createPrismaMemoryHistoryIndexRepository(prisma) });
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      const runs = createPrismaRunRepository(prisma);
      const storage = createMemoryStorageAdapter();
      const POST = contentionUploadHandler(userId, storage);
      const usage = normalizeTokenUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
      const fixtures: Array<{ failed: { assistantMessageId: string; runId: string };
        usage: { chatId: string; runId: string } }> = [];
      let cursor = -1;
      let passes = 0;
      for (;;) {
        const queued = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
        if (queued.state === "SUCCEEDED") break;
        // Every unfinished pass returned the same job to the queue.
        expect(queued).toMatchObject({ completedAt: null, state: "QUEUED" });
        passes += 1;
        expect(passes).toBeLessThanOrEqual(40);
        const fixture = { failed: await createForegroundRun(runs, userId, `Stale ${passes}`),
          usage: await createForegroundRun(runs, userId, `Usage ${passes}`) };
        fixtures.push(fixture);
        const claim = await claimContentionJob(job.id);
        await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
        const now = new Date();
        const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
          signal: new AbortController().signal });
        let ownerHeld!: () => void;
        const held = new Promise<void>((resolve) => { ownerHeld = resolve; });
        const origin = performance.now();
        const commit = settled(coordinator.commitJobSuccess({
          acceptedResultHash: result.acceptedResultHash,
          // The coordinator applies once it holds the owner row and the chat
          // FOR SHARE, and holds both until it commits.
          apply: async (tx, committedClaim) => { ownerHeld(); return result.apply!(tx, committedClaim); },
          claim, now, operationalCounters: result.operationalCounters, stage: result.stage ?? null
        }), origin);
        await held;
        const [chatLock, failed, recorded, uploaded] = await Promise.all([
          // The Workspace export seal's lock: the chat FOR UPDATE within
          // Prisma's default 5 s interactive transaction.
          settled(prisma.$transaction(async (tx) => {
            await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Chat" WHERE "id" = ${chatId} FOR UPDATE`);
            return true;
          }), origin),
          // The GET chat reconcile ends an orphaned run through this write.
          settled(runs.failRun(fixture.failed.runId, fixture.failed.assistantMessageId,
            { code: "run_orphaned", message: "Run stopped reporting progress and was marked failed." }), origin),
          settled(runs.recordRunUsageEvents({ chatId: fixture.usage.chatId, runId: fixture.usage.runId, userId,
            usageAttributions: [{ modelId: "fake-qsa", provider: "fake", purpose: "chat_answer", usage }] }), origin),
          settled(POST(contentionUploadRequest()).then((response) => response.status), origin)
        ]);
        const memory = await commit;
        const counters = result.operationalCounters ?? {};
        console.info("memory_history_contention_pass", JSON.stringify({ chatLock, failed, memory, pass: passes,
          messagesProjected: counters.historyMessagesProjected, recorded, roundsBuilt: counters.historyRoundsBuilt,
          uploaded }));
        expect({ chatLock, failed, memory, recorded, uploaded }).toEqual({
          chatLock: expect.objectContaining({ ok: true, value: true }),
          failed: expect.objectContaining({ ok: true, value: true }),
          memory: expect.objectContaining({ ok: true, value: true }),
          recorded: expect.objectContaining({ ok: true, value: true }),
          uploaded: expect.objectContaining({ ok: true, value: 200 })
        });
        // Each pass wrote one bounded page and advanced the cursor.
        expect(counters.historyMessagesProjected).toBeLessThanOrEqual(MAX_MESSAGES_PER_PASS);
        const checkpoint = await prisma.chatMemoryCheckpoint.findUniqueOrThrow({
          where: { userId_chatId: { chatId, userId } } });
        const indexedThrough = pathIds.indexOf(checkpoint.lastIndexedMessageId ?? "");
        expect(indexedThrough).toBeGreaterThan(cursor);
        cursor = indexedThrough;
      }
      expect(passes).toBeGreaterThanOrEqual(Math.ceil(pathIds.length / MAX_MESSAGES_PER_PASS));

      // The complete, exact index of the whole chat: every message covered,
      // one round per turn, one observation per settled call, every pending
      // vector enqueued, and the cursor proving the active leaf.
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ stage: "lexical_ready", state: "SUCCEEDED" });
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({ where: { userId_chatId: { chatId, userId } } }))
        .resolves.toMatchObject({ activeLeafMessageId: pathIds.at(-1), lastIndexedMessageId: pathIds.at(-1),
          status: "READY" });
      const activeChunks = await prisma.memoryRecallChunk.findMany({ select: { id: true },
        where: { chatId, state: "ACTIVE", userId } });
      const chunkJoins = await prisma.memoryRecallChunkMessage.findMany({ select: { messageId: true },
        where: { chunkId: { in: activeChunks.map(({ id }) => id) }, userId } });
      expect(new Set(chunkJoins.map(({ messageId }) => messageId))).toEqual(new Set(pathIds));
      await expect(prisma.memoryRecallRound.count({ where: { chatId, state: "ACTIVE", userId } })).resolves.toBe(TURNS);
      const events = await prisma.memoryToolEvent.findMany({ select: { modelRunToolCallId: true },
        where: { chatId, state: "ACTIVE", userId } });
      expect(events.map(({ modelRunToolCallId }) => modelRunToolCallId).sort()).toEqual([...toolCallIds].sort());
      const [{ pending, unqueued }] = await prisma.$queryRaw<Array<{ pending: number; unqueued: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS "pending", COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM "MemoryEmbeddingBatchItem" AS item
          WHERE item."userId" = entry."userId" AND item."searchEntryId" = entry."id"))::integer AS "unqueued"
        FROM "MemorySearchEntry" AS entry
        WHERE entry."userId" = ${userId} AND entry."indexGenerationId" = ${generationId}
          AND entry."embeddingState" = 'PENDING'::"MemoryEmbeddingState"
      `);
      expect(pending).toBeGreaterThan(0);
      expect(unqueued).toBe(0);
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
      await embedding.cleanup();
    }
  }, 600_000);

  it("leaves the observations of earlier pages untouched and moves them to a new revision in one statement", async () => {
    const userId = await createContentionOwner("history-events");
    try {
      const { chatId, pathIds } = await seedLongChat(userId, 8, 3);
      const handler = createMemoryHistoryIndexHandler({ repository: createPrismaMemoryHistoryIndexRepository(prisma, {
        maxChunks: 512, maxContentBytes: 4 * 1024 * 1024, maxIndexWrites: 200, maxMessages: 1_024, maxToolCalls: 4_096
      }) });
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      const versions = () => prisma.$queryRaw<Array<{ entry: string; id: string; revision: number; version: string }>>(Prisma.sql`
        SELECT event."id", event."xmin"::text AS "version", entry."xmin"::text AS "entry",
          event."sourceRevisionAtCreation" AS "revision"
        FROM "MemoryToolEvent" AS event
        INNER JOIN "MemorySearchEntry" AS entry ON entry."toolEventId" = event."id" AND entry."userId" = event."userId"
        WHERE event."userId" = ${userId} AND event."state" = 'ACTIVE'::"MemoryHistoryItemState"
        ORDER BY event."id"
      `);
      const indexPass = async () => {
        const job = await currentHistoryJob(userId, chatId);
        const claim = await claimContentionJob(job.id);
        const now = new Date();
        const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
          signal: new AbortController().signal });
        expect(await coordinator.commitJobSuccess({ acceptedResultHash: result.acceptedResultHash, apply: result.apply,
          claim, now, stage: result.stage ?? null })).toBe(true);
      };

      await indexPass();
      const firstPage = await versions();
      expect(firstPage.length).toBeGreaterThan(0);
      await indexPass();
      const bothPages = await versions();
      expect(bothPages.length).toBeGreaterThan(firstPage.length);
      // The second page of the same job neither rewrote the first page's
      // observations nor their entries.
      expect(bothPages.filter(({ id }) => firstPage.some((row) => row.id === id))).toEqual(firstPage);
      while ((await prisma.chatMemoryCheckpoint.findUniqueOrThrow({ where: { userId_chatId: { chatId, userId } } }))
        .lastIndexedMessageId !== pathIds.at(-1)) await indexPass();
      const indexed = await versions();

      // A new turn advances the source revision; its job carries every
      // retained observation to it without rewriting the observation's entry.
      const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
      const question = await prisma.message.create({ data: { chatId, content: textMessageContent("One more question."),
        parentMessageId: pathIds.at(-1)!, role: "user", status: "complete" } });
      const answer = await prisma.message.create({ data: { chatId, content: textMessageContent("One more answer."),
        modelId: "contention-model", parentMessageId: question.id, provider: "contention-provider", role: "assistant",
        status: "complete" } });
      const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, modelId: "contention-model",
        normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } } },
        provider: "contention-provider", status: "complete", userId, userMessageId: question.id } });
      await mutateContentionSource(userId, chatId, { mutations: ["NORMAL_APPEND"], patch: { activeLeafMessageId: answer.id } });
      await mutateContentionSource(userId, chatId, { mutations: ["TERMINAL_SETTLEMENT"], terminalSettlement: {
        assistantMessageId: answer.id, runId: run.id, status: "complete" } });
      await indexPass();
      const moved = await versions();
      const current = await prisma.chatMemoryCheckpoint.findUniqueOrThrow({ where: { userId_chatId: { chatId, userId } } });
      expect(current).toMatchObject({ lastIndexedMessageId: answer.id, status: "READY" });
      expect(current.sourceRevision).toBeGreaterThan(chat.memorySourceRevision);
      expect(moved.map(({ id }) => id)).toEqual(indexed.map(({ id }) => id));
      for (const row of moved) {
        const before = indexed.find(({ id }) => id === row.id)!;
        expect(row.revision).toBe(current.sourceRevision);
        expect(row.version).not.toBe(before.version);
        expect(row.entry).toBe(before.entry);
      }
    } finally {
      await cleanupContentionOwner(userId);
    }
  }, 120_000);
});
