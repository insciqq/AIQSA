import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectDeviceList } from "./ConnectDeviceList";
import { ConnectTestShell, MAC_ID, jsonResponse, testDevices, testShellValue } from "./connectShell.testFixtures";

const navigation = vi.hoisted(() => ({ pathname: "/connect", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push })
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>
}));

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  navigation.pathname = "/connect";
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  navigation.push.mockReset();
  vi.unstubAllGlobals();
});

function renderList() {
  const shell = testShellValue(testDevices());
  render(<ConnectTestShell value={shell.value}><ConnectDeviceList /></ConnectTestShell>);
  return shell;
}

describe("ConnectDeviceList", () => {
  it("lists computers with presence and sessions with program, folder and status", () => {
    renderList();
    const [mac, box] = screen.getAllByTestId("connect-device");
    expect(within(mac!).getByText("MacBook Pro")).toBeVisible();
    expect(within(mac!).getByTestId("connect-device-presence")).toHaveTextContent("Online");
    expect(within(box!).getByTestId("connect-device-presence")).toHaveTextContent("Last seen 3 h ago");
    expect(within(box!).getByText("No sessions")).toBeVisible();

    const rows = within(mac!).getAllByTestId("connect-session-row");
    // Newest first.
    expect(rows.map((row) => row.textContent)).toEqual([
      "PaymentsCodex · paymentsYour turn",
      "Rate limitClaude Code · aiqsaNeeds approval"
    ]);
    expect(rows[1]).toHaveAttribute("href", `/connect/${MAC_ID}/ac-k3m9q2`);
    expect(within(rows[1]!).getByTestId("connect-status-badge")).toHaveAttribute("data-status", "needs_approval");
  });

  it("marks the open session", () => {
    navigation.pathname = `/connect/${MAC_ID}/ac-p7x2we`;
    renderList();
    expect(screen.getByRole("link", { current: "page" })).toHaveTextContent("Payments");
  });

  it("revokes a computer only after confirming its consequences", async () => {
    navigation.pathname = `/connect/${MAC_ID}/ac-k3m9q2`;
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { source } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "MacBook Pro actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke…" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke MacBook Pro" });
    expect(dialog).toHaveTextContent("disconnected at once");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(source.removeDevice).toHaveBeenCalledWith(MAC_ID));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/connect/devices/${MAC_ID}`);
    expect(init?.method).toBe("DELETE");
    expect(navigation.push).toHaveBeenCalledWith("/connect");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the computer and names the reason when revoking fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: "connect_rate_limited" }, 429, { "retry-after": "9" }));
    const { source } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "MacBook Pro actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Try again in 9 s.");
    expect(source.removeDevice).not.toHaveBeenCalled();
  });

  it("cancels a revoke without a request", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "MacBook Pro actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a new session only on an online computer", () => {
    const shell = testShellValue(testDevices());
    render(<ConnectTestShell value={shell.value}><ConnectDeviceList /></ConnectTestShell>);
    fireEvent.click(screen.getByRole("button", { name: "build-box actions" }));
    expect(screen.queryByRole("menuitem", { name: "New session here" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    cleanup();
    render(<ConnectTestShell value={shell.value}><ConnectDeviceList /></ConnectTestShell>);
    fireEvent.click(screen.getByRole("button", { name: "MacBook Pro actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New session here" }));
    expect(shell.value.openNewSession).toHaveBeenCalledWith(MAC_ID);
  });

  it("separates loading and failure from an empty list", () => {
    const loading = testShellValue(null);
    render(<ConnectTestShell value={loading.value}><ConnectDeviceList /></ConnectTestShell>);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your computers");
    cleanup();
    const failed = testShellValue(null);
    render(
      <ConnectTestShell value={{ ...failed.value, snapshot: { connection: "connecting", devices: null, loadError: "network_error" } }}>
        <ConnectDeviceList />
      </ConnectTestShell>
    );
    expect(screen.getByRole("alert")).toHaveTextContent("AIQSA could not be reached");
  });
});
