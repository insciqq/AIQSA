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
  { accessGrants: [], archivedAt: null, id: "group-operators", name: "Operators", systemRole: null, userCount: 2 },
  { accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-archived", name: "Archived group", systemRole: null, userCount: 0 }
];

function createUser(overrides: Partial<AdminUserRecord> = {}): AdminUserRecord {
  return {
    deletion: { canDelete: false, reason: "active_user", summary: "Disable this user before deletion can be considered." },
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

function createActions(): AdminUsersActions {
  return {
    onApprove: vi.fn(),
    onBackToList: vi.fn(),
    onNextPage: vi.fn(),
    onPreviousPage: vi.fn(),
    onQueryChange: vi.fn(),
    onRequestDelete: vi.fn(),
    onRequestDisable: vi.fn(),
    onRequestReject: vi.fn(),
    onRequestRevokeSessions: vi.fn(),
    onSaveGroups: vi.fn(),
    onSelectUser: vi.fn(),
    onSelectedUserGroupsChange: vi.fn(),
    onSort: vi.fn(),
    onStatusFilterChange: vi.fn()
  };
}

function createFixture(options: {
  pageUsers?: AdminUserRecord[];
  selectedUser?: AdminUserRecord | null;
  totalUserCount?: number;
  view?: Partial<AdminUsersView>;
} = {}) {
  const pageUsers = options.pageUsers ?? [createUser()];
  const selectedUser = options.selectedUser ?? null;
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
    focus: { detail, groupsEditor },
    status: { actionsDisabled: false },
    view: {
      compactDetailOpen: false,
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
  it("renders a full-width directory with whole-row selection and no persistent detail", () => {
    const user = createUser();
    const fixture = createFixture({ pageUsers: [user] });
    render(<AdminUsersSection {...fixture.props} />);

    expect(screen.getByTestId("admin-users-index")).toBeVisible();
    expect(screen.queryByTestId("admin-users-detail-pane")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();

    const row = screen.getByRole("button", { name: "Open Active User" });
    expect(row).toHaveTextContent("active@example.com");
    fireEvent.click(row);
    expect(fixture.actions.onSelectUser).toHaveBeenCalledWith(user.id);
  });

  it("keeps directory headers and rows on the same bounded desktop columns", () => {
    const fixture = createFixture({ pageUsers: [createUser()] });
    render(<AdminUsersSection {...fixture.props} />);

    const header = screen.getByTestId("admin-users-header");
    const row = screen.getByTestId("admin-user-row");
    const rowColumns = [...row.classList].find((className) => className.startsWith("md:grid-cols-"));

    expect(rowColumns).toBeDefined();
    expect(rowColumns).not.toContain("_auto]");
    expect(header).toHaveClass(rowColumns!);
    expect(within(row).getByText("Active")).toHaveAttribute("data-resource-availability", "enabled");
    expect(row).toHaveAttribute("data-user-lifecycle-row", "active");
  });

  it("renders only the dedicated detail while a user is open and connects Back", () => {
    const user = createUser();
    const fixture = createFixture({ selectedUser: user, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} />);

    expect(screen.queryByTestId("admin-users-index")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-users-detail-pane")).toBeVisible();
    expect(fixture.detail.current).toBe(screen.getByTestId("admin-user-detail"));
    fireEvent.click(screen.getByRole("button", { name: "Back to users" }));
    expect(fixture.actions.onBackToList).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an empty installation from an empty filtered view without a blank inspector", () => {
    const empty = createFixture({ pageUsers: [], selectedUser: null, totalUserCount: 0 });
    const view = render(<AdminUsersSection {...empty.props} />);
    expect(screen.getByText("No users yet")).toBeVisible();
    expect(screen.queryByText("No user selected")).not.toBeInTheDocument();

    const filtered = createFixture({ pageUsers: [], selectedUser: null, totalUserCount: 3, view: { filteredCount: 0, query: "missing" } });
    view.rerender(<AdminUsersSection {...filtered.props} />);
    expect(screen.getByText("No users match this view")).toBeVisible();
  });

  it("delegates search, filter, sorting, and pagination from the directory", () => {
    const fixture = createFixture({
      view: { filteredCount: 51, pageCount: 3, pageEnd: 26, pageIndex: 1, pageStart: 26 }
    });
    render(<AdminUsersSection {...fixture.props} />);

    fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "pending@example.com" } });
    fireEvent.click(within(screen.getByRole("group", { name: "User status filters" })).getByRole("button", { name: "pending" }));
    fireEvent.change(screen.getByLabelText("Sort users"), { target: { value: "lastSession" } });
    fireEvent.click(screen.getByRole("button", { name: "Change sort direction to descending" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous users page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next users page" }));

    expect(fixture.actions.onQueryChange).toHaveBeenCalledWith("pending@example.com");
    expect(fixture.actions.onStatusFilterChange).toHaveBeenCalledWith("pending");
    expect(fixture.actions.onSort).toHaveBeenCalledWith("lastSession");
    expect(fixture.actions.onPreviousPage).toHaveBeenCalledTimes(1);
    expect(fixture.actions.onNextPage).toHaveBeenCalledTimes(1);
  });

  it("keeps pending lifecycle and membership actions in the dedicated detail", () => {
    const pending = createUser({
      deletion: { canDelete: true, reason: null, summary: "No app-owned records detected; auth request data can be removed." },
      displayName: "Pending User",
      email: "pending@example.com",
      groups: [],
      id: "user-pending",
      status: "pending"
    });
    const fixture = createFixture({ selectedUser: pending, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} />);

    expect(fixture.groupsEditor.current).toBe(screen.getByTestId("admin-user-groups-editor"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Operators" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve user" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject user" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete stale user" }));

    expect(fixture.actions.onSelectedUserGroupsChange).toHaveBeenCalledWith(pending.id, ["group-operators"]);
    expect(fixture.actions.onApprove).toHaveBeenCalledWith(pending);
    expect(fixture.actions.onRequestReject).toHaveBeenCalledWith(pending);
    expect(fixture.actions.onRequestDelete).toHaveBeenCalledWith(pending);
  });

  it("keeps active mutations disabled while another action runs", () => {
    const active = createUser();
    const fixture = createFixture({ selectedUser: active, view: { compactDetailOpen: true } });
    render(
      <AdminUsersSection
        {...fixture.props}
        data={{ ...fixture.props.data, selectedUserGroupIds: [] }}
        status={{ actionsDisabled: true }}
      />
    );

    const saveGroups = screen.getByRole("button", { name: "Save groups" });
    expect(saveGroups).toBeDisabled();
    expect(saveGroups).toHaveClass("bg-control-surface");
    expect(saveGroups).not.toHaveClass("bg-proof");
    expect(screen.getByRole("button", { name: "Revoke sessions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disable user" })).toBeDisabled();
  });

  it("enables group saving only for a changed active-user membership draft", () => {
    const active = createUser();
    const fixture = createFixture({ selectedUser: active, view: { compactDetailOpen: true } });
    const view = render(<AdminUsersSection {...fixture.props} />);

    const accountActions = screen.getByRole("heading", { level: 4, name: "Account actions" }).nextElementSibling;
    expect(accountActions).toHaveClass("flex", "flex-wrap");
    expect(screen.getByRole("button", { name: "Save groups" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save groups" })).toHaveClass("bg-control-surface");
    expect(screen.getByRole("button", { name: "Save groups" })).not.toHaveClass("bg-proof");
    expect(screen.getByText("Group memberships are up to date")).toBeVisible();

    view.rerender(
      <AdminUsersSection
        {...fixture.props}
        data={{ ...fixture.props.data, selectedUserGroupIds: [] }}
      />
    );
    expect(screen.getByRole("button", { name: "Save groups" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save groups" })).toHaveClass("bg-proof");
    expect(screen.getByText("Unsaved group changes")).toBeVisible();
  });

  it("ignores archived memberships when comparing the saved active-group draft", () => {
    const active = createUser({
      groups: [
        { groupId: "group-operators", name: "Operators", role: "member" },
        { groupId: "group-archived", name: "Archived group", role: "member" }
      ]
    });
    const fixture = createFixture({ selectedUser: active, view: { compactDetailOpen: true } });
    render(
      <AdminUsersSection
        {...fixture.props}
        data={{
          ...fixture.props.data,
          selectedUserGroupIds: ["group-operators"]
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Save groups" })).toBeDisabled();
    expect(screen.getByText("Group memberships are up to date")).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Archived group" })).not.toBeInTheDocument();
  });

  it("keeps catalog-backed and unavailable model grants truthful", () => {
    const active = createUser({
      effectiveEntitlements: {
        models: [
          { modelId: "gpt-5.5", provider: "openai" },
          { modelId: "retired-alpha", provider: "retired-openai" },
          { modelId: "retired-beta", provider: "retired-anthropic" }
        ],
        providers: ["openai"],
        searchStrategies: ["web"]
      }
    });
    const fixture = createFixture({ selectedUser: active, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} />);

    expect(screen.getByText("OpenAI / GPT 5.5")).toBeVisible();
    fireEvent.click(screen.getByText("2 unavailable model grants"));
    expect(screen.getByText("retired-openai / retired-alpha")).toBeVisible();
    expect(screen.getByText("retired-anthropic / retired-beta")).toBeVisible();
  });

  it("keeps the acting admin read-only", () => {
    const currentAdmin = createUser({ displayName: "Current Admin", email: "admin@example.com", id: "admin-current", role: "admin" });
    const fixture = createFixture({ selectedUser: currentAdmin, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} />);

    expect(screen.getByText(/Acting admin/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save groups" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Disable/ })).not.toBeInTheDocument();
  });
});
