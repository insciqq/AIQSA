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

describe("terminal execution receipts", () => {
  const receipt = (phase: "closed" | "unknown", sequence = 10): ThreadWorkspaceActivityEntry =>
    ({ id: "execution_status:run", kind: "execution_status", phase, sequence });
  it("closes unpolled commands without exit success, keeps observed failure and excludes exports and plan claims", () => {
    const active = row(1, "running");
    const failed = { ...row(2, "failed"), command: { preview: "exit 17", exitCode: 17 } };
    const entries: ThreadWorkspaceActivityEntry[] = [active, failed,
      { id: "export", kind: "outputs_export", phase: "running", sequence: 3 },
      { id: "plan", kind: "plan", phase: "running", sequence: 4, items: [{ text: "Finish", completed: false }] }, receipt("closed")];
    const activity = mergeWorkspaceActivity(null, { entries })!;
    expect(activity.entries[0]).toMatchObject({ phase: "closed", command: { preview: "echo 1" } });
    expect(activity.entries[0]?.command?.exitCode).toBeUndefined();
    expect(activity.entries[1]).toMatchObject({ phase: "failed", command: { exitCode: 17 } });
    expect(activity.entries[2]?.phase).toBe("running");
    expect(activity.entries[3]).toMatchObject({ phase: "unknown", items: [{ completed: false }] });
    expect(decodeThreadWorkspaceActivity(activity)).toEqual(activity);
    expect(mergeWorkspaceActivity(activity, { entries: [active, receipt("unknown", 11)] })?.entries[0]?.phase).toBe("closed");
    const observed = { ...active, phase: "failed" as const, command: { preview: "echo 1", exitCode: 17 }, sequence: 12 };
    expect(mergeWorkspaceActivity(activity, { entries: [observed] })?.entries[0]).toMatchObject({ phase: "failed", command: { exitCode: 17 } });
  });

  it("upgrades unknown cessation and keeps a fresh run independent", () => {
    const unknown = mergeWorkspaceActivity(null, { entries: [row(1, "running"), receipt("unknown")] });
    expect(unknown?.entries[0]?.phase).toBe("unknown");
    expect(mergeWorkspaceActivity(unknown, { entries: [receipt("closed", 11)] })?.entries[0]?.phase).toBe("closed");
    expect(mergeWorkspaceActivity(null, { entries: [row(1, "running")] })?.entries[0]?.phase).toBe("running");
  });

  it("retains a versioned export failure over old GET, accepts newer retry then complete", () => {
    const failed = { entries: [], outputStatus: { state: "failed" as const, revision: "2026-09-24T10:00:02.000Z" } };
    const pending = { entries: [], outputStatus: { state: "retrying" as const, revision: "2026-09-24T10:00:01.000Z" } };
    expect(mergeWorkspaceActivity(failed, pending)?.outputStatus).toEqual(failed.outputStatus);
    expect(mergeWorkspaceActivity(pending, failed)?.outputStatus).toEqual(failed.outputStatus);
    expect(mergeWorkspaceActivity(failed, { entries: [], outputStatus: { state: "exporting" } })?.outputStatus).toEqual(failed.outputStatus);
    const retry = { ...pending, outputStatus: { ...pending.outputStatus, revision: "2026-09-24T10:00:03.000Z" } };
    expect(mergeWorkspaceActivity(failed, retry)?.outputStatus).toEqual(retry.outputStatus);
    const complete = { entries: [], outputStatus: { state: "complete" as const } };
    expect(mergeWorkspaceActivity(complete, failed)?.outputStatus?.state).toBe("complete");
  });
});

it("does not preserve an old run-outcome guess as an observed process failure", () => {
  const guessed = { ...row(1, "cancelled"), runOutcome: "cancelled" as const };
  const merged = mergeWorkspaceActivity({ entries: [guessed] }, { entries: [
    { id: "receipt", kind: "execution_status", phase: "closed", sequence: 2 }
  ] });
  expect(merged?.entries[0]?.phase).toBe("closed");
  expect(merged?.entries[0]?.runOutcome).toBeUndefined();
});

it("retains a retirement receipt when the incoming snapshot fills the activity bound", () => {
  const active = Array.from({ length: 512 }, (_, index) => row(index + 1, "running"));
  const activity = mergeWorkspaceActivity({ entries: active }, { entries: [
    { id: "receipt", kind: "execution_status", phase: "closed", sequence: 513 }
  ] })!;
  expect(activity.entries).toHaveLength(512);
  expect(activity.entries.some(entry => entry.kind === "execution_status")).toBe(true);
  expect(activity.entries.some(entry => entry.kind === "command" && entry.phase === "running")).toBe(false);
});

it("advances expiry projection at the same binding revision without restoring an older exporting state", () => {
  const revision = "2026-09-24T10:00:02.000Z";
  const exporting = { entries: [], outputStatus: { state: "exporting" as const, revision } };
  const failed = { entries: [], outputStatus: { state: "failed" as const, revision } };
  expect(mergeWorkspaceActivity(exporting, failed)?.outputStatus).toEqual(failed.outputStatus);
  expect(mergeWorkspaceActivity(failed, exporting)?.outputStatus).toEqual(failed.outputStatus);
});

it("does not let a legacy guessed failure erase independently confirmed row closure", () => {
  const closed = { ...row(1, "closed"), sequence: 2 };
  const staleGuess = { ...row(1, "cancelled"), sequence: 3, runOutcome: "cancelled" as const };
  const activity = mergeWorkspaceActivity({ entries: [closed] }, { entries: [staleGuess] })!;
  expect(activity.entries[0]?.phase).toBe("closed");
  expect(activity.entries[0]?.runOutcome).toBeUndefined();
  expect(decodeThreadWorkspaceActivity(activity)).toEqual(activity);
});
