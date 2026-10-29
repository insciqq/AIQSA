import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { decodeSubagentChatThreads, decodeSubagentThreadView } from "../../../contracts/subagentViews";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { createNativeOrphanFinder } from "../../engine/recovery";
import { ActiveMessageMutationConflictError } from "../../messages/handlers";
import { createPrismaMessageBranchRepository } from "../../messages/prismaRepository";
import { prisma } from "../../prisma";
import { loadProviderAdmissionPlan } from "../../providerRuntime/admission";
import type { SubagentBinding } from "../../subagents/ports";
import type { UsageLimitStatus } from "../../usageLimits/repository";
import { FakeSubagentCallbackSink, FakeSubagentRunner, endedSubagentResult } from "../../../../tests/support/subagentPorts";
import { createPrismaRunRepository } from "../prismaRepository";
import { createPrismaRunFollowupOperations } from "../prismaRepositoryFollowups";
import { followupTokenCost } from "../runFollowups";
import type { CreateRunInput, CreatedRun } from "../runRepositoryContract";
import { createSubagentCallbacks } from "./callbacks";
import { createSubagentBackgroundControl } from "./control";
import { reconcileSubagentRuns } from "./recovery";
import {
  SubagentCallbackClaimConflictError,
  claimSubagentCallbacksForRun,
  createPrismaSubagentBackgroundStore,
  lockChatSubagentAdmission
} from "./store";
import { createSubagentViews } from "./views";

/**
 * Background sub-agent runs on a disposable database: admission races, the
 * callback against a finishing answer, deletion during background work and
 * recovery with one coalesced wake-up.
 */

const repository = createPrismaRunRepository(prisma);
const followups = createPrismaRunFollowupOperations(prisma);
const store = createPrismaSubagentBackgroundStore(prisma);
const views = createSubagentViews(prisma);
const messages = createPrismaMessageBranchRepository();
const cancelPayload = { code: "model_run_cancelled", message: "Model run cancelled" };
const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "fake",
  providerModelId: providerTemplateIds.fakeModel, reasoningEffort: null };
const NO_LIMITS: UsageLimitStatus = {
  effective: { exempt: false, messagesPerDay: { source: null, value: null }, messagesPerHour: { source: null, value: null },
    monthlyBudgetMicros: { source: null, value: null } },
  installationCapMicros: null, installationSpentMicros: 0, lastDay: { count: 0, freesAt: null }, lastHour: { count: 0, freesAt: null },
  userSpentMicros: 0
};

type Fixture = Readonly<{
  chatId: string;
  /** The main-agent run whose `call_subagent` calls start threads; active until the test ends it. */
  main: CreatedRun;
  otherId: string;
  /** A thread of the main run with its own `call_subagent` call row. */
  thread(name: string): Promise<Readonly<{ callId: string; threadId: string }>>;
  userId: string;
}>;

async function fixture<T>(execute: (fixture: Fixture) => Promise<T>): Promise<T> {
  const userId = `subagent-owner-${randomUUID()}`, otherId = `subagent-other-${randomUUID()}`;
  await prisma.user.createMany({ data: [userId, otherId].map((id) => ({ displayName: "Synthetic owner", id, status: "active" })) });
  try {
    await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled", userId } });
    await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Sub-agent fixture", userId } });
    const content = textMessageContent("Find the five best");
    const input: CreateRunInput = { chatId: chat.id, content, expectedActiveLeafId: null, userId,
      modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
      defaults: { userId, controlDefaults: {}, modelId: providerTemplateIds.fakeModel,
        provider: providerTemplateIds.fakeConnection, searchPlan: { mode: "all_selected", optionIds: [] } },
      providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { userId,
        providerConnectionId: providerTemplateIds.fakeConnection, providerModelId: providerTemplateIds.fakeModel,
        searchPlan: { mode: "all_selected", optionIds: [] } }),
      followupAdmission: { budgetTokens: 4_096 },
      normalizedRequest: { attachmentIds: [], chatId: chat.id, content, toolMode: "auto",
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
        followupContextReserveTokens: 4_096, searchPlan: { mode: "all_selected", options: [] } } };
    const main = await repository.createRun(input);
    await prisma.modelRun.update({ data: { status: "streaming" }, where: { id: main.runId } });
    let ordinal = 0;
    const thread = async (name: string) => {
      ordinal += 1;
      const call = await prisma.modelRunToolCall.create({ data: { arguments: { message: `Brief for ${name}`, name }, modelRunId: main.runId,
        ordinal, providerCallId: `call-${ordinal}`, roundIndex: 1, state: "running", toolName: "call_subagent" } });
      const row = await prisma.subagentThread.create({ data: { anchorRunId: main.runId, chatId: chat.id, name, userId } });
      return { callId: call.id, threadId: row.id };
    };
    return await execute({ chatId: chat.id, main, otherId, thread, userId });
  } finally {
    await prisma.chat.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  }
}

