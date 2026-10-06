import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageSpendChart } from "./UsageSpendChart";
import { seriesPoint } from "./usageTestFixtures";

const series = [
  seriesPoint("2026-10-05T00:00:00.000Z", { chat: [1_000_000, 4_000], scheduled: [500_000, 1_000] }, 3),
  seriesPoint("2026-10-06T00:00:00.000Z", { background: [0, 500], chat: [2_000_000, 5_000], images: [250_000, 0] }, 2)
];

function chart(metric: "cost" | "tokens" = "cost") {
  return render(<UsageSpendChart bucket="day" metric={metric} series={series} timeZone="UTC" />);
}

describe("UsageSpendChart", () => {
  it("lists all five sources in the fixed slot order and paints marks only through chart tokens", () => {
    const { container } = chart();
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Chats", "Scheduled tasks", "Images", "Memory", "Knowledge & other"
    ]);
    const first = container.querySelector('[data-bucket="2026-10-05T00:00:00.000Z"]');
    const segments = [...(first?.querySelectorAll("path") ?? [])];
    expect(segments.map((path) => path.getAttribute("data-category"))).toEqual(["chat", "scheduled"]);
    expect(segments.map((path) => path.style.fill)).toEqual(["var(--v2-chart-1)", "var(--v2-chart-2)"]);
    // Text never wears a series colour.
    for (const text of container.querySelectorAll("text")) {
      expect(text.getAttribute("fill")).toBe("var(--v2-color-text3)");
    }
  });

  it("stacks segments with a surface gap and rounds only the top of each column", () => {
    const { container } = chart();
    const second = container.querySelector('[data-bucket="2026-10-06T00:00:00.000Z"]');
    const paths = [...(second?.querySelectorAll("path") ?? [])].map((path) => path.getAttribute("d") ?? "");
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toContain("Q");
    expect(paths[1]).toContain("Q");
    const bottomOf = (d: string) => Number(/^M[\d.]+,([\d.]+)/u.exec(d)?.[1]);
    const topOf = (d: string) => Number(/V([\d.]+)/u.exec(d)?.[1]);
    expect(bottomOf(paths[1]!)).toBeCloseTo(topOf(paths[0]!) - 2, 5);
  });

  it("reads each bucket by keyboard with every source and the total", () => {
    chart();
    const plot = screen.getByRole("group", { name: /Spend over time by source/u });
    fireEvent.focus(plot);
    let tooltip = screen.getByTestId("usage-chart-tooltip");
    expect(tooltip).toHaveTextContent("Oct 6");
    expect(within(tooltip).getByText("Chats").nextSibling).toHaveTextContent("$2.00");
    expect(within(tooltip).getByText("Images").nextSibling).toHaveTextContent("$0.25");
    expect(within(tooltip).getByText("Knowledge & other").nextSibling).toHaveTextContent("$0.00");
    expect(tooltip).toHaveTextContent("Total · 2 runs$2.25");

    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    tooltip = screen.getByTestId("usage-chart-tooltip");
    expect(tooltip).toHaveTextContent("Oct 5");
    expect(tooltip).toHaveTextContent("Total · 3 runs$1.50");

    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByTestId("usage-chart-tooltip")).not.toBeInTheDocument();
  });

  it("keeps every value in a table for assistive technology, per metric", () => {
    chart("tokens");
    const table = screen.getByRole("table", { name: "Tokens per day by source" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[2]!).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "5,000", "0", "0", "0", "500", "5,500"
    ]);
  });
});
