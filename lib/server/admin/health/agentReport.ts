import type {
  AdminHealthErrorGroup, AdminHealthIncident, AdminHealthRange, AdminHealthRoleStarts
} from "../../../contracts/adminHealth";
import type { AdminHealthQueueRow } from "../../../contracts/adminHealthQueues";
import type { AdminHealthRunSummary } from "../../../contracts/adminHealthRunLookup";
import { normalizeRunReference, RUN_ID_LENGTH, runReferenceLabel } from "../../../contracts/runReference";
import type { AnswerProblemReportListRow } from "../../answerProblemReports/repository";
import { TELEMETRY_DURATION_BUCKETS } from "../../telemetry/aggregator";
import type {
  TelemetryCounterGroup, TelemetryCounterQuery, TelemetryGroupValue, TelemetryIncident, TelemetryIncidentReach, TelemetryStore
} from "../../telemetry/store";
import {
  adminHealthErrorGroupsWithReach, adminHealthQuantile, adminHealthRetentionWindow, adminHealthWindow, foldAdminHealthErrorGroups
} from "./projection";
import type { FailedRunLoad, FailedRunQuery } from "./failedRuns";
import type { AdminHealthQueuesService } from "./queues";
import { HEALTH_REPORT_VERSION } from "./report";
import { projectAdminHealthRun, type AdminHealthRunRow } from "./runLookup";
import type { AdminHealthUserRunsQuery } from "./runLookupRepository";
import {
  adminHealthBoundedIds, adminHealthConnectionLabel, adminHealthIncidentModelId, adminHealthModelLabel,
  projectAdminHealthIncident, type AdminHealthDependencies, type AdminHealthProviderNames
} from "./service";

/**
 * The agent reports of `./aiqsa.sh health`: `--full` lists every problem of a
 * range, complete and structured, and `--user <id>` one user's incidents,
 * failed runs and problem reports. Both only read. Unlike the default report
 * they carry internal user ids and problem-report comments, so their first
 * field (and first text line) says so: they stay on the host. Never message
 * content, prompts, answers, URLs, file or tool names, secrets or `.env` values.
 *
 * Every list is bounded and says when it was cut. Counts are telemetry
 * records unless a field says otherwise; incidents are a sampled subset.
 * `--json` fields are added, never renamed or removed, without bumping `version`.
 */
export const HEALTH_AGENT_PRIVACY = "contains_user_ids_and_comments" as const;
export const HEALTH_AGENT_PRIVACY_NOTICE =
  "PRIVATE: contains internal user ids and problem-report comments. Keep it on the host; do not paste it anywhere.";

export const HEALTH_FULL_FAILURE_LIMIT = 2_000;
export const HEALTH_FULL_ERROR_GROUP_LIMIT = 500;
/** Rows of each other grouped section (timeouts, sign-ins, tool calls, HTTP, operations). */
export const HEALTH_FULL_ROW_LIMIT = 1_000;
export const HEALTH_PROBLEM_REPORT_LIMIT = 500;
export const HEALTH_NEWEST_INCIDENT_LIMIT = 1_000;
export const HEALTH_INCIDENT_KEY_LIMIT = 1_000;
export const HEALTH_USER_RUN_LIMIT = 500;
/** Failure codes of the failed-runs section, and the newest runs listed per code. */
export const HEALTH_FULL_FAILED_RUN_CODE_LIMIT = 200;
export const HEALTH_FULL_FAILED_RUNS_PER_CODE = 20;

/** The store's own row bound per counter read: a read that fills it may miss rows. */
const READ_LIMIT = 5_000;
const INCIDENT_PAGE = 200;
const IDS_PER_READ = 64;
/** Reads in flight at once: well inside the database pool, so none waits past its pool timeout. */
const PARALLEL_READS = 4;

// --- Report shapes

export type HealthDurationStats = {
  /** Records carrying a duration. */
  measured: number;
  /** Percentiles as the upper bound of their histogram bucket, capped by the maximum. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type HealthRunTotals = {
  /** Runs admitted (`run_accepted`). */
  accepted: number;
  acceptedByKind: { send: number; regenerate: number; project: number };
  /** Runs settled once each: the single confirmed terminal write per run. */
  completed: number;
  /** Failed runs: live failures, failures during preparation and failures settled by recovery. */
  failed: number;
  failedInPreparation: number;
  failedInRecovery: number;
  cancelled: number;
  /** Terminal writes that failed on the database; such a run is settled later or stays open. */
  unconfirmed: number;
  /** failed / (completed + failed + cancelled); `null` without settled runs. */
  failureRate: number | null;
  cancelRate: number | null;
  stopRequests: number;
};

export type HealthFailedRunSample = {
  runId: string;
  /** The reference `./aiqsa.sh health --run` accepts. */
  runReference: string;
  userId: string;
  /** When the run was created. */
  startedAt: string;
};

export type HealthFailedRunCodeRow = {
  /** The runs' stable failure code; `null` when they carry none. */
  failureCode: string | null;
  runs: number;
  users: number;
  firstAt: string;
  lastAt: string;
  /** The newest runs of the code, newest first. */
  newest: HealthFailedRunSample[];
};