function admission(f: Fixture, thread: Readonly<{ callId: string; threadId: string }>) {
  return { binding, chatId: f.chatId, definitionRevisionId: null, parentRunId: f.main.runId, parentToolCallId: thread.callId,
    runId: randomUUID(), threadId: thread.threadId, turnId: randomUUID(), userId: f.userId };
}

function control(runner = new FakeSubagentRunner(), sink = new FakeSubagentCallbackSink("pending")) {
  return { control: createSubagentBackgroundControl({ callbacks: sink, runner, stopWaitMs: 5_000, store,
    usageLimits: { loadUsageLimitStatus: async () => NO_LIMITS } }), runner, sink };
}

const startInput = (f: Fixture, name: string, thread: Readonly<{ callId: string; threadId: string }>) => ({
  binding, brief: `Brief for ${name}`, chatId: f.chatId, kind: "start" as const, name, parentRunId: f.main.runId,
  parentToolCallId: thread.callId, threadId: thread.threadId, type: null, userId: f.userId, userMessage: "Find the five best"
});

describe("background sub-agent runs on PostgreSQL", () => {
  afterAll(() => prisma.$disconnect());

  it("admits one run per thread when two admissions race, caps the chat at 20 and keeps the main agent's send open", async () => fixture(async (f) => {
    const first = await f.thread("dup");
    const [a, b] = await Promise.all([store.admit(admission(f, first)), store.admit(admission(f, first))]);
    expect([a.kind, b.kind].sort()).toEqual(["admitted", "refused"]);
    expect([a, b].find((result) => result.kind === "refused")).toEqual({ code: "subagent_busy", kind: "refused" });
    const admitted = [a, b].find((result) => result.kind === "admitted")!;
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: admitted.kind === "admitted" ? admitted.runId : "" } });
    // Its own run: the parent's user message, no answer, its thread and turn, beside the active main run.
    expect(run).toMatchObject({ assistantMessageId: null, status: "streaming", subagentThreadId: first.threadId,
      userMessageId: f.main.userMessageId });
    for (let index = 1; index < 20; index += 1) {
      expect((await store.admit(admission(f, await f.thread(`agent-${index}`)))).kind).toBe("admitted");
    }
    expect(await store.admit(admission(f, await f.thread("one-too-many")))).toEqual({ code: "subagent_limit_reached", kind: "refused" });
    // The main agent's own active-run reads see only the main run, never the 20 sub-agents.
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
    expect(await repository.findRecentActiveRunForChat({ chatId: f.chatId, since: new Date(0), userId: f.userId })).toBeNull();
    // Stop on a background run's id through the answer's Stop is not one: it stops only through its own paths.
    expect(await repository.cancelRun({ payload: cancelPayload, runId: run.id, userId: f.userId })).toEqual({ kind: "not_found" });
    const threads = decodeSubagentChatThreads(await views.chatThreads({ chatId: f.chatId, userId: f.userId }));
    expect(threads).toMatchObject({ running: 20 });
    expect(await views.chatThreads({ chatId: f.chatId, userId: f.otherId })).toBeNull();
  }));

  it("gives a callback and the answer finishing at the same time exactly one winner, outside the user's follow-ups", async () => fixture(async (f) => {
    const thread = await f.thread("researcher");
    const admitted = await store.admit(admission(f, thread));
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    await store.settle({ chatId: f.chatId, result: endedSubagentResult("researcher", { report: "Five products" }), turnId: admitted.turnId,
      userId: f.userId });
    const [delivered, closed] = await Promise.all([
      store.deliverIntoRun({ chatId: f.chatId, runId: f.main.runId, turnId: admitted.turnId, userId: f.userId }),
      followups.close({ revision: 0, runId: f.main.runId, userId: f.userId })
    ]);
    expect(Number(delivered === "delivered") + Number(closed)).toBe(1);
    const turn = await prisma.subagentTurn.findUniqueOrThrow({ where: { id: admitted.turnId } });
    if (delivered === "delivered") {
      expect(turn.callbackRunId).toBe(f.main.runId);
      expect(await followups.load({ runId: f.main.runId, userId: f.userId })).toMatchObject({ revision: 1,
        entries: [{ delivery: "accepted", origin: "subagent_callback" }] });
      // The user's own follow-ups are untouched by it: one is accepted as their first, and browsers see only theirs.
      expect(await followups.accept({ assistantMessageId: f.main.assistantMessageId, chatId: f.chatId, nonce: "user-1",
        runId: f.main.runId, text: "Prefer cheaper ones", userId: f.userId })).toMatchObject({ entry: { ordinal: 1 }, kind: "accepted" });
      expect((await repository.getRunOutcomeForUser(f.main.runId, f.userId))?.followups?.entries.map((entry) => entry.text))
        .toEqual(["Prefer cheaper ones"]);
      // The claim is once: a wake-up admission for the same callback is refused.
      await expect(prisma.$transaction((tx) => claimSubagentCallbacksForRun(tx, { chatId: f.chatId, runId: f.main.runId,
        turnIds: [admitted.turnId], userMessageId: f.main.assistantMessageId }))).rejects.toBeInstanceOf(SubagentCallbackClaimConflictError);
    } else {
      // The answer closed first: the callback stays owed for its terminal flush.
      expect(turn.callbackRunId).toBeNull();
      expect(delivered).toBe("closed");
      expect((await store.owedCallbacks({ chatId: f.chatId, userId: f.userId }))?.activeBranch.map((callback) => callback.turnId))
        .toEqual([admitted.turnId]);
    }
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
  }));

  it("delivers a main-agent message to the running sub-agent's mailbox once and shows it in the thread view", async () => fixture(async (f) => {
    const thread = await f.thread("shop");
    const { control: background, runner } = control();
    const started = await background.start(startInput(f, "shop", thread));
    expect(started).toMatchObject({ kind: "started", name: "shop" });
    const message = { chatId: f.chatId, message: { nonce: "call-msg", origin: "main_agent" as const, text: "Check delivery too" },
      name: "shop", parentRunId: f.main.runId, parentToolCallId: thread.callId, threadId: thread.threadId, userId: f.userId };
    expect(await background.deliver(message)).toEqual({ kind: "delivered", state: "running" });
    expect(await background.deliver(message)).toEqual({ kind: "delivered", state: "running" });
    const turnId = started.kind === "started" ? started.turnId : "";
    expect(runner.turns.get(turnId)?.messages).toHaveLength(1);
    expect(await prisma.runFollowup.count({ where: { origin: "main_agent" } })).toBeGreaterThanOrEqual(1);
    const view = decodeSubagentThreadView(await views.threadView({ chatId: f.chatId, threadId: thread.threadId, userId: f.userId }));
    expect(view?.turns[0]).toMatchObject({ brief: "Brief for shop", messages: [{ delivery: "delivered", text: "Check delivery too" }],
      mode: "background", state: "running" });
    // The mailbox orders itself and never moves the run's follow-up revision, which a completing run's guard checks
    // (`ModelRun_followup_completion_guard`), so a sub-agent that ends after a message still completes.
    expect(await prisma.modelRun.findFirstOrThrow({ select: { followupRevision: true }, where: { subagentTurnId: turnId } }))
      .toEqual({ followupRevision: 0 });
    // A second message the sub-agent never reads before it ends.
    expect(await background.deliver({ ...message, message: { ...message.message, nonce: "call-msg-2", text: "And returns" } }))
      .toEqual({ kind: "delivered", state: "running" });
    runner.finish(turnId, endedSubagentResult("shop", { report: "Two shops" }));
    await expect.poll(async () => (await prisma.subagentTurn.findUniqueOrThrow({ where: { id: turnId } })).state).toBe("done");
    expect(await prisma.modelRun.findFirstOrThrow({ select: { status: true }, where: { subagentTurnId: turnId } }))
      .toEqual({ status: "complete" });
    expect(decodeSubagentThreadView(await views.threadView({ chatId: f.chatId, threadId: thread.threadId, userId: f.userId }))?.turns[0])
      .toMatchObject({ report: "Two shops", state: "done" });
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
  }));

  it("takes callbacks into an answer past the user's 32 follow-ups without using theirs up", async () => fixture(async (f) => {
    const admitted = await store.admit(admission(f, await f.thread("late")));
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    await store.settle({ chatId: f.chatId, result: endedSubagentResult("late"), turnId: admitted.turnId, userId: f.userId });
    // As if the user's own follow-ups had used all 32 of their ordinals.
    await prisma.modelRun.update({ data: { followupRevision: 32 }, where: { id: f.main.runId } });
    expect(await store.deliverIntoRun({ chatId: f.chatId, runId: f.main.runId, turnId: admitted.turnId, userId: f.userId })).toBe("delivered");
    expect(await prisma.runFollowup.findFirstOrThrow({ select: { ordinal: true }, where: { subagentTurnId: admitted.turnId } }))
      .toEqual({ ordinal: 33 });
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
  }));

  it("stops a branch's background sub-agents before deleting its messages and leaves no rows", async () => fixture(async (f) => {
    const thread = await f.thread("browser");
    const { control: background } = control();
    expect((await background.start(startInput(f, "browser", thread))).kind).toBe("started");
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
    // Unstopped, the deletion refuses rather than cut off a running sub-agent (its run shares the deleted message).
    await expect(messages.deleteMessageSubtree({ messageId: f.main.userMessageId, userId: f.userId }))
      .rejects.toBeInstanceOf(ActiveMessageMutationConflictError);
    expect(await background.stopUnderMessage({ chatId: f.chatId, messageId: f.main.userMessageId, userId: f.userId })).toBe(1);
    expect(await messages.deleteMessageSubtree({ messageId: f.main.userMessageId, userId: f.userId })).toMatchObject({ chatId: f.chatId });
    expect(await prisma.modelRun.count({ where: { chatId: f.chatId } })).toBe(0);
    expect(await prisma.subagentThread.count({ where: { chatId: f.chatId } })).toBe(0);
    expect(await prisma.subagentTurn.count({ where: { chatId: f.chatId } })).toBe(0);
  }));

  it("stops everything when the chat is deleted during background work and leaves no rows", async () => fixture(async (f) => {
    const { control: background, sink } = control();
    for (const name of ["one", "two"]) expect((await background.start(startInput(f, name, await f.thread(name)))).kind).toBe("started");
    expect(await background.stopChat({ chatId: f.chatId, userId: f.userId })).toBe(2);
    expect(sink.callbacks.map((callback) => callback.result.reason)).toEqual(["chat_deleted", "chat_deleted"]);
    expect(await prisma.modelRun.count({ where: { chatId: f.chatId, status: { in: ["streaming", "queued", "in_progress", "preparing"] },
      subagentTurnId: { not: null } } })).toBe(0);
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
    await prisma.chat.delete({ where: { id: f.chatId } });
    for (const count of [prisma.modelRun.count({ where: { chatId: f.chatId } }), prisma.subagentThread.count({ where: { chatId: f.chatId } }),
      prisma.subagentTurn.count({ where: { chatId: f.chatId } }), prisma.runFollowup.count({ where: { chatId: f.chatId } })]) {
      expect(await count).toBe(0);
    }
  }));

  it("interrupts cut-off background runs on recovery, outside the main orphan batch, with one coalesced wake-up", async () => fixture(async (f) => {
    const turnIds: string[] = [];
    for (const name of ["alpha", "beta"]) {
      const admitted = await store.admit(admission(f, await f.thread(name)));
      if (admitted.kind === "admitted") turnIds.push(admitted.turnId);
    }
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
    const future = new Date(Date.now() + 60_000);
    // The main agent's orphan finder never sees them.
    expect(await createNativeOrphanFinder(prisma)({ bootedBefore: future, chatId: f.chatId, limit: 50, liveRunIds: [],
      staleBefore: new Date(0) })).toEqual([]);
    const wakeUps: string[][] = [];
    const callbacks = createSubagentCallbacks({ coalesceMs: 20, store, admitWakeUp: async (input) => {
      // The wake-up's own message hangs from the main answer, so its path holds the callbacks' parent answer.
      await prisma.$transaction((tx) => claimSubagentCallbacksForRun(tx, { chatId: input.chatId, runId: f.main.runId,
        turnIds: input.turnIds, userMessageId: f.main.assistantMessageId }));
      wakeUps.push([...input.turnIds]);
      return "admitted";
    } });
    const recovery = { backoff: new Map(), bootedAt: future, deferred: new Map(), flush: callbacks.flush, liveRunIds: () => [],
      staleMs: 600_000, store };
    const settled = await reconcileSubagentRuns(recovery, { chatId: f.chatId });
    expect(settled).toBe(2);
    expect(await prisma.subagentTurn.findMany({ select: { reasonCode: true, state: true }, where: { id: { in: turnIds } } }))
      .toEqual([{ reasonCode: "restart", state: "interrupted" }, { reasonCode: "restart", state: "interrupted" }]);
    expect(await prisma.modelRun.count({ where: { chatId: f.chatId, status: "error", subagentTurnId: { not: null } } })).toBe(2);
    await expect.poll(() => wakeUps.length).toBe(1);
    expect(wakeUps[0]!.sort()).toEqual([...turnIds].sort());
    // A second pass finds nothing more to do.
    expect(await reconcileSubagentRuns(recovery, { chatId: f.chatId })).toBe(0);
  }));

  it("copies the parent's request onto the background run and keeps the 20 cap across foreground and background admissions", async () => fixture(async (f) => {
    const first = await store.admit(admission(f, await f.thread("copy")));
    if (first.kind !== "admitted") throw new Error("not admitted");
    const [parent, own] = await Promise.all([f.main.runId, first.runId].map((id) =>
      prisma.modelRun.findUniqueOrThrow({ select: { normalizedRequest: true }, where: { id } })));
    expect(own!.normalizedRequest).toEqual(parent!.normalizedRequest);
    expect(await prisma.mcpRunBinding.count({ where: { modelRunId: first.runId } })).toBe(0);
    for (let index = 1; index < 19; index += 1) expect((await store.admit(admission(f, await f.thread(`bg-${index}`)))).kind).toBe("admitted");
    // The engine's foreground admission under the same chat lock, as `admitForeground` takes it.
    const foreground = async (thread: Readonly<{ callId: string; threadId: string }>) => prisma.$transaction(async (tx) => {
      await lockChatSubagentAdmission(tx, f.chatId);
      const running = await tx.subagentTurn.count({ where: { chatId: f.chatId, state: { in: ["running", "waiting"] } } });
      if (running >= 20) return false;
      await tx.subagentTurn.create({ data: { chatId: f.chatId, mode: "foreground", modelId: "fake-qsa", parentRunId: f.main.runId,
        parentToolCallId: thread.callId, provider: "fake", threadId: thread.threadId, userId: f.userId } });
      return true;
    });
    const [background, foregroundAdmitted] = await Promise.all([store.admit(admission(f, await f.thread("last-bg"))),
      foreground(await f.thread("last-fg"))]);
    expect(Number(background.kind === "admitted") + Number(foregroundAdmitted)).toBe(1);
    expect(await prisma.subagentTurn.count({ where: { chatId: f.chatId, state: "running" } })).toBe(20);
    await prisma.subagentTurn.updateMany({ data: { endedAt: new Date(), reasonCode: "restart", state: "interrupted" },
      where: { chatId: f.chatId, mode: "foreground" } });
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
  }));

  it("never runs a turn whose admission had not committed when Stop all came", async () => fixture(async (f) => {
    const thread = await f.thread("early");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Blocked before its transaction wrote anything: Stop all's read of the chat's turns finds no row of it.
    const blocked = { ...store, admit: async (input: Parameters<typeof store.admit>[0]) => {
      await gate;
      return store.admit(input);
    } };
    const runner = new FakeSubagentRunner();
    const background = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink("pending"), runner, stopWaitMs: 5_000,
      store: blocked, usageLimits: { loadUsageLimitStatus: async () => NO_LIMITS } });
    const starting = background.start(startInput(f, "early", thread));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await prisma.subagentTurn.count({ where: { threadId: thread.threadId } })).toBe(0);
    const stopping = background.stopAll({ chatId: f.chatId, userId: f.userId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    expect(await starting).toMatchObject({ kind: "started" });
    expect(await stopping).toBe(1);
    expect(runner.turns.size).toBe(0);
    expect(await prisma.subagentTurn.findFirstOrThrow({ select: { reasonCode: true, state: true }, where: { threadId: thread.threadId } }))
      .toEqual({ reasonCode: "stop_all", state: "stopped" });
    expect(await prisma.modelRun.count({ where: { status: "cancelled", subagentThreadId: thread.threadId } })).toBe(1);
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
  }));

  it("never runs a turn stopped after its admission committed and before it launched", async () => fixture(async (f) => {
    const thread = await f.thread("raced");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gated = { ...store, admit: async (input: Parameters<typeof store.admit>[0]) => {
      const result = await store.admit(input);
      await gate;
      return result;
    } };
    const runner = new FakeSubagentRunner();
    const background = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink("pending"), runner, stopWaitMs: 5_000,
      store: gated, usageLimits: { loadUsageLimitStatus: async () => NO_LIMITS } });
    const starting = background.start(startInput(f, "raced", thread));
    await expect.poll(() => prisma.subagentTurn.count({ where: { threadId: thread.threadId } })).toBe(1);
    const stopping = background.stopAll({ chatId: f.chatId, userId: f.userId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    expect(await starting).toMatchObject({ kind: "started" });
    expect(await stopping).toBe(1);
    expect(runner.turns.size).toBe(0);
    const turn = await prisma.subagentTurn.findFirstOrThrow({ select: { reasonCode: true, state: true }, where: { threadId: thread.threadId } });
    expect(turn).toEqual({ reasonCode: "stop_all", state: "stopped" });
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
  }));

  it("re-owes a callback the stopped answer never read, wakes nothing on the Stop, and recovery wakes the idle chat once", async () => fixture(async (f) => {
    const admitted = await store.admit(admission(f, await f.thread("reader")));
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    await store.settle({ chatId: f.chatId, result: endedSubagentResult("reader", { report: "r".repeat(12_000) }),
      turnId: admitted.turnId, userId: f.userId });
    expect(await store.deliverIntoRun({ chatId: f.chatId, runId: f.main.runId, turnId: admitted.turnId, userId: f.userId })).toBe("delivered");
    const followup = await prisma.runFollowup.findFirstOrThrow({ where: { subagentTurnId: admitted.turnId } });
    // Bounded to the run's follow-up reserve (4,096 tokens in the fixture), with the cut mark.
    expect(followupTokenCost(followup.text)).toBeLessThanOrEqual(4_096);
    // The user stops the answer before it read the callback.
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
    const owed = await store.owedCallbacks({ chatId: f.chatId, userId: f.userId });
    expect(owed?.activeBranch.map((callback) => callback.turnId)).toEqual([admitted.turnId]);
    expect(await prisma.runFollowup.count({ where: { subagentTurnId: admitted.turnId } })).toBe(0);
    // After a restart it is still owed: recovery finds it from the rows alone and wakes the chat once.
    const earlier = new Date(Date.now() - 60_000);
    await prisma.subagentTurn.update({ data: { endedAt: earlier, startedAt: earlier }, where: { id: admitted.turnId } });
    expect(await store.findOwedCallbackChats({ chatId: f.chatId, endedBefore: new Date(), limit: 10 }))
      .toEqual([{ chatId: f.chatId, turnIds: [admitted.turnId], userId: f.userId }]);
    const wakeUps: string[][] = [];
    const callbacks = createSubagentCallbacks({ coalesceMs: 10, store, admitWakeUp: async (input) => {
      await prisma.$transaction((tx) => claimSubagentCallbacksForRun(tx, { chatId: input.chatId, runId: f.main.runId,
        turnIds: input.turnIds, userMessageId: f.main.assistantMessageId }));
      wakeUps.push([...input.turnIds]);
      return "admitted";
    } });
    await reconcileSubagentRuns({ backoff: new Map(), bootedAt: new Date(0), deferred: new Map(), flush: callbacks.flush,
      liveRunIds: () => [], staleMs: 600_000, store }, { chatId: f.chatId });
    await expect.poll(() => wakeUps.length).toBe(1);
    expect(wakeUps[0]).toEqual([admitted.turnId]);
  }));

  it("refuses to claim a callback into a branch its sub-agent's parent answer is not on", async () => fixture(async (f) => {
    const admitted = await store.admit(admission(f, await f.thread("old-branch")));
    if (admitted.kind !== "admitted") throw new Error("not admitted");
    await store.settle({ chatId: f.chatId, result: endedSubagentResult("old-branch"), turnId: admitted.turnId, userId: f.userId });
    await repository.cancelRun({ payload: cancelPayload, runId: f.main.runId, userId: f.userId });
    // The user switched to an edited branch between reading the owed callbacks and the wake-up's admission.
    const sibling = await prisma.message.create({ data: { chatId: f.chatId, content: textMessageContent("Edited question"),
      parentMessageId: null, role: "user", status: "complete" } });
    await expect(prisma.$transaction((tx) => claimSubagentCallbacksForRun(tx, { chatId: f.chatId, runId: f.main.runId,
      turnIds: [admitted.turnId], userMessageId: sibling.id }))).rejects.toBeInstanceOf(SubagentCallbackClaimConflictError);
    expect((await prisma.subagentTurn.findUniqueOrThrow({ where: { id: admitted.turnId } })).callbackRunId).toBeNull();
  }));
});
