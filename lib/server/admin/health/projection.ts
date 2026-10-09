import type { AdminHealthErrorGroup, AdminHealthFailureClass, AdminHealthRange } from "../../../contracts/adminHealth";
import { TELEMETRY_DURATION_BOUNDS_MS } from "../../telemetry/aggregator";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Counter retention (Persistence): an older previous period cannot be compared. */
const COUNTER_RETENTION_MS = 30 * DAY_MS;
const RANGE_DAYS: Readonly<Record<AdminHealthRange, number>> = { "24h": 1, "7d": 7, "14d": 14, "30d": 30 };

export type AdminHealthWindow = Readonly<{
  range: AdminHealthRange;
  interval: "hour" | "day";
  from: Date;
  to: Date;
  buckets: readonly Date[];
  previous: Readonly<{ from: Date; to: Date }> | null;
}>;

/**
 * Whole UTC buckets ending with the current one: 24 hours, or 7/14/30 days. The
 * previous period is the same length right before; it is omitted once it
 * reaches past counter retention.
 */
export function adminHealthWindow(range: AdminHealthRange, now: Date): AdminHealthWindow {
  const interval = range === "24h" ? "hour" : "day";
  const step = interval === "hour" ? HOUR_MS : DAY_MS;
  const size = range === "24h" ? 24 : RANGE_DAYS[range];
  const end = Math.floor(now.getTime() / step) * step + step;
  const start = end - size * step;
  const previousStart = start - size * step;
  return {
    range,
    interval,
    from: new Date(start),
    to: new Date(end),
    buckets: Array.from({ length: size }, (_, index) => new Date(start + index * step)),
    previous: now.getTime() - previousStart > COUNTER_RETENTION_MS ? null
      : { from: new Date(previousStart), to: new Date(start) }
  };
}

/** Incidents look back exactly the range length from now. */
export function adminHealthIncidentFrom(range: AdminHealthRange, now: Date): Date {
  return new Date(now.getTime() - RANGE_DAYS[range] * DAY_MS);
}

/**
 * A provider failure's class from its stable code, HTTP status and reason:
 * rejected key (401/403), quota or rate limit (402/429), provider-side error
 * (5xx), timeout, network/transport, otherwise other.
 */
export function adminHealthFailureClass(
  code: string | null,
  httpStatus: number | null,
  reason: string | null
): AdminHealthFailureClass {
  if (code === "provider_auth_rejected" || httpStatus === 401 || httpStatus === 403) return "key_rejected";
  if (code === "provider_quota_exhausted" || code === "provider_rate_limited" || httpStatus === 402 || httpStatus === 429) {
    return "quota";
  }
  if (code === "provider_server_error" || httpStatus !== null && httpStatus >= 500 && httpStatus <= 599) return "provider_error";
  if (reason === "deadline" || code !== null && (code === "timeout" || /_(?:timed_out|timeout)$/u.test(code))) return "timeout";
  if (reason === "network") return "network";
  return "other";
}

/**
 * A quantile (0 < q <= 1) from the fixed duration histogram: the upper bound
 * of the bucket holding it, capped by the observed maximum (the open last
 * bucket reports the maximum itself).
 */
export function adminHealthQuantile(buckets: readonly number[], maxMs: number | null, quantile: number): number | null {
  const total = buckets.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const target = Math.ceil(total * quantile);
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    seen += buckets[index] ?? 0;
    if (seen < target) continue;
    const bound = TELEMETRY_DURATION_BOUNDS_MS[index];
    if (bound === undefined) return maxMs === null ? null : Math.round(maxMs);
    return Math.round(maxMs === null ? bound : Math.min(bound, maxMs));
  }
  return maxMs === null ? null : Math.round(maxMs);
}

/** The 95th percentile from the fixed duration histogram (`adminHealthQuantile`). */
export function adminHealthP95(buckets: readonly number[], maxMs: number | null): number | null {
  return adminHealthQuantile(buckets, maxMs, 0.95);
}

/**
 * Incident fields an administrator may see beside the dedicated columns:
 * bounded enumerations, stable codes and measurements. Internal job, tool
 * call, generation and scope identities stay out.
 */
export const ADMIN_HEALTH_INCIDENT_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "abort_source", "action", "adapterKind", "attempt", "category", "cause", "claimed_count", "completed_count",
  "configured_timeout_ms", "count", "db_failure", "deadline_kind", "delay_ms", "duration_ms", "durationMs", "effective_timeout_ms",
  "engine_index", "error_category", "error_class", "error_fingerprint", "error_site", "failed_count", "headers_ms", "issue_count", "kind", "layer", "limit", "method",
  "mode", "node_version", "observed", "operation", "operation_index", "operation_stage", "outcome", "pending_count",
  "prisma_code", "providerFamily", "provider_code", "provider_status", "reason", "repeat_count", "retry_at",
  "routePath", "route_source", "sign_in_method", "state", "status", "step", "stream", "stream_drop", "termination", "timeout_ms",
  "tool_kind",
  "totalStreamBytes", "transport", "unit", "work_stage"
]);

