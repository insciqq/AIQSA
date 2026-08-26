import { describe, expect, it, vi } from "vitest";
import { loadMemoryRunPresentationStatuses } from "./runProjection";

describe("loadMemoryRunPresentationStatuses", () => {
  it("distinguishes limited Memory use from a failed-safe unavailable receipt", async () => {
    const findRuns = vi.fn(async () => [
      { id: "run-failed" },
      { id: "run-used" },
      { id: "run-degraded" }
    ]);
    const findMany = vi.fn(async () => [
      Object.assign({ modelRunId: "run-failed" }, {
        degradationCode: "private-code",
        outcome: "FAILED_SAFE",
        retrievalAttemptId: "private-attempt-id"
      }),
      { modelRunId: "run-degraded", outcome: "DEGRADED" }
    ]);

    const statuses = await loadMemoryRunPresentationStatuses({
      modelRun: { findMany: findRuns },
      modelRunMemoryBinding: { findMany }
    } as never, {
      runIds: ["run-failed", "run-used", "run-degraded", "run-failed"],
      userId: "user-1"
    });

    expect(findRuns).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        chat: {
          memoryMode: { not: "TEMPORARY" },
          projectId: null
        },
        id: { in: ["run-failed", "run-used", "run-degraded"] },
        userId: "user-1"
      }
    });
    expect(findMany).toHaveBeenCalledWith({
      select: { modelRunId: true, outcome: true },
      where: {
        modelRunId: { in: ["run-failed", "run-used", "run-degraded"] },
        outcome: { in: ["DEGRADED", "FAILED_SAFE"] },
        userId: "user-1"
      }
    });
    expect([...statuses]).toEqual([
      ["run-failed", "UNAVAILABLE"],
      ["run-degraded", "LIMITED"]
    ]);
    expect(JSON.stringify([...statuses])).not.toContain("private-");
  });

  it("does not query for Temporary, Project, or other paths with no personal run ids", async () => {
    const findRuns = vi.fn();
    const findMany = vi.fn();
    await expect(loadMemoryRunPresentationStatuses({
      modelRun: { findMany: findRuns },
      modelRunMemoryBinding: { findMany }
    } as never, {
      runIds: [],
      userId: "user-1"
    })).resolves.toEqual(new Map());
    expect(findRuns).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not project legacy receipts for Project or Temporary runs", async () => {
    const findMany = vi.fn();
    const statuses = await loadMemoryRunPresentationStatuses({
      modelRun: { findMany: vi.fn(async () => []) },
      modelRunMemoryBinding: { findMany }
    } as never, {
      runIds: ["project-run", "temporary-run"],
      userId: "user-1"
    });

    expect(statuses).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not project a warning for used, empty, or disabled receipts", async () => {
    const statuses = await loadMemoryRunPresentationStatuses({
      modelRun: {
        findMany: vi.fn(async () => [
          { id: "run-used" },
          { id: "run-empty" },
          { id: "run-disabled" }
        ])
      },
      modelRunMemoryBinding: { findMany: vi.fn(async () => []) }
    } as never, {
      runIds: ["run-used", "run-empty", "run-disabled"],
      userId: "user-1"
    });

    expect(statuses).toEqual(new Map());
  });
});
