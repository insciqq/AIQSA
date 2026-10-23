// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { isRunOutputArtifactEvent } from "../runs/runOutputEvents";
import { workspaceActivityEvent } from "../workspace/activityProjection";
import { patchActivityChanges, patchActivityEntry, planActivityEntry } from "./harnessActivity";

const exact = (entry: NonNullable<ReturnType<typeof planActivityEntry>>) => {
  expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
  expect(isRunOutputArtifactEvent(workspaceActivityEvent(entry))).toBe(true);
};

describe("plan row", () => {
  it("marks done and current steps, keeps one row per run and a new update per call", () => {
    const update = { plan: [{ status: "completed" as const, step: "Read the workbook" }, { status: "in_progress" as const, step: "Merge\nthe   sheets" },
      { status: "pending" as const, step: "Draw the chart" }] };
    const first = planActivityEntry({ callId: "call-1", runId: "run-1", update })!;
    expect(first).toMatchObject({ items: [{ completed: true, text: "Read the workbook" }, { active: true, completed: false, text: "Merge the sheets" },
      { completed: false, text: "Draw the chart" }], kind: "plan", phase: "running" });
    expect(first.items?.[0]).not.toHaveProperty("active");
    exact(first);
    const done = planActivityEntry({ callId: "call-2", runId: "run-1", update: { plan: update.plan.map((step) => ({ ...step, status: "completed" as const })) } })!;
    expect(done.phase).toBe("succeeded");
    expect(done.id).toBe(first.id);
    expect(done.updateId).not.toBe(first.updateId);
    expect(planActivityEntry({ callId: "call-1", runId: "run-2", update })!.id).not.toBe(first.id);
    exact(done);
  });

  it("keeps the contract's bounds and drops steps without visible text", () => {
    const long = planActivityEntry({ callId: "c", runId: "r", update: { plan: [{ status: "pending", step: `${"x".repeat(600)}\u0007` },
      { status: "pending", step: "\u0001\u0002" }] } })!;
    expect(long.items).toHaveLength(1);
    expect(long.items?.[0]?.text).toHaveLength(512);
    exact(long);
    expect(planActivityEntry({ callId: "c", runId: "r", update: { plan: [{ status: "pending", step: "\u0003" }] } })).toBeNull();
  });
});

describe("patch row", () => {
  const patch = (body: string) => ({ input: `*** Begin Patch\n${body}\n*** End Patch` });

  it("names the files a patch adds, updates, deletes and moves, as the thread shows paths", () => {
    expect(patchActivityChanges(patch(["*** Add File: notes/todo.md", "+one", "*** Update File: /workspace/output/report.txt", "@@", "-a", "+b",
      "*** Delete File: old.txt", "*** Update File: src/a.py", "*** Move to: src/b.py", "@@", "-x", "+y"].join("\n")))).toEqual([
      { action: "add", displayPath: "project/notes/todo.md" },
      { action: "update", displayPath: "output/report.txt" },
      { action: "delete", displayPath: "project/old.txt" },
      { action: "delete", displayPath: "project/src/a.py" },
      { action: "add", displayPath: "project/src/b.py" }
    ]);
  });

  it("shows nothing for a patch that fails before touching a file", () => {
    expect(patchActivityChanges({})).toEqual([]);
    expect(patchActivityChanges({ input: "not a patch" })).toEqual([]);
    expect(patchActivityChanges(patch("*** Add File: /workspace/inbox/a.txt\n+x"))).toEqual([]);
    expect(patchActivityChanges(patch("*** Add File: ../../etc/passwd\n+x"))).toEqual([]);
  });

  it("is one row per call that settles in place, within the contract", () => {
    const changes = patchActivityChanges(patch("*** Add File: a.txt\n+x"));
    const startedAt = new Date("2026-10-23T09:00:00Z");
    const running = patchActivityEntry({ callId: "row-1", changes, phase: "running", startedAt });
    const settled = patchActivityEntry({ callId: "row-1", changes, durationMs: 12.4, phase: "succeeded", startedAt });
    expect(running).toMatchObject({ changes: [{ action: "add", displayPath: "project/a.txt" }], count: 1, kind: "file_change", phase: "running" });
    expect(settled).toMatchObject({ durationMs: 12, id: running.id, phase: "succeeded" });
    expect(settled.updateId).not.toBe(running.updateId);
    for (const entry of [running, settled]) {
      expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
      expect(isRunOutputArtifactEvent(workspaceActivityEvent(entry))).toBe(true);
    }
    const many = patchActivityEntry({ callId: "row-2", changes: Array.from({ length: 70 }, (_, index) => ({ action: "update" as const,
      displayPath: `project/f${index}` })), phase: "failed", startedAt });
    expect(many).toMatchObject({ count: 70, phase: "failed" });
    expect(many.changes).toHaveLength(64);
    expect(decodeThreadWorkspaceActivityEntry(many)).toEqual(many);
  });
});
