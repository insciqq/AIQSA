import { logEvent, reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { BACKGROUND_WORKER_HEARTBEAT_INTERVAL_MS, type BackgroundWorkerHeartbeat } from "./heartbeat";
import type { BackgroundWorker } from "./worker";

/** Passes and the legacy coordinator drain in parallel within this bound, then each closing write gets
 * `BACKGROUND_WORKER_SHUTDOWN_STEP_MS`, so the whole stop stays inside Compose's 30 s grace period. */
export const BACKGROUND_WORKER_DRAIN_MS = 15_000;
export const BACKGROUND_WORKER_SHUTDOWN_STEP_MS = 4_000;

type ShutdownSignal = "SIGINT" | "SIGTERM";

export type BackgroundWorkerSignals = Readonly<{
  off(signal: ShutdownSignal, listener: () => void): unknown;
  on(signal: ShutdownSignal, listener: () => void): unknown;
}>;

/**
 * The old Memory coordinator, started in the same process for the Memory job kinds that still exist until the
 * Memory removal deletes it. Deletion never depends on it: a blocked or failed start is logged and the
 * background passes keep running.
 */
export type LegacyBackgroundCoordinator = Readonly<{
  start(): Promise<"blocked" | "ready">;
  stop(): Promise<unknown>;
}>;

export type BackgroundWorkerProcessDependencies = Readonly<{
  /** Builds the loop from the passes registered by now. */
  createWorker: () => BackgroundWorker;
  disconnect: () => Promise<void>;
  heartbeat: BackgroundWorkerHeartbeat;
  heartbeatIntervalMs?: number;
  legacy?: LegacyBackgroundCoordinator;
  signals: BackgroundWorkerSignals;
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

/**
 * Runs the background worker until SIGINT or SIGTERM and returns its exit code. Shutdown order is the
 * contract: passes release their claims and drain (bounded) before readiness is cleared and before the
 * database connection closes.
 */
export async function runBackgroundWorkerProcess(
  dependencies: BackgroundWorkerProcessDependencies
): Promise<number> {
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });
  // Installed until shutdown ends: a repeated signal during the drain must not
  // fall through to Node's immediate default termination.
  dependencies.signals.on("SIGINT", requestStop);
  dependencies.signals.on("SIGTERM", requestStop);
  let worker: BackgroundWorker | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let legacyStart: Promise<unknown> | null = null;
  try {
    try {
      await dependencies.heartbeat.begin();
      worker = dependencies.createWorker();
      worker.start();
      await dependencies.heartbeat.beat();
    } catch (error) {
      reportSubsystemFailure({ action: "stop", code: "background_worker_startup_failed", error,
        stage: "startup", subsystem: "background" });
      await within(BACKGROUND_WORKER_SHUTDOWN_STEP_MS, async () => worker?.stop(0));
      await within(BACKGROUND_WORKER_SHUTDOWN_STEP_MS, dependencies.disconnect);
      return 1;
    }
    logEvent("runtime_lifecycle", { outcome: "completed", stage: "startup", subsystem: "background" });
    heartbeatTimer = setInterval(() => {
      void dependencies.heartbeat.beat().then(
        () => reportSubsystemHealthy("background", "heartbeat"),
        (error: unknown) => reportSubsystemFailure({ action: "retry", code: "background_worker_heartbeat_failed",
          error, stage: "heartbeat", subsystem: "background" })
      );
    }, dependencies.heartbeatIntervalMs ?? BACKGROUND_WORKER_HEARTBEAT_INTERVAL_MS);
    if (dependencies.legacy) {
      const legacy = dependencies.legacy;
      legacyStart = Promise.resolve().then(() => legacy.start()).then((status) => {
        if (status === "blocked") {
          logEvent("runtime_lifecycle", { action: "skip", code: "background_legacy_coordinator_blocked",
            outcome: "blocked", stage: "startup", subsystem: "memory" });
        }
      }, (error: unknown) => {
        reportSubsystemFailure({ action: "skip", code: "background_legacy_coordinator_failed", error,
          stage: "startup", subsystem: "memory" });
      });
    }
    await stopRequested;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    const running = worker;
    await Promise.all([
      within(BACKGROUND_WORKER_DRAIN_MS, async () => running?.stop(BACKGROUND_WORKER_DRAIN_MS - 1_000)),
      within(BACKGROUND_WORKER_DRAIN_MS, async () => {
        // A start still in flight may start the coordinator after a stop: stop after it settles.
        await legacyStart;
        await dependencies.legacy?.stop();
      })
    ]);
    await within(BACKGROUND_WORKER_SHUTDOWN_STEP_MS, dependencies.heartbeat.stop);
    await within(BACKGROUND_WORKER_SHUTDOWN_STEP_MS, dependencies.disconnect);
    logEvent("runtime_lifecycle", { outcome: "completed", stage: "shutdown", subsystem: "background" });
    return 0;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    dependencies.signals.off("SIGINT", requestStop);
    dependencies.signals.off("SIGTERM", requestStop);
  }
}
