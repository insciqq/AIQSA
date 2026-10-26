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

  it("hands over to a successor without a VM stop only while its exact predecessor is active and idle", async () => {
    const stop = vi.fn(async () => undefined);
    const fence = new WorkspaceOperationFence({ stop });
    await fence.claim({ ...identity, operation: operation(1) });
    stop.mockClear();
    const handover = { generation: 2, owner: "export:fixture_1:token" };
    await fence.claim({ ...identity, operation: handover, predecessor: operation(1) });
    expect(stop).not.toHaveBeenCalled();
    await expect(fence.run({ ...identity, operation: operation(1) }, async () => undefined))
      .rejects.toMatchObject({ code: "workspace_operation_stale" });
    await expect(fence.run({ ...identity, operation: handover }, async () => "served")).resolves.toBe("served");

    // A request still in flight is aborted and drained behind a stop.
    const entered = barrier();
    const running = fence.run({ ...identity, operation: handover }, async (signal) => {
      entered.release();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await entered.wait;
    const next = { generation: 3, owner: "export:fixture_1:next" };
    await fence.claim({ ...identity, operation: next, predecessor: handover });
    await running;
    expect(stop).toHaveBeenCalled();

    // Neither an older operation nor a retired one counts as the predecessor.
    stop.mockClear();
    await fence.claim({ ...identity, operation: operation(4), predecessor: operation(1) });
    expect(stop).toHaveBeenCalled();
    await fence.retire({ ...identity, operation: operation(4) });
    stop.mockClear();
    await fence.claim({ ...identity, operation: operation(5), predecessor: operation(4) });
    expect(stop).toHaveBeenCalled();
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

describe("Workspace receiver idle refresh", () => {
  // The runner's defaults: a touch every five minutes, for a turn and its handoff after the latest activity.
  const awake = (touch: (input: Readonly<{ sessionId: string }>) => Promise<void>, lifetimeMs = 3_900_000) =>
    new WorkspaceOperationFence({ idleRefresh: { intervalMs: 300_000, lifetimeMs, touch }, stop: async () => undefined });

  it("touches the guest while its operation is active and stops when the run ends", async () => {
    vi.useFakeTimers();
    try {
      const touch = vi.fn(async () => undefined);
      const fence = awake(touch);
      await fence.claim({ ...identity, operation: operation(1) });
      expect(touch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(touch).toHaveBeenCalledExactlyOnceWith({ sessionId: identity.sessionId });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(touch).toHaveBeenCalledTimes(3);
      // The run's end retires its operation: no touch after it, so the guest may idle again.
      await fence.retire({ ...identity, operation: operation(1) });
      await vi.advanceTimersByTimeAsync(3_000_000);
      expect(touch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops touching on Stop, which retires the operation while a request still runs", async () => {
    vi.useFakeTimers();
    try {
      const touch = vi.fn(async () => undefined);
      const fence = awake(touch);
      await fence.claim({ ...identity, operation: operation(1) });
      const entered = barrier();
      const running = fence.run({ ...identity, operation: operation(1) }, async (signal) => {
        entered.release();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      });
      await entered.wait;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(touch).toHaveBeenCalledOnce();
      await fence.retire({ ...identity, operation: operation(1) });
      await running;
      await vi.advanceTimersByTimeAsync(900_000);
      expect(touch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on while requests come and ends a lifetime after the last one when nobody retires the operation", async () => {
    vi.useFakeTimers();
    try {
      const touch = vi.fn(async () => undefined);
      const fence = awake(touch, 900_000);
      await fence.claim({ ...identity, operation: operation(1) });
      await vi.advanceTimersByTimeAsync(600_000);
      // A request at ten minutes keeps the guest awake until 25 minutes, then the touches end on their own.
      await fence.run({ ...identity, operation: operation(1) }, async () => undefined);
      await vi.advanceTimersByTimeAsync(1_400_000);
      expect(touch).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(3_000_000);
      expect(touch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the touches to the operation that takes the session over", async () => {
    vi.useFakeTimers();
    try {
      const touch = vi.fn(async () => undefined);
      const fence = awake(touch);
      await fence.claim({ ...identity, operation: operation(1) });
      await vi.advanceTimersByTimeAsync(300_000);
      await fence.claim({ ...identity, operation: operation(2) });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(touch).toHaveBeenCalledTimes(2);
      await expect(fence.retire({ ...identity, operation: operation(1) })).rejects.toMatchObject({ code: "workspace_operation_stale" });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(touch).toHaveBeenCalledTimes(3);
      await fence.retire({ ...identity, operation: operation(2) });
      await vi.advanceTimersByTimeAsync(900_000);
      expect(touch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fails the operation when a touch fails, and logs only a content-free code", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    try {
      const touch = vi.fn(async () => { throw new Error("guest unreachable: private detail"); });
      const fence = awake(touch);
      await fence.claim({ ...identity, operation: operation(1) });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(touch).toHaveBeenCalledTimes(2);
      await expect(fence.run({ ...identity, operation: operation(1) }, async () => "done")).resolves.toBe("done");
      const failures = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.code === "workspace_idle_refresh_failed");
      expect(failures).toHaveLength(2);
      expect(failures[0]).toMatchObject({ outcome: "failed", stage: "heartbeat", subsystem: "workspace" });
      expect(lines.join("\n")).not.toContain("private detail");
    } finally {
      write.mockRestore();
      vi.useRealTimers();
    }
  });
});
