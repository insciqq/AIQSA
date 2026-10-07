import type { AdminUsageAmounts, AdminUsageCategory, AdminUsagePeriod } from "@/lib/contracts/adminUsageAnalytics";
import type { UsagePurpose } from "@/lib/domain/usagePurpose";
import { serializeAdminMemberships, type AdminMembershipSource } from "@/lib/server/auth/adminSerializationPrimitives";
import { resolvedFromUsageModelKey, type ResolvedUsageModel } from "./models";

/** One CSV line: a bucket × user × canonical model × category × purpose slice. */
export type UsageExportRow = Readonly<{
  amounts: AdminUsageAmounts;
  bucket: string;
  category: AdminUsageCategory;
  model: string;
  purpose: UsagePurpose;
  userId: string;
}>;

export type UsageExportUser = Readonly<{
  displayName: string;
  email: string | null;
  groups: readonly AdminMembershipSource[];
  id: string;
}>;

export const MAX_USAGE_EXPORT_ROWS = 200_000;

export const USAGE_CSV_HEADER = [
  "period_start", "user_email", "user_name", "groups", "category", "purpose", "provider", "model", "runs", "records",
  "input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_tokens",
  "total_tokens", "estimated_cost_usd", "cost_known_records"
] as const;

const FORMULA_PREFIX = /^[=+\-@\t\r]/u;
const NEEDS_QUOTES = /[",\r\n]/u;

/**
 * One text cell: a value a spreadsheet would read as a formula gets a leading
 * apostrophe, then RFC 4180 quoting doubles quotes inside a quoted cell.
 */
export function usageCsvTextCell(value: string): string {
  const inert = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(inert) ? `"${inert.replaceAll("\"", "\"\"")}"` : inert;
}

function countCell(value: number | null): string {
  return value === null ? "" : String(value);
}

/** Exact decimal USD with six places; empty when no record had a known cost. */
export function formatUsageUsd(micros: number | null): string {
  if (micros === null) return "";
  const value = BigInt(micros);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, "0")}`;
}

export function usageExportFilename(period: AdminUsagePeriod, localDate: string): string {
  return `aiqsa-usage-${period}-${localDate}.csv`;
}

/** The local date that starts a bucket: `YYYY-MM-DD`, month buckets on their first day. */
function bucketDate(key: string): string {
  return key.length === 7 ? `${key}-01` : key;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** CRLF-terminated lines, header first, ordered by bucket, user, model, category and purpose. */
export function* usageCsvLines(input: Readonly<{
  models: ReadonlyMap<string, ResolvedUsageModel>;
  rows: readonly UsageExportRow[];
  users: ReadonlyMap<string, UsageExportUser>;
}>): Generator<string> {
  yield `${USAGE_CSV_HEADER.join(",")}\r\n`;
  const groupsByUser = new Map<string, string>();
  // Zero-padded local keys sort chronologically as text.
  const rows = [...input.rows].sort((left, right) => compareText(left.bucket, right.bucket) || compareText(left.userId, right.userId) ||
    compareText(left.model, right.model) || compareText(left.category, right.category) ||
    compareText(left.purpose, right.purpose));
  for (const row of rows) {
    const user = input.users.get(row.userId);
    let groups = groupsByUser.get(row.userId);
    if (groups === undefined) {
      groups = serializeAdminMemberships(user?.groups ?? []).map((group) => group.name).join("; ");
      groupsByUser.set(row.userId, groups);
    }
    const model = input.models.get(row.model) ?? resolvedFromUsageModelKey(row.model);
    const amounts = row.amounts;
    yield `${[
      bucketDate(row.bucket),
      usageCsvTextCell(user?.email ?? ""),
      usageCsvTextCell(user?.displayName ?? row.userId),
      usageCsvTextCell(groups),
      row.category,
      row.purpose,
      usageCsvTextCell(model.providerLabel),
      usageCsvTextCell(model.modelLabel),
      String(amounts.runCount),
      String(amounts.recordCount),
      countCell(amounts.inputTokens),
      countCell(amounts.cachedInputTokens),
      countCell(amounts.cacheWriteInputTokens),
      countCell(amounts.outputTokens),
      countCell(amounts.reasoningTokens),
      countCell(amounts.totalTokens),
      formatUsageUsd(amounts.estimatedCostMicros),
      String(amounts.knownCostRecordCount)
    ].join(",")}\r\n`;
  }
}
