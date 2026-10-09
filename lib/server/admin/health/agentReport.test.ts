import { describe, expect, it, vi } from "vitest";
import type { AdminHealthQueueRow } from "../../../contracts/adminHealthQueues";
import type { AnswerProblemReportListRow } from "../../answerProblemReports/repository";
import { TELEMETRY_DURATION_BUCKETS, telemetryDurationBucket } from "../../telemetry/aggregator";
import type {
  TelemetryCounterGroup, TelemetryCounterQuery, TelemetryGroupKey, TelemetryIncident, TelemetryIncidentQuery
} from "../../telemetry/store";
import {
  collectHealthFullReport,
  collectHealthUserReport,
  HEALTH_FULL_FAILURE_LIMIT,
  HEALTH_NEWEST_INCIDENT_LIMIT,
  HEALTH_PROBLEM_REPORT_LIMIT,
  type HealthAgentReportSources
} from "./agentReport";
import { formatHealthFullReport, formatHealthUserReport } from "./agentReportText";
import type { FailedRunLoad } from "./failedRuns";
import { collectHealthReport, formatHealthReport, parseHealthReportArgs } from "./report";
import type { AdminHealthRunRow } from "./runLookup";
import { createAdminHealthService } from "./service";

// "7d" at this instant covers 2026-10-01T00:00Z to 2026-10-08T00:00Z; the
// previous period 2026-09-24 to 2026-10-01 is inside counter retention.
const NOW = new Date("2026-10-07T09:59:30.000Z");
const IN_RANGE = new Date("2026-10-06T10:00:00.000Z");
const PREVIOUS = new Date("2026-09-28T10:00:00.000Z");
const RUN_A = "1a2b3c4d-1111-4111-8111-111111111111";
const RUN_B = "5e6f7a8b-2222-4222-8222-222222222222";
const USER_A = "user_a";
const USER_B = "user_b";

type Counter = {
  bucketStart: Date; role: string; event: string; level: string; appVersion: string;
  dimensions: Record<string, string | number | boolean>; count: number; valueSum: number; durations: number[];
};

function counter(event: string, level: string, dimensions: Counter["dimensions"], count: number,
  options: Partial<Pick<Counter, "bucketStart" | "role" | "appVersion" | "valueSum" | "durations">> = {}): Counter {
  return { bucketStart: IN_RANGE, role: "app", appVersion: "1.4.0", valueSum: 0, durations: [], ...options, event, level, dimensions, count };
}

function incident(index: number, fields: Partial<TelemetryIncident> = {}): TelemetryIncident {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    occurredAt: new Date(IN_RANGE.getTime() + index * 1_000), role: "app", event: "provider_operation", level: "error",
    appVersion: "1.4.0", instanceId: "a".repeat(32), code: "provider_rate_limited", subsystem: null, connectionId: "conn-openai",
    runId: RUN_A, traceId: null, userId: USER_A,
    details: { stage: "answer", httpStatus: 429, providerModelId: "model-gpt", error_class: "ProviderError",
      error_site: "lib/server/providers/openai.ts:42", error_fingerprint: "0123456789ab" },
    ...fields
  };
}

function groupValue(row: Counter, key: TelemetryGroupKey): TelemetryCounterGroup["group"][TelemetryGroupKey] {
  if (key === "bucket") return row.bucketStart;
  if (key === "role" || key === "event" || key === "level" || key === "appVersion") return row[key];
  return row.dimensions[key] ?? null;
}

