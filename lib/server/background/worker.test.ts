import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundPassRegistry, type BackgroundPass } from "./passes";
import { createBackgroundWorker } from "./worker";

function pass(name: string, intervalMs: number, run: BackgroundPass["run"]): BackgroundPass {
  return { intervalMs, name, run };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("background pass registry", () => {
  it("refuses an invalid or a second pass of the same name", () => {
    const registry = new BackgroundPassRegistry();
    const first = pass("chat_search_index", 3_000, async () => undefined);
    const unregister = registry.register(first);
    expect(registry.register(first)).toBeTypeOf("function");
    expect(() => registry.register(pass("chat_search_index", 3_000, async () => undefined)))
      .toThrow("background_pass_conflict");
    expect(() => registry.register(pass("Bad Name", 3_000, async () => undefined))).toThrow("background_pass_invalid");
    expect(() => registry.register(pass("too_fast", 10, async () => undefined))).toThrow("background_pass_invalid");
    unregister();
    expect(registry.list()).toEqual([]);
  });
});

describe("background worker loop", () => {
  it("runs each pass on its own cadence, never overlapping itself", async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const slow = pass("slow", 1_000, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push("slow");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      active -= 1;
    });
    const fast = pass("fast", 500, async () => { calls.push("fast"); });
    const worker = createBackgroundWorker({ passes: [slow, fast] });
    worker.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const stopping = worker.stop(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await stopping;
    expect(maxActive).toBe(1);
    expect(calls.filter((call) => call === "slow").length).toBe(2);
    expect(calls.filter((call) => call === "fast").length).toBeGreaterThanOrEqual(9);
  });

  it("backs a failing pass off without stopping the others", async () => {
    const failing = vi.fn(async () => { throw new Error("synthetic_pass_failure"); });
    const healthy = vi.fn(async () => undefined);
    const worker = createBackgroundWorker({
      passes: [pass("failing", 1_000, failing), pass("healthy", 1_000, healthy)]
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await worker.stop(1_000);
    // Backoff doubles from the interval: runs at 0 s, 2 s and 6 s within ten seconds.
    expect(failing).toHaveBeenCalledTimes(3);
    expect(healthy.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it("runs a pass that left work behind again soon", async () => {
    let calls = 0;
    const worker = createBackgroundWorker({
      passes: [pass("batches", 60_000, async () => ({ more: ++calls < 3 }))]
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await worker.stop(1_000);
    expect(calls).toBe(3);
  });

  it("bounds how many passes run at once", async () => {
    let active = 0;
    let maxActive = 0;
    const busy = (name: string) => pass(name, 1_000, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 300));
      active -= 1;
    });
    const worker = createBackgroundWorker({ concurrency: 2, passes: [busy("a"), busy("b"), busy("c")] });
    worker.start();
    await vi.advanceTimersByTimeAsync(3_000);
    const stopping = worker.stop(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(maxActive).toBe(2);
  });

  it("aborts running passes at shutdown and waits for them within the bound", async () => {
    let signal: AbortSignal | null = null;
    let settled = false;
    const worker = createBackgroundWorker({
      passes: [pass("long", 1_000, async (context) => {
        signal = context.signal;
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve()));
        settled = true;
      })]
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(10);
    const stopping = worker.stop(1_000);
    await expect(stopping).resolves.toBe("drained");
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it("gives up waiting for a pass that ignores shutdown after the bound", async () => {
    const worker = createBackgroundWorker({
      passes: [pass("stuck", 1_000, () => new Promise(() => undefined))]
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(10);
    const stopping = worker.stop(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(stopping).resolves.toBe("timed_out");
  });
});
