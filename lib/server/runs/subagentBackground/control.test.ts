import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_FOLLOWUP_LIMITS } from "@/lib/contracts/subagents";
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
    expect(turn.input).not.toHaveProperty("workspaceRefused");
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

  it("ends a run its shared Workspace stopped under as interrupted, and names only the runs it owns", async () => {
    const { control, runner, sink, store } = setup();
    const started = await control.start(startInput("browser"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    const runId = store.turns[0]!.runId!;
    expect(control.interruptRuns({ chatId: "chat-1", runIds: [runId, "main-run"], userId: "user-1" })).toEqual([runId]);
    expect(control.interruptRuns({ chatId: "other-chat", runIds: [runId], userId: "user-1" })).toEqual([]);
    await vi.waitFor(() => expect(sink.callbacks).toHaveLength(1));
    expect(sink.callbacks[0]!.result).toMatchObject({ reason: "restart", state: "interrupted" });
    expect(store.turns[0]).toMatchObject({ runActive: false, state: "interrupted" });
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
    // The sub-agent reads it at its next round: the runner received it, and only reading stamps it (`SubagentHost.mailbox`).
    expect(runner!.turns.get(turnId)!.messages).toEqual([message.message]);
    expect(store.turns[0]!.mailbox).toEqual([{ delivered: false, nonce: "call-2", text: "Also check prices" }]);
    for (let index = 1; index < 32; index += 1) await control.deliver({ ...message, message: { ...message.message, nonce: `n-${index}` } });
    await expect(control.deliver({ ...message, message: { ...message.message, nonce: "n-33" } })).rejects.toBeInstanceOf(SubagentMailboxFullError);
    runner!.finish(turnId, endedSubagentResult("researcher"));
    await vi.waitFor(() => expect(store.turns[0]!.state).toBe("done"));
    expect(await control.deliver({ ...message, message: { ...message.message, nonce: "late" } }))
      .toMatchObject({ kind: "ended", result: { name: "researcher", state: "done" } });
  });

  it.each(["background", "foreground"] as const)("delivers direct user speech durably to a %s turn", async (mode) => {
    const { control, runner, store } = setup();
    const started = await control.start(startInput("researcher"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    if (mode === "foreground") store.turns[0] = { ...store.turns[0]!, mode, runId: null };
    const input = { chatId: "chat-1", userId: "user-1", threadId: "thread-researcher", turnId, nonce: "direct-1", text: "Buy this one." };
    expect(await control.deliverUser(input)).toEqual({ kind: "delivered", state: "running" });
    expect(await control.deliverUser(input)).toEqual({ kind: "delivered", state: "running" });
    expect(runner!.turns.get(turnId)!.messages).toEqual([{ nonce: "user:direct-1", origin: "user", text: input.text }]);
    expect(store.turns[0]!.mailbox).toMatchObject([{ delivered: false, origin: "user", nonce: "user:direct-1" }]);
    expect(await control.deliverUser({ ...input, userId: "other" })).toEqual({ kind: "not_found" });
    for (let index = 1; index < SUBAGENT_FOLLOWUP_LIMITS.messagesPerRun; index += 1) await control.deliverUser({ ...input, nonce: `n-${index}` });
    await expect(control.deliverUser({ ...input, nonce: "over-limit" })).rejects.toBeInstanceOf(SubagentMailboxFullError);
    // Restore the admitted mode so the test's background execution can settle and release its lease.
    store.turns[0] = { ...store.turns[0]!, mode: "background" };
    await control.stopAll({ chatId: "chat-1", userId: "user-1" });
    expect(await control.deliverUser({ ...input, nonce: "late" })).toMatchObject({ kind: "ended" });
  });

  it("confirms a stored user message even when the turn ends before its notification arrives", async () => {
    const { control, runner, store } = setup();
    const started = await control.start(startInput("researcher"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
    vi.spyOn(runner!, "deliver").mockResolvedValueOnce({ kind: "ended", result: endedSubagentResult("researcher") });
    expect(await control.deliverUser({ chatId: "chat-1", userId: "user-1", threadId: "thread-researcher", turnId,
      nonce: "receipt", text: "A late clarification" })).toEqual({ kind: "delivered", state: "running" });
    expect(store.turns[0]!.mailbox).toMatchObject([{ delivered: false, origin: "user" }]);
    await control.stopAll({ chatId: "chat-1", userId: "user-1" });
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

  it("runs a turn its Workspace refuses unattached, naming the refusal so it goes without the Workspace tools", async () => {
    const store = new MemorySubagentStore();
    store.callers.add("parent-run");
    const runner = new FakeSubagentRunner();
    const workspace = new FakeWorkspaceAttachments({ refuseAttach: "workspace_busy" });
    const detach = vi.spyOn(workspace, "detach");
    const control = createSubagentBackgroundControl({ callbacks: new FakeSubagentCallbackSink(), runner, store, usageLimits: unlimited, workspace });
    const started = await control.start(startInput("nows"));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(runner.turns.get(turnId)).toBeDefined());
    expect(runner.turns.get(turnId)!.input.workspaceRefused).toBe("workspace_busy");
    // It never held the Workspace, so its end retires nothing there.
    runner.finish(turnId, endedSubagentResult("nows", { report: "Three sources" }));
    await vi.waitFor(() => expect(store.turns[0]).toMatchObject({ runActive: false, state: "done" }));
    expect(detach).not.toHaveBeenCalled();
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
    expect(runner!.turns.size).toBe(0);
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
      expect(runner!.turns.size).toBe(0);
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
    await vi.waitFor(() => expect(runner!.turns.get(started.kind === "started" ? started.turnId : "")).toBeDefined());
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
      attach: async (attachment) => {
        await new Promise<void>((resolve) => { release = resolve; });
        return inner.attach(attachment);
      },
      attached: (scope) => inner.attached(scope),
      detach: (input) => inner.detach(input),
      exclusive: (scope, work) => inner.exclusive(scope, work),
      fence: (input) => inner.fence(input)
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

  describe("what one agent writes another", () => {
    const send = { chatId: "chat-1", from: "scout", nonce: "m-1", parentRunId: "parent-run", text: "It costs 42", to: "researcher", userId: "user-1" };

    it("reaches a running turn's mailbox, foreground or background, and a wait hears of it at once", async () => {
      const { control, runner, store } = setup();
      const started = await control.start(startInput("researcher"));
      const turnId = started.kind === "started" ? started.turnId : "";
      await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
      expect(await control.send(send)).toEqual({ kind: "delivered" });
      expect(runner!.turns.get(turnId)!.messages).toEqual([{ from: "scout", nonce: "m-1", origin: "subagent_message", text: "It costs 42" }]);
      expect(store.turns[0]!.mailbox).toEqual([{ delivered: false, from: "scout", nonce: "m-1", origin: "subagent_message", text: "It costs 42" }]);

      store.turns.push({ ...store.turns[0]!, mailbox: [], mode: "foreground", name: "front", runActive: false, runId: null, threadId: "thread-front",
        turnId: "turn-front" });
      await runner!.start({ ...runner!.turns.get(turnId)!.input, name: "front", threadId: "thread-front", turnId: "turn-front" });
      expect(await control.send({ ...send, nonce: "m-2", to: "front" })).toEqual({ kind: "delivered" });
      expect(store.turns[1]!.mailbox).toMatchObject([{ from: "scout", nonce: "m-2" }]);
      await control.stopAll({ chatId: "chat-1", userId: "user-1" });
    });

    it("stops a ping-pong at its bound with a visible code, leaving the main agent's messages their own room", async () => {
      const { control, runner, store } = setup();
      const started = await control.start(startInput("researcher"));
      const turnId = started.kind === "started" ? started.turnId : "";
      await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
      for (let index = 0; index < SUBAGENT_FOLLOWUP_LIMITS.agentMessagesPerTurn; index += 1) {
        expect(await control.send({ ...send, nonce: `m-${index}` })).toEqual({ kind: "delivered" });
      }
      expect(await control.send({ ...send, nonce: "one-more" })).toEqual({ code: "subagent_message_limit_reached", kind: "refused" });
      expect(store.turns[0]!.mailbox).toHaveLength(SUBAGENT_FOLLOWUP_LIMITS.agentMessagesPerTurn);
      expect(await control.deliver({ chatId: "chat-1", message: { nonce: "main", origin: "main_agent", text: "Hold on" }, name: "researcher",
        parentRunId: "parent-run", parentToolCallId: "c", threadId: "thread-researcher", userId: "user-1" })).toEqual({ kind: "delivered", state: "running" });
      await control.stopAll({ chatId: "chat-1", userId: "user-1" });
    });

    it("refuses a name it cannot reach, and one that ended says how", async () => {
      const { control, runner } = setup();
      expect(await control.send({ ...send, to: "nobody" })).toEqual({ code: "subagent_not_found", kind: "refused" });
      const started = await control.start(startInput("researcher"));
      const turnId = started.kind === "started" ? started.turnId : "";
      await vi.waitFor(() => expect(runner!.turns.get(turnId)).toBeDefined());
      runner!.finish(turnId, endedSubagentResult("researcher"));
      await vi.waitFor(async () => expect(await control.send(send)).toEqual({ code: "subagent_not_active", kind: "refused", state: "done" }));
    });

    it("goes into the main agent's running answer, and refuses when none can read it", async () => {
      const { control, store } = setup();
      const main = { ...send, to: "main" };
      expect(await control.send(main)).toEqual({ code: "subagent_not_active", kind: "refused" });
      store.mainRuns.push({ callbacks: [], chatId: "chat-1", open: true, runId: "main-1", status: "streaming" });
      expect(await control.send(main)).toEqual({ kind: "delivered" });
      expect(store.mainMessages).toEqual([{ from: "scout", nonce: "m-1", text: "It costs 42" }]);
      store.mainMessages.push(...Array.from({ length: SUBAGENT_FOLLOWUP_LIMITS.callbacksPerRun }, () => ({ from: "scout", nonce: "x", text: "x" })));
      expect(await control.send({ ...main, nonce: "m-2" })).toEqual({ code: "subagent_message_limit_reached", kind: "refused" });
    });

    it("sends an asked question out without holding the asker", () => {
      const { control, sink } = setup();
      control.questionAsked({ chatId: "chat-1", userId: "user-1" });
      expect(sink.flushes).toEqual([{ chatId: "chat-1", userId: "user-1" }]);
    });
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

describe("a sub-agent's background children", () => {
  const parentAgent = { name: "research", runId: "parent-bg-run", threadId: "thread-research", toolState: { calls: 0 }, turnId: "turn-research" };
  const childInput = (name: string, overrides: Partial<SubagentBackgroundStartInput> = {}) => startInput(name, { parentAgent, ...overrides });

  /** The parent sub-agent, active: where a child's report lands. */
  function withParent() {
    const ctx = setup();
    ctx.store.callers.add("parent-bg-run");
    ctx.store.turns.push({ callbackRunId: null, chatId: "chat-1", endedAt: null, mailbox: [], mode: "background", modelId: "fake-model", name: "research",
      parentAnswerId: "answer-1", parentRunId: "parent-run", result: null, runActive: true, runId: "parent-bg-run", state: "running",
      threadId: "thread-research", turnId: "turn-research", userId: "user-1" });
    return ctx;
  }

  async function child(ctx: ReturnType<typeof setup>, name: string, overrides: Partial<SubagentBackgroundStartInput> = {}) {
    const started = await ctx.control.start(childInput(name, overrides));
    const turnId = started.kind === "started" ? started.turnId : "";
    await vi.waitFor(() => expect(ctx.runner!.turns.get(turnId)).toBeDefined());
    return turnId;
  }

  it("runs under its parent's own run and name, and ends by its parent's time", async () => {
    const ctx = withParent();
    const deadlineAt = new Date(Date.now() + 5_000);
    const turnId = await child(ctx, "helper", { deadlineAt });
    const turn = ctx.store.turns.find((entry) => entry.turnId === turnId)!;
    expect(turn).toMatchObject({ parentRunId: "parent-bg-run", parentThreadId: "thread-research" });
    expect(ctx.runner!.turns.get(turnId)!.input).toMatchObject({ parentAgent, parentRunId: "parent-run" });
    const left = ctx.runner!.turns.get(turnId)!.input.deadlineAt.getTime() - Date.now();
    expect(left).toBeLessThanOrEqual(5_000);
    expect(left).toBeGreaterThan(4_000);
    await ctx.control.stopAll({ chatId: "chat-1", userId: "user-1" });
  });

  it("asks only whether its parent may start one", async () => {
    const ctx = setup();
    ctx.store.callers.clear();
    expect(await ctx.control.start(childInput("helper"))).toEqual({ code: "subagent_background_unavailable", kind: "refused" });
    ctx.store.callers.add("parent-bg-run");
    expect(await ctx.control.availability({ chatId: "chat-1", parentAgent, parentRunId: "ended-main-run", parentToolCallId: "c", userId: "user-1" }))
      .toEqual({ available: true });
  });

  it("refuses a third at once, across the store's lock", async () => {
    const ctx = withParent();
    await child(ctx, "one");
    await child(ctx, "two");
    expect(await ctx.control.start(childInput("three"))).toEqual({ code: "subagent_child_limit_reached", kind: "refused" });
    await ctx.control.stopAll({ chatId: "chat-1", userId: "user-1" });
  });

  it("reports to its parent's mailbox and owes the main agent nothing", async () => {
    const ctx = withParent();
    const turnId = await child(ctx, "helper");
    ctx.runner!.finish(turnId, endedSubagentResult("helper", { report: "Three offers" }));
    const parent = ctx.store.turns.find((entry) => entry.turnId === "turn-research")!;
    await vi.waitFor(() => expect(parent.mailbox).toHaveLength(1));
    expect(parent.mailbox[0]).toMatchObject({ from: "helper", nonce: `subagent-callback:${turnId}`, origin: "subagent_callback" });
    expect(parent.mailbox[0]!.text).toContain("Three offers");
    expect(ctx.runner!.turns.get("turn-research")).toBeUndefined();
    expect(ctx.sink.callbacks).toEqual([]);
    expect((await ctx.store.owedCallbacks({ chatId: "chat-1", userId: "user-1" }))?.activeBranch).toEqual([]);
  });

  it("delivers its report past the bound on agents' messages: it is what its parent waits for", async () => {
    const ctx = withParent();
    const parent = ctx.store.turns.find((entry) => entry.turnId === "turn-research")!;
    parent.mailbox.push(...Array.from({ length: SUBAGENT_FOLLOWUP_LIMITS.agentMessagesPerTurn }, (_, index) => ({ delivered: false, from: "a",
      nonce: `n-${index}`, origin: "subagent_message" as const, text: "x" })));
    const turnId = await child(ctx, "helper");
    ctx.runner!.finish(turnId, endedSubagentResult("helper"));
    await vi.waitFor(() => expect(parent.mailbox.some((entry) => entry.origin === "subagent_callback")).toBe(true));
  });

  it("finds its parent gone without error: its result stays on its turn", async () => {
    const ctx = withParent();
    const turnId = await child(ctx, "helper");
    ctx.store.turns.find((entry) => entry.turnId === "turn-research")!.state = "done";
    ctx.runner!.finish(turnId, endedSubagentResult("helper", { report: "Late" }));
    await vi.waitFor(() => expect(ctx.store.turns.find((entry) => entry.turnId === turnId)!.state).toBe("done"));
    expect(ctx.sink.callbacks).toEqual([]);
    expect(ctx.store.turns.find((entry) => entry.turnId === "turn-research")!.mailbox).toEqual([]);
  });

  it("ends with its parent, whatever mode it runs in, and reports nothing to a parent that ended it", async () => {
    const ctx = withParent();
    const one = await child(ctx, "one");
    const two = await child(ctx, "two");
    const other = await ctx.control.start(startInput("neighbour"));
    expect(await ctx.control.stopChildren({ chatId: "chat-1", threadId: "thread-research", userId: "user-1" })).toBe(2);
    for (const turnId of [one, two]) {
      expect(ctx.store.turns.find((entry) => entry.turnId === turnId)).toMatchObject({ result: { reason: "parent_stopped", state: "stopped" }, state: "stopped" });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ctx.store.turns.find((entry) => entry.turnId === "turn-research")!.mailbox).toEqual([]);
    expect(ctx.store.turns.find((entry) => entry.name === "neighbour")).toMatchObject({ state: "running" });
    expect(other).toMatchObject({ kind: "started" });
    await ctx.control.stopAll({ chatId: "chat-1", userId: "user-1" });
  });

  it("stops one still being admitted when its parent ends, so it never runs", async () => {
    const ctx = withParent();
    let release!: () => void;
    ctx.store.admitBeforeGate = () => new Promise<void>((resolve) => { release = resolve; });
    const starting = ctx.control.start(childInput("late"));
    await vi.waitFor(() => expect(release).toBeDefined());
    const stopped = ctx.control.stopChildren({ chatId: "chat-1", threadId: "thread-research", userId: "user-1" });
    ctx.store.admitBeforeGate = null;
    release();
    await starting;
    await stopped;
    await vi.waitFor(() => expect(ctx.store.turns.find((entry) => entry.name === "late")).toMatchObject({ state: "stopped" }));
    expect([...ctx.runner!.turns.values()].filter((turn) => turn.input.name === "late")).toEqual([]);
  });

  it("carries a child's question to its parent's mailbox as a question, and refuses it once its parent ended", async () => {
    const ctx = withParent();
    await child(ctx, "helper");
    const question = { chatId: "chat-1", from: "helper", nonce: "subagent-question:call-1", parentRunId: "parent-run", question: true as const, text: "Which size?",
      to: "research", userId: "user-1" };
    expect(await ctx.control.send(question)).toEqual({ kind: "delivered" });
    const parent = ctx.store.turns.find((entry) => entry.turnId === "turn-research")!;
    expect(parent.mailbox).toMatchObject([{ from: "helper", origin: "subagent_question", text: "Which size?" }]);
    parent.state = "done";
    parent.runActive = false;
    parent.result = endedSubagentResult("research");
    expect(await ctx.control.send({ ...question, nonce: "subagent-question:call-2" })).toEqual({ code: "subagent_not_active", kind: "refused", state: "done" });
    await ctx.control.stopAll({ chatId: "chat-1", userId: "user-1" });
  });
});
