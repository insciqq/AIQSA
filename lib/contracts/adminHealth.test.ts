import { describe, expect, it } from "vitest";
import {
  adminHealthIncidentSearch,
  decodeAdminHealthIncidentsResponse,
  decodeAdminHealthResponse,
  parseAdminHealthIncidentFilters,
  type AdminHealth
} from "./adminHealth";

const counts = { providers: 1, requests: 0, runs: 0, background: 2, tools: 0, other: 0 };
const health: AdminHealth = {
  range: "24h", interval: "hour", from: "2026-10-06T13:00:00.000Z", to: "2026-10-07T13:00:00.000Z",
  generatedAt: "2026-10-07T12:30:00.000Z", hasTelemetry: true, providersTruncated: false,
  summary: { errors: 3, previousErrors: null, providerOperations: 10, providerFailures: 1, providerFailureRate: 0.1,
    http5xx: 0, restarts: 0, roleStarts: [{ role: "app", starts: 1, restarts: 0 }], droppedLogRecords: 0, clientErrors: 0 },
  series: [{ start: "2026-10-07T12:00:00.000Z", counts, total: 3 }],
  providers: [{ key: "k", connectionId: "c", connectionName: "OpenAI", connectionState: "known", providerModelId: "m",
    modelName: "GPT", stage: "answer", operations: 10, failures: 1, failureRate: 0.1,
    failuresByClass: { key_rejected: 1, quota: 0, provider_error: 0, timeout: 0, network: 0, other: 0 },
    p95Ms: 2_500, lastFailureAt: "2026-10-07T11:00:00.000Z" }],
  errorGroups: [{ fingerprint: "0123456789ab", errorClass: "TypeError", site: "lib/server/runs/x.ts:42", count: 2,
    events: ["job_attempt"], roles: ["memory_coordinator"], codes: ["memory_job_failed"],
    lastSeenAt: "2026-10-07T12:00:00.000Z", firstSeenAt: "2026-10-07T11:00:00.000Z", isNew: true }],
  errorGroupsTruncated: false
};

describe("admin health contract", () => {
  it("decodes a well-formed health response and rejects malformed shapes", () => {
    expect(decodeAdminHealthResponse({ health })).toEqual({ health });
    expect(decodeAdminHealthResponse({ health: { ...health, range: "1y" } })).toBeNull();
    expect(decodeAdminHealthResponse({ health: { ...health, summary: { ...health.summary, errors: -1 } } })).toBeNull();
    expect(decodeAdminHealthResponse({ health: { ...health, series: [{ ...health.series[0], counts: { providers: 1 } }] } })).toBeNull();
    expect(decodeAdminHealthResponse({ health: { ...health, providers: [{ ...health.providers[0], failureRate: 2 }] } })).toBeNull();
    expect(decodeAdminHealthResponse({ health: { ...health, errorGroups: [{ ...health.errorGroups[0], fingerprint: "nothex" }] } })).toBeNull();
    expect(decodeAdminHealthResponse({ health: { ...health, errorGroups: [{ ...health.errorGroups[0], site: "x\ny" }] } })).toBeNull();
    expect(decodeAdminHealthResponse({ health: { ...health, errorGroupsTruncated: undefined } })).toBeNull();
  });

  it("decodes incidents with bounded scalar details only", () => {
    const incident = { id: "i", occurredAt: "2026-10-07T12:00:00.000Z", role: "app", event: "provider_operation", level: "error",
      code: null, subsystem: null, stage: null, connectionId: null, connectionName: null, modelName: null, httpStatus: null,
      runId: null, traceId: null, details: [{ key: "duration_ms", value: 5 }] };
    expect(decodeAdminHealthIncidentsResponse({ incidents: [incident], nextCursor: null })?.incidents).toHaveLength(1);
    expect(decodeAdminHealthIncidentsResponse({ incidents: [{ ...incident, details: [{ key: "x", value: { nested: 1 } }] }], nextCursor: null })).toBeNull();
    expect(decodeAdminHealthIncidentsResponse({ incidents: [{ ...incident, level: "warn" }], nextCursor: null })).toBeNull();
  });

  it("parses incident filters strictly and round-trips them into a query string", () => {
    const filters = parseAdminHealthIncidentFilters(new URLSearchParams("range=7d&category=tools&q=run-1&cursor=abc_D-1"));
    expect(filters).toEqual({ range: "7d", category: "tools", code: null, cursor: "abc_D-1", event: null, level: null, q: "run-1" });
    expect(adminHealthIncidentSearch(filters!)).toBe("range=7d&category=tools&q=run-1&cursor=abc_D-1");
    expect(parseAdminHealthIncidentFilters(new URLSearchParams(""))?.range).toBe("24h");
    expect(parseAdminHealthIncidentFilters(new URLSearchParams("q=a%20b"))).toBeNull();
    expect(parseAdminHealthIncidentFilters(new URLSearchParams("range=7d&range=30d"))).toBeNull();
  });
});