export type HealthLatencyProviderRow = HealthDurationStats & {
  providerFamily: string | null;
  connectionId: string | null;
  connectionName: string | null;
  providerModelId: string | null;
  modelName: string | null;
};

type Seen = { count: number; firstSeenAt: string; lastSeenAt: string };

export type HealthFailureRow = Seen & {
  event: string;
  level: string;
  code: string | null;
  subsystem: string | null;
  stage: string | null;
  reason: string | null;
  /** Route template, never a URL. */
  routePath: string | null;
  /** HTTP response status of a request record. */
  status: number | null;
  /** Upstream HTTP status of a provider or tool record. */
  httpStatus: number | null;
  providerFamily: string | null;
  toolKind: string | null;
  /** The per-event overflow key: records beyond the writer's key bound, without their fields. */
  overflow: boolean;
  appVersions: string[];
};

export type HealthTimeoutRow = Seen & {
  event: string;
  layer: string | null;
  abortSource: string | null;
  stage: string | null;
  operation: string | null;
  providerFamily: string | null;
  toolKind: string | null;
  code: string | null;
};

export type HealthFullErrorGroup = AdminHealthErrorGroup & {
  /** First seen (within counter retention) inside this range. */
  newInRange: boolean;
};

export type HealthSignInRow = Seen & { method: string | null; step: string | null; outcome: string | null; code: string | null };
export type HealthToolCallRow = Seen & { toolKind: string | null; outcome: string | null; code: string | null };
export type HealthToolFamilyRow = HealthDurationStats & {
  toolKind: string | null; calls: number; failed: number; timedOut: number; cancelled: number;
};
export type HealthHttpRow = Seen & {
  event: string; level: string; routePath: string | null; method: string | null; status: number | null;
  outcome: string | null; stage: string | null;
};
export type HealthClientErrorRow = Seen & { kind: string | null; routePath: string | null };

export type HealthProblemReportRow = {
  reportedAt: string;
  createdAt: string;
  reason: string;
  userId: string;
  runId: string | null;
  /** The reference `./aiqsa.sh health --run` accepts. */
  runReference: string | null;
  connectionName: string | null;
  modelName: string | null;
  /** The user's own words; only these agent reports carry it. */
  comment: string | null;
};

export type HealthAgentIncident = AdminHealthIncident & {
  appVersion: string;
  userId: string | null;
  runReference: string | null;
  errorClass: string | null;
  errorSite: string | null;
  fingerprint: string | null;
};

export type HealthFullIncident = HealthAgentIncident & {
  /** The first incident of its key (event, code, subsystem, connection, fingerprint) in the range. */
  firstOfKey: boolean;
};

export type HealthIncidentKeyRow = {
  event: string;
  code: string | null;
  subsystem: string | null;
  connectionId: string | null;
  connectionName: string | null;
  fingerprint: string | null;
  incidents: number;
  usersAtLeast: number;
  runsAtLeast: number;
  firstAt: string;
  lastAt: string;
};

export type HealthOperationRow = Seen & {
  level: string; stage: string | null; code: string | null; outcome: string | null; action: string | null;
};
export type HealthReadinessRow = Seen & { state: string | null; code: string | null };

export type HealthFullReport = {
  privacy: typeof HEALTH_AGENT_PRIVACY;
  kind: "full";
  version: typeof HEALTH_REPORT_VERSION;
  range: AdminHealthRange;
  /** Whole UTC buckets: every section covers `[from, to)`. */
  from: string;
  to: string;
  generatedAt: string;
  hasTelemetry: boolean;
  /** The equal period right before, compared in `runs.previous`; `null` beyond counter retention. */
  previousPeriod: { from: string; to: string } | null;
  runs: HealthRunTotals & { previous: HealthRunTotals | null };
  /**
   * Runs created in the range that failed, read from the runs themselves, by
   * failure code with the most runs first. A user's Stop or cancellation and
   * refused user input are not failures. Counts are runs, not records.
   */
  failedRuns: { runs: number; users: number; rows: HealthFailedRunCodeRow[]; truncated: boolean };
  latency: {
    /** Live run executions that completed, from dispatch to completion. */
    runDuration: HealthDurationStats & { byProvider: HealthLatencyProviderRow[] };
    /** From acceptance to the first answer text, split by whether tool rounds came first. */
    firstOutput: HealthDurationStats & { byAfter: Array<HealthDurationStats & { after: string | null }>; byProvider: HealthLatencyProviderRow[] };
    truncated: boolean;
  };
  /** Every warn, error and fatal counter key, most records first. */
  failures: { rows: HealthFailureRow[]; truncated: boolean };
  /** Deadline aborts, transport timeouts, timed-out tool calls and run deadlines. */
  timeouts: { rows: HealthTimeoutRow[]; truncated: boolean };
  errorGroups: { rows: HealthFullErrorGroup[]; truncated: boolean };
  signIns: { rows: HealthSignInRow[]; truncated: boolean };
  toolCalls: { rows: HealthToolCallRow[]; families: HealthToolFamilyRow[]; truncated: boolean };
  /** 4xx and 5xx responses, requests that failed before a response, and browser crashes. */
  http: { rows: HealthHttpRow[]; clientErrors: HealthClientErrorRow[]; truncated: boolean };
  problemReports: { rows: HealthProblemReportRow[]; total: number; truncated: boolean };
  incidents: {
    /** The newest incidents plus the first of each key, newest first. */
    rows: HealthFullIncident[];
    newestLimit: number;
    /** Older incidents exist beyond the newest ones listed. */
    newestTruncated: boolean;
    /** More keys exist than their first incidents listed. */
    firstOfKeyTruncated: boolean;
    keys: HealthIncidentKeyRow[];
    keysTruncated: boolean;
  };
  operations: {
    roleStarts: AdminHealthRoleStarts[];
    queues: AdminHealthQueueRow[];
    queuesCheckedAt: string;
    /** Log lines the structured writer dropped, and how many reports said so. */
    droppedLogRecords: { records: number; reports: number };
    /** Telemetry writes, pruning and records the recorder could not keep. */
    telemetry: HealthOperationRow[];
    readiness: HealthReadinessRow[];
    truncated: boolean;
  };
};