/** The store's read semantics over plain rows: filters, grouping, histogram sums, most records first, bounded. */
function memoryStore(counters: readonly Counter[], incidents: readonly TelemetryIncident[]): HealthAgentReportSources["store"] {
  const inRange = (time: Date, query: Readonly<{ from?: Date; to?: Date }>) =>
    (!query.from || time >= query.from) && (!query.to || time < query.to);
  const key = (item: TelemetryIncident) =>
    JSON.stringify([item.event, item.code, item.subsystem, item.connectionId, item.details.error_fingerprint ?? null]);
  const newestFirst = (left: TelemetryIncident, right: TelemetryIncident) =>
    right.occurredAt.getTime() - left.occurredAt.getTime() || (right.id < left.id ? -1 : 1);
  const matching = (query: TelemetryIncidentQuery) => incidents.filter((item) => inRange(item.occurredAt, query) &&
    (query.userId === undefined || item.userId === query.userId)).sort(newestFirst);
  return {
    async readCounters(query: TelemetryCounterQuery) {
      const groupBy = query.groupBy ?? [];
      const groups = new Map<string, Counter[]>();
      for (const row of counters) {
        if (!inRange(row.bucketStart, query) || (query.events && !query.events.includes(row.event)) ||
          (query.levels && !(query.levels as readonly string[]).includes(row.level)) ||
          (query.dimensions && !Object.entries(query.dimensions).every(([name, value]) => row.dimensions[name] === value))) continue;
        const id = JSON.stringify(groupBy.map((name) => groupValue(row, name)));
        groups.set(id, [...(groups.get(id) ?? []), row]);
      }
      return [...groups.values()].map((rows): TelemetryCounterGroup => {
        const buckets = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
        const durations = rows.flatMap((row) => row.durations);
        for (const value of durations) buckets[telemetryDurationBucket(value)]! += 1;
        return {
          group: Object.fromEntries(groupBy.map((name) => [name, groupValue(rows[0]!, name)])),
          count: rows.reduce((total, row) => total + row.count, 0),
          valueSum: rows.reduce((total, row) => total + row.valueSum, 0),
          durationCount: durations.length,
          durationSumMs: durations.reduce((total, value) => total + value, 0),
          durationMaxMs: durations.length > 0 ? Math.max(...durations) : null,
          durationBuckets: buckets,
          firstSeenAt: new Date(Math.min(...rows.map((row) => row.bucketStart.getTime()))),
          lastSeenAt: new Date(Math.max(...rows.map((row) => row.bucketStart.getTime() + 60_000)))
        };
      }).sort((left, right) => right.count - left.count).slice(0, query.limit ?? 1_000);
    },
    async readIncidents(query) {
      const all = matching(query);
      const start = query.cursor ? Number(query.cursor) : 0;
      const size = query.limit ?? 50;
      const items = all.slice(start, start + size);
      return { items, nextCursor: start + size < all.length ? String(start + size) : null };
    },
    async readFirstIncidentPerKey(query) {
      const firsts = new Map<string, TelemetryIncident>();
      for (const item of matching(query).reverse()) if (!firsts.has(key(item))) firsts.set(key(item), item);
      const items = [...firsts.values()].sort(newestFirst);
      const limit = query.limit ?? 100;
      return { items: items.slice(0, limit), truncated: items.length > limit };
    },
    async countIncidentReachByKey(query) {
      const groups = new Map<string, TelemetryIncident[]>();
      for (const item of matching(query)) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
      return [...groups.values()].map((items) => ({
        key: { event: items[0]!.event, code: items[0]!.code, subsystem: items[0]!.subsystem, connectionId: items[0]!.connectionId,
          fingerprint: typeof items[0]!.details.error_fingerprint === "string" ? items[0]!.details.error_fingerprint : null },
        incidents: items.length,
        users: new Set(items.map((item) => item.userId).filter(Boolean)).size,
        runs: new Set(items.map((item) => item.runId).filter(Boolean)).size,
        firstAt: items.at(-1)!.occurredAt,
        lastAt: items[0]!.occurredAt
      })).sort((left, right) => right.incidents - left.incidents).slice(0, query.limit ?? 100);
    },
    async countIncidentReachByFingerprint(query) {
      expect(query.fingerprints.length).toBeLessThanOrEqual(64);
      const result = new Map<string, { incidents: number; users: number; runs: number }>();
      for (const fingerprint of query.fingerprints) {
        const items = matching(query).filter((item) => item.details.error_fingerprint === fingerprint);
        if (items.length > 0) {
          result.set(fingerprint, { incidents: items.length, users: new Set(items.map((item) => item.userId).filter(Boolean)).size,
            runs: new Set(items.map((item) => item.runId).filter(Boolean)).size });
        }
      }
      return result;
    },
    async countIncidentsByRun(runIds) {
      expect(runIds.length).toBeLessThanOrEqual(64);
      return new Map(runIds.map((id) => [id, incidents.filter((item) => item.runId === id).length] as const)
        .filter(([, count]) => count > 0));
    }
  };
}

const queueRows: AdminHealthQueueRow[] = [
  { queue: "chat_titles", state: "stalled", waiting: 4, running: 0, oldestSeconds: 3 * 3_600, failed24h: 0,
    slowAfterSeconds: 600, stalledAfterSeconds: 1_800 },
  { queue: "memory", state: "ok", waiting: 0, running: 0, oldestSeconds: null, failed24h: 0, slowAfterSeconds: 600, stalledAfterSeconds: 1_800 }
];

function report(index: number, userId: string, fields: Partial<AnswerProblemReportListRow> = {}): AnswerProblemReportListRow {
  return {
    id: `report-${index}`, reason: "error_or_broken", comment: "It stopped\u001b[31m halfway\nthrough", createdAt: IN_RANGE,
    updatedAt: new Date(IN_RANGE.getTime() + 3_600_000), runId: RUN_A,
    user: { id: userId, displayName: "Private Person", email: "private@example.com" }, connectionName: "OpenAI", modelName: "gpt-5",
    ...fields
  };
}

