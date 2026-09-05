import { describe, expect, it, vi } from "vitest";
import { WorkspaceOperationFence } from "./operationFence";

const identity = { runtimeSandboxId: "runtime_fixture", sessionId: "session_fixture" };
const operation = (generation: number) => ({ generation, owner: `run:fixture_${generation}` });

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

describe("Workspace receiver operation drain", () => {
  it("keeps a timed-out old drain ahead of the next owner's side effects", async () => {
    vi.useFakeTimers();
    try {
      const stops: string[] = [];
      const fence = new WorkspaceOperationFence({ drainTimeoutMs: 100, stop: async () => { stops.push("stop"); } });
      await fence.claim({ ...identity, operation: operation(1) });
      const entered = barrier();
      const oldWork = barrier();
      const running = fence.run({ ...identity, operation: operation(1) }, async () => {
        entered.release();
        await oldWork.wait; // Models an SDK call that cannot honor AbortSignal.
      });
      await entered.wait;
      const retired = expect(fence.retire({ ...identity, operation: operation(1) }))
        .rejects.toMatchObject({ code: "workspace_execution_cleanup_failed" });
      await vi.advanceTimersByTimeAsync(100);
      await retired;
      let handedOver = false;
      const next = fence.claim({ ...identity, operation: operation(2) }).then(() => { handedOver = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(handedOver).toBe(false);
      let dispatched = false;
      const queued = fence.run({ ...identity, operation: operation(2) }, async () => { dispatched = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatched).toBe(false);
      oldWork.release();
      await running;
      await next;
      await queued;
      await fence.run({ ...identity, operation: operation(2) }, async () => { stops.push("new owner"); });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stops.at(-1)).toBe("new owner");
      await expect(fence.run({ ...identity, operation: operation(1) }, async () => undefined))
        .rejects.toMatchObject({ code: "workspace_operation_stale" });
    } finally { vi.useRealTimers(); }
  });

  it("lets Stop abort the current run without waiting for its own request lock", async () => {
    const stop = vi.fn(async () => undefined);
    const fence = new WorkspaceOperationFence({ stop });
    await fence.claim({ ...identity, operation: operation(1) });
    const entered = barrier();
    const running = fence.run({ ...identity, operation: operation(1) }, async (signal) => {
      entered.release();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await entered.wait;
    await fence.retire({ ...identity, operation: operation(1) });
    await running;
    expect(stop).toHaveBeenCalled();
    await expect(fence.claim({ ...identity, operation: operation(1) }))
      .rejects.toMatchObject({ code: "workspace_operation_stale" });
  });
});
