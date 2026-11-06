import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { AnswerProcessV2 } from "./AnswerProcessV2";

type Calls = ThreadToolActivity["calls"];

function stepRows(calls: Calls) {
  render(<AnswerProcessV2 toolActivity={{ calls }} workDurationMs={60_000} />);
  for (const fold of document.querySelectorAll("details")) (fold as HTMLDetailsElement).open = true;
  return within(screen.getByRole("heading", { name: "Steps" }).parentElement!).getAllByRole("listitem");
}

describe("computer steps in the answer", () => {
  it("show a computer glyph, the command, path or pattern as code, and a command's exit code", () => {
    const rows = stepRows([
      { durationMs: 420, exitCode: 0, origin: "computer", round: 1, status: "complete", summary: "Get-ChildItem *.docx", toolName: "computer_shell" },
      { durationMs: 1_850, exitCode: 1, origin: "computer", round: 2, status: "complete", summary: "python summarize.py", toolName: "computer_shell" },
      { durationMs: 95, origin: "computer", round: 2, status: "complete", summary: "C:\\Contracts\\October.docx", toolName: "computer_read" },
      { durationMs: 60, origin: "computer", round: 3, status: "error", summary: "summary.md", toolName: "computer_edit" },
      { durationMs: 30, origin: "computer", round: 3, status: "complete", toolName: "computer_job_output" }
    ]);
    expect(rows.map((row) => row.textContent)).toEqual([
      "On your computer: Ran Get-ChildItem *.docxExit code 0 · 420 ms",
      "On your computer: Ran python summarize.pyExit code 1 · 1.9 s",
      "On your computer: Read C:\\Contracts\\October.docx95 ms",
      "On your computer: Could not edit summary.md60 ms",
      "On your computer: Checked background job30 ms"
    ]);
    const first = within(rows[0]!).getByTestId("computer-step");
    expect(first.querySelector("svg")).not.toBeNull();
    expect(within(first).getByText("Get-ChildItem *.docx").tagName).toBe("CODE");
    expect(rows[3]).toHaveAttribute("data-status", "error");
  });

  it("keep two identical reads on their own rows", () => {
    const read: Calls[number] = { durationMs: 10, origin: "computer", round: 1, status: "complete", summary: "notes.txt", toolName: "computer_read" };
    expect(stepRows([read, { ...read, round: 2 }])).toHaveLength(2);
  });
});
