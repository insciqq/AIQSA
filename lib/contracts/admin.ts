import type {
  AdminAuthErrorCode,
  ErrorResponse,
  MutationOriginErrorCode
} from "./http";

export type AdminAccessRuleKind = "domain" | "email";

export type AdminMembership = {
  groupId: string;
  name: string;
  role: string;
};

export type AdminAccessGrantRecord = {
  enabled: boolean;
  groupId: string | null;
  id: string;
  modelId: string | null;
  provider: string | null;
  searchStrategy: string | null;
  userId: string | null;
};

export type AdminEntitlementSummary = {
  models: {
    modelId: string;
    provider: string;
  }[];
  providers: string[];
  searchStrategies: string[];
};

export type AdminDeletionBlockReason =
  | "active_user"
  | "group_has_grants"
  | "group_has_members"
  | "invite_accepted"
  | "invite_open"
  | "system_group_forbidden"
  | "user_has_owned_data";

export type AdminDeletionInfo = {
  canDelete: boolean;
  reason: AdminDeletionBlockReason | null;
  summary: string;
};

export type AdminGroup = {
  accessGrants: AdminAccessGrantRecord[];
  archivedAt: string | null;
  deletion?: AdminDeletionInfo;
  id: string;
  name: string;
  systemRole: "full_access" | null;
  userCount: number;
};

export type AdminUserRecord = {
  deletion?: AdminDeletionInfo;
  displayName: string;
  email: string | null;
  effectiveEntitlements: AdminEntitlementSummary;
  groups: AdminMembership[];
  hasVerifiedIdentity: boolean;
  id: string;
  lastSessionAt: string | null;
  role: "admin" | "user";
  status: "active" | "denied" | "disabled" | "pending";
};

export type AdminAccessRuleRecord = {
  defaultGroups: AdminMembership[];
  enabled: boolean;
  id: string;
  kind: AdminAccessRuleKind;
  value: string;
};

export type AdminInviteRecord = {
  acceptedAt: string | null;
  deletion?: AdminDeletionInfo;
  defaultGroups: AdminMembership[];
  email: string;
  expiresAt: string;
  id: string;
  normalizedEmail: string;
  revokedAt: string | null;
};

export type AdminInviteEmailDelivery = "failed" | "not_requested" | "sent" | "unavailable";

export type AdminUsageTokenTotals = {
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  inputTokens: number;
  lastUsedAt: string | null;
  outputTokens: number;
  reasoningTokens: number;
  runCount: number;
  totalTokens: number;
};

export type AdminUsageProviderModelRecord = AdminUsageTokenTotals & {
  modelId: string;
  provider: string;
};

export type AdminUsageUserRecord = AdminUsageTokenTotals & {
  displayName: string;
  email: string | null;
  groups: AdminMembership[];
  providerModels: AdminUsageProviderModelRecord[];
  userId: string;
};

export type AdminUsageGroupRecord = AdminUsageTokenTotals & {
  archivedAt: string | null;
  contributingUsers: number;
  groupId: string;
  name: string;
  userCount: number;
};

export type AdminUsageDashboard = {
  byGroup: AdminUsageGroupRecord[];
  byUser: AdminUsageUserRecord[];
  totals: AdminUsageTokenTotals;
};

export type AdminCatalog = {
  models: {
    displayName: string;
    modelClass?: "answer" | "embedding";
    modelId: string;
    provider: string;
    providerFamily?: string;
    upstreamModelId?: string;
  }[];
  providers: {
    id: string;
    name: string;
  }[];
  searchStrategies: {
    displayName: string;
    strategyId: string;
  }[];
};

export type AdminDashboardNavigation = {
  advancedConfigured: boolean;
  attention: {
    activeUsersWithoutModelAccess: number;
    openInvites: number;
    pendingUsers: number;
  };
  teamConfigured: boolean;
};

export type AdminDashboard = {
  accessRules: AdminAccessRuleRecord[];
  catalog: AdminCatalog;
  groups: AdminGroup[];
  invites: AdminInviteRecord[];
  navigation: AdminDashboardNavigation;
  usage: AdminUsageDashboard;
  users: AdminUserRecord[];
};

