import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { AnswerProcessV2 } from "./AnswerProcessV2";

type Calls = ThreadToolActivity["calls"];

const research = (toolName: string, status: Calls[number]["status"] = "complete", durationMs = 10): Calls[number] =>
  ({ durationMs, origin: "tool", round: 1, serverName: "Research", status, toolName });
const search: Calls[number] = { origin: "web_search", round: 1, serverName: "Web search", status: "complete", toolName: "search" };
const finding = (status?: Calls[number]["status"]) => research("Recording evidence", status);

function steps(calls: Calls) {
  render(<AnswerProcessV2 toolActivity={{ calls }} workDurationMs={60_000} />);
  for (const fold of document.querySelectorAll("details")) (fold as HTMLDetailsElement).open = true;
  return within(screen.getByRole("heading", { name: "Steps" }).parentElement!).getAllByRole("listitem").map((row) => row.textContent);
}

describe("research in the answer's steps", () => {
  it("reads as plain words, with no tool's name", () => {
    const rows = steps([research("Started"), research("Plan"), research("Extending the matrix"), research("Checking the report")]);
    expect(rows.join(" | ")).toBe("Started research10 ms | Finalized the plan10 ms | Extended the comparison10 ms | Checked the report10 ms");
    expect(document.body.textContent).not.toMatch(/Research:|_/u);
  });

  it("shows a run's findings as one counted row where the first was saved, however they fall among other steps", () => {
    const calls: Calls = [finding(), search, research("Plan")];
    for (let saved = 1; saved < 143; saved += 1) calls.push(finding(), { ...search, round: saved + 1 });
    const rows = steps(calls);
    expect(rows[0]).toBe("Saved 143 findings1.4 s");
    expect(rows.filter((row) => row?.includes("finding"))).toHaveLength(1);
  });

  it("keeps findings that failed on a row of their own", () => {
    expect(steps([finding(), finding(), finding("error"), search, finding("error")]).slice(0, 2))
      .toEqual(["Saved 2 findings20 ms", "Could not save 2 findings20 ms"]);
  });

  it("counts a researcher's findings on one row inside its own steps", () => {
    const researcher = { subagentThreadId: "thread", subagentTurnId: "turn" };
    const calls: Calls = [{ origin: "tool", round: 1, status: "complete", toolName: "call_subagent",
      subagent: { mode: "foreground", name: "researcher-1", threadId: "thread", turnId: "turn" } }];
    for (let saved = 0; saved < 40; saved += 1) calls.push({ ...finding(), ...researcher }, { ...search, ...researcher, round: saved + 1 });
    steps(calls);
    const nested = within(screen.getByTestId("subagent-steps")).getAllByRole("listitem").map((row) => row.textContent);
    expect(nested[0]).toBe("Saved 40 findings400 ms");
    expect(nested.filter((row) => row?.includes("finding"))).toHaveLength(1);
  });

  it("says one finding the plain way", () => {
    expect(steps([finding()])[0]).toBe("Saved a finding10 ms");
  });
});
