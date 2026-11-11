import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createQueryCountingClient } from "@/tests/support/prismaQueryLog";
import { CHAT_HISTORY_PAGE_SIZE } from "../../contracts/chats";
import { CHAT_EXPORT_VERSION, decodeChatExportDocument } from "../../contracts/chatExport";
import { textMessageContent } from "../../domain/content";
import { chatExportDocument } from "../../domain/chatExportDocument";
import { prisma } from "../prisma";
import { scheduledTaskScheduleColumns } from "../scheduledTasks/store";
import { createPrismaShareRepository } from "../shares/prismaRepository";
import { loadAuthorizedChatExportSource } from "./exportChat";
import { findMessageMatches } from "./messageSearch";
import { createPrismaChatRepository } from "./prismaRepository";

/**
 * A monitoring automation's chat as production grew one (operator report
 * 2026-11-11): hundreds of checks with no update around a few results, of
 * which the run history keeps only the latest occurrences. What its owner
 * reads leaves every quiet check out, however old.
 */
const users: string[] = [];
afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

const start = Date.UTC(2026, 10, 2);
const PROMPT = "Check the release page and tell me when a new version ships.";

type Check = Readonly<{ answerId: string; outcome: string | null; questionId: string; runId: string; at: Date }>;

/** Seeds a task chat check by check, each a scheduled turn and its answer with the run that settled it. */
async function taskChat() {
  const userId = `quiet-checks-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Quiet checks test", id: userId, status: "active" } });
  const task = await prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatMode: "SAME", kind: "MONITORING", modelId: "fake-qsa",
    prompt: PROMPT, provider: "fake", timeZone: "UTC", title: "Release watch", userId
  } });
  const chatId = randomUUID();
  await prisma.chat.create({ data: { id: chatId, title: "Release watch", userId } });
  const checks: Check[] = [];
  let parent: string | null = null;
  let clock = 0;
  const messages: Prisma.MessageCreateManyInput[] = [];
  const runs: Prisma.ModelRunCreateManyInput[] = [];
  const add = (outcome: string | null, options: Readonly<{ failed?: boolean; text?: string; parentId?: string | null }> = {}) => {
    const at = new Date(start + (clock += 60_000));
    const questionId = randomUUID();
    const answerId = randomUUID();
    const runId = randomUUID();
    const parentMessageId = options.parentId === undefined ? parent : options.parentId;
    messages.push({ chatId, content: textMessageContent(PROMPT), createdAt: at, id: questionId, modelId: "fake-qsa",
      parentMessageId, provider: "fake", role: "user", scheduledTaskPrompt: true, status: "complete" });
    messages.push({ chatId, content: textMessageContent(options.text ?? ""), createdAt: new Date(at.getTime() + 1_000), id: answerId,
      modelId: "fake-qsa", parentMessageId: questionId, provider: "fake", role: "assistant", status: options.failed ? "error" : "complete" });
    runs.push({ assistantMessageId: answerId, chatId, createdAt: at, id: runId, modelId: "fake-qsa", normalizedRequest: {},
      provider: "fake", scheduledOccurrenceId: randomUUID(), scheduledOutcome: outcome, scheduledTaskGeneration: 1,
      scheduledTaskId: task.id, status: options.failed ? "error" : "complete", userId, userMessageId: questionId });
    const check = { answerId, at, outcome, questionId, runId };
    checks.push(check);
    if (options.parentId === undefined) parent = answerId;
    return check;
  };
  const flush = async (leaf: string) => {
    for (let offset = 0; offset < messages.length; offset += 500) {
      await prisma.message.createMany({ data: messages.slice(offset, offset + 500) });
    }
    for (let offset = 0; offset < runs.length; offset += 500) await prisma.modelRun.createMany({ data: runs.slice(offset, offset + 500) });
    messages.length = 0;
    runs.length = 0;
    await prisma.chat.update({ data: { activeLeafMessageId: leaf }, where: { id: chatId } });
  };
  return { add, chatId, checks, flush, parent: () => parent, task, userId };
}

/** The production shape: a starting point, 202 quiet checks, a failure, then 30 updates three quiet checks apart, and a quiet tail. */
async function grownChat() {
  const chat = await taskChat();
  const shown: string[] = [];
  const pair = (check: Check) => shown.push(check.questionId, check.answerId);
  pair(chat.add("baseline", { text: "Version 1.0 is current." }));
  for (let index = 0; index < 202; index += 1) chat.add("no_update");
  pair(chat.add(null, { failed: true }));
  for (let update = 0; update < 30; update += 1) {
    pair(chat.add("update", { text: `Version 1.${update + 1} is out.` }));
    for (let index = 0; index < 3; index += 1) chat.add("no_update");
  }
  for (let index = 0; index < 5; index += 1) chat.add("no_update");
  await chat.flush(chat.parent()!);
  // The run history keeps the latest 50 occurrences; one shown result in it is unread.
  const kept = chat.checks.slice(-50);
  const unread = kept.find((check) => check.outcome === "update")!;
  await prisma.scheduledTaskOccurrence.createMany({ data: kept.map((check) => ({
    chatId: chat.chatId, finishedAt: check.at, runId: check.runId, scheduledFor: check.at, startedAt: check.at, state: "COMPLETED",
    taskId: chat.task.id, trigger: "schedule", unseenAt: check === unread ? check.at : null, userId: chat.userId,
    userMessageId: check.questionId, verdict: check.outcome
  })) });
  const occurrences = new Map((await prisma.scheduledTaskOccurrence.findMany({ select: { id: true, userMessageId: true },
    where: { taskId: chat.task.id } })).map((row) => [row.userMessageId, row.id]));
  const quiet = chat.checks.filter((check) => check.outcome === "no_update");
  return { ...chat, occurrences, quiet, quietIds: new Set(quiet.flatMap((check) => [check.questionId, check.answerId])), shown, unread };
}

describe("a task chat's quiet checks", () => {
  it("leave every page of its history, which re-links over them, marks its checks however old and counts the quiet ones", async () => {
    const chat = await grownChat();
    const repository = createPrismaChatRepository(prisma);
    const detail = await repository.getChat({ chatId: chat.chatId, userId: chat.userId });
    expect(detail).not.toBeNull();
    const page = chat.shown.slice(-CHAT_HISTORY_PAGE_SIZE);
    expect(detail!.messages.map((message) => message.id)).toEqual(page);
    // Each message reads as following the one before it, the first the one before the page.
    expect(detail!.messages.map((message) => message.parentMessageId))
      .toEqual([chat.shown.at(-CHAT_HISTORY_PAGE_SIZE - 1), ...page.slice(0, -1)]);
    expect(detail!.activeLeafMessageId).toBe(chat.shown.at(-1));
    expect(detail!.pageInfo).toMatchObject({ activeLeafMessageId: chat.shown.at(-1), hasOlder: true });
    expect(detail!.quietChecks).toEqual({ count: chat.quiet.length, lastAt: chat.quiet.at(-1)!.at });
    expect(chat.quiet).toHaveLength(202 + 90 + 5);

    // Every page follows the cursor back to the root: no quiet check, no empty page, nothing twice.
    const loaded = detail!.messages.map((message) => message.id);
    let cursor = detail!.pageInfo.beforeCursor;
    let pages = 1;
    while (cursor) {
      const older = await repository.getMessagesPage({ before: cursor, chatId: chat.chatId, userId: chat.userId });
      if (older.kind !== "ok") throw new Error(older.kind);
      expect(older.page.messages.length).toBeGreaterThan(0);
      expect(older.page.messages[0]!.parentMessageId).toBe(older.page.pageInfo.hasOlder
        ? chat.shown[chat.shown.indexOf(older.page.messages[0]!.id) - 1] : null);
      loaded.unshift(...older.page.messages.map((message) => message.id));
      cursor = older.page.pageInfo.beforeCursor;
      pages += 1;
    }
    expect(loaded).toEqual(chat.shown);
    expect(pages).toBe(Math.ceil(chat.shown.length / CHAT_HISTORY_PAGE_SIZE));

    // Every shown turn is the task's, with its prompt behind the mark; only a kept occurrence can be unread. A pruned one
    // is named by the turn's own run, in the shape a client of the previous release decodes.
    const turns = [...detail!.messages];
    const runs = new Map(chat.checks.map((check) => [check.questionId, check.runId]));
    for (const message of turns.filter((entry) => entry.role === "user")) {
      const occurrence = chat.occurrences.get(message.id);
      expect(message.scheduledTask).toEqual({ taskId: chat.task.id, taskRunId: occurrence ?? runs.get(message.id),
        title: "Release watch", unseen: message.id === chat.unread.questionId });
    }
    expect(turns.some((message) => message.role === "user" && !chat.occurrences.has(message.id))).toBe(true);
    expect(turns.filter((message) => message.scheduledOutcome === "no_update")).toEqual([]);
    // The chat's context figures measure what a reply reads: the shown branch.
    expect(detail!.contextStats.approximateActiveBranchInputTokens).toBeGreaterThan(0);
  });

  it("never match a message search, while the shown checks still do", async () => {
    const chat = await grownChat();
    const matches = await findMessageMatches(prisma, { after: null, limit: 10, query: "release page", userId: chat.userId });
    if (matches === "timeout") throw new Error("search timed out");
    expect(matches).toHaveLength(1);
    // The baseline, the failure and the 30 updates: the shown turns that hold the prompt.
    expect(matches[0]).toMatchObject({ chatId: chat.chatId, matchCount: 32, messageId: chat.shown.at(-2) });
  });

  it("leave an archived preview without a summary, whose keys a previous client checks exactly", async () => {
    const chat = await grownChat();
    await prisma.chat.update({ data: { archived: true }, where: { id: chat.chatId } });
    const archived = await createPrismaChatRepository(prisma).getArchivedChat({ chatId: chat.chatId, userId: chat.userId });
    expect(archived!.messages.map((message) => message.id)).toEqual(chat.shown.slice(-CHAT_HISTORY_PAGE_SIZE));
    expect(archived).not.toHaveProperty("quietChecks");
  });

  it("leave the branch graph, and a branch switched to a quiet check reads as its last shown message", async () => {
    const chat = await taskChat();
    const baseline = chat.add("baseline", { text: "Version 1.0 is current." });
    for (let index = 0; index < 60; index += 1) chat.add("no_update");
    const update = chat.add("update", { text: "Version 1.1 is out." });
    const tail = chat.add("no_update");
    // The owner's own reply after the starting point, on a branch of its own, with a quiet check after it.
    const replyId = randomUUID();
    const answerId = randomUUID();
    await chat.flush(tail.answerId);
    await prisma.message.create({ data: { chatId: chat.chatId, content: textMessageContent("What changed?"), id: replyId,
      parentMessageId: baseline.answerId, role: "user", status: "complete" } });
    await prisma.message.create({ data: { chatId: chat.chatId, content: textMessageContent("Nothing yet."), id: answerId,
      parentMessageId: replyId, role: "assistant", status: "complete" } });
    const branchTail = chat.add("no_update", { parentId: answerId });
    await chat.flush(tail.answerId);
    const repository = createPrismaChatRepository(prisma);

    const graph = await repository.getBranches({ chatId: chat.chatId, userId: chat.userId });
    expect(graph!.activeLeafMessageId).toBe(update.answerId);
    expect(graph!.nodes.map((node) => [node.id, node.parentMessageId])).toEqual([
      [baseline.questionId, null], [baseline.answerId, baseline.questionId],
      [update.questionId, baseline.answerId], [update.answerId, update.questionId],
      [replyId, baseline.answerId], [answerId, replyId]
    ]);

    await prisma.chat.update({ data: { activeLeafMessageId: branchTail.answerId }, where: { id: chat.chatId } });
    const switched = await repository.getChat({ chatId: chat.chatId, userId: chat.userId });
    expect(switched!.messages.map((message) => message.id)).toEqual([baseline.questionId, baseline.answerId, replyId, answerId]);
    expect(switched!.activeLeafMessageId).toBe(answerId);
    expect((await repository.getBranches({ chatId: chat.chatId, userId: chat.userId }))!.activeLeafMessageId).toBe(answerId);
  });

  it("leave a chat that holds nothing else empty, still counted", async () => {
    const chat = await taskChat();
    for (let index = 0; index < 3; index += 1) chat.add("no_update");
    await chat.flush(chat.parent()!);
    const detail = await createPrismaChatRepository(prisma).getChat({ chatId: chat.chatId, userId: chat.userId });
    expect(detail!.messages).toEqual([]);
    expect(detail!.activeLeafMessageId).toBeNull();
    expect(detail!.pageInfo).toMatchObject({ activeLeafMessageId: null, beforeCursor: null, hasOlder: false });
    expect(detail!.quietChecks?.count).toBe(3);
    expect(detail!.contextStats.approximateActiveBranchInputTokens).toBe(0);
  });

  it("open in the same number of statements however many quiet checks the chat holds", async () => {
    const chat = await grownChat();
    const { client, count, reset } = createQueryCountingClient();
    try {
      const repository = createPrismaChatRepository(client);
      await reset();
      await repository.getChat({ chatId: chat.chatId, userId: chat.userId });
      const before = await count();
      for (let index = 0; index < 150; index += 1) chat.add("no_update");
      await chat.flush(chat.parent()!);
      await reset();
      const detail = await repository.getChat({ chatId: chat.chatId, userId: chat.userId });
      expect(await count()).toBe(before);
      expect(detail!.quietChecks?.count).toBe(chat.quiet.length + 150);
    } finally {
      await client.$disconnect();
    }
  });

  it("leave exports and shares, whose export keeps its published version", async () => {
    const chat = await grownChat();
    const source = await loadAuthorizedChatExportSource(prisma, { chatId: chat.chatId, userId: chat.userId });
    expect(source!.messages.map((message) => message.key).sort()).toEqual([...chat.shown].sort());
    expect(source!.messages.find((message) => message.key === chat.shown[4])?.parentKey).toBe(chat.shown[3]);
    expect(source!.chat.activeLeafKey).toBe(chat.shown.at(-1));
    const document = chatExportDocument(source!, new Date(start));
    expect(document.version).toBe(CHAT_EXPORT_VERSION);
    expect(decodeChatExportDocument(JSON.parse(JSON.stringify(document))).ok).toBe(true);

    const shares = createPrismaShareRepository(prisma);
    const share = await shares.createChatShare({ activeLeafMessageId: null, chatId: chat.chatId, shareToken: "synthetic",
      slugHash: `quiet-checks-${randomUUID()}`, userId: chat.userId });
    expect(share && "snapshot" in share ? share.snapshot.messages : null).toHaveLength(chat.shown.length);
  });
});
