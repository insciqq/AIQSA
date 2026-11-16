import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialSettingsDestinationSnapshot, useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";
import {
  resetAssistantLibraryStoreForTest,
  resetChatAssistantProjectionStoreForTest,
  resetComposerControlStoreForTest,
  resetComposerSessionStoreForTest,
  resetMcpSettingsStoreForTest,
  resetThreadStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import { matrixCatalog } from "@/tests/e2e/shell/catalog";
import { PowerAppShellV2 } from "./PowerAppShellV2";

/*
 * The whole shell with its real stores: the one Settings navigation opens the
 * section a caller outside the shell's props, a former `?settings=` address
 * or a `?library=` address names.
 */
async function answer(input: RequestInfo | URL): Promise<Response> {
  const path = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/u, "");
  switch (path.split("?")[0]) {
    case "/api/me/catalog":
      return Response.json({ catalog: { ...matrixCatalog, defaults: { ...matrixCatalog.defaults, assistantId: null } } });
    case "/api/chats":
      return Response.json({ chats: [], folders: [] });
    default:
      return Response.json({ error: "not_found" }, { status: 404 });
  }
}

beforeEach(() => {
  resetAssistantLibraryStoreForTest();
  resetChatAssistantProjectionStoreForTest();
  resetComposerControlStoreForTest();
  resetComposerSessionStoreForTest();
  resetThreadStoreForTest();
  resetWorkspaceStoreForTest();
  useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
  vi.stubGlobal("fetch", vi.fn(answer));
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  })));
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  resetMcpSettingsStoreForTest();
  useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const shell = (telegramAvailable = false) => (
  <PowerAppShellV2 accountDisplayName="User" accountEmail="user@example.test" accountId="user-1" telegramAvailable={telegramAvailable} />
);

async function shownSection(name: string): Promise<void> {
  const surface = await screen.findByTestId("library-v2");
  await waitFor(() => expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true"));
  expect(surface).toHaveAttribute("data-view", "section");
}

describe("opening Settings from the shell", () => {
  it("opens the section a caller outside the shell's props asks for, and clears the request", async () => {
    render(shell());
    await screen.findByTestId("app-shell");
    act(() => useSettingsDestinationStore.getState().openSettings("apps"));
    await shownSection("Claude Code & Codex");
    expect(useSettingsDestinationStore.getState().settingsRequest).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("opens a former ?settings= address on its new section and consumes the parameter", async () => {
    window.history.replaceState(null, "", "/?settings=proxies&keep=1");
    render(shell());
    await shownSection("Proxies");
    expect(window.location.search).toBe("?keep=1");
  });

  it("opens ?library= sections, the new ones included, and Telegram only where it is offered", async () => {
    window.history.replaceState(null, "", "/?library=telegram");
    const { unmount } = render(shell(true));
    await shownSection("Telegram");
    unmount();

    window.history.replaceState(null, "", "/?library=telegram");
    render(shell(false));
    const surface = await screen.findByTestId("library-v2");
    expect(screen.queryByRole("tab", { name: "Telegram" })).toBeNull();
    // An unoffered section opens Settings as the gear does, and says why.
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(surface).toHaveAttribute("data-view", "list");
    expect(await within(surface).findByRole("alert")).toHaveTextContent("Telegram is not available in this AIQSA.");
  });

  it("opens an unknown ?library= section as nothing at all", async () => {
    window.history.replaceState(null, "", "/?library=studio");
    render(shell());
    await screen.findByTestId("app-shell");
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.queryByTestId("library-v2")).toBeNull();
    expect(screen.queryByText(/is not available in this AIQSA/u)).toBeNull();
  });

  it("opens Settings › Computers where /connect sends, with the origin the server passed, only while AIQSA Connect is on", async () => {
    window.history.replaceState(null, "", "/?library=computers");
    const { unmount } = render(
      <PowerAppShellV2 accountDisplayName="User" accountEmail="user@example.test" accountId="user-1"
        connectEntryVisible connectInstallOrigin="https://ai.example.com" />
    );
    await shownSection("Computers");
    expect(await screen.findByTestId("connect-add-computer")).toHaveTextContent("ai.example.com");
    expect(window.location.search).toBe("");
    unmount();

    window.history.replaceState(null, "", "/?library=computers");
    render(shell());
    const surface = await screen.findByTestId("library-v2");
    expect(screen.queryByRole("tab", { name: "Computers" })).toBeNull();
    expect(screen.queryByTestId("settings-computers-panel")).toBeNull();
    expect(await within(surface).findByRole("alert")).toHaveTextContent("Computers is not available in this AIQSA.");
  });
});

function stubComposition(mobile: boolean) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: mobile && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  })));
}

/** Opens Settings with the gear in the chat list footer, as a keyboard user does. */
async function openSettingsWithTheGear(): Promise<HTMLElement> {
  const gear = within(await screen.findByTestId("navigation-footer")).getByRole("button", { name: "Settings" });
  gear.focus();
  fireEvent.click(gear);
  await screen.findByTestId("library-v2");
  return gear;
}

describe("keyboard focus around Settings", () => {
  it("enters Settings from the gear, which the shell only hides, and returns to it on Back to chat", async () => {
    render(shell());
    const gear = await openSettingsWithTheGear();
    expect(gear).toBeInTheDocument();
    expect(screen.getByTestId("library-v2")).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole("tab", { name: "General" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(screen.queryByTestId("library-v2")).toBeNull());
    await waitFor(() => expect(gear).toHaveFocus());
  });

  it("returns to Open sidebar when the chat list is hidden", async () => {
    stubComposition(true);
    render(shell());
    await openSettingsWithTheGear();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(screen.queryByTestId("library-v2")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveFocus());
  });

  it("leaves a new chat started from Settings with Ctrl+Shift+O in the composer", async () => {
    render(shell());
    await waitFor(() => expect(document.querySelector('[data-testid="composer-v2"] textarea')).not.toBeNull());
    await openSettingsWithTheGear();
    fireEvent.keyDown(document.body, { ctrlKey: true, key: "O", shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("library-v2")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-testid="composer-v2"] textarea')));
  });
});