const runRow: AdminHealthRunRow = {
  id: RUN_A, status: "error", createdAt: IN_RANGE, updatedAt: new Date(IN_RANGE.getTime() + 12_300), failureCode: "provider_rate_limited",
  connectionId: "conn-openai", connectionName: "OpenAI", providerModelId: "model-gpt", modelDisplayName: "gpt-5", modelProviderId: "gpt-5"
};

const failedRunLoad: FailedRunLoad = {
  runs: 3, users: 2, groupsTruncated: false,
  groups: [
    { code: "provider_server_error", runs: 2, users: 2, firstAt: IN_RANGE, lastAt: new Date(IN_RANGE.getTime() + 60_000), newest: [
      { runId: RUN_B, userId: USER_B, startedAt: new Date(IN_RANGE.getTime() + 60_000) },
      { runId: RUN_A, userId: USER_A, startedAt: IN_RANGE }
    ] },
    { code: "workspace_output_export_failed", runs: 1, users: 1, firstAt: IN_RANGE, lastAt: IN_RANGE, newest: [
      { runId: RUN_A, userId: USER_A, startedAt: IN_RANGE }
    ] }
  ]
};

function sources(counters: readonly Counter[], incidents: readonly TelemetryIncident[], overrides: Partial<HealthAgentReportSources> = {}) {
  return {
    store: memoryStore(counters, incidents),
    providerNames: vi.fn().mockResolvedValue({ connections: new Map([["conn-openai", "OpenAI"]]), models: new Map([["model-gpt", "gpt-5"]]) }),
    queues: { read: vi.fn().mockResolvedValue({ checkedAt: NOW.toISOString(), queues: queueRows }) },
    problemReports: vi.fn(async (query: { userId?: string }) => {
      const rows = [report(1, USER_A), report(2, USER_B, { comment: null, runId: null })]
        .filter((row) => query.userId === undefined || row.user.id === query.userId);
      return { rows, total: rows.length };
    }),
    failedRuns: vi.fn().mockResolvedValue([runRow]),
    failedRunGroups: vi.fn().mockResolvedValue(failedRunLoad),
    userExists: vi.fn().mockResolvedValue(true),
    now: () => NOW,
    ...overrides
  } satisfies HealthAgentReportSources;
}

