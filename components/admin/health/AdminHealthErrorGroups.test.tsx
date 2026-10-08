import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AdminHealthErrorGroup } from "@/lib/contracts/adminHealth";
import { AdminHealthErrorGroups } from "./AdminHealthErrorGroups";

function group(overrides: Partial<AdminHealthErrorGroup> = {}): AdminHealthErrorGroup {
  return {
    fingerprint: "0123456789ab", errorClass: "TypeError", site: "lib/server/memory/coordinator/workerProcess.ts:51", count: 12,
    events: ["job_attempt"], roles: ["memory_coordinator"], codes: ["memory_job_failed"],
    lastSeenAt: "2026-10-07T12:00:00.000Z", firstSeenAt: "2026-10-07T11:00:00.000Z", isNew: true,
    usersAtLeast: 40, runsAtLeast: 3,
    ...overrides
  };
}

function fact(card: HTMLElement, term: string): string | null {
  return within(card).getByText(term, { selector: "dt" }).nextElementSibling?.textContent ?? null;
}

describe("AdminHealthErrorGroups", () => {
  it("shows each failure's class, code location, count and where it was recorded, marking new ones", () => {
    render(<AdminHealthErrorGroups groups={[group(), group({ fingerprint: "ba9876543210", errorClass: "Error", site: null, isNew: false, count: 3 })]} truncated={false} />);
    const cards = screen.getAllByTestId("admin-health-error-group-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("TypeError")).toBeVisible();
    expect(within(cards[0]!).getByText("New")).toBeVisible();
    expect(within(cards[0]!).getByText("lib/server/memory/coordinator/workerProcess.ts:51")).toBeVisible();
    expect(within(cards[0]!).getByText("job_attempt · memory_job_failed")).toBeVisible();
    expect(within(cards[1]!).queryByText("New")).toBeNull();
    expect(within(cards[1]!).getByText("Outside application code")).toBeVisible();
    expect(screen.getAllByTestId("admin-health-error-group-row")).toHaveLength(2);
  });

  it("tells a failure that hit many users from one that keeps hitting one, as minimums and never as ids", () => {
    render(<AdminHealthErrorGroups groups={[
      group(),
      group({ fingerprint: "ba9876543210", count: 120, usersAtLeast: 1, runsAtLeast: 0 })
    ]} truncated={false} />);
    const [many, one] = screen.getAllByTestId("admin-health-error-group-card");
    expect([fact(many!, "Users"), fact(many!, "Runs")]).toEqual(["≥ 40", "≥ 3"]);
    expect([fact(one!, "Users"), fact(one!, "Runs")]).toEqual(["≥ 1", "—"]);
    const [manyRow] = screen.getAllByTestId("admin-health-error-group-row");
    expect(within(manyRow!).getAllByRole("cell").map((cell) => cell.textContent).slice(1, 4)).toEqual(["12", "≥ 40", "≥ 3"]);
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Error · location", "Count", "Users", "Runs", "Recorded as", "Process", "Last seen", "First seen"
    ]);
    expect(screen.getByTestId("admin-health-error-groups-reach-note")).toHaveTextContent("counted from sampled incidents, so they are minimums");
  });

  it("says when nothing failed and when rows were left out", () => {
    const { rerender } = render(<AdminHealthErrorGroups groups={[]} truncated={false} />);
    expect(screen.getByTestId("admin-health-error-groups-empty")).toHaveTextContent("No failures with a code location");
    rerender(<AdminHealthErrorGroups groups={[group()]} truncated />);
    expect(screen.getByRole("status")).toHaveTextContent("Too many distinct failures");
  });
});
