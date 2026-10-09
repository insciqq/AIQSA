import type { ErrorResponse } from "./http";

/**
 * Control Center Health: an administrator-only, content-free projection of the
 * installation's own telemetry (hourly counters and recent error incidents).
 * It carries counts, stable codes, enumerations and provider display names,
 * never user content, raw errors, secrets or internal job/tool identities.
 */
export const adminHealthRanges = ["24h", "7d", "14d", "30d"] as const;
export type AdminHealthRange = (typeof adminHealthRanges)[number];
export const defaultAdminHealthRange: AdminHealthRange = "24h";

/** Stack order of the error chart; "other" is always last. */
export const adminHealthCategories = ["providers", "requests", "runs", "background", "tools", "other"] as const;
export type AdminHealthCategory = (typeof adminHealthCategories)[number];
/** Categories an incident filter can select; "other" has no closed event list. */
export const adminHealthIncidentCategories = ["providers", "requests", "runs", "background", "tools"] as const;
export type AdminHealthIncidentCategory = (typeof adminHealthIncidentCategories)[number];

export const adminHealthFailureClasses = ["key_rejected", "quota", "provider_error", "timeout", "network", "other"] as const;
export type AdminHealthFailureClass = (typeof adminHealthFailureClasses)[number];

export type AdminHealthRoleStarts = {
  role: string;
  starts: number;
  /** Starts beyond the first one in the range. */
  restarts: number;
};

export type AdminHealthSummary = {
  /** Error and fatal records in the range. */
  errors: number;
  /** The same count for the preceding period of equal length; `null` when that period is older than counter retention. */
  previousErrors: number | null;
  /** Finished provider operations (completed or failed; cancellations excluded). */
  providerOperations: number;
  providerFailures: number;
  /** Failures / operations in [0, 1]; `null` without operations. */
  providerFailureRate: number | null;
  /** Server errors: completed requests with status >= 500 plus requests that failed before a response. */
  http5xx: number;
  restarts: number;
  roleStarts: AdminHealthRoleStarts[];
  /** Log records the structured writer had to drop. */
  droppedLogRecords: number;
  /** Browser crashes reported by signed-in pages. */
  clientErrors: number;
};

export type AdminHealthSeriesBucket = {
  /** Bucket start (UTC); hourly for 24h, daily (UTC midnight) otherwise. */
  start: string;
  counts: Record<AdminHealthCategory, number>;
  total: number;
};

export type AdminHealthConnectionState = "known" | "deleted" | "unattributed";

export type AdminHealthProviderRow = {
  key: string;
  connectionId: string | null;
  connectionName: string;
  connectionState: AdminHealthConnectionState;
  providerModelId: string | null;
  /** `null` when the operation named no model. */
  modelName: string | null;
  /** Provider stage (answer, embedding, image, ...) or "vision" for image analysis attempts. */
  stage: string | null;
  operations: number;
  failures: number;
  /** Failures / operations in [0, 1]; `null` without operations. */
  failureRate: number | null;
  failuresByClass: Record<AdminHealthFailureClass, number>;
  /** 95th percentile duration estimated from the fixed histogram (bucket upper bound, capped by the maximum). */
  p95Ms: number | null;
  lastFailureAt: string | null;
};

/**
 * One failure grouped by its fingerprint: the error class and the first
 * application code site of failed records, never a message or stack.
 */
export type AdminHealthErrorGroup = {
  fingerprint: string;
  errorClass: string;
  /** Application-relative `path:line` of the latest occurrence; `null` when no frame was in application code. */
  site: string | null;
  /** Error and fatal records in the range. */
  count: number;
  /** Events, process roles and codes the failure appeared under (bounded). */
  events: string[];
  roles: string[];
  codes: string[];
  lastSeenAt: string;
  /** First occurrence within counter retention. */
  firstSeenAt: string;
  /** First seen within the last day. */
  isNew: boolean;
  /**
   * Distinct signed-in users and runs among the failure's retained incidents in
   * the range. Incidents are a sample (per-minute admission, daily trim), so
   * these are lower bounds; 0 when no retained incident names one. Never ids.
   */
  usersAtLeast: number;
  runsAtLeast: number;
};