const identity = { providerFamily: "openai", connectionId: "conn-openai", providerModelId: "model-gpt" };
const fixtureCounters: Counter[] = [
  // Runs: settled once each by their terminal write; execution records do not count.
  counter("run_accepted", "info", { kind: "send" }, 5),
  counter("run_accepted", "info", { kind: "regenerate" }, 2),
  counter("run_accepted", "info", { kind: "project" }, 1),
  counter("run_persistence", "info", { stage: "complete", outcome: "confirmed" }, 4),
  counter("run_persistence", "info", { stage: "fail", outcome: "confirmed" }, 1),
  counter("run_persistence", "info", { stage: "fail", outcome: "not_applied" }, 1),
  counter("run_persistence", "info", { stage: "cancel", outcome: "confirmed" }, 1),
  counter("run_persistence", "info", { stage: "preparation", outcome: "confirmed" }, 1),
  counter("run_persistence", "error", { stage: "complete", outcome: "unconfirmed", prisma_code: "P1001" }, 1),
  counter("job_persistence", "info", { subsystem: "run_recovery", stage: "fail", outcome: "confirmed" }, 1),
  counter("job_persistence", "info", { subsystem: "memory", stage: "fail", outcome: "confirmed" }, 7),
  counter("run_execution", "error", { stage: "execution", outcome: "failed", code: "provider_rate_limited", ...identity }, 3),
  counter("run_stop_requested", "info", {}, 2),
  counter("run_accepted", "info", { kind: "send" }, 6, { bucketStart: PREVIOUS }),
  counter("run_persistence", "info", { stage: "complete", outcome: "confirmed" }, 6, { bucketStart: PREVIOUS }),
  // Latency.
  counter("run_execution", "info", { stage: "execution", outcome: "completed", ...identity }, 4, { durations: [800, 2_000, 2_400, 25_000] }),
  counter("run_execution", "info", { stage: "first_output", outcome: "completed", after: "dispatch", ...identity }, 2, { durations: [400, 900] }),
  counter("run_execution", "info", { stage: "first_output", outcome: "completed", after: "tools", ...identity }, 1, { durations: [7_000] }),
  // Warn-level timeouts, HTTP 4xx and an error with two versions.
  counter("nested_abort", "warn", { layer: "provider", stage: "delivery", abort_source: "provider_deadline", operation: "answer",
    providerFamily: "openai" }, 3),
  counter("nested_abort", "info", { layer: "tool", stage: "delivery", abort_source: "parent_signal" }, 9),
  counter("transport_stage", "warn", { transport: "provider", stage: "stream", outcome: "failed", category: "timeout",
    providerFamily: "openai" }, 2),
  counter("tool_call", "warn", { tool_kind: "fetch_url", outcome: "timeout", code: "fetch_url_timeout" }, 1, { durations: [15_000] }),
  counter("tool_call", "info", { tool_kind: "fetch_url", outcome: "completed" }, 3, { durations: [300, 600, 900] }),
  counter("tool_call", "warn", { tool_kind: "mcp", outcome: "failed", code: "mcp_tool_failed" }, 2, { durations: [100, 120] }),
  counter("run_execution", "error", { stage: "execution", outcome: "failed", reason: "deadline", abort_source: "workspace_deadline",
    code: "workspace_tool_timeout" }, 1),
  counter("http.request_completed", "warn", { routePath: "/api/chats/[chatId]", method: "GET", status: 404, outcome: "completed" }, 6),
  counter("http.request_completed", "error", { routePath: "/api/runs", method: "POST", status: 502, outcome: "completed" }, 1),
  counter("http.request_completed", "info", { routePath: "/api/runs", method: "POST", status: 200, outcome: "completed" }, 50),
  counter("client.error", "warn", { kind: "render", routePath: "/chat/[chatId]", route_source: "manifest" }, 2),
  counter("provider_operation", "error", { ...identity, stage: "answer", outcome: "failed", code: "provider_rate_limited",
    httpStatus: 429, error_fingerprint: "0123456789ab", error_class: "ProviderError", error_site: "lib/server/providers/openai.ts:42" },
  4, { appVersion: "1.3.9" }),
  counter("provider_operation", "error", { ...identity, stage: "answer", outcome: "failed", code: "provider_rate_limited",
    httpStatus: 429, error_fingerprint: "0123456789ab", error_class: "ProviderError", error_site: "lib/server/providers/openai.ts:42" }, 2),
  counter("provider_operation", "error", { overflow: true }, 5),
  // Sign-ins.
  counter("sign_in", "info", { sign_in_method: "oidc", step: "callback", outcome: "succeeded", code: "signed_in" }, 10),
  counter("sign_in", "warn", { sign_in_method: "oidc", step: "callback", outcome: "failed", code: "oidc_state_invalid" }, 2),
  // Operations.
  counter("process.started", "info", {}, 2),
  counter("process.started", "info", {}, 1, { role: "memory_coordinator" }),
  counter("logging.dropped_records", "warn", {}, 2, { valueSum: 37 }),
  counter("readiness.changed", "warn", { state: "not_ready", code: "database_unavailable" }, 1),
  counter("readiness.changed", "info", { state: "ready" }, 1),
  counter("runtime_lifecycle", "error", { subsystem: "telemetry", stage: "write", outcome: "failed", code: "telemetry_write_failed",
    action: "retry" }, 1),
  counter("runtime_lifecycle", "error", { subsystem: "memory", stage: "write", outcome: "failed", code: "memory_failed" }, 1)
];

const fixtureIncidents: TelemetryIncident[] = [
  incident(1),
  incident(2, { userId: USER_B, runId: RUN_B }),
  incident(3, { event: "process.failure", level: "fatal", code: null, connectionId: null, runId: null, userId: null, details: {} }),
  incident(4, { occurredAt: PREVIOUS })
];