export type HealthUserRun = AdminHealthRunSummary & { runReference: string };

export type HealthUserReport = {
  privacy: typeof HEALTH_AGENT_PRIVACY;
  kind: "user";
  version: typeof HEALTH_REPORT_VERSION;
  userId: string;
  /** False when no account has this id (any more). */
  userExists: boolean;
  range: AdminHealthRange;
  from: string;
  to: string;
  generatedAt: string;
  incidents: { rows: HealthAgentIncident[]; truncated: boolean };
  /** Failed and cancelled runs created in the range, newest first. */
  failedRuns: { rows: HealthUserRun[]; truncated: boolean };
  problemReports: { rows: HealthProblemReportRow[]; total: number; truncated: boolean };
};

export type HealthAgentReportSources = Readonly<{
  store: Pick<TelemetryStore, "readCounters" | "readIncidents" | "countIncidentsByRun" | "countIncidentReachByFingerprint" |
    "countIncidentReachByKey" | "readFirstIncidentPerKey">;
  providerNames: AdminHealthDependencies["providerNames"];
  queues: Pick<AdminHealthQueuesService, "read">;
  problemReports(query: Readonly<{ from: Date; to: Date; limit: number; userId?: string }>):
    Promise<Readonly<{ rows: readonly AnswerProblemReportListRow[]; total: number }>>;
  failedRuns(query: AdminHealthUserRunsQuery): Promise<readonly AdminHealthRunRow[]>;
  /** Every user's failed runs of a range by failure code (`readFailedRunLoad`). */
  failedRunGroups(query: Omit<FailedRunQuery, "statementTimeoutMs">): Promise<FailedRunLoad>;
  userExists(userId: string): Promise<boolean>;
  now?: () => Date;
}>;

// --- Helpers

