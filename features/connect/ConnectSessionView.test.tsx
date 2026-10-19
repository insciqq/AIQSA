import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectDevice } from "@/lib/contracts/connect";
import { base64, fakeViewTransport } from "./connect.testFixtures";
import { CONNECT_OPTIONS_RETRY_MS } from "./ConnectSessionControls";
import { ConnectSessionView } from "./ConnectSessionView";
import { ConnectTestShell, MAC_ID, jsonResponse, testDevices, testShellValue } from "./connectShell.testFixtures";
import { resetConnectDictationForTests } from "./useConnectDictation";

const fakes = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 100;
    rows = 30;
    modes = { applicationCursorKeysMode: false, bracketedPasteMode: false };
    options: Record<string, unknown>;
    written: string[] = [];
    focus = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
    private readonly dataListeners: Listener<string>[] = [];
    private readonly resizeListeners: Listener<{ cols: number; rows: number }>[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      FakeTerminal.instances.push(this);
    }
    loadAddon(addon: { terminal?: FakeTerminal }) {
      addon.terminal = this;
    }
    open() {}
    write(bytes: Uint8Array) {
      this.written.push(new TextDecoder().decode(bytes));
    }
    onData(listener: Listener<string>) {
      this.dataListeners.push(listener);
      return { dispose: () => undefined };
    }
    onResize(listener: Listener<{ cols: number; rows: number }>) {
      this.resizeListeners.push(listener);
      return { dispose: () => undefined };
    }
    type(data: string) {
      if (this.options.disableStdin) return;
      for (const listener of this.dataListeners) listener(data);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      for (const listener of this.resizeListeners) listener({ cols, rows });
    }
  }
  class FakeFitAddon {
    static nextSize: { cols: number; rows: number } | null = null;
    terminal?: FakeTerminal;
    fit = vi.fn(() => {
      if (FakeFitAddon.nextSize) this.terminal?.resize(FakeFitAddon.nextSize.cols, FakeFitAddon.nextSize.rows);
    });
  }
  return { FakeFitAddon, FakeTerminal };
});

vi.mock("./connectXtermLoader", () => ({
  loadConnectXterm: async () => ({
    CONNECT_TERMINAL_SYMBOLS_FONT_FAMILY: "'Symbols Test'",
    FitAddon: fakes.FakeFitAddon,
    Terminal: fakes.FakeTerminal
  })
}));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/connect", useRouter: () => ({ push: navigation.push }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>
}));

const SESSION_ID = "ac-k3m9q2";
const SESSION_PATH = `/api/connect/devices/${MAC_ID}/sessions/${SESSION_ID}`;
const OPTIONS = [{ key: "1", label: "Yes" }, { key: "2", label: "Yes, and don't ask again" }, { key: "3", label: "No" }];
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const routes = {
  catalog: () => jsonResponse({ catalog: { dictation: { available: true, unavailableReason: null } } }),
  endSession: () => jsonResponse({}),
  history: () => jsonResponse({ text: "line one\nline two\n⎿  Read 182 lines" }),
  options: () => jsonResponse({ options: OPTIONS })
};
let resizeObservers: (() => void)[] = [];

function requestPath(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
}

function calls(path: string) {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input) === path);
}

/** `matches` for the touch layout query; null removes matchMedia. */
function stubTouchLayout(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: () => undefined,
    matches: matches && query.includes("pointer: coarse"),
    media: query,
    removeEventListener: () => undefined
  }));
}

