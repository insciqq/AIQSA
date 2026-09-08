"use client";

import { activeDraftGroupIds } from "@/components/admin/adminDraftGroups";
import { adminActionErrorMessage } from "@/components/admin/adminApi";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminActionRequest, AdminDashboard, AdminGroupGrantChange, AdminUserRecord } from "@/lib/contracts/admin";
import { useCallback, useMemo } from "react";

export type UseAdminUsersControllerOptions = Readonly<{
  actionsDisabled: boolean;
  adminUserId: string;
  dashboard: Pick<AdminDashboard, "groups"> | null;
  requestConfirmedAction: AdminConfirmationController["requestConfirmedAction"];
  runAction: AdminRunAction;
}>;

export type AdminUserActionTarget = Pick<AdminUserRecord, "displayName" | "email" | "id">;
export type AdminUserAccessResult = { ok: true } | { message: string; ok: false };

export type AdminUsersController = Readonly<{
  actions: Readonly<{
    /** Approve with groups in one client action: `set_user_groups` (when any) then `approve_user`. */
    approve(user: AdminUserActionTarget, groupIds: readonly string[], expectedGroupIds: readonly string[]): Promise<boolean>;
    requestDelete(user: AdminUserActionTarget, onSuccess?: () => void): void;
    requestDisable(user: AdminUserActionTarget): void;
    requestReject(user: AdminUserActionTarget): void;
    requestRevokeAllSessions(): void;
    requestRevokeSessions(user: AdminUserActionTarget): void;
    saveGroups(user: AdminUserActionTarget, groupIds: readonly string[], expectedGroupIds: readonly string[]): Promise<boolean>;
    saveGrants(user: Pick<AdminUserRecord, "id" | "directGrants">, changes: readonly AdminGroupGrantChange[]): Promise<AdminUserAccessResult>;
    saveCredential(user: AdminUserActionTarget, input: Omit<Extract<AdminActionRequest, { action: "set_user_credential" }>, "action" | "userId">): Promise<AdminUserAccessResult>;
  }>;
  actionsDisabled: boolean;
  adminUserId: string;
}>;

function userLabel(user: AdminUserActionTarget): string {
  return user.email ?? user.displayName;
}

/**
 * Mutations of the Users page: approval, membership, session and account
 * lifecycle actions. Selection lives in the URL (`?resource=`), list and form
 * state in the components; this hook owns only the server calls and the
 * confirmations they need.
 */
