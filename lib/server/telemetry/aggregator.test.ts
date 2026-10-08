// @vitest-environment node
import { describe, expect, it } from "vitest";
import { serializeEvent } from "../observability/runtime.cjs";
import {
  createTelemetryAggregator, DEFAULT_TELEMETRY_AGGREGATOR_LIMITS, TELEMETRY_DURATION_BUCKETS,
  telemetryDurationBucket, type TelemetryAggregatorLimits
} from "./aggregator";

const HOUR = Date.parse("2026-10-07T10:00:00.000Z");
const INSTANCE = "a".repeat(32);

function record(fields: Record<string, unknown>, at = HOUR + 60_000): Readonly<Record<string, unknown>> {
  return Object.freeze({
    timestamp: new Date(at).toISOString(), level: "info", event: "provider_operation", role: "app",
    app_version: "0.3.7", instance_id: INSTANCE, trace_id: "b".repeat(32), ...fields
  });
}

function buckets(entries: Record<number, number>): number[] {
  const values = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
  for (const [index, value] of Object.entries(entries)) values[Number(index)] = value;
  return values;
}

function limits(overrides: Partial<TelemetryAggregatorLimits>): TelemetryAggregatorLimits {
  return { ...DEFAULT_TELEMETRY_AGGREGATOR_LIMITS, ...overrides };
}

const failed = { level: "error", outcome: "failed", code: "provider_http_dns_failed", stage: "answer",
  providerFamily: "openai", connectionId: "connection-1", providerModelId: "model-1" } as const;