export type AdminActionRequest =
  | {
      action: "approve_user";
      groupIds: string[];
      userId: string;
    }
  | {
      action: "archive_group";
      groupId: string;
    }
  | {
      action: "create_access_rule";
      groupIds: string[];
      kind: AdminAccessRuleKind;
      value: string;
    }
  | {
      action: "create_group";
      name: string;
    }
  | {
      action: "create_invite";
      email: string;
      groupIds: string[];
      sendEmail: boolean;
    }
  | {
      action: "delete_access_rule";
      ruleId: string;
    }
  | {
      action: "delete_group";
      groupId: string;
    }
  | {
      action: "delete_invite";
      inviteId: string;
    }
  | {
      action: "delete_user";
      userId: string;
    }
  | {
      action: "disable_user" | "reject_user" | "revoke_user_sessions";
      userId: string;
    }
  | {
      action: "revoke_all_sessions";
    }
  | {
      action: "revoke_invite";
      inviteId: string;
    }
  | {
      action: "rename_group";
      groupId: string;
      name: string;
    }
  | {
      action: "set_group_grant";
      enabled: boolean;
      groupId: string;
      modelId?: string | null;
      provider?: string | null;
      searchStrategy?: string | null;
    }
  | {
      action: "set_user_groups";
      groupIds: string[];
      userId: string;
    };

export const adminActionNames = [
  "approve_user",
  "archive_group",
  "create_access_rule",
  "create_group",
  "create_invite",
  "delete_access_rule",
  "delete_group",
  "delete_invite",
  "delete_user",
  "disable_user",
  "reject_user",
  "revoke_all_sessions",
  "revoke_invite",
  "revoke_user_sessions",
  "rename_group",
  "set_group_grant",
  "set_user_groups"
] as const satisfies readonly AdminActionRequest["action"][];

export type AdminActionName = (typeof adminActionNames)[number];

type AdminActionDomainErrorCode =
  | "access_rule_invalid"
  | "access_rule_not_found"
  | "access_rule_required"
  | "action_required"
  | "action_unknown"
  | "email_invalid"
  | "email_required"
  | "group_grant_invalid"
  | "group_grant_required"
  | "group_has_grants"
  | "group_has_members"
  | "group_invalid"
  | "group_not_found"
  | "group_required"
  | "system_group_forbidden"
  | "invite_accepted"
  | "invite_email_delivery_invalid"
  | "invite_not_found"
  | "invite_open"
  | "invite_required"
  | "json_required"
  | "last_admin_forbidden"
  | "self_disable_forbidden"
  | "self_delete_forbidden"
  | "user_active"
  | "user_has_owned_data"
  | "user_not_found"
  | "user_not_verified"
  | "user_required";

export type AdminActionServerErrorCode =
  | AdminActionDomainErrorCode
  | AdminAuthErrorCode
  | MutationOriginErrorCode;

export type AdminActionSuccessResponse =
  | { ok: true }
  | { revoked: number }
  | { group: AdminGroup }
  | { rule: AdminAccessRuleRecord }
  | { emailDelivery: AdminInviteEmailDelivery; invite: AdminInviteRecord; inviteUrl: string };

export type AdminActionErrorResponse = ErrorResponse<AdminActionServerErrorCode>;

export type AdminActionResponse = AdminActionSuccessResponse | AdminActionErrorResponse;

export type AdminDashboardServerErrorCode = AdminAuthErrorCode;

export type AdminDashboardErrorResponse = ErrorResponse<AdminDashboardServerErrorCode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isAdminDashboard(value: unknown): value is AdminDashboard {
  const catalog = isRecord(value) && isRecord(value.catalog) ? value.catalog : null;
  const navigation = isRecord(value) && isRecord(value.navigation) ? value.navigation : null;
  const attention = navigation && isRecord(navigation.attention) ? navigation.attention : null;

  return Boolean(
    isRecord(value) &&
      Array.isArray(value.accessRules) &&
      catalog &&
      Array.isArray(catalog.models) &&
      Array.isArray(catalog.providers) &&
      Array.isArray(catalog.searchStrategies) &&
      Array.isArray(value.groups) &&
      Array.isArray(value.invites) &&
      navigation &&
      typeof navigation.advancedConfigured === "boolean" &&
      attention &&
      isNonNegativeInteger(attention.activeUsersWithoutModelAccess) &&
      isNonNegativeInteger(attention.openInvites) &&
      isNonNegativeInteger(attention.pendingUsers) &&
      typeof navigation.teamConfigured === "boolean" &&
      isRecord(value.usage) &&
      Array.isArray(value.usage.byGroup) &&
      Array.isArray(value.usage.byUser) &&
      "totals" in value.usage &&
      Array.isArray(value.users)
  );
}
