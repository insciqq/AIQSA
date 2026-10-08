import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminHealthRange } from "@/lib/contracts/adminHealth";
import type { AdminHealthProblemReport, AdminHealthProblemReports as Page } from "@/lib/contracts/adminHealthProblemReports";
import { AdminHealthProblemReports } from "./AdminHealthProblemReports";
import { AdminHealthSection } from "./AdminHealthSection";
import {
  requestAdminHealthProblemReports,
  type AdminHealthProblemReportsController,
  type AdminHealthProblemReportsResult
} from "./useAdminHealthProblemReports";

const RUN_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function report(overrides: Partial<AdminHealthProblemReport> = {}): AdminHealthProblemReport {
  return {
    comment: "It cited a paper that does not exist.\nSecond line.",
    connectionName: "OpenRouter",
    id: "report-1",
    modelName: "Claude",
    reason: "wrong_or_made_up",
    reportedAt: "2026-10-09T11:00:00.000Z",
    runId: RUN_ID,
    user: { displayName: "Dana", email: "dana@example.com", id: "user-1" },
    ...overrides
  };
}

function page(overrides: Partial<Page> = {}): Page {
  return { from: "2026-10-08T12:00:00.000Z", generatedAt: "2026-10-09T12:00:00.000Z", range: "24h",
    reports: [report(), report({ comment: null, connectionName: null, id: "report-2", modelName: null, reason: "too_slow", runId: null,
      user: { displayName: "Lee", email: null, id: "user-2" } })], total: 2, truncated: false, ...overrides };
}

function controller(overrides: Partial<AdminHealthProblemReportsController> = {}): AdminHealthProblemReportsController {
  return { error: null, loading: false, page: page(), refresh: vi.fn(), ...overrides };
}

describe("AdminHealthProblemReports", () => {
  it("lists each report's reason, time, user, model, run reference and comment", () => {
    render(<AdminHealthProblemReports controller={controller()} range="24h" />);
    const rows = screen.getAllByTestId("admin-health-problem-report");
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText("Wrong or made-up answer")).toBeVisible();
    expect(first.getByText("Dana")).toBeVisible();
    expect(first.getByText(/dana@example\.com/u)).toBeVisible();
    expect(first.getByText("Claude · OpenRouter")).toBeVisible();
    expect(first.getByRole("button", { name: "Look up run 0f8fad5b" })).toHaveTextContent("0f8fad5b");
    expect(first.getByText(/It cited a paper that does not exist\.\s+Second line\./u)).toBeVisible();
    const second = within(rows[1]!);
    expect(second.getByText("Too slow")).toBeVisible();
    expect(second.getByText(/no email/u)).toBeVisible();
    expect(second.queryByRole("button")).toBeNull();
  });

  it("opens the run lookup for a report's run and closes it again", async () => {
    const lookup = vi.fn(async () => ({ ok: true as const, lookup: { runs: [], truncated: false } }));
    render(<AdminHealthProblemReports controller={controller()} range="24h" requestRunLookup={lookup} />);
    const button = screen.getByRole("button", { name: "Look up run 0f8fad5b" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByTestId("admin-health-run-lookup-empty")).toBeVisible();
    expect(lookup).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal));
    fireEvent.click(button);
    expect(screen.queryByTestId("admin-health-run-lookup")).toBeNull();
  });

  it("says when the range has no reports and when the list is truncated", () => {
    const { rerender } = render(<AdminHealthProblemReports controller={controller({ page: page({ reports: [], total: 0 }) })} range="7d" />);
    expect(screen.getByTestId("admin-health-problem-reports-empty")).toHaveTextContent("No problem reports in the last 7 days.");
    rerender(<AdminHealthProblemReports controller={controller({ page: page({ total: 140, truncated: true }) })} range="24h" />);
    expect(screen.getByText("Showing the newest 2 of 140 reports.")).toBeVisible();
  });

  it("offers Try again when nothing loaded and keeps the list after a failed refresh", () => {
    const refresh = vi.fn();
    const { rerender } = render(<AdminHealthProblemReports controller={controller({ error: "unavailable", page: null, refresh })} range="24h" />);
    fireEvent.click(within(screen.getByTestId("admin-health-problem-reports-unavailable")).getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
    rerender(<AdminHealthProblemReports controller={controller({ error: "unavailable" })} range="24h" />);
    expect(screen.getByText(/Refresh failed\. Showing reports from/u)).toBeVisible();
    expect(screen.getAllByTestId("admin-health-problem-report")).toHaveLength(2);
  });

  it("loads the section's range in Health and reloads on a range change", async () => {
    const requestProblemReports = vi.fn(async (range: AdminHealthRange): Promise<AdminHealthProblemReportsResult> =>
      ({ ok: true, page: page({ range }) }));
    const props = {
      onSelectFilter: vi.fn(),
      requestHealth: vi.fn(async () => ({ error: "unavailable" as const, ok: false as const })),
      requestIncidents: vi.fn(async () => ({ ok: true as const, page: { incidents: [], nextCursor: null } })),
      requestProblemReports,
      requestQueues: vi.fn(async () => ({ error: "unavailable" as const, ok: false as const }))
    };
    const { rerender } = render(<AdminHealthSection filter={null} {...props} />);
    const section = (await screen.findByRole("heading", { name: "Problem reports" })).closest("section")!;
    expect(await within(section).findAllByTestId("admin-health-problem-report")).toHaveLength(2);
    expect(requestProblemReports).toHaveBeenCalledWith("24h", expect.any(AbortSignal));
    rerender(<AdminHealthSection filter="30d" {...props} />);
    await waitFor(() => expect(requestProblemReports).toHaveBeenLastCalledWith("30d", expect.any(AbortSignal)));
  });
});

describe("requestAdminHealthProblemReports", () => {
  it("decodes the page and maps refusals", async () => {
    const ok = vi.fn(async () => Response.json({ problemReports: page() }));
    expect(await requestAdminHealthProblemReports("24h", undefined, ok)).toEqual({ ok: true, page: page() });
    expect(ok).toHaveBeenCalledWith("/api/admin/health/problem-reports?range=24h", expect.objectContaining({ method: "GET" }));
    const forbidden = vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    expect(await requestAdminHealthProblemReports("24h", undefined, forbidden)).toEqual({ error: "forbidden", ok: false });
    const malformed = vi.fn(async () => Response.json({ problemReports: { reports: "none" } }));
    expect(await requestAdminHealthProblemReports("24h", undefined, malformed)).toEqual({ error: "unavailable", ok: false });
  });
});
