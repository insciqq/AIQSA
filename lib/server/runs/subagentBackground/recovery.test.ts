import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_END_REASONS } from "@/lib/contracts/subagents";
import { FakeWorkspaceAttachments, endedSubagentResult } from "@/tests/support/subagentPorts";
import { MemorySubagentStore } from "@/tests/support/subagentBackgroundStore";
import { createSubagentCallbacks, type SubagentWakeUpOutcome } from "./callbacks";
import { reconcileSubagentRuns, SUBAGENT_RECOVERY_RETIRE_ATTEMPTS } from "./recovery";

function orphan(store: MemorySubagentStore, chatId: string, name: string) {
  const id = `${chatId}-${name}`;
  store.turns.push({ callbackRunId: null, chatId, endedAt: null, mailbox: [], mode: "background", modelId: "m", name,
    parentAnswerId: "answer-1", parentRunId: "parent-run", result: null, runActive: true, runId: `run-${id}`, state: "running",
    threadId: `thread-${id}`, turnId: `turn-${id}`, userId: "user-1" });
  store.orphans.push({ chatId, runId: `run-${id}`, turnId: `turn-${id}`, userId: "user-1" });
}

describe("background sub-agent recovery", () => {
  it("ends every cut-off run interrupted and wakes each chat at most once, listing every interruption", async () => {
    const store = new MemorySubagentStore();
    orphan(store, "chat-a", "one");
    orphan(store, "chat-a", "two");
    orphan(store, "chat-b", "three");
    const wakeUps: Array<Readonly<{ chatId: string; turnIds: readonly string[] }>> = [];
    const callbacks = createSubagentCallbacks({ coalesceMs: 5, store, admitWakeUp: async (input) => {
      store.claim(`wake-${input.chatId}`, input.turnIds);
      wakeUps.push({ chatId: input.chatId, turnIds: input.turnIds });
      return "admitted";
    } });
    const workspace = new FakeWorkspaceAttachments();
    const detach = vi.spyOn(workspace, "detach");
    const settled = await reconcileSubagentRuns({ backoff: new Map(), bootedAt: new Date(), deferred: new Map(), flush: callbacks.flush,
      liveRunIds: () => ["run-chat-b-three"], staleMs: 60_000, store, workspace });
    // A run executing here keeps its execution.
    expect(settled).toBe(2);
    expect(store.turns.map((turn) => turn.state)).toEqual(["interrupted", "interrupted", "running"]);
    expect(store.turns[0]!.result).toMatchObject({ name: "one", reason: "restart", state: "interrupted" });
    expect(detach).toHaveBeenCalledWith(expect.objectContaining({ execution: "unknown", modelRunId: "run-chat-a-one" }));
    await vi.waitFor(() => expect(wakeUps).toHaveLength(1));
    expect(wakeUps[0]).toEqual({ chatId: "chat-a", turnIds: ["turn-chat-a-one", "turn-chat-a-two"] });
    expect(store.strandedInterrupts).toBe(1);
  });

  it("keeps a cut-off run whose Workspace authority could not be retired for the next pass, then settles it and owes its callback", async () => {
    const store = new MemorySubagentStore();
    orphan(store, "chat-w", "browser");
    const workspace = new FakeWorkspaceAttachments();
    await workspace.attach({ agent: { kind: "subagent", name: "browser", threadId: "thread-chat-w-browser" }, chatId: "chat-w",
      modelRunId: "run-chat-w-browser", userId: "user-1" });
    const wakeUps: string[][] = [];
    const callbacks = createSubagentCallbacks({ coalesceMs: 1, recheckMs: [], store, admitWakeUp: async (input) => {
      store.claim("wake", input.turnIds);
      wakeUps.push([...input.turnIds]);
      return "admitted";
    } });
    const retireFailures = new Map<string, number>();
    const pass = () => reconcileSubagentRuns({ backoff: new Map(), bootedAt: new Date(), deferred: new Map(), flush: callbacks.flush,
      liveRunIds: () => [], retireFailures, staleMs: 60_000, store, workspace }, { chatId: "chat-w" });
    // The runner cannot be reached: nothing is settled, and the run keeps its attachment for the next pass.
    const detach = vi.spyOn(workspace, "detach").mockRejectedValueOnce(new Error("runner_unreachable"));
    expect(await pass()).toBe(0);
    expect(store.turns[0]).toMatchObject({ callbackRunId: null, runActive: true, state: "running" });
    expect(retireFailures.get("run-chat-w-browser")).toBe(1);
    // A detach that answers but leaves the run attached (its stop not proven) proves nothing either.
    detach.mockResolvedValueOnce({ interruptedRunIds: [], kind: "detached", remainingRuns: 1 });
    expect(await pass()).toBe(0);
    expect(retireFailures.get("run-chat-w-browser")).toBe(2);
    // The next pass retires it: the turn ends interrupted, its attachment is gone and its callback wakes the main agent.
    expect(await pass()).toBe(1);
    expect(store.turns[0]).toMatchObject({ runActive: false, state: "interrupted" });
    expect(await workspace.attached({ chatId: "chat-w", userId: "user-1" })).toEqual([]);
    expect(retireFailures.size).toBe(0);
    await vi.waitFor(() => expect(wakeUps).toEqual([["turn-chat-w-browser"]]));
  });

  it("settles a cut-off run after the bound of passes that could not retire its Workspace authority", async () => {
    const store = new MemorySubagentStore();
    orphan(store, "chat-x", "stuck");
    const workspace = new FakeWorkspaceAttachments();
    vi.spyOn(workspace, "detach").mockRejectedValue(new Error("runner_unreachable"));
    const callbacks = createSubagentCallbacks({ coalesceMs: 1, recheckMs: [], store, admitWakeUp: async () => "usage_limited" });
    const retireFailures = new Map<string, number>();
    let settled = 0;
    for (let pass = 0; pass < SUBAGENT_RECOVERY_RETIRE_ATTEMPTS; pass += 1) {
      settled += await reconcileSubagentRuns({ backoff: new Map(), bootedAt: new Date(), deferred: new Map(), flush: callbacks.flush,
        liveRunIds: () => [], retireFailures, staleMs: 60_000, store, workspace }, { chatId: "chat-x" });
    }
    expect(settled).toBe(1);
    // Settled behind a fenced Workspace: its result says why, the callback is owed, and the chat's Workspace refuses joins.
    expect(store.turns[0]).toMatchObject({ callbackRunId: null, result: { reason: SUBAGENT_END_REASONS.workspaceStopUnproven },
      state: "interrupted" });
    expect(workspace.fenced.has("chat-x")).toBe(true);
    expect(await workspace.attach({ agent: { kind: "main" }, chatId: "chat-x", modelRunId: "run-next", userId: "user-1" }))
      .toMatchObject({ kind: "refused" });
  });

  it("keeps a cut-off run past the bound unsettled while its Workspace cannot be fenced", async () => {
    const store = new MemorySubagentStore();
    orphan(store, "chat-y", "stuck");
    const workspace = new FakeWorkspaceAttachments();
    vi.spyOn(workspace, "detach").mockRejectedValue(new Error("runner_unreachable"));
    const fence = vi.spyOn(workspace, "fence").mockRejectedValueOnce(new Error("database_unavailable"));
    const callbacks = createSubagentCallbacks({ coalesceMs: 1, recheckMs: [], store, admitWakeUp: async () => "usage_limited" });
    const retireFailures = new Map<string, number>();
    const pass = () => reconcileSubagentRuns({ backoff: new Map(), bootedAt: new Date(), deferred: new Map(), flush: callbacks.flush,
      liveRunIds: () => [], retireFailures, staleMs: 60_000, store, workspace }, { chatId: "chat-y" });
    for (let index = 1; index < SUBAGENT_RECOVERY_RETIRE_ATTEMPTS; index += 1) expect(await pass()).toBe(0);
    expect(await pass()).toBe(0);
    expect(store.turns[0]?.state).not.toBe("interrupted");
    expect(await pass()).toBe(1);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(store.turns[0]).toMatchObject({ result: { reason: SUBAGENT_END_REASONS.workspaceStopUnproven }, state: "interrupted" });
  });

  it("flushes callbacks a restart or a failed flush left owed, and keeps a usage-limited wake-up deferred until a new callback", async () => {
    const store = new MemorySubagentStore();
    const scope = { chatId: "chat-c", userId: "user-1" };
    // Its run settled, then the process went down before the coalescing timer fired: nothing else will flush it.
    const early = store.addEnded({ ...scope, name: "early", result: endedSubagentResult("early") });
    const outcomes: SubagentWakeUpOutcome[] = ["usage_limited", "admitted"];
    const admitted: string[][] = [];
    const callbacks = createSubagentCallbacks({ coalesceMs: 1, store, admitWakeUp: async (input) => {
      const outcome = outcomes.shift() ?? "admitted";
      if (outcome === "admitted") {
        store.claim("wake", input.turnIds);
        admitted.push([...input.turnIds]);
      }
      return outcome;
    } });
    let failures = 1;
    const flush = vi.fn(async (input: typeof scope) => {
      if (failures-- > 0) throw new Error("database_unavailable");
      return callbacks.flush(input);
    });
    const deferred = new Map<string, ReadonlySet<string>>();
    const backoff = new Map<string, Readonly<{ failures: number; until: number }>>();
    let clock = 1_000_000;
    const pass = () => reconcileSubagentRuns({ backoff, bootedAt: new Date(0), deferred, flush, liveRunIds: () => [],
      now: () => new Date(clock), staleMs: 60_000, store });
    await pass();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    // The failed flush is retried once its backoff passed; usage limits refuse that wake-up.
    await pass();
    expect(flush).toHaveBeenCalledTimes(1);
    clock += 31_000;
    await pass();
    await vi.waitFor(() => expect(deferred.get("user-1:chat-c")).toEqual(new Set([early.turnId])));
    // While nothing new is owed, recovery leaves the refused callback for the next main-agent turn.
    await pass();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(admitted).toEqual([]);
    const next = store.addEnded({ ...scope, name: "next", result: endedSubagentResult("next") });
    await pass();
    await vi.waitFor(() => expect(admitted).toEqual([[early.turnId, next.turnId]]));
  });

  it("retries a wake-up that failed for a reason that may clear, with a doubling backoff, never forever deferred", async () => {
    const store = new MemorySubagentStore();
    const scope = { chatId: "chat-d", userId: "user-1" };
    const owed = store.addEnded({ ...scope, name: "owed", result: endedSubagentResult("owed") });
    // The chat was archived, then restored: the first two wake-ups fail, the third is admitted.
    const outcomes: SubagentWakeUpOutcome[] = ["failed", "failed", "admitted"];
    const admits: number[] = [];
    let clock = 5_000_000;
    const callbacks = createSubagentCallbacks({ coalesceMs: 1, store, admitWakeUp: async (input) => {
      admits.push(clock);
      const outcome = outcomes.shift() ?? "admitted";
      if (outcome === "admitted") store.claim("wake", input.turnIds);
      return outcome;
    } });
    const deferred = new Map<string, ReadonlySet<string>>();
    const backoff = new Map<string, Readonly<{ failures: number; until: number }>>();
    const pass = async () => {
      await reconcileSubagentRuns({ backoff, bootedAt: new Date(0), deferred, flush: callbacks.flush, liveRunIds: () => [],
        now: () => new Date(clock), staleMs: 60_000, store });
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await pass();
    expect(admits).toHaveLength(1);
    // Never memoized as a deliberate deferral, but not retried at once either.
    expect(deferred.has("user-1:chat-d")).toBe(false);
    clock += 10_000;
    await pass();
    expect(admits).toHaveLength(1);
    clock += 25_000;
    await pass();
    expect(admits).toHaveLength(2);
    // The second failure doubles the wait.
    clock += 35_000;
    await pass();
    expect(admits).toHaveLength(2);
    clock += 30_000;
    await pass();
    expect(admits).toHaveLength(3);
    expect(owed.callbackRunId).toBe("wake");
    expect(backoff.has("user-1:chat-d")).toBe(false);
  });
});