beforeEach(() => {
  fakes.FakeTerminal.instances = [];
  fakes.FakeFitAddon.nextSize = null;
  resizeObservers = [];
  resetConnectDictationForTests();
  fetchMock.mockImplementation(async (input) => {
    const path = requestPath(input);
    if (path === "/api/me/catalog") return routes.catalog();
    if (path === `${SESSION_PATH}/options`) return routes.options();
    if (path === `${SESSION_PATH}/history`) return routes.history();
    if (path === SESSION_PATH) return routes.endSession();
    return jsonResponse({ code: "connect_not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) {
      resizeObservers.push(callback);
    }
    disconnect() {}
    observe() {}
  });
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  navigation.push.mockReset();
  routes.catalog = () => jsonResponse({ catalog: { dictation: { available: true, unavailableReason: null } } });
  routes.endSession = () => jsonResponse({});
  routes.history = () => jsonResponse({ text: "line one\nline two\n⎿  Read 182 lines" });
  routes.options = () => jsonResponse({ options: OPTIONS });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function sessionView(transport: ReturnType<typeof fakeViewTransport>["transport"]) {
  return <ConnectSessionView deviceId={MAC_ID} sessionId={SESSION_ID} transport={transport} />;
}

function renderSession(devices: ConnectDevice[] = testDevices()) {
  const fake = fakeViewTransport();
  const shell = testShellValue(devices);
  const view = render(<ConnectTestShell value={shell.value}>{sessionView(fake.transport)}</ConnectTestShell>);
  const rerender = (next: ConnectDevice[]) => {
    const nextShell = testShellValue(next, { leave: shell.value.leave });
    view.rerender(<ConnectTestShell value={nextShell.value}>{sessionView(fake.transport)}</ConnectTestShell>);
  };
  return { ...fake, ...shell, rerender, view };
}

async function terminal() {
  await waitFor(() => expect(fakes.FakeTerminal.instances).toHaveLength(1));
  return fakes.FakeTerminal.instances[0]!;
}

async function liveSession(devices?: ConnectDevice[]) {
  const rendered = renderSession(devices);
  const term = await terminal();
  await waitFor(() => expect(rendered.streams).toHaveLength(1));
  act(() => rendered.streams[0]!.open());
  return { ...rendered, term };
}

function sent(transport: ReturnType<typeof fakeViewTransport>["transport"]) {
  return transport.sendInput.mock.calls.map(([, data]) => data);
}

function withStatus(status: "needs_approval" | "running", statusAt?: string): ConnectDevice[] {
  return testDevices().map((device) => device.id !== MAC_ID ? device : {
    ...device,
    sessions: device.sessions.map((session) => session.id !== SESSION_ID ? session : {
      ...session,
      status,
      ...(statusAt ? { statusAt } : {})
    })
  });
}

describe("ConnectSessionView", () => {
  it("shows the session header and a live terminal with the contract options", async () => {
    const { streams, transport } = renderSession();
    const header = screen.getByTestId("connect-page-header");
    expect(header).toHaveTextContent("Rate limit");
    expect(header).toHaveTextContent("MacBook Pro · Claude Code · aiqsa");
    expect(within(header).getByTestId("connect-status-badge")).toHaveTextContent("Needs approval");
    // A desktop gets no key bar and starts with the text field closed.
    expect(screen.queryByTestId("connect-key-bar")).toBeNull();
    expect(screen.queryByTestId("connect-compose-bar")).toBeNull();

    const term = await terminal();
    expect(term.options).toMatchObject({ allowProposedApi: false, disableStdin: true, fontSize: 14, scrollback: 5_000 });
    expect(term.options.fontFamily).toMatch(/'DejaVu Sans Mono', 'Liberation Mono', 'Symbols Test', monospace$/u);
    await waitFor(() => expect(transport.createView).toHaveBeenCalledWith({ cols: 100, deviceId: MAC_ID, rows: 30, sessionId: SESSION_ID }));
    expect(screen.getByTestId("connect-terminal-state")).toHaveTextContent("Connecting to the session");

    act(() => {
      streams[0]!.open();
      streams[0]!.send("output", { data: base64("$ ls\r\n"), seq: 0 });
      streams[0]!.send("output", { data: base64("README.md\r\n"), seq: 1 });
    });
    expect(term.written).toEqual(["$ ls\r\n", "README.md\r\n"]);
    expect(term.options.disableStdin).toBe(false);
    expect(term.focus).toHaveBeenCalled();
    expect(screen.queryByTestId("connect-terminal-state")).toBeNull();
  });

  it("sends keystrokes in order, one request at a time", async () => {
    const { streams, transport } = renderSession();
    const term = await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    let release!: () => void;
    transport.sendInput.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ data: undefined, ok: true });
    }));
    act(() => streams[0]!.open());
    term.type("g");
    term.type("it");
    term.type(" status\r");
    expect(sent(transport)).toEqual(["g"]);
    await act(async () => release());
    expect(sent(transport)).toEqual(["g", "it status\r"]);
  });

  it("resizes the view after the window settles", async () => {
    const { streams, transport } = renderSession();
    const term = await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0]!.open());
    fakes.FakeFitAddon.nextSize = { cols: 140, rows: 44 };
    resizeObservers[0]!();
    resizeObservers[0]!();
    await waitFor(() => expect(transport.resize).toHaveBeenCalledWith(expect.any(String), 140, 44));
    expect(transport.resize).toHaveBeenCalledTimes(1);
    expect(term.cols).toBe(140);
  });

  it("waits while the computer is offline and reconnects when it is back", async () => {
    const devices = testDevices();
    const { rerender, streams, transport } = renderSession(devices);
    await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => {
      streams[0]!.open();
      streams[0]!.send("closed", { reason: "connect_device_offline" });
    });
    expect(screen.getByTestId("connect-terminal-state")).toHaveTextContent("MacBook Pro is offline");

    rerender(devices.map((device) => device.id === MAC_ID ? { ...device, online: false } : device));
    expect(transport.createView).toHaveBeenCalledTimes(1);
    rerender(devices);
    await waitFor(() => expect(transport.createView).toHaveBeenCalledTimes(2));
    act(() => streams[1]!.open());
    expect(screen.queryByTestId("connect-terminal-state")).toBeNull();
  });

  it("keeps the last known title, program and status while the computer is offline", async () => {
    const devices = testDevices();
    const { rerender } = renderSession(devices);
    await terminal();
    // An offline computer lists no sessions.
    rerender(devices.map((device) => device.id === MAC_ID ? { ...device, online: false, sessions: [] } : device));
    const header = screen.getByTestId("connect-page-header");
    expect(header).toHaveTextContent("Rate limit");
    expect(header).toHaveTextContent("MacBook Pro · Claude Code · aiqsa");
    expect(within(header).getByTestId("connect-status-badge")).toHaveTextContent("Needs approval");
    // Nothing can be answered on an offline computer.
    expect(screen.queryByTestId("connect-answer-strip")).toBeNull();
  });

  it("shows an ended session with the way back", async () => {
    const { streams } = renderSession();
    await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => {
      streams[0]!.open();
      streams[0]!.send("closed", { reason: "session_ended" });
    });
    const state = screen.getByTestId("connect-terminal-state");
    expect(state).toHaveTextContent("This session has ended.");
    expect(within(state).getByRole("link", { name: "Back to sessions" })).toHaveAttribute("href", "/connect");
  });

  it("counts down while reconnecting and reconnects on request", async () => {
    const { streams, transport } = renderSession();
    await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => {
      streams[0]!.open();
      streams[0]!.send("closed", { reason: "error" });
    });
    expect(screen.getByTestId("connect-terminal-state")).toHaveTextContent(/Reconnecting in \d s/u);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }));
    await waitFor(() => expect(transport.createView).toHaveBeenCalledTimes(2));
  });

  it("pauses typing when a keystroke may be lost and warns on the reopened terminal", async () => {
    const { streams, transport } = renderSession();
    const term = await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    transport.sendInput.mockResolvedValueOnce({ code: "network_error", ok: false });
    act(() => streams[0]!.open());
    await act(async () => term.type("x"));
    expect(screen.getByTestId("connect-terminal-state")).toHaveTextContent("may not have reached the computer");
    expect(term.options.disableStdin).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }));
    await waitFor(() => expect(streams).toHaveLength(2));
    act(() => streams[1]!.open());
    expect(screen.queryByTestId("connect-terminal-state")).toBeNull();
    const notice = screen.getByTestId("connect-terminal-input-lost");
    expect(notice).toHaveTextContent("Check the command line before you press Enter.");
    expect(term.options.disableStdin).toBe(false);
    fireEvent.click(within(notice).getByRole("button", { name: "Got it" }));
    expect(screen.queryByTestId("connect-terminal-input-lost")).toBeNull();
  });

  it("leaves the mode when the feature is turned off", async () => {
    const { streams, value } = renderSession();
    await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0]!.send("closed", { reason: "connect_disabled" }));
    expect(value.leave).toHaveBeenCalledWith("disabled");
  });

  it("ends the session only after confirmation and returns to the list", async () => {
    const { source } = renderSession();
    await terminal();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "End session…" }));
    const dialog = screen.getByRole("dialog", { name: "End Rate limit" });
    expect(dialog).toHaveTextContent("stop on MacBook Pro");
    expect(calls(SESSION_PATH)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm end session" }));
    await waitFor(() => expect(source.removeSession).toHaveBeenCalledWith(MAC_ID, SESSION_ID));
    expect(calls(SESSION_PATH)).toHaveLength(1);
    expect(calls(SESSION_PATH)[0]![1]?.method).toBe("DELETE");
    expect(navigation.push).toHaveBeenCalledWith("/connect");
  });

  it("keeps the session and names the reason when ending fails", async () => {
    routes.endSession = () => jsonResponse({ code: "connect_device_offline" }, 409);
    const { source } = renderSession();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "End session…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This computer is offline.");
    expect(source.removeSession).not.toHaveBeenCalled();
  });

  it("answers an unknown computer like a missing session", () => {
    const shell = testShellValue(testDevices().filter((device) => device.id !== MAC_ID));
    render(<ConnectTestShell value={shell.value}>{sessionView(fakeViewTransport().transport)}</ConnectTestShell>);
    expect(screen.getByTestId("connect-session-not-found")).toHaveTextContent("This session is not available.");
  });
});

