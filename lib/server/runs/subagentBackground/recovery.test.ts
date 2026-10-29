import { describe, expect, it, vi } from "vitest";
import { FakeWorkspaceAttachments } from "@/tests/support/subagentPorts";
import { MemorySubagentStore } from "@/tests/support/subagentBackgroundStore";
import { createSubagentCallbacks } from "./callbacks";
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
    const settled = await reconcileSubagentRuns({ bootedAt: new Date(), flush: callbacks.flush, liveRunIds: () => ["run-chat-b-three"],
      staleMs: 60_000, store, workspace });
    // A run executing here keeps its execution.
    expect(settled).toBe(2);
    expect(store.turns.map((turn) => turn.state)).toEqual(["interrupted", "interrupted", "running"]);
    expect(store.turns[0]!.result).toMatchObject({ name: "one", reason: "restart", state: "interrupted" });
    expect(detach).toHaveBeenCalledWith(expect.objectContaining({ execution: "unknown", modelRunId: "run-chat-a-one" }));
    await vi.waitFor(() => expect(wakeUps).toHaveLength(1));
    expect(wakeUps[0]).toEqual({ chatId: "chat-a", turnIds: ["turn-chat-a-one", "turn-chat-a-two"] });
    expect(store.strandedInterrupts).toBe(1);
  });
});
