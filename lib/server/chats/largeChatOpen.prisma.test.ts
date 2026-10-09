import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, expect, it } from "vitest";
import { createQueryLoggingClient } from "@/tests/support/prismaQueryLog";
import type { MessageContent } from "../../domain/content";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { SessionContextStatus } from "../../contracts/sessionStatus";
import { prisma } from "../prisma";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { createPrismaChatRepository, loadChatBranchSnapshotStats } from "./prismaRepository";

afterAll(() => prisma.$disconnect());

// A chat the size the production opens slowed down on: a thousand turns of
// long mixed-script text, a run with artifact events per answer, regenerated
// answers, edited dead-end siblings and one deep alternative branch, inside a
// run table that also holds other chats' runs.
const TURNS = 1000;
const ALT_FROM_TURN = 500;
const ALT_TURNS = 30;
const OTHER_RUNS = 20_000;
// Well inside the 5 s interactive-transaction budget the open used to
// outlive, with headroom for a loaded runner; the statement count and the
// absence of P2028 are the structural proof.
const OPEN_BUDGET_MS = 4_000;
// Measured 36; it must not grow with the chat's length.
const OPEN_STATEMENTS_MAX = 40;

const fragments = [
  "The quick brown fox jumps over the lazy dog, then reads the log output again. ",
  "Съешь же ещё этих мягких французских булок, да выпей чаю — и проверь отчёт. ",
  "Ελληνικά κείμενα και עברית וערבית: مرحبا بالعالم. ",
  "漢字かな交じり文と한국어 텍스트, plus emoji 🙂🚀 and ԯ԰ boundaries. ",
  "`const value = items.map((item) => item.id);` — inline code with “quotes”. ",
  // Class edges: pictographs inside otherwise plain blocks, three-byte
  // Cyrillic, scripts outside every class, fullwidth and Latin-1 forms.
  "Café «déjà» © ® ‼ ⁉ 〰 〽 ᲀⷠꙀ ก नमस्ते Ａ… ½ x. "
];

function text(seed: number, length: number): string {
  let value = `#${seed} `;
  for (let index = seed; value.length < length; index += 1) {
    value += fragments[index % fragments.length];
  }
  return value.slice(0, length);
}

function content(seed: number, length: number): MessageContent {
  // Every seventh message also carries an attachment block, which the
  // estimate measures as its JSON.
  return seed % 7 === 0
    ? { blocks: [{ type: "text", text: text(seed, length) }, { type: "file", attachmentId: `att-${seed}`, fileName: `notes-${seed}.md` }] }
    : { blocks: [{ type: "text", text: text(seed, length) }] };
}

function status(tokens: number): SessionContextStatus {
  return {
    approximateInputTokens: tokens, contextWindow: 400_000, droppedMessages: 0, loadedTools: 4,
    maxOutputTokens: 8_000, modelId: "fake-qsa", phase: "after_answer", provider: "fake",
    safetyMarginTokens: 40_000, version: 1
  };
}

type Row = { content: MessageContent; createdAt: Date; id: string; parentMessageId: string | null; role: "assistant" | "user" };

