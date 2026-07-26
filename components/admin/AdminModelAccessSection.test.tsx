import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import {
  AdminModelAccessSection,
  type AdminModelAccessSectionActions,
  type AdminModelAccessSectionProps
} from "./AdminModelAccessSection";

const catalog: AdminCatalog = {
  models: [{ displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" }],
  providers: [{ id: "openai", name: "OpenAI" }],
  searchStrategies: [{ displayName: "OpenAI web search", strategyId: "openai-web-search" }]
};

const activeGroup: AdminGroup = {
  accessGrants: [
    {
      enabled: true,
      groupId: "group-active",
      id: "grant-provider",
      modelId: null,
      provider: "openai",
      searchStrategy: null,
      userId: null
    }
  ],
  archivedAt: null,
  id: "group-active",
  name: "Operators",
  userCount: 2
};

const archivedGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Former operators",
  userCount: 0
};

function createActions(): AdminModelAccessSectionActions {
  return {
    onBackToList: vi.fn<AdminModelAccessSectionActions["onBackToList"]>(),
    onQueryChange: vi.fn<AdminModelAccessSectionActions["onQueryChange"]>(),
    onSelectGroup: vi.fn<AdminModelAccessSectionActions["onSelectGroup"]>(),
    onToggleGrant: vi.fn<AdminModelAccessSectionActions["onToggleGrant"]>(),
    onToggleProviderModels: vi.fn<AdminModelAccessSectionActions["onToggleProviderModels"]>()
  };
}

function activeProps(
  actions: AdminModelAccessSectionActions,
  detailRef: AdminModelAccessSectionProps["refs"]["detail"]
): AdminModelAccessSectionProps {
  return {
    actions,
    data: {
      catalog,
      selectedGroup: activeGroup,
      totalGroupCount: 2,
      visibleGroups: [activeGroup, archivedGroup]
    },
    draft: {
      compactDetailOpen: false,
      query: ""
    },
    refs: {
      detail: detailRef
    },
    status: {
      actionsDisabled: false
    }
  };
}

describe("AdminModelAccessSection", () => {
  it("keeps the grant regions and detail ref while delegating selection and every grant shape", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLDivElement>();
    render(<AdminModelAccessSection {...activeProps(actions, detailRef)} />);

    const list = screen.getByTestId("admin-model-access-group-list");
    expect(within(list).getByRole("button", { name: "Select Operators" })).toHaveAttribute("aria-pressed", "true");
    expect(within(list).getByRole("button", { name: "Select Operators" })).toHaveAttribute(
      "aria-controls",
      "admin-model-access-selected-group"
    );
    expect(within(list).getByRole("button", { name: "Select Former operators" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    const detail = screen.getByTestId("admin-model-access-group");
    expect(detailRef.current).toBe(detail);
    expect(detail.tagName).toBe("DIV");
    expect(detail).toHaveAttribute("id", "admin-model-access-selected-group");
    expect(detail).toHaveAttribute("aria-label", "Model access for Operators");
    expect(detail).toHaveAttribute("role", "region");
    expect(detail).toHaveAttribute("tabindex", "-1");

    expect(screen.getByRole("heading", { name: "Provider-wide access" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Explicit model grants" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Search strategy grants" })).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("openai:gpt-5.5")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search model access groups"), { target: { value: "former" } });
    expect(actions.onQueryChange).toHaveBeenCalledWith("former");
    fireEvent.click(within(list).getByRole("button", { name: "Select Former operators" }));
    expect(actions.onSelectGroup).toHaveBeenCalledWith(archivedGroup.id);

    const providerGrant = screen.getByRole("button", { name: "Grant provider OpenAI" });
    expect(providerGrant).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(providerGrant);
    expect(actions.onToggleGrant).toHaveBeenCalledWith(activeGroup, { provider: "openai" }, false);

    fireEvent.click(screen.getByRole("button", { name: "Grant model OpenAI / GPT 5.5" }));
    expect(actions.onToggleGrant).toHaveBeenCalledWith(
      activeGroup,
      { modelId: "gpt-5.5", provider: "openai" },
      true
    );

    fireEvent.click(screen.getByRole("button", { name: "Grant search OpenAI web search" }));
    expect(actions.onToggleGrant).toHaveBeenCalledWith(
      activeGroup,
      { searchStrategy: "openai-web-search" },
      true
    );

    fireEvent.click(screen.getByRole("button", { name: "Grant all OpenAI models to Operators" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear OpenAI models from Operators" }));
    expect(actions.onToggleProviderModels).toHaveBeenNthCalledWith(1, activeGroup, "openai", true);
    expect(actions.onToggleProviderModels).toHaveBeenNthCalledWith(2, activeGroup, "openai", false);
  });

  it("distinguishes no groups from a filtered empty selection without mounting a stale ref", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLDivElement>();
    const props: AdminModelAccessSectionProps = {
      actions,
      data: {
        catalog,
        selectedGroup: null,
        totalGroupCount: 0,
        visibleGroups: []
      },
      draft: {
        compactDetailOpen: false,
        query: ""
      },
      refs: {
        detail: detailRef
      },
      status: {
        actionsDisabled: false
      }
    };
    const { rerender } = render(<AdminModelAccessSection {...props} />);

    expect(screen.getByText("No groups")).toBeVisible();
    expect(screen.getByText("Create a group before assigning provider, model, search, or MCP access.")).toBeVisible();
    expect(screen.queryByTestId("admin-model-access-group-list")).not.toBeInTheDocument();
    expect(detailRef.current).toBeNull();

    rerender(
      <AdminModelAccessSection
        {...props}
        data={{
          ...props.data,
          totalGroupCount: 1
        }}
        draft={{ compactDetailOpen: false, query: "missing" }}
      />
    );

    expect(screen.getByTestId("admin-model-access-group-list")).toBeVisible();
    expect(screen.getByLabelText("Search model access groups")).toHaveValue("missing");
    expect(screen.getByText("No groups match this view")).toBeVisible();
    expect(screen.getByText("No group selected")).toBeVisible();
    expect(screen.queryByTestId("admin-model-access-group")).not.toBeInTheDocument();
    expect(detailRef.current).toBeNull();
  });

  it("disables archived and busy grant mutations without blocking group selection", () => {
    const actions = createActions();
    const detailRef = createRef<HTMLDivElement>();
    const props: AdminModelAccessSectionProps = {
      actions,
      data: {
        catalog,
        selectedGroup: archivedGroup,
        totalGroupCount: 1,
        visibleGroups: [archivedGroup]
      },
      draft: {
        compactDetailOpen: true,
        query: ""
      },
      refs: {
        detail: detailRef
      },
      status: {
        actionsDisabled: false
      }
    };
    const { rerender } = render(<AdminModelAccessSection {...props} />);

    expect(
      screen.getByText("Archived groups do not apply grants. Grant editing is disabled for this group.")
    ).toBeVisible();
    const archivedMutationButtons = [
      screen.getByRole("button", { name: "Grant provider OpenAI" }),
      screen.getByRole("button", { name: "Grant model OpenAI / GPT 5.5" }),
      screen.getByRole("button", { name: "Grant search OpenAI web search" }),
      screen.getByRole("button", { name: "Grant all OpenAI models to Former operators" }),
      screen.getByRole("button", { name: "Clear OpenAI models from Former operators" })
    ];
    archivedMutationButtons.forEach((button) => expect(button).toBeDisabled());
    const firstArchivedMutation = archivedMutationButtons[0];
    if (!firstArchivedMutation) {
      throw new Error("Expected archived mutation control");
    }
    fireEvent.click(firstArchivedMutation);
    expect(actions.onToggleGrant).not.toHaveBeenCalled();

    const selectButton = screen.getByRole("button", { name: "Select Former operators" });
    expect(selectButton).toBeEnabled();
    fireEvent.click(selectButton);
    expect(actions.onSelectGroup).toHaveBeenCalledWith(archivedGroup.id);

    rerender(
      <AdminModelAccessSection
        {...activeProps(actions, detailRef)}
        status={{ actionsDisabled: true }}
      />
    );

    expect(screen.queryByText("Archived groups do not apply grants. Grant editing is disabled for this group.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grant provider OpenAI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Grant model OpenAI / GPT 5.5" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Grant search OpenAI web search" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Grant all OpenAI models to Operators" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear OpenAI models from Operators" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Select Former operators" })).toBeEnabled();
  });
});
