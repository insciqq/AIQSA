import { describe, expect, it } from "vitest";
import { decodeThreadWorkspaceActivity, type ThreadWorkspaceActivityEntry } from "../contracts/workspace";
import { compactWorkspaceActivityEntries, mergeWorkspaceActivity, mergeWorkspaceActivityEntry } from "./workspaceActivity";

const row = (sequence: number, phase: ThreadWorkspaceActivityEntry["phase"] = "succeeded"): ThreadWorkspaceActivityEntry => ({
  id: `step:${sequence}`, kind: "command", command: { preview: `echo ${sequence}` }, phase, sequence
});
const history = () => Array.from({ length: 600 }, (_, index) => {
  const sequence = index + 1;
  return sequence === 1 ? row(sequence, "running") : sequence === 2 ? row(sequence, "failed")
    : sequence === 3 ? { ...row(sequence), kind: "workspace_start" as const, command: undefined } : row(sequence);
});

describe("bounded Workspace activity snapshots", () => {
  it("keeps active actions and the latest completed actions with honest eviction counts", () => {
    const activity = mergeWorkspaceActivity(null, { entries: history() })!;
    expect(activity.entries).toHaveLength(512);
    expect(activity.truncated).toBe(true);
    expect(activity.entries[0]).toMatchObject({ kind: "elided", count: 89, failedCount: 1, hasLifecycle: true, throughSequence: 90 });
    expect(activity.entries[1]).toMatchObject({ id: "step:1", phase: "running" });
    expect(activity.entries.at(-1)?.id).toBe("step:600");
    expect(activity.entries.find((entry) => entry.id === "step:91")).toBeDefined();
    expect(decodeThreadWorkspaceActivity(activity)).not.toBeNull();
  });

  it("does not resurrect elided rows from late events or an older history response", () => {
    const current = mergeWorkspaceActivity(null, { entries: history() })!;
    const late = mergeWorkspaceActivity(current, { entries: [row(20), row(90), row(500)] });
    expect(late).toEqual(current);
    expect(mergeWorkspaceActivity(current, { entries: history().slice(0, 500) })).toEqual(current);
    expect(mergeWorkspaceActivity(current, current)).toEqual(current);
  });

  it("advances the watermark exactly once across live updates and a newer full history", () => {
    const original = history();
    const current = mergeWorkspaceActivity(null, { entries: original })!;
    const live = mergeWorkspaceActivity(current, { entries: [row(601)] })!;
    expect(live.entries[0]).toMatchObject({ count: 90, throughSequence: 91 });
    const snapshot = mergeWorkspaceActivity(null, { entries: [...original, row(601)] })!;
    expect(mergeWorkspaceActivity(live, snapshot)).toEqual(live);
    expect(mergeWorkspaceActivity(snapshot, current)).toEqual(live);
  });

  it("retains a long-running action when it completes after the watermark", () => {
    const current = mergeWorkspaceActivity(null, { entries: history() })!;
    const completed = { ...row(1, "failed"), sequence: 700, command: { preview: "echo 1", exitCode: 1, stderrPreview: "failure" } };
    const next = mergeWorkspaceActivity(current, { entries: [completed, row(701)] })!;
    expect(next.entries.find((entry) => entry.id === "step:1")).toMatchObject({ firstSequence: 1, phase: "failed", command: { stderrPreview: "failure" } });
    expect(next.entries).toHaveLength(512);
  });

  it("bounds even active-only overflow without saying the removed actions completed", () => {
    const entries = compactWorkspaceActivityEntries(Array.from({ length: 600 }, (_, index) => row(index + 1, "running")));
    expect(entries).toHaveLength(512);
    expect(entries[0]).toMatchObject({ kind: "elided", count: 89, failedCount: 0, phase: "requested" });
    expect(entries.at(-1)?.id).toBe("step:600");
  });

  it("handles older unsequenced projections within the same memory bound", () => {
    const activity = mergeWorkspaceActivity(null, { entries: Array.from({ length: 600 }, (_, index) => ({ ...row(index + 1), sequence: undefined })) })!;
    expect(activity.entries).toHaveLength(512);
    expect(activity.entries.at(-1)?.id).toBe("step:600");
  });

  it("never downgrades an observed terminal command to running, while a plan may change", () => {
    expect(mergeWorkspaceActivityEntry(row(1, "failed"), { ...row(1, "running"), sequence: 2 }).phase).toBe("failed");
    const plan = { id: "plan", kind: "plan" as const, phase: "succeeded" as const, sequence: 1, items: [{ completed: true, text: "Read" }] };
    const next = { ...plan, phase: "running" as const, sequence: 2, items: [...plan.items, { completed: false, text: "Test" }] };
    expect(mergeWorkspaceActivityEntry(plan, next)).toMatchObject({ phase: "running", items: next.items });
  });
});
