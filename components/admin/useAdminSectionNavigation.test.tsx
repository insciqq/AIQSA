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
        <button data-testid="open-section-index" onClick={navigation.openSectionIndex} type="button">
          Open sections
        </button>
        <output data-testid="section-index-state">
          {navigation.sectionIndexOpen ? "open" : "closed"}
        </output>
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

  it("restores deep links, pushes section history, and preserves unrelated URL and state", async () => {
    window.history.replaceState(
      { nextRouter: { marker: "keep" } },
      "",
      "/admin?mode=compact&section=invites#current"
    );
    renderNavigation();

    await waitFor(() => expect(screen.getByRole("tab", { name: "Invites" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Invites");

    fireEvent.click(screen.getByRole("tab", { name: "Access & groups" }));
    expect(window.location.pathname).toBe("/admin");
    expect(window.location.search).toBe("?mode=compact&section=access");
    expect(window.location.hash).toBe("#current");
    expect(window.history.state).toMatchObject({ nextRouter: { marker: "keep" } });

    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(window.location.search).toBe("?mode=compact");
    expect(window.location.hash).toBe("#current");

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?mode=compact&section=access"));
    expect(screen.getByRole("tab", { name: "Access & groups" })).toHaveAttribute("aria-selected", "true");

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?mode=compact&section=invites"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Invites");

    act(() => window.history.forward());
    await waitFor(() => expect(window.location.search).toBe("?mode=compact&section=access"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Access & groups");
  });

  it("models the compact section index as a history entry without inventing a route", async () => {
    window.history.replaceState({ retained: true }, "", "/admin?section=usage#current");
    renderNavigation();
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Usage"));

    fireEvent.click(screen.getByTestId("open-section-index"));
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("open");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/admin?section=usage#current"
    );
    expect(window.history.state).toMatchObject({
      aiqsaControlCenter: { view: "section-index" },
      retained: true
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByTestId("section-index-state")).toHaveTextContent("closed"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Usage");
  });

  it("implements Arrow, Home, and End roving navigation with wraparound", async () => {
    window.history.replaceState(null, "", "/admin");
    renderNavigation();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true"));

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

    await press("Providers", "ArrowLeft", "Safety");
    await press("Safety", "ArrowRight", "Providers");
    await press("Providers", "ArrowDown", "Users");
    await press("Users", "ArrowUp", "Providers");
    await press("Providers", "End", "Safety");
    await press("Safety", "Home", "Providers");

    const accepted = fireEvent.keyDown(screen.getByRole("tab", { name: "Providers" }), { key: "PageDown" });
    expect(accepted).toBe(true);
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
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
    const activeTab = await screen.findByRole("tab", { name: "Access & groups" });
    await waitFor(() => expect(activeTab).toHaveAttribute("aria-selected", "true"));
    expect(window.location.search).toBe("?section=access");

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
