import type {
  AdminHealthCategory,
  AdminHealthFailureClass,
  AdminHealthRange
} from "@/lib/contracts/adminHealth";

export const healthRangeOptions: readonly Readonly<{ label: string; value: AdminHealthRange }>[] = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" }
];

export const healthCategoryLabels: Readonly<Record<AdminHealthCategory, string>> = {
  providers: "Providers",
  requests: "Requests",
  runs: "Runs",
  background: "Background",
  tools: "Tools",
  other: "Other"
};

/** Fixed series order: color follows the category, never its rank. */
export const healthCategoryColors: Readonly<Record<AdminHealthCategory, string>> = {
  providers: "var(--v2-color-chart-1)",
  requests: "var(--v2-color-chart-2)",
  runs: "var(--v2-color-chart-3)",
  background: "var(--v2-color-chart-4)",
  tools: "var(--v2-color-chart-5)",
  other: "var(--v2-color-chart-6)"
};

export const healthFailureClassLabels: Readonly<Record<AdminHealthFailureClass, string>> = {
  key_rejected: "Key rejected",
  quota: "Quota or limits",
  provider_error: "Provider errors",
  timeout: "Timeouts",
  network: "Network",
  other: "Other"
};

const stageLabels: Readonly<Record<string, string>> = {
  answer: "Answers",
  search: "Search",
  structured_output: "Structured output",
  cancel: "Cancel",
  refresh: "Status check",
  retrieve: "Result fetch",
  embedding: "Embeddings",
  rerank: "Reranking",
  decisions: "Decisions",
  image: "Image generation",
  vision: "Image analysis"
};

export function healthStageLabel(stage: string | null): string {
  if (stage === null) return "Unknown stage";
  return stageLabels[stage] ?? stage.replaceAll("_", " ");
}

export function healthRangeLabel(range: AdminHealthRange): string {
  return range === "24h" ? "last 24 hours" : range === "7d" ? "last 7 days" : "last 30 days";
}

const integer = new Intl.NumberFormat(undefined);

export function healthCount(value: number): string {
  return integer.format(value);
}

export function healthPercent(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0%";
  if (value < 0.001) return "<0.1%";
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

export function healthDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** Hour buckets read in local time; day buckets are UTC days and are labelled as such. */
export function healthBucketLabel(start: string, interval: "hour" | "day", detail = false): string {
  const date = new Date(start);
  if (interval === "hour") {
    return new Intl.DateTimeFormat(undefined, detail
      ? { dateStyle: "medium", timeStyle: "short" }
      : { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, detail
    ? { dateStyle: "medium", timeZone: "UTC" }
    : { day: "numeric", month: "short", timeZone: "UTC" }).format(date) + (detail ? " (UTC)" : "");
}

export function healthTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}
