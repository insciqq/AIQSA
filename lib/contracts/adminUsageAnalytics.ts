import type { AdminMembership } from "./admin";
import type { ErrorResponse } from "./http";

/**
 * Control Center usage analytics over one period. Amounts sum persisted
 * provider-reported usage; `estimatedCostMicros` sums only known estimates and
 * stays `null` when no record in the slice has one. Category is derived from
 * the record's links when read, so usage whose source was deleted reads as
 * `background`.
 */
export const ADMIN_USAGE_PERIODS = ["7d", "30d", "90d", "this_month", "last_month", "12m", "all"] as const;
export type AdminUsagePeriod = (typeof ADMIN_USAGE_PERIODS)[number];
export const DEFAULT_ADMIN_USAGE_PERIOD: AdminUsagePeriod = "30d";

export const ADMIN_USAGE_CATEGORIES = ["chat", "scheduled", "images", "memory", "background"] as const;
export type AdminUsageCategory = (typeof ADMIN_USAGE_CATEGORIES)[number];

export type AdminUsageBucket = "day" | "month";

export type AdminUsageAmounts = {
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  estimatedCostMicros: number | null;
  incompleteUsageCount: number;
  inputTokens: number | null;
  knownCostRecordCount: number;
  outputTokens: number | null;
  reasoningTokens: number | null;
  recordCount: number;
  /** Distinct retained runs with usage in the slice. */
  runCount: number;
  totalTokens: number | null;
};

export type AdminUsageWindow = {
  bucket: AdminUsageBucket;
  /** Inclusive start; `null` only for `all` without any usage. */
  from: string | null;
  period: AdminUsagePeriod;
  timeZone: string;
  /** Exclusive end. */
  to: string;
};

export type AdminUsageTotals = AdminUsageAmounts & {
  activeUserCount: number;
  lastUsedAt: string | null;
};

export type AdminUsageComparison = {
  activeUserCount: number;
  estimatedCostMicros: number | null;
  from: string;
  runCount: number;
  to: string;
  totalTokens: number | null;
};

export type AdminUsageSeriesValue = {
  /** Known estimated cost; zero when none was known. */
  estimatedCostMicros: number;
  totalTokens: number;
};

export type AdminUsageSeriesPoint = {
  categories: Record<AdminUsageCategory, AdminUsageSeriesValue>;
  runCount: number;
  /** Bucket start instant in the window's time zone. */
  start: string;
};

export type AdminUsageCategoryRecord = AdminUsageAmounts & { category: AdminUsageCategory };

export type AdminUsageModelRecord = AdminUsageAmounts & {
  /** Human label resolved by the server; the raw model id when no catalog row matches. */
  label: string;
  modelId: string;
  provider: string;
  userCount: number;
};

export type AdminUsageTopModel = {
  estimatedCostMicros: number | null;
  label: string;
  modelId: string;
  provider: string;
  totalTokens: number | null;
};

export type AdminUsageUserRecord = AdminUsageAmounts & {
  displayName: string;
  email: string | null;
  groups: AdminMembership[];
  lastUsedAt: string | null;
  /** At most three, most expensive first. */
  topModels: AdminUsageTopModel[];
  userId: string;
};

export type AdminUsageGroupRecord = AdminUsageAmounts & {
  archivedAt: string | null;
  /** Members with usage in the period. */
  contributingUsers: number;
  groupId: string;
  name: string;
  userCount: number;
};

export type AdminUsageAnalytics = {
  byCategory: AdminUsageCategoryRecord[];
  byGroup: AdminUsageGroupRecord[];
  byModel: AdminUsageModelRecord[];
  /** Users with usage in the period, most expensive first. */
  byUser: AdminUsageUserRecord[];
  /** The preceding comparable window; `null` for `all`. */
  previous: AdminUsageComparison | null;
  /** Every bucket of the window in ascending order, empty buckets included. */
  series: AdminUsageSeriesPoint[];
  totals: AdminUsageTotals;
  /** Users in the installation, for "active of total". */
  userCount: number;
  window: AdminUsageWindow;
};

export type AdminUsageAnalyticsResponse = { usage: AdminUsageAnalytics };

export type AdminUsageAnalyticsErrorCode =
  | "forbidden"
  | "unauthorized"
  | "usage_analytics_failed"
  | "usage_period_invalid"
  | "usage_time_zone_invalid";

export type AdminUsageAnalyticsErrorResponse = ErrorResponse<AdminUsageAnalyticsErrorCode>;

export const MAX_USAGE_TIME_ZONE_LENGTH = 64;

export function isAdminUsagePeriod(value: unknown): value is AdminUsagePeriod {
  return typeof value === "string" && (ADMIN_USAGE_PERIODS as readonly string[]).includes(value);
}

