import type { AdminAttentionItem } from "../../../contracts/adminAttention";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import type { TelemetryCounterGroup, TelemetryCounterQuery, TelemetryStore } from "../../telemetry/store";

/**
 * Health attention rules: thresholds over the content-free telemetry counters,
 * evaluated on every read and never persisted. An item exists only while its
 * failures are recent, so it clears by itself once the window passes without
 * them. Every threshold lives here so calibration touches one place.
 *
 * Counters are hourly UTC buckets. A window reads every bucket it overlaps and
 * keeps a bucket's row only when the row's `lastSeenAt` falls inside the
 * window, so a count may include up to one earlier hour of the same row.
 */
export const HEALTH_ATTENTION_THRESHOLDS = Object.freeze({
  /** The window of every rule except operation timeouts. */
  windowMs: 60 * 60_000,
  /** Final failed operations (rate limits, 5xx, network, timeouts) per connection. */
  providerFailingMinFailures: 5,
  /** ...and their share among the connection's final outcomes. */
  providerFailingMinShare: 0.25,
  /** HTTP responses with status 5xx plus requests that failed before a response. */
  serverErrorsMin: 10,
  /** Process starts of one role. */
  processStartsMin: 3,
  /** Any dropped log line raises the item. */
  droppedLogLinesMin: 1,
  /** Error-level background records of one subsystem. */
  backgroundErrorsMin: 20,
  timeoutWindowMs: 24 * 3_600_000,
  /** Finished operations of one tool or subsystem in the timeout window. */
  timeoutMinOutcomes: 5,
  /** ...and the share of them that ran out of time. */
  timeoutMinShare: 0.2,
  /** A failure fingerprint first seen within this window is new. */
  newErrorWindowMs: 24 * 3_600_000,
  /** New failures named one by one; the rest are summed in one more item. */
  newErrorItemsMax: 3
});

export type HealthThresholds = typeof HEALTH_ATTENTION_THRESHOLDS;

const HOUR_MS = 3_600_000;
const ROW_LIMIT = 5_000;
/** Counter retention (Persistence): the oldest a first occurrence can be. */
const COUNTER_RETENTION_MS = 30 * 24 * HOUR_MS;
/** Classes that almost always mean a defect in AIQSA's own code, whatever the record's code. */
const PROGRAMMING_ERRORS = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError"]);
/** Codes that say only that nobody classified the failure. */
const UNCLASSIFIED_CODES = new Set(["unknown", "unexpected"]);

export type HealthCounterRows = Readonly<{
  /** `provider_operation` grouped by bucket, connectionId, outcome, code, httpStatus, reason, action. */
  providerOperations: readonly TelemetryCounterGroup[];
  /** Error-level HTTP request records grouped by bucket. */
  serverErrors: readonly TelemetryCounterGroup[];
  /** `process.started` grouped by bucket and role. */
  processStarts: readonly TelemetryCounterGroup[];
  /** `logging.dropped_records` grouped by bucket; `valueSum` is the dropped line count. */
  droppedRecords: readonly TelemetryCounterGroup[];
  /** Error-level background lifecycle records grouped by bucket and subsystem. */
  backgroundErrors: readonly TelemetryCounterGroup[];
  /** `tool_execution` over the timeout window grouped by bucket, tool_kind, stage, outcome, reason. */
  toolOutcomes: readonly TelemetryCounterGroup[];
  /** `job_attempt` over the timeout window grouped by bucket, subsystem, outcome, code. */
  jobOutcomes: readonly TelemetryCounterGroup[];
  /** Error and fatal records over the new-error window grouped by fingerprint, class, site and code. */
  errorFingerprints: readonly TelemetryCounterGroup[];
  /** Error and fatal records over counter retention grouped by fingerprint (their first occurrence). */
  errorFirstSeen: readonly TelemetryCounterGroup[];
}>;

export type HealthFinding =
  | Readonly<{ code: "provider_runtime_key_rejected"; connectionId: string; failures: number }>
  | Readonly<{ code: "provider_runtime_quota_exhausted"; connectionId: string; failures: number }>
  | Readonly<{ code: "provider_runtime_failing"; connectionId: string; failures: number; total: number;
    kinds: Readonly<Record<ProviderFailureKind, number>> }>
  | Readonly<{ code: "server_errors_rising"; errors: number }>
  | Readonly<{ code: "process_restarting"; role: HealthRole; starts: number }>
  | Readonly<{ code: "logs_dropped"; lines: number }>
  | Readonly<{ code: "background_failures"; subsystem: HealthSubsystem; errors: number }>
  | Readonly<{ code: "operation_timeouts_rising"; operation: HealthTimedOperation; timeouts: number; total: number }>
  | Readonly<{ code: "new_error"; fingerprint: string; errorClass: string; site: string | null; count: number }>
  | Readonly<{ code: "new_error"; fingerprint: null; more: number }>;

