import { describe, expect, it, vi } from "vitest";
import { FakeWorkspaceAttachments, endedSubagentResult } from "@/tests/support/subagentPorts";
import { MemorySubagentStore } from "@/tests/support/subagentBackgroundStore";
import { createSubagentCallbacks, type SubagentWakeUpOutcome } from "./callbacks";
import { reconcileSubagentRuns } from "./recovery";

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
