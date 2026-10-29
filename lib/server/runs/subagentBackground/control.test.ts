import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentBackgroundStartInput, SubagentBinding } from "@/lib/server/subagents/ports";
import { FakeSubagentCallbackSink, FakeSubagentRunner, FakeWorkspaceAttachments, endedSubagentResult } from "@/tests/support/subagentPorts";
import { MemorySubagentStore } from "@/tests/support/subagentBackgroundStore";
import type { UsageLimitStatus } from "@/lib/server/usageLimits/repository";
import { activeRunControllerRegistry } from "../activeRunControllerRegistry";
import { SubagentMailboxFullError, createSubagentBackgroundControl, localSubagentTurnIds } from "./control";

const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-model", modelSource: "parent", provider: "fake",
  providerModelId: "model-1", reasoningEffort: null };
const NO_LIMITS: UsageLimitStatus = {
  effective: { exempt: false, messagesPerDay: { source: null, value: null }, messagesPerHour: { source: null, value: null },
    monthlyBudgetMicros: { source: null, value: null } },
  installationCapMicros: null, installationSpentMicros: 0,
  lastDay: { count: 0, freesAt: null }, lastHour: { count: 0, freesAt: null }, userSpentMicros: 0
};
const unlimited = { loadUsageLimitStatus: async () => NO_LIMITS };

function startInput(name: string, overrides: Partial<SubagentBackgroundStartInput> = {}): SubagentBackgroundStartInput {
  return { binding, brief: `Research ${name}`, chatId: "chat-1", kind: "start", name, parentRunId: "parent-run",
    parentToolCallId: `call-${name}`, threadId: `thread-${name}`, type: null, userId: "user-1", userMessage: "Find the 5 best", ...overrides };
}

