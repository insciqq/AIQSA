import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import { AdminGroupsSection, type AdminGroupsSectionActions, type AdminGroupsSectionProps } from "./AdminGroupsSection";

const catalog: AdminCatalog = {
  models: [{ displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" }],
  providers: [{ id: "openai", name: "OpenAI" }],
  searchStrategies: [{ displayName: "Web search", strategyId: "web-search" }]
};

const activeGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  deletion: { canDelete: true, reason: null, summary: "No members or active grants; this group can be deleted." },
  id: "group-active",
  name: "Operators",
  userCount: 0
};

const archivedGroup: AdminGroup = {
  ...activeGroup,
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Former operators"
};

function createActions(): AdminGroupsSectionActions {
  return {
    onBackToList: vi.fn(),
    onCreateNameChange: vi.fn(),
    onCreateSubmit: vi.fn(),
    onQueryChange: vi.fn(),
    onRenameNameChange: vi.fn(),
    onRenameSubmit: vi.fn(),
    onRequestArchive: vi.fn(),
    onRequestDelete: vi.fn(),
    onSelectGroup: vi.fn(),
    onStartRenaming: vi.fn(),
    onStatusFilterChange: vi.fn()
  };
}

function createProps(overrides: Partial<AdminGroupsSectionProps> = {}): AdminGroupsSectionProps {
  return {
    actions: createActions(),
    data: {
      allGroups: [activeGroup, archivedGroup],
      catalog,
      selectedGroup: activeGroup,
      visibleGroups: [activeGroup, archivedGroup]
    },
    draft: {
      compactDetailOpen: false,
      createFormOpen: false,
      createName: "",
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

describe("AdminGroupsSection", () => {
  it("keeps the list and selected detail mounted and delegates list controls", () => {
    const actions = createActions();
    const props = createProps({ actions });
    render(<AdminGroupsSection {...props} />);

    expect(screen.getByTestId("admin-groups-index")).toHaveClass("block", "lg:block");
    expect(screen.getByTestId("admin-groups-detail-pane")).toHaveClass("hidden", "lg:block");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search groups"), { target: { value: "former" } });
    fireEvent.click(screen.getByRole("button", { name: "archived" }));
    const archivedRow = screen.getAllByTestId("admin-group").filter((element) => element.textContent?.includes("Former operators"));
    expect(archivedRow).toHaveLength(1);
    fireEvent.click(within(archivedRow[0]!).getByRole("button", { name: "Details" }));

    expect(actions.onQueryChange).toHaveBeenCalledWith("former");
    expect(actions.onStatusFilterChange).toHaveBeenCalledWith("archived");
    expect(actions.onSelectGroup).toHaveBeenCalledWith(archivedGroup.id);
  });

  it("renders create as the deliberate detail task and preserves its controlled error", () => {
    const actions = createActions();
    render(
      <AdminGroupsSection
        {...createProps({ actions })}
        draft={{
          compactDetailOpen: true,
          createFormOpen: true,
          createName: "Draft group",
          query: "",
          renameName: "",
          renamingGroupId: null,
          statusFilter: "all"
        }}
        status={{ actionsDisabled: false, createError: "Create error", renameError: null }}
      />
    );

    expect(screen.getByTestId("admin-groups-index")).toHaveClass("hidden", "lg:block");
    expect(screen.getByTestId("admin-groups-detail-pane")).toHaveClass("block", "lg:block");
    const input = screen.getByLabelText("Group name");
    expect(input).toHaveValue("Draft group");
    expect(input).toHaveAccessibleDescription("Create error");
    fireEvent.change(input, { target: { value: "Reviewers" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "Back to groups" }));

    expect(actions.onCreateNameChange).toHaveBeenCalledWith("Reviewers");
    expect(actions.onCreateSubmit).toHaveBeenCalledTimes(1);
    expect(actions.onBackToList).toHaveBeenCalledTimes(1);
  });

  it("delegates rename, archive, and eligible delete from the selected group detail", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLElement>();
    render(
      <AdminGroupsSection
        {...createProps({ actions, refs: { detail: detailRef } })}
        draft={{
          compactDetailOpen: true,
          createFormOpen: false,
          createName: "",
          query: "",
          renameName: "Operators",
          renamingGroupId: activeGroup.id,
          statusFilter: "active"
        }}
        status={{ actionsDisabled: false, createError: null, renameError: "Rename error" }}
      />
    );

    const detail = screen.getByTestId("admin-group-detail");
    expect(detailRef.current).toBe(detail);
    expect(detail.tagName).toBe("ARTICLE");
    const rename = screen.getByLabelText("Rename group");
    expect(rename).toHaveAccessibleDescription("Rename error");
    fireEvent.change(rename, { target: { value: "Retitled operators" } });
    fireEvent.submit(rename.closest("form")!);
    fireEvent.click(within(detail).getByRole("button", { name: "Rename group" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Delete group" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Archive group" }));

    expect(actions.onRenameNameChange).toHaveBeenCalledWith("Retitled operators");
    expect(actions.onRenameSubmit).toHaveBeenCalledWith(activeGroup);
    expect(actions.onStartRenaming).toHaveBeenCalledWith(activeGroup);
    expect(actions.onRequestDelete).toHaveBeenCalledWith(activeGroup);
    expect(actions.onRequestArchive).toHaveBeenCalledWith(activeGroup);
  });

  it("distinguishes empty states and keeps archived lifecycle non-editable", () => {
    const actions = createActions();
    const view = render(
      <AdminGroupsSection
        {...createProps({ actions })}
        data={{ allGroups: [], catalog, selectedGroup: null, visibleGroups: [] }}
      />
    );
    expect(screen.getByText("No groups")).toBeVisible();
    expect(screen.getByText("No group selected")).toBeVisible();

    view.rerender(
      <AdminGroupsSection
        {...createProps({ actions })}
        data={{ allGroups: [archivedGroup], catalog, selectedGroup: archivedGroup, visibleGroups: [] }}
        draft={{
          compactDetailOpen: true,
          createFormOpen: false,
          createName: "",
          query: "missing",
          renameName: "",
          renamingGroupId: null,
          statusFilter: "archived"
        }}
        status={{ actionsDisabled: true, createError: null, renameError: null }}
      />
    );

    expect(screen.getByText("No groups match this view")).toBeVisible();
    expect(screen.getByText(/Archived groups remain visible for history/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rename group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive group" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete group" })).toBeDisabled();
  });
});
