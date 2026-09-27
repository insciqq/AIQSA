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
        retrievalAttemptId: "private-attempt-failed"
      }),
      { modelRunId: "run-used", outcome: "USED", retrievalAttemptId: "private-attempt-used" },
      {
        modelRunId: "run-degraded",
        outcome: "DEGRADED",
        retrievalAttemptId: "private-attempt-degraded"
      }
    ]);
    const findAttempts = vi.fn(async () => []);

    const statuses = await loadMemoryRunPresentationStatuses({
      memoryRetrievalAttempt: { findMany: findAttempts },
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
      select: { modelRunId: true, outcome: true, retrievalAttemptId: true },
      where: {
        modelRunId: { in: ["run-failed", "run-used", "run-degraded"] },
        userId: "user-1"
      }
    });
    expect(findAttempts).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        budgetSnapshot: { equals: true, path: ["memoryInputTooLong"] },
        id: {
          in: ["private-attempt-failed", "private-attempt-used", "private-attempt-degraded"]
        },
        userId: "user-1"
      }
    });
    expect([...statuses]).toEqual([
      ["run-failed", "UNAVAILABLE"],
      ["run-degraded", "LIMITED"]
    ]);
    expect(JSON.stringify([...statuses])).not.toContain("private-");
  });

  it("reports a turn Memory could not process in full as too long for every outcome", async () => {
    const statuses = await loadMemoryRunPresentationStatuses({
      memoryRetrievalAttempt: {
        findMany: vi.fn(async () => [
          { id: "attempt-used" },
          { id: "attempt-empty" },
          { id: "attempt-failed" }
        ])
      },
      modelRun: {
        findMany: vi.fn(async () => [
          { id: "run-used" },
          { id: "run-empty" },
          { id: "run-failed" },
          { id: "run-ordinary" }
        ])
      },
      modelRunMemoryBinding: {
        findMany: vi.fn(async () => [
          { modelRunId: "run-used", outcome: "USED", retrievalAttemptId: "attempt-used" },
          { modelRunId: "run-empty", outcome: "EMPTY", retrievalAttemptId: "attempt-empty" },
          {
            modelRunId: "run-failed",
            outcome: "FAILED_SAFE",
            retrievalAttemptId: "attempt-failed"
          },
          {
            modelRunId: "run-ordinary",
            outcome: "EMPTY",
            retrievalAttemptId: "attempt-ordinary"
          }
        ])
      }
    } as never, {
      runIds: ["run-used", "run-empty", "run-failed", "run-ordinary"],
      userId: "user-1"
    });

    expect([...statuses]).toEqual([
      ["run-used", "INPUT_TOO_LONG"],
      ["run-empty", "INPUT_TOO_LONG"],
      ["run-failed", "INPUT_TOO_LONG"]
    ]);
  });

  it("does not query for Temporary, Project, or other paths with no personal run ids", async () => {
    const findRuns = vi.fn();
    const findMany = vi.fn();
    await expect(loadMemoryRunPresentationStatuses({
      memoryRetrievalAttempt: { findMany: vi.fn() },
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
      memoryRetrievalAttempt: { findMany: vi.fn() },
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
    const findAttempts = vi.fn(async () => []);
    const statuses = await loadMemoryRunPresentationStatuses({
      memoryRetrievalAttempt: { findMany: findAttempts },
      modelRun: {
        findMany: vi.fn(async () => [
          { id: "run-used" },
          { id: "run-empty" },
          { id: "run-disabled" }
        ])
      },
      modelRunMemoryBinding: {
        findMany: vi.fn(async () => [
          { modelRunId: "run-used", outcome: "USED", retrievalAttemptId: "attempt-used" },
          { modelRunId: "run-empty", outcome: "EMPTY", retrievalAttemptId: "attempt-empty" }
        ])
      }
    } as never, {
      runIds: ["run-used", "run-empty", "run-disabled"],
      userId: "user-1"
    });

    expect(statuses).toEqual(new Map());
    expect(findAttempts).toHaveBeenCalledOnce();
  });
});
