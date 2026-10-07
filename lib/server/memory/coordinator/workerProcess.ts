import { logEvent, reportSubsystemFailure } from "../../observability";
import type { MemoryCoordinatorStartupResult } from "./startup";

/** Each shutdown write after the coordinator's bounded drain gets this long,
 * so the whole stop stays inside Compose's 30 s grace period. */
export const MEMORY_WORKER_SHUTDOWN_STEP_MS = 4_000;

type ShutdownSignal = "SIGINT" | "SIGTERM";

export type MemoryWorkerSignals = Readonly<{
  off(signal: ShutdownSignal, listener: () => void): unknown;
  on(signal: ShutdownSignal, listener: () => void): unknown;
}>;

export type MemoryCoordinatorWorkerDependencies = Readonly<{
  disconnect: () => Promise<void>;
  signals: MemoryWorkerSignals;
  start: () => Promise<MemoryCoordinatorStartupResult>;
  /** Stops admission and drains claimed work within its own bound. */
  stopCoordinator: () => Promise<unknown>;
  stopHeartbeat: () => Promise<void>;
}>;

function within(milliseconds: number, work: () => Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    void Promise.resolve().then(work).catch(() => undefined).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Runs the dedicated Memory worker until SIGINT or SIGTERM and returns its
 * exit code. Shutdown order is the contract: claimed work settles (bounded)
 * before liveness is cleared and before the database connection closes. */
export async function runMemoryCoordinatorWorker(
  dependencies: MemoryCoordinatorWorkerDependencies
): Promise<number> {
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });
  // Installed until shutdown ends: a repeated signal during the drain must not
  // fall through to Node's immediate default termination.
  dependencies.signals.on("SIGINT", requestStop);
  dependencies.signals.on("SIGTERM", requestStop);
  try {
    let started: MemoryCoordinatorStartupResult | null;
    try {
      started = await dependencies.start();
    } catch (error) {
      reportSubsystemFailure({ error, subsystem: "memory", stage: "startup",
        code: "memory_coordinator_startup_failed", action: "stop" });
      started = null;
    }
    if (started?.status === "blocked") {
      logEvent("runtime_lifecycle", { subsystem: "memory", stage: "startup", outcome: "blocked",
        code: started.code, action: "stop" });
      await within(MEMORY_WORKER_SHUTDOWN_STEP_MS, dependencies.disconnect);
      return 1;
    }
    if (started) {
      logEvent("runtime_lifecycle", { subsystem: "memory", stage: "startup", outcome: "completed" });
      const keepAlive = setInterval(() => undefined, 60_000);
      try {
        await stopRequested;
      } finally {
        clearInterval(keepAlive);
      }
    }
    // A failed startup may have started the coordinator before it failed.
    await Promise.resolve().then(dependencies.stopCoordinator).catch(() => undefined);
    await within(MEMORY_WORKER_SHUTDOWN_STEP_MS, dependencies.stopHeartbeat);
    await within(MEMORY_WORKER_SHUTDOWN_STEP_MS, dependencies.disconnect);
    return started ? 0 : 1;
  } finally {
    dependencies.signals.off("SIGINT", requestStop);
    dependencies.signals.off("SIGTERM", requestStop);
  }
}
