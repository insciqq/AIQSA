import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceOverviewWire } from "@/lib/contracts/workspaceOverview";
import { AdminWorkspaceOverview } from "./AdminWorkspaceOverview";

const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./adminWorkspaceApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./adminWorkspaceApi")>(), getAdminWorkspaceOverview: api.read
}));

const overview: WorkspaceOverviewWire = {
  activeCount: 21, filter: "active", observedAt: "2026-09-09T12:00:00.000Z", page: 1, pageSize: 20,
  rows: [{ context: "personal", id: "ws-1234567890abcdef", lastActiveAt: "2026-09-09T11:30:00.000Z", state: "ready", user: "Fixture user" }],
  state: "fresh", stoppedCount: 2, totalCount: 21, transitioningCount: 1, unknownCount: 1,
  updatedAt: "2026-09-09T12:00:00.000Z"
};
beforeEach(() => api.read.mockReset().mockResolvedValue({ data: overview, ok: true }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("administrator Workspace environment list", () => {
  it("shows the full live count, safe row metadata, and paginates independently of that count", async () => {
    api.read.mockResolvedValueOnce({ data: overview, ok: true }).mockResolvedValueOnce({
      data: { ...overview, page: 2, rows: [{ ...overview.rows[0], id: "ws-abcdef1234567890", state: "running", user: "Second chat" }] }, ok: true
    });
    render(<AdminWorkspaceOverview />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Workspace activity");
    expect(await screen.findByText("21 active environments")).toBeVisible();
    expect(screen.getByText("1 changing · 1 unknown · 2 stopped")).toBeVisible();
    const rows = screen.getByRole("list", { name: "Workspace environments" });
    expect(within(rows).getByText("Fixture user")).toBeVisible();
    expect(within(rows).getByText("ws-1234567890abcdef")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next environments" }));
    expect(await screen.findByText("Second chat")).toBeVisible();
    expect(screen.queryByText("Fixture user")).not.toBeInTheDocument();
    expect(screen.getByText("21 active environments")).toBeVisible();
    expect(screen.getByText("Page 2 of 2 · 21 environments")).toBeVisible();
    expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "active", page: 2 }));
  });

  it("keeps failed refreshes visibly stale and never converts an outage into an empty count", async () => {
    render(<AdminWorkspaceOverview />);
    await screen.findByText("21 active environments");
    api.read.mockResolvedValue({ error: "workspace_overview_unavailable", ok: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be refreshed");
    expect(screen.getByText("21 last known active environments")).toBeVisible();
    expect(screen.getByText("Last seen: Ready")).toBeVisible();
    expect(screen.queryByText("No active environments.")).not.toBeInTheDocument();
    expect(screen.getByText(/Activity is stale/)).toBeVisible();
  });

  it("distinguishes an unknown first observation from a confirmed empty observation", async () => {
    api.read.mockResolvedValue({ data: { ...overview, activeCount: null, observedAt: null,
      rows: [], state: "unavailable", stoppedCount: null, totalCount: 0 }, ok: true });
    render(<AdminWorkspaceOverview />);
    expect(await screen.findByText("Live environment count is unknown.")).toBeVisible();
    expect(screen.queryByText("No active environments.")).not.toBeInTheDocument();
    api.read.mockResolvedValue({ data: { ...overview, activeCount: 0, rows: [], totalCount: 0 }, ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(await screen.findByText("No active environments.")).toBeVisible();
  });

  it("cancels old filter requests and discards late results after changing filters or leaving", async () => {
    let finish!: (value: unknown) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<AdminWorkspaceOverview />);
    const firstSignal = api.read.mock.calls[0]![0].signal as AbortSignal;
    api.read.mockResolvedValue({ data: { ...overview, filter: "all", rows: [{ ...overview.rows[0], state: "stopped", user: "Stopped user" }] }, ok: true });
    fireEvent.click(screen.getByRole("button", { name: "All environments" }));
    expect(firstSignal.aborted).toBe(true);
    expect(await screen.findByText("Stopped user")).toBeVisible();
    await act(async () => finish({ data: overview, ok: true }));
    expect(screen.queryByText("Fixture user")).not.toBeInTheDocument();
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    const lastSignal = api.read.mock.lastCall![0].signal as AbortSignal;
    view.unmount();
    expect(lastSignal.aborted).toBe(true);
    await act(async () => finish({ data: overview, ok: true }));
    fireEvent.focus(window);
    expect(api.read).toHaveBeenCalledTimes(3);
  });

  it("throttles focus refreshes, avoids overlapping reads, and stops polling while hidden", async () => {
    vi.useFakeTimers();
    let visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
    render(<AdminWorkspaceOverview />);
    await act(async () => undefined);
    fireEvent.focus(window);
    fireEvent.focus(window);
    expect(api.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.read).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    fireEvent.focus(window);
    expect(api.read).toHaveBeenCalledTimes(2);
    let finish!: (value: unknown) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    fireEvent.focus(window);
    expect(api.read).toHaveBeenCalledTimes(3);
    await act(async () => finish({ data: overview, ok: true }));
  });

  it("clears formerly visible metadata when administrator access is lost", async () => {
    render(<AdminWorkspaceOverview />);
    await screen.findByText("Fixture user");
    api.read.mockResolvedValue({ error: "forbidden", ok: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(screen.queryByText("Fixture user")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("can no longer manage Workspace");
  });
});
