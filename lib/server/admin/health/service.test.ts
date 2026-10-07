import { describe, expect, it, vi } from "vitest";
import type { TelemetryCounterGroup, TelemetryCounterQuery, TelemetryIncident, TelemetryIncidentQuery } from "../../telemetry/store";
import { createAdminHealthService, type AdminHealthDependencies } from "./service";

const NOW = new Date("2026-10-07T12:30:00.000Z");
const CONNECTION = "conn-openai";
const MODEL = "model-gpt";

function group(fields: Partial<TelemetryCounterGroup> & Pick<TelemetryCounterGroup, "group" | "count">): TelemetryCounterGroup {
  return {
    valueSum: 0, durationCount: 0, durationSumMs: 0, durationMaxMs: null,
    durationBuckets: new Array<number>(12).fill(0),
    firstSeenAt: new Date("2026-10-07T10:00:00.000Z"), lastSeenAt: new Date("2026-10-07T10:30:00.000Z"),
    ...fields
  };
}

function buckets(entries: Readonly<Record<number, number>>): number[] {
  return Array.from({ length: 12 }, (_, index) => entries[index] ?? 0);
}

const totals = [
  group({ group: { event: "provider_operation", level: "error", role: "app" }, count: 3 }),
  group({ group: { event: "http.request_completed", level: "error", role: "app" }, count: 2 }),
  group({ group: { event: "http.request_failed", level: "error", role: "app" }, count: 1 }),
  group({ group: { event: "http.request_completed", level: "info", role: "app" }, count: 400 }),
  group({ group: { event: "process.started", level: "info", role: "app" }, count: 3 }),
  group({ group: { event: "process.started", level: "info", role: "memory_search" }, count: 1 }),
  group({ group: { event: "process.failure", level: "fatal", role: "app" }, count: 1 }),
  group({ group: { event: "logging.dropped_records", level: "warn", role: "app" }, count: 2, valueSum: 57 }),
  group({ group: { event: "client.error", level: "warn", role: "app" }, count: 4 })
];

const series = [
  group({ group: { bucket: new Date("2026-10-07T10:00:00.000Z"), event: "provider_operation" }, count: 3 }),
  group({ group: { bucket: new Date("2026-10-07T10:00:00.000Z"), event: "http.request_completed" }, count: 2 }),
  group({ group: { bucket: new Date("2026-10-07T11:00:00.000Z"), event: "job_attempt" }, count: 5 }),
  group({ group: { bucket: new Date("2026-10-07T11:00:00.000Z"), event: "process.failure" }, count: 1 }),
  // Outside the window: never placed in a bucket.
  group({ group: { bucket: new Date("2026-09-01T00:00:00.000Z"), event: "job_attempt" }, count: 9 })
];

const operation = (fields: Record<string, string | number | null>) => ({ connectionId: CONNECTION, providerModelId: MODEL, stage: "answer", ...fields });
const providers = [
  group({ group: operation({ outcome: "started", action: "none" }), count: 100 }),
  group({ group: operation({ outcome: "completed", action: "none" }), count: 90, durationBuckets: buckets({ 2: 85, 4: 5 }), durationMaxMs: 2_000 }),
  group({ group: operation({ outcome: "failed", action: "none", code: "provider_auth_rejected", reason: "http", httpStatus: 401 }), count: 4,
    lastSeenAt: new Date("2026-10-07T11:15:00.000Z") }),
  group({ group: operation({ outcome: "failed", action: "none", code: "provider_request_timed_out", reason: "deadline" }), count: 2,
    durationBuckets: buckets({ 8: 2 }), durationMaxMs: 60_000 }),
  group({ group: operation({ outcome: "failed", action: "retry", code: "provider_response_failed" }), count: 7 }),
  group({ group: operation({ outcome: "cancelled", action: "none" }), count: 5 }),
  group({ group: operation({ connectionId: "conn-gone", providerModelId: "model-gone", stage: "embedding", outcome: "completed", action: "none" }), count: 10 }),
  group({ group: operation({ connectionId: null, providerModelId: null, stage: null, outcome: null }), count: 3 })
];
const vision = [
  group({ group: { connectionId: CONNECTION, providerModelId: MODEL, outcome: "failed", action: null, code: "vision_analysis_timeout", reason: "deadline", httpStatus: null }, count: 3 }),
  group({ group: { connectionId: CONNECTION, providerModelId: MODEL, outcome: "completed", action: null, code: null, reason: null, httpStatus: null }, count: 5 })
];

