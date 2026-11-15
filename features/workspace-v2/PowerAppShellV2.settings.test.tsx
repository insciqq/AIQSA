import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
    // An unoffered section opens the list on the default section instead.
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(surface).toHaveAttribute("data-view", "list");
  });
});