function setup(options: Readonly<{ runner?: FakeSubagentRunner | null; usageRefuses?: boolean }> = {}) {
  const store = new MemorySubagentStore();
  store.callers.add("parent-run");
  const runner = options.runner === undefined ? new FakeSubagentRunner() : options.runner;
  const sink = new FakeSubagentCallbackSink("wake_up");
  const workspace = new FakeWorkspaceAttachments();
  const usageLimits = options.usageRefuses
    ? { loadUsageLimitStatus: async (): Promise<UsageLimitStatus> => { throw new Error("unreadable"); } } : unlimited;
  const control = createSubagentBackgroundControl({ callbacks: sink, runner, stopWaitMs: 2_000, store, usageLimits, workspace });
  return { control, runner, sink, store, workspace };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("background sub-agent runs", () => {
  it("admits a background turn as its own run and returns at once with its name and state", async () => {
    const { control, runner, store, workspace } = setup();
    const started = await control.start(startInput("researcher"));
    expect(started).toMatchObject({ kind: "started", name: "researcher", state: "running" });
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    const turn = runner!.turns.get(turnId)!;
    // Its own run hosts its rows, under the parent's frozen binding, with its own hour of tool time.
    expect(turn.input).toMatchObject({ binding, hostRunId: store.turns[0]!.runId, mode: "background", parentRunId: "parent-run",
      userMessage: "Find the 5 best" });
    expect(turn.input.deadlineAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(turn.kind).toBe("start");
    expect(activeRunControllerRegistry.has(store.turns[0]!.runId!)).toBe(true);
    expect(await workspace.attached({ chatId: "chat-1", userId: "user-1" })).toMatchObject([{
      agent: { kind: "subagent", name: "researcher", threadId: "thread-researcher" }, modelRunId: store.turns[0]!.runId }]);
    await control.stopAll({ chatId: "chat-1", userId: "user-1" });
  });

  it("settles its turn when it ends and sends the callback to the main agent", async () => {
    const { control, runner, sink, store, workspace } = setup();
    const started = await control.start(startInput("shop"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    runner!.finish(turnId, endedSubagentResult("shop", { report: "Three offers" }));
    await vi.waitFor(() => expect(sink.callbacks).toHaveLength(1));
    expect(sink.callbacks[0]).toMatchObject({ chatId: "chat-1", name: "shop", parentRunId: "parent-run", result: { report: "Three offers" },
      threadId: "thread-shop", turnId });
    expect(store.turns[0]).toMatchObject({ runActive: false, state: "done" });
    expect(await workspace.attached({ chatId: "chat-1", userId: "user-1" })).toEqual([]);
    expect(localSubagentTurnIds()).not.toContain(turnId);
  });

  it("refuses visibly and leaves no turn: background unavailable, usage limits, a busy thread, the running cap", async () => {
    expect(await setup({ runner: null }).control.start(startInput("a"))).toEqual({ code: "subagent_background_unavailable", kind: "refused" });
    const telegram = setup();
    telegram.store.callers.clear();
    expect(await telegram.control.availability({ chatId: "chat-1", parentRunId: "parent-run", parentToolCallId: "c", userId: "user-1" }))
      .toEqual({ available: false, code: "subagent_background_unavailable" });
    const limited = setup({ usageRefuses: true });
    expect(await limited.control.start(startInput("a"))).toEqual({ code: "subagent_usage_limited", kind: "refused" });
    expect(limited.store.turns).toHaveLength(0);
    const { control } = setup();
    await control.start(startInput("dup"));
    expect(await control.start(startInput("dup"))).toEqual({ code: "subagent_busy", kind: "refused" });
    for (let index = 1; index < 20; index += 1) await control.start(startInput(`agent-${index}`));
    expect(await control.start(startInput("one-too-many"))).toEqual({ code: "subagent_limit_reached", kind: "refused" });
    expect(await control.stopAll({ chatId: "chat-1", userId: "user-1" })).toBe(20);
  });

  it("delivers a main-agent message to the running sub-agent's mailbox, once per nonce", async () => {
    const { control, runner, store } = setup();
    const started = await control.start(startInput("researcher"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    const message = { message: { nonce: "call-2", origin: "main_agent" as const, text: "Also check prices" }, name: "researcher",
      threadId: "thread-researcher", chatId: "chat-1", parentRunId: "parent-run", parentToolCallId: "call-2", userId: "user-1" };
    expect(await control.deliver(message)).toEqual({ kind: "delivered", state: "running" });
    expect(await control.deliver(message)).toEqual({ kind: "delivered", state: "running" });
    // The sub-agent reads it at its next round: the runner received it, and the mailbox records receipt.
    expect(runner!.turns.get(turnId)!.messages).toEqual([message.message]);
    expect(store.turns[0]!.mailbox).toEqual([{ delivered: true, nonce: "call-2", text: "Also check prices" }]);
    for (let index = 1; index < 32; index += 1) await control.deliver({ ...message, message: { ...message.message, nonce: `n-${index}` } });
    await expect(control.deliver({ ...message, message: { ...message.message, nonce: "n-33" } })).rejects.toBeInstanceOf(SubagentMailboxFullError);
    runner!.finish(turnId, endedSubagentResult("researcher"));
    await vi.waitFor(() => expect(store.turns[0]!.state).toBe("done"));
    expect(await control.deliver({ ...message, message: { ...message.message, nonce: "late" } }))
      .toMatchObject({ kind: "ended", result: { name: "researcher", state: "done" } });
  });

  it("stops by name with stop_subagent and returns its last state; stopping an ended one returns how it ended", async () => {
    const { control, runner, sink } = setup();
    const started = await control.start(startInput("slow"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    const scope = { chatId: "chat-1", parentRunId: "parent-run", parentToolCallId: "stop-1", userId: "user-1" };
    expect(await control.stop({ ...scope, name: "slow" })).toMatchObject({ kind: "stopped", result: { reason: "stop_subagent", state: "stopped" } });
    expect(sink.callbacks.map((callback) => callback.result.state)).toEqual(["stopped"]);
    expect(await control.stop({ ...scope, name: "slow" })).toMatchObject({ kind: "stopped", result: { state: "stopped" } });
    expect(await control.stop({ ...scope, name: "missing" })).toEqual({ kind: "not_found" });
  });

  it("is never stopped by the main answer's Stop: its signal is its own", async () => {
    const { control, runner, store } = setup();
    const started = await control.start(startInput("independent"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    activeRunControllerRegistry.abort("parent-run");
    expect(runner!.turns.get(turnId)!.ended).toBeNull();
    expect(runner!.turns.get(turnId)!.input.signal.aborted).toBe(false);
    expect(await control.stopThread({ chatId: "chat-1", threadId: "thread-independent", userId: "user-1" })).toBe(1);
    expect(store.turns[0]).toMatchObject({ result: { reason: "user_stop" }, state: "stopped" });
  });

  it("ends a turn at its own tool time", async () => {
    const store = new MemorySubagentStore();
    store.callers.add("parent-run");
    const runner = new FakeSubagentRunner();
    const control = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink(), runner, store, turnTimeMs: 20,
      usageLimits: unlimited });
    await control.start(startInput("timed"));
    await vi.waitFor(() => expect(store.turns[0]).toMatchObject({ result: { reason: "deadline" }, state: "stopped" }));
  });

  it("settles a turn no execution here owns when stopped, with its callback", async () => {
    const { control, sink, store } = setup();
    store.turns.push({ callbackRunId: null, chatId: "chat-1", endedAt: null, mailbox: [], mode: "background", modelId: "m", name: "orphan",
      parentAnswerId: "answer-1", parentRunId: "parent-run", result: null, runActive: true, runId: "orphan-run", state: "running",
      threadId: "thread-orphan", turnId: "orphan-turn", userId: "user-1" });
    expect(await control.stopChat({ chatId: "chat-1", userId: "user-1" })).toBe(1);
    expect(store.turns[0]).toMatchObject({ result: { reason: "chat_deleted" }, state: "stopped" });
    expect(sink.callbacks).toHaveLength(1);
  });

  it("fails a turn whose Workspace refuses it, visibly, and never runs it", async () => {
    const store = new MemorySubagentStore();
    store.callers.add("parent-run");
    const runner = new FakeSubagentRunner();
    const control = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink(), runner, store,
      usageLimits: unlimited, workspace: new FakeWorkspaceAttachments({ refuseAttach: "workspace_unavailable" }) });
    await control.start(startInput("nows"));
    await vi.waitFor(() => expect(store.turns[0]).toMatchObject({ result: { reason: "workspace_unavailable" }, state: "failed" }));
    expect(runner.turns.size).toBe(0);
  });
});
