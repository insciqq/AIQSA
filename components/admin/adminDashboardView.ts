import { activeGroups } from "@/components/admin/adminGroupView";
import { isInviteExpiringSoon, isInviteOpen } from "@/components/admin/adminInviteView";
import { hasEntitlements } from "@/components/admin/adminUserView";
import type { AdminDashboard, AdminInviteRecord, AdminUserRecord } from "@/lib/contracts/admin";

export type AdminDashboardOverview = Readonly<{
  acceptedInvites: number;
  accessRules: number;
  activeGroups: number;
  activeUsers: number;
  hasAttention: boolean;
  inactiveUsers: number;
  noAccessUsers: AdminUserRecord[];
  openInvites: AdminInviteRecord[];
  pendingUsers: AdminUserRecord[];
  revokedInvites: number;
  soonExpiringInvites: AdminInviteRecord[];
  totalGroups: number;
  totalInvites: number;
  totalUsers: number;
}>;

export function deriveAdminDashboardOverview(
  dashboard: AdminDashboard | null,
  nowMs: number
): AdminDashboardOverview {
  const users = dashboard?.users ?? [];
  const groups = dashboard?.groups ?? [];
  const invites = dashboard?.invites ?? [];
  const accessRules = dashboard?.accessRules ?? [];
  const activeUsers = users.filter((user) => user.status === "active");
  const pendingUsers = users.filter((user) => user.status === "pending");
  const noAccessUsers = activeUsers.filter((user) => !hasEntitlements(user.effectiveEntitlements));
  const openInvites = invites.filter((invite) => isInviteOpen(invite, nowMs));
  const soonExpiringInvites = invites.filter((invite) => isInviteExpiringSoon(invite, nowMs));

  return {
    acceptedInvites: invites.filter((invite) => Boolean(invite.acceptedAt)).length,
    accessRules: accessRules.length,
    activeGroups: activeGroups(groups).length,
    activeUsers: activeUsers.length,
    hasAttention: Boolean(pendingUsers.length || noAccessUsers.length || openInvites.length),
    inactiveUsers: users.filter((user) => user.status === "disabled" || user.status === "denied").length,
    noAccessUsers,
    openInvites,
    pendingUsers,
    revokedInvites: invites.filter((invite) => Boolean(invite.revokedAt)).length,
    soonExpiringInvites,
    totalGroups: groups.length,
    totalInvites: invites.length,
    totalUsers: users.length
  };
}
