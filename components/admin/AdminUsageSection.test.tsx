import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminUsageAnalytics, AdminUsagePeriod } from "@/lib/contracts/adminUsageAnalytics";
import { AdminUsageSection } from "./AdminUsageSection";
import { emptyUsageAnalytics, populatedUsageAnalytics, usageResponse } from "./usage/usageTestFixtures";

function Harness({ initial = null }: Readonly<{ initial?: string | null }>) {
  const [period, setPeriod] = useState<string | null>(initial);
  return <AdminUsageSection onPeriodChange={setPeriod} period={period} />;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function requestedUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost");
}

function mockUsage(usage: AdminUsageAnalytics) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(usageResponse(usage)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminUsageSection", () => {
  it("shows a pending state without zeros, then KPI tiles with changes against the previous window", async () => {
    const response = deferred<Response>();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    render(<Harness />);

    expect(screen.getByTestId("admin-usage-loading")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    const url = requestedUrl(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe("/api/admin/usage");
    expect(url.searchParams.get("period")).toBe("30d");
    expect(url.searchParams.get("tz")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);

    await act(async () => response.resolve(json(usageResponse(populatedUsageAnalytics()))));
    await screen.findByTestId("usage-kpi-cost");
    const summary = screen.getByLabelText("Usage summary");
    expect(within(summary).getByTestId("usage-kpi-cost")).toHaveTextContent("≈ $4.00");
    expect(within(summary).getByTestId("usage-kpi-cost")).toHaveTextContent("cost known for 6 of 7 requests");
    expect(screen.getByTestId("usage-kpi-cost-delta")).toHaveTextContent("↑ 100% vs previous 30 days");
    const system = within(summary).getByTestId("usage-kpi-system");
    expect(system).toHaveTextContent("System cost≈ $1.00");
    expect(system).toHaveTextContent("25% of the estimated cost");
    expect(system).toHaveTextContent("cost known for 2 of 3 requests");
    expect(screen.getByTestId("usage-kpi-system-delta")).toHaveTextContent("↑ 100% vs previous 30 days");
    expect(screen.getByTestId("usage-kpi-tokens")).toHaveTextContent("10,500");
    expect(screen.getByTestId("usage-kpi-tokens-delta")).toHaveTextContent("—");
    expect(screen.getByTestId("usage-kpi-runs-delta")).toHaveTextContent("↓ 20% vs previous 30 days");
    expect(screen.getByTestId("usage-kpi-users")).toHaveTextContent("2 of 4 users");
    expect(screen.getByTestId("usage-kpi-users-delta")).toHaveTextContent("No change vs previous 30 days");
  });

  it("renders breakdowns by model, source, user and group for the period", async () => {
    mockUsage(populatedUsageAnalytics());
    render(<Harness />);

    // Shares of the models people chose are of their own three dollars.
    const models = await screen.findByTestId("admin-usage-by-model");
    expect(within(models).getByText("OpenAI / GPT 5.5")).toBeInTheDocument();
    expect(within(models).getByText("6,000 tokens · 2 users")).toBeInTheDocument();
    expect(within(models).getByText("83%")).toBeInTheDocument();
    expect(within(models).queryByText("OpenAI / GPT 5 mini")).not.toBeInTheDocument();

    const sources = screen.getByTestId("admin-usage-by-source");
    expect(within(sources).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual([
      "Chats", "Scheduled tasks", "Images", "System"
    ]);
    expect(within(sources).getByText("Titles, summaries, Memory, Knowledge and checks by system models · 2,500 tokens")).toBeInTheDocument();
    expect(within(sources).getByText("25%")).toBeInTheDocument();

    const users = screen.getByRole("region", { name: "User usage table" });
    const rows = within(users).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Ada Admin");
    expect(rows[1]).toHaveTextContent("OpenAI / GPT 5.5");
    expect(rows[1]).toHaveTextContent("1,000 tokens · 33% of cost");
    expect(rows[2]).toHaveTextContent("No email");
    expect(rows[2]).toHaveTextContent("Cost unknown1,500 tokens");
    expect(within(screen.getByTestId("admin-usage-users-mobile")).getByText("Bo Builder")).toBeInTheDocument();

    const groups = screen.getByRole("region", { name: "Group usage table" });
    expect(within(groups).getByText("Operators")).toBeInTheDocument();
    expect(within(groups).getAllByRole("row")[1]).toHaveTextContent("2,500 tokens · 25% of cost");
    expect(screen.getByTestId("admin-usage-groups")).toHaveTextContent("group totals can overlap");
    expect(screen.getByText(/follow the\s+UTC time zone/u)).toBeInTheDocument();
  });

  it("breaks system spend down by function and model and keeps unknown cost unknown", async () => {
    mockUsage(populatedUsageAnalytics());
    render(<Harness />);

    const functions = await screen.findByTestId("admin-usage-system-functions");
    const rows = within(functions).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["Memory processing", "Chat titles", "Knowledge indexing"]);
    expect(rows[0]).toHaveTextContent("≈ $0.800");
    expect(rows[0]).toHaveTextContent("500 tokens · 1 request");
    expect(rows[0]).toHaveTextContent("80%");
    expect(rows[2]).toHaveTextContent("Cost unknown");
    expect(rows[2]).toHaveTextContent("1,500 tokens · 1 request · 1 with unknown cost");
    expect(rows[2]).toHaveTextContent("share unknown");
    expect(rows[2]).not.toHaveTextContent("$");

    const models = screen.getByRole("region", { name: "System model usage table" });
    const modelRows = within(models).getAllByRole("row");
    expect(modelRows[1]).toHaveTextContent("OpenAI / GPT 5 mini");
    expect(modelRows[1]).toHaveTextContent("Chat titles, Memory processing");
    expect(modelRows[1]).toHaveTextContent("100%");
    expect(modelRows[2]).toHaveTextContent("OpenAI / Embedding 3 small");
    expect(modelRows[2]).toHaveTextContent("Knowledge indexing");
    expect(modelRows[2]).toHaveTextContent("Cost unknown");
    expect(within(screen.getByTestId("admin-usage-system-models-mobile")).getByText("OpenAI / Embedding 3 small")).toBeInTheDocument();
  });

  it("says when the period has no usage instead of drawing an empty chart", async () => {
    mockUsage(emptyUsageAnalytics());
    render(<Harness />);

    const spend = await screen.findByTestId("admin-usage-spend");
    expect(within(spend).getByRole("status")).toHaveTextContent("No usage in this period");
    expect(screen.queryByTestId("usage-spend-chart")).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-kpi-cost")).toHaveTextContent("—");
    expect(screen.getByTestId("usage-kpi-system")).toHaveTextContent("no system usage in this period");
    expect(within(screen.getByTestId("admin-usage-system")).getByText("No system usage in this period.")).toBeInTheDocument();
    expect(screen.getByText("No user had usage in this period.", { selector: "p" })).toBeInTheDocument();
  });

  it("switches the chart between cost and tokens", async () => {
    mockUsage(populatedUsageAnalytics());
    render(<Harness />);

    await screen.findByTestId("usage-spend-chart");
    expect(screen.getByRole("table", { name: "Estimated cost per day by source" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("table", { name: "Tokens per day by source" })).toBeInTheDocument();
  });

  it("aborts the stale request on a period change and keeps the previous data marked as updating", async () => {
    const next = deferred<Response>();
    const signals: AbortSignal[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      signals.push(init!.signal!);
      return requestedUrl(input).searchParams.get("period") === "7d"
        ? next.promise
        : json(usageResponse(populatedUsageAnalytics()));
    });
    render(<Harness />);
    await screen.findByTestId("usage-kpi-cost");

    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "7d" } });
    expect(requestedUrl(fetch.mock.calls.at(-1)![0]).searchParams.get("period")).toBe("7d");
    expect(signals[0]!.aborted).toBe(true);
    expect(screen.getByTestId("admin-usage-content")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(screen.getByTestId("usage-kpi-cost")).toHaveTextContent("≈ $4.00");

    const weekly: AdminUsageAnalytics = {
      ...populatedUsageAnalytics(),
      totals: { ...populatedUsageAnalytics().totals, estimatedCostMicros: 1_500_000 },
      window: { ...populatedUsageAnalytics().window, period: "7d" }
    };
    await act(async () => next.resolve(json(usageResponse(weekly))));
    await waitFor(() => expect(screen.getByTestId("admin-usage-content")).not.toHaveAttribute("aria-busy"));
    expect(screen.getByTestId("usage-kpi-cost")).toHaveTextContent("≈ $1.50");
    expect(screen.getByTestId("usage-kpi-cost-delta")).toHaveTextContent("vs previous 7 days");
  });

  it("links the CSV export to the selected period and the browser time zone", async () => {
    mockUsage(populatedUsageAnalytics());
    render(<Harness initial="90d" />);

    const link = screen.getByRole("link", { name: "Download CSV" });
    const url = new URL(link.getAttribute("href")!, "http://localhost");
    expect(url.pathname).toBe("/api/admin/usage/export");
    expect(url.searchParams.get("period")).toBe("90d");
    expect(url.searchParams.get("tz")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(screen.getByLabelText("Period")).toHaveValue("90d");
    await screen.findByTestId("usage-kpi-cost");
  });

  it("falls back to the default period for an unknown filter value", async () => {
    const fetch = mockUsage(populatedUsageAnalytics());
    render(<Harness initial="forever" />);
    expect(screen.getByLabelText("Period")).toHaveValue("30d" satisfies AdminUsagePeriod);
    expect(requestedUrl(fetch.mock.calls[0]![0]).searchParams.get("period")).toBe("30d");
    await screen.findByTestId("usage-kpi-cost");
  });

  it("shows a load failure with Retry instead of an empty result", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "usage_analytics_failed" }, 500))
      .mockResolvedValueOnce(json({ usage: { malformed: true } }))
      .mockResolvedValueOnce(json(usageResponse(populatedUsageAnalytics())));
    render(<Harness />);

    let alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Usage could not be loaded");
    expect(screen.queryByText("No usage in this period")).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    alert = await screen.findByRole("alert");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("usage-kpi-cost")).toHaveTextContent("≈ $4.00");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
