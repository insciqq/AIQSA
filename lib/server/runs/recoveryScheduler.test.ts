import { describe, expect, it, vi } from "vitest";
import { RunRecoveryScheduler } from "./recoveryScheduler";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("run recovery scheduler", () => {
  it("keeps timer-driven run recovery progressing and cancels the single held export on shutdown", async () => {
    vi.useFakeTimers();
    const held = deferred();
    let exportSignal: AbortSignal | undefined;
    const exports = vi.fn(async (signal: AbortSignal) => { exportSignal = signal; await held.promise; });
    const reconcile = vi.fn(async () => undefined);
    const scheduler = new RunRecoveryScheduler({ intervalMs: 100, reconcile, recoverWorkspaceExports: exports });
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(reconcile).toHaveBeenCalledTimes(6);
      expect(exports).toHaveBeenCalledOnce();
      const stopping = scheduler.stop();
      const cancelled = exportSignal?.aborted;
      held.resolve();
      await stopping;
      expect(cancelled).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(reconcile).toHaveBeenCalledTimes(6);
      expect(exports).toHaveBeenCalledOnce();
    } finally {
      held.resolve();
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("runs one independent export worker while repeated run-recovery ticks progress", async () => {
    const held = deferred();
    let active = 0;
    let maximum = 0;
    const exports = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      try { await held.promise; } finally { active -= 1; }
    });
    const reconcile = vi.fn(async () => undefined);
    const scheduler = new RunRecoveryScheduler({ reconcile, recoverWorkspaceExports: exports });
    try {
      await scheduler.reconcileNow();
      await vi.waitFor(() => expect(exports).toHaveBeenCalledOnce());
      for (let index = 0; index < 4; index += 1) await scheduler.reconcileNow();
      expect(reconcile).toHaveBeenCalledTimes(5);
      expect(exports).toHaveBeenCalledOnce();
      expect(maximum).toBe(1);
    } finally {
      const stopping = scheduler.stop();
      held.resolve();
      await stopping;
    }
    expect(exports).toHaveBeenCalledOnce();
  });

  it("aborts and drains the owned worker, discards pending work, and rejects kicks after stop", async () => {
    const held = deferred();
    let signal: AbortSignal | undefined;
    const reconcile = vi.fn(async (received: AbortSignal) => {
      signal = received;
      await held.promise;
    });
    const scheduler = new RunRecoveryScheduler({ reconcile });
    scheduler.kick();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    scheduler.kick();
    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    try {
      expect(signal?.aborted).toBe(true);
      expect(stopped).toBe(false);
      scheduler.kick();
    } finally {
      held.resolve();
      await stopping;
    }
    await scheduler.reconcileNow();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("keeps export failures isolated and retries on a later tick", async () => {
    const exports = vi.fn().mockRejectedValueOnce(new Error("transfer unavailable")).mockResolvedValue(undefined);
    const reconcile = vi.fn(async () => undefined);
    const scheduler = new RunRecoveryScheduler({ reconcile, recoverWorkspaceExports: exports });
    try {
      await scheduler.reconcileNow();
      await vi.waitFor(() => expect(exports).toHaveBeenCalledOnce());
      await scheduler.reconcileNow();
      await vi.waitFor(() => expect(exports).toHaveBeenCalledTimes(2));
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally { await scheduler.stop(); }
  });

  it("coalesces concurrent kicks and drains one pending pass", async () => {
    const first = deferred();
    const reconcile = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const scheduler = new RunRecoveryScheduler({ reconcile });

    scheduler.kick();
    scheduler.kick();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    scheduler.kick();
    scheduler.kick();
    first.resolve();
    await scheduler.reconcileNow();

    expect(reconcile).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});