/** The query string both the dashboard and the CSV export send. */
export function adminUsageQuery(period: AdminUsagePeriod, timeZone: string): string {
  return new URLSearchParams({ period, tz: timeZone }).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableCount(value: unknown): value is number | null {
  return value === null || count(value);
}

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || instant(value);
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

const AMOUNT_COUNTS = ["incompleteUsageCount", "knownCostRecordCount", "recordCount", "runCount"] as const;
const AMOUNT_NULLABLE = [
  "cachedInputTokens", "cacheWriteInputTokens", "estimatedCostMicros",
  "inputTokens", "outputTokens", "reasoningTokens", "totalTokens"
] as const;

function amounts(value: Record<string, unknown>): boolean {
  return AMOUNT_COUNTS.every((key) => count(value[key])) &&
    AMOUNT_NULLABLE.every((key) => nullableCount(value[key]));
}

function membership(value: unknown): value is AdminMembership {
  return isRecord(value) && text(value.groupId, 128) && text(value.name, 256) && typeof value.role === "string";
}

function topModel(value: unknown): value is AdminUsageTopModel {
  return isRecord(value) && text(value.label, 512) && text(value.modelId, 512) && text(value.provider, 256) &&
    nullableCount(value.estimatedCostMicros) && nullableCount(value.totalTokens);
}

function seriesPoint(value: unknown): value is AdminUsageSeriesPoint {
  if (!isRecord(value) || !instant(value.start) || !count(value.runCount) || !isRecord(value.categories)) return false;
  const categories = value.categories;
  return Object.keys(categories).length === ADMIN_USAGE_CATEGORIES.length &&
    ADMIN_USAGE_CATEGORIES.every((category) => {
      const entry = categories[category];
      return isRecord(entry) && count(entry.estimatedCostMicros) && count(entry.totalTokens);
    });
}

function window(value: unknown): value is AdminUsageWindow {
  return isRecord(value) && isAdminUsagePeriod(value.period) &&
    (value.bucket === "day" || value.bucket === "month") &&
    nullableInstant(value.from) && instant(value.to) && text(value.timeZone, MAX_USAGE_TIME_ZONE_LENGTH);
}

function comparison(value: unknown): value is AdminUsageComparison {
  return isRecord(value) && instant(value.from) && instant(value.to) && count(value.activeUserCount) &&
    count(value.runCount) && nullableCount(value.estimatedCostMicros) && nullableCount(value.totalTokens);
}

const MAX_ROWS = 10_000;

function rows<T>(value: unknown, decode: (row: Record<string, unknown>) => boolean): value is T[] {
  return Array.isArray(value) && value.length <= MAX_ROWS &&
    value.every((row) => isRecord(row) && amounts(row) && decode(row));
}

/** Strict decoding: a malformed response fails visibly instead of rendering guessed numbers. */
export function decodeAdminUsageAnalyticsResponse(value: unknown): AdminUsageAnalyticsResponse | null {
  if (!isRecord(value) || !isRecord(value.usage)) return null;
  const usage = value.usage;
  if (!window(usage.window) || !count(usage.userCount) ||
    !isRecord(usage.totals) || !amounts(usage.totals) || !count(usage.totals.activeUserCount) ||
    !nullableInstant(usage.totals.lastUsedAt) ||
    !(usage.previous === null || comparison(usage.previous)) ||
    !Array.isArray(usage.series) || usage.series.length > 1_000 || !usage.series.every(seriesPoint) ||
    !rows<AdminUsageCategoryRecord>(usage.byCategory, (row) =>
      (ADMIN_USAGE_CATEGORIES as readonly unknown[]).includes(row.category)) ||
    !rows<AdminUsageModelRecord>(usage.byModel, (row) =>
      text(row.label, 512) && text(row.modelId, 512) && text(row.provider, 256) && count(row.userCount)) ||
    !rows<AdminUsageUserRecord>(usage.byUser, (row) =>
      text(row.userId, 128) && text(row.displayName, 512) &&
      (row.email === null || text(row.email, 512)) && nullableInstant(row.lastUsedAt) &&
      Array.isArray(row.groups) && row.groups.every(membership) &&
      Array.isArray(row.topModels) && row.topModels.length <= 3 && row.topModels.every(topModel)) ||
    !rows<AdminUsageGroupRecord>(usage.byGroup, (row) =>
      text(row.groupId, 128) && text(row.name, 256) && nullableInstant(row.archivedAt) &&
      count(row.contributingUsers) && count(row.userCount))) {
    return null;
  }
  return value as AdminUsageAnalyticsResponse;
}
