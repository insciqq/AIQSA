import { describe, expect, it, vi } from "vitest";
import { endedSubagentResult } from "@/tests/support/subagentPorts";
import { MemorySubagentStore } from "@/tests/support/subagentBackgroundStore";
import { createSubagentCallbacks, type SubagentWakeUpAdmitter, type SubagentWakeUpOutcome } from "./callbacks";

const scope = { chatId: "chat-1", userId: "user-1" };

function setup(outcomes: SubagentWakeUpOutcome[] = []) {
  const store = new MemorySubagentStore();
  const wakeUps: Array<Readonly<{ text: string; turnIds: readonly string[] }>> = [];
  const admitWakeUp: SubagentWakeUpAdmitter = vi.fn(async (input) => {
    const outcome = outcomes.shift() ?? "admitted";
    if (outcome === "admitted") {
      // The admission claims what it renders, and its run is then the chat's running answer.
      expect(store.claim(`wake-${wakeUps.length + 1}`, input.turnIds)).toBe(true);
      wakeUps.push({ text: input.text, turnIds: input.turnIds });
      store.mainRuns.push({ callbacks: [], chatId: input.chatId, open: true, runId: `wake-${wakeUps.length}`, status: "streaming" });
    }
    return outcome;
  });
  const callbacks = createSubagentCallbacks({ admitWakeUp, coalesceMs: 5, store });
  return { admitWakeUp, callbacks, store, wakeUps };
}

const callbackOf = (turn: Readonly<{ name: string; result: ReturnType<typeof endedSubagentResult>; threadId: string; turnId: string }>) =>
  ({ ...scope, name: turn.name, parentRunId: "parent-run", result: turn.result, threadId: turn.threadId, turnId: turn.turnId });

describe("background sub-agent callbacks", () => {
  it("goes into the running main answer as a callback follow-up, claimed once", async () => {
    const { admitWakeUp, callbacks, store } = setup();
    store.mainRuns.push({ callbacks: [], chatId: scope.chatId, open: true, runId: "main-1", status: "streaming" });
    const turn = store.addEnded({ ...scope, name: "researcher", result: endedSubagentResult("researcher", { report: "done" }) });
    expect(await callbacks.sink.deliver(callbackOf(turn))).toBe("delivered");
    // A second delivery attempt (the terminal flush, recovery) finds it claimed and adds nothing.
    expect(await callbacks.sink.deliver(callbackOf(turn))).toBe("delivered");
    expect(store.mainRuns[0]!.callbacks).toHaveLength(1);
    expect(store.mainRuns[0]!.callbacks[0]!.text).toContain("\"researcher\" ended");
    expect(admitWakeUp).not.toHaveBeenCalled();
  });

  it("waits for a running answer that already closed: the callback stays owed for its terminal flush", async () => {
    const { callbacks, store, wakeUps } = setup();
    store.mainRuns.push({ callbacks: [], chatId: scope.chatId, open: false, runId: "main-1", status: "streaming" });
    const turn = store.addEnded({ ...scope, name: "a", result: endedSubagentResult("a") });
    expect(await callbacks.sink.deliver(callbackOf(turn))).toBe("after_run");
    expect(turn.callbackRunId).toBeNull();
    // The answer ends: its terminal flush wakes the main agent with the callback.
    store.mainRuns[0]!.status = "complete";
    callbacks.mainRunEnded(scope);
    await vi.waitFor(() => expect(wakeUps).toHaveLength(1));
    expect(wakeUps[0]!.turnIds).toEqual([turn.turnId]);
  });

  it("wakes nothing when the user stops the main answer, yet a callback after the stop wakes the idle main agent", async () => {
    const { admitWakeUp, callbacks, store, wakeUps } = setup();
    store.mainRuns.push({ callbacks: [], chatId: scope.chatId, open: true, runId: "main-1", status: "streaming" });
    // The user's Stop: the run ends cancelled and nothing calls the terminal flush.
    store.mainRuns[0]!.status = "complete";
    store.mainRuns[0]!.open = false;
    expect(admitWakeUp).not.toHaveBeenCalled();
    const later = store.addEnded({ ...scope, name: "late", result: endedSubagentResult("late") });
    expect(await callbacks.sink.deliver(callbackOf(later))).toBe("wake_up");
    expect(wakeUps[0]!.turnIds).toEqual([later.turnId]);
  });

  it("coalesces callbacks that end close together into one wake-up turn", async () => {
    const { admitWakeUp, callbacks, store, wakeUps } = setup();
    const turns = ["one", "two", "three"].map((name) => store.addEnded({ ...scope, name, result: endedSubagentResult(name) }));
    const dispositions = await Promise.all(turns.map((turn) => callbacks.sink.deliver(callbackOf(turn))));
    expect(dispositions).toEqual(["wake_up", "wake_up", "wake_up"]);
    expect(admitWakeUp).toHaveBeenCalledTimes(1);
    expect(wakeUps[0]!.turnIds).toEqual(turns.map((turn) => turn.turnId));
    expect(wakeUps[0]!.text).toContain("\"two\"");
  });

  it("keeps callbacks owed when usage limits refuse the wake-up, and delivers them with the next main-agent turn", async () => {
    const { callbacks, store } = setup(["usage_limited"]);
    const turn = store.addEnded({ ...scope, name: "a", result: endedSubagentResult("a") });
    expect(await callbacks.sink.deliver(callbackOf(turn))).toBe("pending");
    expect(turn.callbackRunId).toBeNull();
    // The user writes: the new answer's admission flushes the owed callback into it.
    store.mainRuns.push({ callbacks: [], chatId: scope.chatId, open: true, runId: "main-2", status: "streaming" });
    const report = await callbacks.flush(scope);
    expect(report.dispositions.get(turn.turnId)).toBe("delivered");
    expect(turn.callbackRunId).toBe("main-2");
  });

  it("delivers into the user's answer when it started before the wake-up was admitted", async () => {
    const { callbacks, store } = setup(["busy"]);
    const turn = store.addEnded({ ...scope, name: "a", result: endedSubagentResult("a") });
    const original = store.owedCallbacks.bind(store);
    let reads = 0;
    vi.spyOn(store, "owedCallbacks").mockImplementation(async (input) => {
      reads += 1;
      if (reads === 2) store.mainRuns.push({ callbacks: [], chatId: scope.chatId, open: true, runId: "main-3", status: "streaming" });
      return original(input);
    });
    expect(await callbacks.sink.deliver(callbackOf(turn))).toBe("delivered");
    expect(turn.callbackRunId).toBe("main-3");
  });

  it("records a callback of a branch that is no longer active and wakes nothing", async () => {
    const { admitWakeUp, callbacks, store } = setup();
    const turn = store.addEnded({ ...scope, name: "old", parentAnswerId: "answer-old", result: endedSubagentResult("old") });
    store.inactiveAnswers.add("answer-old");
    expect(await callbacks.sink.deliver(callbackOf(turn))).toBe("inactive_branch");
    expect(turn.callbackRunId).toBeNull();
    expect(admitWakeUp).not.toHaveBeenCalled();
  });

  it("wakes nothing in a chat being deleted", async () => {
    const { admitWakeUp, callbacks, store } = setup();
    const turn = store.addEnded({ ...scope, name: "a", result: endedSubagentResult("a") });
    store.goneChats.add(scope.chatId);
    expect(await callbacks.sink.deliver(callbackOf(turn))).toBe("inactive_branch");
    expect(admitWakeUp).not.toHaveBeenCalled();
  });
});
