import type { TelemetryCounterGroup, TelemetryCounterQuery, TelemetryGroupValue } from "../../telemetry/store";

/**
 * Slow tracked database transactions (`db_transaction`) from the counters:
 * which transaction held its rows past the slow bound (warn) or past the
 * foreground budget (error), how often, the longest hold and when. The
 * holder of a contended row and the transactions that waited for it appear
 * side by side; incidents carry each error's own duration and lock wait.
 */

/** Rows a report lists; the counters' own read bound comes first. */
export const HEALTH_SLOW_TRANSACTION_LIMIT = 200;

export const HEALTH_SLOW_TRANSACTION_QUERY = {
  events: ["db_transaction"],
  levels: ["warn", "error", "fatal"],
  groupBy: ["level", "subsystem", "operation", "job_kind", "outcome"],
  limit: HEALTH_SLOW_TRANSACTION_LIMIT
} as const satisfies Omit<TelemetryCounterQuery, "from" | "to">;

export type HealthSlowTransactionRow = {
  /** `error`: held past the foreground budget; `warn`: past the slow bound. */
  level: string;
  subsystem: string | null;
  operation: string | null;
  /** The Memory job kind of a job commit. */
  jobKind: string | null;
  /** `committed` or `rolled_back`. */
  outcome: string | null;
  count: number;
  /** The longest hold, in milliseconds. */
  maxMs: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type HealthSlowTransactions = { rows: HealthSlowTransactionRow[]; truncated: boolean };

function text(value: TelemetryGroupValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Errors first, then the latest, then the most frequent. */
export function healthSlowTransactions(rows: readonly TelemetryCounterGroup[]): HealthSlowTransactions {
  const projected = rows.map((row): HealthSlowTransactionRow => ({
    level: text(row.group.level) ?? "unknown",
    subsystem: text(row.group.subsystem),
    operation: text(row.group.operation),
    jobKind: text(row.group.job_kind),
    outcome: text(row.group.outcome),
    count: row.count,
    maxMs: row.durationMaxMs === null ? null : Math.round(row.durationMaxMs),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString()
  })).sort((left, right) => Number(right.level !== "warn") - Number(left.level !== "warn") ||
    right.lastSeenAt.localeCompare(left.lastSeenAt) || right.count - left.count);
  return { rows: projected, truncated: rows.length >= HEALTH_SLOW_TRANSACTION_LIMIT };
}

/** The transaction a row names, as the reports print it: `memory/job_commit INDEX_HISTORY`. */
export function slowTransactionName(row: Pick<HealthSlowTransactionRow, "subsystem" | "operation" | "jobKind">): string {
  const name = [row.subsystem, row.operation].filter((part): part is string => part !== null).join("/") || "unknown";
  return row.jobKind === null ? name : `${name} ${row.jobKind}`;
}
