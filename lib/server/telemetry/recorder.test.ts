// @vitest-environment node
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceProcess, logEvent } from "../observability";
import { rememberDatabaseFailure } from "../observability/databaseFailure";
import { createTelemetryAggregator, DEFAULT_TELEMETRY_AGGREGATOR_LIMITS, type TelemetryBatch } from "./aggregator";
import { createTelemetryRecorder, startTelemetryRecorder, type TelemetryRecorder } from "./recorder";
import type { TelemetryStore } from "./store";

const START = Date.parse("2026-10-07T10:00:05.000Z");
const lines: string[] = [];
const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
let recorder: TelemetryRecorder | null = null;

function fakeStore() {
  const store = {
    write: vi.fn<TelemetryStore["write"]>(async () => undefined),
    deleteExpired: vi.fn<TelemetryStore["deleteExpired"]>(async () => ({ counters: 0, incidents: 0 })),
    readCounters: vi.fn<TelemetryStore["readCounters"]>(),
    readIncidents: vi.fn<TelemetryStore["readIncidents"]>(),
    countIncidentsByRun: vi.fn<TelemetryStore["countIncidentsByRun"]>()
  };
  const batch = (index: number): TelemetryBatch => store.write.mock.calls[index]![0];
  return { store, batch };
}

function providerFailure(connectionId = "connection-1") {
  logEvent("provider_operation", { outcome: "failed", code: "provider_http_dns_failed", providerFamily: "openai",
    connectionId, providerModelId: "model-1", stage: "answer", duration_ms: 300 });
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  lines.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  const runtime = (globalThis as unknown as Record<symbol, { systemFailures?: Map<string, unknown> }>)[Symbol.for("aiqsa.observability.v1")];
  runtime?.systemFailures?.clear();
});

