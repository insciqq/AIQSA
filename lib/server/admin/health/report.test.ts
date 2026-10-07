import { describe, expect, it, vi } from "vitest";
import type { AdminHealth, AdminHealthIncident, AdminHealthProviderRow } from "../../../contracts/adminHealth";
import type { AdminHealthQueueRow } from "../../../contracts/adminHealthQueues";
import {
  collectHealthReport,
  collectHealthRunReport,
  formatHealthReport,
  formatHealthRunReport,
  parseHealthReportArgs,
  type HealthReport,
  type HealthReportSources
} from "./report";

const RUN = "1a2b3c4d-1111-4111-8111-111111111111";
const classes = { key_rejected: 0, quota: 0, provider_error: 0, timeout: 0, network: 0, other: 0 };
const categories = { providers: 0, requests: 0, runs: 0, background: 0, tools: 0, other: 0 };

function provider(fields: Partial<AdminHealthProviderRow>): AdminHealthProviderRow {
  return {
    key: "conn-openai|model-gpt|answer", connectionId: "conn-openai", connectionName: "OpenAI", connectionState: "known",
    providerModelId: "model-gpt", modelName: "gpt-5", stage: "answer", operations: 120, failures: 0, failureRate: 0,
    failuresByClass: classes, p95Ms: 2_000, lastFailureAt: null, ...fields
  };
}

function incident(index: number, fields: Partial<AdminHealthIncident> = {}): AdminHealthIncident {
  return {
    id: `incident-${index}`, occurredAt: `2026-10-07T09:${String(59 - index).padStart(2, "0")}:12.000Z`, role: "app",
    event: "provider_operation", level: "error", code: "provider_rate_limited", subsystem: null, stage: "answer",
    connectionId: "conn-openai", connectionName: "OpenAI", modelName: "gpt-5", httpStatus: 429, runId: RUN,
    traceId: null, details: [], ...fields
  };
}

function queue(fields: Partial<AdminHealthQueueRow> & Pick<AdminHealthQueueRow, "queue">): AdminHealthQueueRow {
  return { state: "ok", waiting: 0, running: 0, oldestSeconds: null, failed24h: 0, slowAfterSeconds: 600, stalledAfterSeconds: 1_800, ...fields };
}

const health: AdminHealth = {
  range: "24h", interval: "hour", from: "2026-10-06T10:00:00.000Z", to: "2026-10-07T10:00:00.000Z",
  generatedAt: "2026-10-07T09:59:30.000Z", hasTelemetry: true,
  summary: {
    errors: 42, previousErrors: 10, providerOperations: 240, providerFailures: 9, providerFailureRate: 0.0375, http5xx: 3,
    restarts: 2, roleStarts: [{ role: "app", starts: 3, restarts: 2 }, { role: "memory_coordinator", starts: 1, restarts: 0 }],
    droppedLogRecords: 0, clientErrors: 1
  },
  series: [
    { start: "2026-10-07T08:00:00.000Z", counts: { ...categories, providers: 7, runs: 20 }, total: 27 },
    { start: "2026-10-07T09:00:00.000Z", counts: { ...categories, providers: 2, requests: 3, background: 10 }, total: 15 }
  ],
  providers: [
    provider({ key: "a", failures: 2, failureRate: 2 / 120, failuresByClass: { ...classes, timeout: 2 },
      lastFailureAt: "2026-10-07T08:10:00.000Z", connectionName: "Anthropic", modelName: "claude", stage: "title" }),
    provider({ key: "b", failures: 0 }),
    provider({ key: "c", failures: 7, failureRate: 7 / 120, failuresByClass: { ...classes, quota: 6, network: 1 },
      lastFailureAt: "2026-10-07T09:58:00.000Z" })
  ],
  providersTruncated: false
};

function sources(overrides: Partial<HealthReportSources> = {}): HealthReportSources {
  return {
    health: {
      read: vi.fn().mockResolvedValue(health),
      incidents: vi.fn().mockResolvedValue({ incidents: Array.from({ length: 12 }, (_, index) => incident(index)), nextCursor: null })
    },
    queues: {
      read: vi.fn().mockResolvedValue({ checkedAt: "2026-10-07T09:59:30.000Z", queues: [
        queue({ queue: "attachment_processing" }),
        queue({ queue: "chat_titles", state: "stalled", waiting: 4, running: 0, oldestSeconds: 3 * 3_600 }),
        queue({ queue: "document_processing", state: "slow", waiting: 2, running: 1, oldestSeconds: 20 * 60, failed24h: 3 }),
        queue({ queue: "memory", state: "unavailable", waiting: null, running: null, failed24h: null })
      ] })
    },
    findings: vi.fn().mockResolvedValue([
      { code: "provider_runtime_quota_exhausted", connectionId: "conn-openai", failures: 6 },
      { code: "provider_runtime_key_rejected", connectionId: "conn-disabled", failures: 4 },
      { code: "process_restarting", role: "app", starts: 3 }
    ]),
    connections: vi.fn().mockResolvedValue([
      { id: "conn-openai", displayName: "OpenAI", enabled: true },
      { id: "conn-disabled", displayName: "Old key", enabled: false }
    ]),
    ...overrides
  };
}

