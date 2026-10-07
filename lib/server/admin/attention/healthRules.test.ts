import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import type { TelemetryCounterGroup } from "../../telemetry/store";
import {
  evaluateHealthRules,
  healthAttentionItems,
  readHealthCounterRows,
  type HealthCounterRows,
  type HealthFinding
} from "./healthRules";

const now = new Date("2026-10-07T12:20:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function row(group: Record<string, string | number | null>, count: number, lastSeenMinutesAgo = 5, valueSum = 0): TelemetryCounterGroup {
  return {
    count,
    durationBuckets: [],
    durationCount: 0,
    durationMaxMs: null,
    durationSumMs: 0,
    firstSeenAt: minutesAgo(lastSeenMinutesAgo + 1),
    group,
    lastSeenAt: minutesAgo(lastSeenMinutesAgo),
    valueSum
  };
}

function rows(overrides: Partial<HealthCounterRows> = {}): HealthCounterRows {
  return {
    backgroundErrors: [],
    droppedRecords: [],
    jobOutcomes: [],
    processStarts: [],
    providerOperations: [],
    serverErrors: [],
    toolOutcomes: [],
    ...overrides
  };
}

const provider = (connectionId: string, fields: Record<string, string | number | null>, count: number, ago = 5) =>
  row({ connectionId, ...fields }, count, ago);
const completed = (connectionId: string, count: number, ago = 5) => provider(connectionId, { outcome: "completed", action: "none" }, count, ago);
const failed = (connectionId: string, fields: Record<string, string | number | null>, count: number, ago = 5) =>
  provider(connectionId, { outcome: "failed", action: "none", ...fields }, count, ago);

