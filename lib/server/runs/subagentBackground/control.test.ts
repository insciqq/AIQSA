import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentBackgroundStartInput, SubagentBinding, WorkspaceAttachments } from "@/lib/server/subagents/ports";
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

  it("runs a turn its Workspace refuses unattached, so its Workspace calls are refused where they are made", async () => {
    const store = new MemorySubagentStore();
    store.callers.add("parent-run");
    const runner = new FakeSubagentRunner();
    const control = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink(), runner, store,
      usageLimits: unlimited, workspace: new FakeWorkspaceAttachments({ refuseAttach: "workspace_unavailable" }) });
    const started = await control.start(startInput("nows"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner.turns.get(turnId)).toBeDefined());
    await control.stopAll({ chatId: "chat-1", userId: "user-1" });
  });

  it("never runs a turn stopped between its admission becoming visible and its launch", async () => {
    const { control, runner, sink, store } = setup();
    let release: () => void = () => undefined;
    store.admitGate = () => new Promise<void>((resolve) => { release = resolve; });
    const starting = control.start(startInput("raced"));
    await vi.waitFor(() => expect(store.turns).toHaveLength(1));
    const stopping = control.stopAll({ chatId: "chat-1", userId: "user-1" });
    await vi.waitFor(() => expect(activeRunControllerRegistry.has(store.turns[0]!.runId!)).toBe(false));
    release();
    expect(await starting).toMatchObject({ kind: "started" });
    expect(await stopping).toBe(1);
    expect(store.turns[0]).toMatchObject({ result: { reason: "stop_all" }, state: "stopped" });
    expect(runner.turns.size).toBe(0);
    expect(sink.callbacks).toHaveLength(1);
  });

  it.each(["stopAll", "stopThread", "stopUnderMessage"] as const)(
    "never runs a turn whose admission had not committed when %s came", async (operation) => {
      const { control, runner, store } = setup();
      let release: () => void = () => undefined;
      store.admitBeforeGate = () => new Promise<void>((resolve) => { release = resolve; });
      const before = localSubagentTurnIds().length;
      const starting = control.start(startInput("early"));
      await vi.waitFor(() => expect(localSubagentTurnIds()).toHaveLength(before + 1));
      expect(store.turns).toHaveLength(0);
      const scope = { chatId: "chat-1", userId: "user-1" };
      const stopping = operation === "stopAll" ? control.stopAll(scope)
        : operation === "stopThread" ? control.stopThread({ ...scope, threadId: "thread-early" })
          : control.stopUnderMessage({ ...scope, messageId: "answer-1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      expect(await starting).toMatchObject({ kind: "started" });
      expect(await stopping).toBe(1);
      expect(runner.turns.size).toBe(0);
      expect(store.turns[0]).toMatchObject({ result: { state: "stopped" }, state: "stopped" });
    });

  it("leaves another thread's admission alone when stopping one thread", async () => {
    const { control, runner, store } = setup();
    let release: () => void = () => undefined;
    store.admitBeforeGate = () => new Promise<void>((resolve) => { release = resolve; });
    const before = localSubagentTurnIds().length;
    const starting = control.start(startInput("other"));
    await vi.waitFor(() => expect(localSubagentTurnIds()).toHaveLength(before + 1));
    expect(await control.stopThread({ chatId: "chat-1", threadId: "thread-unrelated", userId: "user-1" })).toBe(0);
    release();
    const started = await starting;
    await vi.waitFor(() => expect(runner.turns.get(started.kind === "started" ? started.turnId : "")).toBeDefined());
    await control.stopAll({ chatId: "chat-1", userId: "user-1" });
  });

  it("answers a stop within its bound when the runner's own stop never settles, and retires the Workspace", async () => {
    const store = new MemorySubagentStore();
    store.callers.add("parent-run");
    const hung = new FakeSubagentRunner();
    hung.stop = () => new Promise(() => undefined);
    const workspace = new FakeWorkspaceAttachments();
    const detach = vi.spyOn(workspace, "detach");
    const control = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink(), runner: hung, stopWaitMs: 20, store,
      usageLimits: unlimited, workspace });
    const started = await control.start(startInput("hung"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(hung.turns.get(turnId)).toBeDefined());
    expect(await workspace.attached({ chatId: "chat-1", userId: "user-1" })).toHaveLength(1);
    expect(await control.stop({ chatId: "chat-1", name: "hung", parentRunId: "parent-run", parentToolCallId: "s", userId: "user-1" }))
      .toMatchObject({ kind: "stopped", result: { state: "stopped" } });
    // Its guest authority went with the stop, its execution state unknown, before the turn settled on record.
    expect(detach).toHaveBeenCalledWith(expect.objectContaining({ execution: "unknown", modelRunId: store.turns[0]!.runId }));
    expect(await workspace.attached({ chatId: "chat-1", userId: "user-1" })).toEqual([]);
    expect(store.turns[0]).toMatchObject({ state: "stopped" });
  });

  it("never lets a launch still attaching keep the Workspace after a stop retired it", async () => {
    const store = new MemorySubagentStore();
    store.callers.add("parent-run");
    const runner = new FakeSubagentRunner();
    const inner = new FakeWorkspaceAttachments();
    let release: () => void = () => undefined;
    const slowAttach: WorkspaceAttachments = {
      attach: async (attachment, signal) => {
        await new Promise<void>((resolve) => { release = resolve; });
        return inner.attach(attachment, signal);
      },
      attached: (scope) => inner.attached(scope),
      detach: (input) => inner.detach(input),
      exclusive: (scope, work) => inner.exclusive(scope, work)
    };
    const control = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink(), runner, stopWaitMs: 20, store,
      usageLimits: unlimited, workspace: slowAttach });
    const started = await control.start(startInput("attaching"));
    const turnId = started.kind === "started" ? started.turnId : "";
    expect(await control.stopAll({ chatId: "chat-1", userId: "user-1" })).toBe(1);
    release();
    await vi.waitFor(() => expect(localSubagentTurnIds()).not.toContain(turnId));
    expect(await inner.attached({ chatId: "chat-1", userId: "user-1" })).toEqual([]);
    expect(runner.turns.size).toBe(0);
  });

  it("never stamps a message delivered that no execution here will read", async () => {
    const { control, store } = setup();
    store.turns.push({ callbackRunId: null, chatId: "chat-1", endedAt: null, mailbox: [], mode: "background", modelId: "m", name: "cut",
      parentAnswerId: "answer-1", parentRunId: "parent-run", result: null, runActive: true, runId: "cut-run", state: "running",
      threadId: "thread-cut", turnId: "cut-turn", userId: "user-1" });
    expect(await control.deliver({ chatId: "chat-1", message: { nonce: "m1", origin: "main_agent", text: "Hello" }, name: "cut",
      parentRunId: "parent-run", parentToolCallId: "c", threadId: "thread-cut", userId: "user-1" })).toEqual({ kind: "delivered", state: "running" });
    expect(store.turns[0]!.mailbox).toEqual([{ delivered: false, nonce: "m1", text: "Hello" }]);
  });

  it("settles a turn its runner does not stop in time as stopped on record, and counts only turns that ended", async () => {
    const store = new MemorySubagentStore();
    store.callers.add("parent-run");
    const stuck = new FakeSubagentRunner();
    // A wedged runner: it neither honours Stop nor the signal.
    stuck.stop = async () => null;
    const sink = new FakeSubagentCallbackSink();
    const control = createSubagentBackgroundControl({ callbacks: sink, runner: stuck, stopWaitMs: 20, store, usageLimits: unlimited });
    const started = await control.start(startInput("wedged"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(stuck.turns.get(turnId)).toBeDefined());
    expect(await control.stop({ chatId: "chat-1", name: "wedged", parentRunId: "parent-run", parentToolCallId: "s", userId: "user-1" }))
      .toMatchObject({ kind: "stopped", result: { reason: "stop_subagent", state: "stopped" } });
    expect(store.turns[0]).toMatchObject({ state: "stopped" });
    // Its execution ends later; the record and the single callback stand.
    stuck.finish(turnId, endedSubagentResult("wedged", { report: "late" }));
    await vi.waitFor(() => expect(localSubagentTurnIds()).not.toContain(turnId));
    expect(store.turns[0]).toMatchObject({ result: { report: "" }, state: "stopped" });
    expect(sink.callbacks).toHaveLength(1);
  });
});
