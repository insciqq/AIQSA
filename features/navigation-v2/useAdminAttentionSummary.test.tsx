import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAttentionSummary } from "@/lib/contracts/adminAttention";
import {
  adminAttentionIndicator,
  createAdminAttentionSummaryStore,
  useAdminAttentionSummary,
  type AdminAttentionSummaryStore
} from "./useAdminAttentionSummary";

const summary = (bad: number, warn: number): AdminAttentionSummary =>
  ({ bad, checkedAt: "2026-10-07T12:00:00.000Z", health: bad + warn, unavailable: [], warn });

let visibility: DocumentVisibilityState = "visible";

function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

function Probe({ enabled, store }: Readonly<{ enabled: boolean; store: AdminAttentionSummaryStore }>) {
  const value = useAdminAttentionSummary(enabled, store);
  return <output data-testid="summary">{value ? `${value.bad}/${value.warn}` : "none"}</output>;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("admin attention summary store", () => {
  it("never requests for a viewer without the administrator entry", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, summary: summary(1, 0) });
    const store = createAdminAttentionSummaryStore({ request });
    render(<Probe enabled={false} store={store} />);
    await flush();
    act(() => { vi.advanceTimersByTime(30 * 60_000); });
    setVisibility("visible");
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByTestId("summary")).toHaveTextContent("none");
  });

  it("shares one request between entries and polls every five minutes only while the tab is visible", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, summary: summary(1, 2) });
    const store = createAdminAttentionSummaryStore({ request });
    render(<><Probe enabled store={store} /><Probe enabled store={store} /></>);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("summary").map((node) => node.textContent)).toEqual(["1/2", "1/2"]);

    request.mockResolvedValue({ ok: true, summary: summary(0, 0) });
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("summary")[0]).toHaveTextContent("0/0");

    act(() => setVisibility("hidden"));
    act(() => { vi.advanceTimersByTime(15 * 60_000); });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    // Returning to a tab whose counts are older than the interval refreshes at once.
    act(() => setVisibility("visible"));
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps the last counts after a failed read and stops for good once the server denies access", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, summary: summary(0, 1) });
    const store = createAdminAttentionSummaryStore({ request });
    render(<Probe enabled store={store} />);
    await flush();
    request.mockResolvedValueOnce({ error: "network_error", ok: false });
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    await flush();
    expect(screen.getByTestId("summary")).toHaveTextContent("0/1");

    request.mockResolvedValueOnce({ error: "forbidden", ok: false });
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    await flush();
    expect(screen.getByTestId("summary")).toHaveTextContent("none");
    act(() => { vi.advanceTimersByTime(20 * 60_000); });
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the last entry unmounts", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, summary: summary(0, 0) });
    const store = createAdminAttentionSummaryStore({ request });
    const view = render(<Probe enabled store={store} />);
    await flush();
    view.unmount();
    act(() => { vi.advanceTimersByTime(30 * 60_000); });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("adminAttentionIndicator", () => {
  it("shows the worst severity and the bad plus warning count, and nothing when all is well", () => {
    expect(adminAttentionIndicator(null)).toBeNull();
    expect(adminAttentionIndicator(summary(0, 0))).toBeNull();
    expect(adminAttentionIndicator(summary(0, 1))).toEqual({ count: 1, label: "1 item needs attention", severity: "warn" });
    expect(adminAttentionIndicator(summary(2, 1))).toEqual({ count: 3, label: "3 items need attention", severity: "bad" });
  });
});
