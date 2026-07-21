import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { adminSectionPanelId, adminSections, adminSectionTabId } from "./adminSections";
import { AdminInactiveSectionPanels, AdminSectionTabs } from "./AdminSectionTabs";
import type { AdminSectionNavigation } from "./useAdminSectionNavigation";

function navigation(
  activeSection: AdminSectionNavigation["activeSection"]
): Pick<AdminSectionNavigation, "activeSection" | "onTabKeyDown" | "registerTab" | "selectSection"> {
  return {
    activeSection,
    onTabKeyDown: vi.fn<AdminSectionNavigation["onTabKeyDown"]>(),
    registerTab: vi.fn<AdminSectionNavigation["registerTab"]>(),
    selectSection: vi.fn<AdminSectionNavigation["selectSection"]>()
  };
}

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

    expect(screen.getByRole("tablist", { name: "Admin sections" })).toBeVisible();
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
});