describe("health report collection", () => {
  it("reuses the Health projections and attention rules and keeps only what went wrong", async () => {
    const input = sources();
    const report = await collectHealthReport(input, "24h");
    expect(input.health.read).toHaveBeenCalledWith("24h");
    expect(input.health.incidents).toHaveBeenCalledWith({ category: null, code: null, cursor: null, event: null, level: null, q: null, range: "24h" });
    expect(Object.keys(report)).toEqual(["kind", "version", "range", "from", "to", "generatedAt", "hasTelemetry", "attention",
      "summary", "errorsByCategory", "providerFailures", "providersTruncated", "restarts", "queues", "queuesCheckedAt",
      "incidents", "incidentsTruncated"]);
    // A disabled connection has nothing left to fix; only the stalled queue that raises its own item joins.
    expect(report.attention.map((item) => item.id)).toEqual([
      "provider_runtime_quota_exhausted:conn-openai", "process_restarting:app", "queue_stalled:chat_titles"
    ]);
    expect(report.errorsByCategory).toEqual({ ...categories, providers: 9, requests: 3, runs: 20, background: 10 });
    expect(report.providerFailures.map((row) => row.key)).toEqual(["c", "a"]);
    expect(report.restarts).toEqual([{ role: "app", starts: 3, restarts: 2 }]);
    expect(report.queues.map((row) => row.queue)).toEqual(["chat_titles", "document_processing", "memory"]);
    expect(report.incidents).toHaveLength(10);
    expect(report.incidentsTruncated).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("fails once on an unreadable database before reading anything else", async () => {
    const input = sources({ health: { read: vi.fn().mockRejectedValue(new Error("down")), incidents: vi.fn() } });
    await expect(collectHealthReport(input, "7d")).rejects.toThrow("down");
    expect(input.queues.read).not.toHaveBeenCalled();
    expect(input.health.incidents).not.toHaveBeenCalled();
  });
});

describe("health report text", () => {
  it("leads with what needs attention and fits 100 columns", async () => {
    const text = formatHealthReport(await collectHealthReport(sources(), "24h"));
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("AIQSA health · last 24 hours · 2026-10-06 10:00 to 2026-10-07 10:00 UTC");
    expect(lines[2]).toBe("Needs attention (3)");
    expect(lines[3]).toBe("  BAD   Provider quota exhausted");
    expect(lines.map((line) => line.length).every((length) => length <= 100)).toBe(true);
    const headings = lines.filter((line) => /^[A-Z]/u.test(line));
    expect(headings.slice(1)).toEqual([
      "Needs attention (3)", "Error totals: 42 (previous 24 hours: 10)", "Provider failures", "Process restarts",
      "Background queues", "Latest incidents (UTC, newest first; 10 shown, Control Center Health lists the rest)",
      "Look up a reference: ./aiqsa.sh health --run <reference>"
    ]);
    expect(text).toContain("  By area: providers 9 · requests 3 · runs 20 · background 10\n");
    expect(text).toContain("  server errors 3 · provider failures 9 of 240 (3.8%) · browser crashes 1\n");
    expect(text).toMatch(/\n {2}OpenAI · gpt-5 +answer +7\/120 +5\.8% {2}quota +2026-10-07 09:58\n/u);
    expect(text).toContain("  app: 3 starts (2 restarts)\n");
    expect(text).not.toContain("memory_coordinator");
    expect(text).toContain("  STALLED      Chat titles · 4 waiting, 0 running · oldest due 3 hours ago\n");
    expect(text).toContain("  SLOW         Knowledge document processing · 2 waiting, 1 running · oldest due 20 minutes ago\n" +
      "               3 failed in 24 hours\n");
    expect(text).toContain("  UNAVAILABLE  Memory learning and indexing · could not be read\n");
    expect(text).toContain("  2026-10-07 09:59:12  error  app  provider_operation  ref 1a2b3c4d\n" +
      "      code provider_rate_limited · answer · OpenAI · gpt-5 · HTTP 429\n");
  });

  it("says so when nothing went wrong", async () => {
    const quiet: AdminHealth = {
      ...health, range: "7d", interval: "day", hasTelemetry: false, providers: [], series: [],
      summary: { ...health.summary, errors: 0, previousErrors: 0, providerFailures: 0, providerFailureRate: null, http5xx: 0,
        restarts: 0, roleStarts: [{ role: "app", starts: 1, restarts: 0 }], clientErrors: 0 }
    };
    const report = await collectHealthReport(sources({
      health: { read: vi.fn().mockResolvedValue(quiet), incidents: vi.fn().mockResolvedValue({ incidents: [], nextCursor: null }) },
      queues: { read: vi.fn().mockResolvedValue({ checkedAt: "2026-10-07T09:59:30.000Z", queues: [queue({ queue: "chat_titles" })] }) },
      findings: vi.fn().mockResolvedValue([])
    }), "7d");
    expect(formatHealthReport(report).split("\n").slice(2)).toEqual([
      "No problems recorded in the last 7 days.", "No telemetry at all was recorded in this range.", ""
    ]);
    expect(formatHealthReport({ ...report, hasTelemetry: true } satisfies HealthReport)).not.toContain("No telemetry");
  });
});

describe("run lookup report", () => {
  it("normalizes the reference and lists the run with its incidents over the longest range", async () => {
    const health = { incidents: vi.fn().mockResolvedValue({ incidents: [incident(0, { level: "fatal", code: null, subsystem: "runs", httpStatus: null })], nextCursor: null }) };
    const runs = { lookup: vi.fn().mockResolvedValue({ truncated: true, runs: [{
      runId: RUN, status: "error", startedAt: "2026-10-07T09:58:00.000Z", updatedAt: "2026-10-07T09:58:12.300Z",
      durationMs: 12_300, failureCode: "provider_rate_limited", connectionName: "OpenAI", modelName: "gpt-5", incidentCount: 1
    }] }) };
    const report = await collectHealthRunReport({ health, runs }, "Reference: 1A2B3C4D");
    expect(runs.lookup).toHaveBeenCalledWith("1a2b3c4d");
    expect(health.incidents).toHaveBeenCalledWith(expect.objectContaining({ q: "1a2b3c4d", range: "30d" }));
    expect(formatHealthRunReport(report)).toBe([
      "AIQSA run lookup · reference 1a2b3c4d",
      "",
      `  ${RUN}`,
      "    error · started 2026-10-07 09:58:00 UTC · took 12.3 s",
      "    failure provider_rate_limited · OpenAI · gpt-5 · 1 incident",
      "  More runs share this reference; give more characters of the run id.",
      "",
      "Incidents for this reference (UTC, newest first)",
      "  2026-10-07 09:59:12  fatal  app  provider_operation  ref 1a2b3c4d",
      "      runs/answer · OpenAI · gpt-5",
      ""
    ].join("\n"));
  });

  it("says when no run matches", async () => {
    const report = await collectHealthRunReport({
      health: { incidents: vi.fn().mockResolvedValue({ incidents: [], nextCursor: null }) },
      runs: { lookup: vi.fn().mockResolvedValue({ truncated: false, runs: [] }) }
    }, "deadbeef");
    expect(formatHealthRunReport(report)).toBe("AIQSA run lookup · reference deadbeef\n\nNo run matches reference deadbeef.\n");
  });
});

describe("health report arguments", () => {
  it("defaults to the shortest range and accepts both flag spellings", () => {
    expect(parseHealthReportArgs([])).toEqual({ help: false, json: false, range: "24h", run: null });
    expect(parseHealthReportArgs(["--since=30d", "--json"])).toEqual({ help: false, json: true, range: "30d", run: null });
    expect(parseHealthReportArgs(["--run", "1A2B3C4D-11", "--json"])).toEqual({ help: false, json: true, range: "24h", run: "1a2b3c4d-11" });
  });

  it.each([
    [["--since", "1h"], "--since must be one of 24h, 7d, 30d."],
    [["--since"], "--since must be one of 24h, 7d, 30d."],
    [["--since", "7d", "--since", "7d"], "--since was given twice."],
    [["--run", "1a2b3c"], "--run needs an error reference"],
    [["--run", "1a2b3c4d", "--since", "7d"], "--run and --since are mutually exclusive."],
    [["--json=yes"], "--json takes no value."],
    [["extra"], "Unknown argument: extra"]
  ])("refuses %j", (argv, message) => {
    const parsed = parseHealthReportArgs(argv);
    expect("error" in parsed && parsed.error).toContain(message);
  });
});
