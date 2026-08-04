import { fireEvent, render, screen, within } from "@testing-library/react";
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

const summary = {
  advancedConfigured: false,
  attention: {
    activeUsersWithoutModelAccess: 1,
    openInvites: 2,
    pendingUsers: 1
  },
  teamConfigured: false
} satisfies AdminDashboard["navigation"];

describe("AdminSectionTabs", () => {
  it("renders every destination under static subject headings", () => {
    const tabs = navigation("invites");
    render(
      <>
        <AdminSectionTabs navigation={tabs} summary={summary} />
        <section aria-labelledby={adminSectionTabId("invites")} id={adminSectionPanelId("invites")} role="tabpanel" />
        <AdminInactiveSectionPanels activeSection="invites" />
      </>
    );

    for (const [groupId, heading] of [
      ["ai-setup", "AI setup"],
      ["team-access", "Team & access"],
      ["operations", "Operations"],
      ["infrastructure", "Infrastructure"],
      ["safety", "Safety"]
    ] as const) {
      expect(within(screen.getByTestId(`admin-nav-group-${groupId}`)).getAllByText(heading)[0]).toBeVisible();
    }
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(adminSections.length);
    for (const section of adminSections) {
      expect(screen.getByRole("tab", { name: section.label })).toHaveAccessibleName(section.label);
    }
    const invitesTab = screen.getByRole("tab", { name: "Invites" });
    const usersTab = screen.getByRole("tab", { name: "Users" });
    expect(invitesTab).toHaveAttribute("aria-selected", "true");
    expect(usersTab).toHaveTextContent("2");
    expect(invitesTab).toHaveTextContent("2");
    expect(within(invitesTab).getByText("2")).toHaveClass("text-ink");
    expect(within(usersTab).getByText("2")).toHaveClass("text-caution");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

    for (const section of adminSections) {
      const tab = screen.getByRole("tab", { name: section.label });
      const panelId = tab.getAttribute("aria-controls");
      expect(tab).toHaveAttribute("id", adminSectionTabId(section.id));
      expect(panelId).toBe(adminSectionPanelId(section.id));
      if (!panelId) throw new Error(`Expected panel id for ${section.id}`);
      expect(document.getElementById(panelId)).toHaveAttribute("aria-labelledby", adminSectionTabId(section.id));
    }
  });

  it("delegates pointer and keyboard intents without collapsible heading controls", () => {
    const tabs = navigation("users");
    render(<AdminSectionTabs navigation={tabs} summary={summary} />);

    fireEvent.click(screen.getByRole("tab", { name: "Access & groups" }));
    expect(tabs.selectSection).toHaveBeenCalledWith("access");

    const eventAccepted = fireEvent.keyDown(screen.getByRole("tab", { name: "Users" }), { key: "ArrowRight" });
    expect(eventAccepted).toBe(true);
    expect(tabs.onTabKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "ArrowRight" }), "users");
    expect(screen.queryByRole("button", { name: "Team & access" })).not.toBeInTheDocument();
  });
});
