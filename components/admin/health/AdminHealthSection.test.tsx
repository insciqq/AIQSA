import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminHealth, AdminHealthIncident, AdminHealthIncidentFilters, AdminHealthRange } from "@/lib/contracts/adminHealth";
import type { AdminHealthIncidentsResult, AdminHealthResult } from "./adminHealthApi";
import { AdminHealthSection } from "./AdminHealthSection";

const zero = { providers: 0, requests: 0, runs: 0, background: 0, tools: 0, other: 0 };

function health(overrides: Partial<AdminHealth> = {}): AdminHealth {
  return {
    range: "24h", interval: "hour", from: "2026-10-06T13:00:00.000Z", to: "2026-10-07T13:00:00.000Z",
    generatedAt: "2026-10-07T12:30:00.000Z", hasTelemetry: true, providersTruncated: false, errorGroups: [], errorGroupsTruncated: false,
    summary: { errors: 9, previousErrors: 4, providerOperations: 200, providerFailures: 6, providerFailureRate: 0.03,
      http5xx: 2, restarts: 1, roleStarts: [{ role: "memory_search", starts: 2, restarts: 1 }], droppedLogRecords: 0, clientErrors: 1 },
    series: [
      { start: "2026-10-07T11:00:00.000Z", counts: { ...zero, providers: 6, background: 1 }, total: 7 },
      { start: "2026-10-07T12:00:00.000Z", counts: { ...zero, requests: 2 }, total: 2 }
    ],
    providers: [{
      key: "a", connectionId: "c1", connectionName: "OpenAI production", connectionState: "known", providerModelId: "m1",
      modelName: "GPT vision", stage: "vision", operations: 40, failures: 6, failureRate: 0.15,
      failuresByClass: { key_rejected: 4, quota: 0, provider_error: 0, timeout: 2, network: 0, other: 0 },
      p95Ms: 30_000, lastFailureAt: "2026-10-07T11:40:00.000Z"
    }, {
      key: "b", connectionId: "gone", connectionName: "Deleted connection", connectionState: "deleted", providerModelId: "m2",
      modelName: "Deleted model", stage: "embedding", operations: 160, failures: 0, failureRate: 0,
      failuresByClass: { key_rejected: 0, quota: 0, provider_error: 0, timeout: 0, network: 0, other: 0 },
      p95Ms: 250, lastFailureAt: null
    }],
    ...overrides
  };
}

function incident(id: string, overrides: Partial<AdminHealthIncident> = {}): AdminHealthIncident {
  return {
    id, occurredAt: "2026-10-07T12:10:00.000Z", role: "app", event: "provider_operation", level: "error",
    code: "provider_auth_rejected", subsystem: null, stage: "answer", connectionId: "c1", connectionName: "OpenAI production",
    modelName: "GPT", httpStatus: 401, runId: "run-1", traceId: "a".repeat(32), details: [{ key: "duration_ms", value: 812 }],
    ...overrides
  };
}

function setup(options: Partial<{
  requestHealth: (range: AdminHealthRange, signal?: AbortSignal) => Promise<AdminHealthResult>;
  requestIncidents: (filters: AdminHealthIncidentFilters, signal?: AbortSignal) => Promise<AdminHealthIncidentsResult>;
  filter: string | null;
}> = {}) {
  const requestHealth = vi.fn(options.requestHealth ?? (async (range: AdminHealthRange) => ({ ok: true as const, health: health({ range }) })));
  const requestIncidents = vi.fn(options.requestIncidents ?? (async () => ({ ok: true as const, page: { incidents: [incident("i1")], nextCursor: null } })));
  const onSelectFilter = vi.fn();
  const view = render(
    <AdminHealthSection filter={options.filter ?? null} onSelectFilter={onSelectFilter} requestHealth={requestHealth} requestIncidents={requestIncidents} />
  );
  return { ...view, onSelectFilter, requestHealth, requestIncidents };
}