export type ProviderFailureKind = "network" | "other" | "rate_limited" | "server_error" | "timeout";

const roleLabels = {
  app: "The application",
  bootstrap: "Database setup",
  knowledge_search: "The Knowledge search worker",
  maintenance: "The maintenance worker",
  memory_coordinator: "The Memory worker",
  memory_search: "The Memory search worker",
  storage_relay: "The storage relay",
  workspace_runner: "The Workspace runner"
} as const;
export type HealthRole = keyof typeof roleLabels | "other";

const subsystemLabels = {
  admin: "Control Center",
  attachments: "File attachments",
  chat_title: "Chat titles",
  configuration: "Configuration",
  database: "Database",
  email: "Email",
  knowledge: "Knowledge",
  knowledge_search: "Knowledge search",
  mcp: "MCP servers",
  memory: "Memory",
  memory_search: "Memory search",
  object_storage: "File storage",
  pdf: "PDF processing",
  push: "Push notifications",
  run_recovery: "Chat run recovery",
  scheduled_tasks: "Scheduled tasks",
  telemetry: "Health telemetry",
  workspace: "Workspace"
} as const;
export type HealthSubsystem = keyof typeof subsystemLabels | "other";

const toolLabels = {
  knowledge: "Knowledge search",
  mcp: "MCP tools",
  search: "Web search",
  vision: "Image analysis",
  workspace: "Workspace tools"
} as const;
export type HealthTimedOperation =
  | Readonly<{ kind: "tool"; name: keyof typeof toolLabels }>
  | Readonly<{ kind: "subsystem"; name: HealthSubsystem }>;

const BACKGROUND_EVENTS = ["job_attempt", "job_persistence", "run_recovery", "runtime_lifecycle", "service_operation"];
const SERVER_ERROR_EVENTS = ["http.request_completed", "http.request_failed"];
/** Request-shaped failures (a stop, a policy fence, a safety limit) say nothing about the provider's health. */
const NON_HEALTH_REASONS = new Set(["cancelled", "policy", "safety_limit"]);
const TIMEOUT_CODE = /(?:^|_)(?:timeout|timed_out)(?:$|_)/u;

