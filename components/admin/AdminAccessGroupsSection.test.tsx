import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminCatalog, AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import {
  AdminAccessGroupsSection,
  type AdminAccessGroupsSectionActions,
  type AdminAccessGroupsSectionProps
} from "./AdminAccessGroupsSection";

const catalog: AdminCatalog = {
  models: [{ displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" }],
  providers: [{ id: "openai", name: "OpenAI" }],
  searchStrategies: [{ displayName: "OpenAI web search", strategyId: "openai-web-search" }]
};

const activeGroup: AdminGroup = {
  accessGrants: [{
    enabled: true,
    groupId: "group-active",
    id: "grant-provider",
    modelId: null,
    provider: "openai",
    searchStrategy: null,
    userId: null
  }],
  archivedAt: null,
  deletion: { canDelete: false, reason: "group_has_members", summary: "Remove members before deleting this group." },
  id: "group-active",
  name: "Operators",
  systemRole: null,
  userCount: 1
};

const archivedGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: "2026-07-01T00:00:00.000Z",
  deletion: { canDelete: true, reason: null, summary: "No members or active grants; this group can be deleted." },
  id: "group-archived",
  name: "Former operators",
  systemRole: null,
  userCount: 0
};

const fullAccessGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  deletion: {
    canDelete: false,
    reason: "system_group_forbidden",
    summary: "Full access is built in and cannot be renamed, archived, or deleted."
  },
  id: "group-full-access",
  name: "Full access",
  systemRole: "full_access",
  userCount: 1
};

const member: AdminUserRecord = {
  displayName: "Ada Operator",
  effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
  email: "ada@example.com",
  groups: [{ groupId: activeGroup.id, name: activeGroup.name, role: "member" }],
  hasVerifiedIdentity: true,
  id: "user-ada",
  lastSessionAt: null,
  role: "user",
  status: "active"
};

const candidate: AdminUserRecord = {
  ...member,
  displayName: "Grace Reviewer",
  email: "grace@example.com",
  groups: [],
  id: "user-grace"
};

function createActions(): AdminAccessGroupsSectionActions {
  return {
    onAddMember: vi.fn(),
    onBackToList: vi.fn(),
    onCreateNameChange: vi.fn(),
    onCreateSubmit: vi.fn(),
    onQueryChange: vi.fn(),
    onRenameNameChange: vi.fn(),
    onRenameSubmit: vi.fn(),
    onRemoveMember: vi.fn(),
    onRequestArchive: vi.fn(),
    onRequestDelete: vi.fn(),
    onSelectGroup: vi.fn(),
    onSelectView: vi.fn(),
    onStartRenaming: vi.fn(),
    onStatusFilterChange: vi.fn(),
    onToggleGrant: vi.fn(),
    onToggleProviderModels: vi.fn()
  };
}

function createProps(overrides: Partial<AdminAccessGroupsSectionProps> = {}): AdminAccessGroupsSectionProps {
  return {
    actions: createActions(),
    data: {
      allGroups: [activeGroup, archivedGroup],
      allUsers: [member, candidate],
      catalog,
      selectedGroup: null,
      selectedGroupMembers: [],
      visibleGroups: [activeGroup, archivedGroup]
    },
    draft: {
      activeView: "overview",
      createFormOpen: false,
      createName: "",
      detailOpen: false,
      query: "",
      renameName: "",
      renamingGroupId: null,
      statusFilter: "all"
    },
    refs: { detail: createRef<HTMLElement>() },
    status: { actionsDisabled: false, createError: null, renameError: null },
    ...overrides
  };
}

