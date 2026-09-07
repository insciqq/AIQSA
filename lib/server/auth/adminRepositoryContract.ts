import type {
  AdminAccessRuleKind,
  AdminAccessRuleRecord,
  AdminDashboard as AdminDashboardWire,
  AdminDeletionInfo,
  AdminGroup as AdminGroupWire,
  AdminGroupGrantChange,
  AdminInviteRecord as AdminInviteWire,
  AdminUserRecord as AdminUserWire
} from "@/lib/contracts/admin";

export type {
  AdminAccessGrantRecord,
  AdminAccessRuleRecord,
  AdminDashboardNavigation,
  AdminDeletionBlockReason,
  AdminDeletionInfo,
  AdminEntitlementSummary,
  AdminUsageDashboard,
  AdminUsageGroupRecord,
  AdminUsageProviderModelRecord,
  AdminUsageTokenTotals,
  AdminUsageUserRecord
} from "@/lib/contracts/admin";

export type AdminGroupRecord = Omit<AdminGroupWire, "deletion"> & {
  deletion: AdminDeletionInfo;
};

export type AdminUserRecord = Omit<AdminUserWire, "deletion"> & {
  deletion: AdminDeletionInfo;
};

export type AdminInviteRecord = Omit<AdminInviteWire, "deletion"> & {
  deletion: AdminDeletionInfo;
};

export type AdminDeleteUserResult =
  | "deletion_pending"
  | "deleted"
  | "not_found"
  | "self_delete_forbidden"
  | "user_active"
  | "user_has_owned_data";
export type AdminDeleteGroupResult =
  | "deleted"
  | "group_has_grants"
  | "group_has_members"
  | "not_found"
  | "system_group_forbidden";
export type AdminDeleteInviteResult = "deleted" | "invite_accepted" | "invite_open" | "not_found";
export type AdminApproveUserResult = "approved" | "not_found" | "not_verified";
export type AdminDisableUserResult =
  | "disabled"
  | "last_admin_forbidden"
  | "not_found"
  | "self_disable_forbidden";
export type AdminRejectUserResult = "not_found" | "rejected";

export type AdminDashboard = Omit<AdminDashboardWire, "groups" | "invites" | "users"> & {
  groups: AdminGroupRecord[];
  invites: AdminInviteRecord[];
  users: AdminUserRecord[];
};

export type AdminApproveUserInput = {
  groupIds?: string[];
  userId: string;
};

export type AdminCreateAccessRuleInput = {
  createdByUserId: string;
  groupIds?: string[];
  kind: AdminAccessRuleKind;
  value: string;
};

export type AdminCreateInviteInput = {
  createdByUserId: string;
  email: string;
  expiresAt: Date;
  groupIds?: string[];
  tokenHash: string;
};

export type AdminCreateGroupInput = {
  name: string;
};

export type AdminDeleteStaleInviteInput = {
  inviteId: string;
  now: Date;
};

export type AdminDeleteStaleUserInput = {
  actingAdminUserId: string;
  userId: string;
};

export type AdminRevokeUserSessionsInput = {
  revokedByUserId: string;
  userId: string;
};

export type AdminRenameGroupInput = {
  groupId: string;
  name: string;
};

export type AdminSetGroupGrantsInput = {
  changes: readonly AdminGroupGrantChange[];
  groupId: string;
};

/**
 * Outcome of one grant batch. Anything but `applied` means the transaction
 * was rolled back and no grant changed; `invalid_change` names the first
 * change that could not be applied.
 */
export type AdminSetGroupGrantsResult =
  | { kind: "applied" }
  | { kind: "group_archived" }
  | { kind: "group_not_found" }
  | { kind: "system_group_forbidden" }
  | { change: number; kind: "invalid_change" };

export type AdminSetUserGroupsInput = {
  groupIds: string[];
  userId: string;
};

export type AdminActorRecord = Pick<AdminUserWire, "id" | "role" | "status">;

export type AdminRevokeAllSessionsInput = {
  revokedByUserId: string;
};

export type AdminRepository = {
  archiveGroup(groupId: string): Promise<boolean>;
  approveUser(input: AdminApproveUserInput): Promise<AdminApproveUserResult>;
  createAccessRule(input: AdminCreateAccessRuleInput): Promise<AdminAccessRuleRecord | null>;
  createInvite(input: AdminCreateInviteInput): Promise<AdminInviteRecord | null>;
  createGroup(input: AdminCreateGroupInput): Promise<AdminGroupRecord | null>;
  deleteAccessRule(ruleId: string): Promise<boolean>;
  deleteEmptyGroup(groupId: string): Promise<AdminDeleteGroupResult>;
  deleteStaleInvite(input: AdminDeleteStaleInviteInput): Promise<AdminDeleteInviteResult>;
  deleteStaleUser(input: AdminDeleteStaleUserInput): Promise<AdminDeleteUserResult>;
  disableUser(input: AdminRevokeUserSessionsInput): Promise<AdminDisableUserResult>;
  findAdminUser(userId: string): Promise<AdminActorRecord | null>;
  listDashboard(actingAdminUserId: string): Promise<AdminDashboard>;
  rejectUser(input: AdminRevokeUserSessionsInput): Promise<AdminRejectUserResult>;
  renameGroup(input: AdminRenameGroupInput): Promise<AdminGroupRecord | null>;
  revokeAllSessions(input: AdminRevokeAllSessionsInput): Promise<number>;
  revokeInvite(inviteId: string): Promise<boolean>;
  revokeUserSessions(input: AdminRevokeUserSessionsInput): Promise<number>;
  /** Applies every change in one transaction; a rejected change rolls the whole batch back. */
  setGroupGrants(input: AdminSetGroupGrantsInput): Promise<AdminSetGroupGrantsResult>;
  setUserGroups(input: AdminSetUserGroupsInput): Promise<boolean>;
};