describe("full agent report", () => {
  it("returns every section with counts, flags and the privacy marker first", async () => {
    const input = sources(fixtureCounters, fixtureIncidents);
    const full = await collectHealthFullReport(input, "7d");
    expect(Object.keys(full)).toEqual(["privacy", "kind", "version", "range", "from", "to", "generatedAt", "hasTelemetry",
      "previousPeriod", "runs", "failedRuns", "latency", "failures", "timeouts", "errorGroups", "signIns", "toolCalls", "http",
      "problemReports", "incidents", "operations"]);
    expect(full).toMatchObject({ privacy: "contains_user_ids_and_comments", kind: "full", version: 1, range: "7d",
      from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z", hasTelemetry: true,
      previousPeriod: { from: "2026-09-24T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" } });

    expect(full.runs).toEqual({
      accepted: 8, acceptedByKind: { send: 5, regenerate: 2, project: 1 }, completed: 4, failed: 3, failedInPreparation: 1,
      failedInRecovery: 1, cancelled: 1, unconfirmed: 1, failureRate: 3 / 8, cancelRate: 1 / 8, stopRequests: 2,
      previous: expect.objectContaining({ accepted: 6, completed: 6, failed: 0, failureRate: 0, stopRequests: 0 })
    });

    expect(input.failedRunGroups).toHaveBeenCalledWith({ from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-08T00:00:00.000Z"), perCode: 20, groupLimit: 200 });
    expect(full.failedRuns).toEqual({ runs: 3, users: 2, truncated: false, rows: [
      { failureCode: "provider_server_error", runs: 2, users: 2, firstAt: "2026-10-06T10:00:00.000Z", lastAt: "2026-10-06T10:01:00.000Z",
        newest: [
          { runId: RUN_B, runReference: "5e6f7a8b", userId: USER_B, startedAt: "2026-10-06T10:01:00.000Z" },
          { runId: RUN_A, runReference: "1a2b3c4d", userId: USER_A, startedAt: "2026-10-06T10:00:00.000Z" }
        ] },
      { failureCode: "workspace_output_export_failed", runs: 1, users: 1, firstAt: "2026-10-06T10:00:00.000Z",
        lastAt: "2026-10-06T10:00:00.000Z",
        newest: [{ runId: RUN_A, runReference: "1a2b3c4d", userId: USER_A, startedAt: "2026-10-06T10:00:00.000Z" }] }
    ] });

    expect(full.latency.runDuration).toMatchObject({ measured: 4, p50Ms: 2_500, p95Ms: 25_000, maxMs: 25_000 });
    expect(full.latency.runDuration.byProvider).toEqual([expect.objectContaining({
      providerFamily: "openai", connectionName: "OpenAI", modelName: "gpt-5", measured: 4 })]);
    expect(full.latency.firstOutput).toMatchObject({ measured: 3, p50Ms: 1_000, p95Ms: 7_000 });
    expect(full.latency.firstOutput.byAfter.map((row) => [row.after, row.measured, row.p95Ms])).toEqual([["dispatch", 2, 900], ["tools", 1, 7_000]]);

    const failure = (event: string) => full.failures.rows.filter((row) => row.event === event);
    expect(failure("provider_operation")).toEqual([
      expect.objectContaining({ level: "error", code: "provider_rate_limited", httpStatus: 429, providerFamily: "openai", stage: "answer",
        count: 6, appVersions: ["1.3.9", "1.4.0"], overflow: false }),
      expect.objectContaining({ code: null, count: 5, overflow: true })
    ]);
    expect(failure("nested_abort")).toEqual([expect.objectContaining({ level: "warn", count: 3 })]);
    expect(failure("http.request_completed").map((row) => [row.level, row.status, row.routePath])).toEqual([
      ["warn", 404, "/api/chats/[chatId]"], ["error", 502, "/api/runs"]]);
    expect(failure("run_persistence")).toEqual([expect.objectContaining({ level: "error", stage: "complete", count: 1 })]);
    expect(full.failures.rows.every((row) => row.level !== "info")).toBe(true);
    expect(full.failures.truncated).toBe(false);

    expect(full.timeouts.rows.map((row) => [row.event, row.layer, row.abortSource, row.toolKind, row.count])).toEqual([
      ["nested_abort", "provider", "provider_deadline", null, 3],
      ["transport_stage", "provider", null, null, 2],
      ["tool_call", "tool", null, "fetch_url", 1],
      ["run_execution", "run", "workspace_deadline", null, 1]
    ]);

    expect(full.errorGroups).toEqual({ truncated: false, rows: [expect.objectContaining({
      fingerprint: "0123456789ab", errorClass: "ProviderError", count: 6, usersAtLeast: 2, runsAtLeast: 2, newInRange: true })] });
    expect(full.signIns.rows.map((row) => [row.method, row.step, row.outcome, row.code, row.count])).toEqual([
      ["oidc", "callback", "succeeded", "signed_in", 10], ["oidc", "callback", "failed", "oidc_state_invalid", 2]]);
    expect(full.toolCalls.families).toEqual([
      expect.objectContaining({ toolKind: "fetch_url", calls: 4, failed: 0, timedOut: 1, measured: 4, p95Ms: 15_000 }),
      expect.objectContaining({ toolKind: "mcp", calls: 2, failed: 2, timedOut: 0 })
    ]);
    expect(full.http.rows.map((row) => row.status)).toEqual([404, 502]);
    expect(full.http.clientErrors).toEqual([expect.objectContaining({ kind: "render", routePath: "/chat/[chatId]", count: 2 })]);

    expect(input.problemReports).toHaveBeenCalledWith({ from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-08T00:00:00.000Z"),
      limit: HEALTH_PROBLEM_REPORT_LIMIT });
    expect(full.problemReports).toEqual({ total: 2, truncated: false, rows: [
      expect.objectContaining({ userId: USER_A, runId: RUN_A, runReference: "1a2b3c4d", reason: "error_or_broken",
        comment: "It stopped\u001b[31m halfway\nthrough", modelName: "gpt-5" }),
      expect.objectContaining({ userId: USER_B, runId: null, runReference: null, comment: null })
    ] });

    expect(full.incidents.rows.map((row) => [row.code, row.userId, row.runReference, row.firstOfKey])).toEqual([
      [null, null, null, true], ["provider_rate_limited", USER_B, "5e6f7a8b", false], ["provider_rate_limited", USER_A, "1a2b3c4d", true]]);
    expect(full.incidents.rows[2]).toMatchObject({ errorClass: "ProviderError", errorSite: "lib/server/providers/openai.ts:42",
      fingerprint: "0123456789ab", appVersion: "1.4.0", connectionName: "OpenAI", modelName: "gpt-5", httpStatus: 429 });
    expect(full.incidents).toMatchObject({ newestLimit: HEALTH_NEWEST_INCIDENT_LIMIT, newestTruncated: false, firstOfKeyTruncated: false,
      keysTruncated: false });
    expect(full.incidents.keys).toEqual([
      expect.objectContaining({ event: "provider_operation", incidents: 2, usersAtLeast: 2, runsAtLeast: 2, connectionName: "OpenAI" }),
      expect.objectContaining({ event: "process.failure", incidents: 1, usersAtLeast: 0 })
    ]);

    expect(full.operations).toMatchObject({
      roleStarts: [{ role: "app", starts: 2, restarts: 1 }, { role: "memory_coordinator", starts: 1, restarts: 0 }],
      queues: queueRows, droppedLogRecords: { records: 37, reports: 2 }, truncated: false,
      telemetry: [expect.objectContaining({ stage: "write", code: "telemetry_write_failed", action: "retry", count: 1 })],
      readiness: [expect.objectContaining({ state: "not_ready", code: "database_unavailable" }), expect.objectContaining({ state: "ready" })]
    });

    const json = JSON.stringify(full);
    expect(JSON.parse(json)).toEqual(full);
    expect(json).not.toMatch(/Private Person|private@example\.com|displayName|email/u);
  });

  it("lists warn-level timeouts and HTTP 4xx that the default report leaves out", async () => {
    const input = sources(fixtureCounters, fixtureIncidents);
    const health = createAdminHealthService({ store: input.store, providerNames: input.providerNames, now: () => NOW });
    const defaultReport = await collectHealthReport({
      health, queues: input.queues, findings: vi.fn().mockResolvedValue([]), connections: vi.fn().mockResolvedValue([]),
      failedRuns: input.failedRunGroups
    }, "7d");
    const defaultOutput = JSON.stringify(defaultReport) + formatHealthReport(defaultReport);
    const full = await collectHealthFullReport(input, "7d");
    const fullOutput = JSON.stringify(full) + formatHealthFullReport(full);
    for (const marker of ["nested_abort", "provider_deadline", "/api/chats/[chatId]", "oidc_state_invalid", "fetch_url_timeout"]) {
      expect(defaultOutput).not.toContain(marker);
      expect(fullOutput).toContain(marker);
    }
    expect(defaultOutput).not.toContain(USER_A);
    expect(fullOutput).toContain(USER_A);
  });

  it("keeps at most four reads in flight so a small database pool never times out", async () => {
    const input = sources(fixtureCounters, fixtureIncidents);
    let inFlight = 0;
    let most = 0;
    const slow = <A extends unknown[], R>(read: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await read(...args);
      } finally {
        inFlight -= 1;
      }
    };
    const store = input.store;
    const full = await collectHealthFullReport({ ...input, store: {
      readCounters: slow(store.readCounters), readIncidents: slow(store.readIncidents), countIncidentsByRun: slow(store.countIncidentsByRun),
      countIncidentReachByFingerprint: slow(store.countIncidentReachByFingerprint), countIncidentReachByKey: slow(store.countIncidentReachByKey),
      readFirstIncidentPerKey: slow(store.readFirstIncidentPerKey)
    } }, "7d");
    expect(full.runs.accepted).toBe(8);
    expect(most).toBe(4);
  });

  it("stays bounded and says so when a range holds thousands of keys and incidents", async () => {
    const counters = Array.from({ length: 6_000 }, (_, index) => counter("service_operation", "error",
      { subsystem: "memory", stage: "write", outcome: "failed", code: `memory_code_${index}`, error_fingerprint: index.toString(16).padStart(12, "0"),
        error_class: "Error", error_site: `lib/server/memory/x${index}.ts:1` }, 1 + (index % 7)));
    const incidents = Array.from({ length: 3_000 }, (_, index) => incident(index, { code: `memory_code_${index % 1_500}` }));
    const many = Array.from({ length: 600 }, (_, index) => report(index, `user_${index}`, { comment: "x".repeat(1_000) }));
    const full = await collectHealthFullReport(sources(counters, incidents, {
      problemReports: vi.fn(async (query: { limit: number }) => ({ rows: many.slice(0, query.limit), total: many.length }))
    }), "7d");
    expect(full.failures.rows).toHaveLength(HEALTH_FULL_FAILURE_LIMIT);
    expect(full.failures.truncated).toBe(true);
    expect(full.errorGroups.rows).toHaveLength(500);
    expect(full.errorGroups.truncated).toBe(true);
    expect(full.problemReports).toMatchObject({ total: 600, truncated: true });
    expect(full.problemReports.rows).toHaveLength(HEALTH_PROBLEM_REPORT_LIMIT);
    expect(full.incidents.newestTruncated).toBe(true);
    expect(full.incidents.firstOfKeyTruncated).toBe(true);
    expect(full.incidents.keysTruncated).toBe(true);
    expect(full.incidents.keys).toHaveLength(1_000);
    expect(full.incidents.rows.length).toBeGreaterThan(HEALTH_NEWEST_INCIDENT_LIMIT);
    expect(full.incidents.rows.length).toBeLessThanOrEqual(2 * HEALTH_NEWEST_INCIDENT_LIMIT);
    const json = JSON.stringify(full, null, 2);
    expect(json.length).toBeLessThan(6_000_000);
    const text = formatHealthFullReport(full);
    expect(text.length).toBeLessThan(3_000_000);
    expect(text).toContain("Failures: warn, error and fatal records by key (2000 shown; more exist)");
  });
});

describe("user agent report", () => {
  it("returns only that user's incidents, failed runs and problem reports", async () => {
    const input = sources(fixtureCounters, fixtureIncidents);
    const user = await collectHealthUserReport(input, USER_A, "7d");
    expect(Object.keys(user)).toEqual(["privacy", "kind", "version", "userId", "userExists", "range", "from", "to", "generatedAt",
      "incidents", "failedRuns", "problemReports"]);
    expect(user).toMatchObject({ privacy: "contains_user_ids_and_comments", kind: "user", userId: USER_A, userExists: true });
    expect(user.incidents.rows.map((row) => row.userId)).toEqual([USER_A]);
    expect(input.failedRuns).toHaveBeenCalledWith({ from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-08T00:00:00.000Z"),
      userId: USER_A, limit: 501 });
    expect(user.failedRuns).toEqual({ truncated: false, rows: [expect.objectContaining({
      runId: RUN_A, runReference: "1a2b3c4d", status: "error", failureCode: "provider_rate_limited", incidentCount: 2, durationMs: 12_300 })] });
    expect(input.problemReports).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_A }));
    expect(user.problemReports.rows.map((row) => row.userId)).toEqual([USER_A]);
    expect(JSON.stringify(user)).not.toContain(USER_B);

    const text = formatHealthUserReport(user);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "PRIVATE: contains internal user ids and problem-report comments. Keep it on the host; do not paste it anywhere.",
      "AIQSA health · user user_a · last 7 days · 2026-10-01 00:00 to 2026-10-08 00:00 UTC",
      ""
    ]);
    expect(text).toContain(`  ${RUN_A}  ref 1a2b3c4d\n    error · started 2026-10-06 10:00:00 UTC · took 12.3 s\n` +
      "    failure provider_rate_limited · OpenAI · gpt-5 · 2 incidents\n");
    expect(text).not.toContain(USER_B);
  });

  it("says when no account has the id and lists nothing", async () => {
    const user = await collectHealthUserReport(sources([], [], {
      userExists: vi.fn().mockResolvedValue(false), failedRuns: vi.fn().mockResolvedValue([])
    }), "nobody", "24h");
    expect(user).toMatchObject({ userExists: false, incidents: { rows: [] }, failedRuns: { rows: [] }, problemReports: { rows: [], total: 0 } });
    expect(formatHealthUserReport(user)).toContain("No account has this id (any more).\n");
  });
});

