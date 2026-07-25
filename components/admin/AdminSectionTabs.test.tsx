import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("keeps a newly active compact tab visible by scrolling only its tablist", async () => {
    const view = render(<AdminSectionTabs navigation={navigation("users")} />);
    const tablist = screen.getByRole("tablist", { name: "Control Center sections" });
    const providers = screen.getByRole("tab", { name: "Providers" });
    tablist.scrollLeft = 0;
    vi.spyOn(tablist, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 300
    } as DOMRect);
    vi.spyOn(providers, "getBoundingClientRect").mockReturnValue({
      left: 380,
      right: 480
    } as DOMRect);

    view.rerender(<AdminSectionTabs navigation={navigation("providers")} />);

    await waitFor(() => expect(tablist.scrollLeft).toBe(180));
    expect(providers).not.toHaveFocus();
  });
});
