import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import {
  AdminUsersSection,
  type AdminUsersActions,
  type AdminUsersSectionProps,
  type AdminUsersView
} from "./AdminUsersSection";

const groups: AdminGroup[] = [
  {
    accessGrants: [],
    archivedAt: null,
    id: "group-operators",
    name: "Operators",
    userCount: 2
  },
  {
    accessGrants: [],
    archivedAt: "2026-07-01T00:00:00.000Z",
    id: "group-archived",
    name: "Archived group",
    userCount: 0
  }
];

function createUser(overrides: Partial<AdminUserRecord> = {}): AdminUserRecord {
  return {
    deletion: {
      canDelete: false,
      reason: "active_user",
      summary: "Disable this user before deletion can be considered."
    },
    displayName: "Active User",
    effectiveEntitlements: {
      models: [{ modelId: "gpt-5.5", provider: "openai" }],
      providers: ["openai"],
      searchStrategies: ["web"]
    },
    email: "active@example.com",
    groups: [{ groupId: "group-operators", name: "Operators", role: "member" }],
    hasVerifiedIdentity: true,
    id: "user-active",
    lastSessionAt: "2026-07-12T08:00:00.000Z",
    role: "user",
    status: "active",
    ...overrides
  };
}

function createActions() {
  return {
    onApprove: vi.fn<AdminUsersActions["onApprove"]>(),
    onEditUserGroups: vi.fn<AdminUsersActions["onEditUserGroups"]>(),
    onNextPage: vi.fn<AdminUsersActions["onNextPage"]>(),
    onPreviousPage: vi.fn<AdminUsersActions["onPreviousPage"]>(),
    onQueryChange: vi.fn<AdminUsersActions["onQueryChange"]>(),
    onRequestDelete: vi.fn<AdminUsersActions["onRequestDelete"]>(),
    onRequestDisable: vi.fn<AdminUsersActions["onRequestDisable"]>(),
    onRequestReject: vi.fn<AdminUsersActions["onRequestReject"]>(),
    onRequestRevokeSessions: vi.fn<AdminUsersActions["onRequestRevokeSessions"]>(),
    onSaveGroups: vi.fn<AdminUsersActions["onSaveGroups"]>(),
    onSelectUser: vi.fn<AdminUsersActions["onSelectUser"]>(),
    onSelectedUserGroupsChange: vi.fn<AdminUsersActions["onSelectedUserGroupsChange"]>(),
    onSort: vi.fn<AdminUsersActions["onSort"]>(),
    onStatusFilterChange: vi.fn<AdminUsersActions["onStatusFilterChange"]>()
  } satisfies AdminUsersActions;
}

