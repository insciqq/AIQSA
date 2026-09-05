import { describe, expect, it } from "vitest";
import { decodeThreadWorkspaceActivity, type ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
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
  it("keeps output freshness when a cold terminal update arrives before its output snapshots", () => {
    const updates = [
      { ...command("a", "running"), command: { preview: "npm test", stdoutPreview: "old" }, sequence: 1 },
      { ...command("a", "running"), command: { preview: "…", stdoutPreview: "latest" }, sequence: 2 },
      { ...command("a", "succeeded"), command: { exitCode: 0, preview: "…" }, sequence: 3 }
    ];
    const event = (payload: ThreadWorkspaceActivityEntry) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" });
    const forward = presentWorkspaceActivityV2(updates.map(event));
    const reordered = presentWorkspaceActivityV2([updates[2]!, updates[0]!, updates[1]!].map(event));
    expect(reordered).toEqual(forward);
    expect(reordered?.entries[0]?.command?.stdoutPreview).toBe("latest");
    const snapshot = presentWorkspaceActivityV2([updates[2]!, updates[0]!].map(event));
    expect(presentWorkspaceActivityV2([event(updates[1]!)], decodeThreadWorkspaceActivity(snapshot))).toEqual(forward);
  });

  it("restores original row order after reordered starts and later completion of the first command", () => {
    const updates = [
      { ...command("a", "running"), sequence: 1 },
      { ...command("b", "running"), sequence: 2 },
      { ...command("a", "succeeded"), sequence: 3 }
    ];
    const events = [updates[1]!, updates[2]!, updates[0]!].map((payload) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" }));
    expect(presentWorkspaceActivityV2(events)?.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("uses durable sequence in both merge directions and preserves command facts on replay", () => {
    const running = { ...command("a", "running"), command: { cwd: "project", preview: "npm test" }, sequence: 3, startedAt: "2026-09-04T10:00:00.000Z" };
    const terminal = { ...command("a", "failed", "…"), command: { exitCode: 1, preview: "…", stdoutPreview: "bounded output" }, sequence: 7 };
    const event = (payload: ThreadWorkspaceActivityEntry) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" });
    const expected = { entries: [{ ...terminal, command: { ...terminal.command, cwd: "project", outputSequence: 7, preview: "npm test" }, firstSequence: 3, startedAt: running.startedAt }] };
    expect(presentWorkspaceActivityV2([event(terminal)], { entries: [running] })).toEqual(expected);
    expect(presentWorkspaceActivityV2([event(running)], { entries: [terminal] })).toEqual(expected);
    expect(presentWorkspaceActivityV2([event(terminal), event(running), event(terminal)], expected)).toEqual(expected);
    expect(presentWorkspaceActivityV2([event(terminal), event(running)])).toEqual(expected);
    // Freshness also orders conflicting terminal observations, with no phase ranking.
    expect(presentWorkspaceActivityV2([event({ ...terminal, phase: "cancelled", sequence: 9 })], expected)?.entries[0]?.phase).toBe("cancelled");
  });

  it("retains the authoritative run-outcome projection when its underlying running event is replayed", () => {
    const running = { ...command("a", "running"), sequence: 4 };
    const cancelled = { ...running, phase: "cancelled" as const, runOutcome: "cancelled" as const };
    const event = { data: { artifactType: "workspace_activity", payload: running }, type: "artifact" };
    expect(presentWorkspaceActivityV2([event], { entries: [cancelled] })).toEqual({ entries: [{ ...cancelled, firstSequence: 4 }] });
  });

  it("retains one bounded output snapshot across reordered delivery and an update without output", () => {
    const initial = { ...command("a", "running"), command: { preview: "npm test", stderrPreview: "e".repeat(8 * 1024) }, sequence: 1 };
    const terminal = { ...command("a", "succeeded", "…"), command: { exitCode: 0, preview: "…", stdoutPreview: "o".repeat(8 * 1024) }, sequence: 2 };
    const close = { ...terminal, command: { exitCode: 0, preview: "…" }, sequence: 3 };
    const events = [initial, terminal, close, initial].map((payload) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" }));
    const activity = presentWorkspaceActivityV2(events);
    expect(decodeThreadWorkspaceActivity(activity)).toEqual(activity);
    expect(activity?.entries[0]?.command).toMatchObject({ exitCode: 0, outputSequence: 2, preview: "npm test" });
    expect(activity?.entries[0]?.command?.stdoutPreview).toBe(terminal.command.stdoutPreview);
    expect(activity?.entries[0]?.command?.stderrPreview).toBeUndefined();
  });
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

  it("retains newer persisted entries and adds unseen live steps", () => {
    const events = [
      { data: { artifactType: "workspace_activity", payload: command("a", "running") }, type: "artifact" },
      { data: { artifactType: "workspace_activity", payload: command("b", "running", "pytest") }, type: "artifact" },
      { data: { artifactType: "tool_call", payload: { serverName: "Workspace", status: "requested" } }, type: "artifact" }
    ];
    expect(presentWorkspaceActivityV2(events, null)).toEqual({
      entries: [command("a", "running"), command("b", "running", "pytest")]
    });
    expect(presentWorkspaceActivityV2(events, {
      entries: [{ ...command("a", "succeeded"), sequence: 1 }],
      outputStatus: { state: "complete" }
    })).toEqual({
      entries: [{ ...command("a", "succeeded"), firstSequence: 1, sequence: 1 }, command("b", "running", "pytest")],
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