describe("AdminAccessGroupsSection", () => {
  it("renders a full-width directory with clickable rows and no auto-open detail", () => {
    const actions = createActions();
    render(<AdminAccessGroupsSection {...createProps({ actions })} />);

    expect(screen.getByTestId("admin-access-groups-index")).toBeVisible();
    expect(screen.queryByTestId("admin-access-group-detail")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search access groups"), { target: { value: "former" } });
    fireEvent.click(screen.getByRole("button", { name: "archived" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Former operators" }));

    expect(actions.onQueryChange).toHaveBeenCalledWith("former");
    expect(actions.onStatusFilterChange).toHaveBeenCalledWith("archived");
    expect(actions.onSelectGroup).toHaveBeenCalledWith(archivedGroup.id);
  });

  it("renders group creation as a dedicated Back-connected task", () => {
    const actions = createActions();
    render(
      <AdminAccessGroupsSection
        {...createProps({ actions })}
        draft={{
          activeView: "overview",
          createFormOpen: true,
          createName: "Draft group",
          detailOpen: true,
          query: "",
          renameName: "",
          renamingGroupId: null,
          statusFilter: "active"
        }}
        status={{ actionsDisabled: false, createError: "Create error", renameError: null }}
      />
    );

    expect(screen.queryByTestId("admin-access-groups-index")).not.toBeInTheDocument();
    const input = screen.getByLabelText("Group name");
    expect(input).toHaveValue("Draft group");
    expect(input).toHaveAccessibleDescription("Create error");
    fireEvent.change(input, { target: { value: "Reviewers" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "Back to access groups" }));

    expect(actions.onCreateNameChange).toHaveBeenCalledWith("Reviewers");
    expect(actions.onCreateSubmit).toHaveBeenCalledTimes(1);
    expect(actions.onBackToList).toHaveBeenCalledTimes(1);
  });

  it("shows Overview with access summary and preserves lifecycle actions", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLElement>();
    render(
      <AdminAccessGroupsSection
        {...createProps({ actions, refs: { detail: detailRef } })}
        data={{
          allGroups: [activeGroup],
          allUsers: [member, candidate],
          catalog,
          selectedGroup: activeGroup,
          selectedGroupMembers: [member],
          visibleGroups: [activeGroup]
        }}
        draft={{
          activeView: "overview",
          createFormOpen: false,
          createName: "",
          detailOpen: true,
          query: "",
          renameName: "Operators",
          renamingGroupId: activeGroup.id,
          statusFilter: "active"
        }}
      />
    );

    const detail = screen.getByTestId("admin-access-group-detail");
    expect(detailRef.current).toBe(detail);
    expect(within(detail).getByRole("heading", { name: "Access overview" })).toBeVisible();
    fireEvent.click(within(detail).getByRole("button", { name: "Members" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Models & search" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Tools" }));
    fireEvent.change(within(detail).getByLabelText("Rename group"), { target: { value: "Retitled" } });
    fireEvent.submit(within(detail).getByLabelText("Rename group").closest("form")!);
    fireEvent.click(within(detail).getByRole("button", { name: "Rename group" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Archive group" }));

    expect(actions.onSelectView).toHaveBeenNthCalledWith(1, "members");
    expect(actions.onSelectView).toHaveBeenNthCalledWith(2, "models");
    expect(actions.onSelectView).toHaveBeenNthCalledWith(3, "tools");
    expect(actions.onRenameSubmit).toHaveBeenCalledWith(activeGroup);
    expect(actions.onRequestArchive).toHaveBeenCalledWith(activeGroup);
  });

  it("adds and removes members directly from the selected group", () => {
    const actions = createActions();
    render(
      <AdminAccessGroupsSection
        {...createProps({ actions })}
        data={{
          allGroups: [activeGroup],
          allUsers: [member, candidate],
          catalog,
          selectedGroup: activeGroup,
          selectedGroupMembers: [member],
          visibleGroups: [activeGroup]
        }}
        draft={{
          activeView: "members",
          createFormOpen: false,
          createName: "",
          detailOpen: true,
          query: "",
          renameName: "",
          renamingGroupId: null,
          statusFilter: "active"
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Add member"), { target: { value: candidate.id } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    fireEvent.click(within(screen.getByText(member.displayName).closest("div.border-b")!).getByRole("button", { name: "Remove" }));

    expect(actions.onAddMember).toHaveBeenCalledWith(activeGroup, candidate);
    expect(actions.onRemoveMember).toHaveBeenCalledWith(activeGroup, member);
  });

  it("keeps provider, model, search, and bulk grant actions in Models & search", () => {
    const actions = createActions();
    render(
      <AdminAccessGroupsSection
        {...createProps({ actions })}
        data={{
          allGroups: [activeGroup],
          allUsers: [member, candidate],
          catalog,
          selectedGroup: activeGroup,
          selectedGroupMembers: [member],
          visibleGroups: [activeGroup]
        }}
        draft={{
          activeView: "models",
          createFormOpen: false,
          createName: "",
          detailOpen: true,
          query: "",
          renameName: "",
          renamingGroupId: null,
          statusFilter: "active"
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Grant provider OpenAI" }));
    fireEvent.click(screen.getByRole("button", { name: "Grant model OpenAI / GPT 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Grant search OpenAI web search" }));
    fireEvent.click(screen.getByRole("button", { name: "Grant all OpenAI models to Operators" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear OpenAI models from Operators" }));

    expect(actions.onToggleGrant).toHaveBeenNthCalledWith(1, activeGroup, { provider: "openai" }, false);
    expect(actions.onToggleGrant).toHaveBeenNthCalledWith(2, activeGroup, { modelId: "gpt-5.5", provider: "openai" }, true);
    expect(actions.onToggleGrant).toHaveBeenNthCalledWith(3, activeGroup, { searchStrategy: "openai-web-search" }, true);
    expect(actions.onToggleProviderModels).toHaveBeenNthCalledWith(1, activeGroup, "openai", true);
    expect(actions.onToggleProviderModels).toHaveBeenNthCalledWith(2, activeGroup, "openai", false);
  });

  it("marks Full access as built in and removes ordinary lifecycle and grant controls", () => {
    const actions = createActions();
    const props = createProps({ actions });
    const view = render(
      <AdminAccessGroupsSection
        {...props}
        data={{
          ...props.data,
          allGroups: [fullAccessGroup],
          selectedGroup: fullAccessGroup,
          selectedGroupMembers: [member],
          visibleGroups: [fullAccessGroup]
        }}
        draft={{ ...props.draft, detailOpen: true }}
      />
    );

    expect(screen.getByText("Built-in")).toBeVisible();
    expect(screen.getByText(/all current and future providers, models, search strategies, and MCP servers/i)).toBeVisible();
    expect(screen.getByText(/provider credentials and personal MCP setup remain separate/i)).toBeVisible();
    expect(screen.getByText(/cannot be renamed, archived, or deleted/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rename group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete group" })).not.toBeInTheDocument();

    view.rerender(
      <AdminAccessGroupsSection
        {...props}
        data={{
          ...props.data,
          allGroups: [fullAccessGroup],
          selectedGroup: fullAccessGroup,
          selectedGroupMembers: [member],
          visibleGroups: [fullAccessGroup]
        }}
        draft={{ ...props.draft, activeView: "models", detailOpen: true }}
      />
    );

    expect(screen.getByRole("heading", { name: "Automatic full access" })).toBeVisible();
    expect(screen.getByText(/independently selected provider credential and its current availability check are valid/i)).toBeVisible();
    expect(screen.getByText(/there are no per-resource switches/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Grant provider/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Grant model/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Grant search/i })).not.toBeInTheDocument();
    expect(actions.onToggleGrant).not.toHaveBeenCalled();
  });

  it("places MCP access under Tools and disables archived grant mutations", () => {
    const actions = createActions();
    const props = createProps({ actions });
    const { rerender } = render(
      <AdminAccessGroupsSection
        {...props}
        data={{ ...props.data, selectedGroup: activeGroup }}
        draft={{ ...props.draft, activeView: "tools", detailOpen: true }}
        mcpAccess={<section data-testid="group-tools">MCP grants</section>}
      />
    );
    expect(screen.getByTestId("group-tools")).toBeVisible();

    rerender(
      <AdminAccessGroupsSection
        {...props}
        data={{ ...props.data, selectedGroup: archivedGroup }}
        draft={{ ...props.draft, activeView: "models", detailOpen: true }}
      />
    );
    expect(screen.getByText("Archived groups do not apply grants. Access editing is disabled for this group.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Grant provider OpenAI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Grant model OpenAI / GPT 5.5" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Grant search OpenAI web search" })).toBeDisabled();
  });

  it("distinguishes an empty directory from filtered empty results", () => {
    const props = createProps();
    const view = render(
      <AdminAccessGroupsSection
        {...props}
        data={{ ...props.data, allGroups: [], visibleGroups: [] }}
      />
    );
    expect(screen.getByText("No access groups")).toBeVisible();
    expect(screen.queryByText("Group unavailable")).not.toBeInTheDocument();

    view.rerender(
      <AdminAccessGroupsSection
        {...props}
        data={{ ...props.data, visibleGroups: [] }}
        draft={{ ...props.draft, query: "missing" }}
      />
    );
    expect(screen.getByText("No groups match this view")).toBeVisible();
  });
});
