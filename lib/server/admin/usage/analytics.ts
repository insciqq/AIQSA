import {
  ADMIN_USAGE_CATEGORIES,
  type AdminUsageAmounts,
  type AdminUsageAnalytics,
  type AdminUsageCategory,
  type AdminUsageCategoryRecord,
  type AdminUsageComparison,
  type AdminUsageGroupRecord,
  type AdminUsageModelRecord,
  type AdminUsageSeriesPoint,
  type AdminUsageSeriesValue,
  type AdminUsageTopModel,
  type AdminUsageUserRecord
} from "@/lib/contracts/adminUsageAnalytics";
import { serializeAdminMemberships, type AdminMembershipSource } from "@/lib/server/auth/adminSerializationPrimitives";
import { boundedUsageText, resolvedFromUsageModelKey, type ResolvedUsageModel } from "./models";
import type { UsageWindowPlan } from "./window";

/** Which `GROUPING SETS` entry an aggregate row belongs to. */
export type UsageAggregateSet = "bucket" | "bucket_category" | "category" | "model" | "total" | "user" | "user_model";

export type UsageAggregateRow = Readonly<{
  amounts: AdminUsageAmounts;
  bucket: string | null;
  category: AdminUsageCategory | null;
  lastUsedAt: Date | null;
  model: string | null;
  set: UsageAggregateSet;
  /** Distinct users in the slice. */
  userCount: number;
  userId: string | null;
}>;

export type UsageComparisonTotals = Readonly<{
  activeUserCount: number;
  estimatedCostMicros: number | null;
  runCount: number;
  totalTokens: number | null;
}>;

export type UsageUserSource = Readonly<{
  displayName: string;
  email: string | null;
  groups: readonly AdminMembershipSource[];
  id: string;
}>;

export type UsageGroupSource = Readonly<{
  archivedAt: Date | null;
  id: string;
  memberCount: number;
  name: string;
}>;

export type UsageAnalyticsSnapshot = Readonly<{
  groups: readonly UsageGroupSource[];
  models: ReadonlyMap<string, ResolvedUsageModel>;
  plan: UsageWindowPlan;
  previous: UsageComparisonTotals | null;
  rows: readonly UsageAggregateRow[];
  userCount: number;
  users: readonly UsageUserSource[];
}>;

const NULLABLE_AMOUNTS = [
  "cachedInputTokens", "cacheWriteInputTokens", "estimatedCostMicros",
  "inputTokens", "outputTokens", "reasoningTokens", "totalTokens"
] as const;
const COUNT_AMOUNTS = ["incompleteUsageCount", "knownCostRecordCount", "recordCount", "runCount"] as const;

export function emptyUsageAmounts(): AdminUsageAmounts {
  return {
    cachedInputTokens: null, cacheWriteInputTokens: null, estimatedCostMicros: null, incompleteUsageCount: 0,
    inputTokens: null, knownCostRecordCount: 0, outputTokens: null, reasoningTokens: null, recordCount: 0,
    runCount: 0, totalTokens: null
  };
}

function safeSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error("usage_amount_overflow");
  return sum;
}

/** Sums of disjoint slices; a nullable field stays `null` only when neither side reports it. */
export function addUsageAmounts(left: AdminUsageAmounts, right: AdminUsageAmounts): AdminUsageAmounts {
  const result = { ...left };
  for (const key of COUNT_AMOUNTS) result[key] = safeSum(left[key], right[key]);
  for (const key of NULLABLE_AMOUNTS) {
    result[key] = left[key] === null && right[key] === null ? null : safeSum(left[key] ?? 0, right[key] ?? 0);
  }
  return result;
}

type Ranked = Readonly<{ estimatedCostMicros: number | null; totalTokens: number | null }>;

