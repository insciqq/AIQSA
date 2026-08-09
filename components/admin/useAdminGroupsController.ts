"use client";

import type {
  AdminAccessGroupsSectionProps,
  AdminAccessGroupsSectionRefs,
  AdminAccessGroupView
} from "@/components/admin/AdminAccessGroupsSection";
import {
  filterAdminGroups,
  resolveAdminGroupSelection,
  type AdminGrantTarget,
  type AdminGroupStatusFilter
} from "@/components/admin/adminGroupView";
import { activeGroupIdsForUser } from "@/components/admin/adminUserView";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminDashboardRefresh } from "@/components/admin/useAdminDashboardResource";
import type { AdminFieldErrorController } from "@/components/admin/useAdminFieldErrors";
import type { AdminDashboard, AdminGroup } from "@/lib/contracts/admin";
import { useCallback, useMemo, useState } from "react";

type AdminGroupsFocus = Readonly<{
  groups: AdminAccessGroupsSectionRefs;
}>;

export type UseAdminGroupsControllerOptions = Readonly<{
  actionsDisabled: boolean;
  dashboard: AdminDashboard | null;
  fieldErrors: Pick<AdminFieldErrorController, "clearFieldError" | "fieldError" | "reportFieldError">;
  focus: AdminGroupsFocus;
  onMutationReconciled(): void;
  refreshDashboard: AdminDashboardRefresh;
  reportNotice(message: string): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  requestConfirmedAction: AdminConfirmationController["requestConfirmedAction"];
  requestFocus(target: "group-detail"): void;
  runAction: AdminRunAction;
}>;

export type AdminGroupsController = Readonly<{
  access: Readonly<{
    draftProtection: Readonly<{
      dirty: boolean;
      discard(): void;
    }>;
    sectionProps: AdminAccessGroupsSectionProps | null;
    toggleCreateForm(): void;
  }>;
}>;