afterEach(async () => {
  const stopping = recorder?.stop();
  recorder = null;
  await vi.advanceTimersByTimeAsync(5_000);
  await stopping;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("telemetry recorder", () => {
  it("writes this process's records as hourly counters and error incidents, leaving stdout unchanged", async () => {
    const { store, batch } = fakeStore();
    const created = createTelemetryRecorder({ store, retention: false });
    recorder = created;
    created.start();
    providerFailure();
    logEvent("provider_operation", { outcome: "completed", connectionId: "connection-1", stage: "answer", duration_ms: 120 });
    logEvent("provider_operation", { outcome: "completed", connectionId: "connection-1", stage: "answer", duration_ms: 80 });
    expect(records().map((record) => record.event)).toEqual(["provider_operation", "provider_operation", "provider_operation"]);
    expect(store.write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.write).toHaveBeenCalledOnce();
    expect(batch(0).counters).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucketStart: new Date("2026-10-07T10:00:00.000Z"), role: "app", event: "provider_operation",
        level: "error", count: 1, dimensions: { code: "provider_http_dns_failed", connectionId: "connection-1",
          outcome: "failed", providerFamily: "openai", providerModelId: "model-1", stage: "answer" } }),
      expect.objectContaining({ level: "info", count: 2, durationCount: 2, durationSumMs: 200, durationMaxMs: 120,
        dimensions: { connectionId: "connection-1", outcome: "completed", stage: "answer" } })
    ]));
    expect(batch(0).incidents).toEqual([expect.objectContaining({ event: "provider_operation", level: "error",
      code: "provider_http_dns_failed", connectionId: "connection-1", details: expect.objectContaining({ duration_ms: 300 }) })]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.write).toHaveBeenCalledOnce();
    expect(lines).toHaveLength(3);
  });

  it("keeps a failed batch for the next interval and reports the failure and the recovery", async () => {
    const { store, batch } = fakeStore();
    const failure = new Error("PRIVATE_DATABASE_DETAIL");
    rememberDatabaseFailure(failure, "P1001");
    store.write.mockRejectedValueOnce(failure);
    const created = createTelemetryRecorder({ store, retention: false });
    recorder = created;
    created.start();
    providerFailure();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(records().at(-1)).toMatchObject({ event: "runtime_lifecycle", level: "warn", subsystem: "telemetry",
      stage: "write", outcome: "failed", code: "telemetry_write_failed", prisma_code: "P1001", action: "retry" });

    providerFailure();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(batch(1).counters).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "provider_operation", level: "error", count: 2 }),
      expect.objectContaining({ event: "runtime_lifecycle", level: "warn", count: 1,
        dimensions: expect.objectContaining({ subsystem: "telemetry", code: "telemetry_write_failed" }) })
    ]));
    expect(batch(1).incidents).toHaveLength(2);
    expect(records().at(-1)).toMatchObject({ event: "subsystem.recovered", subsystem: "telemetry", stage: "write" });
    expect(lines.join("")).not.toContain("PRIVATE_");
  });

  it("drops a batch the database rejects as invalid instead of retrying it forever", async () => {
    const { store, batch } = fakeStore();
    store.write.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("PRIVATE_SQL_DETAIL", {
      code: "P2010", clientVersion: "test", meta: { code: "23514" }
    }));
    const created = createTelemetryRecorder({ store, retention: false });
    recorder = created;
    created.start();
    providerFailure();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(records().at(-1)).toMatchObject({ subsystem: "telemetry", code: "telemetry_write_failed", action: "skip" });
    providerFailure("connection-2");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(batch(1).counters.filter((counter) => counter.event === "provider_operation"))
      .toEqual([expect.objectContaining({ count: 1, dimensions: expect.objectContaining({ connectionId: "connection-2" }) })]);
  });

  it("never holds up logging while the database hangs, stays bounded and stops within its bound", async () => {
    const { store } = fakeStore();
    store.write.mockImplementation(() => new Promise(() => undefined));
    const aggregator = createTelemetryAggregator({ ...DEFAULT_TELEMETRY_AGGREGATOR_LIMITS, maxCounterKeys: 2, maxOverflowKeys: 2 });
    const created = createTelemetryRecorder({ store, retention: false, aggregator });
    created.start();
    providerFailure();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let index = 0; index < 50; index += 1) {
      logEvent("provider_operation", { outcome: "completed", connectionId: `connection-${index}` });
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.write).toHaveBeenCalledOnce();
    expect(aggregator.pending()).toEqual({ counters: 3, incidents: 0 });
    expect(lines).toHaveLength(51);

    const stopping = created.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopping).resolves.toBeUndefined();
  });

  it("prunes only where enabled, at most hourly, and reports a failed pass without content", async () => {
    const { store } = fakeStore();
    const created = createTelemetryRecorder({ store, retention: true });
    recorder = created;
    created.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.deleteExpired).toHaveBeenCalledExactlyOnceWith(new Date(START + 30_000));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(store.deleteExpired).toHaveBeenCalledOnce();

    store.deleteExpired.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_DETAIL"));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(store.deleteExpired).toHaveBeenCalledTimes(2);
    expect(records()).toContainEqual(expect.objectContaining({ subsystem: "telemetry", stage: "cleanup",
      outcome: "failed", code: "telemetry_retention_failed", action: "retry" }));
    store.deleteExpired.mockResolvedValueOnce({ counters: 3, incidents: 2 });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(records()).toContainEqual(expect.objectContaining({ subsystem: "telemetry", stage: "cleanup",
      outcome: "completed", completed_count: 5 }));
    expect(lines.join("")).not.toContain("PRIVATE_");

    await created.stop();
    const worker = fakeStore();
    const workerRecorder = createTelemetryRecorder({ store: worker.store, retention: false });
    recorder = workerRecorder;
    workerRecorder.start();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(worker.store.deleteExpired).not.toHaveBeenCalled();
  });

  it("writes soon after start, so a process restarting in a loop still leaves its starts", async () => {
    const { store, batch } = fakeStore();
    const created = createTelemetryRecorder({ store, retention: false });
    recorder = created;
    created.start();
    announceProcess();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(batch(0).counters).toEqual([expect.objectContaining({ event: "process.started", level: "info", count: 1 })]);
  });

  it("stops observing and makes one final write", async () => {
    const { store } = fakeStore();
    const created = createTelemetryRecorder({ store, retention: false });
    created.start();
    providerFailure();
    await created.stop();
    expect(store.write).toHaveBeenCalledOnce();
    providerFailure();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(store.write).toHaveBeenCalledOnce();
  });

  it("keeps one process-wide recorder that writes through the given database client", async () => {
    const db = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(),
      $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
    };
    const first = startTelemetryRecorder({ prisma: db as never });
    recorder = first;
    expect(startTelemetryRecorder({ prisma: db as never })).toBe(first);
    providerFailure();
    await first.flush();
    // One transaction: the counter upsert and the incident insert.
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    await first.stop();
    const second = startTelemetryRecorder({ prisma: db as never });
    recorder = second;
    expect(second).not.toBe(first);
  });

  it("registers its bounded final write for a fatal exit and withdraws it on stop", async () => {
    const hooks = () => (globalThis as unknown as Record<symbol, { fatalExitTask?: (() => Promise<unknown>) | null }>)[
      Symbol.for("aiqsa.observability.process-hooks.v1")];
    const db = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(),
      $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
    };
    const started = startTelemetryRecorder({ prisma: db as never });
    recorder = started;
    const task = hooks()?.fatalExitTask;
    expect(task).toEqual(expect.any(Function));
    // A crash before the first interval still persists the failure it saw.
    providerFailure();
    await task!();
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(hooks()?.fatalExitTask).toBeNull();
    recorder = null;
  });
});
