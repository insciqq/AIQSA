import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { AnswerProcessV2 } from "./AnswerProcessV2";

const plan: ThreadWorkspaceActivityEntry = {
  id: "plan:run", items: [{ completed: true, text: "Read the workbook" }, { active: true, completed: false, text: "Merge the sheets" },
    { completed: false, text: "Draw the chart" }], kind: "plan", phase: "running", sequence: 3
};
const calls: ThreadToolActivity["calls"] = [
  { origin: "session", round: 1, serverName: "Plan", status: "complete", toolName: "update_plan" },
  { origin: "session", round: 1, serverName: "Secrets", status: "complete", toolName: "read_secret" },
  { origin: "session", round: 2, serverName: "Plan", status: "complete", toolName: "update_plan" }
];

function openProcess() {
  for (const fold of document.querySelectorAll("details")) (fold as HTMLDetailsElement).open = true;
}

function planSteps() {
  return within(screen.getByRole("list", { name: "Plan steps" })).getAllByRole("listitem");
}

describe("the agent's plan in the answer", () => {
  it("shows its steps as done, current and waiting, and its count on the fold, apart from Workspace work", () => {
    render(<AnswerProcessV2 toolActivity={{ calls }} workDurationMs={12_400} workspaceActivity={{ entries: [plan] }} />);
    const fold = screen.getByTestId("tool-activity-disclosure");
    expect(fold.querySelector("summary")).toHaveTextContent("Worked for 12s · Plan · 1 of 3 complete");
    expect(fold).not.toHaveTextContent("Workspace");
    openProcess();
    const section = screen.getByTestId("answer-plan");
    expect(within(section).getByRole("heading", { name: "Plan" })).toBeVisible();
    expect(planSteps().map((step) => [step.dataset.state, step.textContent])).toEqual([
      ["complete", "Read the workbookDone"], ["active", "Merge the sheetsIn progress"], ["pending", "Draw the chartNot started"]
    ]);
    // The plan's own calls are the plan, not steps; other tools stay steps.
    expect(screen.getByText("Used Secrets: read secret")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/update.plan/iu);
  });

  it("spins on the current step while the answer runs and keeps the count beside the live status", () => {
    const { rerender } = render(<AnswerProcessV2 liveLabel="Thinking…" workspaceActivity={{ entries: [plan] }} />);
    // The live line unfolds to the plan instead of standing alone.
    expect(screen.queryByTestId("run-status-line")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary")).toHaveTextContent("Thinking… · Plan · 1 of 3 complete");
    openProcess();
    expect(planSteps()[1]!.querySelector(".v2-answer-process-mark")).toHaveAttribute("data-status", "running");
    rerender(<AnswerProcessV2 workspaceActivity={{ entries: [{ ...plan, items: plan.items!.map((item) => ({ completed: true, text: item.text })),
      phase: "succeeded" }] }} />);
    expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary")).toHaveTextContent("Plan · 3 of 3 complete");
    expect(planSteps().map((step) => step.dataset.state)).toEqual(["complete", "complete", "complete"]);
  });

  it("keeps a settled answer's unfinished step marked without motion", () => {
    render(<AnswerProcessV2 workspaceActivity={{ entries: [{ ...plan, phase: "unknown" }] }} />);
    openProcess();
    expect(planSteps()[1]!.querySelector(".v2-answer-process-mark")).toHaveAttribute("data-status", "active");
    expect(document.querySelector(".v2-spinner")).toBeNull();
  });

  it("leaves Workspace work to its own timeline beside the plan", () => {
    const command: ThreadWorkspaceActivityEntry = { command: { preview: "python merge.py" }, id: "call:1", kind: "command", phase: "succeeded",
      sequence: 4 };
    render(<AnswerProcessV2 workDurationMs={12_400} workspaceActivity={{ entries: [plan, command] }} />);
    const fold = screen.getByTestId("tool-activity-disclosure");
    expect(fold.querySelector("summary")).toHaveTextContent("Worked in Workspace for 12s · Plan · 1 of 3 complete");
    openProcess();
    const timeline = screen.getByTestId("workspace-activity");
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(1);
    expect(timeline).toHaveTextContent("python merge.py");
    expect(timeline).not.toHaveTextContent("Plan");
    expect(planSteps()).toHaveLength(3);
  });
});
