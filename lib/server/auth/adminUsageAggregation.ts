import { reportedTokenCount } from "../../domain/usage";
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
  incompleteUsageCount: number;
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
  return { cachedInputTokens: null, cacheWriteInputTokens: null, inputTokens: null,
    lastUsedAt: null, outputTokens: null, reasoningTokens: null, runCount: 0,
    incompleteUsageCount: 0, totalTokens: null };
}

function usageTotalsFromAggregate(input: {
  count: number;
  incompleteUsageCount: number;
  lastUsedAt: Date | null;
  sums: AdminUsageAggregateSums;
}): AdminUsageTokenTotals {
  return {
    cachedInputTokens: reportedTokenCount(input.sums.cachedInputTokens),
    cacheWriteInputTokens: reportedTokenCount(input.sums.cacheWriteInputTokens),
    inputTokens: reportedTokenCount(input.sums.inputTokens),
    outputTokens: reportedTokenCount(input.sums.outputTokens),
    reasoningTokens: reportedTokenCount(input.sums.reasoningTokens),
    totalTokens: reportedTokenCount(input.sums.totalTokens),
    lastUsedAt: serializeAdminDate(input.lastUsedAt),
    runCount: input.count,
    incompleteUsageCount: input.incompleteUsageCount
  };
}

function sumKnown(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : reportedTokenCount((left ?? 0) + (right ?? 0));
}

function addUsageTotals(left: AdminUsageTokenTotals, right: AdminUsageTokenTotals): AdminUsageTokenTotals {
  const lastUsedAt =
    left.lastUsedAt && right.lastUsedAt
      ? new Date(left.lastUsedAt).getTime() >= new Date(right.lastUsedAt).getTime()
        ? left.lastUsedAt
        : right.lastUsedAt
      : left.lastUsedAt ?? right.lastUsedAt;

  return {
    cachedInputTokens: sumKnown(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteInputTokens: sumKnown(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    inputTokens: sumKnown(left.inputTokens, right.inputTokens),
    lastUsedAt,
    outputTokens: sumKnown(left.outputTokens, right.outputTokens),
    reasoningTokens: sumKnown(left.reasoningTokens, right.reasoningTokens),
    runCount: left.runCount + right.runCount,
    incompleteUsageCount: left.incompleteUsageCount + right.incompleteUsageCount,
    totalTokens: sumKnown(left.totalTokens, right.totalTokens)
  };
}

function compareUsageTotals(left: AdminUsageTokenTotals, right: AdminUsageTokenTotals): number {
  return (
    (right.totalTokens ?? 0) - (left.totalTokens ?? 0) ||
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
        incompleteUsageCount: row.incompleteUsageCount,
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
        incompleteUsageCount: row.incompleteUsageCount,
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

      if (userTotals.lastUsedAt !== null) {
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
