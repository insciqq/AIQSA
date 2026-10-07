import {
  logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, setFatalExitTask, setRecordObserver
} from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { createTelemetryAggregator, type TelemetryAggregator } from "./aggregator";
import {
  createPrismaTelemetryStore, telemetryWriteIsPermanent, type TelemetryDatabase, type TelemetryStore
} from "./store";

export const TELEMETRY_FLUSH_INTERVAL_MS = 30_000;
/** The first write follows soon after start, so a process that restarts in a
 * loop still leaves its start (and early failures) behind. */
export const TELEMETRY_FIRST_FLUSH_MS = 5_000;
export const TELEMETRY_RETENTION_INTERVAL_MS = 3_600_000;
/** A shutdown or a fatal exit waits at most this long for the final write;
 * a process killed from outside loses its last interval. */
export const TELEMETRY_FINAL_FLUSH_MS = 2_000;

export type TelemetryRecorder = Readonly<{
  /** Writes what is pending now and any due retention; never rejects. */
  flush(): Promise<void>;
  /** Stops observing, then makes one bounded final write. */
  stop(): Promise<void>;
}>;

export type TelemetryRecorderOptions = Readonly<{
  store: TelemetryStore;
  /** Only the application process prunes. */
  retention: boolean;
  aggregator?: TelemetryAggregator;
  firstFlushMs?: number;
  flushIntervalMs?: number;
  retentionIntervalMs?: number;
  finalFlushMs?: number;
  now?: () => number;
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

/** Observes this process's validated log records and adds them to PostgreSQL
 * every interval. Database trouble never reaches the logging call path: a
 * failed write is reported through the throttled subsystem failure line and
 * its batch waits, bounded, for the next interval. */
export function createTelemetryRecorder(options: TelemetryRecorderOptions): TelemetryRecorder & Readonly<{ start(): void }> {
  const aggregator = options.aggregator ?? createTelemetryAggregator();
  const now = options.now ?? Date.now;
  const flushIntervalMs = options.flushIntervalMs ?? TELEMETRY_FLUSH_INTERVAL_MS;
  const retentionIntervalMs = options.retentionIntervalMs ?? TELEMETRY_RETENTION_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  // Pruning waits for the first regular interval, clear of startup work.
  let retentionDueAt = now() + flushIntervalMs;

  const write = async (): Promise<void> => {
    const batch = aggregator.drain();
    if (batch.lostObservations > 0) {
      logEvent("runtime_lifecycle", { subsystem: "telemetry", stage: "write", outcome: "degraded",
        code: "telemetry_records_dropped", action: "degrade", count: batch.lostObservations });
    }
    if (batch.counters.length === 0 && batch.incidents.length === 0) return;
    try {
      await options.store.write(batch);
      reportSubsystemHealthy("telemetry", "write");
    } catch (error) {
      const permanent = telemetryWriteIsPermanent(error);
      if (!permanent) aggregator.restore(batch);
      reportSubsystemFailure({ error, subsystem: "telemetry", stage: "write", code: "telemetry_write_failed",
        prisma_code: databaseFailureCode(error), action: permanent ? "skip" : "retry" });
    }
  };

  const prune = async (): Promise<void> => {
    if (!options.retention || stopped || now() < retentionDueAt) return;
    retentionDueAt = now() + retentionIntervalMs;
    try {
      const deleted = await options.store.deleteExpired(new Date(now()));
      reportSubsystemHealthy("telemetry", "cleanup");
      if (deleted.counters + deleted.incidents > 0) {
        logEvent("runtime_lifecycle", { subsystem: "telemetry", stage: "cleanup", outcome: "completed",
          completed_count: deleted.counters + deleted.incidents });
      }
    } catch (error) {
      reportSubsystemFailure({ error, subsystem: "telemetry", stage: "cleanup", code: "telemetry_retention_failed",
        prisma_code: databaseFailureCode(error), action: "retry" });
    }
  };

  const flush = (): Promise<void> => {
    // One write at a time per process; a slow database delays, never stacks, intervals.
    running ??= runInBackground(async () => {
      try {
        await write();
        await prune();
      } catch { /* Reporting failed; the next interval retries. */ }
    }).finally(() => { running = null; });
    return running;
  };

  return Object.freeze({
    start(): void {
      if (timer || stopped) return;
      setRecordObserver((record) => aggregator.observe(record));
      const timers = runInBackground(() => ({
        first: setTimeout(() => { void flush(); }, options.firstFlushMs ?? TELEMETRY_FIRST_FLUSH_MS),
        interval: setInterval(() => { void flush(); }, flushIntervalMs)
      }));
      timers.first.unref?.();
      timers.interval.unref?.();
      first = timers.first;
      timer = timers.interval;
    },
    flush,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
      setRecordObserver(null);
      await within(options.finalFlushMs ?? TELEMETRY_FINAL_FLUSH_MS, async () => {
        await running;
        await flush();
      });
    }
  });
}

const RECORDER_KEY = Symbol.for("aiqsa.telemetry.recorder.v1");
type RecorderScope = typeof globalThis & { [RECORDER_KEY]?: TelemetryRecorder };

/** Starts the one recorder of this process (shared across bundles) on the
 * process's own database client. Tests and one-shot scripts never start it. */
export function startTelemetryRecorder(input: Readonly<{ prisma: TelemetryDatabase; retention?: boolean }>): TelemetryRecorder {
  const scope = globalThis as RecorderScope;
  const existing = scope[RECORDER_KEY];
  if (existing) return existing;
  const recorder = createTelemetryRecorder({ store: createPrismaTelemetryStore(input.prisma), retention: input.retention === true });
  const handle: TelemetryRecorder = Object.freeze({
    flush: recorder.flush,
    async stop() {
      if (scope[RECORDER_KEY] === handle) {
        delete scope[RECORDER_KEY];
        setFatalExitTask(null);
      }
      await recorder.stop();
    }
  });
  scope[RECORDER_KEY] = handle;
  recorder.start();
  // A process dying on an unhandled error still writes its start, its fatal
  // record and its last interval, so a fast crash loop shows in Health.
  setFatalExitTask(handle.stop);
  return handle;
}