function floorHour(time: number): number {
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

function windowQuery(now: Date, windowMs: number): Pick<TelemetryCounterQuery, "from" | "to"> {
  return { from: new Date(floorHour(now.getTime() - windowMs)), to: new Date(floorHour(now.getTime()) + HOUR_MS) };
}

/** Reads the counters every rule needs, in parallel; any failed read fails the whole health source. */
export async function readHealthCounterRows(
  reader: Pick<TelemetryStore, "readCounters">,
  now: Date,
  thresholds: HealthThresholds = HEALTH_ATTENTION_THRESHOLDS
): Promise<HealthCounterRows> {
  const recent = windowQuery(now, thresholds.windowMs);
  const day = windowQuery(now, thresholds.timeoutWindowMs);
  const fresh = windowQuery(now, thresholds.newErrorWindowMs);
  const retained = windowQuery(now, COUNTER_RETENTION_MS);
  const [providerOperations, serverErrors, processStarts, droppedRecords, backgroundErrors, toolOutcomes, jobOutcomes,
    errorFingerprints, errorFirstSeen] =
    await Promise.all([
      reader.readCounters({ ...recent, events: ["provider_operation"], limit: ROW_LIMIT,
        groupBy: ["bucket", "connectionId", "outcome", "code", "httpStatus", "reason", "action"] }),
      reader.readCounters({ ...recent, events: SERVER_ERROR_EVENTS, levels: ["error", "fatal"], groupBy: ["bucket"], limit: ROW_LIMIT }),
      reader.readCounters({ ...recent, events: ["process.started"], groupBy: ["bucket", "role"], limit: ROW_LIMIT }),
      reader.readCounters({ ...recent, events: ["logging.dropped_records"], groupBy: ["bucket"], limit: ROW_LIMIT }),
      reader.readCounters({ ...recent, events: BACKGROUND_EVENTS, levels: ["error", "fatal"], groupBy: ["bucket", "subsystem"], limit: ROW_LIMIT }),
      reader.readCounters({ ...day, events: ["tool_execution"], groupBy: ["bucket", "tool_kind", "stage", "outcome", "reason"], limit: ROW_LIMIT }),
      reader.readCounters({ ...day, events: ["job_attempt"], groupBy: ["bucket", "subsystem", "outcome", "code"], limit: ROW_LIMIT }),
      reader.readCounters({ ...fresh, levels: ["error", "fatal"], groupBy: ["error_fingerprint", "error_class", "error_site", "code"], limit: ROW_LIMIT }),
      reader.readCounters({ ...retained, levels: ["error", "fatal"], groupBy: ["error_fingerprint"], limit: ROW_LIMIT })
    ]);
  return { providerOperations, serverErrors, processStarts, droppedRecords, backgroundErrors, toolOutcomes, jobOutcomes,
    errorFingerprints, errorFirstSeen };
}

function text(row: TelemetryCounterGroup, key: string): string | null {
  const value = (row.group as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numeric(row: TelemetryCounterGroup, key: string): number | null {
  const value = (row.group as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function within(rows: readonly TelemetryCounterGroup[], since: number): TelemetryCounterGroup[] {
  return rows.filter((row) => row.lastSeenAt instanceof Date && row.lastSeenAt.getTime() >= since && row.count > 0);
}

function sum(rows: readonly TelemetryCounterGroup[], value: (row: TelemetryCounterGroup) => number = (row) => row.count): number {
  return rows.reduce((total, row) => total + value(row), 0);
}

function grouped<K extends string>(rows: readonly TelemetryCounterGroup[], key: (row: TelemetryCounterGroup) => K | null): Map<K, TelemetryCounterGroup[]> {
  const groups = new Map<K, TelemetryCounterGroup[]>();
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    const list = groups.get(value);
    if (list) list.push(row);
    else groups.set(value, [row]);
  }
  return groups;
}

function known<T extends string>(labels: Readonly<Record<T, string>>, value: string | null): T | "other" {
  return value !== null && Object.hasOwn(labels, value) ? value as T : "other";
}

function latest(rows: readonly TelemetryCounterGroup[]): number {
  return rows.reduce((value, row) => Math.max(value, row.lastSeenAt.getTime()), Number.NEGATIVE_INFINITY);
}

type ProviderOutcome = "auth" | "completed" | "failure" | "ignored" | "quota";

function providerOutcome(row: TelemetryCounterGroup): ProviderOutcome {
  const outcome = text(row, "outcome");
  if (outcome === "completed") return "completed";
  // A failed attempt that will be retried has not decided the operation.
  if (outcome !== "failed" || text(row, "action") === "retry") return "ignored";
  const code = text(row, "code");
  const status = numeric(row, "httpStatus");
  if (code === "provider_auth_rejected" || status === 401 || status === 403) return "auth";
  if (code === "provider_quota_exhausted" || status === 402) return "quota";
  // Other client errors (a malformed or oversized request, an unknown model) belong to the request.
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "ignored";
  const reason = text(row, "reason");
  return reason !== null && NON_HEALTH_REASONS.has(reason) ? "ignored" : "failure";
}

function providerFailureKind(row: TelemetryCounterGroup): ProviderFailureKind {
  const code = text(row, "code");
  const status = numeric(row, "httpStatus");
  const reason = text(row, "reason");
  if (code === "provider_rate_limited" || status === 429) return "rate_limited";
  if (code === "provider_server_error" || status !== null && status >= 500) return "server_error";
  if (reason === "deadline" || status === 408) return "timeout";
  if (reason === "network") return "network";
  return "other";
}

function providerFindings(rows: readonly TelemetryCounterGroup[], thresholds: HealthThresholds): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const [connectionId, connectionRows] of grouped(rows, (row) => text(row, "connectionId"))) {
    const byOutcome = grouped(connectionRows, providerOutcome);
    const completed = byOutcome.get("completed") ?? [];
    const lastCompleted = latest(completed);
    let keyFailure = false;
    for (const [outcome, code] of [["auth", "provider_runtime_key_rejected"], ["quota", "provider_runtime_quota_exhausted"]] as const) {
      const failed = byOutcome.get(outcome) ?? [];
      // A later successful operation means the key works again.
      if (failed.length === 0 || latest(failed) <= lastCompleted) continue;
      keyFailure = true;
      findings.push({ code, connectionId, failures: sum(failed) });
    }
    if (keyFailure) continue;
    const failures = byOutcome.get("failure") ?? [];
    const failed = sum(failures);
    const total = failed + sum(completed);
    if (failed < thresholds.providerFailingMinFailures || total === 0 || failed / total < thresholds.providerFailingMinShare) continue;
    const kinds: Record<ProviderFailureKind, number> = { network: 0, other: 0, rate_limited: 0, server_error: 0, timeout: 0 };
    for (const row of failures) kinds[providerFailureKind(row)] += row.count;
    findings.push({ code: "provider_runtime_failing", connectionId, failures: failed, total, kinds });
  }
  return findings;
}

type TimedRow = Readonly<{ key: string; operation: HealthTimedOperation; finished: boolean; timedOut: boolean; count: number }>;

function timeoutFindings(rows: readonly TimedRow[], thresholds: HealthThresholds): HealthFinding[] {
  // Each stage of a tool counts separately; the worst stage speaks for the tool.
  const stages = new Map<string, { operation: HealthTimedOperation; total: number; timeouts: number }>();
  for (const row of rows) {
    if (!row.finished) continue;
    const stage = stages.get(row.key) ?? { operation: row.operation, total: 0, timeouts: 0 };
    stage.total += row.count;
    if (row.timedOut) stage.timeouts += row.count;
    stages.set(row.key, stage);
  }
  const worst = new Map<string, { operation: HealthTimedOperation; total: number; timeouts: number }>();
  for (const stage of stages.values()) {
    if (stage.total < thresholds.timeoutMinOutcomes || stage.timeouts / stage.total < thresholds.timeoutMinShare) continue;
    const id = `${stage.operation.kind}:${stage.operation.name}`;
    const current = worst.get(id);
    if (!current || stage.timeouts / stage.total > current.timeouts / current.total) worst.set(id, stage);
  }
  return [...worst.values()].map((stage) => ({
    code: "operation_timeouts_rising", operation: stage.operation, timeouts: stage.timeouts, total: stage.total
  }));
}

/** Pure evaluation of every rule over already-read counter rows. */
export function evaluateHealthRules(
  rows: HealthCounterRows,
  now: Date,
  thresholds: HealthThresholds = HEALTH_ATTENTION_THRESHOLDS
): HealthFinding[] {
  const since = now.getTime() - thresholds.windowMs;
  const daySince = now.getTime() - thresholds.timeoutWindowMs;
  const findings: HealthFinding[] = providerFindings(within(rows.providerOperations, since), thresholds);

  const serverErrors = sum(within(rows.serverErrors, since));
  if (serverErrors >= thresholds.serverErrorsMin) findings.push({ code: "server_errors_rising", errors: serverErrors });

  for (const [role, starts] of grouped(within(rows.processStarts, since), (row) => known(roleLabels, text(row, "role")))) {
    const count = sum(starts);
    if (count >= thresholds.processStartsMin) findings.push({ code: "process_restarting", role, starts: count });
  }

  const dropped = within(rows.droppedRecords, since);
  // Every report names at least one line; an old row without a sum still counts as one.
  const lines = sum(dropped, (row) => Math.max(row.valueSum, row.count));
  if (dropped.length > 0 && lines >= thresholds.droppedLogLinesMin) findings.push({ code: "logs_dropped", lines });

  for (const [subsystem, errors] of grouped(within(rows.backgroundErrors, since), (row) => known(subsystemLabels, text(row, "subsystem")))) {
    const count = sum(errors);
    if (count >= thresholds.backgroundErrorsMin) findings.push({ code: "background_failures", subsystem, errors: count });
  }

  const timed: TimedRow[] = [
    ...within(rows.toolOutcomes, daySince).flatMap((row): TimedRow[] => {
      const tool = text(row, "tool_kind");
      if (tool === null || !Object.hasOwn(toolLabels, tool)) return [];
      const outcome = text(row, "outcome");
      return [{
        key: `tool:${tool}:${text(row, "stage") ?? ""}`,
        operation: { kind: "tool", name: tool as keyof typeof toolLabels },
        finished: outcome === "completed" || outcome === "failed" || outcome === "degraded",
        timedOut: text(row, "reason") === "deadline",
        count: row.count
      }];
    }),
    ...within(rows.jobOutcomes, daySince).flatMap((row): TimedRow[] => {
      const subsystem = text(row, "subsystem");
      if (subsystem === null) return [];
      const outcome = text(row, "outcome");
      const name = known(subsystemLabels, subsystem);
      return [{
        key: `subsystem:${name}`,
        operation: { kind: "subsystem", name },
        finished: outcome === "completed" || outcome === "failed",
        timedOut: outcome === "failed" && TIMEOUT_CODE.test(text(row, "code") ?? ""),
        count: row.count
      }];
    })
  ];
  findings.push(...timeoutFindings(timed, thresholds));
  findings.push(...newErrorFindings(rows, now, thresholds));
  return findings;
}

/**
 * A failure is new when its fingerprint first appears within the window. Only
 * unclassified failures and programming errors count: a classified failure
 * (a rejected key, a timeout) already has its own rule and copy.
 */
function newErrorFindings(rows: HealthCounterRows, now: Date, thresholds: HealthThresholds): HealthFinding[] {
  const since = now.getTime() - thresholds.newErrorWindowMs;
  const firstSeen = new Map<string, number>();
  for (const row of rows.errorFirstSeen) {
    const fingerprint = text(row, "error_fingerprint");
    if (fingerprint !== null) firstSeen.set(fingerprint, Math.min(firstSeen.get(fingerprint) ?? Infinity, row.firstSeenAt.getTime()));
  }
  const candidates = new Map<string, { errorClass: string; site: string | null; siteSeenAt: number; count: number; first: number }>();
  for (const row of within(rows.errorFingerprints, since)) {
    const fingerprint = text(row, "error_fingerprint");
    const errorClass = text(row, "error_class") ?? "Error";
    const code = text(row, "code");
    if (fingerprint === null || !(code === null || UNCLASSIFIED_CODES.has(code) || PROGRAMMING_ERRORS.has(errorClass))) continue;
    const entry = candidates.get(fingerprint) ?? { errorClass, site: null, siteSeenAt: -1, count: 0, first: Infinity };
    const site = text(row, "error_site");
    if (site !== null && row.lastSeenAt.getTime() > entry.siteSeenAt) {
      entry.site = site;
      entry.siteSeenAt = row.lastSeenAt.getTime();
    }
    entry.count += row.count;
    entry.first = Math.min(entry.first, row.firstSeenAt.getTime(), firstSeen.get(fingerprint) ?? Infinity);
    candidates.set(fingerprint, entry);
  }
  const fresh = [...candidates.entries()]
    .filter(([, entry]) => entry.first >= since)
    .sort(([leftKey, left], [rightKey, right]) => right.count - left.count || leftKey.localeCompare(rightKey));
  const named: HealthFinding[] = fresh.slice(0, thresholds.newErrorItemsMax).map(([fingerprint, entry]) => ({
    code: "new_error", fingerprint, errorClass: entry.errorClass, site: entry.site, count: entry.count
  }));
  const more = fresh.length - named.length;
  return more > 0 ? [...named, { code: "new_error", fingerprint: null, more }] : named;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const failureKindCopy: Readonly<Record<ProviderFailureKind, string>> = {
  network: "network errors",
  other: "other errors",
  rate_limited: "rate limits",
  server_error: "provider server errors",
  timeout: "timeouts"
};

function failureMix(kinds: Readonly<Record<ProviderFailureKind, number>>): string {
  return (Object.entries(kinds) as [ProviderFailureKind, number][])
    .filter(([, count]) => count > 0)
    .sort(([leftKind, left], [rightKind, right]) => right - left || leftKind.localeCompare(rightKind))
    .slice(0, 2)
    .map(([kind, count]) => `${failureKindCopy[kind]} ${count}`)
    .join(", ");
}

function operationLabel(operation: HealthTimedOperation): string {
  return operation.kind === "tool" ? toolLabels[operation.name]
    : operation.name === "other" ? "Background jobs" : `${subsystemLabels[operation.name]} jobs`;
}

/**
 * Human copy and navigation for findings. Provider findings name the connection
 * from the administrator's provider list and jump to its page; a connection
 * that is gone or switched off has nothing left to fix and stays quiet.
 */
export function healthAttentionItems(
  findings: readonly HealthFinding[],
  connections: readonly AdminProviderConnection[] | null
): AdminAttentionItem[] {
  const items: AdminAttentionItem[] = [];
  for (const finding of findings) {
    switch (finding.code) {
      case "provider_runtime_key_rejected":
      case "provider_runtime_quota_exhausted":
      case "provider_runtime_failing": {
        const connection = connections?.find(({ id }) => id === finding.connectionId);
        if (connections && (!connection || !connection.enabled)) continue;
        const name = connection?.displayName ?? "A provider connection";
        const base = { action: "Open provider", id: `${finding.code}:${finding.connectionId}`,
          target: { resource: finding.connectionId, section: "providers" as const } };
        if (finding.code === "provider_runtime_key_rejected") {
          items.push({ ...base, code: finding.code, count: finding.failures, severity: "bad",
            detail: `${name} rejected its key ${plural(finding.failures, "time")} in the last hour, after its last successful request — check the key`,
            title: "Provider key rejected during use" });
        } else if (finding.code === "provider_runtime_quota_exhausted") {
          items.push({ ...base, code: finding.code, count: finding.failures, severity: "bad",
            detail: `${name} reported no remaining quota or balance ${plural(finding.failures, "time")} in the last hour — check the provider account`,
            title: "Provider quota exhausted" });
        } else {
          items.push({ ...base, code: finding.code, count: finding.failures, severity: "warn",
            detail: `${name} · ${finding.failures} of ${plural(finding.total, "request")} failed in the last hour (${failureMix(finding.kinds)})`,
            title: "Provider requests are failing" });
        }
        break;
      }
      case "server_errors_rising":
        items.push({ action: "Open Health", code: finding.code, count: finding.errors, id: finding.code, severity: "warn",
          detail: `${plural(finding.errors, "request")} ended with a server error in the last hour`,
          target: { section: "health" }, title: "Server errors are rising" });
        break;
      case "process_restarting":
        items.push({ action: "Open Health", code: finding.code, count: finding.starts, id: `${finding.code}:${finding.role}`,
          severity: "bad",
          detail: `${finding.role === "other" ? "A service" : roleLabels[finding.role]} started ${plural(finding.starts, "time")} in the last hour — check its logs`,
          target: { section: "health" }, title: "A service keeps restarting" });
        break;
      case "logs_dropped":
        items.push({ action: "Open Health", code: finding.code, count: finding.lines, id: finding.code, severity: "warn",
          detail: `${plural(finding.lines, "log line")} could not be written in the last hour, so some diagnostics are missing`,
          target: { section: "health" }, title: "Log lines were dropped" });
        break;
      case "background_failures":
        items.push({ action: "Open Health", code: finding.code, count: finding.errors, id: `${finding.code}:${finding.subsystem}`,
          severity: "warn",
          detail: `${finding.subsystem === "other" ? "Other background work" : subsystemLabels[finding.subsystem]} · ${plural(finding.errors, "error")} in the last hour`,
          target: { section: "health" }, title: "Background work is failing" });
        break;
      case "new_error":
        if (finding.fingerprint === null) {
          items.push({ action: "Open Health", code: finding.code, count: finding.more, id: `${finding.code}:more`, severity: "warn",
            detail: `${plural(finding.more, "more new failure")} first appeared in the last 24 hours`,
            target: { section: "health" }, title: "More new errors" });
        } else {
          items.push({ action: "Open Health", code: finding.code, count: finding.count, id: `${finding.code}:${finding.fingerprint}`,
            severity: "warn",
            detail: `${finding.errorClass} ${finding.site ? `at ${finding.site}` : "outside application code"} · ${plural(finding.count, "time")} since it first appeared in the last 24 hours`,
            target: { section: "health" }, title: "A new error appeared" });
        }
        break;
      case "operation_timeouts_rising":
        items.push({ action: "Open Health", code: finding.code, count: finding.timeouts,
          id: `${finding.code}:${finding.operation.kind}:${finding.operation.name}`, severity: "warn",
          detail: `${operationLabel(finding.operation)} · ${finding.timeouts} of ${finding.total} ran out of time in the last 24 hours`,
          target: { section: "health" }, title: "Operations are timing out" });
        break;
    }
  }
  return items;
}

/** Reads and evaluates the health rules at `now`. */
export async function readHealthFindings(
  reader: Pick<TelemetryStore, "readCounters">,
  now: Date,
  thresholds: HealthThresholds = HEALTH_ATTENTION_THRESHOLDS
): Promise<HealthFinding[]> {
  return evaluateHealthRules(await readHealthCounterRows(reader, now, thresholds), now, thresholds);
}
