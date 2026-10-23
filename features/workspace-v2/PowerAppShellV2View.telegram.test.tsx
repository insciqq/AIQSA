import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import type { PowerAppShellV2Props } from "@/components/app-shell/powerAppShellV2Contracts";
import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import { deactivatePersonalMcp } from "@/components/app-shell/personalMcpStore";
import {
  resetComposerControlStoreForTest,
  resetMcpSettingsStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import { PowerAppShellV2View } from "./PowerAppShellV2View";

afterEach(() => {
  cleanup();
  deactivatePersonalMcp();
  resetComposerControlStoreForTest();
  resetMcpSettingsStoreForTest();
  resetWorkspaceStoreForTest();
  vi.unstubAllGlobals();
});

// Only the view-consumed state of a blank personal chat with Settings open on Connections.
function shellProps(telegramAvailable: boolean | undefined): PowerAppShellV2Props {
  return {
    branches: { open: false },
    session: {
      accountId: "owner", accountDisplayName: "Owner", accountEmail: null, activeChatId: null, notice: null,
      ...(telegramAvailable === undefined ? {} : { telegramAvailable })
    },
    composer: {
      attachments: [], catalog: composerGalleryConfig.catalog, draft: "", currentParameterControls: defaultParameterControls(),
      assistant: { current: null, pickerItems: [], recentIds: [], openPicker: false, stripItems: [] },
      memory: { mode: "NORMAL" }, workspace: { available: false, enabled: false },
      composerActions: {}, selectedSearchOptionIds: []
    },
    settings: {
      memory: { open: false },
      settings: { open: true, section: "connections", themeId: "dark" },
      closeSettings: vi.fn(), dismissNotice: vi.fn(), notice: null, updateTheme: vi.fn()
    },
    thread: { visibleMessages: [], events: [], refreshLayout: vi.fn() },
    overlays: { share: { target: null }, confirmations: {} },
    workspace: {
      pane: { state: {}, actions: {} }
    }
  } as unknown as PowerAppShellV2Props;
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input instanceof Request ? input.url : input).split("?")[0];
    if (path === "/api/me/telegram") return Response.json({ available: true, state: "not_linked" });
    if (path === "/api/me/mcp-connections") return Response.json({ servers: [] });
    if (path === "/api/me/mcp") return Response.json({ servers: [] });
    return Response.json({ announcements: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const telegramReads = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/me/telegram"));

describe("Settings → Connections → Telegram", () => {
  it("is absent and never reads the Telegram status while the viewer flag is off", async () => {
    for (const flag of [undefined, false]) {
      const fetchMock = stubFetch();
      render(<PowerAppShellV2View {...shellProps(flag)} />);
      const panel = await screen.findByTestId("settings-connections-panel");
      expect(await within(panel).findByRole("heading", { name: "Personal connections" })).toBeInTheDocument();
      expect(within(panel).queryByTestId("settings-telegram")).not.toBeInTheDocument();
      expect(telegramReads(fetchMock)).toEqual([]);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("sits above Personal connections when the viewer flag is on", async () => {
    stubFetch();
    render(<PowerAppShellV2View {...shellProps(true)} />);
    const panel = await screen.findByTestId("settings-connections-panel");
    const telegram = await within(panel).findByTestId("settings-telegram");
    expect(await within(telegram).findByRole("button", { name: "Connect Telegram" })).toBeInTheDocument();
    const personal = within(panel).getByRole("heading", { name: "Personal connections" });
    expect(telegram.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
