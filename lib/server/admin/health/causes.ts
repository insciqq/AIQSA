import type { TelemetryCounterGroup } from "../../telemetry/store";

export const HEALTH_CAUSE_QUERY = {
  events: ["provider_operation", "run_execution", "job_attempt", "job_persistence", "tool_execution", "tool_call", "run_http_failed"],
  levels: ["warn", "error", "fatal"],
  groupBy: ["event", "code", "cause", "stage", "tool_kind", "provider_error_code", "db_constraint", "job_kind", "reason",
    "mcp_server", "tool_identity", "http_status_class", "fetch_reason", "httpStatus", "outcome", "tool_scope"],
  limit: 501
} as const;

export type HealthFailureCauses = Readonly<{
  rows: readonly Readonly<{ event: string; count: number; lastAt: string; facts: Readonly<Record<string, string | number>> }>[];
  truncated: boolean;
}>;

/** Counts describe the named boundary (provider attempts, jobs, runs or calls), never a sum across boundaries. */
export function healthFailureCauses(rows: readonly TelemetryCounterGroup[]): HealthFailureCauses {
  const selected = rows.filter(({ group }) => {
    if (group.event === "tool_execution") return group.tool_scope !== "model_call" &&
      (group.stage === "execution" || group.stage === "admission");
    return group.outcome === "failed" || group.outcome === "timeout" || group.outcome === "unconfirmed" || group.event === "run_http_failed";
  });
  return {
    rows: selected.slice(0, 200).map((row) => ({ event: String(row.group.event), count: row.count, lastAt: row.lastSeenAt.toISOString(),
      facts: Object.fromEntries(HEALTH_CAUSE_QUERY.groupBy.flatMap((key) => {
        const value = row.group[key];
        return key !== "event" && key !== "outcome" && (typeof value === "string" || typeof value === "number") ? [[key, value]] : [];
      })) })),
    truncated: rows.length >= HEALTH_CAUSE_QUERY.limit || selected.length > 200
  };
}
