import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectComputerWire } from "@/lib/contracts/computer";
import { CONNECT_EVENTS_PATH } from "@/lib/contracts/connect";
import { ConnectComputersSection } from "./ConnectComputersSection";
import { FakeEventSource } from "./connect.testFixtures";
import { jsonResponse, testComputers, testComputersValue } from "./connectComputers.testFixtures";

type FakeUserAgentData = { platform: string; getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string }> };

function setUserAgentData(data: FakeUserAgentData | undefined) {
  Object.defineProperty(navigator, "userAgentData", { configurable: true, value: data });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let streams: FakeEventSource[] = [];

beforeEach(() => {
  streams = [];
  fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  // The live feed opens the browser's EventSource; this one is scripted.
  vi.stubGlobal("EventSource", class extends FakeEventSource {
    constructor(url: string) {
      super(url);
      streams.push(this);
    }
  });
  setUserAgentData({ platform: "Windows" });
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  setUserAgentData(undefined);
});

function renderSection(computers: ConnectComputerWire[] = testComputers(), installOrigin: string | null = "https://ai.example.com") {
  const { source } = testComputersValue(computers);
  const onDisabled = vi.fn();
  const view = render(<ConnectComputersSection installOrigin={installOrigin} onDisabled={onDisabled} source={source} />);
  return { onDisabled, source, view };
}

function renderLive() {
  const onDisabled = vi.fn();
  const view = render(<ConnectComputersSection installOrigin="https://ai.example.com" onDisabled={onDisabled} />);
  return { onDisabled, view };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

describe("ConnectComputersSection", () => {
  it("shows the computers under the Settings heading, then how to add one", () => {
    const { source } = renderSection();
    expect(source.start).toHaveBeenCalledOnce();
    const panel = screen.getByTestId("settings-computers-panel");
    expect(within(panel).getByRole("heading", { level: 2, name: "Computers" })).toBeVisible();
    expect(within(panel).getByRole("heading", { level: 3, name: "Your computers" })).toBeVisible();
    expect(within(panel).getByRole("heading", { level: 3, name: "Add a computer" })).toBeVisible();
    expect(screen.getAllByTestId("connect-computer")).toHaveLength(2);
    // No page shell of its own: Settings is the page.
    expect(screen.queryByTestId("connect-shell")).toBeNull();
    expect(screen.queryByTestId("connect-page-header")).toBeNull();
    expect(screen.queryByRole("link", { name: "Chats" })).toBeNull();
  });

  it("runs the live list only while it is open", () => {
    const { view } = renderLive();
    expect(streams).toHaveLength(1);
    expect(streams[0]!.url).toBe(CONNECT_EVENTS_PATH);
    act(() => streams[0]!.send("devices", { computers: testComputers() }));
    expect(screen.getAllByTestId("connect-computer")).toHaveLength(2);
    view.unmount();
    expect(streams[0]!.closed).toBe(true);
    expect(streams).toHaveLength(1);
  });

  it("leaves when an administrator turns AIQSA Connect off", () => {
    const { onDisabled } = renderLive();
    act(() => streams[0]!.send("closed", { code: "connect_disabled" }));
    expect(onDisabled).toHaveBeenCalledOnce();
    expect(streams[0]!.closed).toBe(true);
  });

  it("leaves an ended sign-in to the chat shell's session check", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const { onDisabled } = renderLive();
    act(() => streams[0]!.send("closed", { code: "connect_unauthorized" }));
    await flush();
    // One list request through the shell's fetch, which reports the expired session; no reload, no new stream.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/connect/devices");
    expect(onDisabled).not.toHaveBeenCalled();
    expect(streams).toHaveLength(1);
  });

  it("resumes the list when the session turns out to be valid", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ computers: [] }));
    renderLive();
    act(() => streams[0]!.send("closed", { code: "connect_unauthorized" }));
    await flush();
    expect(streams).toHaveLength(2);
  });

  it("offers the Windows download named after this installation, with the SmartScreen note", () => {
    renderSection([]);
    const add = screen.getByTestId("connect-add-computer");
    expect(within(add).getByRole("radio", { name: "Windows" })).toHaveAttribute("aria-checked", "true");
    expect(within(add).getByTestId("connect-download-windows")).toHaveAttribute("href", "/connect/download/aiqsa-connect-windows-amd64.exe");
    expect(within(add).getByTestId("connect-download-windows-other")).toHaveAttribute("href", "/connect/download/aiqsa-connect-windows-arm64.exe");
    expect(add).toHaveTextContent("AIQSA Connect - ai.example.com.exe");
    expect(add).toHaveTextContent("More info");
    expect(add).toHaveTextContent("Run anyway");
    expect(add).toHaveTextContent("Approve");
  });

  it("puts ARM64 first on an ARM Windows that says so", async () => {
    setUserAgentData({ getHighEntropyValues: async () => ({ architecture: "arm" }), platform: "Windows" });
    renderSection([]);
    expect(await screen.findByText("For x64 PCs")).toHaveAttribute("href", "/connect/download/aiqsa-connect-windows-amd64.exe");
    expect(screen.getByTestId("connect-download-windows")).toHaveAttribute("href", "/connect/download/aiqsa-connect-windows-arm64.exe");
  });

  it("names a port and plain http in the Windows file name as the download does", () => {
    renderSection([], "http://192.168.1.20:3000");
    expect(screen.getByTestId("connect-add-windows")).toHaveTextContent("AIQSA Connect - http_192.168.1.20_3000.exe");
  });

  it("shows the login command instead of the installer for an IPv6 address", () => {
    renderSection([], "https://[2001:db8::1]:8443");
    const ipv6 = screen.getByTestId("connect-add-windows-ipv6");
    expect(screen.queryByTestId("connect-download-windows")).toBeNull();
    expect(within(ipv6).getByLabelText("Connect the computer command"))
      .toHaveTextContent(".\\aiqsa-connect-windows-amd64.exe login https://[2001:db8::1]:8443");
    expect(within(ipv6).getByRole("link", { name: /Download aiqsa-connect-windows-amd64\.exe/u }))
      .toHaveAttribute("href", "/connect/download/aiqsa-connect-windows-amd64.exe");
  });

  it("shows the macOS and Linux commands for this installation", () => {
    setUserAgentData({ platform: "macOS" });
    renderSection([]);
    const add = screen.getByTestId("connect-add-computer");
    expect(within(add).getByRole("radio", { name: "macOS or Linux" })).toHaveAttribute("aria-checked", "true");
    expect(within(add).getByLabelText("Install AIQSA Connect command"))
      .toHaveTextContent("curl -fsSL https://ai.example.com/connect/install.sh | sh");
    expect(within(add).getByLabelText("Connect the computer command"))
      .toHaveTextContent("aiqsa-connect login https://ai.example.com");
    expect(within(add).getByLabelText("Keep it running command")).toHaveTextContent("aiqsa-connect service install");
    expect(add).not.toHaveTextContent(/tmux|setup|Claude Code/u);
    fireEvent.click(within(add).getByRole("radio", { name: "Windows" }));
    expect(within(add).getByTestId("connect-download-windows")).toBeVisible();
  });

  it("says computers cannot be added without a public address", () => {
    renderSection([], null);
    expect(within(screen.getByTestId("connect-add-computer")).getByRole("alert")).toHaveTextContent("no valid public address");
  });
});