export type AdminHealth = {
  range: AdminHealthRange;
  interval: "hour" | "day";
  from: string;
  to: string;
  generatedAt: string;
  /** False when no telemetry at all was recorded in the range (a fresh installation). */
  hasTelemetry: boolean;
  summary: AdminHealthSummary;
  series: AdminHealthSeriesBucket[];
  providers: AdminHealthProviderRow[];
  /** True when the provider grouping hit its row bound and some rows may be missing. */
  providersTruncated: boolean;
  /** New failures first, then the most frequent. */
  errorGroups: AdminHealthErrorGroup[];
  errorGroupsTruncated: boolean;
};

export type AdminHealthResponse = { health: AdminHealth };

export type AdminHealthIncidentDetail = { key: string; value: string | number | boolean };

export type AdminHealthIncident = {
  id: string;
  occurredAt: string;
  role: string;
  event: string;
  level: "error" | "fatal";
  code: string | null;
  subsystem: string | null;
  stage: string | null;
  connectionId: string | null;
  connectionName: string | null;
  modelName: string | null;
  httpStatus: number | null;
  runId: string | null;
  traceId: string | null;
  /** Remaining allowlisted, content-free record fields. */
  details: AdminHealthIncidentDetail[];
};

export type AdminHealthIncidentsResponse = {
  incidents: AdminHealthIncident[];
  nextCursor: string | null;
};

export type AdminHealthErrorCode = "admin_health_failed" | "admin_health_query_invalid" | "forbidden" | "unauthorized";
export type AdminHealthErrorResponse = ErrorResponse<AdminHealthErrorCode>;

export type AdminHealthIncidentFilters = {
  category: AdminHealthIncidentCategory | null;
  code: string | null;
  cursor: string | null;
  event: string | null;
  level: "error" | "fatal" | null;
  /** A run id, a trace id, or an error reference (a run-id prefix of at least eight characters). */
  q: string | null;
  range: AdminHealthRange;
};

const BACKGROUND_EVENTS = new Set(["job_attempt", "job_persistence", "run_recovery", "runtime_lifecycle", "service_operation"]);
const REQUEST_EVENTS = new Set(["http.request_completed", "http.request_failed"]);

/** Every error-level event belongs to exactly one chart category. */
export function adminHealthEventCategory(event: string): AdminHealthCategory {
  if (BACKGROUND_EVENTS.has(event)) return "background";
  if (REQUEST_EVENTS.has(event)) return "requests";
  if (event.startsWith("provider_")) return "providers";
  if (event.startsWith("run_")) return "runs";
  if (event === "tool_execution" || event === "tool_call") return "tools";
  return "other";
}

/** The closed event lists an incident category filter selects. */
export const ADMIN_HEALTH_CATEGORY_EVENTS: Readonly<Record<AdminHealthIncidentCategory, readonly string[]>> = {
  providers: ["provider_operation", "provider_stream_safety_terminated"],
  requests: [...REQUEST_EVENTS],
  runs: ["run_execution", "run_persistence", "run_http_failed", "run_preparation", "run_stop_admission"],
  background: [...BACKGROUND_EVENTS],
  tools: ["tool_execution", "tool_call"]
};

export const ADMIN_HEALTH_INCIDENT_EVENT_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/u;
export const ADMIN_HEALTH_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
export const ADMIN_HEALTH_TRACE_PATTERN = /^[0-9a-f]{32}$/u;
export const ADMIN_HEALTH_RUN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

export function isAdminHealthRange(value: unknown): value is AdminHealthRange {
  return typeof value === "string" && (adminHealthRanges as readonly string[]).includes(value);
}

/** Whether a search box value can be looked up: a run id or error reference, or a trace id. */
export function isAdminHealthReference(value: string): boolean {
  return ADMIN_HEALTH_TRACE_PATTERN.test(value) || ADMIN_HEALTH_RUN_PATTERN.test(value);
}

function single(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  if (values.length > 1) return undefined;
  const value = values[0]?.trim();
  return value ? value : null;
}

