import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectComputerList } from "./ConnectDeviceList";
import { ConnectTestComputers, MAC_ID, jsonResponse, testComputers, testComputersValue } from "./connectComputers.testFixtures";

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function renderList() {
  const shell = testComputersValue(testComputers());
  render(<ConnectTestComputers value={shell.value}><ConnectComputerList /></ConnectTestComputers>);
  return shell;
}

describe("ConnectComputerList", () => {
  it("lists computers with system, client version and presence", () => {
    renderList();
    const [mac, box] = screen.getAllByTestId("connect-computer");
    expect(within(mac!).getByText("MacBook Pro")).toBeVisible();
    expect(within(mac!).getByTestId("connect-computer-facts")).toHaveTextContent("macOS 15.1 · ARM64 · AIQSA Connect 0.4.22");
    expect(within(mac!).getByTestId("connect-computer-presence")).toHaveTextContent("Online");
    expect(within(box!).getByTestId("connect-computer-facts")).toHaveTextContent("Linux · x64 · AIQSA Connect 0.4.21");
    expect(within(box!).getByTestId("connect-computer-presence")).toHaveTextContent("Offline · last seen 3 h ago");
    expect(screen.queryByText(/session|terminal/iu)).toBeNull();
  });

  it("revokes a computer only after confirming its consequences", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { source } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Revoke MacBook Pro" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke MacBook Pro" });
    expect(dialog).toHaveTextContent("disconnected at once");
    expect(dialog).toHaveTextContent("can no longer work on it");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(source.removeComputer).toHaveBeenCalledWith(MAC_ID));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/connect/devices/${MAC_ID}`);
    expect(init?.method).toBe("DELETE");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("treats a computer that is already gone as revoked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: "connect_device_unavailable" }, 404));
    const { source } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Revoke MacBook Pro" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(source.removeComputer).toHaveBeenCalledWith(MAC_ID));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the computer and names the reason when revoking fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: "connect_rate_limited" }, 429, { "retry-after": "9" }));
    const { source } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Revoke MacBook Pro" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Try again in 9 s.");
    expect(source.removeComputer).not.toHaveBeenCalled();
  });

  it("cancels a revoke without a request", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Revoke MacBook Pro" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("separates loading and failure from an empty list", () => {
    const loading = testComputersValue(null);
    render(<ConnectTestComputers value={loading.value}><ConnectComputerList /></ConnectTestComputers>);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your computers");
    cleanup();
    const failed = testComputersValue(null);
    render(
      <ConnectTestComputers value={{ ...failed.value, snapshot: { computers: null, connection: "connecting", loadError: "network_error" } }}>
        <ConnectComputerList />
      </ConnectTestComputers>
    );
    expect(screen.getByRole("alert")).toHaveTextContent("AIQSA could not be reached");
    cleanup();
    const empty = testComputersValue([]);
    render(<ConnectTestComputers value={empty.value}><ConnectComputerList /></ConnectTestComputers>);
    expect(screen.getByTestId("connect-no-computers")).toHaveTextContent("No computers yet");
  });
});
