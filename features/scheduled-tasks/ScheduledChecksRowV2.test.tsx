import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScheduledChecksRowV2 } from "./ScheduledChecksRowV2";

const now = new Date("2026-10-04T10:00:00.000Z");

describe("ScheduledChecksRowV2", () => {
  it("names the folded checks and toggles them from one keyboard-reachable button", () => {
    const onToggle = vi.fn();
    const summary = { checks: 3, failed: 0, lastAt: null, noun: "check" as const };
    const { rerender } = render(<ScheduledChecksRowV2 expanded={false} summary={summary} onToggle={onToggle} />);
    expect(screen.getByTestId("scheduled-checks-row")).toHaveTextContent("3 checks with no update·Show");
    const show = screen.getByRole("button", { name: "Show 3 checks with no update" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<ScheduledChecksRowV2 expanded summary={summary} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Hide 3 checks with no update" })).toHaveAttribute("aria-expanded", "true");
  });

  it("counts failures and says when the latest check ran, with the day when it was not today", () => {
    const { rerender } = render(<ScheduledChecksRowV2 expanded={false} now={now} timeZone="Europe/London" onToggle={vi.fn()}
      summary={{ checks: 25, failed: 2, lastAt: "2026-10-04T08:03:00.000Z", noun: "check" }} />);
    expect(screen.getByTestId("scheduled-checks-row")).toHaveTextContent("23 checks with no update · 2 failed · last 09:03·Show");
    expect(screen.getByRole("button", { name: "Show 23 checks with no update, 2 failed" })).toBeInTheDocument();
    rerender(<ScheduledChecksRowV2 expanded={false} now={now} timeZone="Europe/London" onToggle={vi.fn()}
      summary={{ checks: 1, failed: 1, lastAt: "2026-10-03T14:03:00.000Z", noun: "check" }} />);
    expect(screen.getByTestId("scheduled-checks-row")).toHaveTextContent("1 failed check · last Sat 3 Oct, 15:03·Show");
  });
});