/** Strict query parsing shared by the route and its client: an unknown or repeated value is invalid, never ignored. */
export function parseAdminHealthIncidentFilters(params: URLSearchParams): AdminHealthIncidentFilters | null {
  const range = single(params, "range");
  const category = single(params, "category");
  const code = single(params, "code");
  const cursor = single(params, "cursor");
  const event = single(params, "event");
  const level = single(params, "level");
  const q = single(params, "q");
  if ([range, category, code, cursor, event, level, q].includes(undefined)) return null;
  if (range !== null && !isAdminHealthRange(range)) return null;
  if (category != null && !(adminHealthIncidentCategories as readonly string[]).includes(category)) return null;
  if (code != null && !ADMIN_HEALTH_CODE_PATTERN.test(code)) return null;
  if (cursor != null && !CURSOR_PATTERN.test(cursor)) return null;
  if (event != null && !ADMIN_HEALTH_INCIDENT_EVENT_PATTERN.test(event)) return null;
  if (level != null && level !== "error" && level !== "fatal") return null;
  if (q != null && !isAdminHealthReference(q)) return null;
  return {
    category: (category ?? null) as AdminHealthIncidentCategory | null,
    code: code ?? null,
    cursor: cursor ?? null,
    event: event ?? null,
    level: (level ?? null) as "error" | "fatal" | null,
    q: q ?? null,
    range: (range ?? defaultAdminHealthRange) as AdminHealthRange
  };
}

export function adminHealthIncidentSearch(filters: AdminHealthIncidentFilters): string {
  const params = new URLSearchParams({ range: filters.range });
  for (const key of ["category", "event", "code", "level", "q", "cursor"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params.toString();
}

// --- Browser decoding: a malformed response fails visibly instead of becoming guessed state.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function ratio(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableText(value: unknown, maxLength: number): value is string | null {
  return value === null || text(value, maxLength);
}

function time(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function countsOf<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(value)) return null;
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const item = value[key];
    if (!count(item)) return null;
    result[key] = item;
  }
  return result;
}

function decodeSummary(value: unknown): AdminHealthSummary | null {
  if (!isRecord(value) || !count(value.errors) || !(value.previousErrors === null || count(value.previousErrors)) ||
    !count(value.providerOperations) || !count(value.providerFailures) || !ratio(value.providerFailureRate) ||
    !count(value.http5xx) || !count(value.restarts) || !count(value.droppedLogRecords) || !count(value.clientErrors) ||
    !Array.isArray(value.roleStarts) || value.roleStarts.length > 32) return null;
  const roleStarts: AdminHealthRoleStarts[] = [];
  for (const item of value.roleStarts) {
    if (!isRecord(item) || !text(item.role, 32) || !count(item.starts) || !count(item.restarts)) return null;
    roleStarts.push({ role: item.role, starts: item.starts, restarts: item.restarts });
  }
  return {
    errors: value.errors, previousErrors: value.previousErrors, providerOperations: value.providerOperations,
    providerFailures: value.providerFailures, providerFailureRate: value.providerFailureRate, http5xx: value.http5xx,
    restarts: value.restarts, roleStarts, droppedLogRecords: value.droppedLogRecords, clientErrors: value.clientErrors
  };
}

function decodeBucket(value: unknown): AdminHealthSeriesBucket | null {
  if (!isRecord(value) || !time(value.start) || !count(value.total)) return null;
  const counts = countsOf(value.counts, adminHealthCategories);
  return counts ? { start: value.start, counts, total: value.total } : null;
}

function decodeProvider(value: unknown): AdminHealthProviderRow | null {
  if (!isRecord(value) || !text(value.key, 400) || !nullableText(value.connectionId, 128) || !text(value.connectionName, 200) ||
    !(value.connectionState === "known" || value.connectionState === "deleted" || value.connectionState === "unattributed") ||
    !nullableText(value.providerModelId, 128) || !nullableText(value.modelName, 300) || !nullableText(value.stage, 64) ||
    !count(value.operations) || !count(value.failures) || !ratio(value.failureRate) ||
    !(value.p95Ms === null || count(value.p95Ms)) || !(value.lastFailureAt === null || time(value.lastFailureAt))) return null;
  const failuresByClass = countsOf(value.failuresByClass, adminHealthFailureClasses);
  if (!failuresByClass) return null;
  return {
    key: value.key, connectionId: value.connectionId, connectionName: value.connectionName,
    connectionState: value.connectionState, providerModelId: value.providerModelId, modelName: value.modelName,
    stage: value.stage, operations: value.operations, failures: value.failures, failureRate: value.failureRate,
    failuresByClass, p95Ms: value.p95Ms, lastFailureAt: value.lastFailureAt
  };
}

export const ADMIN_HEALTH_ERROR_GROUP_LIMIT = 50;
const FINGERPRINT_PATTERN = /^[0-9a-f]{12}$/u;