describe("ConnectSessionView answer buttons", () => {
  it("offers the agent's numbered choices and sends a key only when tapped", async () => {
    const { transport } = await liveSession();
    const strip = await screen.findByTestId("connect-answer-strip");
    const yes = await within(strip).findByRole("button", { name: "1 Yes" });
    expect(within(strip).getByRole("button", { name: "2 Yes, and don't ask again" })).toBeEnabled();
    expect(calls(`${SESSION_PATH}/options`)).toHaveLength(1);
    expect(sent(transport)).toEqual([]);
    fireEvent.click(yes);
    expect(sent(transport)).toEqual(["1"]);
  });

  it("falls back to Enter, Esc, y and n when no choices can be read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routes.options = () => jsonResponse({ options: [] });
    const { transport } = await liveSession();
    const strip = screen.getByTestId("connect-answer-strip");
    expect(within(strip).getByRole("status")).toHaveTextContent("Reading the choices");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECT_OPTIONS_RETRY_MS);
    });
    await waitFor(() => expect(calls(`${SESSION_PATH}/options`)).toHaveLength(2));
    const buttons = await within(strip).findAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Enter", "Esc", "y", "n"]);
    fireEvent.click(within(strip).getByRole("button", { name: "Esc" }));
    fireEvent.click(within(strip).getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(sent(transport).join("")).toBe("\u001b\r"));
  });

  it("disappears when the session stops asking and reads the choices again on the next request", async () => {
    const { rerender } = await liveSession();
    await screen.findByRole("button", { name: "1 Yes" });
    rerender(withStatus("running"));
    expect(screen.queryByTestId("connect-answer-strip")).toBeNull();
    rerender(withStatus("needs_approval", new Date().toISOString()));
    await screen.findByRole("button", { name: "1 Yes" });
    expect(calls(`${SESSION_PATH}/options`)).toHaveLength(2);
  });
});