function createFixture(options: {
  pageUsers?: AdminUserRecord[];
  selectedUser?: AdminUserRecord | null;
  totalUserCount?: number;
  view?: Partial<AdminUsersView>;
} = {}) {
  const pageUsers = options.pageUsers ?? [createUser()];
  const selectedUser = options.selectedUser === undefined ? pageUsers[0] ?? null : options.selectedUser;
  const actions = createActions();
  const detail = createRef<HTMLElement>();
  const groupsEditor = createRef<HTMLDivElement>();
  const props: AdminUsersSectionProps = {
    actions,
    data: {
      adminUserId: "admin-current",
      catalog: {
        models: [{ displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" }],
        providers: [{ id: "openai", name: "OpenAI" }],
        searchStrategies: [{ displayName: "Web search", strategyId: "web" }]
      },
      groups,
      pageUsers,
      selectedUser,
      selectedUserGroupIds: selectedUser?.groups.map((group) => group.groupId) ?? [],
      totalUserCount: options.totalUserCount ?? pageUsers.length
    },
    focus: {
      detail,
      groupsEditor
    },
    status: {
      actionsDisabled: false
    },
    view: {
      filteredCount: pageUsers.length,
      pageCount: 1,
      pageEnd: pageUsers.length,
      pageIndex: 0,
      pageStart: pageUsers.length ? 1 : 0,
      query: "",
      sortDirection: "asc",
      sortKey: "user",
      statusFilter: "all",
      ...options.view
    }
  };

  return { actions, detail, groupsEditor, props };
}

describe("AdminUsersSection", () => {
  it("distinguishes an empty dashboard from an empty filtered page", () => {
    const empty = createFixture({ pageUsers: [], selectedUser: null, totalUserCount: 0 });
    const view = render(<AdminUsersSection {...empty.props} />);

    expect(screen.getByText("No users yet")).toBeVisible();
    expect(screen.getByText("No user selected")).toBeVisible();
    expect(screen.getByRole("region", { name: "Users table" })).toHaveAttribute("tabindex", "0");

    const filtered = createFixture({
      pageUsers: [],
      selectedUser: null,
      totalUserCount: 3,
      view: { filteredCount: 0, query: "missing" }
    });
    view.rerender(<AdminUsersSection {...filtered.props} />);

    expect(screen.getByText("No users match this view")).toBeVisible();
    expect(screen.queryByText("No users yet")).not.toBeInTheDocument();
  });

  it("emits semantic filter, sort, page, and selection actions", () => {
    const user = createUser();
    const fixture = createFixture({
      pageUsers: [user],
      selectedUser: user,
      view: {
        filteredCount: 51,
        pageCount: 3,
        pageEnd: 26,
        pageIndex: 1,
        pageStart: 26
      }
    });
    render(<AdminUsersSection {...fixture.props} />);

    fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "pending@example.com" } });
    fireEvent.click(within(screen.getByRole("group", { name: "User status filters" })).getByRole("button", { name: "pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort by Status" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous users page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next users page" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(fixture.actions.onQueryChange).toHaveBeenCalledWith("pending@example.com");
    expect(fixture.actions.onStatusFilterChange).toHaveBeenCalledWith("pending");
    expect(fixture.actions.onSort).toHaveBeenCalledWith("status");
    expect(fixture.actions.onPreviousPage).toHaveBeenCalledTimes(1);
    expect(fixture.actions.onNextPage).toHaveBeenCalledTimes(1);
    expect(fixture.actions.onSelectUser).toHaveBeenCalledWith(user.id);
  });

  it("attaches the controller refs to the exact focus targets", () => {
    const fixture = createFixture();
    render(<AdminUsersSection {...fixture.props} />);

    expect(fixture.detail.current).toBe(screen.getByTestId("admin-user-detail"));
    expect(fixture.detail.current?.tagName).toBe("ASIDE");
    expect(fixture.detail.current).toHaveAttribute("tabindex", "-1");
    expect(fixture.groupsEditor.current).toBe(screen.getByTestId("admin-user-groups-editor"));
    expect(fixture.groupsEditor.current?.tagName).toBe("DIV");
    expect(fixture.groupsEditor.current).toHaveAttribute("tabindex", "-1");
  });

  it("delegates pending and active user workflows through semantic actions", () => {
    const pending = createUser({
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No app-owned records detected; auth request data can be removed."
      },
      displayName: "Pending User",
      email: "pending@example.com",
      groups: [],
      id: "user-pending",
      status: "pending"
    });
    const pendingFixture = createFixture({ pageUsers: [pending], selectedUser: pending });
    const view = render(<AdminUsersSection {...pendingFixture.props} />);

    expect(screen.queryByRole("checkbox", { name: "Archived group" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Operators" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve user" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject user" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete stale user" }));

    expect(pendingFixture.actions.onSelectedUserGroupsChange).toHaveBeenCalledWith(pending.id, ["group-operators"]);
    expect(pendingFixture.actions.onApprove).toHaveBeenCalledWith(pending);
    expect(pendingFixture.actions.onRequestReject).toHaveBeenCalledWith(pending);
    expect(pendingFixture.actions.onRequestDelete).toHaveBeenCalledWith(pending);

    const active = createUser();
    const activeFixture = createFixture({ pageUsers: [active], selectedUser: active });
    view.rerender(<AdminUsersSection {...activeFixture.props} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit groups" }));
    fireEvent.click(screen.getByRole("button", { name: "Save groups" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable user" }));

    expect(activeFixture.actions.onEditUserGroups).toHaveBeenCalledWith(active.id);
    expect(activeFixture.actions.onSaveGroups).toHaveBeenCalledWith(active);
    expect(activeFixture.actions.onRequestRevokeSessions).toHaveBeenCalledWith(active);
    expect(activeFixture.actions.onRequestDisable).toHaveBeenCalledWith(active);
  });

  it("keeps unverified approval blocked and disables verified pending and active mutations while busy", () => {
    const unverified = createUser({
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No app-owned records detected; auth request data can be removed."
      },
      displayName: "Unverified User",
      email: "unverified@example.com",
      groups: [],
      hasVerifiedIdentity: false,
      id: "user-unverified",
      status: "pending"
    });
    const fixture = createFixture({ pageUsers: [unverified], selectedUser: unverified });
    const view = render(<AdminUsersSection {...fixture.props} />);

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve user" })).toBeDisabled();

    const pending = createUser({
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No app-owned records detected; auth request data can be removed."
      },
      displayName: "Pending User",
      email: "pending@example.com",
      groups: [],
      id: "user-pending-busy",
      status: "pending"
    });
    const pendingFixture = createFixture({ pageUsers: [pending], selectedUser: pending });
    view.rerender(<AdminUsersSection {...pendingFixture.props} status={{ actionsDisabled: true }} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve user" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject user" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete stale user" })).toBeDisabled();

    const active = createUser();
    const activeFixture = createFixture({ pageUsers: [active], selectedUser: active });
    view.rerender(<AdminUsersSection {...activeFixture.props} status={{ actionsDisabled: true }} />);

    expect(screen.getByRole("button", { name: "Details" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit groups" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save groups" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke sessions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disable user" })).toBeDisabled();
  });

  it("keeps the current admin actions read-only", () => {
    const currentAdmin = createUser({
      displayName: "Current Admin",
      email: "admin@example.com",
      id: "admin-current",
      role: "admin"
    });
    const fixture = createFixture({ pageUsers: [currentAdmin], selectedUser: currentAdmin });
    render(<AdminUsersSection {...fixture.props} />);

    expect(screen.getByText("You")).toBeVisible();
    expect(screen.getByText("Acting admin")).toBeVisible();
    expect(screen.getByText(/self-disable and self-delete are not exposed/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit groups" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save groups" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Revoke/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Disable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });
});
