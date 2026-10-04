import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScheduledChecksRowV2 } from "./ScheduledChecksRowV2";

describe("ScheduledChecksRowV2", () => {
  it("names the folded checks and toggles them from one keyboard-reachable button", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ScheduledChecksRowV2 checks={3} expanded={false} onToggle={onToggle} />);
    expect(screen.getByTestId("scheduled-checks-row")).toHaveTextContent("3 checks with no update·Show");
    const show = screen.getByRole("button", { name: "Show 3 checks with no update" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<ScheduledChecksRowV2 checks={3} expanded onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Hide 3 checks with no update" })).toHaveAttribute("aria-expanded", "true");
  });
});
