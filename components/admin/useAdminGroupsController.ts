"use client";

import type {
  AdminGroupsSectionProps,
  AdminGroupsSectionRefs
} from "@/components/admin/AdminGroupsSection";
import type {
  AdminModelAccessSectionProps,
  AdminModelAccessSectionRefs
} from "@/components/admin/AdminModelAccessSection";
import {
  filterAdminGroups,
  filterAdminModelAccessGroups,
  resolveAdminGroupSelection,
  resolveAdminModelAccessGroupSelection,
  type AdminGrantTarget,
  type AdminGroupStatusFilter
} from "@/components/admin/adminGroupView";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminDashboardRefresh } from "@/components/admin/useAdminDashboardResource";
import type { AdminFieldErrorController } from "@/components/admin/useAdminFieldErrors";
import type { AdminDashboard, AdminGroup } from "@/lib/contracts/admin";
import { useCallback, useMemo, useState } from "react";

type AdminGroupsFocus = Readonly<{
  groups: AdminGroupsSectionRefs;
  modelAccess: AdminModelAccessSectionRefs;
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
  requestFocus(target: "group-detail" | "model-access-detail"): void;
  runAction: AdminRunAction;
}>;

export type AdminGroupsController = Readonly<{
  groups: Readonly<{
    sectionProps: AdminGroupsSectionProps | null;
    toggleCreateForm(): void;
  }>;
  modelAccess: Readonly<{
    sectionProps: AdminModelAccessSectionProps | null;
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
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [groupsCompactDetailOpen, setGroupsCompactDetailOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [groupQuery, setGroupQuery] = useState("");
  const [groupStatusFilter, setGroupStatusFilter] = useState<AdminGroupStatusFilter>("active");
  const [modelAccessQuery, setModelAccessQuery] = useState("");
  const [modelAccessCompactDetailOpen, setModelAccessCompactDetailOpen] = useState(false);
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
    () => resolveAdminGroupSelection(visibleGroups, requestedSelectedGroupId),
    [requestedSelectedGroupId, visibleGroups]
  );
  const visibleModelAccessGroups = useMemo(
    () =>
      filterAdminModelAccessGroups(
        dashboard?.groups ?? [],
        dashboard?.catalog ?? { models: [], providers: [], searchStrategies: [] },
        modelAccessQuery
      ),
    [dashboard?.catalog, dashboard?.groups, modelAccessQuery]
  );
  const selectedModelAccessGroup = useMemo(
    () => resolveAdminModelAccessGroupSelection(visibleModelAccessGroups, requestedSelectedGroupId),
    [requestedSelectedGroupId, visibleModelAccessGroups]
  );

  const selectGroup = useCallback(
    (groupId: string, target: "group-detail" | "model-access-detail" = "group-detail") => {
      requestFocus(target);
      setRequestedSelectedGroupId(groupId);
      if (target === "model-access-detail") {
        setModelAccessCompactDetailOpen(true);
      } else {
        setGroupsCompactDetailOpen(true);
      }
    },
    [requestFocus]
  );

  const toggleCreateForm = useCallback(() => {
    clearFieldError("group-name");
    setCreateFormOpen((open) => {
      const nextOpen = !open;
      setGroupsCompactDetailOpen(nextOpen);
      return nextOpen;
    });
  }, [clearFieldError]);

  const closeGroupsDetail = useCallback(() => {
    setCreateFormOpen(false);
    setGroupsCompactDetailOpen(false);
  }, []);

  const changeCreateName = useCallback(
    (value: string) => {
      setCreateName(value);
      clearFieldError("group-name");
    },
    [clearFieldError]
  );

  const changeRenameName = useCallback(
    (value: string) => {
      setRenameName(value);
      clearFieldError("rename-selected-group");
    },
    [clearFieldError]
  );

  const createGroup = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      reportFieldError("group-name", "group_required");
      return;
    }
    clearFieldError("group-name");

    const result = await runAction(
      {
        action: "create_group",
        name
      },
      "Group created."
    );

    if (!result.error) {
      setCreateName("");
      setCreateFormOpen(false);
      setGroupsCompactDetailOpen(false);
    }
  }, [clearFieldError, createName, reportFieldError, runAction]);

  const renameGroup = useCallback(
    async (group: AdminGroup) => {
      const name = renameName.trim();
      if (!name) {
        reportFieldError("rename-selected-group", "group_required");
        return;
      }
      clearFieldError("rename-selected-group");

      const result = await runAction(
        {
          action: "rename_group",
          groupId: group.id,
          name
        },
        "Group renamed."
      );

      if (!result.error) {
        setRenameName("");
        setRenamingGroupId(null);
      }
    },
    [clearFieldError, renameName, reportFieldError, runAction]
  );

  const requestDeleteGroup = useCallback(
    (group: AdminGroup) => {
      requestConfirmedAction({
        body: {
          action: "delete_group",
          groupId: group.id
        },
        confirmLabel: "Delete group",
        dialogLabel: `Delete group ${group.name}`,
        icon: "trash",
        message: "Group deleted.",
        onSuccess: () => {
          setRequestedSelectedGroupId(null);
          setGroupsCompactDetailOpen(false);
          setModelAccessCompactDetailOpen(false);
        },
        prompt: `Delete ${group.name}? This permanently removes the empty group. Groups with members or active grants are blocked.`,
        testId: "admin-confirm-delete-group",
        title: "Delete empty group?"
      });
    },
    [requestConfirmedAction]
  );

  const requestArchiveGroup = useCallback(
    (group: AdminGroup) => {
      requestConfirmation({
        body: `Archive ${group.name}? Its grants will stop applying to members immediately.`,
        confirmLabel: "Archive group",
        dialogLabel: `Archive ${group.name}`,
        onConfirm: async () => {
          const result = await runAction(
            {
              action: "archive_group",
              groupId: group.id
            },
            "Group archived."
          );

          if (!result.error) {
            setGroupStatusFilter("archived");
          }
        },
        testId: "admin-confirm-archive-group",
        title: "Archive group?"
      });
    },
    [requestConfirmation, runAction]
  );

  const setGroupGrant = useCallback(
    async (group: AdminGroup, target: AdminGrantTarget, enabled: boolean) => {
      await runAction(
        {
          action: "set_group_grant",
          enabled,
          groupId: group.id,
          ...target
        },
        enabled ? "Grant enabled." : "Grant revoked."
      );
    },
    [runAction]
  );

  const setProviderModelGrants = useCallback(
    async (group: AdminGroup, providerId: string, enabled: boolean) => {
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
          {
            reload: false,
            successNotice: false
          }
        );

        if (result.error) {
          return;
        }
      }

      reportNotice(enabled ? "Provider model grants enabled." : "Provider model grants revoked.");
      await refreshDashboard({
        afterReconcile: onMutationReconciled
      });
    },
    [dashboard?.catalog.models, onMutationReconciled, refreshDashboard, reportNotice, runAction]
  );

  const startRenaming = useCallback(
    (group: AdminGroup) => {
      clearFieldError("rename-selected-group");
      setRenameName(group.name);
      setRenamingGroupId(group.id);
    },
    [clearFieldError]
  );

  const groupsSectionProps = useMemo<AdminGroupsSectionProps | null>(() => {
    if (!dashboard) {
      return null;
    }

    return {
      actions: {
        onBackToList: closeGroupsDetail,
        onCreateNameChange: changeCreateName,
        onCreateSubmit: createGroup,
        onQueryChange: setGroupQuery,
        onRenameNameChange: changeRenameName,
        onRenameSubmit: renameGroup,
        onRequestArchive: requestArchiveGroup,
        onRequestDelete: requestDeleteGroup,
        onSelectGroup: selectGroup,
        onStartRenaming: startRenaming,
        onStatusFilterChange: setGroupStatusFilter
      },
      data: {
        allGroups: dashboard.groups,
        catalog: dashboard.catalog,
        selectedGroup,
        visibleGroups
      },
      draft: {
        compactDetailOpen: groupsCompactDetailOpen,
        createFormOpen,
        createName,
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
    changeCreateName,
    changeRenameName,
    closeGroupsDetail,
    createFormOpen,
    createGroup,
    createName,
    dashboard,
    fieldError,
    focus.groups,
    groupQuery,
    groupStatusFilter,
    groupsCompactDetailOpen,
    renameGroup,
    renameName,
    renamingGroupId,
    requestArchiveGroup,
    requestDeleteGroup,
    selectGroup,
    selectedGroup,
    startRenaming,
    visibleGroups
  ]);

  const modelAccessSectionProps = useMemo<AdminModelAccessSectionProps | null>(() => {
    if (!dashboard) {
      return null;
    }

    return {
      actions: {
        onBackToList: () => setModelAccessCompactDetailOpen(false),
        onQueryChange: setModelAccessQuery,
        onSelectGroup: (groupId) => {
          setRequestedSelectedGroupId(groupId);
          setModelAccessCompactDetailOpen(true);
        },
        onToggleGrant: (group, target, enabled) => void setGroupGrant(group, target, enabled),
        onToggleProviderModels: (group, providerId, enabled) =>
          void setProviderModelGrants(group, providerId, enabled)
      },
      data: {
        catalog: dashboard.catalog,
        selectedGroup: selectedModelAccessGroup,
        totalGroupCount: dashboard.groups.length,
        visibleGroups: visibleModelAccessGroups
      },
      draft: {
        compactDetailOpen: modelAccessCompactDetailOpen,
        query: modelAccessQuery
      },
      refs: focus.modelAccess,
      status: {
        actionsDisabled
      }
    };
  }, [
    actionsDisabled,
    dashboard,
    focus.modelAccess,
    modelAccessCompactDetailOpen,
    modelAccessQuery,
    selectedModelAccessGroup,
    setGroupGrant,
    setProviderModelGrants,
    visibleModelAccessGroups
  ]);

  return useMemo(
    () => ({
      groups: {
        sectionProps: groupsSectionProps,
        toggleCreateForm
      },
      modelAccess: {
        sectionProps: modelAccessSectionProps
      }
    }),
    [groupsSectionProps, modelAccessSectionProps, toggleCreateForm]
  );
}
