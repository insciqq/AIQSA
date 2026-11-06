import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectComputerWire } from "@/lib/contracts/computer";
import { ConnectHomeView } from "./ConnectHomeView";
import { ConnectShell } from "./ConnectShell";
import { testComputers, testShellValue } from "./connectShell.testFixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/connect", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/app-shell/sessionActions", () => ({ signOutCurrentSession: vi.fn() }));

type FakeUserAgentData = { platform: string; getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string }> };

function setUserAgentData(data: FakeUserAgentData | undefined) {
  Object.defineProperty(navigator, "userAgentData", { configurable: true, value: data });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  setUserAgentData({ platform: "Windows" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUserAgentData(undefined);
});

function renderShell(computers: ConnectComputerWire[] = testComputers(), installOrigin: string | null = "https://ai.example.com") {
  const { source } = testShellValue(computers);
  render(
    <ConnectShell
      accountId="account-1"
      accountLabel="Dana"
      adminEntryVisible={false}
      installOrigin={installOrigin}
      onLeave={vi.fn()}
      source={source}
    >
      <ConnectHomeView />
    </ConnectShell>
  );
  return source;
}

describe("ConnectShell", () => {
  it("has its own rail: AIQSA Connect is current and Chats returns to the chat shell", () => {
    const source = renderShell();
    expect(source.start).toHaveBeenCalledOnce();
    const rail = screen.getByTestId("connect-rail");
    expect(within(rail).getByRole("link", { name: "Chats" })).toHaveAttribute("href", "/");
    expect(within(rail).getByRole("link", { name: "AIQSA Connect" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).queryByRole("link", { name: "Control Center" })).toBeNull();
    expect(screen.getAllByTestId("connect-computer")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByText(/notifications/iu)).toBeNull();
  });

  it("offers the Windows download named after this installation, with the SmartScreen note", () => {
    renderShell([]);
    const add = screen.getByTestId("connect-add-computer");
    expect(within(add).getByRole("radio", { name: "Windows" })).toHaveAttribute("aria-checked", "true");
    expect(within(add).getByTestId("connect-download-windows")).toHaveAttribute("href", "/connect/download/windows-amd64");
    expect(within(add).getByTestId("connect-download-windows-other")).toHaveAttribute("href", "/connect/download/windows-arm64");
    expect(add).toHaveTextContent("AIQSA Connect - ai.example.com.exe");
    expect(add).toHaveTextContent("More info");
    expect(add).toHaveTextContent("Run anyway");
    expect(add).toHaveTextContent("Approve");
  });

  it("puts ARM64 first on an ARM Windows that says so", async () => {
    setUserAgentData({ getHighEntropyValues: async () => ({ architecture: "arm" }), platform: "Windows" });
    renderShell([]);
    expect(await screen.findByText("For x64 PCs")).toHaveAttribute("href", "/connect/download/windows-amd64");
    expect(screen.getByTestId("connect-download-windows")).toHaveAttribute("href", "/connect/download/windows-arm64");
  });

  it("names a port and plain http in the Windows file name as the download does", () => {
    renderShell([], "http://192.168.1.20:3000");
    expect(screen.getByTestId("connect-add-windows")).toHaveTextContent("AIQSA Connect - http_192.168.1.20_3000.exe");
  });

  it("shows the login command instead of the installer for an IPv6 address", () => {
    renderShell([], "https://[2001:db8::1]:8443");
    const ipv6 = screen.getByTestId("connect-add-windows-ipv6");
    expect(screen.queryByTestId("connect-download-windows")).toBeNull();
    expect(within(ipv6).getByLabelText("Connect the computer command"))
      .toHaveTextContent(".\\aiqsa-connect-windows-amd64.exe login https://[2001:db8::1]:8443");
    expect(within(ipv6).getByRole("link", { name: /Download aiqsa-connect-windows-amd64\.exe/u }))
      .toHaveAttribute("href", "/connect/download/aiqsa-connect-windows-amd64.exe");
  });

  it("shows the macOS and Linux commands for this installation", () => {
    setUserAgentData({ platform: "macOS" });
    renderShell([]);
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
    renderShell([], null);
    expect(within(screen.getByTestId("connect-add-computer")).getByRole("alert")).toHaveTextContent("no valid public address");
  });
});
