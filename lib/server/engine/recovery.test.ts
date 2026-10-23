import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { NATIVE_RUN_INTERRUPTED, reconcileNativeRuns, type NativeOrphanRun, type NativeRecoveryDeps } from "./recovery";

const workspace = { enabled: true, sessionId: "session-1" };

function orphan(id: string, extra: Partial<NativeOrphanRun> = {}): NativeOrphanRun {
  return { answerCompletedAt: null, assistantMessageId: `answer-${id}`, chatId: "chat", id, normalizedRequest: { workspace },
    userId: "user", ...extra };
}

function deps(orphans: readonly NativeOrphanRun[], live: readonly string[] = []) {
  const value = {
    bootedAt: new Date("2026-10-23T00:00:00Z"),
    findOrphans: vi.fn(async () => orphans),
    liveRunIds: () => live,
    repository: { failRun: vi.fn(async () => true) },
    runs: { complete: vi.fn(async () => true) },
    workspace: { settle: vi.fn(async () => ({}) as never) }
  } satisfies NativeRecoveryDeps;
  return value;
}

describe("native run recovery", () => {
  it("ends a run no execution owns interrupted, its Workspace retired and its work kept", async () => {
    const recovery = deps([orphan("run-1")]);
    await expect(reconcileNativeRuns(recovery, { userId: "user" })).resolves.toBe(1);
    expect(recovery.findOrphans).toHaveBeenCalledWith(expect.objectContaining({ userId: "user" }));
    expect(recovery.workspace.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", runId: "run-1", workspace }));
    expect(recovery.repository.failRun).toHaveBeenCalledWith("run-1", "answer-run-1", NATIVE_RUN_INTERRUPTED, { recoveryTerminal: true });
  });

  it("completes a run whose answer was published before the process stopped", async () => {
    const recovery = deps([orphan("run-2", { answerCompletedAt: new Date() })]);
    await reconcileNativeRuns(recovery);
    expect(recovery.runs.complete).toHaveBeenCalledWith({ assistantMessageId: "answer-run-2", chatId: "chat", runId: "run-2", userId: "user" });
    expect(recovery.repository.failRun).not.toHaveBeenCalled();
  });

  it("leaves a run this process executes alone", async () => {
    const recovery = deps([orphan("run-3")], ["run-3"]);
    await expect(reconcileNativeRuns(recovery)).resolves.toBe(0);
    expect(recovery.repository.failRun).not.toHaveBeenCalled();
    expect(recovery.findOrphans).toHaveBeenCalledWith(expect.objectContaining({ liveRunIds: ["run-3"] }));
  });

  it("keeps going past a run it could not settle", async () => {
    const recovery = deps([orphan("run-4"), orphan("run-5")]);
    recovery.repository.failRun.mockRejectedValueOnce(new Error("database"));
    await expect(reconcileNativeRuns(recovery)).resolves.toBe(1);
  });

  it("records each terminal write it makes, which Admin Health counts as a run recovery failed", async () => {
    const observation = await captureRunObservation();
    const recovery = deps([orphan("run-6"), orphan("run-7"), orphan("run-8", { answerCompletedAt: new Date() })]);
    recovery.repository.failRun.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("database"));
    await reconcileNativeRuns(recovery);
    expect(observation.records().filter((record) => record.event === "job_persistence")
      .map((record) => [record.run_id, record.subsystem, record.stage, record.outcome])).toEqual([
      ["run-6", "run_recovery", "fail", "confirmed"], ["run-7", "run_recovery", "fail", "unconfirmed"],
      ["run-8", "run_recovery", "complete", "confirmed"]
    ]);
  });
});
