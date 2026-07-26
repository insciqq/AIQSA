import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminAccessGroupsSectionProps } from "@/components/admin/AdminAccessGroupsSection";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminDashboardRefresh } from "@/components/admin/useAdminDashboardResource";
import type { AdminFieldErrorController } from "@/components/admin/useAdminFieldErrors";
import type { AdminDashboard, AdminGroup } from "@/lib/contracts/admin";
import { useAdminGroupsController } from "./useAdminGroupsController";

const archived: AdminGroup = {
  accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-archived", name: "Former operators", systemRole: null, userCount: 0
};
const operators: AdminGroup = {
  accessGrants: [], archivedAt: null, id: "group-operators", name: "Operators", systemRole: null, userCount: 1
};
const reviewers: AdminGroup = {
  accessGrants: [], archivedAt: null, id: "group-reviewers", name: "Reviewers", systemRole: null, userCount: 0
};
const fullAccess: AdminGroup = {
  accessGrants: [], archivedAt: null, id: "group-full-access", name: "Full access", systemRole: "full_access", userCount: 1
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
    attention: { activeUsersWithoutModelAccess: 0, openInvites: 0, pendingUsers: 0 },
    teamConfigured: false
  },
  usage: {
    byGroup: [], byUser: [],
    totals: {
      cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 0, lastUsedAt: null,
      outputTokens: 0, reasoningTokens: 0, runCount: 0, totalTokens: 0
    }
  },
  users: [{
    displayName: "Ada Operator",
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: "ada@example.com",
    groups: [{ groupId: operators.id, name: operators.name, role: "member" }],
    hasVerifiedIdentity: true,
    id: "user-ada",
    lastSessionAt: null,
    role: "user",
    status: "active"
  }]
};

function requireAccessProps(value: AdminAccessGroupsSectionProps | null): AdminAccessGroupsSectionProps {
  if (!value) throw new Error("Expected Access section props");
  return value;
}

function dependencies() {
  const runAction = vi.fn<AdminRunAction>();
  runAction.mockResolvedValue({ ok: true });
  const refreshDashboard = vi.fn<AdminDashboardRefresh>();
  refreshDashboard.mockResolvedValue({ dashboard, ok: true });
  const fieldErrors: Pick<AdminFieldErrorController, "clearFieldError" | "fieldError" | "reportFieldError"> = {
    clearFieldError: vi.fn<AdminFieldErrorController["clearFieldError"]>(),
    fieldError: null,
    reportFieldError: vi.fn<AdminFieldErrorController["reportFieldError"]>()
  };

  return {
    fieldErrors,
    focus: { groups: { detail: createRef<HTMLElement>() } },
    onMutationReconciled: vi.fn<() => void>(),
    refreshDashboard,
    reportNotice: vi.fn<(message: string) => void>(),
    requestConfirmation: vi.fn<AdminConfirmationController["requestConfirmation"]>(),
    requestConfirmedAction: vi.fn<AdminConfirmationController["requestConfirmedAction"]>(),
    requestFocus: vi.fn<(target: "group-detail") => void>(),
    runAction
  };
}

