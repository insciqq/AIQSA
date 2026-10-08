import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AdminHealthRunSummary } from "@/lib/contracts/adminHealthRunLookup";
import { AdminHealthIncidents, emptyIncidentFilters, type AdminHealthIncidentFilterState } from "./AdminHealthIncidents";
import { AdminHealthRunLookup } from "./AdminHealthRunLookup";
import { requestAdminHealthRunLookup, type AdminHealthRunLookupRequest, type AdminHealthRunLookupResult } from "./adminHealthRunLookupApi";
import type { AdminHealthIncidentsController } from "./useAdminHealth";

const RUN = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b";

function run(overrides: Partial<AdminHealthRunSummary> = {}): AdminHealthRunSummary {
  return {
    runId: RUN, status: "error", startedAt: "2026-10-07T14:03:00.000Z", updatedAt: "2026-10-07T14:03:04.250Z", durationMs: 4_250,
    failureCode: "provider_auth_rejected", connectionName: "OpenAI production", modelName: "GPT answer", incidentCount: 2, ...overrides
  };
}

const controller: AdminHealthIncidentsController = {
  items: [], loading: false, loadingMore: false, error: null, moreError: null, hasMore: false, loadMore: vi.fn(), refresh: vi.fn()
};

function Incidents({ request, onChange }: Readonly<{ request: AdminHealthRunLookupRequest; onChange?: (next: AdminHealthIncidentFilterState) => void }>) {
  const [filters, setFilters] = useState(emptyIncidentFilters);
  return (
    <AdminHealthIncidents
      controller={controller}
      filters={filters}
      onChangeFilters={(next) => { onChange?.(next); setFilters(next); }}
      requestRunLookup={request}
    />
  );
}

function search(value: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Run or trace id" }), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("AdminHealthRunLookup", () => {
  it("looks a pasted error reference up and shows the run summary beside its incident filter", async () => {
    const request = vi.fn<AdminHealthRunLookupRequest>(async () => ({ ok: true, lookup: { runs: [run()], truncated: false } }));
    const onChange = vi.fn();
    render(<Incidents onChange={onChange} request={request} />);
    expect(screen.queryByTestId("admin-health-run-lookup")).toBeNull();

    search("Reference: 3F2A9C1E");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ q: "3f2a9c1e" }));
    expect(screen.getByRole("searchbox", { name: "Run or trace id" })).toHaveValue("3f2a9c1e");
    const lookup = await screen.findByTestId("admin-health-run");
    expect(request).toHaveBeenCalledWith("3f2a9c1e", expect.any(AbortSignal));
    expect(within(lookup).getByText(RUN)).toBeVisible();
    expect(within(lookup).getByText("Failed")).toBeVisible();
    expect(within(lookup).getByText("provider_auth_rejected")).toBeVisible();
    expect(within(lookup).getByText("OpenAI production")).toBeVisible();
    expect(within(lookup).getByText("GPT answer")).toBeVisible();
    expect(within(lookup).getByText("4.3 s")).toBeVisible();
    expect(within(lookup).getByText("Linked incidents").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByRole("heading", { name: "Run 3f2a9c1e" })).toBeVisible();
  });

  it("does not look up trace ids or short values and explains the accepted forms", async () => {
    const request = vi.fn<AdminHealthRunLookupRequest>();
    render(<Incidents request={request} />);
    search("a".repeat(32));
    search("3f2a9c1");
    expect(screen.queryByTestId("admin-health-run-lookup")).toBeNull();
    search("not a reference");
    expect(screen.getByRole("alert")).toHaveTextContent(/error reference \(at least 8 characters\)/u);
    expect(request).not.toHaveBeenCalled();
  });

  it("shows an empty match, more matches, an active run and a retryable failure", async () => {
    let result: AdminHealthRunLookupResult = { ok: true, lookup: { runs: [], truncated: false } };
    const request = vi.fn<AdminHealthRunLookupRequest>(async () => result);
    const view = render(<AdminHealthRunLookup reference="3f2a9c1e" request={request} />);
    expect(screen.getByRole("status")).toHaveTextContent("Looking up the run…");
    expect(await screen.findByTestId("admin-health-run-lookup-empty")).toHaveTextContent(/No run matches this reference/u);

    result = { ok: true, lookup: { runs: [run({ status: "streaming", durationMs: null, failureCode: null })], truncated: true } };
    view.rerender(<AdminHealthRunLookup reference="3f2a9c1e-7b" request={request} />);
    expect(await screen.findByText("Still running")).toBeVisible();
    expect(screen.getByText("Answering")).toBeVisible();
    expect(screen.getByText(/More runs share this reference/u)).toBeVisible();

    result = { ok: false, error: "unavailable" };
    view.rerender(<AdminHealthRunLookup reference="3f2a9c1e-7b4" request={request} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The run could not be looked up.");
    result = { ok: true, lookup: { runs: [run()], truncated: false } };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("admin-health-run")).toBeVisible());
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("decodes the lookup response strictly and maps refusals", async () => {
    const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const ok = respond(200, { runs: [run()], truncated: false });
    await expect(requestAdminHealthRunLookup("3f2a9c1e", undefined, ok)).resolves.toEqual({ ok: true, lookup: { runs: [run()], truncated: false } });
    expect(ok).toHaveBeenCalledWith("/api/admin/health/runs?q=3f2a9c1e", expect.objectContaining({ method: "GET" }));
    await expect(requestAdminHealthRunLookup("3f2a9c1e", undefined, respond(200, { runs: [{ ...run(), prompt: 1, runId: "x" }], truncated: false })))
      .resolves.toEqual({ ok: false, error: "unavailable" });
    await expect(requestAdminHealthRunLookup("3f2a9c1e", undefined, respond(403, { error: "forbidden" })))
      .resolves.toEqual({ ok: false, error: "forbidden" });
    await expect(requestAdminHealthRunLookup("3f2a9c1e", undefined, respond(400, { error: "admin_health_query_invalid" })))
      .resolves.toEqual({ ok: false, error: "invalid" });
  });
});
