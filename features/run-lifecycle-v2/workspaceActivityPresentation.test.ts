import { describe, expect, it } from "vitest";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import {
  aggregateWorkspaceActivityV2,
  presentWorkspaceActivityV2,
  workspaceActivityLabelV2,
  workspaceLiveLabelV2,
  workspaceOutputStatusCopyV2,
  workspaceProcessLabelV2
} from "./workspaceActivityPresentation";

const command = (id: string, phase: ThreadWorkspaceActivityEntry["phase"], preview = "npm test"): ThreadWorkspaceActivityEntry =>
  ({ command: { preview }, id, kind: "command", phase });

describe("workspace activity presentation", () => {
  it("phrases every kind and phase in plain language", () => {
    expect(workspaceActivityLabelV2(command("a", "running"))).toBe("Running npm test…");
    expect(workspaceActivityLabelV2(command("a", "succeeded"))).toBe("Ran npm test");
    expect(workspaceActivityLabelV2(command("a", "failed"))).toBe("npm test failed");
    expect(workspaceActivityLabelV2(command("a", "cancelled"))).toBe("Stopped npm test");
    expect(workspaceActivityLabelV2(command("a", "succeeded", "x".repeat(120)))).toBe(`Ran ${"x".repeat(79)}…`);
    expect(workspaceActivityLabelV2({ file: { displayPath: "project/a.ts" }, id: "b", kind: "file_read", phase: "succeeded" })).toBe("Read project/a.ts");
    expect(workspaceActivityLabelV2({ file: { displayPath: "inbox/report.xlsx", targetPath: "project/report.xlsx" }, id: "c", kind: "file_copy", phase: "succeeded" }))
      .toBe("Copied inbox/report.xlsx → project/report.xlsx");
    expect(workspaceActivityLabelV2({ file: { displayPath: "project/tmp.txt" }, id: "d", kind: "file_check", phase: "failed" })).toBe("Could not find project/tmp.txt");
    expect(workspaceActivityLabelV2({ count: 3, id: "e", kind: "attachments_prepare", phase: "running" })).toBe("Preparing 3 attachments…");
    expect(workspaceActivityLabelV2({ count: 1, id: "f", kind: "attachments_prepare", phase: "succeeded" })).toBe("Prepared 1 attachment");
    expect(workspaceActivityLabelV2({ count: 2, id: "g", kind: "outputs_export", phase: "running" })).toBe("Exporting 2 files…");
    expect(workspaceActivityLabelV2({ id: "h", kind: "workspace_start", phase: "succeeded" })).toBe("Workspace ready");
    expect(workspaceActivityLabelV2({ id: "i", kind: "workspace_recreated", phase: "succeeded" })).toBe("Workspace was recreated");
    expect(workspaceActivityLabelV2({ id: "j", kind: "workspace_stopped", phase: "cancelled" })).toBe("Workspace work stopped");
  });

  it("keeps persisted entries authoritative and only adds unseen live steps", () => {
    const events = [
      { data: { artifactType: "workspace_activity", payload: command("a", "running") }, type: "artifact" },
      { data: { artifactType: "workspace_activity", payload: command("b", "running", "pytest") }, type: "artifact" },
      { data: { artifactType: "tool_call", payload: { serverName: "Workspace", status: "requested" } }, type: "artifact" }
    ];
    expect(presentWorkspaceActivityV2(events, null)).toEqual({
      entries: [command("a", "running"), command("b", "running", "pytest")]
    });
    expect(presentWorkspaceActivityV2(events, {
      entries: [command("a", "succeeded")],
      outputStatus: { state: "complete" }
    })).toEqual({
      entries: [command("a", "succeeded"), command("b", "running", "pytest")],
      outputStatus: { state: "complete" }
    });
    expect(presentWorkspaceActivityV2([], null)).toBeNull();
    expect(workspaceLiveLabelV2(presentWorkspaceActivityV2(events, null))).toBe("Running pytest…");
    expect(workspaceLiveLabelV2({ entries: [command("a", "succeeded")] })).toBe("Working in Workspace…");
  });

  it("aggregates consecutive successful checks and keeps failures visible", () => {
    const check = (id: string, phase: ThreadWorkspaceActivityEntry["phase"]): ThreadWorkspaceActivityEntry =>
      ({ durationMs: 10, file: { displayPath: `project/${id}.txt` }, id, kind: "file_check", phase });
    const rows = aggregateWorkspaceActivityV2([check("a", "succeeded"), check("b", "succeeded"), check("c", "failed"), check("d", "succeeded")]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ count: 2, durationMs: 20, id: "a" });
    expect(workspaceActivityLabelV2(rows[0]!)).toBe("Checked 2 files");
    expect(rows[1]).toMatchObject({ id: "c", phase: "failed" });
    expect(workspaceActivityLabelV2(rows[2]!)).toBe("Checked project/d.txt");
  });

  it("labels the fold and the output status", () => {
    expect(workspaceProcessLabelV2({ live: true, workDurationMs: 1_000 })).toBe("Working in Workspace…");
    expect(workspaceProcessLabelV2({ live: false, workDurationMs: 42_000 })).toBe("Worked in Workspace for 42s");
    expect(workspaceOutputStatusCopyV2({ state: "exporting" }, 2)).toBe("Exporting 2 files…");
    expect(workspaceOutputStatusCopyV2({ state: "retrying" })).toContain("still being prepared");
    expect(workspaceOutputStatusCopyV2({ state: "failed" })).toContain("could not be prepared");
    expect(workspaceOutputStatusCopyV2({ state: "complete" })).toBeNull();
    expect(workspaceOutputStatusCopyV2(undefined)).toBeNull();
  });
});