function textList(value: unknown, max: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => text(item, maxLength));
}

function decodeErrorGroup(value: unknown): AdminHealthErrorGroup | null {
  if (!isRecord(value) || typeof value.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(value.fingerprint) ||
    !text(value.errorClass, 64) || !nullableText(value.site, 160) || !count(value.count) ||
    !textList(value.events, 8, 64) || !textList(value.roles, 8, 32) || !textList(value.codes, 8, 128) ||
    !time(value.lastSeenAt) || !time(value.firstSeenAt) || typeof value.isNew !== "boolean" ||
    !count(value.usersAtLeast) || !count(value.runsAtLeast)) return null;
  return {
    fingerprint: value.fingerprint, errorClass: value.errorClass, site: value.site, count: value.count,
    events: value.events, roles: value.roles, codes: value.codes, lastSeenAt: value.lastSeenAt,
    firstSeenAt: value.firstSeenAt, isNew: value.isNew, usersAtLeast: value.usersAtLeast, runsAtLeast: value.runsAtLeast
  };
}

function decodeList<T>(value: unknown, max: number, decode: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const items = value.map(decode);
  return items.every((item) => item !== null) ? items as T[] : null;
}

export function decodeAdminHealthResponse(value: unknown): AdminHealthResponse | null {
  if (!isRecord(value) || !isRecord(value.health)) return null;
  const health = value.health;
  if (!isAdminHealthRange(health.range) || !(health.interval === "hour" || health.interval === "day") ||
    !time(health.from) || !time(health.to) || !time(health.generatedAt) || typeof health.hasTelemetry !== "boolean" ||
    typeof health.providersTruncated !== "boolean" || typeof health.errorGroupsTruncated !== "boolean") return null;
  const summary = decodeSummary(health.summary);
  const series = decodeList(health.series, 64, decodeBucket);
  const providers = decodeList(health.providers, 2_000, decodeProvider);
  const errorGroups = decodeList(health.errorGroups, ADMIN_HEALTH_ERROR_GROUP_LIMIT, decodeErrorGroup);
  if (!summary || !series || !providers || !errorGroups) return null;
  return {
    health: {
      range: health.range, interval: health.interval, from: health.from, to: health.to,
      generatedAt: health.generatedAt, hasTelemetry: health.hasTelemetry, summary, series, providers,
      providersTruncated: health.providersTruncated, errorGroups, errorGroupsTruncated: health.errorGroupsTruncated
    }
  };
}

function decodeIncident(value: unknown): AdminHealthIncident | null {
  if (!isRecord(value) || !text(value.id, 64) || !time(value.occurredAt) || !text(value.role, 32) ||
    !text(value.event, 64) || !(value.level === "error" || value.level === "fatal") ||
    !nullableText(value.code, 128) || !nullableText(value.subsystem, 64) || !nullableText(value.stage, 64) ||
    !nullableText(value.connectionId, 128) || !nullableText(value.connectionName, 200) || !nullableText(value.modelName, 300) ||
    !(value.httpStatus === null || count(value.httpStatus)) || !nullableText(value.runId, 128) ||
    !nullableText(value.traceId, 32) || !Array.isArray(value.details) || value.details.length > 64) return null;
  const details: AdminHealthIncidentDetail[] = [];
  for (const item of value.details) {
    if (!isRecord(item) || !text(item.key, 64) ||
      !(typeof item.value === "boolean" || typeof item.value === "number" && Number.isFinite(item.value) || text(item.value, 512))) return null;
    details.push({ key: item.key, value: item.value });
  }
  return {
    id: value.id, occurredAt: value.occurredAt, role: value.role, event: value.event, level: value.level,
    code: value.code, subsystem: value.subsystem, stage: value.stage, connectionId: value.connectionId,
    connectionName: value.connectionName, modelName: value.modelName, httpStatus: value.httpStatus,
    runId: value.runId, traceId: value.traceId, details
  };
}

export function decodeAdminHealthIncidentsResponse(value: unknown): AdminHealthIncidentsResponse | null {
  if (!isRecord(value) || !(value.nextCursor === null || typeof value.nextCursor === "string" && CURSOR_PATTERN.test(value.nextCursor))) {
    return null;
  }
  const incidents = decodeList(value.incidents, 200, decodeIncident);
  return incidents ? { incidents, nextCursor: value.nextCursor } : null;
}
