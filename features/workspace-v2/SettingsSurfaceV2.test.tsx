import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PowerAppShellV2Props, ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import { deactivatePersonalMcp } from "@/components/app-shell/personalMcpStore";
import type { Notice } from "@/components/app-shell/types";
import { FakeEventSource } from "@/features/connect/connect.testFixtures";
import { settingsSectionsV2 } from "@/features/library-v2/LibraryV2";
import type { StudioNavigationV2 } from "@/features/library-v2/contracts";
import { useStudioNavigation } from "@/features/library-v2/useStudioNavigation";
import { resetMcpSettingsStoreForTest } from "@/tests/support/appShellStores";
import { LibrarySurfaceV2 } from "./WorkspaceWelcomeV2";

const accountApi = vi.hoisted(() => ({
  loadAccountProfile: vi.fn(async () => ({ displayName: "Ada", email: "ada@example.test", hasPassword: false, role: "user" })),
  loadTwoFactorStatus: vi.fn(() => new Promise(() => undefined))
}));

vi.mock("@/components/app-shell/accountApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/app-shell/accountApi")>(),
  ...accountApi
}));

// The sign-in start ends in a document navigation, which the test page does not perform.
const followMcpOAuthStart = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-shell/mcpSettingsApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/app-shell/mcpSettingsApi")>(),
  followMcpOAuthStart
}));

// Stable owners, as the shell's are: the account form reloads when its callback changes.
const updateAccountDisplayName = vi.fn();
const settingsActions = {
  closeMemory: vi.fn(), dismissNotice: vi.fn(), open: vi.fn(), openLibrary: vi.fn(), openMcp: vi.fn(), openMemory: vi.fn(),
  updateTheme: vi.fn()
};
const workspaceActions = { openChat: vi.fn(), openChatMessage: vi.fn(), retry: vi.fn() };
const onRestored = vi.fn();

const composer = {
  assistant: { current: null },
  catalog: null,
  currentModel: undefined,
  notificationSoundEnabled: false,
  notificationSoundId: "rise",
  notificationSoundReady: true,
  previewAnswerSound: async () => true,
  selectAnswerSound: () => undefined,
  sendWithEnter: true,
  setSendWithEnter: () => undefined,
  showCitations: true,
  showReasoningBlocks: true,
  toggleCitationsVisibility: () => undefined,
  toggleNotificationSound: () => undefined,
  toggleReasoningBlockVisibility: () => undefined,
  uploading: false,
  workspace: { available: false, loading: false }
} as unknown as ShellComposerView;

function shellProps(studio: StudioNavigationV2, telegramAvailable: boolean, notice: Notice | null, connect: boolean): PowerAppShellV2Props {
  return {
    session: {
      accountDisplayName: "Ada", accountEmail: "ada@example.test", accountId: "owner", adminEntryVisible: false,
      connectEntryVisible: connect, connectInstallOrigin: connect ? "https://ai.example.com" : null,
      telegramAvailable, updateAccountDisplayName
    },
    settings: { ...settingsActions, library: null, memory: { open: false }, notice, studio, themeId: "dark" },
    thread: { activeChatStreaming: false },
    workspace: { archived: { onRestored }, pane: { actions: workspaceActions, state: {} } }
  } as unknown as PowerAppShellV2Props;
}

/** The shell's part: one Settings navigation, a gear and Settings over the chat. */
function Shell({ connect = false, notice = null, telegramAvailable = false }: Readonly<{
  connect?: boolean;
  notice?: Notice | null;
  telegramAvailable?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const studio = useStudioNavigation({
    available: settingsSectionsV2({ computersAvailable: connect, telegramAvailable }),
    onExit: () => setOpen(false),
    onSelect: () => setOpen(true)
  });
  return open
    ? <LibrarySurfaceV2 composer={composer} props={shellProps(studio, telegramAvailable, notice, connect)} />
    : (
      <>
        <button type="button" onClick={() => studio.open()}>Gear</button>
        <button type="button" onClick={() => studio.open("data")}>Open Data</button>
        <button type="button" onClick={() => studio.open("mcp")}>Open MCP servers</button>
      </>
    );
}

/** Answers by path; `routes` adds or replaces answers for one test. */
function stubFetch(routes: Readonly<Record<string, () => Promise<Response>>> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input instanceof Request ? input.url : input).split("?")[0]!;
    if (routes[path]) return routes[path]();
    if (path === "/api/me/mcp") return Response.json({ servers: [] });
    if (path === "/api/me/telegram") return Response.json({ available: true, state: "not_linked" });
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
}

