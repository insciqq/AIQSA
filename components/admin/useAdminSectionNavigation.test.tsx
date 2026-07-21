import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminSectionPanelId, adminSectionTabId } from "./adminSections";
import { AdminInactiveSectionPanels, AdminSectionTabs } from "./AdminSectionTabs";
import {
  useAdminSectionNavigation,
  type AdminSectionNavigation
} from "./useAdminSectionNavigation";

function renderNavigation() {
  let currentNavigation: AdminSectionNavigation | null = null;

  function Harness() {
    const navigation = useAdminSectionNavigation();
    currentNavigation = navigation;

    return (
      <>
        <button data-testid="stable-focus" type="button">
          Stable focus
        </button>
        <AdminSectionTabs navigation={navigation} />
        <section
          aria-labelledby={adminSectionTabId(navigation.activeSection)}
          data-testid="active-panel"
          id={adminSectionPanelId(navigation.activeSection)}
          role="tabpanel"
        >
          {navigation.activeSectionConfig.label}
        </section>
        <AdminInactiveSectionPanels activeSection={navigation.activeSection} />
      </>
    );
  }

  const view = render(<Harness />);

  return {
    ...view,
    get navigation() {
      if (!currentNavigation) {
        throw new Error("Navigation harness did not render");
      }

      return currentNavigation;
    }
  };
}

describe("useAdminSectionNavigation", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("restores deep links, replaces only the section query, and follows popstate", async () => {
    window.history.replaceState(null, "", "/admin?mode=compact&section=invites#current");
    renderNavigation();

    await waitFor(() => expect(screen.getByRole("tab", { name: "Invites" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Invites");

    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(window.location.pathname).toBe("/admin");
    expect(window.location.search).toBe("?mode=compact&section=groups");
    expect(window.location.hash).toBe("#current");

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(window.location.search).toBe("?mode=compact");
    expect(window.location.hash).toBe("#current");

    window.history.pushState(null, "", "/admin?mode=compact&section=safety#external");
    fireEvent.popState(window);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Safety" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Safety");
  });

  it("implements Arrow, Home, and End roving navigation with wraparound", async () => {
    window.history.replaceState(null, "", "/admin");
    renderNavigation();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true"));

    async function press(from: string, key: string, to: string) {
      const target = screen.getByRole("tab", { name: to });
      const scrollIntoView = vi.fn();
      target.scrollIntoView = scrollIntoView;
      const accepted = fireEvent.keyDown(screen.getByRole("tab", { name: from }), { key });
      expect(accepted).toBe(false);
      await waitFor(() => expect(screen.getByRole("tab", { name: to })).toHaveFocus());
      expect(screen.getByRole("tab", { name: to })).toHaveAttribute("aria-selected", "true");
      expect(scrollIntoView).not.toHaveBeenCalled();
    }

    await press("Users", "ArrowLeft", "Safety");
    await press("Safety", "ArrowRight", "Users");
    await press("Users", "ArrowDown", "Usage");
    await press("Usage", "ArrowUp", "Users");
    await press("Users", "End", "Safety");
    await press("Safety", "Home", "Users");

    const accepted = fireEvent.keyDown(screen.getByRole("tab", { name: "Users" }), { key: "PageDown" });
    expect(accepted).toBe(true);
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not steal valid focus and restores the active operational tab after an opener disappears", async () => {
    window.history.replaceState(null, "", "/admin?section=access-rules");
    const harness = renderNavigation();
    const activeTab = await screen.findByRole("tab", { name: "Access rules" });
    await waitFor(() => expect(activeTab).toHaveAttribute("aria-selected", "true"));

    const stable = screen.getByTestId("stable-focus");
    stable.focus();
    act(() => harness.navigation.restoreFocusAfterMutation());
    await waitFor(() => expect(stable).toHaveFocus());

    const removedOpener = document.createElement("button");
    document.body.append(removedOpener);
    removedOpener.focus();
    removedOpener.remove();
    act(() => harness.navigation.restoreFocusAfterMutation());

    await waitFor(() => expect(activeTab).toHaveFocus());
  });

  it("treats focus inside hidden or inert content as unstable", async () => {
    window.history.replaceState(null, "", "/admin?section=groups");
    const harness = renderNavigation();
    const activeTab = await screen.findByRole("tab", { name: "Groups" });
    await waitFor(() => expect(activeTab).toHaveAttribute("aria-selected", "true"));

    const hiddenOwner = document.createElement("div");
    hiddenOwner.setAttribute("aria-hidden", "true");
    const hiddenButton = document.createElement("button");
    hiddenOwner.append(hiddenButton);
    document.body.append(hiddenOwner);
    hiddenButton.focus();
    expect(hiddenButton).toHaveFocus();

    act(() => harness.navigation.restoreFocusAfterMutation());
    await waitFor(() => expect(activeTab).toHaveFocus());
    hiddenOwner.remove();
  });
});