export function useAdminUsersController({
  actionsDisabled,
  adminUserId,
  dashboard,
  requestConfirmedAction,
  runAction
}: UseAdminUsersControllerOptions): AdminUsersController {
  const groups = dashboard?.groups;

  const approve = useCallback(async (user: AdminUserActionTarget, groupIds: readonly string[], expectedGroupIds: readonly string[]) => {
    const activeIds = activeDraftGroupIds(groups ?? [], groupIds);
    if (activeIds.length) {
      const memberships = await runAction(
        { action: "set_user_groups", expectedGroupIds: [...expectedGroupIds], groupIds: activeIds, userId: user.id },
        "User groups saved.",
        { reload: false, successNotice: false }
      );
      if (memberships.error) return false;
    }
    const result = await runAction(
      { action: "approve_user", groupIds: activeIds, userId: user.id },
      activeIds.length ? "User approved and added to the group." : "User approved."
    );
    return !result.error;
  }, [groups, runAction]);

  const saveGroups = useCallback(async (user: AdminUserActionTarget, groupIds: readonly string[], expectedGroupIds: readonly string[]) => {
    const result = await runAction(
      { action: "set_user_groups", expectedGroupIds: [...expectedGroupIds], groupIds: activeDraftGroupIds(groups ?? [], groupIds), userId: user.id },
      "User groups saved."
    );
    return !result.error;
  }, [groups, runAction]);

  const requestDelete = useCallback((user: AdminUserActionTarget, onSuccess?: () => void) => {
    requestConfirmedAction({
      body: { action: "delete_user", userId: user.id },
      confirmLabel: "Delete user",
      dialogLabel: `Delete ${userLabel(user)}`,
      icon: "trash",
      message: "Account deletion accepted.",
      onSuccess,
      prompt: `Delete ${userLabel(user)}? Personal Memory and Knowledge are fenced and durably purged before the stale account and auth records are removed. Shared Project data remains. This cannot be undone.`,
      testId: "admin-confirm-delete-user",
      title: "Delete stale user?"
    });
  }, [requestConfirmedAction]);

  const saveGrants = useCallback<AdminUsersController["actions"]["saveGrants"]>(async (user, changes) => {
    const result = await runAction({
      action: "set_user_grants",
      changes: [...changes],
      expectedGrantIds: user.directGrants.map(({ id }) => id),
      userId: user.id
    }, "Direct access updated. Group access is unchanged.");
    return result.error ? { message: adminActionErrorMessage(result.error), ok: false } : { ok: true };
  }, [runAction]);

  const saveCredential = useCallback<AdminUsersController["actions"]["saveCredential"]>(async (user, input) => {
    const result = await runAction({ action: "set_user_credential", ...input, userId: user.id }, "Direct provider key updated.");
    return result.error ? { message: adminActionErrorMessage(result.error), ok: false } : { ok: true };
  }, [runAction]);

  const requestReject = useCallback((user: AdminUserActionTarget) => {
    requestConfirmedAction({
      body: { action: "reject_user", userId: user.id },
      confirmLabel: "Reject user",
      dialogLabel: `Reject ${userLabel(user)}`,
      message: "User rejected.",
      prompt: `Reject ${userLabel(user)}? This leaves owned data intact and prevents sign-in.`,
      testId: "admin-confirm-reject-user",
      title: "Reject pending user?"
    });
  }, [requestConfirmedAction]);

  const requestRevokeSessions = useCallback((user: AdminUserActionTarget) => {
    requestConfirmedAction({
      body: { action: "revoke_user_sessions", userId: user.id },
      confirmLabel: "Revoke sessions",
      dialogLabel: `Revoke sessions for ${userLabel(user)}`,
      icon: "x",
      message: "User sessions revoked.",
      prompt: `Revoke active sessions for ${userLabel(user)}? They will need to sign in again.`,
      testId: "admin-confirm-revoke-user-sessions",
      title: "Revoke user sessions?",
      tone: "warning"
    });
  }, [requestConfirmedAction]);

  const requestDisable = useCallback((user: AdminUserActionTarget) => {
    requestConfirmedAction({
      body: { action: "disable_user", userId: user.id },
      confirmLabel: "Disable user",
      dialogLabel: `Disable ${userLabel(user)}`,
      message: "User disabled.",
      prompt: `Disable ${userLabel(user)}? Existing sessions are revoked and future sign-in is blocked.`,
      testId: "admin-confirm-disable-user",
      title: "Disable active user?"
    });
  }, [requestConfirmedAction]);

  const requestRevokeAllSessions = useCallback(() => {
    requestConfirmedAction({
      body: { action: "revoke_all_sessions" },
      confirmLabel: "Revoke all sessions",
      dialogLabel: "Revoke all sessions",
      icon: "x",
      message: "All sessions revoked.",
      prompt: "Revoke every active session, including yours? Everyone will need to sign in again.",
      testId: "admin-confirm-revoke-all-sessions",
      title: "Revoke all sessions?",
      tone: "warning"
    });
  }, [requestConfirmedAction]);

  return useMemo(() => ({
    actions: {
      approve,
      requestDelete,
      requestDisable,
      requestReject,
      requestRevokeAllSessions,
      requestRevokeSessions,
      saveCredential,
      saveGrants,
      saveGroups
    },
    actionsDisabled,
    adminUserId
  }), [
    actionsDisabled,
    adminUserId,
    approve,
    requestDelete,
    requestDisable,
    requestReject,
    requestRevokeAllSessions,
    requestRevokeSessions,
    saveCredential,
    saveGrants,
    saveGroups
  ]);
}