it("opens a thousand-turn chat inside its read budget with the same page, branches and context stats", async () => {
  const userId = randomUUID();
  const chatId = randomUUID();
  const otherChatId = randomUUID();
  await prisma.user.create({ data: { id: userId, displayName: "Large chat", status: "active" } });
  try {
    await prisma.chat.create({ data: { id: chatId, userId, title: "Large chat" } });
    await prisma.chat.create({ data: { id: otherChatId, userId, title: "Other chat" } });
    const otherQuestion = await prisma.message.create({ data: {
      chatId: otherChatId, content: { blocks: [{ type: "text", text: "other" }] }, role: "user", status: "complete"
    } });
    await prisma.$executeRaw`
      INSERT INTO "ModelRun" ("id", "chatId", "userId", "userMessageId", "provider", "modelId", "status", "normalizedRequest", "updatedAt")
      SELECT gen_random_uuid()::text, ${otherChatId}, ${userId}, ${otherQuestion.id}, 'fake', 'fake-qsa', 'complete',
        jsonb_build_object('input', repeat('x', 1200), 'ordinal', series), now()
      FROM generate_series(1, ${OTHER_RUNS}) AS series
    `;

    const start = Date.UTC(2026, 0, 1);
    let clock = 0;
    const at = () => new Date(start + (clock += 1000));
    const messages: Row[] = [];
    const runs: Prisma.ModelRunCreateManyInput[] = [];
    const events: Prisma.ModelRunEventCreateManyInput[] = [];
    const run = (userMessageId: string, assistantMessageId: string, measured: number | null) => {
      const id = randomUUID();
      const createdAt = at();
      runs.push({ assistantMessageId, chatId, createdAt, id, modelId: "fake-qsa", normalizedRequest: { sessionStatusTool: true },
        provider: "fake", status: "complete", updatedAt: createdAt, userId, userMessageId });
      for (let sequence = 1; sequence <= 4; sequence += 1) {
        events.push({ eventType: "artifact", modelRunId: id, payload: { artifactType: "test_filler", payload: { note: text(sequence, 400) } }, sequence });
      }
      if (measured !== null) {
        events.push({ eventType: "artifact", modelRunId: id, payload: { artifactType: "context_status", payload: status(measured) }, sequence: 5 });
      }
      return id;
    };
    const turn = (parentMessageId: string | null, seed: number, measured: number | null, regenerated = false) => {
      const question: Row = { content: content(seed, 1_500), createdAt: at(), id: randomUUID(), parentMessageId, role: "user" };
      const answer: Row = { content: content(seed + 1, 5_000), createdAt: at(), id: randomUUID(), parentMessageId: question.id, role: "assistant" };
      messages.push(question, answer);
      if (regenerated) run(question.id, answer.id, 777_777);
      return { answer, question, runId: run(question.id, answer.id, measured) };
    };

    const mainPath: Row[] = [];
    const runByAnswer = new Map<string, string>();
    let parent: string | null = null;
    let altParent: string | null = null;
    for (let index = 0; index < TURNS; index += 1) {
      if (index === ALT_FROM_TURN) altParent = parent;
      if (index % 50 === 10) turn(parent, 900_000 + index, 9_000_000 + index);
      // The last two answers carry no measurement; the nearest measured
      // ancestor is a regenerated answer whose newest run is shown.
      const measured = index >= TURNS - 2 ? null : 1_000 + index;
      const created = turn(parent, index * 2, measured, index % 25 === 0 || index === TURNS - 3);
      mainPath.push(created.question, created.answer);
      runByAnswer.set(created.answer.id, created.runId);
      parent = created.answer.id;
    }
    const altPath = mainPath.slice(0, ALT_FROM_TURN * 2);
    for (let index = 0; index < ALT_TURNS; index += 1) {
      const created = turn(altParent, 500_000 + index, 5_000 + index);
      altPath.push(created.question, created.answer);
      runByAnswer.set(created.answer.id, created.runId);
      altParent = created.answer.id;
    }
    for (let offset = 0; offset < messages.length; offset += 200) {
      await prisma.message.createMany({ data: messages.slice(offset, offset + 200).map((message) => ({
        ...message, chatId, content: message.content as Prisma.InputJsonValue, status: "complete"
      })) });
    }
    for (let offset = 0; offset < runs.length; offset += 500) {
      await prisma.modelRun.createMany({ data: runs.slice(offset, offset + 500) });
    }
    for (let offset = 0; offset < events.length; offset += 1_000) {
      await prisma.modelRunEvent.createMany({ data: events.slice(offset, offset + 1_000) });
    }
    await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: parent } });
    await prisma.$executeRawUnsafe(`ANALYZE "Message"`);
    await prisma.$executeRawUnsafe(`ANALYZE "ModelRun"`);
    await prisma.$executeRawUnsafe(`ANALYZE "ModelRunEvent"`);

    const statements: Array<{ duration: number; query: string }> = [];
    const { client: counting, settle } = createQueryLoggingClient((event) => {
      statements.push({ duration: event.duration, query: event.query });
    });
    try {
      const repo = createPrismaChatRepository(counting);
      const estimate = (path: readonly Row[]) => path.reduce((total, message) => total + estimateApproxTokens(message.content), 0);
      const expectOpen = async (path: readonly Row[], session: { messageId: string; tokens: number }) => {
        const detail = await repo.getChat({ chatId, userId });
        expect(detail).not.toBeNull();
        const page = path.slice(-50);
        expect(detail!.messages.map((message) => message.id)).toEqual(page.map((message) => message.id));
        expect(detail!.messages.map((message) => message.content)).toEqual(page.map((message) => message.content));
        for (const message of detail!.messages) {
          if (message.role === "assistant") expect(message.modelRunId).toBe(runByAnswer.get(message.id));
        }
        expect(detail!.pageInfo.hasOlder).toBe(true);
        const sessionIndex = path.findIndex((message) => message.id === session.messageId);
        expect(detail!.contextStats).toEqual({
          approximateActiveBranchInputTokens: estimate(path),
          approximateInputTokensAfterSession: estimate(path.slice(sessionIndex + 1)),
          session: status(session.tokens),
          sessionBranchLeafId: path.at(-1)!.id,
          sessionMessageId: session.messageId
        });
        expect((await counting.$transaction((tx) => loadChatBranchSnapshotStats(tx, {
          activeLeafMessageId: path.at(-1)!.id, chatId
        }))).contextStats).toEqual(detail!.contextStats);
        // Older pages follow the cursor back to the root of the active branch.
        const loaded = detail!.messages.map((message) => message.id);
        let cursor = detail!.pageInfo.beforeCursor;
        while (cursor) {
          const older = await repo.getMessagesPage({ before: cursor, chatId, userId });
          if (older.kind !== "ok") throw new Error(older.kind);
          loaded.unshift(...older.page.messages.map((message) => message.id));
          cursor = older.page.pageInfo.beforeCursor;
        }
        expect(loaded).toEqual(path.map((message) => message.id));
      };

      const samples: Array<{ failure: string | null; ms: number; statements: number; slowest: Array<{ duration: number; query: string }> }> = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await settle();
        statements.length = 0;
        const started = performance.now();
        // A failed open is measured too: before the bounded read it outlived
        // its transaction (P2028).
        const failure = await repo.getChat({ chatId, userId }).then(() => null, (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "unexpected");
        const ms = Math.round(performance.now() - started);
        await settle();
        samples.push({
          failure,
          ms,
          slowest: [...statements].sort((left, right) => right.duration - left.duration).slice(0, 4)
            .map((statement) => ({ duration: statement.duration, query: statement.query.replace(/\s+/gu, " ").slice(0, 160) })),
          statements: statements.length
        });
      }
      const warm = samples.slice(1).sort((left, right) => left.ms - right.ms);
      const median = warm[Math.floor(warm.length / 2)]!;
      console.info(`LARGE_CHAT_OPEN ${JSON.stringify({
        messages: messages.length, otherRuns: OTHER_RUNS, samples: samples.map((sample) => [sample.ms, sample.failure]),
        medianMs: median.ms, statements: median.statements, slowest: median.slowest
      })}`);
      const measured = TURNS - 3;
      await expectOpen(mainPath, { messageId: mainPath[measured * 2 + 1]!.id, tokens: 1_000 + measured });

      // Branch navigation sees every message and switches to the deep sibling.
      const graph = await repo.getBranches({ chatId, userId });
      expect(graph?.nodes).toHaveLength(messages.length);
      expect(graph?.activeLeafMessageId).toBe(mainPath.at(-1)!.id);
      await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: altPath.at(-1)!.id } });
      await expectOpen(altPath, { messageId: altPath.at(-1)!.id, tokens: 5_000 + ALT_TURNS - 1 });
      await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: mainPath.at(-1)!.id } });

      expect(samples.map((sample) => sample.failure)).toEqual([null, null, null, null]);
      expect(Math.max(...samples.map((sample) => sample.statements))).toBeLessThanOrEqual(OPEN_STATEMENTS_MAX);
      expect(median.ms).toBeLessThan(OPEN_BUDGET_MS);
    } finally {
      await counting.$disconnect();
    }
  } finally {
    await prisma.modelRun.deleteMany({ where: { chatId: { in: [chatId, otherChatId] } } });
    await prisma.user.delete({ where: { id: userId } });
  }
}, 900_000);