describe("useAdminGroupsController", () => {
  it("starts at the directory and opens one explicit group with Overview and members", () => {
    const deps = dependencies();
    const { result } = renderHook(() => useAdminGroupsController({ actionsDisabled: false, dashboard, ...deps }));

    expect(requireAccessProps(result.current.access.sectionProps).data.selectedGroup).toBeNull();
    expect(requireAccessProps(result.current.access.sectionProps).draft.detailOpen).toBe(false);

    act(() => requireAccessProps(result.current.access.sectionProps).actions.onSelectGroup(operators.id));
    const selected = requireAccessProps(result.current.access.sectionProps);
    expect(selected.data.selectedGroup).toBe(operators);
    expect(selected.data.selectedGroupMembers.map((user) => user.id)).toEqual(["user-ada"]);
    expect(selected.draft).toMatchObject({ activeView: "overview", detailOpen: true });
    expect(deps.requestFocus).toHaveBeenCalledWith("group-detail");

    act(() => selected.actions.onSelectView("models"));
    expect(requireAccessProps(result.current.access.sectionProps).draft.activeView).toBe("models");
    act(() => requireAccessProps(result.current.access.sectionProps).actions.onBackToList());
    expect(requireAccessProps(result.current.access.sectionProps).data.selectedGroup).toBeNull();
    expect(requireAccessProps(result.current.access.sectionProps).draft.detailOpen).toBe(false);
  });

  it("adds and removes members from group detail without losing their other active groups", async () => {
    const deps = dependencies();
    const { result } = renderHook(() => useAdminGroupsController({ actionsDisabled: false, dashboard, ...deps }));
    const user = dashboard.users[0]!;

    await act(async () => {
      await requireAccessProps(result.current.access.sectionProps).actions.onAddMember(reviewers, user);
    });
    expect(deps.runAction).toHaveBeenNthCalledWith(1, {
      action: "set_user_groups",
      groupIds: [operators.id, reviewers.id],
      userId: user.id
    }, "Member added to group.");

    await act(async () => {
      await requireAccessProps(result.current.access.sectionProps).actions.onRemoveMember(operators, user);
    });
    expect(deps.runAction).toHaveBeenNthCalledWith(2, {
      action: "set_user_groups",
      groupIds: [],
      userId: user.id
    }, "Member removed from group.");
  });

  it("keeps create and rename drafts after failures and resets them only after success", async () => {
    const deps = dependencies();
    const { result } = renderHook(() => useAdminGroupsController({ actionsDisabled: false, dashboard, ...deps }));

    act(() => result.current.access.toggleCreateForm());
    act(() => requireAccessProps(result.current.access.sectionProps).actions.onCreateNameChange("   "));
    await act(async () => requireAccessProps(result.current.access.sectionProps).actions.onCreateSubmit());
    expect(deps.fieldErrors.reportFieldError).toHaveBeenCalledWith("group-name", "group_required");

    act(() => requireAccessProps(result.current.access.sectionProps).actions.onCreateNameChange(" New group "));
    deps.runAction.mockResolvedValueOnce({ error: "group_invalid" });
    await act(async () => requireAccessProps(result.current.access.sectionProps).actions.onCreateSubmit());
    expect(requireAccessProps(result.current.access.sectionProps).draft).toMatchObject({ createFormOpen: true, createName: " New group " });

    deps.runAction.mockResolvedValueOnce({ ok: true });
    await act(async () => requireAccessProps(result.current.access.sectionProps).actions.onCreateSubmit());
    expect(requireAccessProps(result.current.access.sectionProps).draft).toMatchObject({ createFormOpen: false, createName: "", detailOpen: false });

    act(() => requireAccessProps(result.current.access.sectionProps).actions.onSelectGroup(operators.id));
    act(() => requireAccessProps(result.current.access.sectionProps).actions.onStartRenaming(operators));
    act(() => requireAccessProps(result.current.access.sectionProps).actions.onRenameNameChange(" Renamed "));
    deps.runAction.mockResolvedValueOnce({ error: "group_invalid" });
    await act(async () => requireAccessProps(result.current.access.sectionProps).actions.onRenameSubmit(operators));
    expect(requireAccessProps(result.current.access.sectionProps).draft).toMatchObject({ renameName: " Renamed ", renamingGroupId: operators.id });

    deps.runAction.mockResolvedValueOnce({ ok: true });
    await act(async () => requireAccessProps(result.current.access.sectionProps).actions.onRenameSubmit(operators));
    expect(requireAccessProps(result.current.access.sectionProps).draft).toMatchObject({ renameName: "", renamingGroupId: null });
  });

  it("switches to archived results after archive and returns to the directory after delete", async () => {
    const deps = dependencies();
    const { result } = renderHook(() => useAdminGroupsController({ actionsDisabled: false, dashboard, ...deps }));

    act(() => requireAccessProps(result.current.access.sectionProps).actions.onSelectGroup(reviewers.id));
    act(() => requireAccessProps(result.current.access.sectionProps).actions.onRequestArchive(reviewers));
    const archiveRequest = deps.requestConfirmation.mock.calls[0]?.[0];
    await act(async () => archiveRequest?.onConfirm());
    expect(deps.runAction).toHaveBeenCalledWith({ action: "archive_group", groupId: reviewers.id }, "Group archived.");
    expect(requireAccessProps(result.current.access.sectionProps).draft.statusFilter).toBe("archived");
    expect(requireAccessProps(result.current.access.sectionProps).data.selectedGroup).toBe(reviewers);
    expect(requireAccessProps(result.current.access.sectionProps).draft.detailOpen).toBe(true);

    act(() => requireAccessProps(result.current.access.sectionProps).actions.onRequestDelete(reviewers));
    const deleteRequest = deps.requestConfirmedAction.mock.calls[0]?.[0];
    expect(deleteRequest).toMatchObject({ body: { action: "delete_group", groupId: reviewers.id } });
    act(() => deleteRequest?.onSuccess?.());
    expect(requireAccessProps(result.current.access.sectionProps).data.selectedGroup).toBeNull();
    expect(requireAccessProps(result.current.access.sectionProps).draft.detailOpen).toBe(false);
  });

  it("keeps an open group detail when a refresh makes it miss the preserved index query", () => {
    const deps = dependencies();
    const { result, rerender } = renderHook(
      ({ value }: { value: AdminDashboard }) =>
        useAdminGroupsController({ actionsDisabled: false, dashboard: value, ...deps }),
      { initialProps: { value: dashboard } }
    );

    act(() => requireAccessProps(result.current.access.sectionProps).actions.onQueryChange("operators"));
    act(() => requireAccessProps(result.current.access.sectionProps).actions.onSelectGroup(operators.id));

    const renamedOperators = { ...operators, name: "Research" };
    rerender({ value: { ...dashboard, groups: [archived, renamedOperators, reviewers] } });

    const refreshed = requireAccessProps(result.current.access.sectionProps);
    expect(refreshed.data.visibleGroups).toEqual([]);
    expect(refreshed.data.selectedGroup).toBe(renamedOperators);
    expect(refreshed.draft).toMatchObject({ detailOpen: true, query: "operators" });
  });

  it("delegates an individual grant and bulk-updates provider models with one final refresh", async () => {
    const deps = dependencies();
    const { result } = renderHook(() => useAdminGroupsController({ actionsDisabled: false, dashboard, ...deps }));
    const props = requireAccessProps(result.current.access.sectionProps);

    act(() => props.actions.onToggleGrant(operators, { provider: "openai" }, true));
    await waitFor(() => expect(deps.runAction).toHaveBeenCalledWith(
      { action: "set_group_grant", enabled: true, groupId: operators.id, provider: "openai" },
      "Grant enabled."
    ));

    deps.runAction.mockClear();
    act(() => requireAccessProps(result.current.access.sectionProps).actions.onToggleProviderModels(operators, "openai", true));
    await waitFor(() => expect(deps.refreshDashboard).toHaveBeenCalledTimes(1));
    expect(deps.runAction).toHaveBeenCalledTimes(2);
    expect(deps.runAction).toHaveBeenNthCalledWith(
      1,
      { action: "set_group_grant", enabled: true, groupId: operators.id, modelId: "gpt-5.5", provider: "openai" },
      "Model grants enabled.",
      { reload: false, successNotice: false }
    );
    expect(deps.reportNotice).toHaveBeenCalledWith("Provider model grants enabled.");
  });

  it("stops a provider-model bulk mutation at the first error", async () => {
    const deps = dependencies();
    deps.runAction.mockReset();
    deps.runAction.mockResolvedValueOnce({ error: "group_not_found" });
    const { result } = renderHook(() => useAdminGroupsController({ actionsDisabled: false, dashboard, ...deps }));

    act(() => requireAccessProps(result.current.access.sectionProps).actions.onToggleProviderModels(operators, "openai", false));
    await waitFor(() => expect(deps.runAction).toHaveBeenCalledTimes(1));
    expect(deps.refreshDashboard).not.toHaveBeenCalled();
    expect(deps.reportNotice).not.toHaveBeenCalled();
  });

  it("does not dispatch ordinary lifecycle or grant mutations for Full access", async () => {
    const deps = dependencies();
    const { result } = renderHook(() => useAdminGroupsController({ actionsDisabled: false, dashboard, ...deps }));
    const actions = requireAccessProps(result.current.access.sectionProps).actions;

    act(() => actions.onStartRenaming(fullAccess));
    await act(async () => actions.onRenameSubmit(fullAccess));
    act(() => actions.onRequestArchive(fullAccess));
    act(() => actions.onRequestDelete(fullAccess));
    act(() => actions.onToggleGrant(fullAccess, { provider: "openai" }, true));
    act(() => actions.onToggleProviderModels(fullAccess, "openai", true));

    await waitFor(() => expect(deps.runAction).not.toHaveBeenCalled());
    expect(deps.requestConfirmation).not.toHaveBeenCalled();
    expect(deps.requestConfirmedAction).not.toHaveBeenCalled();
    expect(deps.refreshDashboard).not.toHaveBeenCalled();
  });
});