describe("full agent report text", () => {
  it("starts with the privacy line, prints every section within 100 columns and neutralizes comments", async () => {
    const text = formatHealthFullReport(await collectHealthFullReport(sources(fixtureCounters, fixtureIncidents), "7d"));
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("PRIVATE: contains internal user ids and problem-report comments. Keep it on the host; do not paste it anywhere.");
    expect(lines[1]).toBe("AIQSA health · full report · last 7 days · 2026-10-01 00:00 to 2026-10-08 00:00 UTC");
    expect(lines.slice(2).every((line) => line.length <= 100)).toBe(true);
    // Sections by user impact: failed runs and user reports first, then failures, then performance and operations.
    expect(lines.filter((line) => /^[A-Z]/u.test(line)).slice(3)).toEqual([
      "Failed runs by code (3 runs, 2 users; no stops or refused input)",
      "Answer problem reports (2, newest first)",
      "Runs (accepted runs; outcomes counted once per run from its terminal write)",
      "Error groups (class · where in AIQSA; NEW = first seen in this range) (1)",
      "Failures: warn, error and fatal records by key (17)",
      "Timeouts: deadline aborts, transport timeouts, tool and run deadlines (4)",
      "Tool calls by family, then calls that did not complete by code (2)",
      "HTTP: 4xx and 5xx responses and failed requests by route (3)",
      "Sign-in outcomes by method, step and code (2)",
      "Incidents (UTC, newest first; 3 listed)",
      "Incident keys (event · code · subsystem · connection · fingerprint), most incidents first (2)",
      "Latency (percentiles are histogram bucket upper bounds)",
      "Operations",
      "Drill in: ./aiqsa.sh health --run <reference> · ./aiqsa.sh health --user <user id>"
    ]);
    expect(text).toContain("Failed runs by code (3 runs, 2 users; no stops or refused input)\n" +
      "  code provider_server_error · 2 runs · 2 users\n" +
      "      first 2026-10-06 10:00 · last 2026-10-06 10:01\n" +
      "      ref 5e6f7a8b user user_b 2026-10-06 10:01 · ref 1a2b3c4d user user_a 2026-10-06 10:00\n" +
      "  code workspace_output_export_failed · 1 run · 1 user\n" +
      "      first 2026-10-06 10:00 · last 2026-10-06 10:00\n" +
      "      ref 1a2b3c4d user user_a 2026-10-06 10:00\n");
    const empty = formatHealthFullReport(await collectHealthFullReport(sources(fixtureCounters, fixtureIncidents, {
      failedRunGroups: vi.fn().mockResolvedValue({ runs: 0, users: 0, groups: [], groupsTruncated: false })
    }), "7d"));
    expect(empty).toContain("Failed runs by code (0 runs, 0 users; no stops or refused input)\n  none\n");
    expect(text).toContain("  accepted 8: send 5 · regenerate 2 · project 1\n" +
      "  completed 4 · failed 3 (37.5%) · cancelled 1 (12.5%) · stop requests 2\n");
    expect(text).toContain("  run duration      4 measured · p50 ≤ 2.5 s · p95 ≤ 25.0 s · max 25.0 s\n");
    expect(text).toContain("  WARN   nested_abort · stage delivery · openai\n");
    expect(text).toContain('      comment: "It stopped [31m halfway through"\n');
    expect(text).not.toContain("\u001b");
    expect(text).toContain("      user user_a · version 1.4.0 · fingerprint 0123456789ab · first of its key\n");
  });
});

