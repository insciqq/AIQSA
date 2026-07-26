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
  { accessGrants: [], archivedAt: null, id: "group-operators", name: "Operators", userCount: 2 },
  { accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-archived", name: "Archived group", userCount: 0 }
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
    onEditUserGroups: vi.fn(),
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
  it("keeps a flat index and detail mounted while compact ownership switches", () => {
    const fixture = createFixture();
    const view = render(<AdminUsersSection {...fixture.props} />);

    expect(screen.getByTestId("admin-users-index")).toHaveClass("block", "lg:block");
    expect(screen.getByTestId("admin-users-detail-pane")).toHaveClass("hidden", "lg:block");
    expect(screen.getByTestId("admin-user-row")).toHaveTextContent("active@example.com");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    view.rerender(<AdminUsersSection {...fixture.props} view={{ ...fixture.props.view, compactDetailOpen: true }} />);
    expect(screen.getByTestId("admin-users-index")).toHaveClass("hidden", "lg:block");
    expect(screen.getByTestId("admin-users-detail-pane")).toHaveClass("block", "lg:block");
    fireEvent.click(screen.getByRole("button", { name: "Back to users" }));
    expect(fixture.actions.onBackToList).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an empty installation from an empty filtered view", () => {
    const empty = createFixture({ pageUsers: [], selectedUser: null, totalUserCount: 0 });
    const view = render(<AdminUsersSection {...empty.props} />);
    expect(screen.getByText("No users yet")).toBeVisible();
    expect(screen.getByText("No user selected")).toBeVisible();

    const filtered = createFixture({ pageUsers: [], selectedUser: null, totalUserCount: 3, view: { filteredCount: 0, query: "missing" } });
    view.rerender(<AdminUsersSection {...filtered.props} />);
    expect(screen.getByText("No users match this view")).toBeVisible();
    expect(screen.queryByText("No users yet")).not.toBeInTheDocument();
  });

  it("delegates search, filter, every sort key, pagination, and selection", () => {
    const user = createUser();
    const fixture = createFixture({
      pageUsers: [user],
      selectedUser: user,
      view: { filteredCount: 51, pageCount: 3, pageEnd: 26, pageIndex: 1, pageStart: 26 }
    });
    render(<AdminUsersSection {...fixture.props} />);

    fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "pending@example.com" } });
    fireEvent.click(within(screen.getByRole("group", { name: "User status filters" })).getByRole("button", { name: "pending" }));
    for (const sortKey of ["status", "role", "groups", "access", "lastSession", "user"]) {
      fireEvent.change(screen.getByLabelText("Sort users"), { target: { value: sortKey } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Asc" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous users page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next users page" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(fixture.actions.onQueryChange).toHaveBeenCalledWith("pending@example.com");
    expect(fixture.actions.onStatusFilterChange).toHaveBeenCalledWith("pending");
    expect(fixture.actions.onSort).toHaveBeenCalledWith("lastSession");
    expect(fixture.actions.onPreviousPage).toHaveBeenCalledTimes(1);
    expect(fixture.actions.onNextPage).toHaveBeenCalledTimes(1);
    expect(fixture.actions.onSelectUser).toHaveBeenCalledWith(user.id);
  });

  it("keeps refs on the selected detail and delegates pending lifecycle actions", () => {
    const pending = createUser({
      deletion: { canDelete: true, reason: null, summary: "No app-owned records detected; auth request data can be removed." },
      displayName: "Pending User",
      email: "pending@example.com",
      groups: [],
      id: "user-pending",
      status: "pending"
    });
    const fixture = createFixture({ pageUsers: [pending], selectedUser: pending, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} />);

    expect(fixture.detail.current).toBe(screen.getByTestId("admin-user-detail"));
    expect(fixture.detail.current?.tagName).toBe("ARTICLE");
    expect(fixture.groupsEditor.current).toBe(screen.getByTestId("admin-user-groups-editor"));
    expect(screen.queryByRole("checkbox", { name: "Archived group" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Operators" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve user" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject user" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete stale user" }));

    expect(fixture.actions.onSelectedUserGroupsChange).toHaveBeenCalledWith(pending.id, ["group-operators"]);
    expect(fixture.actions.onApprove).toHaveBeenCalledWith(pending);
    expect(fixture.actions.onRequestReject).toHaveBeenCalledWith(pending);
    expect(fixture.actions.onRequestDelete).toHaveBeenCalledWith(pending);
  });

  it("keeps active mutations in detail and disables them while another action runs", () => {
    const active = createUser();
    const fixture = createFixture({ pageUsers: [active], selectedUser: active, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} status={{ actionsDisabled: true }} />);

    expect(screen.getByRole("button", { name: "Details" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save groups" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke sessions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disable user" })).toBeDisabled();
  });

  it("keeps catalog-backed model rows and collapses missing model grants into one truthful disclosure", () => {
    const active = createUser({
      effectiveEntitlements: {
        models: [
          { modelId: "gpt-5.5", provider: "openai" },
          { modelId: "retired-alpha", provider: "legacy-openai" },
          { modelId: "retired-beta", provider: "legacy-anthropic" }
        ],
        providers: ["openai"],
        searchStrategies: ["web"]
      }
    });
    const fixture = createFixture({ pageUsers: [active], selectedUser: active, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} />);

    expect(screen.getByText("OpenAI / GPT 5.5")).toBeVisible();
    expect(screen.queryByText("Unavailable provider / Unavailable model")).not.toBeInTheDocument();

    const summary = screen.getByText("2 unavailable model grants");
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(summary);

    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("legacy-openai / retired-alpha")).toBeVisible();
    expect(screen.getByText("legacy-anthropic / retired-beta")).toBeVisible();
    expect(screen.getByText(/remain effective records/)).toBeVisible();
  });

  it("keeps the acting admin read-only", () => {
    const currentAdmin = createUser({ displayName: "Current Admin", email: "admin@example.com", id: "admin-current", role: "admin" });
    const fixture = createFixture({ pageUsers: [currentAdmin], selectedUser: currentAdmin, view: { compactDetailOpen: true } });
    render(<AdminUsersSection {...fixture.props} />);

    expect(screen.getByText("You")).toBeVisible();
    expect(screen.getByText(/Acting admin/)).toBeVisible();
    expect(screen.getByText(/self-disable and self-delete are not exposed/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save groups" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Revoke/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Disable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });
});
