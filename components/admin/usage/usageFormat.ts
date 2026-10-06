import {
  ADMIN_USAGE_CATEGORIES,
  type AdminUsageAmounts,
  type AdminUsageBucket,
  type AdminUsageCategory,
  type AdminUsagePeriod,
  type AdminUsageWindow
} from "@/lib/contracts/adminUsageAnalytics";

export const USAGE_PERIOD_LABELS: Record<AdminUsagePeriod, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  this_month: "This month",
  last_month: "Last month",
  "12m": "Last 12 months",
  all: "All time"
};

/** Fixed chart slot per category; never reassigned by rank or filter. */
export const USAGE_CATEGORY_META: Record<AdminUsageCategory, Readonly<{
  color: string;
  label: string;
  meaning: string;
}>> = {
  chat: {
    color: "var(--v2-chart-1)",
    label: "Chats",
    meaning: "Answers, edits and regenerations in personal and Project chats"
  },
  scheduled: {
    color: "var(--v2-chart-2)",
    label: "Scheduled tasks",
    meaning: "Runs started by scheduled tasks"
  },
  images: {
    color: "var(--v2-chart-3)",
    label: "Images",
    meaning: "Image generation and editing"
  },
  memory: {
    color: "var(--v2-chart-4)",
    label: "Memory",
    meaning: "Memory extraction and upkeep"
  },
  background: {
    color: "var(--v2-chart-5)",
    label: "Knowledge & other",
    meaning: "Background processing and usage whose source was deleted"
  }
};

export const USAGE_CATEGORY_ORDER: readonly AdminUsageCategory[] = ADMIN_USAGE_CATEGORIES;

export type UsageChartMetric = "cost" | "tokens";

export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length <= 64 ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

export function formatCount(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined).format(value);
}

export function formatCompactTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(value);
}

/** USD for axis ticks and tooltips from integer micro-dollars. */
export function formatUsd(micros: number, fractionDigits?: number): string {
  const dollars = micros / 1_000_000;
  const digits = fractionDigits ?? (dollars !== 0 && Math.abs(dollars) < 10 ? 2 : 0);
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: "currency"
  }).format(dollars);
}

/** A known estimate at cent precision; a tiny non-zero estimate never reads as zero. */
export function formatUsdValue(micros: number): string {
  if (micros > 0 && micros < 10_000) return "<$0.01";
  return formatUsd(micros, 2);
}

/** Axis tick in the step's own precision, so 0.025 steps keep their third digit. */
export function formatUsdTick(micros: number, stepMicros: number): string {
  // Whole dollars drop the cents; otherwise cents, or a third digit for half-cent steps.
  const digits = stepMicros % 1_000_000 === 0 ? 0 : stepMicros % 10_000 === 0 ? 2 : 3;
  return formatUsd(micros, micros === 0 ? 0 : digits);
}

export function formatMetricValue(metric: UsageChartMetric, value: number): string {
  return metric === "cost" ? formatUsdValue(value) : formatCount(value);
}

function comparisonLabel(window: AdminUsageWindow, previous: Readonly<{ from: string; to: string }>): string {
  switch (window.period) {
    case "7d": return "previous 7 days";
    case "30d": return "previous 30 days";
    case "90d": return "previous 90 days";
    case "12m": return "previous 12 months";
    case "last_month": return "the month before";
    default: {
      // Month to date compares with a window the server picks; name its dates.
      const end = new Date(Date.parse(previous.to) - 1);
      return `${formatBucketDate(previous.from, window.timeZone, "day")} – ${formatBucketDate(end.toISOString(), window.timeZone, "day")}`;
    }
  }
}

/**
 * "↑ 12% vs previous 30 days" in neutral wording; "—" when either side is
 * unknown or the previous value is zero (no meaningful ratio).
 */
export function formatUsageDelta(
  current: number | null,
  previousValue: number | null,
  window: AdminUsageWindow,
  previous: Readonly<{ from: string; to: string }> | null
): string {
  if (!previous || current === null || previousValue === null || previousValue === 0) return "—";
  const label = comparisonLabel(window, previous);
  const ratio = (current - previousValue) / previousValue;
  const percent = Math.abs(ratio * 100);
  if (current === previousValue) return `No change vs ${label}`;
  const arrow = ratio > 0 ? "↑" : "↓";
  const amount = percent < 1 ? "<1%" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(percent)}%`;
  return `${arrow} ${amount} vs ${label}`;
}

export function formatBucketDate(start: string, timeZone: string, bucket: AdminUsageBucket, long = false): string {
  const options: Intl.DateTimeFormatOptions = bucket === "month"
    ? { month: long ? "long" : "short", timeZone, year: "numeric" }
    : { day: "numeric", month: "short", timeZone, ...(long ? { weekday: "short", year: "numeric" } : {}) };
  try {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(start));
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date(start));
  }
}

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/** Rounded axis ticks from zero covering `max` with about `target` intervals. */
export function niceTicks(max: number, target = 4, minimumStep = 1): number[] {
  if (!(max > 0)) return [0, minimumStep];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const factor = NICE_STEPS.find((step) => step * magnitude >= rough) ?? 10;
  const step = Math.ceil(Math.max(minimumStep, factor * magnitude) / minimumStep - 1e-9) * minimumStep;
  const ticks = [0];
  while (ticks[ticks.length - 1]! < max) ticks.push(ticks.length * step);
  return ticks;
}

/** Share of a positive total, 0–1; zero when the total is unknown or empty. */
export function shareOf(value: number | null, total: number | null): number {
  if (value === null || total === null || total <= 0 || value <= 0) return 0;
  return Math.min(1, value / total);
}

export function formatShare(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

const SUMMED_NULLABLE = [
  "cachedInputTokens", "cacheWriteInputTokens", "estimatedCostMicros",
  "inputTokens", "outputTokens", "reasoningTokens", "totalTokens"
] as const;

/** Folds rows into one: counts add, nullable amounts stay `null` only when every row is unknown. */
export function sumUsageAmounts(rows: readonly AdminUsageAmounts[]): AdminUsageAmounts {
  const total: AdminUsageAmounts = {
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostMicros: null,
    incompleteUsageCount: 0,
    inputTokens: null,
    knownCostRecordCount: 0,
    outputTokens: null,
    reasoningTokens: null,
    recordCount: 0,
    runCount: 0,
    totalTokens: null
  };
  for (const row of rows) {
    total.incompleteUsageCount += row.incompleteUsageCount;
    total.knownCostRecordCount += row.knownCostRecordCount;
    total.recordCount += row.recordCount;
    total.runCount += row.runCount;
    for (const key of SUMMED_NULLABLE) {
      const value = row[key];
      if (value !== null) total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}
