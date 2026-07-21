import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import {
  AdminGroupsSection,
  type AdminGroupsSectionActions,
  type AdminGroupsSectionProps
} from "./AdminGroupsSection";

const catalog: AdminCatalog = {
  models: [{ displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" }],
  providers: [{ id: "openai", name: "OpenAI" }],
  searchStrategies: [{ displayName: "Web search", strategyId: "web-search" }]
};

const activeGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  deletion: {
    canDelete: true,
    reason: null,
    summary: "No members or active grants; this group can be deleted."
  },
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
    onCreateNameChange: vi.fn<AdminGroupsSectionActions["onCreateNameChange"]>(),
    onCreateSubmit: vi.fn<AdminGroupsSectionActions["onCreateSubmit"]>(),
    onQueryChange: vi.fn<AdminGroupsSectionActions["onQueryChange"]>(),
    onRenameNameChange: vi.fn<AdminGroupsSectionActions["onRenameNameChange"]>(),
    onRenameSubmit: vi.fn<AdminGroupsSectionActions["onRenameSubmit"]>(),
    onRequestArchive: vi.fn<AdminGroupsSectionActions["onRequestArchive"]>(),
    onRequestDelete: vi.fn<AdminGroupsSectionActions["onRequestDelete"]>(),
    onSelectGroup: vi.fn<AdminGroupsSectionActions["onSelectGroup"]>(),
    onStartRenaming: vi.fn<AdminGroupsSectionActions["onStartRenaming"]>(),
    onStatusFilterChange: vi.fn<AdminGroupsSectionActions["onStatusFilterChange"]>()
  };
}

function activeProps(
  actions: AdminGroupsSectionActions,
  detailRef: AdminGroupsSectionProps["refs"]["detail"]
): AdminGroupsSectionProps {
  return {
    actions,
    data: {
      allGroups: [activeGroup, archivedGroup],
      catalog,
      selectedGroup: activeGroup,
      visibleGroups: [activeGroup, archivedGroup]
    },
    draft: {
      createFormOpen: true,
      createName: "Draft group",
      query: "",
      renameName: "Operators",
      renamingGroupId: activeGroup.id,
      statusFilter: "all"
    },
    refs: {
      detail: detailRef
    },
    status: {
      actionsDisabled: false,
      createError: "Create error",
      renameError: "Rename error"
    }
  };
}

