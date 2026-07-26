import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminUsersSectionProps } from "@/components/admin/AdminUsersSection";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminDashboard, AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import { useAdminUsersController } from "./useAdminUsersController";

const activeGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-active",
  name: "Active group",
  userCount: 2
};

const archivedGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Archived group",
  userCount: 0
};

function user(id: string, status: AdminUserRecord["status"] = "active"): AdminUserRecord {
  return {
    displayName: `User ${id}`,
    effectiveEntitlements: {
      models: [],
      providers: [],
      searchStrategies: []
    },
    email: `${id}@example.com`,
    groups: status === "active" ? [{ groupId: activeGroup.id, name: activeGroup.name, role: "member" }] : [],
    hasVerifiedIdentity: true,
    id,
    lastSessionAt: null,
    role: "user",
    status
  };
}

function dashboard(users: AdminUserRecord[], groups: AdminGroup[] = [activeGroup, archivedGroup]): AdminDashboard {
  return {
    accessRules: [],
    catalog: {
      models: [],
      providers: [],
      searchStrategies: []
    },
    groups,
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
    users
  };
}

function requireSectionProps(value: AdminUsersSectionProps | null): AdminUsersSectionProps {
  if (!value) {
    throw new Error("Expected Users section props");
  }

  return value;
}

function dependencies() {
  const runAction = vi.fn<AdminRunAction>();
  runAction.mockResolvedValue({ ok: true });

  return {
    focus: {
      detail: createRef<HTMLElement>(),
      groupsEditor: createRef<HTMLDivElement>()
    },
    requestConfirmedAction: vi.fn<AdminConfirmationController["requestConfirmedAction"]>(),
    requestFocus: vi.fn<(target: "user-detail" | "user-groups") => void>(),
    runAction
  };
}

describe("useAdminUsersController", () => {
  it("keeps keyed membership drafts and prunes archived ids at projection and submit time", async () => {
    const pending = user("pending", "pending");
    const deps = dependencies();
    const initialDashboard = dashboard([pending]);
    const { result, rerender } = renderHook(
      ({ value }: { value: AdminDashboard | null }) =>
        useAdminUsersController({
          actionsDisabled: false,
          adminUserId: "admin-current",
          dashboard: value,
          ...deps
        }),
      {
        initialProps: {
          value: initialDashboard
        }
      }
    );

    act(() => {
      requireSectionProps(result.current.sectionProps).actions.onSelectedUserGroupsChange(pending.id, [
        activeGroup.id,
        archivedGroup.id
      ]);
    });
    expect(requireSectionProps(result.current.sectionProps).data.selectedUserGroupIds).toEqual([activeGroup.id]);

    const archivedDashboard = dashboard(
      [pending],
      [
        {
          ...activeGroup,
          archivedAt: "2026-07-12T00:00:00.000Z"
        },
        archivedGroup
      ]
    );
    rerender({ value: archivedDashboard });
    expect(requireSectionProps(result.current.sectionProps).data.selectedUserGroupIds).toEqual([]);

    act(() => requireSectionProps(result.current.sectionProps).actions.onApprove(pending));
    await waitFor(() =>
      expect(deps.runAction).toHaveBeenCalledWith(
        {
          action: "approve_user",
          groupIds: [],
          userId: pending.id
        },
        "User approved."
      )
    );
  });

  it("preserves requested selection through page fallback and issues repeated semantic focus requests", () => {
    const users = Array.from({ length: 27 }, (_, index) => user(String(index + 1).padStart(2, "0")));
    const deps = dependencies();
    const { result } = renderHook(() =>
      useAdminUsersController({
        actionsDisabled: false,
        adminUserId: "admin-current",
        dashboard: dashboard(users),
        ...deps
      })
    );

    act(() => requireSectionProps(result.current.sectionProps).actions.onNextPage());
    const pageTwo = requireSectionProps(result.current.sectionProps);
    expect(pageTwo.data.selectedUser?.id).toBe("26");

    act(() => {
      pageTwo.actions.onSelectUser("27");
      pageTwo.actions.onSelectUser("27");
    });
    expect(requireSectionProps(result.current.sectionProps).data.selectedUser?.id).toBe("27");
    expect(deps.requestFocus).toHaveBeenNthCalledWith(1, "user-detail");
    expect(deps.requestFocus).toHaveBeenNthCalledWith(2, "user-detail");

    act(() => requireSectionProps(result.current.sectionProps).actions.onQueryChange("missing"));
    expect(requireSectionProps(result.current.sectionProps).data.selectedUser).toBeNull();
    act(() => requireSectionProps(result.current.sectionProps).actions.onQueryChange(""));
    expect(requireSectionProps(result.current.sectionProps).data.selectedUser?.id).toBe("01");
    act(() => requireSectionProps(result.current.sectionProps).actions.onNextPage());
    expect(requireSectionProps(result.current.sectionProps).data.selectedUser?.id).toBe("27");
  });

  it("maps confirmations and clears the requested selection only after successful deletion", () => {
    const first = user("first");
    const second = user("second");
    const deps = dependencies();
    const { result } = renderHook(() =>
      useAdminUsersController({
        actionsDisabled: true,
        adminUserId: "admin-current",
        dashboard: dashboard([first, second]),
        ...deps
      })
    );

    act(() => requireSectionProps(result.current.sectionProps).actions.onSelectUser(second.id));
    expect(requireSectionProps(result.current.sectionProps).data.selectedUser?.id).toBe(second.id);
    expect(requireSectionProps(result.current.sectionProps).status.actionsDisabled).toBe(true);

    act(() => requireSectionProps(result.current.sectionProps).actions.onRequestDelete(second));
    const request = deps.requestConfirmedAction.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      body: {
        action: "delete_user",
        userId: second.id
      },
      confirmLabel: "Delete user",
      icon: "trash",
      testId: "admin-confirm-delete-user"
    });
    expect(requireSectionProps(result.current.sectionProps).data.selectedUser?.id).toBe(second.id);

    act(() => request?.onSuccess?.());
    expect(requireSectionProps(result.current.sectionProps).data.selectedUser?.id).toBe(first.id);
  });
});
