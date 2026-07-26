import type {
  AdminAccessGrantRecord,
  AdminAccessRuleKind,
  AdminAccessRuleRecord,
  AdminCatalog,
  AdminEntitlementSummary
} from "@/lib/contracts/admin";
import {
  adminGroupDeletionInfo,
  adminInviteDeletionInfo,
  type AdminGroupDeletionSource,
  type AdminInviteDeletionSource
} from "@/lib/server/auth/adminDeletionMetadata";
import type {
  AdminGroupRecord,
  AdminInviteRecord
} from "@/lib/server/auth/adminRepositoryContract";
import {
  serializeAdminDate,
  serializeAdminMemberships,
  type AdminGroupNameLookup,
  type AdminMembershipSource
} from "@/lib/server/auth/adminSerializationPrimitives";
import { resolveEntitlements } from "@/lib/server/auth/entitlements";

export type AdminAccessRuleSource = Readonly<{
  defaultGroups: readonly AdminMembershipSource[];
  enabled: boolean;
  id: string;
  kind: AdminAccessRuleKind;
  value: string;
}>;

export type AdminInviteSource = AdminInviteDeletionSource &
  Readonly<{
    defaultGroups: readonly AdminMembershipSource[];
    email: string;
    id: string;
    normalizedEmail: string;
  }>;

export type AdminGrantSource = Readonly<{
  enabled: boolean;
  groupId: string | null;
  id: string;
  providerConnectionId: string | null;
  providerModel: { connectionId: string } | null;
  providerModelId: string | null;
  searchStrategy: string | null;
  userId: string | null;
}>;

export type AdminGroupSource = AdminGroupDeletionSource &
  Readonly<{
    accessGrants: readonly AdminGrantSource[];
    archivedAt: Date | null;
    id: string;
    name: string;
    systemRole: "full_access" | null;
  }>;

export type AdminEntitlementSource = Readonly<{
  catalog: Pick<AdminCatalog, "models" | "providers" | "searchStrategies">;
  fullAccess: boolean;
  grants: readonly AdminGrantSource[];
  groupIds: readonly string[];
  userId: string;
}>;

export type AdminSessionActivitySource = Readonly<{
  createdAt: Date;
  lastSeenAt: Date | null;
}>;

export function serializeAdminRule(
  rule: AdminAccessRuleSource,
  groupNamesById?: AdminGroupNameLookup
): AdminAccessRuleRecord {
  return {
    defaultGroups: serializeAdminMemberships(rule.defaultGroups, groupNamesById),
    enabled: rule.enabled,
    id: rule.id,
    kind: rule.kind,
    value: rule.value
  };
}

export function serializeAdminInvite(
  invite: AdminInviteSource,
  groupNamesById?: AdminGroupNameLookup,
  now = new Date()
): AdminInviteRecord {
  return {
    acceptedAt: serializeAdminDate(invite.acceptedAt),
    deletion: adminInviteDeletionInfo(invite, now),
    defaultGroups: serializeAdminMemberships(invite.defaultGroups, groupNamesById),
    email: invite.email,
    expiresAt: invite.expiresAt.toISOString(),
    id: invite.id,
    normalizedEmail: invite.normalizedEmail,
    revokedAt: serializeAdminDate(invite.revokedAt)
  };
}

export function serializeAdminGrant(grant: AdminGrantSource): AdminAccessGrantRecord {
  return {
    enabled: grant.enabled,
    groupId: grant.groupId,
    id: grant.id,
    modelId: grant.providerModelId,
    provider: grant.providerConnectionId ?? grant.providerModel?.connectionId ?? null,
    searchStrategy: grant.searchStrategy,
    userId: grant.userId
  };
}

export function serializeAdminGroup(group: AdminGroupSource): AdminGroupRecord {
  return {
    accessGrants: group.accessGrants.map(serializeAdminGrant),
    archivedAt: serializeAdminDate(group.archivedAt),
    deletion: adminGroupDeletionInfo(group),
    id: group.id,
    name: group.name,
    systemRole: group.systemRole,
    userCount: group._count.users
  };
}

export function serializeAdminEntitlements(input: AdminEntitlementSource): AdminEntitlementSummary {
  const entitlements = resolveEntitlements(
    input.userId,
    [...input.groupIds],
    input.grants.map((grant) => ({
      ...grant,
      providerModelConnectionId: grant.providerModel?.connectionId ?? null
    })),
    { fullAccess: input.fullAccess }
  );

  if (entitlements.fullAccess) {
    const models = new Map(
      input.catalog.models.map((model) => [
        `${model.provider}:${model.modelId}`,
        { modelId: model.modelId, provider: model.provider }
      ])
    );

    return {
      models: [...models.values()].sort((left, right) =>
        left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId)
      ),
      providers: [...new Set(input.catalog.providers.map((provider) => provider.id))].sort(),
      searchStrategies: [
        ...new Set(input.catalog.searchStrategies.map((strategy) => strategy.strategyId))
      ].sort()
    };
  }

  return {
    models: Array.from(entitlements.modelKeys)
      .sort()
      .map((key) => {
        const separator = key.indexOf(":");

        return {
          modelId: key.slice(separator + 1),
          provider: key.slice(0, separator)
        };
      }),
    providers: Array.from(entitlements.providerKeys).sort(),
    searchStrategies: Array.from(entitlements.searchStrategies).sort()
  };
}

export function serializeAdminLastSession(sessions: readonly AdminSessionActivitySource[]): string | null {
  const dates = sessions.map((session) => session.lastSeenAt ?? session.createdAt);
  const latest = dates.sort((left, right) => right.getTime() - left.getTime())[0];

  return serializeAdminDate(latest);
}

export function adminProviderName(provider: string): string {
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    fake: "Fake",
    openai: "OpenAI",
    openrouter: "OpenRouter"
  };

  return names[provider] ?? provider;
}
