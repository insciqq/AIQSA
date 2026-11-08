import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScheduledTurnV2 } from "./ScheduledTurnV2";

const now = new Date("2026-10-04T10:00:00.000Z");
const prompt = "Tell me when PR 12 is merged.\nInclude the merge date.";

describe("ScheduledTurnV2", () => {
  it("is one line with the task and run time, the instructions behind a disclosure and no edit actions", () => {
    const onCopy = vi.fn();
    const onOpen = vi.fn();
    render(<ScheduledTurnV2 anchorId="turn-1" content={prompt} createdAt="2026-10-04T08:03:00.000Z" now={now}
      timeZone="Europe/London" title="PR watch" onCopy={onCopy} onOpen={onOpen} />);
    const turn = screen.getByTestId("scheduled-turn");
    expect(turn).toHaveAttribute("data-conversation-message-id", "turn-1");
    expect(turn).toHaveTextContent("Automation · PR watch·09:03·Show instructions");
    expect(screen.queryByText(/Tell me when PR 12/u)).toBeNull();
    expect(screen.queryByRole("button", { name: /edit|branch|delete/iu })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Automation · PR watch" }));
    expect(onOpen).toHaveBeenCalledOnce();

    const show = screen.getByRole("button", { name: "Show instructions" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    const hide = screen.getByRole("button", { name: "Hide instructions" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    const instructions = document.getElementById(hide.getAttribute("aria-controls") ?? "");
    expect(instructions).toHaveTextContent("Tell me when PR 12 is merged. Include the merge date.");
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    expect(onCopy).toHaveBeenCalledOnce();
    fireEvent.click(hide);
    expect(screen.queryByText(/Tell me when PR 12/u)).toBeNull();
  });

  it("names the day of an earlier run, and stays plain text without Studio or a time", () => {
    const { rerender } = render(<ScheduledTurnV2 anchorId="turn-1" content={prompt} createdAt="2026-10-02T08:00:00.000Z" now={now}
      timeZone="Europe/London" title="PR watch" />);
    expect(screen.getByTestId("scheduled-turn")).toHaveTextContent("Automation · PR watch·Fri 2 Oct, 09:00·Show instructions");
    expect(screen.queryByRole("button", { name: "Automation · PR watch" })).toBeNull();
    rerender(<ScheduledTurnV2 anchorId="turn-1" content={prompt} title="PR watch" />);
    expect(screen.getByTestId("scheduled-turn")).toHaveTextContent("Automation · PR watch·Show instructions");
    fireEvent.click(screen.getByRole("button", { name: "Show instructions" }));
    // Without a copy action the instructions are shown alone.
    expect(screen.queryByRole("button", { name: "Copy instructions" })).toBeNull();
  });
});