describe("AdminGroupsSection", () => {
  it("keeps the table and detail ref boundaries while delegating group workflows", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLElement>();
    const props = activeProps(actions, detailRef);
    const { rerender } = render(<AdminGroupsSection {...props} />);

    const tableRegion = screen.getByRole("region", { name: "Groups table" });
    expect(tableRegion).toHaveAttribute("tabindex", "0");
    expect(within(tableRegion).getByRole("table")).toBeVisible();
    expect(within(tableRegion).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Group",
      "Users",
      "Access",
      "Status",
      "Actions"
    ]);

    const detail = screen.getByTestId("admin-group-detail");
    expect(detailRef.current).toBe(detail);
    expect(detail.tagName).toBe("ASIDE");
    expect(detail).toHaveAttribute("aria-label", "Selected group Operators");
    expect(detail).toHaveAttribute("tabindex", "-1");

    const createInput = screen.getByLabelText("Group name");
    expect(createInput).toHaveValue("Draft group");
    expect(createInput).toHaveAttribute("aria-invalid", "true");
    expect(createInput).toHaveAccessibleDescription("Create error");
    fireEvent.change(createInput, { target: { value: "Reviewers" } });
    expect(actions.onCreateNameChange).toHaveBeenCalledWith("Reviewers");
    const createForm = createInput.closest("form");
    if (!createForm) {
      throw new Error("Expected create-group form");
    }
    fireEvent.submit(createForm);
    expect(actions.onCreateSubmit).toHaveBeenCalledTimes(1);

    const renameInput = screen.getByLabelText("Rename group");
    expect(renameInput).toHaveValue("Operators");
    expect(renameInput).toHaveAttribute("name", "name");
    expect(renameInput).toHaveAccessibleDescription("Rename error");
    fireEvent.change(renameInput, { target: { value: "Retitled operators" } });
    expect(actions.onRenameNameChange).toHaveBeenCalledWith("Retitled operators");

    rerender(
      <AdminGroupsSection
        {...props}
        draft={{
          ...props.draft,
          createName: "Parent-controlled name",
          renameName: "Retitled operators"
        }}
      />
    );

    expect(screen.getByLabelText("Group name")).toHaveValue("Parent-controlled name");
    expect(screen.getByLabelText("Rename group")).toHaveValue("Retitled operators");
    const renameForm = screen.getByLabelText("Rename group").closest("form");
    if (!renameForm) {
      throw new Error("Expected rename-group form");
    }
    fireEvent.submit(renameForm);
    expect(actions.onRenameSubmit).toHaveBeenCalledWith(activeGroup);

    fireEvent.change(screen.getByLabelText("Search groups"), { target: { value: "former" } });
    expect(actions.onQueryChange).toHaveBeenCalledWith("former");
    fireEvent.click(screen.getByRole("button", { name: "archived" }));
    expect(actions.onStatusFilterChange).toHaveBeenCalledWith("archived");

    const archivedRow = screen.getByText("Former operators").closest("tr");
    if (!archivedRow) {
      throw new Error("Expected archived group row");
    }
    fireEvent.click(within(archivedRow).getByRole("button", { name: "Select" }));
    expect(actions.onSelectGroup).toHaveBeenCalledWith(archivedGroup.id);

    fireEvent.click(within(detail).getByRole("button", { name: "Rename group" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Delete group" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Archive group" }));
    expect(actions.onStartRenaming).toHaveBeenCalledWith(activeGroup);
    expect(actions.onRequestDelete).toHaveBeenCalledWith(activeGroup);
    expect(actions.onRequestArchive).toHaveBeenCalledWith(activeGroup);
  });

  it("keeps the two distinct empty states and the deliberate table row mounted", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLElement>();
    const props: AdminGroupsSectionProps = {
      actions,
      data: {
        allGroups: [],
        catalog,
        selectedGroup: null,
        visibleGroups: []
      },
      draft: {
        createFormOpen: false,
        createName: "",
        query: "",
        renameName: "",
        renamingGroupId: null,
        statusFilter: "active"
      },
      refs: {
        detail: detailRef
      },
      status: {
        actionsDisabled: false,
        createError: null,
        renameError: null
      }
    };
    const { rerender } = render(<AdminGroupsSection {...props} />);

    expect(screen.getByText("No groups").closest("td")).toHaveAttribute("colspan", "5");
    expect(screen.getByText("No group selected").closest("aside")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Groups table" })).toBeVisible();
    expect(detailRef.current).toBeNull();

    rerender(
      <AdminGroupsSection
        {...props}
        data={{
          ...props.data,
          allGroups: [activeGroup]
        }}
      />
    );

    expect(screen.getByText("No groups match this view").closest("td")).toHaveAttribute("colspan", "5");
  });

  it("disables active mutations while busy and keeps archived-only actions absent", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLElement>();
    const { rerender } = render(
      <AdminGroupsSection
        actions={actions}
        data={{
          allGroups: [activeGroup],
          catalog,
          selectedGroup: activeGroup,
          visibleGroups: [activeGroup]
        }}
        draft={{
          createFormOpen: true,
          createName: "Draft",
          query: "",
          renameName: "Operators draft",
          renamingGroupId: activeGroup.id,
          statusFilter: "active"
        }}
        refs={{ detail: detailRef }}
        status={{
          actionsDisabled: true,
          createError: null,
          renameError: null
        }}
      />
    );

    expect(detailRef.current).toBe(screen.getByTestId("admin-group-detail"));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename group" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete group" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive group" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Select" })).toBeEnabled();

    rerender(
      <AdminGroupsSection
        actions={actions}
        data={{
          allGroups: [archivedGroup],
          catalog,
          selectedGroup: archivedGroup,
          visibleGroups: [archivedGroup]
        }}
        draft={{
          createFormOpen: false,
          createName: "",
          query: "",
          renameName: "",
          renamingGroupId: null,
          statusFilter: "archived"
        }}
        refs={{ detail: detailRef }}
        status={{
          actionsDisabled: true,
          createError: null,
          renameError: null
        }}
      />
    );

    expect(
      screen.getByText(
        "Archived groups remain visible for history. Their grants no longer apply, and grant editing is disabled."
      )
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rename group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive group" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete group" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(actions.onRequestDelete).not.toHaveBeenCalled();
  });
});
