import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminSectionPanelId, adminSectionTabId } from "./adminSections";
import { AdminInactiveSectionPanels, AdminSectionTabs } from "./AdminSectionTabs";
import {
  useAdminSectionNavigation,
  type AdminSectionNavigation,
  type AdminSectionNavigationOptions
} from "./useAdminSectionNavigation";

function renderNavigation(options: AdminSectionNavigationOptions = {}) {
  let currentNavigation: AdminSectionNavigation | null = null;

  function Harness() {
    const navigation = useAdminSectionNavigation(options);
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
    vi.unstubAllGlobals();
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
    await press("Providers", "ArrowDown", "Search");
    await press("Search", "ArrowDown", "Knowledge");
    await press("Knowledge", "ArrowDown", "Memory");
    await press("Memory", "ArrowDown", "Users");
    await press("Users", "ArrowUp", "Memory");
    await press("Memory", "ArrowUp", "Knowledge");
    await press("Knowledge", "ArrowUp", "Search");
    await press("Search", "ArrowUp", "Providers");
    await press("Providers", "End", "Safety");
    await press("Safety", "Home", "Providers");

    const accepted = fireEvent.keyDown(screen.getByRole("tab", { name: "Providers" }), { key: "PageDown" });
    expect(accepted).toBe(true);
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the current section and URL when guarded click or keyboard navigation is refused", async () => {
    window.history.replaceState(null, "", "/admin");
    const canSelectSection = vi.fn((section: AdminSectionNavigation["activeSection"]) => (
      section !== "search" && section !== "users"
    ));
    const onNavigationBlocked = vi.fn();
    renderNavigation({ canSelectSection, onNavigationBlocked });
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers"));

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers");
    expect(window.location.search).toBe("");

    screen.getByRole("tab", { name: "Providers" }).focus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Providers" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveFocus();
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers");
    expect(onNavigationBlocked).toHaveBeenCalledTimes(2);
  });

  it("guards compact All sections and Back without changing history until approval", async () => {
    window.history.replaceState(null, "", "/admin?section=users");
    let allowed = false;
    const blocked: Parameters<NonNullable<AdminSectionNavigationOptions["onNavigationBlocked"]>>[0][] = [];
    renderNavigation({
      canToggleSectionIndex: () => allowed,
      onNavigationBlocked: (navigation) => blocked.push(navigation)
    });
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Users"));
    const originalState = structuredClone(window.history.state);

    fireEvent.click(screen.getByTestId("open-section-index"));
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("closed");
    expect(window.history.state).toEqual(originalState);
    expect(blocked[0]?.target).toMatchObject({ kind: "section-index", open: true });

    act(() => blocked[0]!.proceed());
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("open");
    const indexState = structuredClone(window.history.state);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("open");
    expect(window.history.state).toEqual(indexState);
    expect(blocked[1]?.target).toMatchObject({ kind: "section-index", open: false });

    allowed = true;
    act(() => blocked[1]!.proceed());
    await waitFor(() => expect(screen.getByTestId("section-index-state")).toHaveTextContent("closed"));
    expect(window.location.search).toBe("?section=users");
  });

  it("rolls a refused Back traversal to its origin and replays the same entry after approval", async () => {
    window.history.replaceState(null, "", "/admin");
    let guarded = false;
    const canSelectSection = vi.fn((section: AdminSectionNavigation["activeSection"]) => (
      !guarded || section !== "users"
    ));
    const blocked: Parameters<NonNullable<AdminSectionNavigationOptions["onNavigationBlocked"]>>[0][] = [];
    renderNavigation({
      canSelectSection,
      onNavigationBlocked: (navigation) => blocked.push(navigation)
    });
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers"));

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(window.location.search).toBe("");
    guarded = true;

    act(() => window.history.back());
    await waitFor(() => expect(blocked).toHaveLength(1));
    expect(window.location.search).toBe("");
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers");

    // Cancel means leaving the supplied retry unused. A second Back still
    // targets the same Users entry instead of a rewritten duplicate.
    act(() => window.history.back());
    await waitFor(() => expect(blocked).toHaveLength(2));
    expect(window.location.search).toBe("");

    act(() => blocked[1]!.proceed());
    await waitFor(() => expect(window.location.search).toBe("?section=users"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Users");
  });

  it("guards and exactly replays a non-adjacent app-owned history jump", async () => {
    window.history.replaceState(null, "", "/admin");
    let guarded = false;
    const blocked: Parameters<NonNullable<AdminSectionNavigationOptions["onNavigationBlocked"]>>[0][] = [];
    renderNavigation({
      canSelectSection: (section) => !guarded || section !== "users",
      onNavigationBlocked: (navigation) => blocked.push(navigation)
    });
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers"));

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    fireEvent.click(screen.getByRole("tab", { name: "Access & groups" }));
    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(window.location.search).toBe("");
    guarded = true;

    act(() => window.history.go(-2));
    await waitFor(() => expect(blocked).toHaveLength(1));
    expect(window.location.search).toBe("");
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers");

    act(() => blocked[0]!.proceed());
    await waitFor(() => expect(window.location.search).toBe("?section=users"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Users");
  });

  it("rebases an unmarked current entry before creating a contiguous owned history session", async () => {
    window.history.replaceState({ route: "initial" }, "", "/admin");
    renderNavigation();
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers"));
    const initialSession = window.history.state.aiqsaControlCenter.sessionId as string;

    window.history.pushState({ route: "foreign" }, "", "/admin#foreign");
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));

    const pushedView = window.history.state.aiqsaControlCenter;
    expect(pushedView).toMatchObject({
      entryId: expect.any(String),
      position: 1,
      previousEntryId: expect.any(String),
      sessionId: expect.any(String),
      view: "section"
    });
    expect(pushedView.sessionId).not.toBe(initialSession);

    act(() => window.history.back());
    await waitFor(() => expect(window.history.state.aiqsaControlCenter.entryId).toBe(
      pushedView.previousEntryId
    ));
    expect(window.location.hash).toBe("#foreign");
    expect(window.history.state).toMatchObject({
      aiqsaControlCenter: {
        entryId: pushedView.previousEntryId,
        position: 0,
        previousEntryId: null,
        sessionId: pushedView.sessionId,
        view: "section"
      },
      route: "foreign"
    });
  });

  it("does not wrap the shared History API while it marks Control Center entries", async () => {
    window.history.replaceState({ route: "admin" }, "", "/admin");
    const pushState = window.history.pushState;
    const replaceState = window.history.replaceState;
    renderNavigation();

    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers"));
    expect(window.history.pushState).toBe(pushState);
    expect(window.history.replaceState).toBe(replaceState);
    expect(window.history.state).toMatchObject({
      aiqsaControlCenter: {
        entryId: expect.any(String),
        position: 0,
        previousEntryId: null,
        sessionId: expect.any(String),
        view: "section"
      },
      route: "admin"
    });
  });

  it("rolls back and replays a guarded Forward between marked Control Center entries", async () => {
    window.history.replaceState(null, "", "/admin");
    let guarded = false;
    const canSelectSection = vi.fn((section: AdminSectionNavigation["activeSection"]) => (
      !guarded || section !== "users"
    ));
    const blocked: Parameters<NonNullable<AdminSectionNavigationOptions["onNavigationBlocked"]>>[0][] = [];
    renderNavigation({
      canSelectSection,
      onNavigationBlocked: (navigation) => blocked.push(navigation)
    });
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers"));

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers"));
    guarded = true;

    act(() => window.history.forward());
    await waitFor(() => expect(blocked).toHaveLength(1));
    expect(window.location.search).toBe("");
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Providers");

    // Cancelling leaves the replay callback unused, so the same Forward entry
    // remains available and retains its original state.
    act(() => window.history.forward());
    await waitFor(() => expect(blocked).toHaveLength(2));
    act(() => blocked[1]!.proceed());

    await waitFor(() => expect(window.location.search).toBe("?section=users"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Users");
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
