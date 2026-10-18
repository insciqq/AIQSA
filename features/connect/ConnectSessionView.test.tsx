import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64, fakeViewTransport } from "./connect.testFixtures";
import { ConnectSessionView } from "./ConnectSessionView";
import { ConnectTestShell, MAC_ID, jsonResponse, testDevices, testShellValue } from "./connectShell.testFixtures";

const fakes = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 100;
    rows = 30;
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
  loadConnectXterm: async () => ({ FitAddon: fakes.FakeFitAddon, Terminal: fakes.FakeTerminal })
}));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/connect", useRouter: () => ({ push: navigation.push }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>
}));

const SESSION_ID = "ac-k3m9q2";
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let resizeObservers: (() => void)[] = [];

beforeEach(() => {
  fakes.FakeTerminal.instances = [];
  fakes.FakeFitAddon.nextSize = null;
  resizeObservers = [];
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
  vi.unstubAllGlobals();
});

function renderSession(devices = testDevices()) {
  const fake = fakeViewTransport();
  const shell = testShellValue(devices);
  const view = render(
    <ConnectTestShell value={shell.value}>
      <ConnectSessionView deviceId={MAC_ID} sessionId={SESSION_ID} transport={fake.transport} />
    </ConnectTestShell>
  );
  return { ...fake, ...shell, view };
}

async function terminal() {
  await waitFor(() => expect(fakes.FakeTerminal.instances).toHaveLength(1));
  return fakes.FakeTerminal.instances[0]!;
}

describe("ConnectSessionView", () => {
  it("shows the session header and a live terminal with the contract options", async () => {
    const { streams, transport } = renderSession();
    const header = screen.getByTestId("connect-page-header");
    expect(header).toHaveTextContent("Rate limit");
    expect(header).toHaveTextContent("MacBook Pro · Claude Code · aiqsa");
    expect(within(header).getByTestId("connect-status-badge")).toHaveTextContent("Needs approval");
    expect(screen.getByTestId("connect-session-controls")).toBeEmptyDOMElement();

    const term = await terminal();
    expect(term.options).toMatchObject({ allowProposedApi: false, disableStdin: true, scrollback: 5_000 });
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
    expect(transport.sendInput.mock.calls.map(([, data]) => data)).toEqual(["g"]);
    await act(async () => release());
    expect(transport.sendInput.mock.calls.map(([, data]) => data)).toEqual(["g", "it status\r"]);
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
    const { streams, transport, value, view } = renderSession(devices);
    await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => {
      streams[0]!.open();
      streams[0]!.send("closed", { reason: "connect_device_offline" });
    });
    expect(screen.getByTestId("connect-terminal-state")).toHaveTextContent("MacBook Pro is offline");

    const offline = devices.map((device) => device.id === MAC_ID ? { ...device, online: false } : device);
    const offlineShell = testShellValue(offline, { leave: value.leave });
    view.rerender(
      <ConnectTestShell value={offlineShell.value}>
        <ConnectSessionView deviceId={MAC_ID} sessionId={SESSION_ID} transport={transport} />
      </ConnectTestShell>
    );
    expect(transport.createView).toHaveBeenCalledTimes(1);
    const onlineShell = testShellValue(devices, { leave: value.leave });
    view.rerender(
      <ConnectTestShell value={onlineShell.value}>
        <ConnectSessionView deviceId={MAC_ID} sessionId={SESSION_ID} transport={transport} />
      </ConnectTestShell>
    );
    await waitFor(() => expect(transport.createView).toHaveBeenCalledTimes(2));
    act(() => streams[1]!.open());
    expect(screen.queryByTestId("connect-terminal-state")).toBeNull();
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

  it("leaves the mode when the feature is turned off", async () => {
    const { streams, value } = renderSession();
    await terminal();
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0]!.send("closed", { reason: "connect_disabled" }));
    expect(value.leave).toHaveBeenCalledWith("disabled");
  });

  it("ends the session only after confirmation and returns to the list", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const { source } = renderSession();
    await terminal();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.queryByRole("menuitem", { name: "History" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "End session…" }));
    const dialog = screen.getByRole("dialog", { name: "End Rate limit" });
    expect(dialog).toHaveTextContent("stop on MacBook Pro");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm end session" }));
    await waitFor(() => expect(source.removeSession).toHaveBeenCalledWith(MAC_ID, SESSION_ID));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/connect/devices/${MAC_ID}/sessions/${SESSION_ID}`);
    expect(init?.method).toBe("DELETE");
    expect(navigation.push).toHaveBeenCalledWith("/connect");
  });

  it("keeps the session and names the reason when ending fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: "connect_device_offline" }, 409));
    const { source } = renderSession();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "End session…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm end session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This computer is offline.");
    expect(source.removeSession).not.toHaveBeenCalled();
  });

  it("answers an unknown computer like a missing session", () => {
    const shell = testShellValue(testDevices().filter((device) => device.id !== MAC_ID));
    render(
      <ConnectTestShell value={shell.value}>
        <ConnectSessionView deviceId={MAC_ID} sessionId={SESSION_ID} transport={fakeViewTransport().transport} />
      </ConnectTestShell>
    );
    expect(screen.getByTestId("connect-session-not-found")).toHaveTextContent("This session is not available.");
  });

  it("offers History when the touch layout provides it", async () => {
    const onOpenHistory = vi.fn();
    const shell = testShellValue(testDevices());
    render(
      <ConnectTestShell value={shell.value}>
        <ConnectSessionView
          deviceId={MAC_ID}
          onOpenHistory={onOpenHistory}
          sessionId={SESSION_ID}
          transport={fakeViewTransport().transport}
        />
      </ConnectTestShell>
    );
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });
});
