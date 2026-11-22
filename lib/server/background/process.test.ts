import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runBackgroundWorkerProcess, type BackgroundWorkerProcessDependencies } from "./process";

function signals() {
  const emitter = new EventEmitter();
  return {
    emit: (signal: "SIGINT" | "SIGTERM") => emitter.emit(signal),
    listeners: () => emitter.listenerCount("SIGTERM") + emitter.listenerCount("SIGINT"),
    off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => emitter.off(signal, listener),
    on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => emitter.on(signal, listener)
  };
}

function dependencies(order: string[], overrides: Partial<BackgroundWorkerProcessDependencies> = {}) {
  const shutdown = signals();
  const deps: BackgroundWorkerProcessDependencies = {
    createWorker: () => ({
      start: () => { order.push("worker.start"); },
      stop: async () => { order.push("worker.stop"); return "drained"; }
    }),
    disconnect: async () => { order.push("disconnect"); },
    heartbeat: {
      begin: async () => { order.push("heartbeat.begin"); },
      beat: async () => { order.push("heartbeat.beat"); },
      stop: async () => { order.push("heartbeat.stop"); }
    },
    heartbeatIntervalMs: 60_000,
    signals: shutdown,
    ...overrides
  };
  return { deps, shutdown };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("background worker process", () => {
  it("starts the passes and stops in the contract order", async () => {
    const order: string[] = [];
    const { deps, shutdown } = dependencies(order);
    const running = runBackgroundWorkerProcess(deps);
    await settle();
    expect(order).toEqual(["heartbeat.begin", "worker.start", "heartbeat.beat"]);
    shutdown.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    // Passes drain before readiness clears and the connection closes.
    expect(order.slice(3)).toEqual(["worker.stop", "heartbeat.stop", "disconnect"]);
    expect(shutdown.listeners()).toBe(0);
  });

  it("exits non-zero and disconnects when the worker cannot start", async () => {
    const order: string[] = [];
    const { deps } = dependencies(order, {
      heartbeat: {
        begin: async () => { throw new Error("synthetic_database_down"); },
        beat: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      }
    });
    await expect(runBackgroundWorkerProcess(deps)).resolves.toBe(1);
    expect(order).toEqual(["disconnect"]);
  });

  it("keeps running when a heartbeat write fails", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      let beats = 0;
      const { deps, shutdown } = dependencies(order, {
        heartbeat: {
          begin: async () => undefined,
          beat: async () => { beats += 1; if (beats > 1) throw new Error("synthetic_heartbeat_failed"); },
          stop: async () => undefined
        },
        heartbeatIntervalMs: 1_000
      });
      const running = runBackgroundWorkerProcess(deps);
      await vi.advanceTimersByTimeAsync(3_500);
      expect(beats).toBe(4);
      shutdown.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);
      await expect(running).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