it("shows a branch copy's source runs and context measurement, which live in the source chat", async () => {
  const userId = randomUUID();
  const sourceChatId = randomUUID();
  await prisma.user.create({ data: { id: userId, displayName: "Branch copy", status: "active" } });
  try {
    await prisma.chat.create({ data: { id: sourceChatId, userId, title: "Branch source" } });
    const runIds: string[] = [];
    let parentMessageId: string | null = null;
    // Seeds 1–4 carry no attachment block: a copy clones only stored attachments.
    for (const [index, measured] of [[0, 1_200], [1, 2_400]] as const) {
      const question: { id: string } = await prisma.message.create({ data: {
        chatId: sourceChatId, content: content(index * 2 + 1, 300) as Prisma.InputJsonValue, parentMessageId, role: "user", status: "complete"
      } });
      const answer: { id: string } = await prisma.message.create({ data: {
        chatId: sourceChatId, content: content(index * 2 + 2, 600) as Prisma.InputJsonValue, parentMessageId: question.id,
        role: "assistant", status: "complete"
      } });
      const run = await prisma.modelRun.create({ data: {
        assistantMessageId: answer.id, chatId: sourceChatId, modelId: "fake-qsa", normalizedRequest: { sessionStatusTool: true },
        provider: "fake", status: "complete", userId, userMessageId: question.id,
        events: { create: { eventType: "artifact", payload: { artifactType: "context_status", payload: status(measured) }, sequence: 1 } }
      } });
      runIds.push(run.id);
      parentMessageId = answer.id;
    }
    await prisma.chat.update({ where: { id: sourceChatId }, data: { activeLeafMessageId: parentMessageId } });
    const chats = createPrismaChatRepository(prisma);
    const source = await chats.getChat({ chatId: sourceChatId, userId });

    // The copy's answers reference the source chat's runs by branchSourceModelRunId.
    const branch = await createPrismaMessageBranchRepository(prisma).createChatBranchFromMessage({ sourceMessageId: parentMessageId!, userId });
    const copy = await chats.getChat({ chatId: branch!.id, userId });
    expect(copy!.messages.map((message) => message.modelRunId)).toEqual([null, runIds[0], null, runIds[1]]);
    expect(copy!.messages.map((message) => [message.role, message.status, message.content]))
      .toEqual(source!.messages.map((message) => [message.role, message.status, message.content]));
    expect(copy!.contextStats.session).toEqual(status(2_400));
    expect(copy!.contextStats).toEqual({
      ...source!.contextStats,
      sessionBranchLeafId: copy!.messages.at(-1)!.id,
      sessionMessageId: copy!.messages.at(-1)!.id
    });
  } finally {
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
}, 120_000);
