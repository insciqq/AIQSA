import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { adminSectionPanelId, adminSections, adminSectionTabId } from "./adminSections";
import { AdminInactiveSectionPanels, AdminSectionTabs } from "./AdminSectionTabs";
import type { AdminSectionNavigation } from "./useAdminSectionNavigation";
import type { AdminDashboard } from "@/lib/contracts/admin";

function navigation(
  activeSection: AdminSectionNavigation["activeSection"]
): Pick<
  AdminSectionNavigation,
  "activeSection" | "closeSectionIndex" | "onTabKeyDown" | "registerTab" | "selectSection"
> {
  return {
    activeSection,
    closeSectionIndex: vi.fn<AdminSectionNavigation["closeSectionIndex"]>(),
    onTabKeyDown: vi.fn<AdminSectionNavigation["onTabKeyDown"]>(),
    registerTab: vi.fn<AdminSectionNavigation["registerTab"]>(),
    selectSection: vi.fn<AdminSectionNavigation["selectSection"]>()
  };
}

const personalSummary = {
  advancedConfigured: false,
  attention: {
    activeUsersWithoutModelAccess: 0,
    openInvites: 0,
    pendingUsers: 0
  },
  teamConfigured: false
} satisfies AdminDashboard["navigation"];

const teamSummary = {
  advancedConfigured: true,
  attention: {
    activeUsersWithoutModelAccess: 1,
    openInvites: 2,
    pendingUsers: 1
  },
  teamConfigured: true
} satisfies AdminDashboard["navigation"];

describe("AdminSectionTabs", () => {
  it("renders one semantic roving tab for every registered section", () => {
    const tabs = navigation("invites");
    render(
      <>
        <AdminSectionTabs navigation={tabs} />
        <section
          aria-labelledby={adminSectionTabId("invites")}
          id={adminSectionPanelId("invites")}
          role="tabpanel"
        />
        <AdminInactiveSectionPanels activeSection="invites" />
      </>
    );

    expect(screen.getByRole("tablist", { name: "Control Center sections" })).toBeVisible();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(adminSections.map((section) => section.label));
    expect(screen.getByRole("tab", { name: "Invites" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Invites" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

    for (const section of adminSections) {
      const tab = screen.getByRole("tab", { name: section.label });
      const panelId = tab.getAttribute("aria-controls");
      expect(tab).toHaveAttribute("id", adminSectionTabId(section.id));
      expect(panelId).toBe(adminSectionPanelId(section.id));
      if (!panelId) {
        throw new Error(`Expected panel id for ${section.id}`);
      }
      expect(document.getElementById(panelId)).toHaveAttribute("aria-labelledby", adminSectionTabId(section.id));
    }
  });

  it("delegates pointer and keyboard intents without owning controller state", () => {
    const tabs = navigation("users");
    render(<AdminSectionTabs navigation={tabs} />);

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(tabs.selectSection).toHaveBeenCalledWith("groups");

    const eventAccepted = fireEvent.keyDown(screen.getByRole("tab", { name: "Users" }), { key: "ArrowRight" });
    expect(eventAccepted).toBe(true);
    expect(tabs.onTabKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "ArrowRight" }), "users");
  });

  it("collapses proven-unused groups while keeping a direct active destination visible", () => {
    const tabs = navigation("users");
    render(<AdminSectionTabs navigation={tabs} summary={personalSummary} />);

    expect(screen.getByTestId("admin-nav-group-personal")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("admin-nav-group-team")).toHaveAttribute("data-expanded", "false");
    expect(screen.getByTestId("admin-nav-group-advanced")).toHaveAttribute("data-expanded", "false");
    expect(screen.getByRole("tab", { name: "Providers" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Groups" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "MCP servers" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(screen.getByTestId("admin-nav-group-team")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByRole("tab", { name: "Groups" })).toBeVisible();
  });

  it("expands configured groups, keeps contextual attention, and preserves a manual override on refresh", () => {
    const tabs = navigation("providers");
    const view = render(<AdminSectionTabs navigation={tabs} summary={teamSummary} />);

    expect(screen.getByTestId("admin-nav-group-team")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("admin-nav-group-advanced")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByRole("button", { name: /Team/ })).toHaveTextContent("4 items");
    expect(screen.getByRole("tab", { name: "Users" })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: "Invites" })).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.getByTestId("admin-nav-group-advanced")).toHaveAttribute("data-expanded", "false");
    view.rerender(<AdminSectionTabs navigation={tabs} summary={{ ...teamSummary }} />);
    expect(screen.getByTestId("admin-nav-group-advanced")).toHaveAttribute("data-expanded", "false");
  });
});