describe("telemetry aggregation", () => {
  it("counts records per hour and allowlisted dimensions with duration and value statistics", () => {
    const aggregator = createTelemetryAggregator();
    aggregator.observe(record({ ...failed, duration_ms: 120, attempt: 2, run_id: "run-1", timeout_ms: 30_000 }));
    aggregator.observe(record({ ...failed, duration_ms: 4_000, run_id: "run-2" }, HOUR + 120_000));
    aggregator.observe(record({ ...failed, code: "provider_http_server_error", httpStatus: 503 }));
    aggregator.observe(record({ ...failed, duration_ms: 50 }, HOUR + 3_600_000));
    aggregator.observe(record({ event: "logging.dropped_records", level: "warn", count: 7 }));
    aggregator.observe(record({ event: "logging.dropped_records", level: "warn", count: 5 }, HOUR + 30_000));

    const { counters, incidents, lostObservations } = aggregator.drain();
    expect(lostObservations).toBe(0);
    expect(incidents).toHaveLength(4);
    expect(counters).toHaveLength(4);
    const dns = counters.find((item) => item.dimensions.code === "provider_http_dns_failed" &&
      item.bucketStart.getTime() === HOUR)!;
    expect(dns).toEqual({
      bucketStart: new Date(HOUR), role: "app", event: "provider_operation", level: "error", appVersion: "0.3.7",
      dimensions: { code: "provider_http_dns_failed", connectionId: "connection-1", outcome: "failed",
        providerFamily: "openai", providerModelId: "model-1", stage: "answer" },
      count: 2, valueSum: 0, durationCount: 2, durationSumMs: 4_120, durationMaxMs: 4_000,
      durationBuckets: buckets({ 1: 1, 5: 1 }),
      firstSeenAt: new Date(HOUR + 60_000), lastSeenAt: new Date(HOUR + 120_000)
    });
    expect(counters.find((item) => item.dimensions.httpStatus === 503))
      .toMatchObject({ count: 1, durationCount: 0, durationMaxMs: null, durationBuckets: buckets({}) });
    expect(counters.find((item) => item.bucketStart.getTime() === HOUR + 3_600_000))
      .toMatchObject({ count: 1, durationBuckets: buckets({ 0: 1 }) });
    expect(counters.find((item) => item.event === "logging.dropped_records"))
      .toMatchObject({ level: "warn", count: 2, valueSum: 12, dimensions: {} });
    for (const counter of counters) {
      for (const key of ["run_id", "trace_id", "instance_id", "attempt", "timeout_ms", "duration_ms", "count", "timestamp"]) {
        expect(counter.dimensions).not.toHaveProperty(key);
      }
    }
    expect(aggregator.pending()).toEqual({ counters: 0, incidents: 0 });
  });

  it("aggregates the leaf's own validated records", () => {
    const aggregator = createTelemetryAggregator();
    const line = serializeEvent("http.request_completed", { method: "GET", status: 502, duration_ms: 12, outcome: "completed" })!;
    aggregator.observe(Object.freeze(JSON.parse(line)));
    const { counters, incidents } = aggregator.drain();
    expect(counters).toEqual([expect.objectContaining({
      event: "http.request_completed", level: "error", count: 1,
      dimensions: { method: "GET", outcome: "completed", status: 502 }
    })]);
    expect(incidents).toEqual([expect.objectContaining({ event: "http.request_completed", level: "error",
      details: { method: "GET", status: 502, duration_ms: 12, outcome: "completed" } })]);
  });

  it("keeps a time-to-first-output histogram per provider family, model and what came first", () => {
    const aggregator = createTelemetryAggregator();
    const firstOutput = (runId: string, durationMs: number, after: "dispatch" | "tools", providerModelId = "model-1") =>
      aggregator.observe(Object.freeze(JSON.parse(serializeEvent("run_execution", { run_id: runId, stage: "first_output",
        outcome: "completed", duration_ms: durationMs, after, providerFamily: "openai", connectionId: "connection-1",
        providerModelId })!)));
    firstOutput("run-1", 800, "dispatch");
    firstOutput("run-2", 2_000, "dispatch");
    firstOutput("run-3", 40_000, "tools");
    firstOutput("run-4", 90, "dispatch", "model-2");
    const { counters, incidents } = aggregator.drain();
    expect(incidents).toEqual([]);
    const dimensions = { after: "dispatch", connectionId: "connection-1", outcome: "completed", providerFamily: "openai",
      providerModelId: "model-1", stage: "first_output" };
    expect(counters).toHaveLength(3);
    expect(counters).toContainEqual(expect.objectContaining({ event: "run_execution", level: "info", dimensions,
      count: 2, durationCount: 2, durationSumMs: 2_800, durationMaxMs: 2_000, durationBuckets: buckets({ 3: 1, 4: 1 }) }));
    expect(counters).toContainEqual(expect.objectContaining({ dimensions: { ...dimensions, after: "tools" },
      count: 1, durationBuckets: buckets({ 8: 1 }) }));
    expect(counters).toContainEqual(expect.objectContaining({ dimensions: { ...dimensions, providerModelId: "model-2" },
      count: 1, durationBuckets: buckets({ 0: 1 }) }));
    expect(JSON.stringify(counters)).not.toContain("run-");
  });

  it("keeps rate-limited error incidents with the record's remaining fields", () => {
    const aggregator = createTelemetryAggregator(limits({ incidentsPerMinute: 3, maxIncidents: 6 }));
    for (let index = 0; index < 5; index += 1) {
      aggregator.observe(record({ ...failed, httpStatus: 401, job_id: "job-1", run_id: "run-1" }, HOUR + index * 1_000));
    }
    aggregator.observe(record({ ...failed, connectionId: "connection-2" }));
    aggregator.observe(record({ ...failed, level: "fatal" }, HOUR + 60_000));
    aggregator.observe(record({ ...failed, level: "warn", outcome: "failed", action: "retry" }));
    aggregator.observe(record({ ...failed }, HOUR + 61_000));
    aggregator.observe(record({ ...failed, connectionId: "connection-3" }));

    const { counters, incidents } = aggregator.drain();
    expect(incidents.map((item) => [item.connectionId, item.level, item.occurredAt.getTime() - HOUR])).toEqual([
      ["connection-1", "error", 0], ["connection-1", "error", 1_000], ["connection-1", "error", 2_000],
      ["connection-2", "error", 60_000], ["connection-1", "fatal", 60_000], ["connection-1", "error", 61_000]
    ]);
    expect(incidents[0]).toEqual({
      occurredAt: new Date(HOUR), role: "app", event: "provider_operation", level: "error", appVersion: "0.3.7",
      instanceId: INSTANCE, code: "provider_http_dns_failed", subsystem: null, connectionId: "connection-1",
      runId: "run-1", traceId: "b".repeat(32),
      details: { outcome: "failed", stage: "answer", providerFamily: "openai", providerModelId: "model-1",
        httpStatus: 401, job_id: "job-1" }
    });
    // Suppressed and unadmitted incidents remain in the counters.
    expect(counters.filter((item) => item.level !== "warn").reduce((sum, item) => sum + item.count, 0)).toBe(9);
  });

  it("folds keys beyond the bound into a per-event overflow key and counts what still does not fit", () => {
    const aggregator = createTelemetryAggregator(limits({ maxCounterKeys: 2, maxOverflowKeys: 1 }));
    for (const code of ["first", "second", "third", "fourth"]) aggregator.observe(record({ ...failed, code, level: "warn" }));
    aggregator.observe(record({ ...failed, code: "third", level: "warn", duration_ms: 400 }));
    aggregator.observe(record({ event: "run_execution", level: "info", outcome: "completed" }));

    const { counters, lostObservations } = aggregator.drain();
    expect(counters.map((item) => [item.event, item.dimensions.code ?? null, item.dimensions.overflow ?? false, item.count]))
      .toEqual([
        ["provider_operation", "first", false, 1],
        ["provider_operation", "second", false, 1],
        ["provider_operation", null, true, 3]
      ]);
    expect(counters[2]).toMatchObject({ dimensions: { overflow: true }, durationCount: 1, durationMaxMs: 400,
      durationBuckets: buckets({ 2: 1 }) });
    expect(lostObservations).toBe(1);
  });

  it("hands a failed batch back without double counting, oldest incidents first and within bounds", () => {
    const aggregator = createTelemetryAggregator(limits({ maxIncidents: 3 }));
    aggregator.observe(record({ ...failed, duration_ms: 100 }));
    aggregator.observe(record({ ...failed, connectionId: "connection-2" }));
    const failedBatch = aggregator.drain();
    aggregator.observe(record({ ...failed, duration_ms: 900 }, HOUR + 30_000));
    aggregator.observe(record({ ...failed, connectionId: "connection-3" }, HOUR + 90_000));
    aggregator.observe(record({ ...failed, connectionId: "connection-4" }, HOUR + 91_000));
    aggregator.restore(failedBatch);

    const { counters, incidents } = aggregator.drain();
    expect(counters.find((item) => item.dimensions.connectionId === "connection-1")).toMatchObject({
      count: 2, durationCount: 2, durationSumMs: 1_000, durationMaxMs: 900,
      durationBuckets: buckets({ 0: 1, 3: 1 }), firstSeenAt: new Date(HOUR + 30_000), lastSeenAt: new Date(HOUR + 60_000)
    });
    expect(counters.reduce((sum, item) => sum + item.count, 0)).toBe(5);
    expect(incidents.map((item) => item.connectionId)).toEqual(["connection-1", "connection-2", "connection-1"]);

    const bounded = createTelemetryAggregator(limits({ maxCounterKeys: 1 }));
    bounded.observe(record({ ...failed, code: "first" }));
    const retry = bounded.drain();
    bounded.observe(record({ ...failed, code: "second" }));
    bounded.restore(retry);
    expect(bounded.drain().counters.map((item) => [item.dimensions.overflow === true, item.count])).toEqual([[false, 1], [true, 1]]);
  });

  it("skips malformed records without throwing", () => {
    const aggregator = createTelemetryAggregator();
    const hostile = Object.defineProperty({ ...record({}) }, "event", { enumerable: true, get() { throw new Error("canary"); } });
    for (const value of [null, "line", {}, record({ timestamp: "not-a-time" }), record({ level: "debug" }),
      record({ event: "" }), record({ role: "x".repeat(33) }), hostile]) {
      expect(() => aggregator.observe(value)).not.toThrow();
    }
    expect(aggregator.pending()).toEqual({ counters: 0, incidents: 0 });
    aggregator.observe(record({ ...failed, instance_id: "not-hex" }));
    expect(aggregator.pending()).toEqual({ counters: 1, incidents: 0 });
    aggregator.drain();

    // Values no leaf record carries never reach storage, where one would fail every retry of its batch.
    aggregator.observe(record({ ...failed, code: "bad\u0000code", stage: "line\nbreak", duration_ms: 2e10, count: 2 ** 40 }));
    const { counters: [counter], incidents: [incident] } = aggregator.drain();
    expect(counter!.dimensions).not.toHaveProperty("code");
    expect(counter!.dimensions).not.toHaveProperty("stage");
    expect(counter).toMatchObject({ count: 1, durationCount: 0, valueSum: 0 });
    expect(incident).toMatchObject({ code: null });
    expect(incident!.details).not.toHaveProperty("stage");
  });

  it("places durations in fixed inclusive buckets", () => {
    expect([0, 100, 101, 250, 1_000, 300_000, 300_001].map(telemetryDurationBucket)).toEqual([0, 0, 1, 1, 3, 10, 11]);
  });
});