describe("evaluateHealthRules", () => {
  it("raises a rejected key when the last 401 is newer than the last success, and clears after a later success", () => {
    const rejected = evaluateHealthRules(rows({ providerOperations: [
      completed("conn-1", 40, 30),
      failed("conn-1", { code: "provider_auth_rejected", httpStatus: 401, reason: "http" }, 3, 2)
    ] }), now);
    expect(rejected).toEqual([{ code: "provider_runtime_key_rejected", connectionId: "conn-1", failures: 3 }]);

    const recovered = evaluateHealthRules(rows({ providerOperations: [
      failed("conn-1", { code: "provider_auth_rejected", httpStatus: 401, reason: "http" }, 3, 10),
      completed("conn-1", 2, 1)
    ] }), now);
    expect(recovered).toEqual([]);
  });

  it("recognizes 403 and quota exhaustion by status as well as by class", () => {
    const findings = evaluateHealthRules(rows({ providerOperations: [
      failed("conn-1", { code: "unknown", httpStatus: 403, reason: "http" }, 1),
      failed("conn-2", { code: "provider_response_not_retryable", httpStatus: 402, reason: "http" }, 2),
      failed("conn-3", { code: "provider_quota_exhausted", httpStatus: 429, reason: "http" }, 1)
    ] }), now);
    expect(findings).toEqual([
      { code: "provider_runtime_key_rejected", connectionId: "conn-1", failures: 1 },
      { code: "provider_runtime_quota_exhausted", connectionId: "conn-2", failures: 2 },
      { code: "provider_runtime_quota_exhausted", connectionId: "conn-3", failures: 1 }
    ]);
  });

  it("auto-clears once the failures fall out of the window", () => {
    const stale = evaluateHealthRules(rows({
      providerOperations: [failed("conn-1", { code: "provider_auth_rejected", httpStatus: 401 }, 9, 61)],
      serverErrors: [row({}, 50, 75)],
      processStarts: [row({ role: "app" }, 5, 65)],
      droppedRecords: [row({}, 1, 90, 400)],
      backgroundErrors: [row({ subsystem: "memory" }, 99, 70)]
    }), now);
    expect(stale).toEqual([]);
  });

  it("flags a failing connection only at both the count and the share thresholds, naming the failure mix", () => {
    const failing = [
      failed("conn-1", { code: "provider_rate_limited", httpStatus: 429, reason: "http" }, 3),
      failed("conn-1", { code: "provider_request_timed_out", reason: "deadline" }, 2),
      completed("conn-1", 15)
    ];
    expect(evaluateHealthRules(rows({ providerOperations: failing }), now)).toEqual([{
      code: "provider_runtime_failing", connectionId: "conn-1", failures: 5, total: 20,
      kinds: { network: 0, other: 0, rate_limited: 3, server_error: 0, timeout: 2 }
    }]);
    // Five failures at under a quarter of the outcomes, or a high share with too few failures, stay quiet.
    expect(evaluateHealthRules(rows({ providerOperations: [...failing.slice(0, 2), completed("conn-1", 16)] }), now)).toEqual([]);
    expect(evaluateHealthRules(rows({ providerOperations: [
      failed("conn-1", { code: "provider_server_error", httpStatus: 503, reason: "http" }, 4)
    ] }), now)).toEqual([]);
  });

  it("ignores retried attempts, cancellations, policy fences and request-shaped client errors", () => {
    const findings = evaluateHealthRules(rows({ providerOperations: [
      failed("conn-1", { code: "provider_response_failed", reason: "invalid_response", action: "retry" }, 10),
      provider("conn-1", { outcome: "cancelled", code: "model_run_cancelled", reason: "cancelled" }, 10),
      failed("conn-1", { code: "agent_model_request_invalid", reason: "policy", action: "stop" }, 10),
      failed("conn-1", { code: "provider_http_invalid_request", httpStatus: 400, reason: "http" }, 10),
      provider("conn-1", { outcome: "started" }, 40)
    ] }), now);
    expect(findings).toEqual([]);
  });

  it("counts server errors, restarts per role, dropped lines and background errors per subsystem at their thresholds", () => {
    // The 70-minute-old server-error bucket row is outside the window.
    const findings = evaluateHealthRules(rows({
      serverErrors: [row({}, 6, 70), row({}, 4, 20), row({}, 6, 3)],
      processStarts: [row({ role: "memory_coordinator" }, 2, 50), row({ role: "memory_coordinator" }, 1, 5), row({ role: "app" }, 2, 5)],
      droppedRecords: [row({}, 2, 10, 37)],
      backgroundErrors: [row({ subsystem: "knowledge" }, 20, 15), row({ subsystem: "memory" }, 19, 15), row({ subsystem: null }, 99, 15)]
    }), now);
    expect(findings).toEqual([
      { code: "server_errors_rising", errors: 10 },
      { code: "process_restarting", role: "memory_coordinator", starts: 3 },
      { code: "logs_dropped", lines: 37 },
      { code: "background_failures", subsystem: "knowledge", errors: 20 },
      // Records without a subsystem (or beyond the counter key bound) still count, as other work.
      { code: "background_failures", subsystem: "other", errors: 99 }
    ]);
  });

  it("reports a tool or job subsystem whose finished operations time out too often over 24 hours", () => {
    const findings = evaluateHealthRules(rows({
      toolOutcomes: [
        row({ tool_kind: "vision", stage: "execution", outcome: "completed", reason: null }, 5, 600),
        row({ tool_kind: "vision", stage: "execution", outcome: "failed", reason: "deadline" }, 3, 30),
        row({ tool_kind: "vision", stage: "execution", outcome: "started", reason: null }, 8, 30),
        row({ tool_kind: "search", stage: "request", outcome: "failed", reason: "deadline" }, 1, 30),
        row({ tool_kind: "search", stage: "request", outcome: "completed", reason: null }, 30, 30),
        row({ tool_kind: "mcp", stage: "execution", outcome: "failed", reason: "deadline" }, 9, 25 * 60)
      ],
      jobOutcomes: [
        row({ subsystem: "pdf", outcome: "failed", code: "pdf_parse_timed_out" }, 2, 100),
        row({ subsystem: "pdf", outcome: "completed", code: null }, 3, 100)
      ]
    }), now);
    expect(findings).toEqual([
      { code: "operation_timeouts_rising", operation: { kind: "tool", name: "vision" }, timeouts: 3, total: 8 },
      { code: "operation_timeouts_rising", operation: { kind: "subsystem", name: "pdf" }, timeouts: 2, total: 5 }
    ]);
  });
});

describe("readHealthCounterRows", () => {
  it("reads the current and previous hourly buckets for the hour rules and a day of buckets for timeouts", async () => {
    const readCounters = vi.fn().mockResolvedValue([]);
    await readHealthCounterRows({ readCounters }, now);
    expect(readCounters).toHaveBeenCalledTimes(7);
    const hour = { from: new Date("2026-10-07T11:00:00.000Z"), to: new Date("2026-10-07T13:00:00.000Z") };
    const day = { from: new Date("2026-10-06T12:00:00.000Z"), to: new Date("2026-10-07T13:00:00.000Z") };
    expect(readCounters).toHaveBeenCalledWith(expect.objectContaining({ ...hour, events: ["provider_operation"] }));
    expect(readCounters).toHaveBeenCalledWith(expect.objectContaining({ ...hour, events: ["process.started"], groupBy: ["bucket", "role"] }));
    expect(readCounters).toHaveBeenCalledWith(expect.objectContaining({ ...day, events: ["tool_execution"] }));
    for (const [query] of readCounters.mock.calls) {
      expect(query.groupBy).toContain("bucket");
    }
  });

  it("fails as a whole when one read fails", async () => {
    const readCounters = vi.fn().mockResolvedValue([]).mockRejectedValueOnce(new Error("database down"));
    await expect(readHealthCounterRows({ readCounters }, now)).rejects.toThrow("database down");
  });
});

