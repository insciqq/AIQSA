import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { backgroundErrorCode } from "./errors";
import { assertBackgroundPass, type BackgroundPass } from "./passes";

/** How long after a pass that left work behind it runs again. */
export const BACKGROUND_PASS_MORE_DELAY_MS = 250;
/** The longest a failing pass waits before its next run. */
export const BACKGROUND_PASS_MAX_BACKOFF_MS = 5 * 60 * 1_000;
/** Passes running at once; each pass runs at most once at a time. */
export const BACKGROUND_PASS_CONCURRENCY = 2;

type Timer = ReturnType<typeof setTimeout>;

export type BackgroundWorkerOptions = Readonly<{
  passes: readonly BackgroundPass[];
  concurrency?: number;
  maxBackoffMs?: number;
  now?: () => Date;
  /** Test seams; the defaults are Node's timers, unreferenced so they never hold the process open. */
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}>;

export type BackgroundWorkerStopResult = "drained" | "timed_out";

export type BackgroundWorker = Readonly<{
  start(): void;
  /** Stops scheduling, aborts the running passes and waits for them within `drainMs`. */
  stop(drainMs: number): Promise<BackgroundWorkerStopResult>;
}>;

type PassState = {
  failures: number;
  nextRunAt: number;
  readonly pass: BackgroundPass;
  running: Promise<void> | null;
};

/**
 * The neutral worker loop. Each registered pass runs on its own cadence, at most once at a time and at most
 * `concurrency` passes together. A pass that throws is logged by code only and backs off exponentially; it
 * never stops the others. Shutdown aborts the passes' signal so they release their claims, then drains them.
 */
export function createBackgroundWorker(options: BackgroundWorkerOptions): BackgroundWorker {
  const now = options.now ?? (() => new Date());
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? BACKGROUND_PASS_CONCURRENCY));
  const maxBackoffMs = options.maxBackoffMs ?? BACKGROUND_PASS_MAX_BACKOFF_MS;
  const setTimer = options.setTimer ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const names = new Set<string>();
  const states: PassState[] = options.passes.map((pass) => {
    assertBackgroundPass(pass);
    if (names.has(pass.name)) throw new Error("background_pass_conflict");
    names.add(pass.name);
    return { failures: 0, nextRunAt: 0, pass, running: null };
  });
  const controller = new AbortController();
  let started = false;
  let stopped = false;
  let timer: Timer | null = null;

  const runningCount = () => states.filter((state) => state.running).length;

  function schedule(): void {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = null;
    if (runningCount() >= concurrency) return;
    const idle = states.filter((state) => !state.running);
    if (idle.length === 0) return;
    const next = Math.min(...idle.map((state) => state.nextRunAt));
    timer = setTimer(tick, Math.max(0, next - now().getTime()));
  }

  function launch(state: PassState): void {
    const startedAt = now().getTime();
    state.running = (async () => {
      try {
        const outcome = await state.pass.run({ now, signal: controller.signal });
        if (state.failures > 0) reportSubsystemHealthy("background", "process");
        state.failures = 0;
        state.nextRunAt = now().getTime() +
          (outcome?.more ? BACKGROUND_PASS_MORE_DELAY_MS : state.pass.intervalMs);
      } catch (error) {
        state.failures += 1;
        const backoff = Math.min(maxBackoffMs, state.pass.intervalMs * 2 ** Math.min(state.failures, 20));
        state.nextRunAt = Math.max(startedAt, now().getTime()) + backoff;
        if (!controller.signal.aborted) {
          reportSubsystemFailure({
            action: "retry",
            code: backgroundErrorCode(error, "background_pass_failed"),
            error,
            stage: "process",
            subsystem: "background"
          });
        }
      } finally {
        state.running = null;
        schedule();
      }
    })();
  }

  function tick(): void {
    timer = null;
    if (stopped) return;
    const current = now().getTime();
    const due = states
      .filter((state) => !state.running && state.nextRunAt <= current)
      .sort((left, right) => left.nextRunAt - right.nextRunAt);
    for (const state of due) {
      if (runningCount() >= concurrency) break;
      launch(state);
    }
    schedule();
  }

  return Object.freeze({
    start() {
      if (started || stopped) return;
      started = true;
      const current = now().getTime();
      for (const state of states) state.nextRunAt = current;
      schedule();
    },
    async stop(drainMs) {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      controller.abort(new Error("background_worker_stopping"));
      const running = states.flatMap((state) => state.running ? [state.running] : []);
      if (running.length === 0) return "drained";
      const drain: { timer?: Timer } = {};
      const result = await Promise.race([
        Promise.allSettled(running).then(() => "drained" as const),
        new Promise<"timed_out">((resolve) => {
          drain.timer = setTimer(() => resolve("timed_out"), drainMs);
        })
      ]);
      if (drain.timer) clearTimer(drain.timer);
      return result;
    }
  });
}
