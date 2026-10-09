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
  providersTruncated: false,
  errorGroups: [{ fingerprint: "0123456789ab", errorClass: "TypeError", site: "lib/server/memory/coordinator/workerProcess.ts:51",
    count: 12, events: ["job_attempt"], roles: ["knowledge_search"], codes: ["memory_job_failed"],
    lastSeenAt: "2026-10-07T09:40:00.000Z", firstSeenAt: "2026-10-07T08:00:00.000Z", isNew: true, usersAtLeast: 3, runsAtLeast: 5 }],
  errorGroupsTruncated: false
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
    failedRuns: vi.fn().mockResolvedValue({ runs: 0, users: 0, groups: [], groupsTruncated: false }),
    slowTransactions: vi.fn().mockResolvedValue([]),
    ...overrides
  };
}

describe("health report collection", () => {
  it("reuses the Health projections and attention rules and keeps only what went wrong", async () => {
    const input = sources();
    const report = await collectHealthReport(input, "24h");
    expect(input.health.read).toHaveBeenCalledWith("24h");
    expect(input.health.incidents).toHaveBeenCalledWith({ category: null, code: null, cursor: null, event: null, level: null, q: null, range: "24h" });
    expect(input.failedRuns).toHaveBeenCalledWith({ from: new Date(health.from), to: new Date(health.to), perCode: 3, groupLimit: 50 });
    expect(Object.keys(report)).toEqual(["kind", "version", "range", "from", "to", "generatedAt", "hasTelemetry", "attention",
      "failedRuns", "summary", "errorsByCategory", "errorGroups", "errorGroupsTruncated", "providerFailures", "providersTruncated", "restarts",
      "queues", "queuesCheckedAt", "slowTransactions",
      "incidents", "incidentsTruncated"]);
    expect(input.slowTransactions).toHaveBeenCalledWith({ from: new Date(health.from), to: new Date(health.to) });
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
      "Needs attention (3)", "Error totals: 42 (previous 24 hours: 10)", "Failures by location (class · where in AIQSA)",
      "Provider failures", "Process restarts",
      "Background queues", "Latest incidents (UTC, newest first; 10 shown, Control Center Health lists the rest)",
      "Look up a reference: ./aiqsa.sh health --run <reference>"
    ]);
    expect(text).toContain("  By area: providers 9 · requests 3 · runs 20 · background 10\n");
    expect(text).toContain("  server errors 3 · provider failures 9 of 240 (3.8%) · browser crashes 1\n");
    expect(text).toContain("  NEW   TypeError · lib/server/memory/coordinator/workerProcess.ts:51\n" +
      "        12 times · at least 3 users · at least 5 runs · job_attempt · memory_job_failed\n" +
      "        knowledge_search · last 2026-10-07 09:40\n");
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

  it("leads with failed runs: counts in attention, then each failure code with users and references to look up", async () => {
    const RUN_A = "1a2b3c4d-1111-4111-8111-111111111111";
    const RUN_B = "5e6f7a8b-2222-4222-8222-222222222222";
    const RUN_C = "9c8d7e6f-3333-4333-8333-333333333333";
    const at = new Date("2026-10-07T09:30:00.000Z");
    const report = await collectHealthReport(sources({
      health: { read: vi.fn().mockResolvedValue(health), incidents: vi.fn().mockResolvedValue({ incidents: [], nextCursor: null }) },
      findings: vi.fn().mockResolvedValue([
        { code: "runs_failed", runs: 13, users: 5 },
        { code: "new_error", fingerprint: "0123456789ab", errorClass: "WorkspaceHandoffFailure",
          site: "lib/server/runs/runExecution.ts:3832", count: 1 }
      ]),
      failedRuns: vi.fn().mockResolvedValue({ runs: 13, users: 5, groupsTruncated: false, groups: [
        { code: "provider_server_error", runs: 12, users: 4, firstAt: at, lastAt: at, newest: [
          { runId: RUN_A, userId: "private-user-a", startedAt: at }, { runId: RUN_B, userId: "private-user-b", startedAt: at }] },
        { code: "workspace_output_export_failed", runs: 1, users: 1, firstAt: at, lastAt: at, newest: [
          { runId: RUN_C, userId: "private-user-c", startedAt: at }, { runId: "not-a-run", userId: "private-user-d", startedAt: at }] }
      ] })
    }), "24h");
    expect(report.attention.map((item) => item.id)).toEqual(["runs_failed", "new_error:0123456789ab", "queue_stalled:chat_titles"]);
    expect(report.failedRuns).toEqual({ runs: 13, users: 5, truncated: false, rows: [
      { failureCode: "provider_server_error", runs: 12, users: 4, lastAt: at.toISOString(), references: ["1a2b3c4d", "5e6f7a8b"] },
      { failureCode: "workspace_output_export_failed", runs: 1, users: 1, lastAt: at.toISOString(), references: ["9c8d7e6f"] }
    ] });
    // The default report counts users and never names them.
    expect(JSON.stringify(report)).not.toMatch(/private-user|"user_?[iI]d"/u);
    const text = formatHealthReport(report);
    const lines = text.trimEnd().split("\n");
    expect(lines.every((line) => line.length <= 100)).toBe(true);
    expect(text).toContain("Needs attention (3)\n  WARN  Runs failed\n" +
      "        13 answers failed for 5 users in the last 24 hours — the health report lists them by cause\n");
    expect(text).toContain("\n\nFailed runs: 13 runs of 5 users (stops and refused input not counted)\n" +
      "  code provider_server_error · 12 runs · 4 users · last 2026-10-07 09:30\n" +
      "      ref 1a2b3c4d, 5e6f7a8b\n" +
      "  code workspace_output_export_failed · 1 run · 1 user · last 2026-10-07 09:30\n" +
      "      ref 9c8d7e6f\n\nError totals");
    // Attention copy is human copy only; codes and references live in the report sections.
    const attentionCopy = JSON.stringify(report.attention);
    expect(attentionCopy).not.toMatch(/provider_server_error|workspace_output_export_failed|1a2b3c4d|9c8d7e6f/u);
    // Without incidents of their own, the failed runs' references still get the lookup hint.
    expect(lines.at(-1)).toBe("Look up a reference: ./aiqsa.sh health --run <reference>");
  });

  it("names the class and code site of an incident that has them", async () => {
    const failure = incident(0, { event: "http.request_failed", code: null, stage: "next_request", connectionName: null,
      modelName: null, httpStatus: null, runId: null,
      details: [{ key: "error_class", value: "TypeError" }, { key: "error_site", value: "app/api/x/route.ts:3" }] });
    const report = await collectHealthReport(sources({
      health: { read: vi.fn().mockResolvedValue(health), incidents: vi.fn().mockResolvedValue({ incidents: [failure], nextCursor: null }) }
    }), "24h");
    expect(formatHealthReport(report)).toContain("  2026-10-07 09:59:12  error  app  http.request_failed\n" +
      "      TypeError at app/api/x/route.ts:3 · next_request\n");
  });

  it("names the root cause, database and system facts of an incident in the list and the run lookup", async () => {
    const handoff = incident(0, { event: "run_execution", code: "workspace_output_export_failed", stage: "completion",
      connectionName: null, modelName: null, httpStatus: null, details: [
        { key: "cause_class", value: "PrismaClientKnownRequestError" },
        { key: "cause_site", value: "lib/server/workspace/sessionOperation.ts:11" },
        { key: "db_failure", value: "transaction_expired" },
        { key: "error_class", value: "WorkspaceHandoffFailure" },
        { key: "error_site", value: "lib/server/runs/runExecution.ts:3832" },
        { key: "prisma_code", value: "P2028" },
        { key: "tx_elapsed_ms", value: 5012 },
        { key: "tx_timeout_ms", value: 5000 }
      ] });
    const crash = incident(1, { event: "process.failure", level: "fatal", code: "unexpected", stage: "uncaught_exception",
      connectionName: null, modelName: null, httpStatus: null, runId: null, details: [
        { key: "cause_class", value: "Error" }, { key: "error_class", value: "McpSafeFetchError" },
        { key: "sys_code", value: "ENETUNREACH" }, { key: "syscall", value: "connect" }
      ] });
    const incidents = vi.fn().mockResolvedValue({ incidents: [handoff, crash], nextCursor: null });
    const joined = (text: string) => text.replace(/\n {6}/gu, " · ");
    const listed = joined(formatHealthReport(await collectHealthReport(sources({
      health: { read: vi.fn().mockResolvedValue(health), incidents }
    }), "24h")));
    const handoffLine = "WorkspaceHandoffFailure at lib/server/runs/runExecution.ts:3832 · " +
      "cause PrismaClientKnownRequestError at lib/server/workspace/sessionOperation.ts:11 · " +
      "P2028 transaction_expired · transaction 5012 ms of 5000 ms · code workspace_output_export_failed · completion";
    const crashLine = "McpSafeFetchError · cause Error · system ENETUNREACH connect · code unexpected · uncaught_exception";
    expect(listed).toContain(handoffLine);
    expect(listed).toContain(crashLine);
    const runs = { lookup: vi.fn().mockResolvedValue({ truncated: false, runs: [] }) };
    const looked = joined(formatHealthRunReport(await collectHealthRunReport({ health: { incidents }, runs }, RUN.slice(0, 8))));
    expect(looked).toContain(handoffLine);
  });

  it("lists slow transactions errors first and shows the holder's hold beside the waiter's lock wait", async () => {
    const counter = (group: Record<string, string>, count: number, maxMs: number, lastSeenAt: string) => ({
      group, count, valueSum: 0, durationCount: count, durationSumMs: maxMs * count, durationMaxMs: maxMs,
      durationBuckets: [], firstSeenAt: new Date("2026-10-07T09:00:00.000Z"), lastSeenAt: new Date(lastSeenAt)
    });
    const slowTransactions = vi.fn().mockResolvedValue([
      counter({ level: "warn", subsystem: "workspace", operation: "export_seal", outcome: "rolled_back" }, 3, 2_031,
        "2026-10-07T09:41:31.000Z"),
      counter({ level: "error", subsystem: "memory", operation: "job_commit", job_kind: "INDEX_HISTORY", outcome: "committed" }, 1,
        6_020, "2026-10-07T09:41:35.000Z")
    ]);
    const holder = incident(0, { event: "db_transaction", code: null, subsystem: "memory", stage: null, connectionId: null,
      connectionName: null, modelName: null, httpStatus: null, runId: null, details: [
        { key: "duration_ms", value: 6_020 }, { key: "job_kind", value: "INDEX_HISTORY" }, { key: "lock_wait_ms", value: 3 },
        { key: "operation", value: "job_commit" }, { key: "outcome", value: "committed" }
      ] });
    const waiter = incident(1, { event: "runtime_lifecycle", code: "workspace_output_export_failed", subsystem: "workspace",
      stage: "export", connectionId: null, connectionName: null, modelName: null, httpStatus: null, details: [
        { key: "db_failure", value: "lock_timeout" }, { key: "duration_ms", value: 2_031 }, { key: "lock_wait_ms", value: 2_004 },
        { key: "prisma_code", value: "P2010" }, { key: "work_stage", value: "seal" }
      ] });
    const report = await collectHealthReport(sources({
      health: { read: vi.fn().mockResolvedValue(health), incidents: vi.fn().mockResolvedValue({ incidents: [holder, waiter], nextCursor: null }) },
      slowTransactions
    }), "24h");
    expect(report.slowTransactions).toEqual({ truncated: false, rows: [
      { level: "error", subsystem: "memory", operation: "job_commit", jobKind: "INDEX_HISTORY", outcome: "committed", count: 1,
        maxMs: 6_020, firstSeenAt: "2026-10-07T09:00:00.000Z", lastSeenAt: "2026-10-07T09:41:35.000Z" },
      { level: "warn", subsystem: "workspace", operation: "export_seal", jobKind: null, outcome: "rolled_back", count: 3,
        maxMs: 2_031, firstSeenAt: "2026-10-07T09:00:00.000Z", lastSeenAt: "2026-10-07T09:41:31.000Z" }
    ] });
    const text = formatHealthReport(report);
    const lines = text.split("\n");
    const section = lines.indexOf("Slow database transactions (held rows over 2.0 s; ERROR: over the 5.0 s budget)");
    expect(section).toBeGreaterThan(-1);
    expect(lines.slice(section + 1, section + 3)).toEqual([
      "  ERROR  memory/job_commit INDEX_HISTORY · 1 time · max 6.0 s · last 2026-10-07 09:41",
      "  WARN   workspace/export_seal · rolled back · 3 times · max 2.0 s · last 2026-10-07 09:41"
    ]);
    // The section sits right before the incidents it explains.
    expect(lines[section + 4]).toMatch(/^Latest incidents/u);
    expect(text).toContain("  2026-10-07 09:59:12  error  app  db_transaction\n      held 6.0 s, lock wait 3 ms · memory/job_commit INDEX_HISTORY\n");
    expect(text.replace(/\n {6}/gu, " · "))
      .toContain(" · P2010 lock_timeout · lock wait 2.0 s of 2.0 s · code workspace_output_export_failed · workspace/export\n");
  });

  it("prints how many users and runs a failure hit as counts only, in text and JSON", async () => {
    const one = { ...health.errorGroups[0]!, fingerprint: "ba9876543210", errorClass: "RangeError", site: "lib/server/a.ts:1",
      count: 120, events: ["run_execution"], roles: ["app"], codes: [], isNew: false, usersAtLeast: 1, runsAtLeast: 0 };
    const none = { ...one, fingerprint: "aaaaaaaaaaaa", errorClass: "SyntaxError", usersAtLeast: 0 };
    const report = await collectHealthReport(sources({
      health: { read: vi.fn().mockResolvedValue({ ...health, errorGroups: [...health.errorGroups, one, none] }),
        incidents: vi.fn().mockResolvedValue({ incidents: [], nextCursor: null }) }
    }), "24h");
    expect(report.errorGroups.map((group) => [group.usersAtLeast, group.runsAtLeast])).toEqual([[3, 5], [1, 0], [0, 0]]);
    expect(JSON.stringify(report)).not.toMatch(/"user_?[iI]d"/u);
    const text = formatHealthReport(report);
    expect(text).toContain("      RangeError · lib/server/a.ts:1\n        120 times · at least 1 user · run_execution · app · last ");
    expect(text).toContain("      SyntaxError · lib/server/a.ts:1\n        120 times · run_execution · app · last ");
  });

  it("says so when nothing went wrong", async () => {
    const quiet: AdminHealth = {
      ...health, range: "14d", interval: "day", hasTelemetry: false, providers: [], series: [], errorGroups: [],
      summary: { ...health.summary, errors: 0, previousErrors: 0, providerFailures: 0, providerFailureRate: null, http5xx: 0,
        restarts: 0, roleStarts: [{ role: "app", starts: 1, restarts: 0 }], clientErrors: 0 }
    };
    const read = vi.fn().mockResolvedValue(quiet);
    const report = await collectHealthReport(sources({
      health: { read, incidents: vi.fn().mockResolvedValue({ incidents: [], nextCursor: null }) },
      queues: { read: vi.fn().mockResolvedValue({ checkedAt: "2026-10-07T09:59:30.000Z", queues: [queue({ queue: "chat_titles" })] }) },
      findings: vi.fn().mockResolvedValue([])
    }), "14d");
    expect(read).toHaveBeenCalledWith("14d");
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({ kind: "health", range: "14d" });
    expect(formatHealthReport(report).split("\n")[0]).toMatch(/^AIQSA health · last 14 days · /u);
    expect(formatHealthReport(report).split("\n").slice(2)).toEqual([
      "No problems recorded in the last 14 days.", "No telemetry at all was recorded in this range.", ""
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
    expect(parseHealthReportArgs(["--since", "14d"])).toEqual({ help: false, json: false, range: "14d", run: null });
    expect(parseHealthReportArgs(["--run", "1A2B3C4D-11", "--json"])).toEqual({ help: false, json: true, range: "24h", run: "1a2b3c4d-11" });
  });

  it.each([
    [["--since", "1h"], "--since must be one of 24h, 7d, 14d, 30d."],
    [["--since"], "--since must be one of 24h, 7d, 14d, 30d."],
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