function connection(id: string, displayName: string, enabled = true): AdminProviderConnection {
  return { displayName, enabled, id } as AdminProviderConnection;
}

describe("healthAttentionItems", () => {
  const findings: HealthFinding[] = [
    { code: "provider_runtime_key_rejected", connectionId: "conn-1", failures: 3 },
    { code: "provider_runtime_quota_exhausted", connectionId: "conn-2", failures: 1 },
    { code: "provider_runtime_failing", connectionId: "conn-1", failures: 6, total: 20,
      kinds: { network: 1, other: 0, rate_limited: 4, server_error: 1, timeout: 0 } },
    { code: "server_errors_rising", errors: 12 },
    { code: "process_restarting", role: "memory_coordinator", starts: 4 },
    { code: "logs_dropped", lines: 1 },
    { code: "background_failures", subsystem: "knowledge", errors: 25 },
    { code: "operation_timeouts_rising", operation: { kind: "tool", name: "vision" }, timeouts: 3, total: 8 }
  ];

  it("writes plain-English copy with a provider page or Health jump and no raw codes", () => {
    const items = healthAttentionItems(findings, [connection("conn-1", "OpenAI"), connection("conn-2", "OpenRouter")]);
    expect(items.map(({ code, count, id, severity, target, title }) => ({ code, count, id, severity, target, title }))).toEqual([
      { code: "provider_runtime_key_rejected", count: 3, id: "provider_runtime_key_rejected:conn-1", severity: "bad",
        target: { resource: "conn-1", section: "providers" }, title: "Provider key rejected during use" },
      { code: "provider_runtime_quota_exhausted", count: 1, id: "provider_runtime_quota_exhausted:conn-2", severity: "bad",
        target: { resource: "conn-2", section: "providers" }, title: "Provider quota exhausted" },
      { code: "provider_runtime_failing", count: 6, id: "provider_runtime_failing:conn-1", severity: "warn",
        target: { resource: "conn-1", section: "providers" }, title: "Provider requests are failing" },
      { code: "server_errors_rising", count: 12, id: "server_errors_rising", severity: "warn", target: { section: "health" }, title: "Server errors are rising" },
      { code: "process_restarting", count: 4, id: "process_restarting:memory_coordinator", severity: "bad", target: { section: "health" }, title: "A service keeps restarting" },
      { code: "logs_dropped", count: 1, id: "logs_dropped", severity: "warn", target: { section: "health" }, title: "Log lines were dropped" },
      { code: "background_failures", count: 25, id: "background_failures:knowledge", severity: "warn", target: { section: "health" }, title: "Background work is failing" },
      { code: "operation_timeouts_rising", count: 3, id: "operation_timeouts_rising:tool:vision", severity: "warn", target: { section: "health" }, title: "Operations are timing out" }
    ]);
    expect(items.map((item) => item.detail)).toEqual([
      "OpenAI rejected its key 3 times in the last hour, after its last successful request — check the key",
      "OpenRouter reported no remaining quota or balance 1 time in the last hour — check the provider account",
      "OpenAI · 6 of 20 requests failed in the last hour (rate limits 4, network errors 1)",
      "12 requests ended with a server error in the last hour",
      "The Memory worker started 4 times in the last hour — check its logs",
      "1 log line could not be written in the last hour, so some diagnostics are missing",
      "Knowledge · 25 errors in the last hour",
      "Image analysis · 3 of 8 ran out of time in the last 24 hours"
    ]);
    const copy = JSON.stringify(items.map(({ action, detail, title }) => ({ action, detail, title })));
    expect(copy).not.toMatch(/provider_|_rejected|memory_coordinator|conn-|\b40[0-9]\b/u);
  });

  it("stays quiet for a removed or switched-off connection and falls back to a generic name without the provider list", () => {
    const providerFindings = findings.slice(0, 2);
    expect(healthAttentionItems(providerFindings, [connection("conn-1", "OpenAI", false)])).toEqual([]);
    const unnamed = healthAttentionItems(providerFindings, null);
    expect(unnamed.map((item) => item.detail)).toEqual([
      "A provider connection rejected its key 3 times in the last hour, after its last successful request — check the key",
      "A provider connection reported no remaining quota or balance 1 time in the last hour — check the provider account"
    ]);
  });
});
