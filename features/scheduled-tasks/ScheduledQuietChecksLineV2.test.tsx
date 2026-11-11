import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScheduledQuietChecksLineV2 } from "./ScheduledQuietChecksLineV2";

const now = new Date("2026-11-11T12:00:00.000Z");

describe("ScheduledQuietChecksLineV2", () => {
  it("counts the quiet checks with the latest and the next check, in the viewer's zone, and offers nothing to open", () => {
    render(<ScheduledQuietChecksLineV2 now={now} timeZone="Europe/Moscow" nextRunAt="2026-11-11T12:00:00.000Z"
      summary={{ count: 202, lastAt: "2026-11-11T11:00:00.000Z" }} />);
    const line = screen.getByTestId("scheduled-quiet-checks");
    expect(line).toHaveTextContent("Checked 202 times, no change · last 14:00 · next 15:00");
    expect(line.querySelectorAll("time")[0]).toHaveAttribute("dateTime", "2026-11-11T11:00:00.000Z");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leaves out the next check when none is due, and names the day of a latest check on another day", () => {
    render(<ScheduledQuietChecksLineV2 now={now} timeZone="Europe/Moscow" nextRunAt={null}
      summary={{ count: 1, lastAt: "2026-11-09T21:00:00.000Z" }} />);
    expect(screen.getByTestId("scheduled-quiet-checks")).toHaveTextContent(/^Checked once, no change · last Tue 10 Nov, 00:00$/u);
  });
});
