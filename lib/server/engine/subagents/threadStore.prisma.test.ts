import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SUBAGENT_ERROR_CODES, SUBAGENT_LIMITS } from "../../../contracts/subagents";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import type { SubagentBinding } from "../../subagents/ports";
import { createToolCallStore } from "../toolCallStore";
import type { TranscriptItem } from "../transcript";
import { createTranscriptRepository } from "../transcriptRepository";
import { endedSubagentCallResult } from "./runner";
import { createSubagentThreadStore } from "./threadStore";

const owners: string[] = [];
const store = createSubagentThreadStore(prisma);
const transcripts = createTranscriptRepository(prisma);
const toolCalls = createToolCallStore(prisma);
const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "connection-1",
  providerModelId: "model-1", reasoningEffort: null };

async function owner(): Promise<string> {
  const userId = `subagent-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Sub-agent test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } } } });
  return userId;
}

async function chat(userId: string) {
  return prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Sub-agents", userId } });
}

/** A question and its answer under `parentMessageId`, answered by a native run. */
async function turn(userId: string, chatId: string, input: Readonly<{ parentMessageId?: string; status?: "complete" | "streaming" }> = {}) {
  const status = input.status ?? "complete";
  const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic question"),
    ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}), role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId, content: textMessageContent(""), parentMessageId: question.id,
    role: "assistant", status: status === "streaming" ? "streaming" : "complete" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, engine: "native", modelId: "fake-qsa",
    normalizedRequest: {}, provider: "fake", status, userId, userMessageId: question.id } });
  return { answerId: answer.id, questionId: question.id, runId: run.id };
}

/** The `call_subagent` row a turn hangs from. */
async function callRow(runId: string, ordinal: number): Promise<string> {
  const row = await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: runId, ordinal, providerCallId: `call-${ordinal}`,
    roundIndex: 1, startedAt: new Date(), state: "running", toolName: "call_subagent" } });
  return row.id;
}

const admission = (userId: string, chatId: string, runId: string, parentToolCallId: string, name: string, branchRunIds: string[] = []) => ({
  binding, branchRunIds, chatId, definitionId: null, definitionRevisionId: null, name, parentRunId: runId, parentToolCallId,
  typeName: null, userId });

const origin = { model: "fake-qsa", provider: "connection-1" };
const items = (text: string): TranscriptItem[] => [{ id: randomUUID(), kind: "assistant_text", origin, text }];

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("sub-agent threads on PostgreSQL", () => {
  it("records a thread's items and calls with its own sequence and rounds beside the main agent's", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId);
    const run = await turn(userId, chatId, { status: "streaming" });
    const main = { chatId, runId: run.runId, userId };
    const threadScope = { ...main, thread: { threadId: "thread-a", turnId: "turn-a" } };
    await transcripts.append(main, 0, items("Main answer."));
    await transcripts.append(threadScope, 0, items("Sub-agent report."));
    await expect(transcripts.nextSequence(main)).resolves.toBe(1);
    await expect(transcripts.nextSequence(threadScope)).resolves.toBe(1);
    await expect(transcripts.nextSequence({ ...main, thread: { threadId: "thread-b", turnId: "turn-b" } })).resolves.toBe(0);
    const mainItems = await transcripts.loadRuns({ chatId, runIds: [run.runId], userId });
    const threadItems = await transcripts.loadRuns({ chatId, runIds: [run.runId], threadId: "thread-a", userId });
    expect(mainItems.get(run.runId)?.map((item) => item.kind === "assistant_text" ? item.text : item.kind)).toEqual(["Main answer."]);
    expect(threadItems.get(run.runId)?.map((item) => item.kind === "assistant_text" ? item.text : item.kind)).toEqual(["Sub-agent report."]);
    await expect(prisma.runTranscriptItem.findFirst({ where: { modelRunId: run.runId, subagentThreadId: "thread-a" } }))
      .resolves.toMatchObject({ sequence: 0, subagentTurnId: "turn-a" });
    // The same round and ordinal for the main agent and a thread: each keeps its own keys.
    const record = { arguments: {}, chatId, ordinal: 0, providerCallId: "p1", roundIndex: 1, runId: run.runId, toolName: "fetch_url", userId };
    await expect(toolCalls.begin(record)).resolves.toMatchObject({ kind: "running" });
    await expect(toolCalls.begin({ ...record, thread: { threadId: "thread-a", turnId: "turn-a" } })).resolves.toMatchObject({ kind: "running" });
    await expect(toolCalls.begin(record)).rejects.toThrow();
    await expect(prisma.modelRunToolCall.count({ where: { modelRunId: run.runId, subagentThreadId: "thread-a", subagentTurnId: "turn-a" } }))
      .resolves.toBe(1);
  });

  it("admits a foreground turn, refuses a busy thread, settles it and continues the thread by name", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId);
    const run = await turn(userId, chatId, { status: "streaming" });
    const first = await store.admitForeground(admission(userId, chatId, run.runId, await callRow(run.runId, 0), "shop"));
    expect(first).toMatchObject({ continued: false, kind: "admitted", thread: { anchorRunId: run.runId, name: "shop" },
      turn: { mode: "foreground", modelId: "fake-qsa", state: "running" } });
    if (first.kind !== "admitted") throw new Error("not admitted");
    await expect(store.admitForeground(admission(userId, chatId, run.runId, await callRow(run.runId, 1), "shop")))
      .resolves.toEqual({ code: SUBAGENT_ERROR_CODES.busy, kind: "refused" });
    const result = endedSubagentCallResult({ approvals: [], binding, files: ["shop/laptops.md"], name: "shop", outcome: "done",
      report: "Outcome: done", state: "done", steps: [] });
    await expect(store.settle({ chatId, result, turnId: first.turn.id, userId })).resolves.toBe(true);
    await expect(store.settle({ chatId, result, turnId: first.turn.id, userId })).resolves.toBe(false);
    await expect(prisma.subagentTurn.findUniqueOrThrow({ where: { id: first.turn.id } }))
      .resolves.toMatchObject({ endedAt: expect.any(Date), outcome: "done", state: "done" });
    const again = await store.admitForeground(admission(userId, chatId, run.runId, await callRow(run.runId, 2), "shop"));
    expect(again).toMatchObject({ continued: true, kind: "admitted", thread: { id: first.thread.id } });
    await expect(store.find({ branchRunIds: [run.runId], chatId, name: "shop", userId })).resolves.toMatchObject({
      active: { mode: "foreground" }, thread: { id: first.thread.id } });
  });

  it("shows a thread only on the branch of the run that started it, after an earlier message was edited", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId);
    const original = await turn(userId, chatId, { status: "streaming" });
    const admitted = await store.admitForeground(admission(userId, chatId, original.runId, await callRow(original.runId, 0), "shop"));
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    await transcripts.append({ chatId, runId: original.runId, thread: { threadId: admitted.thread.id, turnId: admitted.turn.id }, userId }, 0,
      items("Abandoned branch work."));
    await store.settle({ chatId, result: endedSubagentCallResult({ approvals: [], binding, files: [], name: "shop", report: "x",
      state: "done", steps: [] }), turnId: admitted.turn.id, userId });
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: original.runId } });
    // The edited question is a sibling: its branch has its own run and none of the original's sub-agent work.
    const edited = await turn(userId, chatId, { status: "streaming" });
    await expect(store.find({ branchRunIds: [edited.runId], chatId, name: "shop", userId })).resolves.toBeNull();
    const loaded = await transcripts.loadRuns({ chatId, runIds: [edited.runId], threadId: admitted.thread.id, userId });
    expect(loaded.get(edited.runId)).toEqual([]);
    const fresh = await store.admitForeground(admission(userId, chatId, edited.runId, await callRow(edited.runId, 0), "shop",
      [edited.runId]));
    expect(fresh).toMatchObject({ continued: false, kind: "admitted", thread: { anchorRunId: edited.runId } });
    // The original branch still sees its own.
    await expect(store.find({ branchRunIds: [original.runId], chatId, name: "shop", userId })).resolves.toMatchObject({
      thread: { id: admitted.thread.id } });
  });

  it("refuses the 21st running sub-agent and ends turns a stopped parent left behind", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId);
    const run = await turn(userId, chatId, { status: "streaming" });
    for (let index = 0; index < SUBAGENT_LIMITS.runningPerChat; index += 1) {
      await expect(store.admitForeground(admission(userId, chatId, run.runId, await callRow(run.runId, index), `agent-${index}`)))
        .resolves.toMatchObject({ kind: "admitted" });
    }
    await expect(store.admitForeground(admission(userId, chatId, run.runId, await callRow(run.runId, 20), "agent-20")))
      .resolves.toEqual({ code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" });
    await expect(prisma.subagentThread.count({ where: { chatId } })).resolves.toBe(SUBAGENT_LIMITS.runningPerChat);
    // A restart ended the parent: its foreground turns end as interrupted, never replayed, and stop counting.
    await prisma.modelRun.update({ data: { status: "error" }, where: { id: run.runId } });
    const next = await turn(userId, chatId, { status: "streaming" });
    await expect(store.admitForeground(admission(userId, chatId, next.runId, await callRow(next.runId, 0), "agent-20")))
      .resolves.toMatchObject({ kind: "admitted" });
    await expect(prisma.subagentTurn.count({ where: { chatId, reasonCode: "restart", state: "interrupted" } }))
      .resolves.toBe(SUBAGENT_LIMITS.runningPerChat);
  });

  it("never counts a turn a restart left behind as running: its name is free and stopping it ends it as interrupted", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId);
    const run = await turn(userId, chatId, { status: "streaming" });
    const admitted = await store.admitForeground(admission(userId, chatId, run.runId, await callRow(run.runId, 0), "shop"));
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    await prisma.modelRun.update({ data: { status: "error" }, where: { id: run.runId } });
    const found = await store.find({ branchRunIds: [run.runId], chatId, name: "shop", userId });
    expect(found).toMatchObject({ active: null, latest: { id: admitted.turn.id, state: "running" } });
    await expect(store.endOrphanedTurns({ chatId, userId })).resolves.toBe(1);
    await expect(store.result({ chatId, turnId: admitted.turn.id, userId })).resolves.toMatchObject({ reason: "restart",
      state: "interrupted" });
    await expect(store.endOrphanedTurns({ chatId, userId })).resolves.toBe(0);
  });

  it("keeps a thread's keys apart across two turns of one run, and reads every thread's effects for the run's fence", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId);
    const run = await turn(userId, chatId, { status: "streaming" });
    const call = (turnId: string, roundIndex: number) => ({ arguments: {}, chatId, ordinal: 0, providerCallId: "c1", roundIndex,
      runId: run.runId, thread: { threadId: "thread-a", turnId }, toolName: "place_order", userId });
    // The runner continues a thread's rounds across its turns: the second turn's first round is the thread's round 2.
    await expect(toolCalls.begin(call("turn-1", 1))).resolves.toMatchObject({ kind: "running" });
    await expect(toolCalls.begin(call("turn-2", 2))).resolves.toMatchObject({ kind: "running" });
    await expect(toolCalls.begin(call("turn-2", 1))).rejects.toThrow();
    const scope = (turnId: string) => ({ chatId, runId: run.runId, thread: { threadId: "thread-a", turnId }, userId });
    const toolCall: TranscriptItem = { arguments: "{}", callId: "c1", id: randomUUID(), kind: "tool_call", name: "place_order", origin };
    await transcripts.append(scope("turn-1"), 0, [toolCall]);
    await transcripts.append(scope("turn-2"), 1, items("Second turn."));
    await transcripts.append({ chatId, runId: run.runId, userId }, 0, items("Main answer."));
    const effects = await store.threadEffectItems({ chatId, runIds: [run.runId], userId });
    expect(effects).toEqual([[expect.objectContaining({ callId: "c1", kind: "tool_call", recordedAt: expect.any(Date) })]]);
    await expect(store.threadEffectItems({ chatId, runIds: [run.runId], userId: "someone-else" })).resolves.toEqual([]);
  });

  it("deletes threads, turns and thread items with the chat", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId);
    const run = await turn(userId, chatId, { status: "streaming" });
    const admitted = await store.admitForeground(admission(userId, chatId, run.runId, await callRow(run.runId, 0), "shop"));
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    await transcripts.append({ chatId, runId: run.runId, thread: { threadId: admitted.thread.id, turnId: admitted.turn.id }, userId }, 0,
      items("Thread work."));
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: run.runId } });
    await prisma.chat.delete({ where: { id: chatId } });
    await expect(prisma.subagentThread.count({ where: { chatId } })).resolves.toBe(0);
    await expect(prisma.subagentTurn.count({ where: { chatId } })).resolves.toBe(0);
    await expect(prisma.runTranscriptItem.count({ where: { subagentThreadId: admitted.thread.id } })).resolves.toBe(0);
  });
});
