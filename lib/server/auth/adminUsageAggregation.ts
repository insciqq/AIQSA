import type {
  AdminUsageDashboard,
  AdminUsageGroupRecord,
  AdminUsageProviderModelRecord,
  AdminUsageTokenTotals,
  AdminUsageUserRecord
} from "@/lib/contracts/admin";
import {
  serializeAdminDate,
  serializeAdminMemberships,
  type AdminMembershipSource
} from "@/lib/server/auth/adminSerializationPrimitives";

export type AdminUsageAggregateSums = Readonly<{
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
}>;

export type AdminUsageAggregateSource = Readonly<{
  _count: Readonly<{
    _all: number;
  }>;
  _max: Readonly<{
    createdAt: Date | null;
  }>;
  _sum: AdminUsageAggregateSums;
  userId: string;
}>;

export type AdminUsageProviderModelSource = AdminUsageAggregateSource &
  Readonly<{
    modelId: string;
    provider: string;
  }>;

export type AdminUsageGroupSource = Readonly<{
  _count: Readonly<{
    users: number;
  }>;
  archivedAt: Date | null;
  id: string;
  name: string;
}>;

export type AdminUsageUserSource = Readonly<{
  displayName: string;
  email: string | null;
  groups: readonly (AdminMembershipSource &
    Readonly<{
      group?: Readonly<{
        archivedAt: Date | null;
        name: string;
      }> | null;
    }>)[];
  id: string;
}>;

export type AdminUsageAggregationInput = Readonly<{
  groups: readonly AdminUsageGroupSource[];
  providerModelRows: readonly AdminUsageProviderModelSource[];
  userRows: readonly AdminUsageAggregateSource[];
  users: readonly AdminUsageUserSource[];
}>;

function emptyUsageTotals(): AdminUsageTokenTotals {
  return {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    inputTokens: 0,
    lastUsedAt: null,
    outputTokens: 0,
    reasoningTokens: 0,
    runCount: 0,
    totalTokens: 0
  };
}

function numberOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageTotalsFromAggregate(input: {
  count: number;
  lastUsedAt: Date | null;
  sums: AdminUsageAggregateSums;
}): AdminUsageTokenTotals {
  const inputTokens = numberOrZero(input.sums.inputTokens);
  const outputTokens = numberOrZero(input.sums.outputTokens);
  const totalTokens = numberOrZero(input.sums.totalTokens);

  return {
    cachedInputTokens: numberOrZero(input.sums.cachedInputTokens),
    cacheWriteInputTokens: numberOrZero(input.sums.cacheWriteInputTokens),
    inputTokens,
    lastUsedAt: serializeAdminDate(input.lastUsedAt),
    outputTokens,
    reasoningTokens: numberOrZero(input.sums.reasoningTokens),
    runCount: input.count,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens
  };
}

function addUsageTotals(left: AdminUsageTokenTotals, right: AdminUsageTokenTotals): AdminUsageTokenTotals {
  const lastUsedAt =
    left.lastUsedAt && right.lastUsedAt
      ? new Date(left.lastUsedAt).getTime() >= new Date(right.lastUsedAt).getTime()
        ? left.lastUsedAt
        : right.lastUsedAt
      : left.lastUsedAt ?? right.lastUsedAt;

  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    lastUsedAt,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    runCount: left.runCount + right.runCount,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function compareUsageTotals(left: AdminUsageTokenTotals, right: AdminUsageTokenTotals): number {
  return (
    right.totalTokens - left.totalTokens ||
    right.runCount - left.runCount ||
    (right.lastUsedAt ? new Date(right.lastUsedAt).getTime() : 0) -
      (left.lastUsedAt ? new Date(left.lastUsedAt).getTime() : 0)
  );
}

export function serializeAdminUsageDashboard(input: AdminUsageAggregationInput): AdminUsageDashboard {
  const providerModelsByUser = new Map<string, AdminUsageProviderModelRecord[]>();

  for (const row of input.providerModelRows) {
    const providerModel = {
      ...usageTotalsFromAggregate({
        count: row._count._all,
        lastUsedAt: row._max.createdAt,
        sums: row._sum
      }),
      modelId: row.modelId,
      provider: row.provider
    };

    providerModelsByUser.set(row.userId, [...(providerModelsByUser.get(row.userId) ?? []), providerModel]);
  }

  for (const providerModels of providerModelsByUser.values()) {
    providerModels.sort(compareUsageTotals);
  }

  const usageByUserId = new Map(
    input.userRows.map((row) => [
      row.userId,
      usageTotalsFromAggregate({
        count: row._count._all,
        lastUsedAt: row._max.createdAt,
        sums: row._sum
      })
    ])
  );

  const byUser = input.users
    .map((user): AdminUsageUserRecord => ({
      ...emptyUsageTotals(),
      ...(usageByUserId.get(user.id) ?? {}),
      displayName: user.displayName,
      email: user.email,
      groups: serializeAdminMemberships(user.groups),
      providerModels: providerModelsByUser.get(user.id) ?? [],
      userId: user.id
    }))
    .sort((left, right) => compareUsageTotals(left, right) || left.displayName.localeCompare(right.displayName));

  const totals = byUser.reduce((current, user) => addUsageTotals(current, user), emptyUsageTotals());
  const groupTotals = new Map<string, AdminUsageTokenTotals>(
    input.groups.map((group) => [group.id, emptyUsageTotals()])
  );
  const groupContributors = new Map<string, Set<string>>(input.groups.map((group) => [group.id, new Set<string>()]));

  for (const user of input.users) {
    const userTotals = usageByUserId.get(user.id) ?? emptyUsageTotals();

    for (const membership of user.groups) {
      groupTotals.set(
        membership.groupId,
        addUsageTotals(groupTotals.get(membership.groupId) ?? emptyUsageTotals(), userTotals)
      );

      if (userTotals.totalTokens > 0) {
        groupContributors.get(membership.groupId)?.add(user.id);
      }
    }
  }

  const byGroup = input.groups
    .map((group): AdminUsageGroupRecord => ({
      ...(groupTotals.get(group.id) ?? emptyUsageTotals()),
      archivedAt: serializeAdminDate(group.archivedAt),
      contributingUsers: groupContributors.get(group.id)?.size ?? 0,
      groupId: group.id,
      name: group.name,
      userCount: group._count.users
    }))
    .sort((left, right) => compareUsageTotals(left, right) || left.name.localeCompare(right.name));

  return {
    byGroup,
    byUser,
    totals
  };
}