describe("AdminHealthSection", () => {
  it("shows the summary, the error chart, provider reliability and incidents for 24 hours", async () => {
    const { requestHealth } = setup();
    expect(screen.getByTestId("admin-health-loading")).toBeVisible();
    expect(await screen.findByTestId("admin-health-summary")).toBeVisible();
    expect(requestHealth).toHaveBeenCalledWith("24h", expect.any(AbortSignal));

    expect(within(screen.getByTestId("admin-health-tile-errors")).getByText("9")).toBeVisible();
    expect(within(screen.getByTestId("admin-health-tile-errors")).getByText(/\+5 vs the period before/u)).toBeVisible();
    expect(within(screen.getByTestId("admin-health-tile-providers")).getByText("3.0%")).toBeVisible();
    expect(within(screen.getByTestId("admin-health-tile-restarts")).getByText("memory search ×1")).toBeVisible();
    expect(within(screen.getByTestId("admin-health-legend-providers")).getByText("6")).toBeVisible();
    expect(screen.getAllByTestId("admin-health-bar")).toHaveLength(2);
    expect(screen.getByRole("table", { name: /errors by hour and area/iu })).toBeInTheDocument();

    const rows = screen.getAllByTestId("admin-health-provider-row");
    expect(within(rows[0]!).getByText("OpenAI production")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("GPT vision · Image analysis")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("4 key rejected · 2 timeouts")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Deleted connection")).toBeInTheDocument();

    expect(await screen.findAllByTestId("admin-health-incident")).toHaveLength(1);
  });

  it("reads each chart column from the keyboard", async () => {
    setup();
    const chart = await screen.findByRole("group", { name: /errors chart/iu });
    fireEvent.keyDown(chart, { key: "End" });
    const readout = screen.getByTestId("admin-health-chart-readout");
    expect(readout).toHaveTextContent(/2 errors\s*2\s*Requests$/u);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(within(screen.getByTestId("admin-health-chart-readout")).getByText("Providers")).toBeVisible();
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByTestId("admin-health-chart-readout")).toBeNull();
  });

  it("switches range through the URL filter and loads the new range", async () => {
    const view = setup();
    await screen.findByTestId("admin-health-summary");
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    expect(view.onSelectFilter).toHaveBeenCalledWith("7d");
    view.rerender(<AdminHealthSection filter="7d" onSelectFilter={view.onSelectFilter} requestHealth={view.requestHealth} requestIncidents={view.requestIncidents} />);
    await waitFor(() => expect(view.requestHealth).toHaveBeenLastCalledWith("7d", expect.any(AbortSignal)));
    expect(view.requestIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ range: "7d", cursor: null }), expect.any(AbortSignal));
    expect(within(screen.getByRole("radiogroup", { name: "Time range" })).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["24 hours", "7 days", "14 days", "30 days"]);
    fireEvent.click(screen.getByRole("radio", { name: "14 days" }));
    expect(view.onSelectFilter).toHaveBeenLastCalledWith("14d");
    view.rerender(<AdminHealthSection filter="14d" onSelectFilter={view.onSelectFilter} requestHealth={view.requestHealth} requestIncidents={view.requestIncidents} />);
    await waitFor(() => expect(view.requestHealth).toHaveBeenLastCalledWith("14d", expect.any(AbortSignal)));
    expect(view.requestIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ range: "14d", cursor: null }), expect.any(AbortSignal));
    expect(screen.getByRole("radio", { name: "14 days" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "24 hours" }));
    expect(view.onSelectFilter).toHaveBeenLastCalledWith(null);
  });

  it("explains a fresh installation instead of showing zeros", async () => {
    setup({ requestHealth: async () => ({ ok: true, health: health({ hasTelemetry: false, providers: [], series: [] }) }) });
    expect(await screen.findByText("No telemetry yet")).toBeVisible();
    expect(screen.queryByTestId("admin-health-summary")).toBeNull();
  });

  it("shows an unavailable state with a working retry when the read fails", async () => {
    let fail = true;
    setup({ requestHealth: async (range) => fail ? { ok: false, error: "unavailable" } : { ok: true, health: health({ range }) } });
    expect(await screen.findByTestId("admin-health-unavailable")).toHaveTextContent(/could not be loaded/iu);
    fail = false;
    fireEvent.click(within(screen.getByTestId("admin-health-unavailable")).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("admin-health-summary")).toBeVisible();
  });

  it("expands incident details, pages with Load more and validates the reference search", async () => {
    const requestIncidents = vi.fn(async (filters: AdminHealthIncidentFilters) => filters.cursor
      ? { ok: true as const, page: { incidents: [incident("i2", { code: "provider_server_error", httpStatus: 503 })], nextCursor: null } }
      : { ok: true as const, page: { incidents: [incident("i1")], nextCursor: "page2" } });
    setup({ requestIncidents });
    const [first] = await screen.findAllByTestId("admin-health-incident");
    const toggle = within(first!).getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(first!).getByText("run-1")).toBeVisible();
    expect(within(first!).getByText("duration_ms")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByTestId("admin-health-incident")).toHaveLength(2));
    expect(requestIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page2" }), expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Run or trace id" }), { target: { value: "not an id" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/exact run id/iu);
    const calls = requestIncidents.mock.calls.length;
    expect(requestIncidents).toHaveBeenCalledTimes(calls);

    fireEvent.change(screen.getByRole("searchbox", { name: "Run or trace id" }), { target: { value: "run-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(requestIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ q: "run-1", cursor: null }), expect.any(AbortSignal)));

    fireEvent.change(screen.getByRole("combobox", { name: "Area" }), { target: { value: "providers" } });
    await waitFor(() => expect(requestIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ category: "providers", q: "run-1" }), expect.any(AbortSignal)));
  });

  it("keeps incidents failure separate from the health view", async () => {
    setup({ requestIncidents: async () => ({ ok: false, error: "unavailable" }) });
    expect(await screen.findByTestId("admin-health-summary")).toBeVisible();
    expect(await screen.findByText("Incidents could not be loaded.")).toBeVisible();
  });

  it("ignores a late response from a previous range", async () => {
    let resolveSlow: (value: AdminHealthResult) => void = () => undefined;
    const requestHealth = vi.fn((range: AdminHealthRange) => range === "24h"
      ? new Promise<AdminHealthResult>((resolve) => { resolveSlow = resolve; })
      : Promise.resolve({ ok: true as const, health: health({ range: "7d", summary: { ...health().summary, errors: 77 } }) }));
    const view = setup({ requestHealth });
    view.rerender(<AdminHealthSection filter="7d" onSelectFilter={view.onSelectFilter} requestHealth={requestHealth} requestIncidents={view.requestIncidents} />);
    expect(await screen.findByText("77")).toBeVisible();
    await act(async () => resolveSlow({ ok: true, health: health() }));
    expect(screen.getByText("77")).toBeVisible();
  });
});
