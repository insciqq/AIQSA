"use client";

import { adminActionErrorMessage } from "@/components/admin/adminApi";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { activeGroupIdsForUser } from "@/components/admin/users/usersView";
import type { AdminDashboard, AdminGroup, AdminGroupGrantChange } from "@/lib/contracts/admin";
import { useCallback, useMemo } from "react";

export type UseAdminGroupsControllerOptions = Readonly<{
  actionsDisabled: boolean;
  dashboard: Pick<AdminDashboard, "groups" | "users"> | null;
  requestConfirmedAction: AdminConfirmationController["requestConfirmedAction"];
  runAction: AdminRunAction;
}>;

export type AdminGroupActionTarget = Pick<AdminGroup, "archivedAt" | "id" | "name" | "systemRole">;

export type AdminGroupMutationResult =
  | Readonly<{ groupId: string | null; ok: true }>
  | Readonly<{ message: string; ok: false }>;

export type AdminGroupsController = Readonly<{
  actions: Readonly<{
    /**
     * Applies one batch of grant changes as a single request (`set_group_grants`);
     * a rejected change leaves the group untouched and reports through the toast.
     */
    applyGrants(group: AdminGroupActionTarget, changes: readonly AdminGroupGrantChange[], notice?: string): Promise<boolean>;
    /** The failure message goes back to the sheet, not to a toast. */
    create(name: string): Promise<AdminGroupMutationResult>;
    rename(group: AdminGroupActionTarget, name: string): Promise<AdminGroupMutationResult>;
    requestArchive(group: AdminGroupActionTarget, onSuccess?: () => void): void;
    requestDelete(group: AdminGroupActionTarget, onSuccess?: () => void): void;
    setMembership(group: AdminGroupActionTarget, userId: string, enabled: boolean): Promise<boolean>;
  }>;
  actionsDisabled: boolean;
}>;

function createdGroupId(value: unknown): string | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : null;
}

function builtIn(group: Pick<AdminGroup, "systemRole">): boolean {
  return group.systemRole === "full_access";
}

/**
 * Mutations of the Groups section: create, rename, archive, delete,
 * membership and grant batches. Selection lives in the URL (`?resource=`),
 * list and form state in the components; this hook owns only the server
 * calls and the confirmations the destructive ones need.
 */
export function useAdminGroupsController({
  actionsDisabled,
  dashboard,
  requestConfirmedAction,
  runAction
}: UseAdminGroupsControllerOptions): AdminGroupsController {
  const groups = dashboard?.groups;
  const users = dashboard?.users;

  const create = useCallback(async (name: string): Promise<AdminGroupMutationResult> => {
    const trimmed = name.trim();
    if (!trimmed) return { message: adminActionErrorMessage("group_required"), ok: false };
    const result = await runAction({ action: "create_group", name: trimmed }, "Group created.");
    if (result.error) return { message: adminActionErrorMessage(result.error), ok: false };
    return { groupId: createdGroupId(result.group), ok: true };
  }, [runAction]);

  const rename = useCallback(async (group: AdminGroupActionTarget, name: string): Promise<AdminGroupMutationResult> => {
    if (builtIn(group)) return { message: adminActionErrorMessage("system_group_forbidden"), ok: false };
    const trimmed = name.trim();
    if (!trimmed) return { message: adminActionErrorMessage("group_required"), ok: false };
    const result = await runAction({ action: "rename_group", groupId: group.id, name: trimmed }, "Group renamed.");
    if (result.error) return { message: adminActionErrorMessage(result.error), ok: false };
    return { groupId: group.id, ok: true };
  }, [runAction]);

  const requestArchive = useCallback((group: AdminGroupActionTarget, onSuccess?: () => void) => {
    if (builtIn(group) || group.archivedAt) return;
    requestConfirmedAction({
      body: { action: "archive_group", groupId: group.id },
      confirmLabel: "Archive group",
      dialogLabel: `Archive ${group.name}`,
      message: "Group archived.",
      onSuccess,
      prompt: `Archive ${group.name}? Its grants stop applying to members right away. The group stays visible under Archived.`,
      testId: "admin-confirm-archive-group",
      title: "Archive group?",
      tone: "warning"
    });
  }, [requestConfirmedAction]);

  const requestDelete = useCallback((group: AdminGroupActionTarget, onSuccess?: () => void) => {
    if (builtIn(group)) return;
    requestConfirmedAction({
      body: { action: "delete_group", groupId: group.id },
      confirmLabel: "Delete group",
      dialogLabel: `Delete group ${group.name}`,
      icon: "trash",
      message: "Group deleted.",
      onSuccess,
      prompt: `Delete ${group.name}? This permanently removes the empty group. Groups with members or active grants are blocked.`,
      testId: "admin-confirm-delete-group",
      title: "Delete empty group?"
    });
  }, [requestConfirmedAction]);

  const applyGrants = useCallback(async (
    group: AdminGroupActionTarget,
    changes: readonly AdminGroupGrantChange[],
    notice = "Access updated."
  ) => {
    if (builtIn(group) || group.archivedAt || !changes.length) return false;
    const result = await runAction({ action: "set_group_grants", changes: [...changes], groupId: group.id }, notice);
    return !result.error;
  }, [runAction]);

  const setMembership = useCallback(async (group: AdminGroupActionTarget, userId: string, enabled: boolean) => {
    const user = users?.find((candidate) => candidate.id === userId);
    if (!user || group.archivedAt) return false;
    const currentGroupIds = activeGroupIdsForUser(user, groups ?? []);
    const nextGroupIds = enabled
      ? [...new Set([...currentGroupIds, group.id])]
      : currentGroupIds.filter((groupId) => groupId !== group.id);
    const result = await runAction(
      { action: "set_user_groups", expectedGroupIds: currentGroupIds, groupIds: nextGroupIds, userId },
      enabled ? "Member added." : "Member removed."
    );
    return !result.error;
  }, [groups, runAction, users]);

  return useMemo(() => ({
    actions: { applyGrants, create, rename, requestArchive, requestDelete, setMembership },
    actionsDisabled
  }), [actionsDisabled, applyGrants, create, rename, requestArchive, requestDelete, setMembership]);
}
