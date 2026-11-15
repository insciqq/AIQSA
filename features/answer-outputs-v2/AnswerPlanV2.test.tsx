import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { AnswerProcessV2 } from "./AnswerProcessV2";

const plan: ThreadWorkspaceActivityEntry = {
  id: "plan:run", items: [{ completed: true, text: "Read the workbook" }, { active: true, completed: false, text: "Merge the sheets" },
    { completed: false, text: "Draw the chart" }], kind: "plan", phase: "running", sequence: 3
};
const done: ThreadWorkspaceActivityEntry = {
  ...plan, items: plan.items!.map((item) => ({ completed: true, text: item.text })), phase: "succeeded"
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

function foldLine() {
  return screen.getByTestId("tool-activity-disclosure").querySelector("summary");
}

describe("the agent's plan in the answer", () => {
  it("shows its steps as done, current and waiting, and its count beside the live status", () => {
    render(<AnswerProcessV2 liveLabel="Thinking…" toolActivity={{ calls }} workspaceActivity={{ entries: [plan] }} />);
    // The live line unfolds to the plan instead of standing alone.
    expect(screen.queryByTestId("run-status-line")).not.toBeInTheDocument();
    expect(foldLine()).toHaveTextContent("Thinking… · Plan · 1 of 3 complete");
    expect(screen.getByTestId("tool-activity-disclosure")).not.toHaveTextContent("Workspace");
    openProcess();
    const section = screen.getByTestId("answer-plan");
    expect(within(section).getByRole("heading", { name: "Plan" })).toBeVisible();
    expect(planSteps().map((step) => [step.dataset.state, step.textContent])).toEqual([
      ["complete", "Read the workbookDone"], ["active", "Merge the sheetsIn progress"], ["pending", "Draw the chartNot started"]
    ]);
    expect(planSteps()[1]!.querySelector(".v2-answer-process-mark")).toHaveAttribute("data-status", "running");
    // The plan's own calls are the plan, not steps; other tools stay steps.
    expect(screen.getByText("Used Secrets: read secret")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/update.plan/iu);
  });

  it("keeps the count of a plan the agent finished once the answer ends", () => {
    const { rerender } = render(<AnswerProcessV2 liveLabel="Thinking…" workspaceActivity={{ entries: [done] }} />);
    expect(foldLine()).toHaveTextContent("Thinking… · Plan · 3 of 3 complete");
    rerender(<AnswerProcessV2 toolActivity={{ calls }} workDurationMs={12_400} workspaceActivity={{ entries: [done] }} />);
    expect(foldLine()).toHaveTextContent("Worked for 12s · Plan · 3 of 3 complete");
    openProcess();
    expect(planSteps().map((step) => [step.dataset.state, step.textContent])).toEqual([
      ["complete", "Read the workbookDone"], ["complete", "Merge the sheetsDone"], ["complete", "Draw the chartDone"]
    ]);
  });

  it("stops presenting an unfinished plan as progress once the answer has finished", () => {
    render(<AnswerProcessV2 toolActivity={{ calls }} workDurationMs={12_400} workspaceActivity={{ entries: [{ ...plan, phase: "unknown" }] }} />);
    expect(foldLine()).toHaveTextContent("Worked for 12s · Plan · 3 steps");
    expect(document.body).not.toHaveTextContent(/of 3 complete/u);
    openProcess();
    // The step the agent marked done keeps its check; nothing else claims progress.
    expect(planSteps().map((step) => [step.dataset.state, step.textContent])).toEqual([
      ["complete", "Read the workbookDone"], ["pending", "Merge the sheetsNot done"], ["pending", "Draw the chartNot done"]
    ]);
    expect(planSteps().map((step) => step.querySelector(".v2-answer-process-mark")?.getAttribute("data-status")))
      .toEqual(["complete", "pending", "pending"]);
    expect(document.querySelector(".v2-spinner")).toBeNull();
    expect(document.body).not.toHaveTextContent("In progress");
  });

  it("names a one-step plan's size in the singular", () => {
    render(<AnswerProcessV2 workspaceActivity={{ entries: [{ ...plan, items: [{ active: true, completed: false, text: "Merge" }] }] }} />);
    expect(foldLine()).toHaveTextContent(/Plan · 1 step$/u);
  });

  it("reads a failed answer's untouched plan as its steps, not as nothing done", () => {
    // The agent planned once, worked for minutes and the provider failed its last request.
    const untouched: ThreadWorkspaceActivityEntry = { ...plan, items: plan.items!.map((item, index) =>
      ({ ...(index === 0 ? { active: true as const } : {}), completed: false, text: item.text })), phase: "unknown" };
    render(<RunAnswerV2 content="" toolActivity={{ calls }} workDurationMs={854_000} workspaceActivity={{ entries: [untouched] }} presentation={{
      failure: { code: "provider_response_failed", message: "The provider failed.", recovery: "retry" }, kind: "terminal_error", runId: "run-failed"
    }} />);
    expect(foldLine()).toHaveTextContent("Worked for 14m 14s · Plan · 3 steps");
    expect(document.body).not.toHaveTextContent(/0 of 3 complete/u);
    openProcess();
    expect(planSteps().map((step) => step.textContent)).toEqual([
      "Read the workbookNot done", "Merge the sheetsNot done", "Draw the chartNot done"
    ]);
    expect(document.querySelector(".v2-spinner")).toBeNull();
  });

  it("leaves Workspace work to its own timeline beside the plan", () => {
    const command: ThreadWorkspaceActivityEntry = { command: { preview: "python merge.py" }, id: "call:1", kind: "command", phase: "succeeded",
      sequence: 4 };
    render(<AnswerProcessV2 workDurationMs={12_400} workspaceActivity={{ entries: [plan, command] }} />);
    expect(foldLine()).toHaveTextContent("Worked in Workspace for 12s · Plan · 3 steps");
    openProcess();
    const timeline = screen.getByTestId("workspace-activity");
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(1);
    expect(timeline).toHaveTextContent("python merge.py");
    expect(timeline).not.toHaveTextContent("Plan");
    expect(planSteps()).toHaveLength(3);
  });
});