/** A failure first seen within this period is new (Health marks it, Needs attention may raise it). */
export const ADMIN_HEALTH_NEW_ERROR_MS = DAY_MS;

/** The retention window every first occurrence is searched in. */
export function adminHealthRetentionWindow(now: Date): Readonly<{ from: Date; to: Date }> {
  const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  return { from: new Date(end - COUNTER_RETENTION_MS), to: new Date(end) };
}

type ErrorGroupRow = Readonly<{
  group: Readonly<Record<string, unknown>>;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}>;

type ErrorGroupFold = {
  fingerprint: string;
  classes: Map<string, number>;
  site: string | null;
  siteSeenAt: number;
  count: number;
  events: Set<string>;
  roles: Set<string>;
  codes: Set<string>;
  firstSeenAt: number;
  lastSeenAt: number;
};

const LIST_LIMIT = 8;

function groupText(row: ErrorGroupRow, key: string): string | null {
  const value = row.group[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function addBounded(set: Set<string>, value: string | null): void {
  if (value !== null && set.size < LIST_LIMIT) set.add(value);
}

/** A failure group from the counters, before its incidents' reach is read. */
export type AdminHealthErrorGroupFold = Omit<AdminHealthErrorGroup, "usersAtLeast" | "runsAtLeast">;

/**
 * Failures grouped by fingerprint from counter rows of the range (grouped by
 * fingerprint, class, site, event, role and code) and the first occurrence of
 * each fingerprint over retention. The site is the one most recently seen,
 * since a fingerprint deliberately survives line shifts between versions.
 */
export function foldAdminHealthErrorGroups(
  rows: readonly ErrorGroupRow[],
  firstSeen: readonly ErrorGroupRow[],
  now: Date,
  limit: number
): Readonly<{ groups: AdminHealthErrorGroupFold[]; truncated: boolean }> {
  const folds = new Map<string, ErrorGroupFold>();
  for (const row of rows) {
    const fingerprint = groupText(row, "error_fingerprint");
    if (fingerprint === null) continue;
    let fold = folds.get(fingerprint);
    if (!fold) {
      fold = { fingerprint, classes: new Map(), site: null, siteSeenAt: -1, count: 0, events: new Set(), roles: new Set(),
        codes: new Set(), firstSeenAt: row.firstSeenAt.getTime(), lastSeenAt: row.lastSeenAt.getTime() };
      folds.set(fingerprint, fold);
    }
    const errorClass = groupText(row, "error_class") ?? "Error";
    fold.classes.set(errorClass, (fold.classes.get(errorClass) ?? 0) + row.count);
    const site = groupText(row, "error_site");
    if (site !== null && row.lastSeenAt.getTime() > fold.siteSeenAt) {
      fold.site = site;
      fold.siteSeenAt = row.lastSeenAt.getTime();
    }
    fold.count += row.count;
    addBounded(fold.events, groupText(row, "event"));
    addBounded(fold.roles, groupText(row, "role"));
    addBounded(fold.codes, groupText(row, "code"));
    fold.firstSeenAt = Math.min(fold.firstSeenAt, row.firstSeenAt.getTime());
    fold.lastSeenAt = Math.max(fold.lastSeenAt, row.lastSeenAt.getTime());
  }
  for (const row of firstSeen) {
    const fold = folds.get(groupText(row, "error_fingerprint") ?? "");
    if (fold) fold.firstSeenAt = Math.min(fold.firstSeenAt, row.firstSeenAt.getTime());
  }
  const newSince = now.getTime() - ADMIN_HEALTH_NEW_ERROR_MS;
  const groups = [...folds.values()].map((fold): AdminHealthErrorGroupFold => ({
    fingerprint: fold.fingerprint,
    errorClass: [...fold.classes.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]![0],
    site: fold.site,
    count: fold.count,
    events: [...fold.events].sort(),
    roles: [...fold.roles].sort(),
    codes: [...fold.codes].sort(),
    lastSeenAt: new Date(fold.lastSeenAt).toISOString(),
    firstSeenAt: new Date(fold.firstSeenAt).toISOString(),
    isNew: fold.firstSeenAt >= newSince
  })).sort((left, right) => Number(right.isNew) - Number(left.isNew) || right.count - left.count ||
    right.lastSeenAt.localeCompare(left.lastSeenAt) || left.fingerprint.localeCompare(right.fingerprint));
  return { groups: groups.slice(0, limit), truncated: groups.length > limit };
}

/**
 * Each failure with how many distinct users and runs its retained incidents of
 * the range name (`countIncidentReachByFingerprint`): lower bounds, since
 * incidents are sampled; none when no retained incident names one.
 */
export function adminHealthErrorGroupsWithReach(
  groups: readonly AdminHealthErrorGroupFold[],
  reach: ReadonlyMap<string, Readonly<{ users: number; runs: number }>>
): AdminHealthErrorGroup[] {
  return groups.map((group) => ({
    ...group,
    usersAtLeast: reach.get(group.fingerprint)?.users ?? 0,
    runsAtLeast: reach.get(group.fingerprint)?.runs ?? 0
  }));
}
