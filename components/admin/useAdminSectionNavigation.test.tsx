import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminShell } from "./AdminShell";
import {
  useAdminSectionNavigation,
  type AdminSectionNavigation,
  type AdminSectionNavigationOptions
} from "./useAdminSectionNavigation";

function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: () => undefined,
    matches: query.includes("max-width: 1023px") ? width < 1024 : query.includes("max-width: 767px") ? width < 768 : false,
    media: query,
    removeEventListener: () => undefined
  }));
}

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
        <output data-testid="section-index-state">
          {navigation.sectionIndexOpen ? "open" : "closed"}
        </output>
        <AdminShell
          accountLabel="admin@example.com"
          navigation={navigation}
          releaseStatus={null}
          topbar={{ title: navigation.activeSectionConfig.label }}
        >
          <section data-testid="active-panel">{navigation.activeSectionConfig.label}</section>
        </AdminShell>
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

function sectionLink(name: string) {
  return screen.getByTestId("admin-section-index").querySelector<HTMLAnchorElement>(
    `a[data-testid="admin-nav-${name}"]`
  )!;
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
      "/admin?mode=compact&section=users#current"
    );
    renderNavigation();

    await waitFor(() => expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Users");
    expect(screen.getByRole("link", { name: "Groups" })).toHaveAttribute("href", "/admin?mode=compact&section=groups#current");

    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    expect(window.location.pathname).toBe("/admin");
    expect(window.location.search).toBe("?mode=compact&section=groups");
    expect(window.location.hash).toBe("#current");
    expect(window.history.state).toMatchObject({ nextRouter: { marker: "keep" } });

    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    expect(window.location.search).toBe("?mode=compact");
    expect(window.location.hash).toBe("#current");

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?mode=compact&section=groups"));
    expect(screen.getByRole("link", { name: "Groups" })).toHaveAttribute("aria-current", "page");

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?mode=compact&section=users"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Users");

    act(() => window.history.forward());
    await waitFor(() => expect(window.location.search).toBe("?mode=compact&section=groups"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Groups");
  });

  it("opens a resource page inside a section, keeps section links resource-free, and returns with Back", async () => {
    window.history.replaceState({ nextRouter: { marker: "keep" } }, "", "/admin?section=providers&resource=conn-1#top");
    const view = renderNavigation();
    await waitFor(() => expect(view.navigation.activeSection).toBe("providers"));
    expect(view.navigation.activeResource).toBe("conn-1");
    expect(screen.getByRole("link", { name: "Groups" })).toHaveAttribute("href", "/admin?section=groups#top");

    act(() => { view.navigation.selectResource(null); });
    expect(window.location.search).toBe("?section=providers");
    expect(view.navigation.activeResource).toBeNull();
    act(() => { view.navigation.selectResource("conn-2"); });
    expect(window.location.search).toBe("?section=providers&resource=conn-2");
    expect(window.location.hash).toBe("#top");
    expect(window.history.state).toMatchObject({ nextRouter: { marker: "keep" } });
    expect(view.navigation.activeResource).toBe("conn-2");

    act(() => window.history.back());
    await waitFor(() => expect(view.navigation.activeResource).toBeNull());
    expect(window.location.search).toBe("?section=providers");

    act(() => { view.navigation.selectSection("groups", "group-1"); });
    expect(window.location.search).toBe("?section=groups&resource=group-1");
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(window.location.search).toBe("?section=usage");
    expect(view.navigation.activeResource).toBeNull();
  });

  it("normalizes retired section ids in the address bar without a redirect", async () => {
    window.history.replaceState(null, "", "/admin?section=system-models");
    renderNavigation();
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Defaults & roles"));
    expect(window.location.search).toBe("?section=roles");
    expect(screen.getByRole("link", { name: "Defaults & roles" })).toHaveAttribute("aria-current", "page");
  });

  it("leaves modified clicks to the browser so a section can open in a new tab", async () => {
    window.history.replaceState(null, "", "/admin");
    renderNavigation();
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));

    const accepted = fireEvent.click(screen.getByRole("link", { name: "Usage" }), { ctrlKey: true });
    expect(accepted).toBe(true);
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview");
    expect(window.location.search).toBe("");
  });

  it("models the compact section drawer as a history entry without inventing a route", async () => {
    stubViewport(800);
    window.history.replaceState({ retained: true }, "", "/admin?section=usage");
    renderNavigation();
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Usage"));
    expect(screen.getByTestId("admin-section-column")).toHaveClass("max-lg:hidden");

    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("open");
    expect(screen.getByTestId("admin-section-column")).not.toHaveClass("max-lg:hidden");
    expect(screen.getByTestId("admin-section-column")).toHaveAttribute("role", "dialog");
    expect(screen.getByTestId("admin-drawer-scrim")).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe("/admin?section=usage");
    expect(window.history.state).toMatchObject({
      aiqsaControlCenter: { view: "section-index" },
      retained: true
    });

    fireEvent.click(screen.getByRole("button", { name: "Close sections" }));
    await waitFor(() => expect(screen.getByTestId("section-index-state")).toHaveTextContent("closed"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Usage");

    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    await waitFor(() => expect(screen.getByTestId("section-index-state")).toHaveTextContent("open"));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("section-index-state")).toHaveTextContent("closed"));

    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    await waitFor(() => expect(screen.getByTestId("section-index-state")).toHaveTextContent("open"));
    fireEvent.click(screen.getByRole("link", { name: "Email" }));
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Email"));
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("closed");
  });

  it("keeps the current section and URL when guarded navigation is refused", async () => {
    window.history.replaceState(null, "", "/admin");
    const canSelectSection = vi.fn((section: AdminSectionNavigation["activeSection"]) => (
      section !== "roles" && section !== "users"
    ));
    const onNavigationBlocked = vi.fn();
    renderNavigation({ canSelectSection, onNavigationBlocked });
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));

    fireEvent.click(screen.getByRole("link", { name: "Users" }));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview");
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("link", { name: "Defaults & roles" }));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview");
    expect(onNavigationBlocked).toHaveBeenCalledTimes(2);
    expect(onNavigationBlocked.mock.calls[0]?.[0].target).toMatchObject({ kind: "section", section: "users" });
  });

  it("guards the compact drawer open and close without changing history until approval", async () => {
    stubViewport(800);
    window.history.replaceState(null, "", "/admin?section=users");
    let allowed = false;
    const blocked: Parameters<NonNullable<AdminSectionNavigationOptions["onNavigationBlocked"]>>[0][] = [];
    renderNavigation({
      canToggleSectionIndex: () => allowed,
      onNavigationBlocked: (navigation) => blocked.push(navigation)
    });
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Users"));
    const originalState = structuredClone(window.history.state);

    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("closed");
    expect(window.history.state).toEqual(originalState);
    expect(blocked[0]?.target).toMatchObject({ kind: "section-index", open: true });

    act(() => blocked[0]!.proceed());
    expect(screen.getByTestId("section-index-state")).toHaveTextContent("open");
    const indexState = structuredClone(window.history.state);

    fireEvent.click(screen.getByRole("button", { name: "Close sections" }));
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
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));

    fireEvent.click(screen.getByRole("link", { name: "Users" }));
    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    expect(window.location.search).toBe("");
    guarded = true;

    act(() => window.history.back());
    await waitFor(() => expect(blocked).toHaveLength(1));
    expect(window.location.search).toBe("");
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview");

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
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));

    fireEvent.click(screen.getByRole("link", { name: "Users" }));
    fireEvent.click(screen.getByRole("link", { name: "Groups" }));
    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    expect(window.location.search).toBe("");
    guarded = true;

    act(() => window.history.go(-2));
    await waitFor(() => expect(blocked).toHaveLength(1));
    expect(window.location.search).toBe("");
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview");

    act(() => blocked[0]!.proceed());
    await waitFor(() => expect(window.location.search).toBe("?section=users"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Users");
  });

  it("rebases an unmarked current entry before creating a contiguous owned history session", async () => {
    window.history.replaceState({ route: "initial" }, "", "/admin");
    renderNavigation();
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));
    const initialSession = window.history.state.aiqsaControlCenter.sessionId as string;

    window.history.pushState({ route: "foreign" }, "", "/admin#foreign");
    fireEvent.click(screen.getByRole("link", { name: "Users" }));

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

    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));
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
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));

    fireEvent.click(screen.getByRole("link", { name: "Users" }));
    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview"));
    guarded = true;

    act(() => window.history.forward());
    await waitFor(() => expect(blocked).toHaveLength(1));
    expect(window.location.search).toBe("");
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Overview");

    // Cancelling leaves the replay callback unused, so the same Forward entry
    // remains available and retains its original state.
    act(() => window.history.forward());
    await waitFor(() => expect(blocked).toHaveLength(2));
    act(() => blocked[1]!.proceed());

    await waitFor(() => expect(window.location.search).toBe("?section=users"));
    expect(screen.getByTestId("active-panel")).toHaveTextContent("Users");
  });

  it("does not steal valid focus and restores the active section link after an opener disappears", async () => {
    window.history.replaceState(null, "", "/admin?section=email");
    const harness = renderNavigation();
    const activeLink = await screen.findByRole("link", { name: "Email" });
    await waitFor(() => expect(activeLink).toHaveAttribute("aria-current", "page"));

    const stable = screen.getByTestId("stable-focus");
    stable.focus();
    act(() => harness.navigation.restoreFocusAfterMutation());
    await waitFor(() => expect(stable).toHaveFocus());

    const removedOpener = document.createElement("button");
    document.body.append(removedOpener);
    removedOpener.focus();
    removedOpener.remove();
    act(() => harness.navigation.restoreFocusAfterMutation());

    await waitFor(() => expect(activeLink).toHaveFocus());
  });

  it("treats focus inside hidden or inert content as unstable", async () => {
    window.history.replaceState(null, "", "/admin?section=access");
    const harness = renderNavigation();
    const activeLink = await screen.findByRole("link", { name: "Groups" });
    await waitFor(() => expect(activeLink).toHaveAttribute("aria-current", "page"));
    expect(window.location.search).toBe("?section=groups");
    expect(sectionLink("groups")).toBe(activeLink);

    const hiddenOwner = document.createElement("div");
    hiddenOwner.setAttribute("aria-hidden", "true");
    const hiddenButton = document.createElement("button");
    hiddenOwner.append(hiddenButton);
    document.body.append(hiddenOwner);
    hiddenButton.focus();
    expect(hiddenButton).toHaveFocus();

    act(() => harness.navigation.restoreFocusAfterMutation());
    await waitFor(() => expect(activeLink).toHaveFocus());
    hiddenOwner.remove();
  });
});