describe("agent report arguments", () => {
  it("accepts --full and --user with a range and keeps the default arguments unchanged", () => {
    expect(parseHealthReportArgs(["--full", "--since", "14d", "--json"])).toEqual({ help: false, json: true, range: "14d", run: null, full: true });
    expect(parseHealthReportArgs(["--user=user_a-1"])).toEqual({ help: false, json: false, range: "24h", run: null, user: "user_a-1" });
    expect(Object.keys(parseHealthReportArgs(["--json"]))).toEqual(["help", "json", "range", "run"]);
  });

  it.each([
    [["--full", "--full"], "--full was given twice."],
    [["--full=yes"], "--full takes no value."],
    [["--user"], "--user needs an internal user id"],
    [["--user", "-x"], "--user needs an internal user id"],
    [["--user", "a b"], "--user needs an internal user id"],
    [["--user", "a", "--user", "b"], "--user was given twice."],
    [["--run", "1a2b3c4d", "--full"], "--run and --full are mutually exclusive."],
    [["--run", "1a2b3c4d", "--user", "a"], "--run and --user are mutually exclusive."],
    [["--full", "--user", "a"], "--full and --user are mutually exclusive."]
  ])("refuses %j", (argv, message) => {
    const parsed = parseHealthReportArgs(argv);
    expect("error" in parsed && parsed.error).toContain(message);
  });
});