describe("ConnectSessionView touch controls", () => {
  it("sends each key bar key with the terminal's cursor mode and a one-key Ctrl", async () => {
    stubTouchLayout(true);
    const { term, transport } = await liveSession(withStatus("running"));
    const bar = screen.getByTestId("connect-key-bar");
    const press = (name: string) => fireEvent.click(within(bar).getByRole("button", { name }));
    for (const name of ["Escape", "Tab", "Shift Tab", "Left", "Up", "Down", "Right", "Control C", "Enter"]) press(name);
    term.modes.applicationCursorKeysMode = true;
    press("Up");
    press("Control, for the next key");
    expect(within(bar).getByRole("button", { name: "Control, for the next key" })).toHaveAttribute("aria-pressed", "true");
    act(() => {
      term.type("c");
      term.type("c");
    });
    expect(within(bar).getByRole("button", { name: "Control, for the next key" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(sent(transport).join("")).toBe(
      "\u001b\t\u001b[Z\u001b[D\u001b[A\u001b[B\u001b[C\u0003\r\u001bOA\u0003c"
    ));
  });

  it("keeps the focus where it is when a key is tapped", async () => {
    stubTouchLayout(true);
    await liveSession(withStatus("running"));
    const field = screen.getByTestId("connect-compose-field");
    field.focus();
    const key = within(screen.getByTestId("connect-key-bar")).getByRole("button", { name: "Tab" });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    key.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("sends the text field as a bracketed paste with Enter and keeps a draft per session", async () => {
    stubTouchLayout(true);
    const { term, transport, view } = await liveSession(withStatus("running"));
    expect(await screen.findByRole("button", { name: "Dictate" })).toBeInTheDocument();
    const field = screen.getByTestId("connect-compose-field");
    const send = screen.getByRole("button", { name: "Send to the terminal" });
    expect(send).toBeDisabled();
    fireEvent.change(field, { target: { value: "run the tests" } });
    fireEvent.click(send);
    term.modes.bracketedPasteMode = true;
    fireEvent.change(field, { target: { value: "then\nfix them" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(sent(transport).join("")).toBe(
      "run the tests\r\u001b[200~then\rfix them\u001b[201~\r"
    ));
    expect(field).toHaveValue("");

    // A draft not sent survives leaving the session and coming back.
    fireEvent.change(field, { target: { value: "half a thought" } });
    view.unmount();
    renderSession(withStatus("running"));
    expect(screen.getByTestId("connect-compose-field")).toHaveValue("half a thought");
  });

  it("sends the next character typed into the text field as a control character while Ctrl is armed", async () => {
    stubTouchLayout(true);
    const { transport } = await liveSession(withStatus("running"));
    fireEvent.click(screen.getByRole("button", { name: "Control, for the next key" }));
    const field = screen.getByTestId("connect-compose-field");
    const typed = new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: "d", inputType: "insertText" });
    field.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(true);
    const next = new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: "d", inputType: "insertText" });
    field.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    await waitFor(() => expect(sent(transport)).toEqual(["\u0004"]));
  });

  it("hides the microphone when dictation is not set up", async () => {
    stubTouchLayout(true);
    routes.catalog = () => jsonResponse({ catalog: { dictation: { available: false, unavailableReason: "not_configured" } } });
    await liveSession(withStatus("running"));
    await waitFor(() => expect(calls("/api/me/catalog")).toHaveLength(1));
    expect(screen.getByTestId("connect-compose-bar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("opens the text field on the desktop from the header", async () => {
    await liveSession(withStatus("running"));
    const toggle = screen.getByRole("button", { name: "Text field" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("connect-compose-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-key-bar")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("connect-compose-bar")).toBeNull();
  });

  it("stays above an overlaid keyboard and sends the new size", async () => {
    stubTouchLayout(true);
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 844);
    const { term, transport } = await liveSession(withStatus("running"));
    const root = screen.getByTestId("connect-session-view");
    expect(root.style.paddingBottom).toBe("");

    fakes.FakeFitAddon.nextSize = { cols: 44, rows: 12 };
    act(() => {
      viewport.height = 508;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(root.style.paddingBottom).toBe("336px");
    expect(root).toHaveAttribute("data-keyboard", "open");
    expect(within(root).getByTestId("connect-key-bar")).toBeInTheDocument();
    expect(within(root).getByTestId("connect-compose-bar")).toBeInTheDocument();
    await waitFor(() => expect(transport.resize).toHaveBeenCalledWith(expect.any(String), 44, 12));
    expect(term.cols).toBe(44);
  });

  it("uses the smaller terminal font on phones", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      addEventListener: () => undefined,
      matches: query.includes("max-width: 639px") || query.includes("max-width: 767px"),
      media: query,
      removeEventListener: () => undefined
    }));
    renderSession(withStatus("running"));
    const term = await terminal();
    expect(term.options.fontSize).toBe(13);
    expect(screen.getByTestId("connect-key-bar")).toBeInTheDocument();
  });
});

describe("ConnectSessionView history", () => {
  it("opens the session's text at the newest line and reads it again on Refresh", async () => {
    await liveSession(withStatus("running"));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    const sheet = await screen.findByRole("dialog", { name: "History" });
    const text = await within(sheet).findByTestId("connect-history-text");
    expect(text.tagName).toBe("PRE");
    expect(text).toHaveTextContent("line two");
    expect(text.style.fontFamily).toContain("'Symbols Test'");

    routes.history = () => jsonResponse({ text: "line one\nline two\nline three" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(within(sheet).getByTestId("connect-history-text")).toHaveTextContent("line three"));
    expect(calls(`${SESSION_PATH}/history`)).toHaveLength(2);

    Object.defineProperty(text, "scrollHeight", { configurable: true, value: 900 });
    text.scrollTop = 0;
    fireEvent.click(within(sheet).getByRole("button", { name: "Jump to bottom" }));
    expect(text.scrollTop).toBe(900);

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "History" })).toBeNull();
  });

  it("names a failed read and keeps the text it already shows", async () => {
    await liveSession(withStatus("running"));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    const sheet = await screen.findByRole("dialog", { name: "History" });
    await within(sheet).findByTestId("connect-history-text");
    routes.history = () => jsonResponse({ code: "connect_device_offline" }, 409);
    fireEvent.click(within(sheet).getByRole("button", { name: "Refresh" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This computer is offline.");
    expect(within(sheet).getByTestId("connect-history-text")).toHaveTextContent("line two");
  });
});
