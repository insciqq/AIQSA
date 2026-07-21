"use client";

import type {
  AdminUsersFocus,
  AdminUsersSectionProps
} from "@/components/admin/AdminUsersSection";
import { activeDraftGroupIds } from "@/components/admin/adminDraftGroups";
import {
  activeGroupIdsForUser,
  deriveAdminUsersView,
  type AdminUserSortKey,
  type AdminUserStatusFilter
} from "@/components/admin/adminUserView";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminDashboard, AdminUserRecord } from "@/lib/contracts/admin";
import { useCallback, useMemo, useState } from "react";

const usersPageSize = 25;

export type UseAdminUsersControllerOptions = Readonly<{
  actionsDisabled: boolean;
  adminUserId: string;
  dashboard: AdminDashboard | null;
  focus: AdminUsersFocus;
  requestConfirmedAction: AdminConfirmationController["requestConfirmedAction"];
  requestFocus(target: "user-detail" | "user-groups"): void;
  runAction: AdminRunAction;
}>;

export type AdminUsersController = Readonly<{
  sectionProps: AdminUsersSectionProps | null;
}>;

export function useAdminUsersController({
  actionsDisabled,
  adminUserId,
  dashboard,
  focus,
  requestConfirmedAction,
  requestFocus,
  runAction
}: UseAdminUsersControllerOptions): AdminUsersController {
  const [pageIndex, setPageIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [requestedSelectedUserId, setRequestedSelectedUserId] = useState<string | null>(null);
  const [selectedGroupIdsByUser, setSelectedGroupIdsByUser] = useState<Record<string, string[]>>({});
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [sortKey, setSortKey] = useState<AdminUserSortKey>("user");
  const [statusFilter, setStatusFilter] = useState<AdminUserStatusFilter>("all");

  const viewModel = useMemo(
    () =>
      deriveAdminUsersView({
        pageIndex,
        pageSize: usersPageSize,
        query,
        selectedUserId: requestedSelectedUserId,
        sortDirection,
        sortKey,
        statusFilter,
        users: dashboard?.users ?? []
      }),
    [dashboard?.users, pageIndex, query, requestedSelectedUserId, sortDirection, sortKey, statusFilter]
  );

  const selectUser = useCallback(
    (userId: string, target: "user-detail" | "user-groups" = "user-detail") => {
      requestFocus(target);
      setRequestedSelectedUserId(userId);
    },
    [requestFocus]
  );

  const changeQuery = useCallback((value: string) => {
    setQuery(value);
    setPageIndex(0);
  }, []);

  const changeStatusFilter = useCallback((value: AdminUserStatusFilter) => {
    setStatusFilter(value);
    setPageIndex(0);
  }, []);

  const changeSort = useCallback(
    (key: AdminUserSortKey) => {
      setPageIndex(0);
      if (sortKey === key) {
        setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
        return;
      }

      setSortKey(key);
      setSortDirection("asc");
    },
    [sortKey]
  );

  const approveUser = useCallback(
    async (user: AdminUserRecord) => {
      await runAction(
        {
          action: "approve_user",
          groupIds: activeDraftGroupIds(dashboard?.groups ?? [], selectedGroupIdsByUser[user.id] ?? []),
          userId: user.id
        },
        "User approved."
      );
    },
    [dashboard?.groups, runAction, selectedGroupIdsByUser]
  );

  const saveUserGroups = useCallback(
    async (user: AdminUserRecord) => {
      await runAction(
        {
          action: "set_user_groups",
          groupIds: activeDraftGroupIds(
            dashboard?.groups ?? [],
            selectedGroupIdsByUser[user.id] ?? activeGroupIdsForUser(user, dashboard?.groups ?? [])
          ),
          userId: user.id
        },
        "User groups saved."
      );
    },
    [dashboard?.groups, runAction, selectedGroupIdsByUser]
  );

  const requestDeleteUser = useCallback(
    (user: AdminUserRecord) => {
      requestConfirmedAction({
        body: {
          action: "delete_user",
          userId: user.id
        },
        confirmLabel: "Delete user",
        dialogLabel: `Delete ${user.email ?? user.displayName}`,
        icon: "trash",
        message: "User deleted.",
        onSuccess: () => setRequestedSelectedUserId(null),
        prompt: `Delete ${user.email ?? user.displayName}? This permanently removes the stale account shell and auth records. This cannot delete users with app-owned data.`,
        testId: "admin-confirm-delete-user",
        title: "Delete stale user?"
      });
    },
    [requestConfirmedAction]
  );

  const requestRejectUser = useCallback(
    (user: AdminUserRecord) => {
      requestConfirmedAction({
        body: {
          action: "reject_user",
          userId: user.id
        },
        confirmLabel: "Reject user",
        dialogLabel: `Reject ${user.email ?? user.displayName}`,
        message: "User rejected.",
        prompt: `Reject ${user.email ?? user.displayName}? This leaves owned data intact and prevents sign-in.`,
        testId: "admin-confirm-reject-user",
        title: "Reject pending user?"
      });
    },
    [requestConfirmedAction]
  );

  const requestRevokeUserSessions = useCallback(
    (user: AdminUserRecord) => {
      requestConfirmedAction({
        body: {
          action: "revoke_user_sessions",
          userId: user.id
        },
        confirmLabel: "Revoke sessions",
        dialogLabel: `Revoke sessions for ${user.email ?? user.displayName}`,
        icon: "x",
        message: "User sessions revoked.",
        prompt: `Revoke active sessions for ${user.email ?? user.displayName}? They will need to sign in again.`,
        testId: "admin-confirm-revoke-user-sessions",
        title: "Revoke user sessions?",
        tone: "warning"
      });
    },
    [requestConfirmedAction]
  );

  const requestDisableUser = useCallback(
    (user: AdminUserRecord) => {
      requestConfirmedAction({
        body: {
          action: "disable_user",
          userId: user.id
        },
        confirmLabel: "Disable user",
        dialogLabel: `Disable ${user.email ?? user.displayName}`,
        message: "User disabled.",
        prompt: `Disable ${user.email ?? user.displayName}? Existing sessions are revoked and future sign-in is blocked.`,
        testId: "admin-confirm-disable-user",
        title: "Disable active user?"
      });
    },
    [requestConfirmedAction]
  );

  const selectedUserGroupIds = useMemo(() => {
    const selectedUser = viewModel.selectedUser;
    if (!selectedUser) {
      return [];
    }

    const draft =
      selectedGroupIdsByUser[selectedUser.id] ??
      (selectedUser.status === "pending" ? [] : activeGroupIdsForUser(selectedUser, dashboard?.groups ?? []));

    return activeDraftGroupIds(dashboard?.groups ?? [], draft);
  }, [dashboard?.groups, selectedGroupIdsByUser, viewModel.selectedUser]);

  const sectionProps = useMemo<AdminUsersSectionProps | null>(() => {
    if (!dashboard) {
      return null;
    }

    return {
      actions: {
        onApprove: (user) => void approveUser(user),
        onEditUserGroups: (userId) => selectUser(userId, "user-groups"),
        onNextPage: () => setPageIndex((current) => Math.min(viewModel.pageCount - 1, current + 1)),
        onPreviousPage: () => setPageIndex((current) => Math.max(0, current - 1)),
        onQueryChange: changeQuery,
        onRequestDelete: requestDeleteUser,
        onRequestDisable: requestDisableUser,
        onRequestReject: requestRejectUser,
        onRequestRevokeSessions: requestRevokeUserSessions,
        onSaveGroups: (user) => void saveUserGroups(user),
        onSelectUser: selectUser,
        onSelectedUserGroupsChange: (userId, groupIds) =>
          setSelectedGroupIdsByUser((current) => ({
            ...current,
            [userId]: groupIds
          })),
        onSort: changeSort,
        onStatusFilterChange: changeStatusFilter
      },
      data: {
        adminUserId,
        catalog: dashboard.catalog,
        groups: dashboard.groups,
        pageUsers: viewModel.pageUsers,
        selectedUser: viewModel.selectedUser,
        selectedUserGroupIds,
        totalUserCount: dashboard.users.length
      },
      focus,
      status: {
        actionsDisabled
      },
      view: {
        filteredCount: viewModel.filteredUsers.length,
        pageCount: viewModel.pageCount,
        pageEnd: viewModel.pageEnd,
        pageIndex: viewModel.pageIndex,
        pageStart: viewModel.pageStart,
        query,
        sortDirection,
        sortKey,
        statusFilter
      }
    };
  }, [
    actionsDisabled,
    adminUserId,
    approveUser,
    changeQuery,
    changeSort,
    changeStatusFilter,
    dashboard,
    focus,
    requestDeleteUser,
    requestDisableUser,
    requestRejectUser,
    requestRevokeUserSessions,
    saveUserGroups,
    selectUser,
    selectedUserGroupIds,
    sortDirection,
    sortKey,
    statusFilter,
    query,
    viewModel
  ]);

  return useMemo(
    () => ({
      sectionProps
    }),
    [sectionProps]
  );
}
