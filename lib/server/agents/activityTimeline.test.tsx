import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceActivityTimelineV2 } from "@/features/run-lifecycle-v2/WorkspaceActivityTimelineV2";
import { createCodexActivityProjection } from "./activityProjection";
import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";
import { workspaceLifecycleActivity } from "../workspace/activityProjection";
import { WorkspaceActivityText } from "../workspace/activityText";
import type { ProviderRunRequest } from "../providers/types";

describe("Agent activity in the shared timeline", () => {
  it("preserves manual disclosure for actual Agent command projections", () => {
    const project = createCodexActivityProjection("synthetic-run", {
      searchPlan: { mode: "all_selected", options: [] }
    } as unknown as ProviderRunRequest);
    const text = new WorkspaceActivityText([]);
    const running = project({ type: "activity", kind: "command", id: "one", phase: "running",
      command: "python inspect.py" }, text, 1000)!;
    const { container, rerender } = render(<WorkspaceActivityTimelineV2 activity={{ entries: [running] }} />);
    const row = container.querySelector("details")!;
    expect(row).not.toHaveAttribute("open");
    fireEvent.click(row.querySelector("summary")!);
    const failed = project({ type: "activity", kind: "command", id: "one", phase: "failed",
      command: "python inspect.py", output: "Synthetic failure", exitCode: 2 }, text, 1500)!;
    const other = project({ type: "activity", kind: "command", id: "two", phase: "failed",
      command: "python inspect.py", output: "Synthetic failure", exitCode: 2 }, text, 1600)!;
    rerender(<WorkspaceActivityTimelineV2 activity={{ entries: [failed, other] }} />);
    expect(container.querySelector("details")).toBe(row);
    expect(row).toHaveAttribute("open");
    expect(container.querySelectorAll("details")[1]).not.toHaveAttribute("open");
    expect(row).toHaveTextContent("Exit code 2");
    fireEvent.click(row.querySelector("summary")!);
    rerender(<WorkspaceActivityTimelineV2 activity={{ entries: [failed, other] }} />);
    expect(row).not.toHaveAttribute("open");
  });

});

it("applies retirement to actual native Agent rows without borrowing the outer process exit", () => {
  const project = createCodexActivityProjection("native-run", { searchPlan: { mode: "all_selected", options: [] } } as unknown as ProviderRunRequest);
  const text = new WorkspaceActivityText([]);
  const running = project({ type: "activity", kind: "command", id: "open", phase: "running", command: "prepare" }, text, 1000)!;
  const failed = project({ type: "activity", kind: "command", id: "failed", phase: "failed", command: "inspect", exitCode: 17 }, text, 1100)!;
  const activity = mergeWorkspaceActivity({ entries: [running, failed] }, { entries: [
    workspaceLifecycleActivity({ kind: "execution_status", phase: "closed", runId: "native-run" })
  ] })!;
  expect(activity.entries[0]?.phase).toBe("closed");
  expect(activity.entries[0]?.command?.exitCode).toBeUndefined();
  expect(activity.entries[1]).toMatchObject({ phase: "failed", command: { exitCode: 17 } });
  const { container } = render(<WorkspaceActivityTimelineV2 activity={activity} />);
  expect(container.querySelector(".v2-spinner")).toBeNull();
  expect(container).toHaveTextContent("prepare · exit not observed");
});
