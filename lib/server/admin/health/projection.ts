import type { AdminHealthFailureClass, AdminHealthRange } from "../../../contracts/adminHealth";
import { TELEMETRY_DURATION_BOUNDS_MS } from "../../telemetry/aggregator";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Counter retention (Persistence): an older previous period cannot be compared. */
const COUNTER_RETENTION_MS = 30 * DAY_MS;

export type AdminHealthWindow = Readonly<{
  range: AdminHealthRange;
  interval: "hour" | "day";
  from: Date;
  to: Date;
  buckets: readonly Date[];
  previous: Readonly<{ from: Date; to: Date }> | null;
}>;

/**
 * Whole UTC buckets ending with the current one: 24 hours, or 7/30 days. The
 * previous period is the same length right before; it is omitted once it
 * reaches past counter retention.
 */
export function adminHealthWindow(range: AdminHealthRange, now: Date): AdminHealthWindow {
  const interval = range === "24h" ? "hour" : "day";
  const step = interval === "hour" ? HOUR_MS : DAY_MS;
  const size = range === "24h" ? 24 : range === "7d" ? 7 : 30;
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
  const length = range === "24h" ? DAY_MS : range === "7d" ? 7 * DAY_MS : 30 * DAY_MS;
  return new Date(now.getTime() - length);
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
 * The 95th percentile from the fixed duration histogram: the upper bound of
 * the bucket holding it, capped by the observed maximum (the open last bucket
 * reports the maximum itself).
 */
export function adminHealthP95(buckets: readonly number[], maxMs: number | null): number | null {
  const total = buckets.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const target = Math.ceil(total * 0.95);
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

/**
 * Incident fields an administrator may see beside the dedicated columns:
 * bounded enumerations, stable codes and measurements. Internal job, tool
 * call, generation and scope identities stay out.
 */
export const ADMIN_HEALTH_INCIDENT_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "abort_source", "action", "adapterKind", "attempt", "category", "cause", "claimed_count", "completed_count",
  "configured_timeout_ms", "count", "deadline_kind", "delay_ms", "duration_ms", "durationMs", "effective_timeout_ms",
  "engine_index", "error_category", "failed_count", "headers_ms", "issue_count", "kind", "layer", "limit", "method",
  "mode", "node_version", "observed", "operation", "operation_index", "operation_stage", "outcome", "pending_count",
  "prisma_code", "providerFamily", "provider_code", "provider_status", "reason", "repeat_count", "retry_at",
  "routePath", "route_source", "state", "status", "stream", "termination", "timeout_ms", "tool_kind",
  "totalStreamBytes", "transport", "unit", "work_stage"
]);
