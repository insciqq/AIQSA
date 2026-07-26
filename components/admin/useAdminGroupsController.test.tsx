import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminGroupsSectionProps } from "@/components/admin/AdminGroupsSection";
import type { AdminModelAccessSectionProps } from "@/components/admin/AdminModelAccessSection";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminDashboardRefresh } from "@/components/admin/useAdminDashboardResource";
import type { AdminFieldErrorController } from "@/components/admin/useAdminFieldErrors";
import type { AdminDashboard, AdminGroup } from "@/lib/contracts/admin";
import { useAdminGroupsController } from "./useAdminGroupsController";

const archived: AdminGroup = {
  accessGrants: [],
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Former operators",
  userCount: 0
};

const operators: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-operators",
  name: "Operators",
  userCount: 2
};

const reviewers: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-reviewers",
  name: "Reviewers",
  userCount: 0
};

const dashboard: AdminDashboard = {
  accessRules: [],
  catalog: {
    models: [
      { displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" },
      { displayName: "GPT Mini", modelId: "gpt-mini", provider: "openai" }
    ],
    providers: [{ id: "openai", name: "OpenAI" }],
    searchStrategies: [{ displayName: "Web search", strategyId: "web" }]
  },
  groups: [archived, operators, reviewers],
  invites: [],
  navigation: {
    advancedConfigured: false,
    attention: {
      activeUsersWithoutModelAccess: 0,
      openInvites: 0,
      pendingUsers: 0
    },
    teamConfigured: false
  },
  usage: {
    byGroup: [],
    byUser: [],
    totals: {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 0,
      lastUsedAt: null,
      outputTokens: 0,
      reasoningTokens: 0,
      runCount: 0,
      totalTokens: 0
    }
  },
  users: []
};

function requireGroupsProps(value: AdminGroupsSectionProps | null): AdminGroupsSectionProps {
  if (!value) {
    throw new Error("Expected Groups section props");
  }

  return value;
}

function requireModelAccessProps(value: AdminModelAccessSectionProps | null): AdminModelAccessSectionProps {
  if (!value) {
    throw new Error("Expected Model access section props");
  }

  return value;
}

function dependencies() {
  const runAction = vi.fn<AdminRunAction>();
  runAction.mockResolvedValue({ ok: true });
  const refreshDashboard = vi.fn<AdminDashboardRefresh>();
  refreshDashboard.mockResolvedValue({ dashboard, ok: true });
  const fieldErrors: Pick<
    AdminFieldErrorController,
    "clearFieldError" | "fieldError" | "reportFieldError"
  > = {
    clearFieldError: vi.fn<AdminFieldErrorController["clearFieldError"]>(),
    fieldError: null,
    reportFieldError: vi.fn<AdminFieldErrorController["reportFieldError"]>()
  };

  return {
    fieldErrors,
    focus: {
      groups: {
        detail: createRef<HTMLElement>()
      },
      modelAccess: {
        detail: createRef<HTMLDivElement>()
      }
    },
    onMutationReconciled: vi.fn<() => void>(),
    refreshDashboard,
    reportNotice: vi.fn<(message: string) => void>(),
    requestConfirmation: vi.fn<AdminConfirmationController["requestConfirmation"]>(),
    requestConfirmedAction: vi.fn<AdminConfirmationController["requestConfirmedAction"]>(),
    requestFocus: vi.fn<(target: "group-detail" | "model-access-detail") => void>(),
    runAction
  };
}

describe("useAdminGroupsController", () => {
  it("shares requested selection while Model access keeps focus on its group selector", () => {
    const deps = dependencies();
    const { result } = renderHook(() =>
      useAdminGroupsController({
        actionsDisabled: false,
        dashboard,
        ...deps
      })
    );

    expect(requireGroupsProps(result.current.groups.sectionProps).data.selectedGroup?.id).toBe(operators.id);
    expect(requireModelAccessProps(result.current.modelAccess.sectionProps).data.selectedGroup?.id).toBe(operators.id);

    act(() => {
      requireModelAccessProps(result.current.modelAccess.sectionProps).actions.onSelectGroup(reviewers.id);
      requireModelAccessProps(result.current.modelAccess.sectionProps).actions.onSelectGroup(reviewers.id);
    });
    expect(requireGroupsProps(result.current.groups.sectionProps).data.selectedGroup?.id).toBe(reviewers.id);
    expect(deps.requestFocus).not.toHaveBeenCalled();

    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onQueryChange("Operators"));
    expect(requireGroupsProps(result.current.groups.sectionProps).data.selectedGroup?.id).toBe(operators.id);
    expect(requireModelAccessProps(result.current.modelAccess.sectionProps).data.selectedGroup?.id).toBe(reviewers.id);

    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onQueryChange(""));
    expect(requireGroupsProps(result.current.groups.sectionProps).data.selectedGroup?.id).toBe(reviewers.id);

    act(() => requireModelAccessProps(result.current.modelAccess.sectionProps).actions.onQueryChange("Former"));
    expect(requireModelAccessProps(result.current.modelAccess.sectionProps).data.selectedGroup).toBe(archived);
  });

  it("keeps create and rename drafts after failures and resets them only after success", async () => {
    const deps = dependencies();
    const { result } = renderHook(() =>
      useAdminGroupsController({
        actionsDisabled: false,
        dashboard,
        ...deps
      })
    );

    act(() => result.current.groups.toggleCreateForm());
    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onCreateNameChange("   "));
    await act(async () => {
      await requireGroupsProps(result.current.groups.sectionProps).actions.onCreateSubmit();
    });
    expect(deps.fieldErrors.reportFieldError).toHaveBeenCalledWith("group-name", "group_required");
    expect(deps.runAction).not.toHaveBeenCalled();

    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onCreateNameChange(" New group "));
    deps.runAction.mockResolvedValueOnce({ error: "group_invalid" });
    await act(async () => {
      await requireGroupsProps(result.current.groups.sectionProps).actions.onCreateSubmit();
    });
    expect(requireGroupsProps(result.current.groups.sectionProps).draft).toMatchObject({
      createFormOpen: true,
      createName: " New group "
    });

    deps.runAction.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      await requireGroupsProps(result.current.groups.sectionProps).actions.onCreateSubmit();
    });
    expect(requireGroupsProps(result.current.groups.sectionProps).draft).toMatchObject({
      createFormOpen: false,
      createName: ""
    });

    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onStartRenaming(operators));
    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onRenameNameChange(" Renamed "));
    deps.runAction.mockResolvedValueOnce({ error: "group_invalid" });
    await act(async () => {
      await requireGroupsProps(result.current.groups.sectionProps).actions.onRenameSubmit(operators);
    });
    expect(requireGroupsProps(result.current.groups.sectionProps).draft).toMatchObject({
      renameName: " Renamed ",
      renamingGroupId: operators.id
    });

    deps.runAction.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      await requireGroupsProps(result.current.groups.sectionProps).actions.onRenameSubmit(operators);
    });
    expect(requireGroupsProps(result.current.groups.sectionProps).draft).toMatchObject({
      renameName: "",
      renamingGroupId: null
    });
  });

  it("switches to archived view after confirmed archive and clears selection only after confirmed delete", async () => {
    const deps = dependencies();
    const { result } = renderHook(() =>
      useAdminGroupsController({
        actionsDisabled: false,
        dashboard,
        ...deps
      })
    );

    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onSelectGroup(reviewers.id));
    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onRequestArchive(reviewers));
    const archiveRequest = deps.requestConfirmation.mock.calls[0]?.[0];
    expect(archiveRequest).toMatchObject({
      confirmLabel: "Archive group",
      testId: "admin-confirm-archive-group"
    });
    await act(async () => {
      await archiveRequest?.onConfirm();
    });
    expect(deps.runAction).toHaveBeenCalledWith(
      {
        action: "archive_group",
        groupId: reviewers.id
      },
      "Group archived."
    );
    expect(requireGroupsProps(result.current.groups.sectionProps).draft.statusFilter).toBe("archived");

    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onRequestDelete(reviewers));
    const deleteRequest = deps.requestConfirmedAction.mock.calls[0]?.[0];
    expect(deleteRequest).toMatchObject({
      body: {
        action: "delete_group",
        groupId: reviewers.id
      },
      testId: "admin-confirm-delete-group"
    });
    act(() => deleteRequest?.onSuccess?.());
    act(() => requireGroupsProps(result.current.groups.sectionProps).actions.onStatusFilterChange("active"));
    expect(requireGroupsProps(result.current.groups.sectionProps).data.selectedGroup?.id).toBe(operators.id);
  });

  it("bulk-updates provider models sequentially, then reports once and reloads once", async () => {
    const deps = dependencies();
    const { result } = renderHook(() =>
      useAdminGroupsController({
        actionsDisabled: false,
        dashboard,
        ...deps
      })
    );

    act(() => {
      requireModelAccessProps(result.current.modelAccess.sectionProps).actions.onToggleProviderModels(
        operators,
        "openai",
        true
      );
    });

    await waitFor(() => expect(deps.refreshDashboard).toHaveBeenCalledTimes(1));
    expect(deps.runAction).toHaveBeenNthCalledWith(
      1,
      {
        action: "set_group_grant",
        enabled: true,
        groupId: operators.id,
        modelId: "gpt-5.5",
        provider: "openai"
      },
      "Model grants enabled.",
      { reload: false, successNotice: false }
    );
    expect(deps.runAction).toHaveBeenNthCalledWith(
      2,
      {
        action: "set_group_grant",
        enabled: true,
        groupId: operators.id,
        modelId: "gpt-mini",
        provider: "openai"
      },
      "Model grants enabled.",
      { reload: false, successNotice: false }
    );
    expect(deps.reportNotice).toHaveBeenCalledWith("Provider model grants enabled.");
    expect(deps.refreshDashboard).toHaveBeenCalledWith({
      afterReconcile: deps.onMutationReconciled
    });
  });

  it("stops provider-model bulk mutation at the first error without notice or reload", async () => {
    const deps = dependencies();
    deps.runAction.mockReset();
    deps.runAction.mockResolvedValueOnce({ error: "group_not_found" });
    const { result } = renderHook(() =>
      useAdminGroupsController({
        actionsDisabled: false,
        dashboard,
        ...deps
      })
    );

    act(() => {
      requireModelAccessProps(result.current.modelAccess.sectionProps).actions.onToggleProviderModels(
        operators,
        "openai",
        false
      );
    });

    await waitFor(() => expect(deps.runAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(deps.refreshDashboard).not.toHaveBeenCalled());
    expect(deps.reportNotice).not.toHaveBeenCalled();
  });
});
