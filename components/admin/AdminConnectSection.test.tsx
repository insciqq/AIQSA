import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_CONNECT_WARNING, AdminConnectSection } from "./AdminConnectSection";

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const reportNotice = vi.fn();

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  reportNotice.mockReset();
  vi.unstubAllGlobals();
});

function patchBodies() {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PATCH")
    .map(([url, init]) => ({ body: JSON.parse(String(init?.body)) as unknown, url: String(url) }));
}

describe("AdminConnectSection", () => {
  it("shows the switch off by default with its warning", async () => {
    fetchMock.mockResolvedValueOnce(json({ connect: { enabled: false, version: 1 } }));
    render(<AdminConnectSection reportNotice={reportNotice} />);
    const toggle = await screen.findByRole("switch", { name: "Enable AIQSA Connect" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(ADMIN_CONNECT_WARNING)).toBeVisible();
    expect(ADMIN_CONNECT_WARNING).toBe(
      "Lets users open terminals on their own computers from AIQSA. The server relays their terminal traffic."
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/connect");
  });

  it("saves with the version it read", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ connect: { enabled: false, version: 4 } }))
      .mockResolvedValueOnce(json({ connect: { enabled: true, version: 5 } }));
    render(<AdminConnectSection reportNotice={reportNotice} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable AIQSA Connect" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable AIQSA Connect" })).toHaveAttribute("aria-checked", "true"));
    expect(patchBodies()).toEqual([{ body: { enabled: true, expectedVersion: 4 }, url: "/api/admin/connect" }]);
    expect(reportNotice).toHaveBeenCalledWith("AIQSA Connect turned on.");
  });

  it("shows the current setting after a change from another session", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ connect: { enabled: false, version: 4 } }))
      .mockResolvedValueOnce(json({ error: "connect_policy_version_conflict" }, 409))
      .mockResolvedValueOnce(json({ connect: { enabled: true, version: 6 } }))
      .mockResolvedValueOnce(json({ connect: { enabled: false, version: 7 } }));
    render(<AdminConnectSection reportNotice={reportNotice} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable AIQSA Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another session");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable AIQSA Connect" })).toHaveAttribute("aria-checked", "true"));
    expect(reportNotice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("switch", { name: "Enable AIQSA Connect" }));
    await waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]!.body).toEqual({ enabled: false, expectedVersion: 6 });
  });

  it("explains an expired administrator session", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "unauthorized" }, 401));
    render(<AdminConnectSection reportNotice={reportNotice} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your administrator session has expired.");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
