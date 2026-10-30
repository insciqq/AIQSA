import { describe, expect, it, vi } from "vitest";
import { backgroundSubagentRunner, registerSubagentBackgroundHost, withForegroundTurnStops } from "@/lib/server/engine/subagents/backgroundRunner";
import type { SubagentBinding } from "@/lib/server/subagents/ports";
import type { UsageLimitStatus } from "@/lib/server/usageLimits/repository";
import { MemorySubagentStore } from "@/tests/support/subagentBackgroundStore";
import { FakeSubagentRunner, FakeWorkspaceAttachments, endedSubagentResult } from "@/tests/support/subagentPorts";
import { createSubagentCallbacks, type SubagentWakeUpAdmitter } from "./callbacks";
import { createSubagentBackgroundControl } from "./control";

/**
 * The background composition as `default.ts` builds it, with the engine's real background runner and the real
 * callbacks over the in-memory store: a background turn that ends done wakes the main agent, also while the answer
 * that started it is published but its run still finishes its Workspace hand-off (the stand's shared Workspace).
 */

const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-model", modelSource: "parent", provider: "fake",
  providerModelId: "model-1", reasoningEffort: null };
const NO_LIMITS: UsageLimitStatus = {
  effective: { exempt: false, messagesPerDay: { source: null, value: null }, messagesPerHour: { source: null, value: null },
    monthlyBudgetMicros: { source: null, value: null } },
  installationCapMicros: null, installationSpentMicros: 0, lastDay: { count: 0, freesAt: null }, lastHour: { count: 0, freesAt: null },
  userSpentMicros: 0
};

function compose(parentRunId: string) {
  const store = new MemorySubagentStore();
  store.callers.add(parentRunId);
  const runner = new FakeSubagentRunner();
  // The parent run's host, as `prepareRunSubagents` registers it; the parent then ends.
  const host = registerSubagentBackgroundHost(parentRunId, () => runner);
  host.use();
  host.release();
  const wakeUps: Array<readonly string[]> = [];
  const admitWakeUp: SubagentWakeUpAdmitter = vi.fn(async (input) => {
    if (!store.claim(`wake-${wakeUps.length + 1}`, input.turnIds)) return "stale";
    wakeUps.push(input.turnIds);
    return "admitted";
  });
  const callbacks = createSubagentCallbacks({ admitWakeUp, coalesceMs: 5, recheckMs: [], store });
  const control = createSubagentBackgroundControl({ callbacks: callbacks.sink, runner: backgroundSubagentRunner, store,
    usageLimits: { loadUsageLimitStatus: async () => NO_LIMITS }, workspace: new FakeWorkspaceAttachments() });
  return { control, runner, store, wakeUps };
}

const start = (parentRunId: string, name: string) => ({ binding, brief: `Brief for ${name}`, chatId: "chat-1", kind: "start" as const,
  name, parentRunId, parentToolCallId: `call-${name}`, threadId: `thread-${name}`, type: null, userId: "user-1",
  userMessage: "Find the best" });

describe("background sub-agents composed as in production", () => {
  for (const answer of ["idle", "still finishing its hand-off"] as const) {
    it(`wakes the main agent when a background turn ends done, the answer that started it ${answer}`, async () => {
      const parentRunId = `parent-${answer.length}`;
      const { control, runner, store, wakeUps } = compose(parentRunId);
      if (answer !== "idle") store.mainRuns.push({ callbacks: [], chatId: "chat-1", open: false, runId: parentRunId, status: "streaming" });
      const started = await control.start(start(parentRunId, "alpha"));
      if (started.kind !== "started") throw new Error(started.code);
      await vi.waitFor(() => expect(runner.turns.has(started.turnId)).toBe(true));
      runner.finish(started.turnId, endedSubagentResult("alpha", { report: "Done." }));
      await vi.waitFor(() => expect(wakeUps).toEqual([[started.turnId]]));
      expect(store.turns[0]).toMatchObject({ callbackRunId: "wake-1", runActive: false, state: "done" });
    });
  }

  it("stops a foreground turn of a running answer from its thread and with Stop all, as it stops a background one", async () => {
    const { control, store } = compose("parent-fg");
    // The answer's own runner, as `prepareRunSubagents` wraps it: its foreground turns are reachable by id.
    const inner = new FakeSubagentRunner();
    const answer = withForegroundTurnStops(inner);
    const foreground = (name: string) => {
      const turnId = `turn-fg-${name}`;
      store.turns.push({ callbackRunId: null, chatId: "chat-1", endedAt: null, mailbox: [], mode: "foreground", modelId: "fake-model", name,
        parentAnswerId: "answer-1", parentRunId: "parent-fg", result: null, runActive: true, runId: null, state: "running",
        threadId: `thread-${name}`, turnId, userId: "user-1" });
      return answer.start({ binding, brief: `Brief for ${name}`, chatId: "chat-1", deadlineAt: new Date(Date.now() + 60_000),
        hostRunId: "parent-fg", mode: "foreground", name, parentRunId: "parent-fg", parentToolCallId: `call-${name}`,
        signal: new AbortController().signal, threadId: `thread-${name}`, turnId, type: null, userId: "user-1", userMessage: "Find it" });
    };
    const one = await foreground("reader");
    const waiting = answer.wait(one);
    expect(await control.stopThread({ chatId: "chat-1", threadId: "thread-reader", userId: "user-1" })).toBe(1);
    // The answer that waits on it goes on with the stopped result.
    await expect(waiting).resolves.toMatchObject({ reason: "user_stop", state: "stopped" });

    const two = await foreground("writer");
    store.turns.find((turn) => turn.turnId === one.turnId)!.state = "stopped";
    expect(await control.stopAll({ chatId: "chat-1", userId: "user-1" })).toBe(1);
    await expect(answer.wait(two)).resolves.toMatchObject({ reason: "stop_all", state: "stopped" });
  });
});
