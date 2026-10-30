import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { describeToolCallV2 } from "@/features/run-lifecycle-v2/runPresentation";
import { AnswerProcessV2, splitSubagentStepsV2 } from "./AnswerProcessV2";

const calls: ThreadToolActivity["calls"] = [
  { origin: "tool", round: 1, status: "complete", toolName: "call_subagent", durationMs: 42_000,
    subagent: { mode: "foreground", name: "shop", threadId: "thread-1", turnId: "turn-1" } },
  { origin: "web_search", round: 1, serverName: "Web search", status: "complete", subagentThreadId: "thread-1", subagentTurnId: "turn-1",
    toolName: "search_selected_engines" },
  { origin: "workspace", round: 2, serverName: "Workspace", status: "complete", subagentThreadId: "thread-1", subagentTurnId: "turn-1",
    toolName: "sandbox_exec" },
  { origin: "mcp", round: 3, serverName: "Jira", status: "error", subagentThreadId: "thread-1", subagentTurnId: "turn-1",
    toolName: "create_issue" },
  { origin: "session", round: 2, serverName: "Secrets", status: "complete", toolName: "read_secret" }
];

function openProcess() {
  for (const fold of document.querySelectorAll("details")) (fold as HTMLDetailsElement).open = true;
}

describe("a sub-agent's steps in the answer", () => {
  it("nest under its call_subagent step, Workspace ones included, while the answer's own steps stay apart", () => {
    render(<AnswerProcessV2 toolActivity={{ calls }} workDurationMs={50_000} />);
    openProcess();
    const step = screen.getByTestId("subagent-steps");
    expect(step.querySelector("summary")).toHaveTextContent("Sub-agent shop finished");
    expect(step.querySelector("summary")).toHaveTextContent("3 steps");
    const nested = within(within(step).getByRole("list", { name: "Sub-agent shop finished: steps" })).getAllByRole("listitem");
    expect(nested.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Searched the web"), expect.stringContaining("Worked in Workspace"),
      expect.stringContaining("Jira: create issue failed")
    ]);
    // The answer's own step is not nested, and the sub-agent's are listed once.
    expect(screen.getByText("Used Secrets: read secret")).toBeVisible();
    expect(screen.getAllByText("Searched the web")).toHaveLength(1);
  });

  it("keeps a sub-agent's calls whose step is not in the answer among the answer's own", () => {
    const orphan = calls.filter((call) => call.toolName !== "call_subagent");
    expect(splitSubagentStepsV2(orphan).own).toHaveLength(orphan.length);
    expect(splitSubagentStepsV2(calls).nested.get("turn-1")).toHaveLength(3);
  });

  it("names the sub-agent in the live status and in how its step ended", () => {
    expect(describeToolCallV2({ origin: "tool", serverName: "shop", toolName: "call_subagent" }, "running")).toBe("Sub-agent shop is working");
    expect(describeToolCallV2({ origin: "tool", subagent: { name: "shop" }, toolName: "call_subagent" }, "failed"))
      .toBe("Sub-agent shop did not finish");
    expect(describeToolCallV2({ origin: "tool", subagent: { name: "shop" }, toolName: "stop_subagent" }, "settled"))
      .toBe("Stopped sub-agent shop");
    expect(describeToolCallV2({ origin: "tool", serverName: "Not A Slug!", toolName: "call_subagent" }, "settled")).toBe("Sub-agent finished");
  });
});
