import type { AdminDeletionInfo, AdminUserRecord } from "@/lib/contracts/admin";

export type AdminUserDeletionSource = Readonly<{
  ownedDataCount: number;
  status: AdminUserRecord["status"];
}>;

export type AdminGroupDeletionSource = Readonly<{
  _count: Readonly<{
    providerCredentialAssignments?: number;
    users: number;
  }>;
  accessGrants: readonly Readonly<{
    enabled: boolean;
  }>[];
  mcpGrants: readonly Readonly<{
    canUse: boolean;
  }>[];
  systemRole: "full_access" | null;
}>;

export type AdminInviteDeletionSource = Readonly<{
  acceptedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

export type AdminUserOwnedDataSource = Readonly<{
  _count: Readonly<{
    accessGrants: number;
    attachments: number;
    chats: number;
    folders: number;
    mcpGrants: number;
    mcpOAuthConnections: number;
    mcpUserServers: number;
    modelRuns: number;
    promptPresets: number;
    sharedSnapshots: number;
    usageEvents: number;
  }>;
  settings: unknown | null;
}>;

export type AdminOwnedAppDataCounts = Readonly<{
  accessGrants: number;
  attachments: number;
  chats: number;
  folders: number;
  mcpGrants: number;
  mcpOAuthConnections: number;
  mcpUserServers: number;
  modelRuns: number;
  promptPresets: number;
  settings: number;
  sharedSnapshots: number;
  usageEvents: number;
}>;

export type AdminUserDeletionBlock = "user_active" | "user_has_owned_data";
export type AdminGroupDeletionBlock = "group_has_grants" | "group_has_members";
export type AdminInviteDeletionBlock = "invite_accepted" | "invite_open";

export function adminUserDeletionBlock(input: AdminUserDeletionSource): AdminUserDeletionBlock | null {
  if (input.status === "active") {
    return "user_active";
  }

  return input.ownedDataCount > 0 ? "user_has_owned_data" : null;
}

export function adminGroupDeletionBlock(input: {
  activeGrantCount: number;
  memberCount: number;
}): AdminGroupDeletionBlock | null {
  if (input.memberCount > 0) {
    return "group_has_members";
  }

  return input.activeGrantCount > 0 ? "group_has_grants" : null;
}

export function adminInviteDeletionBlock(
  invite: AdminInviteDeletionSource,
  now: Date
): AdminInviteDeletionBlock | null {
  if (invite.acceptedAt) {
    return "invite_accepted";
  }

  return !invite.revokedAt && invite.expiresAt > now ? "invite_open" : null;
}

export function adminUserDeletionInfo(input: AdminUserDeletionSource): AdminDeletionInfo {
  const block = adminUserDeletionBlock(input);

  if (block === "user_active") {
    return {
      canDelete: false,
      reason: "active_user",
      summary: "Disable this user before deletion can be considered."
    };
  }

  if (block === "user_has_owned_data") {
    return {
      canDelete: false,
      reason: "user_has_owned_data",
      summary: `${input.ownedDataCount} owned app record${input.ownedDataCount === 1 ? "" : "s"} keep this account as disabled history.`
    };
  }

  return {
    canDelete: true,
    reason: null,
    summary: "No app-owned records detected; auth request data can be removed."
  };
}

export function adminGroupDeletionInfo(group: AdminGroupDeletionSource): AdminDeletionInfo {
  if (group.systemRole === "full_access") {
    return {
      canDelete: false,
      reason: "system_group_forbidden",
      summary: "Full access is built in and cannot be renamed, archived, or deleted."
    };
  }

  const activeGrantCount =
    group.accessGrants.filter((grant) => grant.enabled).length +
    group.mcpGrants.filter((grant) => grant.canUse).length;
  const credentialAssignmentCount = group._count.providerCredentialAssignments ?? 0;
  const block = adminGroupDeletionBlock({
    activeGrantCount: activeGrantCount + credentialAssignmentCount,
    memberCount: group._count.users
  });

  if (block === "group_has_members") {
    return {
      canDelete: false,
      reason: "group_has_members",
      summary: `Remove ${group._count.users} member${group._count.users === 1 ? "" : "s"} before deleting this group.`
    };
  }

  if (block === "group_has_grants") {
    const accessSummary = [
      activeGrantCount
        ? `${activeGrantCount} active grant${activeGrantCount === 1 ? "" : "s"}`
        : null,
      credentialAssignmentCount
        ? `${credentialAssignmentCount} provider credential assignment${credentialAssignmentCount === 1 ? "" : "s"}`
        : null
    ].filter((part): part is string => Boolean(part)).join(" and ");
    return {
      canDelete: false,
      reason: "group_has_grants",
      summary: `Remove ${accessSummary} before deleting this group.`
    };
  }

  return {
    canDelete: true,
    reason: null,
    summary: "No members, active grants, or provider credential assignments; this group can be deleted."
  };
}

export function adminInviteDeletionInfo(invite: AdminInviteDeletionSource, now: Date): AdminDeletionInfo {
  const block = adminInviteDeletionBlock(invite, now);

  if (block === "invite_accepted") {
    return {
      canDelete: false,
      reason: "invite_accepted",
      summary: "Accepted invites are kept for audit history."
    };
  }

  if (block === "invite_open") {
    return {
      canDelete: false,
      reason: "invite_open",
      summary: "Revoke this open invite before deleting it."
    };
  }

  return {
    canDelete: true,
    reason: null,
    summary: "This stale invite can be deleted."
  };
}

export function adminUserOwnedDataCount(user: AdminUserOwnedDataSource): number {
  return adminOwnedAppDataCount({
    ...user._count,
    settings: user.settings ? 1 : 0
  });
}

export function adminOwnedAppDataCount(counts: AdminOwnedAppDataCounts): number {
  return (
    counts.accessGrants +
    counts.attachments +
    counts.chats +
    counts.folders +
    counts.mcpGrants +
    counts.mcpOAuthConnections +
    counts.mcpUserServers +
    counts.modelRuns +
    counts.promptPresets +
    counts.settings +
    counts.sharedSnapshots +
    counts.usageEvents
  );
}