export function useAdminGroupsController({
  actionsDisabled,
  dashboard,
  fieldErrors,
  focus,
  onMutationReconciled,
  refreshDashboard,
  reportNotice,
  requestConfirmation,
  requestConfirmedAction,
  requestFocus,
  runAction
}: UseAdminGroupsControllerOptions): AdminGroupsController {
  const { clearFieldError, fieldError, reportFieldError } = fieldErrors;
  const [activeView, setActiveView] = useState<AdminAccessGroupView>("overview");
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  const [groupStatusFilter, setGroupStatusFilter] = useState<AdminGroupStatusFilter>("active");
  const [renameName, setRenameName] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [requestedSelectedGroupId, setRequestedSelectedGroupId] = useState<string | null>(null);

  const visibleGroups = useMemo(
    () =>
      filterAdminGroups(
        dashboard?.groups ?? [],
        dashboard?.catalog ?? { models: [], providers: [], searchStrategies: [] },
        groupQuery,
        groupStatusFilter
      ),
    [dashboard?.catalog, dashboard?.groups, groupQuery, groupStatusFilter]
  );
  const selectedGroup = useMemo(
    () => resolveAdminGroupSelection(dashboard?.groups ?? [], requestedSelectedGroupId),
    [dashboard?.groups, requestedSelectedGroupId]
  );
  const selectedGroupMembers = useMemo(
    () => selectedGroup
      ? (dashboard?.users ?? []).filter((user) =>
          user.groups.some((membership) => membership.groupId === selectedGroup.id)
        )
      : [],
    [dashboard?.users, selectedGroup]
  );
  const draftDirty = createName.length > 0 || Boolean(
    renamingGroupId &&
    selectedGroup?.id === renamingGroupId &&
    renameName !== selectedGroup.name
  );

  const discardDraft = useCallback(() => {
    setCreateName("");
    setCreateFormOpen(false);
    setRenameName("");
    setRenamingGroupId(null);
  }, []);

  const selectGroup = useCallback((groupId: string) => {
    setRequestedSelectedGroupId(groupId);
    setActiveView("overview");
    setCreateFormOpen(false);
    setDetailOpen(true);
    requestFocus("group-detail");
  }, [requestFocus]);

  const closeDetail = useCallback(() => {
    setCreateFormOpen(false);
    setDetailOpen(false);
    setRequestedSelectedGroupId(null);
    setRenamingGroupId(null);
    setActiveView("overview");
  }, []);

  const toggleCreateForm = useCallback(() => {
    clearFieldError("group-name");
    setCreateFormOpen((open) => {
      const nextOpen = !open;
      setDetailOpen(nextOpen);
      if (nextOpen) {
        setRequestedSelectedGroupId(null);
        setRenamingGroupId(null);
      }
      return nextOpen;
    });
  }, [clearFieldError]);

  const changeCreateName = useCallback((value: string) => {
    setCreateName(value);
    clearFieldError("group-name");
  }, [clearFieldError]);

  const changeRenameName = useCallback((value: string) => {
    setRenameName(value);
    clearFieldError("rename-selected-group");
  }, [clearFieldError]);

  const createGroup = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      reportFieldError("group-name", "group_required");
      return;
    }
    clearFieldError("group-name");

    const result = await runAction({ action: "create_group", name }, "Group created.");
    if (!result.error) {
      setCreateName("");
      setCreateFormOpen(false);
      setDetailOpen(false);
    }
  }, [clearFieldError, createName, reportFieldError, runAction]);

  const renameGroup = useCallback(async (group: AdminGroup) => {
    if (group.systemRole === "full_access") return;
    const name = renameName.trim();
    if (!name) {
      reportFieldError("rename-selected-group", "group_required");
      return;
    }
    clearFieldError("rename-selected-group");

    const result = await runAction(
      { action: "rename_group", groupId: group.id, name },
      "Group renamed."
    );
    if (!result.error) {
      setRenameName("");
      setRenamingGroupId(null);
    }
  }, [clearFieldError, renameName, reportFieldError, runAction]);

  const requestDeleteGroup = useCallback((group: AdminGroup) => {
    if (group.systemRole === "full_access") return;
    requestConfirmedAction({
      body: { action: "delete_group", groupId: group.id },
      confirmLabel: "Delete group",
      dialogLabel: `Delete group ${group.name}`,
      icon: "trash",
      message: "Group deleted.",
      onSuccess: closeDetail,
      prompt: `Delete ${group.name}? This permanently removes the empty group. Groups with members or active grants are blocked.`,
      testId: "admin-confirm-delete-group",
      title: "Delete empty group?"
    });
  }, [closeDetail, requestConfirmedAction]);

  const requestArchiveGroup = useCallback((group: AdminGroup) => {
    if (group.systemRole === "full_access") return;
    requestConfirmation({
      body: `Archive ${group.name}? Its grants will stop applying to members immediately.`,
      confirmLabel: "Archive group",
      dialogLabel: `Archive ${group.name}`,
      onConfirm: async () => {
        const result = await runAction(
          { action: "archive_group", groupId: group.id },
          "Group archived."
        );
        if (!result.error) {
          setGroupStatusFilter("archived");
        }
      },
      testId: "admin-confirm-archive-group",
      title: "Archive group?"
    });
  }, [requestConfirmation, runAction]);

  const setGroupGrant = useCallback(async (
    group: AdminGroup,
    target: AdminGrantTarget,
    enabled: boolean
  ) => {
    if (group.systemRole === "full_access") return;
    await runAction(
      { action: "set_group_grant", enabled, groupId: group.id, ...target },
      enabled ? "Grant enabled." : "Grant revoked."
    );
  }, [runAction]);

  const setProviderModelGrants = useCallback(async (
    group: AdminGroup,
    providerId: string,
    enabled: boolean
  ) => {
    if (group.systemRole === "full_access") return;
    const models = dashboard?.catalog.models.filter((model) => model.provider === providerId) ?? [];
    if (!models.length) {
      reportNotice("No provider models to update.");
      return;
    }

    for (const model of models) {
      const result = await runAction(
        {
          action: "set_group_grant",
          enabled,
          groupId: group.id,
          modelId: model.modelId,
          provider: model.provider
        },
        enabled ? "Model grants enabled." : "Model grants revoked.",
        { reload: false, successNotice: false }
      );
      if (result.error) return;
    }

    reportNotice(enabled ? "Provider model grants enabled." : "Provider model grants revoked.");
    await refreshDashboard({ afterReconcile: onMutationReconciled });
  }, [dashboard?.catalog.models, onMutationReconciled, refreshDashboard, reportNotice, runAction]);

  const setGroupMembership = useCallback(async (
    group: AdminGroup,
    userId: string,
    enabled: boolean
  ) => {
    const user = dashboard?.users.find((candidate) => candidate.id === userId);
    if (!user || group.archivedAt) return false;
    const currentGroupIds = activeGroupIdsForUser(user, dashboard?.groups ?? []);
    const nextGroupIds = enabled
      ? [...new Set([...currentGroupIds, group.id])]
      : currentGroupIds.filter((groupId) => groupId !== group.id);
    const result = await runAction(
      { action: "set_user_groups", groupIds: nextGroupIds, userId },
      enabled ? "Member added to group." : "Member removed from group."
    );
    return !result.error;
  }, [dashboard?.groups, dashboard?.users, runAction]);

  const startRenaming = useCallback((group: AdminGroup) => {
    if (group.systemRole === "full_access") return;
    clearFieldError("rename-selected-group");
    setRenameName(group.name);
    setRenamingGroupId(group.id);
  }, [clearFieldError]);

  const sectionProps = useMemo<AdminAccessGroupsSectionProps | null>(() => {
    if (!dashboard) return null;

    return {
      actions: {
        onAddMember: (group, user) => setGroupMembership(group, user.id, true),
        onBackToList: closeDetail,
        onCreateNameChange: changeCreateName,
        onCreateSubmit: createGroup,
        onQueryChange: setGroupQuery,
        onRenameNameChange: changeRenameName,
        onRenameSubmit: renameGroup,
        onRemoveMember: (group, user) => {
          void setGroupMembership(group, user.id, false);
        },
        onRequestArchive: requestArchiveGroup,
        onRequestDelete: requestDeleteGroup,
        onSelectGroup: selectGroup,
        onSelectView: setActiveView,
        onStartRenaming: startRenaming,
        onStatusFilterChange: setGroupStatusFilter,
        onToggleGrant: (group, target, enabled) => void setGroupGrant(group, target, enabled),
        onToggleProviderModels: (group, providerId, enabled) =>
          void setProviderModelGrants(group, providerId, enabled)
      },
      data: {
        allGroups: dashboard.groups,
        allUsers: dashboard.users,
        catalog: dashboard.catalog,
        selectedGroup,
        selectedGroupMembers,
        visibleGroups
      },
      draft: {
        activeView,
        createFormOpen,
        createName,
        detailOpen,
        query: groupQuery,
        renameName,
        renamingGroupId,
        statusFilter: groupStatusFilter
      },
      refs: focus.groups,
      status: {
        actionsDisabled,
        createError: fieldError?.field === "group-name" ? fieldError.message : null,
        renameError: fieldError?.field === "rename-selected-group" ? fieldError.message : null
      }
    };
  }, [
    actionsDisabled,
    activeView,
    changeCreateName,
    changeRenameName,
    closeDetail,
    createFormOpen,
    createGroup,
    createName,
    dashboard,
    detailOpen,
    fieldError,
    focus.groups,
    groupQuery,
    groupStatusFilter,
    renameGroup,
    renameName,
    renamingGroupId,
    requestArchiveGroup,
    requestDeleteGroup,
    selectGroup,
    selectedGroup,
    selectedGroupMembers,
    setGroupGrant,
    setGroupMembership,
    setProviderModelGrants,
    startRenaming,
    visibleGroups
  ]);

  return useMemo(() => ({
    access: {
      draftProtection: {
        dirty: draftDirty,
        discard: discardDraft
      },
      sectionProps,
      toggleCreateForm
    }
  }), [discardDraft, draftDirty, sectionProps, toggleCreateForm]);
}
