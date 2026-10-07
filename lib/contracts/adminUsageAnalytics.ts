import type { AdminMembership } from "./admin";
import type { ErrorResponse } from "./http";

/**
 * Control Center usage analytics over one period. Amounts sum persisted
 * provider-reported usage; `estimatedCostMicros` sums only known estimates and
 * stays `null` when no record in the slice has one. Category derives from each
 * record's purpose when read: system purposes are `system`; the work of models
 * users chose is `images`, `scheduled` (while the run's scheduled task link is
 * retained) or `chat`.
 */
export const ADMIN_USAGE_PERIODS = ["7d", "30d", "90d", "this_month", "last_month", "12m", "all"] as const;
export type AdminUsagePeriod = (typeof ADMIN_USAGE_PERIODS)[number];
export const DEFAULT_ADMIN_USAGE_PERIOD: AdminUsagePeriod = "30d";

export const ADMIN_USAGE_CATEGORIES = ["chat", "scheduled", "images", "system"] as const;
export type AdminUsageCategory = (typeof ADMIN_USAGE_CATEGORIES)[number];

/**
 * The system purposes of `lib/domain/usagePurpose.ts` in its order: work that
 * administrator-assigned system models do for users. Contracts stay dependency
 * leaves, so the list is repeated here; a server test keeps the two equal.
 */
export const ADMIN_USAGE_SYSTEM_PURPOSES = [
  "chat_title", "chat_summary", "chat_vision", "chat_pdf", "skill_selection",
  "memory_processing", "memory_indexing", "memory_retrieval",
  "knowledge_indexing", "knowledge_retrieval", "model_check", "other"
] as const;
export type AdminUsageSystemPurpose = (typeof ADMIN_USAGE_SYSTEM_PURPOSES)[number];

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

/** The system-purpose part of a user's or a group's usage. */
export type AdminUsageSystemAmounts = Pick<AdminUsageAmounts,
  "estimatedCostMicros" | "knownCostRecordCount" | "recordCount" | "totalTokens">;

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
  /** Known estimated cost of system purposes. */
  systemEstimatedCostMicros: number | null;
  to: string;
  totalTokens: number | null;
};

export type AdminUsageSeriesValue = {
  /** Known estimated cost: zero without usage, `null` when the slice has usage but no known cost. */
  estimatedCostMicros: number | null;
  totalTokens: number;
};

export type AdminUsageSeriesPoint = {
  categories: Record<AdminUsageCategory, AdminUsageSeriesValue>;
  runCount: number;
  /** Bucket start instant in the window's time zone. */
  start: string;
};

export type AdminUsageCategoryRecord = AdminUsageAmounts & { category: AdminUsageCategory };

/** One canonical model's personal-purpose usage. */
export type AdminUsageModelRecord = AdminUsageAmounts & {
  /** Human label resolved by the server; the raw model id when no catalog row matches. */
  label: string;
  modelId: string;
  provider: string;
  userCount: number;
};

export type AdminUsageSystemFunctionRecord = AdminUsageAmounts & { purpose: AdminUsageSystemPurpose };

/** One canonical model's system-purpose usage. */
export type AdminUsageSystemModelRecord = AdminUsageAmounts & {
  label: string;
  modelId: string;
  provider: string;
  /** The system purposes it served in the period, in vocabulary order. */
  purposes: AdminUsageSystemPurpose[];
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
  system: AdminUsageSystemAmounts;
  /** Personal-purpose models, at most three, most expensive first. */
  topModels: AdminUsageTopModel[];
  userId: string;
};

export type AdminUsageGroupRecord = AdminUsageAmounts & {
  archivedAt: string | null;
  /** Members with usage in the period. */
  contributingUsers: number;
  groupId: string;
  name: string;
  system: AdminUsageSystemAmounts;
  userCount: number;
};

export type AdminUsageAnalytics = {
  byCategory: AdminUsageCategoryRecord[];
  byGroup: AdminUsageGroupRecord[];
  /** Models users chose (personal purposes), most expensive first. */
  byModel: AdminUsageModelRecord[];
  /** System purposes with usage in the period, most expensive first. */
  bySystemFunction: AdminUsageSystemFunctionRecord[];
  /** Models that served system purposes, most expensive first. */
  bySystemModel: AdminUsageSystemModelRecord[];
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

export function isAdminUsageSystemPurpose(value: unknown): value is AdminUsageSystemPurpose {
  return (ADMIN_USAGE_SYSTEM_PURPOSES as readonly unknown[]).includes(value);
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

function systemAmounts(value: unknown): value is AdminUsageSystemAmounts {
  return isRecord(value) && count(value.knownCostRecordCount) && count(value.recordCount) &&
    nullableCount(value.estimatedCostMicros) && nullableCount(value.totalTokens);
}

function systemPurposes(value: unknown): value is AdminUsageSystemPurpose[] {
  return Array.isArray(value) && value.length <= ADMIN_USAGE_SYSTEM_PURPOSES.length &&
    value.every(isAdminUsageSystemPurpose) && new Set(value).size === value.length;
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
      return isRecord(entry) && nullableCount(entry.estimatedCostMicros) && count(entry.totalTokens);
    });
}

function window(value: unknown): value is AdminUsageWindow {
  return isRecord(value) && isAdminUsagePeriod(value.period) &&
    (value.bucket === "day" || value.bucket === "month") &&
    nullableInstant(value.from) && instant(value.to) && text(value.timeZone, MAX_USAGE_TIME_ZONE_LENGTH);
}

function comparison(value: unknown): value is AdminUsageComparison {
  return isRecord(value) && instant(value.from) && instant(value.to) && count(value.activeUserCount) &&
    count(value.runCount) && nullableCount(value.estimatedCostMicros) && nullableCount(value.totalTokens) &&
    nullableCount(value.systemEstimatedCostMicros);
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
    !rows<AdminUsageSystemFunctionRecord>(usage.bySystemFunction, (row) => isAdminUsageSystemPurpose(row.purpose)) ||
    !rows<AdminUsageSystemModelRecord>(usage.bySystemModel, (row) =>
      text(row.label, 512) && text(row.modelId, 512) && text(row.provider, 256) && systemPurposes(row.purposes)) ||
    !rows<AdminUsageUserRecord>(usage.byUser, (row) =>
      text(row.userId, 128) && text(row.displayName, 512) &&
      (row.email === null || text(row.email, 512)) && nullableInstant(row.lastUsedAt) &&
      Array.isArray(row.groups) && row.groups.every(membership) && systemAmounts(row.system) &&
      Array.isArray(row.topModels) && row.topModels.length <= 3 && row.topModels.every(topModel)) ||
    !rows<AdminUsageGroupRecord>(usage.byGroup, (row) =>
      text(row.groupId, 128) && text(row.name, 256) && nullableInstant(row.archivedAt) &&
      count(row.contributingUsers) && count(row.userCount) && systemAmounts(row.system))) {
    return null;
  }
  return value as AdminUsageAnalyticsResponse;
}