/** Cost descending with unknown cost last, then tokens descending, then name. */
export function compareUsageRank(left: Ranked, right: Ranked, leftName: string, rightName: string): number {
  return (right.estimatedCostMicros ?? -1) - (left.estimatedCostMicros ?? -1) ||
    (right.totalTokens ?? -1) - (left.totalTokens ?? -1) ||
    leftName.localeCompare(rightName);
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function emptySeriesValue(): AdminUsageSeriesValue {
  return { estimatedCostMicros: 0, totalTokens: 0 };
}

function seriesOf(snapshot: UsageAnalyticsSnapshot): AdminUsageSeriesPoint[] {
  const points = new Map(snapshot.plan.buckets.map((bucket) => [bucket.key, {
    categories: Object.fromEntries(ADMIN_USAGE_CATEGORIES.map((category) => [category, emptySeriesValue()])) as
      Record<AdminUsageCategory, AdminUsageSeriesValue>,
    runCount: 0,
    start: bucket.start.toISOString()
  }]));
  for (const row of snapshot.rows) {
    const point = row.bucket === null ? undefined : points.get(row.bucket);
    if (!point) continue;
    if (row.set === "bucket") point.runCount = row.amounts.runCount;
    if (row.set === "bucket_category" && row.category) {
      point.categories[row.category] = {
        estimatedCostMicros: row.amounts.estimatedCostMicros ?? 0,
        totalTokens: row.amounts.totalTokens ?? 0
      };
    }
  }
  return [...points.values()];
}

function modelOf(snapshot: UsageAnalyticsSnapshot, key: string): ResolvedUsageModel {
  return snapshot.models.get(key) ?? resolvedFromUsageModelKey(key);
}

function topModel(model: ResolvedUsageModel, amounts: AdminUsageAmounts): AdminUsageTopModel {
  return {
    estimatedCostMicros: amounts.estimatedCostMicros, label: model.label, modelId: model.modelId,
    provider: model.provider, totalTokens: amounts.totalTokens
  };
}

function comparison(snapshot: UsageAnalyticsSnapshot): AdminUsageComparison | null {
  const range = snapshot.plan.previous;
  if (!range || !snapshot.previous) return null;
  return { ...snapshot.previous, from: range.from.toISOString(), to: range.to.toISOString() };
}

/** Projects the aggregate rows of one window onto the analytics contract. */
export function serializeAdminUsageAnalytics(snapshot: UsageAnalyticsSnapshot): AdminUsageAnalytics {
  const plan = snapshot.plan;
  const rowsOf = (set: UsageAggregateSet) => snapshot.rows.filter((row) => row.set === set);
  const total = rowsOf("total")[0];

  const byCategory = rowsOf("category")
    .filter((row): row is UsageAggregateRow & { category: AdminUsageCategory } => row.category !== null)
    .map((row): AdminUsageCategoryRecord => ({ ...row.amounts, category: row.category }))
    .sort((left, right) => compareUsageRank(left, right, "", "") ||
      ADMIN_USAGE_CATEGORIES.indexOf(left.category) - ADMIN_USAGE_CATEGORIES.indexOf(right.category));

  const byModel = rowsOf("model").flatMap((row): AdminUsageModelRecord[] => {
    if (row.model === null) return [];
    const model = modelOf(snapshot, row.model);
    return [{ ...row.amounts, label: model.label, modelId: model.modelId, provider: model.provider, userCount: row.userCount }];
  }).sort((left, right) => compareUsageRank(left, right, left.label, right.label));

  const topModelsByUser = new Map<string, AdminUsageTopModel[]>();
  for (const row of rowsOf("user_model")) {
    if (row.userId === null || row.model === null) continue;
    const list = topModelsByUser.get(row.userId) ?? [];
    list.push(topModel(modelOf(snapshot, row.model), row.amounts));
    topModelsByUser.set(row.userId, list);
  }

  const usersById = new Map(snapshot.users.map((user) => [user.id, user]));
  const usageByUser = new Map<string, Readonly<{ amounts: AdminUsageAmounts; lastUsedAt: Date | null }>>();
  const byUser = rowsOf("user").flatMap((row): AdminUsageUserRecord[] => {
    const user = row.userId === null ? undefined : usersById.get(row.userId);
    if (!user) return [];
    usageByUser.set(user.id, row);
    const email = user.email ? boundedUsageText(user.email, 512, user.email) : null;
    return [{
      ...row.amounts,
      displayName: boundedUsageText(user.displayName, 512, email ?? user.id),
      email,
      groups: serializeAdminMemberships(user.groups),
      lastUsedAt: isoDate(row.lastUsedAt),
      topModels: (topModelsByUser.get(user.id) ?? [])
        .sort((left, right) => compareUsageRank(left, right, left.label, right.label)).slice(0, 3),
      userId: user.id
    }];
  }).sort((left, right) => compareUsageRank(left, right, left.displayName, right.displayName));

  const groupAmounts = new Map<string, AdminUsageAmounts>();
  const contributors = new Map<string, number>();
  for (const user of snapshot.users) {
    const usage = usageByUser.get(user.id);
    if (!usage) continue;
    for (const membership of new Set(user.groups.map((entry) => entry.groupId))) {
      groupAmounts.set(membership, addUsageAmounts(groupAmounts.get(membership) ?? emptyUsageAmounts(), usage.amounts));
      contributors.set(membership, (contributors.get(membership) ?? 0) + 1);
    }
  }
  const byGroup = snapshot.groups.map((group): AdminUsageGroupRecord => ({
    ...(groupAmounts.get(group.id) ?? emptyUsageAmounts()),
    archivedAt: isoDate(group.archivedAt),
    contributingUsers: contributors.get(group.id) ?? 0,
    groupId: group.id,
    name: group.name,
    userCount: group.memberCount
  })).sort((left, right) => compareUsageRank(left, right, left.name, right.name));

  return {
    byCategory,
    byGroup,
    byModel,
    byUser,
    previous: comparison(snapshot),
    series: seriesOf(snapshot),
    totals: {
      ...(total?.amounts ?? emptyUsageAmounts()),
      activeUserCount: total?.userCount ?? 0,
      lastUsedAt: isoDate(total?.lastUsedAt ?? null)
    },
    userCount: snapshot.userCount,
    window: {
      bucket: plan.bucket,
      from: isoDate(plan.from),
      period: plan.period,
      timeZone: plan.timeZone,
      to: plan.to.toISOString()
    }
  };
}