function store(overrides: Partial<Record<"totals" | "previous" | "series" | "providers" | "vision", TelemetryCounterGroup[]>> = {}) {
  const queries: TelemetryCounterQuery[] = [];
  const readCounters = vi.fn(async (query: TelemetryCounterQuery) => {
    queries.push(query);
    if (query.events?.includes("provider_operation")) return overrides.providers ?? providers;
    if (query.events?.includes("tool_execution")) return overrides.vision ?? vision;
    if (query.groupBy?.includes("bucket")) return overrides.series ?? series;
    if (!query.groupBy) return overrides.previous ?? [group({ group: {}, count: 2 })];
    return overrides.totals ?? totals;
  });
  return { queries, readCounters, readIncidents: vi.fn() };
}

const names: AdminHealthDependencies["providerNames"] = vi.fn(async () => ({
  connections: new Map([[CONNECTION, "OpenAI production"]]),
  models: new Map([[MODEL, "GPT answer"]])
}));

describe("admin health service", () => {
  it("aggregates summary, category series and provider reliability from counter groups", async () => {
    const telemetry = store();
    const service = createAdminHealthService({ store: telemetry, providerNames: names, now: () => NOW });
    const health = await service.read("24h");

    expect(health).toMatchObject({ range: "24h", interval: "hour", hasTelemetry: true,
      from: "2026-10-06T13:00:00.000Z", to: "2026-10-07T13:00:00.000Z", generatedAt: NOW.toISOString() });
    expect(health.summary).toEqual({
      errors: 7, previousErrors: 2, providerOperations: 106, providerFailures: 6, providerFailureRate: 6 / 106,
      http5xx: 3, restarts: 2, roleStarts: [{ role: "app", starts: 3, restarts: 2 }, { role: "memory_search", starts: 1, restarts: 0 }],
      droppedLogRecords: 57, clientErrors: 4
    });

    expect(health.series).toHaveLength(24);
    const at = (iso: string) => health.series.find((bucket) => bucket.start === iso);
    expect(at("2026-10-07T10:00:00.000Z")).toEqual({ start: "2026-10-07T10:00:00.000Z", total: 5,
      counts: { providers: 3, requests: 2, runs: 0, background: 0, tools: 0, other: 0 } });
    expect(at("2026-10-07T11:00:00.000Z")?.counts).toMatchObject({ background: 5, other: 1 });
    expect(health.series.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(11);

    expect(health.providers.map((row) => [row.connectionName, row.modelName, row.stage, row.operations, row.failures])).toEqual([
      ["OpenAI production", "GPT answer", "answer", 96, 6],
      ["OpenAI production", "GPT answer", "vision", 8, 3],
      ["Deleted connection", "Deleted model", "embedding", 10, 0]
    ]);
    const answer = health.providers[0]!;
    expect(answer.failuresByClass).toEqual({ key_rejected: 4, quota: 0, provider_error: 0, timeout: 2, network: 0, other: 0 });
    expect(answer.failureRate).toBeCloseTo(6 / 96);
    // 92 timed durations: the 88th falls in (1000, 2500]; the 60 s maximum does not cap it.
    expect(answer.p95Ms).toBe(2_500);
    expect(answer.lastFailureAt).toBe("2026-10-07T11:15:00.000Z");
    expect(answer.connectionState).toBe("known");
    expect(health.providers[1]!.failuresByClass.timeout).toBe(3);
    expect(health.providers[2]).toMatchObject({ connectionState: "deleted", failureRate: 0, p95Ms: null, lastFailureAt: null });
    expect(health.providersTruncated).toBe(false);

    const providerQuery = telemetry.queries.find((query) => query.events?.includes("provider_operation"));
    expect(providerQuery?.groupBy).toHaveLength(8);
    expect(telemetry.queries.find((query) => query.events?.includes("tool_execution"))?.dimensions).toEqual({ tool_kind: "vision" });
    expect(names).toHaveBeenCalledWith({ connectionIds: [CONNECTION, "conn-gone"], modelIds: [MODEL, "model-gone"] });
  });

  it("reports a fresh installation as having no telemetry and no previous period past retention", async () => {
    const telemetry = store({ totals: [], series: [], providers: [], vision: [] });
    const service = createAdminHealthService({ store: telemetry, providerNames: names, now: () => NOW });
    const health = await service.read("30d");
    expect(health.hasTelemetry).toBe(false);
    expect(health.interval).toBe("day");
    expect(health.series).toHaveLength(30);
    expect(health.summary).toMatchObject({ errors: 0, previousErrors: null, providerFailureRate: null, restarts: 0 });
    expect(health.providers).toEqual([]);
    expect(telemetry.queries.some((query) => !query.groupBy)).toBe(false);
  });

  it("propagates a database failure instead of returning an empty view", async () => {
    const failing = { readCounters: vi.fn().mockRejectedValue(new Error("db down")), readIncidents: vi.fn() };
    const service = createAdminHealthService({ store: failing, providerNames: names, now: () => NOW });
    await expect(service.read("24h")).rejects.toThrow("db down");
  });
});

describe("admin health incidents", () => {
  const incident: TelemetryIncident = {
    id: "0b6c7f0e-5d1c-4a51-9df7-7d1fb0d6c111", occurredAt: new Date("2026-10-07T12:00:00.000Z"), role: "app",
    event: "provider_operation", level: "error", appVersion: "0.3.7", instanceId: "a".repeat(32),
    code: "provider_auth_rejected", subsystem: null, connectionId: CONNECTION, runId: "run-1", traceId: "b".repeat(32),
    details: { stage: "answer", outcome: "failed", httpStatus: 401, providerModelId: MODEL, duration_ms: 812,
      job_id: "job-secret", tool_call_id: "call-1", scope_id: "scope", generation_id: "gen" }
  };

  function incidentStore(items: TelemetryIncident[] = [incident]) {
    const readIncidents = vi.fn(async (query: TelemetryIncidentQuery) => {
      void query;
      return { items, nextCursor: "next" };
    });
    return { readCounters: vi.fn(), readIncidents };
  }

  const filters = { range: "24h" as const, category: null, code: null, cursor: null, event: null, level: null, q: null };

  it("projects incidents with provider names and only allowlisted details", async () => {
    const telemetry = incidentStore();
    const service = createAdminHealthService({ store: telemetry, providerNames: names, now: () => NOW });
    const page = await service.incidents(filters);
    expect(page.nextCursor).toBe("next");
    expect(page.incidents).toEqual([{
      id: incident.id, occurredAt: "2026-10-07T12:00:00.000Z", role: "app", event: "provider_operation", level: "error",
      code: "provider_auth_rejected", subsystem: null, stage: "answer", connectionId: CONNECTION,
      connectionName: "OpenAI production", modelName: "GPT answer", httpStatus: 401, runId: "run-1", traceId: "b".repeat(32),
      details: [{ key: "duration_ms", value: 812 }, { key: "outcome", value: "failed" }]
    }]);
    expect(JSON.stringify(page)).not.toMatch(/job-secret|call-1|scope|gen"/u);
    expect(telemetry.readIncidents).toHaveBeenCalledWith({ from: new Date("2026-10-06T12:30:00.000Z"), cursor: null, limit: 50 });
  });

  it("maps filters to the read: category events, exact code, level, and a trace or run reference", async () => {
    const telemetry = incidentStore([]);
    const service = createAdminHealthService({ store: telemetry, providerNames: names, now: () => NOW });
    await service.incidents({ ...filters, category: "requests", code: "unexpected", level: "fatal", q: "c".repeat(32), cursor: "abc" });
    expect(telemetry.readIncidents).toHaveBeenLastCalledWith(expect.objectContaining({
      events: ["http.request_completed", "http.request_failed"], codes: ["unexpected"], levels: ["fatal"],
      traceId: "c".repeat(32), cursor: "abc"
    }));
    await service.incidents({ ...filters, event: "run_execution", q: "run-42" });
    expect(telemetry.readIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ events: ["run_execution"], runId: "run-42" }));
    telemetry.readIncidents.mockClear();
    await expect(service.incidents({ ...filters, event: "run_execution", category: "tools" })).resolves.toEqual({ incidents: [], nextCursor: null });
    expect(telemetry.readIncidents).not.toHaveBeenCalled();
  });

  it("names an incident of a deleted connection without inventing one for unattributed records", async () => {
    const telemetry = incidentStore([{ ...incident, connectionId: "gone", details: {} }, { ...incident, id: "x", connectionId: null, details: {} }]);
    const service = createAdminHealthService({ store: telemetry, providerNames: names, now: () => NOW });
    const page = await service.incidents(filters);
    expect(page.incidents.map((item) => [item.connectionName, item.modelName, item.httpStatus])).toEqual([
      ["Deleted connection", null, null], [null, null, null]
    ]);
  });
});