/** True when a guard asks the browser to confirm leaving the page. */
function leavingAsksFirst(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const neverAnswers = () => new Promise<Response>(() => undefined);

const notionConnection = {
  accountLabel: null, authHeaderName: null, authMode: "oauth", availableTools: [], description: "", enabled: false,
  endpoint: "https://mcp.example.test/mcp", fields: [], id: "notion", knownToolCount: 1, name: "Notion", oauthAvailable: true,
  oauthState: "disconnected", readiness: "needs_authorization", runtimeErrorCode: null, sourceType: "personal", tools: [],
  userDisabledToolNames: []
};

const tab = (name: string) => screen.getByRole("tab", { name });
const view = () => screen.getByTestId("library-v2").getAttribute("data-view");

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  cleanup();
  deactivatePersonalMcp();
  resetMcpSettingsStoreForTest();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("the Settings surface", () => {
  it("lists every section in its group order, and Telegram only when the installation offers it", async () => {
    const { unmount } = render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    const sections = within(screen.getByRole("tablist", { name: "Settings sections" })).getAllByRole("tab").map(node => node.textContent);
    expect(sections).toEqual(["General", "Account", "Data", "Assistants", "Instructions", "Skills", "Sub-agents", "Automations",
      "Chat defaults", "Memory", "Files", "Artifacts", "MCP servers", "Secrets", "Proxies", "Claude Code & Codex"]);
    for (const label of ["Agent", "Content", "Tools", "Connections"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Studio/u);
    unmount();

    render(<Shell telegramAvailable />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    const tail = within(screen.getByRole("tablist", { name: "Settings sections" })).getAllByRole("tab").slice(-3);
    expect(tail.map(node => node.textContent)).toEqual(["Proxies", "Telegram", "Claude Code & Codex"]);
    const telegramReads = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/me/telegram"));
    expect(telegramReads()).toEqual([]);
    fireEvent.click(tab("Telegram"));
    const section = await screen.findByTestId("settings-telegram");
    expect(await within(section).findByRole("button", { name: "Connect Telegram" })).toBeInTheDocument();
    expect(telegramReads().length).toBeGreaterThan(0);
  });

  it("opens the gear on General with the list first, then on the last section visited", async () => {
    render(<Shell notice={{ kind: "error", text: "The setting could not be saved." }} />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    expect(tab("General")).toHaveAttribute("aria-selected", "true");
    expect(view()).toBe("list");
    // The gear left with the chat; focus lands on the open section's row, not the page.
    expect(tab("General")).toHaveFocus();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The setting could not be saved.");

    fireEvent.click(tab("Data"));
    expect(view()).toBe("section");
    expect(await screen.findByTestId("settings-data-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByTestId("library-v2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    expect(tab("Data")).toHaveAttribute("aria-selected", "true");
    expect(view()).toBe("list");
  });

  it("asks before unsaved account changes are lost to another section or to the chat", async () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    fireEvent.click(tab("Account"));
    const name = await screen.findByRole("textbox", { name: "Display name" });
    await waitFor(() => expect(name).toHaveValue("Ada"));
    fireEvent.change(name, { target: { value: "Ada Lovelace" } });

    fireEvent.click(tab("Proxies"));
    const kept = await screen.findByRole("dialog", { name: "Unsaved account changes" });
    expect(kept).toHaveTextContent("Your unsaved account changes will be lost.");
    fireEvent.click(within(kept).getByRole("button", { name: "Keep editing" }));
    expect(tab("Account")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    const leaving = await screen.findByRole("dialog", { name: "Unsaved account changes" });
    fireEvent.click(within(leaving).getByRole("button", { name: /discard changes/iu }));
    await waitFor(() => expect(screen.queryByTestId("library-v2")).toBeNull());
  });

  it("asks to leave the page with unsaved account changes, never for its own sign-out", async () => {
    stubFetch({ "/api/auth/logout": neverAnswers });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    fireEvent.click(tab("Account"));
    const name = await screen.findByRole("textbox", { name: "Display name" });
    await waitFor(() => expect(name).toHaveValue("Ada"));
    expect(leavingAsksFirst()).toBe(false);
    fireEvent.change(name, { target: { value: "Ada Lovelace" } });
    expect(leavingAsksFirst()).toBe(true);
    fireEvent.change(name, { target: { value: "Ada" } });
    expect(leavingAsksFirst()).toBe(false);

    // Signing out ends in the page's own navigation to sign-in: Settings
    // stays locked meanwhile, and leaving asks nothing.
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to chat" })).toBeDisabled());
    expect(leavingAsksFirst()).toBe(false);
  });

  /** Back from another site restores the page from the back/forward cache. */
  function restoreFromCache() {
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => { window.dispatchEvent(restored); });
  }

  it("never asks to leave while a personal MCP sign-in is starting, and keeps a start without an answer locked", async () => {
    stubFetch({
      "/api/me/mcp-connections": async () => Response.json({ servers: [notionConnection] }),
      "/api/me/mcp-connections/notion/oauth/connect": neverAnswers
    });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Open MCP servers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Notion" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to chat" })).toBeDisabled());
    expect(leavingAsksFirst()).toBe(false);

    // The request is still in flight: a restored page must not let a second start begin beside it.
    restoreFromCache();
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeDisabled();
  });

  it("frees Settings when the page comes back from the sign-in site", async () => {
    followMcpOAuthStart.mockClear();
    stubFetch({
      "/api/me/mcp-connections": async () => Response.json({ servers: [notionConnection] }),
      "/api/me/mcp-connections/notion/oauth/connect": async () => Response.json({ location: "https://auth.example.test/authorize?state=test" })
    });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Open MCP servers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Notion" }));
    await waitFor(() => expect(followMcpOAuthStart).toHaveBeenCalledWith("https://auth.example.test/authorize?state=test"));
    // The document is leaving: Settings stays locked, and leaving does not ask.
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeDisabled();
    expect(leavingAsksFirst()).toBe(false);

    restoreFromCache();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to chat" })).toBeEnabled());
  });

  it("opens archived chats as Data's sub-view and returns to Data", async () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Open Data" }));
    expect(view()).toBe("section");
    expect(screen.getByRole("button", { name: "Back to Settings" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByRole("navigation", { name: "Settings location" })).toHaveTextContent("Data / Archived chats");
    const back = screen.getByRole("button", { name: "Back to Data" });
    await waitFor(() => expect(back).toHaveFocus());
    fireEvent.click(back);
    expect(screen.getByRole("navigation", { name: "Settings location" })).toHaveTextContent(/^Data$/u);
    await waitFor(() => expect(screen.getByRole("button", { name: "Manage" })).toHaveFocus());

    // Another section closes the sub-view.
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(tab("General"));
    fireEvent.click(tab("Data"));
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
  });

  it("lists Computers only while AIQSA Connect is on, runs its live list only while it is open, and leaves when it is turned off", async () => {
    const streams: FakeEventSource[] = [];
    vi.stubGlobal("EventSource", class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        streams.push(this);
      }
    });
    const { unmount } = render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    expect(screen.queryByRole("tab", { name: "Computers" })).toBeNull();
    unmount();

    render(<Shell connect />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    const tail = within(screen.getByRole("tablist", { name: "Settings sections" })).getAllByRole("tab").slice(-3);
    expect(tail.map(node => node.textContent)).toEqual(["Proxies", "Computers", "Claude Code & Codex"]);
    expect(streams).toEqual([]);

    fireEvent.click(tab("Computers"));
    const section = await screen.findByTestId("settings-computers-panel");
    expect(within(section).getByRole("heading", { level: 2, name: "Computers" })).toBeVisible();
    // The install steps name the origin the server passed.
    expect(within(section).getByTestId("connect-add-computer")).toHaveTextContent("ai.example.com");
    expect(streams).toHaveLength(1);
    fireEvent.click(tab("General"));
    expect(streams[0]!.closed).toBe(true);

    fireEvent.click(tab("Computers"));
    expect(streams).toHaveLength(2);
    act(() => streams[1]!.send("closed", { code: "connect_disabled" }));
    await waitFor(() => expect(tab("General")).toHaveAttribute("aria-selected", "true"));
    expect(view()).toBe("section");
    expect(screen.queryByRole("tab", { name: "Computers" })).toBeNull();
    expect(streams[1]!.closed).toBe(true);
  });
});
