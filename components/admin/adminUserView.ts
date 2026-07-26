import { groupLabel } from "@/components/admin/adminViewUtils";
import type {
  AdminDeletionInfo,
  AdminEntitlementSummary,
  AdminGroup,
  AdminUserRecord
} from "@/lib/contracts/admin";

export type AdminSortDirection = "asc" | "desc";
export type AdminUserSortKey = "access" | "groups" | "lastSession" | "role" | "status" | "user";
export type AdminUserStatusFilter = AdminUserRecord["status"] | "all";

export type AdminUsersViewInput = Readonly<{
  pageIndex: number;
  pageSize: number;
  query: string;
  selectedUserId: string | null;
  sortDirection: AdminSortDirection;
  sortKey: AdminUserSortKey;
  statusFilter: AdminUserStatusFilter;
  users: readonly AdminUserRecord[];
}>;

export type AdminUsersViewModel = Readonly<{
  filteredUsers: AdminUserRecord[];
  pageCount: number;
  pageEnd: number;
  pageIndex: number;
  pageStart: number;
  pageUsers: AdminUserRecord[];
  selectedUser: AdminUserRecord | null;
}>;

export function activeGroupIdsForUser(user: AdminUserRecord, groups: AdminGroup[]): string[] {
  const activeIds = new Set(groups.filter((group) => !group.archivedAt).map((group) => group.id));

  return user.groups.filter((group) => activeIds.has(group.groupId)).map((group) => group.groupId);
}

export function hasEntitlements(entitlements: AdminEntitlementSummary): boolean {
  return Boolean(entitlements.providers.length || entitlements.models.length || entitlements.searchStrategies.length);
}

export function entitlementCountLabel(entitlements: AdminEntitlementSummary): string {
  if (!hasEntitlements(entitlements)) {
    return "No access";
  }

  const parts = [
    entitlements.providers.length ? `${entitlements.providers.length} provider` : null,
    entitlements.models.length ? `${entitlements.models.length} model` : null,
    entitlements.searchStrategies.length ? `${entitlements.searchStrategies.length} search` : null
  ].filter(Boolean);

  return parts.join(" / ");
}

function entitlementScore(entitlements: AdminEntitlementSummary): number {
  return entitlements.providers.length + entitlements.models.length + entitlements.searchStrategies.length;
}

export function sortValueForUser(user: AdminUserRecord, key: AdminUserSortKey): number | string {
  if (key === "access") {
    return entitlementScore(user.effectiveEntitlements);
  }

  if (key === "groups") {
    return groupLabel(user.groups).toLowerCase();
  }

  if (key === "lastSession") {
    return user.lastSessionAt ? new Date(user.lastSessionAt).getTime() : 0;
  }

  if (key === "role") {
    return user.role;
  }

  if (key === "status") {
    return user.status;
  }

  return `${user.displayName} ${user.email ?? ""}`.toLowerCase();
}

export function deriveAdminUsersView(input: AdminUsersViewInput): AdminUsersViewModel {
  const query = input.query.trim().toLowerCase();
  const direction = input.sortDirection === "asc" ? 1 : -1;
  const filteredUsers = [...input.users]
    .filter((user) => {
      const matchesStatus = input.statusFilter === "all" || user.status === input.statusFilter;
      const haystack = [
        user.displayName,
        user.email ?? "",
        user.role,
        user.status,
        ...user.groups.map((group) => group.name)
      ]
        .join(" ")
        .toLowerCase();

      return matchesStatus && (!query || haystack.includes(query));
    })
    .sort((first, second) => {
      const firstValue = sortValueForUser(first, input.sortKey);
      const secondValue = sortValueForUser(second, input.sortKey);

      if (typeof firstValue === "number" && typeof secondValue === "number") {
        return (firstValue - secondValue) * direction;
      }

      return String(firstValue).localeCompare(String(secondValue)) * direction;
    });
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / input.pageSize));
  const pageIndex = Math.min(input.pageIndex, pageCount - 1);
  const pageUsers = filteredUsers.slice(pageIndex * input.pageSize, (pageIndex + 1) * input.pageSize);
  const selectedUser =
    (input.selectedUserId ? pageUsers.find((user) => user.id === input.selectedUserId) : null) ??
    pageUsers[0] ??
    null;

  return {
    filteredUsers,
    pageCount,
    pageEnd: Math.min(filteredUsers.length, (pageIndex + 1) * input.pageSize),
    pageIndex,
    pageStart: filteredUsers.length ? pageIndex * input.pageSize + 1 : 0,
    pageUsers,
    selectedUser
  };
}

export function userStatusClass(status: AdminUserRecord["status"]): string {
  const classes: Record<AdminUserRecord["status"], string> = {
    active: "border-positive/25 bg-positive/10 text-positive",
    denied: "border-critical/25 bg-critical/10 text-critical",
    disabled: "border-trace-subtle bg-control-surface text-ink-secondary",
    pending: "border-caution/25 bg-caution/10 text-caution"
  };

  return classes[status];
}

export function userDeletionInfo(user: AdminUserRecord, adminUserId: string): AdminDeletionInfo {
  if (user.id === adminUserId) {
    return {
      canDelete: false,
      reason: "active_user",
      summary: "Your current admin account cannot delete itself."
    };
  }

  return (
    user.deletion ?? {
      canDelete: user.status !== "active",
      reason: user.status === "active" ? "active_user" : null,
      summary:
        user.status === "active"
          ? "Disable this user before deletion can be considered."
          : "No app-owned records detected; auth request data can be removed."
    }
  );
}