function text(value: TelemetryGroupValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: TelemetryGroupValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function seen(rows: readonly TelemetryCounterGroup[]): Seen {
  return {
    count: rows.reduce((total, row) => total + row.count, 0),
    firstSeenAt: new Date(Math.min(...rows.map((row) => row.firstSeenAt.getTime()))).toISOString(),
    lastSeenAt: new Date(Math.max(...rows.map((row) => row.lastSeenAt.getTime()))).toISOString()
  };
}

function rate(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

function stats(rows: readonly TelemetryCounterGroup[]): HealthDurationStats {
  const buckets = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
  let maxMs: number | null = null;
  let measured = 0;
  for (const row of rows) {
    measured += row.durationCount;
    row.durationBuckets.forEach((value, index) => {
      if (index < buckets.length) buckets[index] = (buckets[index] ?? 0) + value;
    });
    if (row.durationMaxMs !== null) maxMs = Math.max(maxMs ?? 0, row.durationMaxMs);
  }
  return {
    measured,
    p50Ms: adminHealthQuantile(buckets, maxMs, 0.5),
    p95Ms: adminHealthQuantile(buckets, maxMs, 0.95),
    maxMs: maxMs === null ? null : Math.round(maxMs)
  };
}

/** Groups counter rows by a key, keeping first-seen order of the key. */
function groupRows(rows: readonly TelemetryCounterGroup[], key: (row: TelemetryCounterGroup) => string): TelemetryCounterGroup[][] {
  const groups = new Map<string, TelemetryCounterGroup[]>();
  for (const row of rows) {
    const id = key(row);
    const list = groups.get(id);
    if (list) list.push(row);
    else groups.set(id, [row]);
  }
  return [...groups.values()];
}

function byCount<T extends { count: number; lastSeenAt: string }>(left: T, right: T): number {
  return right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt);
}

/** Rows bounded to `limit`, with whether the read or the bound cut any. */
function bounded<T>(rows: readonly T[], limit: number, readFull: boolean): Readonly<{ rows: T[]; truncated: boolean }> {
  return { rows: rows.slice(0, limit), truncated: readFull || rows.length > limit };
}

/**
 * Runs at most `size` reads at once; a finished read hands its slot straight
 * to the next waiting one.
 */
function readLimiter(size: number): <T>(read: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (active < size) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function runIdOf(value: string | null): string | null {
  return value !== null && value.length === RUN_ID_LENGTH && normalizeRunReference(value) === value ? value : null;
}

function detailText(item: TelemetryIncident, key: string): string | null {
  const value = item.details[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function agentIncident(item: TelemetryIncident, names: AdminHealthProviderNames): HealthAgentIncident {
  const runId = runIdOf(item.runId);
  return {
    ...projectAdminHealthIncident(item, names),
    appVersion: item.appVersion,
    userId: item.userId,
    runReference: runId === null ? null : runReferenceLabel(runId),
    errorClass: detailText(item, "error_class"),
    errorSite: detailText(item, "error_site"),
    fingerprint: detailText(item, "error_fingerprint")
  };
}

function problemReportRow(row: AnswerProblemReportListRow): HealthProblemReportRow {
  const runId = runIdOf(row.runId);
  return {
    reportedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    reason: row.reason,
    userId: row.user.id,
    runId,
    runReference: runId === null ? null : runReferenceLabel(runId),
    connectionName: row.connectionName,
    modelName: row.modelName,
    comment: row.comment
  };
}

async function readProblemReports(sources: HealthAgentReportSources, query: Readonly<{ from: Date; to: Date; userId?: string }>):
  Promise<HealthFullReport["problemReports"]> {
  const { rows, total } = await sources.problemReports({ ...query, limit: HEALTH_PROBLEM_REPORT_LIMIT });
  const listed = rows.slice(0, HEALTH_PROBLEM_REPORT_LIMIT).map(problemReportRow);
  return { rows: listed, total: Math.max(total, listed.length), truncated: total > listed.length };
}

/** The newest incidents matching `filter`, page by page, at most `limit`. */
async function readNewestIncidents(
  store: HealthAgentReportSources["store"],
  filter: Readonly<{ from: Date; to: Date; userId?: string }>,
  limit: number
): Promise<Readonly<{ items: TelemetryIncident[]; truncated: boolean }>> {
  const items: TelemetryIncident[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.readIncidents({ ...filter, cursor, limit: Math.min(INCIDENT_PAGE, limit - items.length) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null && items.length < limit);
  return { items, truncated: cursor !== null };
}

function providerKey(row: TelemetryCounterGroup): string {
  return JSON.stringify([text(row.group.providerFamily), text(row.group.connectionId), text(row.group.providerModelId)]);
}

function latencyProviders(rows: readonly TelemetryCounterGroup[], names: AdminHealthProviderNames): HealthLatencyProviderRow[] {
  return groupRows(rows, providerKey).map((group): HealthLatencyProviderRow => {
    const first = group[0]!;
    const connectionId = text(first.group.connectionId);
    const providerModelId = text(first.group.providerModelId);
    return {
      providerFamily: text(first.group.providerFamily),
      connectionId,
      connectionName: connectionId === null ? null : adminHealthConnectionLabel(connectionId, names).connectionName,
      providerModelId,
      modelName: adminHealthModelLabel(providerModelId, names),
      ...stats(group)
    };
  }).filter((row) => row.measured > 0).sort((left, right) => right.measured - left.measured ||
    (left.providerFamily ?? "").localeCompare(right.providerFamily ?? "") ||
    (left.connectionName ?? "").localeCompare(right.connectionName ?? "") || (left.modelName ?? "").localeCompare(right.modelName ?? ""));
}

const RUN_EXECUTION_STAGES = new Set(["dispatch", "execution", "completion"]);

/**
 * Run totals from the records that settle a run exactly once: the guarded
 * terminal write (`run_persistence` confirmed: complete, fail, cancel, or a
 * failure during preparation) and recovery's own confirmed failure write
 * (`job_persistence` of `run_recovery` at stage fail). Execution records are
 * not counted: a run can log several failed ones (a deadline and the failure
 * it causes) and recovered runs log none.
 */
function runTotals(rows: readonly TelemetryCounterGroup[]): HealthRunTotals {
  const count = (match: (row: TelemetryCounterGroup) => boolean) =>
    rows.filter(match).reduce((total, row) => total + row.count, 0);
  const persisted = (stage: string, outcome = "confirmed") => count((row) => row.group.event === "run_persistence" &&
    row.group.stage === stage && row.group.outcome === outcome);
  const accepted = (kind: string) => count((row) => row.group.event === "run_accepted" && row.group.kind === kind);
  const failedInPreparation = persisted("preparation");
  const failedInRecovery = count((row) => row.group.event === "job_persistence" && row.group.subsystem === "run_recovery" &&
    row.group.stage === "fail" && row.group.outcome === "confirmed");
  const completed = persisted("complete");
  const failed = persisted("fail") + failedInPreparation + failedInRecovery;
  const cancelled = persisted("cancel");
  const settled = completed + failed + cancelled;
  return {
    accepted: count((row) => row.group.event === "run_accepted"),
    acceptedByKind: { send: accepted("send"), regenerate: accepted("regenerate"), project: accepted("project") },
    completed,
    failed,
    failedInPreparation,
    failedInRecovery,
    cancelled,
    unconfirmed: count((row) => row.group.event === "run_persistence" && row.group.outcome === "unconfirmed"),
    failureRate: rate(failed, settled),
    cancelRate: rate(cancelled, settled),
    stopRequests: count((row) => row.group.event === "run_stop_requested")
  };
}

const RUN_TOTAL_QUERY = {
  events: ["run_accepted", "run_persistence", "job_persistence", "run_stop_requested"],
  groupBy: ["event", "kind", "stage", "outcome", "subsystem"],
  limit: READ_LIMIT
} as const satisfies Omit<TelemetryCounterQuery, "from" | "to">;

function failureRows(rows: readonly TelemetryCounterGroup[]): HealthFailureRow[] {
  const key = (row: TelemetryCounterGroup) => JSON.stringify(["event", "level", "code", "subsystem", "stage", "reason", "routePath",
    "status", "httpStatus", "providerFamily", "tool_kind", "overflow"].map((name) => row.group[name as keyof typeof row.group] ?? null));
  return groupRows(rows, key).map((group): HealthFailureRow => {
    const first = group[0]!.group;
    return {
      event: text(first.event) ?? "unknown",
      level: text(first.level) ?? "unknown",
      code: text(first.code),
      subsystem: text(first.subsystem),
      stage: text(first.stage),
      reason: text(first.reason),
      routePath: text(first.routePath),
      status: integer(first.status),
      httpStatus: integer(first.httpStatus),
      providerFamily: text(first.providerFamily),
      toolKind: text(first.tool_kind),
      overflow: first.overflow === true,
      ...seen(group),
      appVersions: [...new Set(group.map((row) => text(row.group.appVersion)).filter((value): value is string => value !== null))].sort()
    };
  }).sort(byCount);
}

function timeoutRows(input: Readonly<{
  nested: readonly TelemetryCounterGroup[]; transport: readonly TelemetryCounterGroup[];
  tools: readonly TelemetryCounterGroup[]; runs: readonly TelemetryCounterGroup[];
}>): HealthTimeoutRow[] {
  const row = (event: string, group: TelemetryCounterGroup, fields: Partial<HealthTimeoutRow>): HealthTimeoutRow => ({
    event, layer: null, abortSource: null, stage: null, operation: null, providerFamily: null,
    toolKind: null, code: null, ...fields, ...seen([group])
  });
  return [
    ...input.nested.filter((group) => text(group.group.abort_source)?.endsWith("_deadline") === true).map((group) =>
      row("nested_abort", group, {
        layer: text(group.group.layer), abortSource: text(group.group.abort_source),
        stage: text(group.group.stage), operation: text(group.group.operation), providerFamily: text(group.group.providerFamily)
      })),
    ...input.transport.map((group) => row("transport_stage", group, {
      layer: text(group.group.transport), stage: text(group.group.stage), operation: text(group.group.operation),
      providerFamily: text(group.group.providerFamily), code: text(group.group.code)
    })),
    ...input.tools.map((group) => row("tool_call", group, { layer: "tool", toolKind: text(group.group.tool_kind), code: text(group.group.code) })),
    ...input.runs.map((group) => row("run_execution", group, {
      layer: "run", stage: text(group.group.stage), abortSource: text(group.group.abort_source),
      providerFamily: text(group.group.providerFamily), code: text(group.group.code)
    }))
  ].sort(byCount);
}

function toolFamilies(rows: readonly TelemetryCounterGroup[]): HealthToolFamilyRow[] {
  return groupRows(rows, (row) => JSON.stringify(row.group.tool_kind ?? null)).map((group): HealthToolFamilyRow => {
    const outcome = (name: string) => group.filter((row) => row.group.outcome === name).reduce((total, row) => total + row.count, 0);
    return {
      toolKind: text(group[0]!.group.tool_kind),
      calls: group.reduce((total, row) => total + row.count, 0),
      failed: outcome("failed"),
      timedOut: outcome("timeout"),
      cancelled: outcome("cancelled"),
      ...stats(group)
    };
  }).sort((left, right) => right.calls - left.calls || (left.toolKind ?? "").localeCompare(right.toolKind ?? ""));
}

async function reachByFingerprint(
  store: HealthAgentReportSources["store"], window: Readonly<{ from: Date; to: Date }>, fingerprints: readonly string[]
): Promise<ReadonlyMap<string, TelemetryIncidentReach>> {
  const read = readLimiter(PARALLEL_READS);
  const maps = await Promise.all(chunks(fingerprints, IDS_PER_READ).map((part) =>
    read(() => store.countIncidentReachByFingerprint({ ...window, fingerprints: part }))));
  return new Map(maps.flatMap((map) => [...map.entries()]));
}

function sortIncidents<T extends Pick<AdminHealthIncident, "occurredAt" | "id">>(items: T[]): T[] {
  return items.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0));
}

function failedRunSection(load: FailedRunLoad): HealthFullReport["failedRuns"] {
  return {
    runs: load.runs,
    users: load.users,
    rows: load.groups.map((group) => ({
      failureCode: group.code,
      runs: group.runs,
      users: group.users,
      firstAt: group.firstAt.toISOString(),
      lastAt: group.lastAt.toISOString(),
      newest: group.newest.flatMap((run) => {
        const runId = runIdOf(run.runId);
        return runId === null ? [] : [{
          runId, runReference: runReferenceLabel(runId), userId: run.userId, startedAt: run.startedAt.toISOString()
        }];
      })
    })),
    truncated: load.groupsTruncated
  };
}

// --- Collection

/** Every problem of the range, complete and structured, for an agent on the host. */
export async function collectHealthFullReport(sources: HealthAgentReportSources, range: AdminHealthRange): Promise<HealthFullReport> {
  const generatedAt = (sources.now ?? (() => new Date()))();
  const window = adminHealthWindow(range, generatedAt);
  const span = { from: window.from, to: window.to };
  const base = { ...span, limit: READ_LIMIT };
  const { store } = sources;
  // One cheap read first: an unreachable database fails once instead of once per section.
  const any = await store.readCounters({ ...span, limit: 1 });
  const read = readLimiter(PARALLEL_READS);
  const counters = (query: TelemetryCounterQuery) => read(() => store.readCounters(query));
  const [
    runRows, previousRows, latencyRows, failureCounters, nested, transport, toolTimeouts, runDeadlines, errorRows, errorFirstSeen,
    signInRows, toolRows, httpRows, clientRows, operationRows, telemetryRows, queues, problemReports, newest, firsts, keyRows,
    failedRunLoad
  ] = await Promise.all([
    counters({ ...span, ...RUN_TOTAL_QUERY }),
    window.previous ? counters({ ...window.previous, ...RUN_TOTAL_QUERY }) : Promise.resolve(null),
    counters({ ...base, events: ["run_execution"], dimensions: { outcome: "completed" },
      groupBy: ["stage", "after", "providerFamily", "connectionId", "providerModelId"] }),
    counters({ ...base, levels: ["warn", "error", "fatal"], groupBy: ["event", "level", "code", "subsystem", "stage", "reason",
      "routePath", "status", "httpStatus", "providerFamily", "tool_kind", "overflow", "appVersion"] }),
    counters({ ...base, events: ["nested_abort"], levels: ["warn"], groupBy: ["layer", "abort_source", "operation", "stage", "providerFamily"] }),
    counters({ ...base, events: ["transport_stage"], dimensions: { category: "timeout" },
      groupBy: ["transport", "stage", "operation", "providerFamily", "code"] }),
    counters({ ...base, events: ["tool_call"], dimensions: { outcome: "timeout" }, groupBy: ["tool_kind", "code"] }),
    counters({ ...base, events: ["run_execution"], dimensions: { reason: "deadline" }, groupBy: ["stage", "abort_source", "code", "providerFamily"] }),
    counters({ ...base, levels: ["error", "fatal"], groupBy: ["error_fingerprint", "error_class", "error_site", "event", "role", "code"] }),
    counters({ ...adminHealthRetentionWindow(generatedAt), limit: READ_LIMIT, levels: ["error", "fatal"], groupBy: ["error_fingerprint"] }),
    counters({ ...base, events: ["sign_in"], groupBy: ["sign_in_method", "step", "outcome", "code"] }),
    counters({ ...base, events: ["tool_call"], groupBy: ["tool_kind", "outcome", "code"] }),
    counters({ ...base, events: ["http.request_completed", "http.request_failed"], levels: ["warn", "error", "fatal"],
      groupBy: ["event", "level", "routePath", "method", "status", "outcome", "stage"] }),
    counters({ ...base, events: ["client.error"], groupBy: ["kind", "routePath"] }),
    counters({ ...base, events: ["process.started", "logging.dropped_records", "readiness.changed"], groupBy: ["event", "role", "state", "code"] }),
    counters({ ...base, events: ["runtime_lifecycle"], dimensions: { subsystem: "telemetry" }, levels: ["warn", "error", "fatal"],
      groupBy: ["level", "stage", "code", "outcome", "action"] }),
    read(() => sources.queues.read()),
    read(() => readProblemReports(sources, span)),
    read(() => readNewestIncidents(store, span, HEALTH_NEWEST_INCIDENT_LIMIT)),
    read(() => store.readFirstIncidentPerKey({ ...span, limit: HEALTH_INCIDENT_KEY_LIMIT })),
    read(() => store.countIncidentReachByKey({ ...span, limit: HEALTH_INCIDENT_KEY_LIMIT })),
    read(() => sources.failedRunGroups({ ...span, perCode: HEALTH_FULL_FAILED_RUNS_PER_CODE, groupLimit: HEALTH_FULL_FAILED_RUN_CODE_LIMIT }))
  ]);

  const errorFold = foldAdminHealthErrorGroups(errorRows, errorFirstSeen, generatedAt, HEALTH_FULL_ERROR_GROUP_LIMIT);
  const runCompletions = latencyRows.filter((row) => RUN_EXECUTION_STAGES.has(text(row.group.stage) ?? ""));
  const firstOutputs = latencyRows.filter((row) => row.group.stage === "first_output");
  const incidentItems = new Map<string, TelemetryIncident>();
  for (const item of [...newest.items, ...firsts.items]) incidentItems.set(item.id, item);
  const [reach, names] = await Promise.all([
    reachByFingerprint(store, span, errorFold.groups.map((group) => group.fingerprint)),
    sources.providerNames({
      connectionIds: adminHealthBoundedIds([
        ...latencyRows.map((row) => text(row.group.connectionId)),
        ...[...incidentItems.values()].map((item) => item.connectionId),
        ...keyRows.map((row) => row.key.connectionId)
      ]),
      modelIds: adminHealthBoundedIds([
        ...latencyRows.map((row) => text(row.group.providerModelId)),
        ...[...incidentItems.values()].map(adminHealthIncidentModelId)
      ])
    })
  ]);

  const firstIds = new Set(firsts.items.map((item) => item.id));
  const failures = failureRows(failureCounters);
  const timeouts = timeoutRows({ nested, transport, tools: toolTimeouts, runs: runDeadlines });
  const signIns = groupRows(signInRows, (row) => JSON.stringify([row.group.sign_in_method, row.group.step, row.group.outcome, row.group.code]))
    .map((group): HealthSignInRow => ({
      method: text(group[0]!.group.sign_in_method), step: text(group[0]!.group.step), outcome: text(group[0]!.group.outcome),
      code: text(group[0]!.group.code), ...seen(group)
    })).sort(byCount);
  const toolCallRows = toolRows.map((row): HealthToolCallRow => ({
    toolKind: text(row.group.tool_kind), outcome: text(row.group.outcome), code: text(row.group.code), ...seen([row])
  })).sort(byCount);
  const http = httpRows.map((row): HealthHttpRow => ({
    event: text(row.group.event) ?? "unknown", level: text(row.group.level) ?? "unknown", routePath: text(row.group.routePath),
    method: text(row.group.method), status: integer(row.group.status), outcome: text(row.group.outcome), stage: text(row.group.stage),
    ...seen([row])
  })).sort(byCount);
  const clientErrors = clientRows.map((row): HealthClientErrorRow => ({
    kind: text(row.group.kind), routePath: text(row.group.routePath), ...seen([row])
  })).sort(byCount);
  const starts = new Map<string, number>();
  for (const row of operationRows.filter((item) => item.group.event === "process.started")) {
    const role = text(row.group.role);
    if (role !== null) starts.set(role, (starts.get(role) ?? 0) + row.count);
  }
  const dropped = operationRows.filter((row) => row.group.event === "logging.dropped_records");
  const readiness = groupRows(operationRows.filter((row) => row.group.event === "readiness.changed"),
    (row) => JSON.stringify([row.group.state, row.group.code]))
    .map((group): HealthReadinessRow => ({ state: text(group[0]!.group.state), code: text(group[0]!.group.code), ...seen(group) }))
    .sort(byCount);
  const telemetry = telemetryRows.map((row): HealthOperationRow => ({
    level: text(row.group.level) ?? "unknown", stage: text(row.group.stage), code: text(row.group.code),
    outcome: text(row.group.outcome), action: text(row.group.action), ...seen([row])
  })).sort(byCount);
  const latencyFull = latencyRows.length >= READ_LIMIT;
  const keys = keyRows.map((row): HealthIncidentKeyRow => ({
    event: row.key.event,
    code: row.key.code,
    subsystem: row.key.subsystem,
    connectionId: row.key.connectionId,
    connectionName: row.key.connectionId === null ? null : adminHealthConnectionLabel(row.key.connectionId, names).connectionName,
    fingerprint: row.key.fingerprint,
    incidents: row.incidents,
    usersAtLeast: row.users,
    runsAtLeast: row.runs,
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString()
  }));

  return {
    privacy: HEALTH_AGENT_PRIVACY,
    kind: "full",
    version: HEALTH_REPORT_VERSION,
    range,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    generatedAt: generatedAt.toISOString(),
    hasTelemetry: any.length > 0,
    previousPeriod: window.previous ? { from: window.previous.from.toISOString(), to: window.previous.to.toISOString() } : null,
    runs: { ...runTotals(runRows), previous: previousRows === null ? null : runTotals(previousRows) },
    failedRuns: failedRunSection(failedRunLoad),
    latency: {
      runDuration: { ...stats(runCompletions), byProvider: latencyProviders(runCompletions, names) },
      firstOutput: {
        ...stats(firstOutputs),
        byAfter: groupRows(firstOutputs, (row) => JSON.stringify(row.group.after ?? null))
          .map((group) => ({ after: text(group[0]!.group.after), ...stats(group) }))
          .sort((left, right) => (left.after ?? "~").localeCompare(right.after ?? "~")),
        byProvider: latencyProviders(firstOutputs, names)
      },
      truncated: latencyFull
    },
    failures: bounded(failures, HEALTH_FULL_FAILURE_LIMIT, failureCounters.length >= READ_LIMIT),
    timeouts: bounded(timeouts, HEALTH_FULL_ROW_LIMIT,
      [nested, transport, toolTimeouts, runDeadlines].some((rows) => rows.length >= READ_LIMIT)),
    errorGroups: {
      rows: adminHealthErrorGroupsWithReach(errorFold.groups, reach).map((group) => ({
        ...group, newInRange: group.firstSeenAt >= window.from.toISOString()
      })),
      truncated: errorFold.truncated || errorRows.length >= READ_LIMIT
    },
    signIns: bounded(signIns, HEALTH_FULL_ROW_LIMIT, signInRows.length >= READ_LIMIT),
    toolCalls: {
      ...bounded(toolCallRows, HEALTH_FULL_ROW_LIMIT, toolRows.length >= READ_LIMIT),
      families: toolFamilies(toolRows)
    },
    http: {
      rows: http.slice(0, HEALTH_FULL_ROW_LIMIT),
      clientErrors: clientErrors.slice(0, HEALTH_FULL_ROW_LIMIT),
      truncated: http.length > HEALTH_FULL_ROW_LIMIT || clientErrors.length > HEALTH_FULL_ROW_LIMIT ||
        httpRows.length >= READ_LIMIT || clientRows.length >= READ_LIMIT
    },
    problemReports,
    incidents: {
      rows: sortIncidents([...incidentItems.values()].map((item) => ({ ...agentIncident(item, names), firstOfKey: firstIds.has(item.id) }))),
      newestLimit: HEALTH_NEWEST_INCIDENT_LIMIT,
      newestTruncated: newest.truncated,
      firstOfKeyTruncated: firsts.truncated,
      keys,
      keysTruncated: keyRows.length >= HEALTH_INCIDENT_KEY_LIMIT
    },
    operations: {
      roleStarts: [...starts.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([role, value]) => ({ role, starts: value, restarts: Math.max(0, value - 1) })),
      queues: queues.queues,
      queuesCheckedAt: queues.checkedAt,
      droppedLogRecords: {
        records: dropped.reduce((total, row) => total + row.valueSum, 0),
        reports: dropped.reduce((total, row) => total + row.count, 0)
      },
      telemetry: telemetry.slice(0, HEALTH_FULL_ROW_LIMIT),
      readiness: readiness.slice(0, HEALTH_FULL_ROW_LIMIT),
      truncated: operationRows.length >= READ_LIMIT || telemetryRows.length >= READ_LIMIT ||
        telemetry.length > HEALTH_FULL_ROW_LIMIT || readiness.length > HEALTH_FULL_ROW_LIMIT
    }
  };
}

/** One user's incidents, failed and cancelled runs and problem reports over the range. */
export async function collectHealthUserReport(
  sources: HealthAgentReportSources,
  userId: string,
  range: AdminHealthRange
): Promise<HealthUserReport> {
  const generatedAt = (sources.now ?? (() => new Date()))();
  const window = adminHealthWindow(range, generatedAt);
  const span = { from: window.from, to: window.to };
  // The account first: an unreachable database fails once.
  const userExists = await sources.userExists(userId);
  const [incidents, runRows, problemReports] = await Promise.all([
    readNewestIncidents(sources.store, { ...span, userId }, HEALTH_NEWEST_INCIDENT_LIMIT),
    sources.failedRuns({ ...span, userId, limit: HEALTH_USER_RUN_LIMIT + 1 }),
    readProblemReports(sources, { ...span, userId })
  ]);
  const selected = runRows.slice(0, HEALTH_USER_RUN_LIMIT).filter((row) => runIdOf(row.id) !== null);
  const read = readLimiter(PARALLEL_READS);
  const [counts, names] = await Promise.all([
    Promise.all(chunks(selected.map((row) => row.id), IDS_PER_READ).map((ids) => read(() => sources.store.countIncidentsByRun(ids)))),
    sources.providerNames({
      connectionIds: adminHealthBoundedIds(incidents.items.map((item) => item.connectionId)),
      modelIds: adminHealthBoundedIds(incidents.items.map(adminHealthIncidentModelId))
    })
  ]);
  const incidentCounts = new Map(counts.flatMap((map) => [...map.entries()]));
  return {
    privacy: HEALTH_AGENT_PRIVACY,
    kind: "user",
    version: HEALTH_REPORT_VERSION,
    userId,
    userExists,
    range,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    generatedAt: generatedAt.toISOString(),
    incidents: { rows: incidents.items.map((item) => agentIncident(item, names)), truncated: incidents.truncated },
    failedRuns: {
      rows: selected.flatMap((row) => {
        const run = projectAdminHealthRun(row, incidentCounts.get(row.id) ?? 0);
        return run === null ? [] : [{ ...run, runReference: runReferenceLabel(run.runId) }];
      }),
      truncated: runRows.length > HEALTH_USER_RUN_LIMIT
    },
    problemReports
  };
}
