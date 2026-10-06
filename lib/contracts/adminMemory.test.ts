import { memoryRecoveryStatusFixture, memoryWorkerStatusFixture } from "@/tests/support/memoryStatus";
import { describe, expect, it } from "vitest";
import {
  ADMIN_MEMORY_RECENT_ACTIVITY_STAGES,
  decodeAdminMemorySearchTimeoutInput,
  decodeAdminMemoryActionInput,
  decodeAdminMemoryRebuildInput,
  decodeAdminMemoryStatusResponse
} from "./adminMemory";

function response() {
  return {
    memory: {
      searchTimeout: { seconds: 15, version: 4 },
      processing: { enabled: true, issues: [] },
      configuredTargets: [
        { model: "Utility model", provider: "Primary provider" },
        { model: "Embedding model", provider: "Vector provider" }
      ],
      index: { generation: 3, readiness: "READY" },
      queue: { inProgress: 0, length: 0, oldestAgeSeconds: null },
      rebuild: { state: "NOT_REQUIRED" },
      recovery: memoryRecoveryStatusFixture(),
      worker: memoryWorkerStatusFixture()
    }
  };
}

describe("administrator Memory status contract", () => {
  it("rejects inconsistent worker and recovery evidence or private recovery targets", () => {
    const memory = response().memory;
    for (const worker of [
      memoryWorkerStatusFixture({ state: "RUNNING", reason: "NOT_READY" }),
      memoryWorkerStatusFixture({ state: "STALLED", reason: "IDLE" }),
      memoryWorkerStatusFixture({ lastSuccessAgeSeconds: -1 })
    ]) expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, worker } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      recovery: memoryRecoveryStatusFixture({ scheduled: 1 }) } })).toBeNull();
    expect(decodeAdminMemoryActionInput({ action: "RECOVER_ELIGIBLE" })).toEqual({ action: "RECOVER_ELIGIBLE" });
    expect(decodeAdminMemoryActionInput({ action: "RECOVER_ELIGIBLE", jobId: "private" })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      recovery: { ...memoryRecoveryStatusFixture(), errorMessage: "private" } } })).toBeNull();
  });

  it("accepts only the minimal operational projection", () => {
    expect(decodeAdminMemoryStatusResponse(response())).toEqual(response());
    expect(decodeAdminMemoryStatusResponse({ memory: {
      ...response().memory,
      admissionTimeout: { seconds: 15, version: 4 }
    } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({
      ...response(),
      memoryEgress: { currentFingerprint: "a".repeat(64) }
    })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({
      memory: { ...response().memory, destinationMatrix: [] }
    })).toBeNull();
  });

  it("accepts recent command/search/preparation issues only as stages, never as worker stages", () => {
    const memory = response().memory;
    const issues = [
      { stage: "COMMAND", reason: "COMMAND_FAILED", severity: "warn", count: 1, oldestAgeSeconds: 60 },
      { stage: "SEARCH", reason: "SEARCH_DEGRADED", severity: "warn", count: 2, oldestAgeSeconds: 600 },
      { stage: "PREPARATION", reason: "PREPARATION_SKIPPED", severity: "warn", count: 3, oldestAgeSeconds: 900 },
      { stage: "PREPARATION", reason: "PREPARATION_FAILED", severity: "warn", count: 1, oldestAgeSeconds: 30 }
    ];
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, processing: { enabled: true, issues } } }))
      .toEqual({ memory: { ...memory, processing: { enabled: true, issues } } });
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, processing: { enabled: true,
      issues: [{ ...issues[0], errorCode: "memory_command_failed" }] } } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      worker: memoryWorkerStatusFixture({ activeStages: ["COMMAND"] as never }) } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      worker: memoryWorkerStatusFixture({ activeStages: ["PREPARATION"] as never }) } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, processing: { enabled: true,
      issues: [{ ...issues[2], degradationCode: "memory_preparation_skipped" }] } } })).toBeNull();
  });

  it("bounds the issue list by every distinct stage and reason combination", () => {
    const memory = response().memory;
    const stages = ["LEARNING", "HISTORY", "INDEXING", "MAINTENANCE", "DELETION", ...ADMIN_MEMORY_RECENT_ACTIVITY_STAGES];
    const reasons = ["MODEL_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "CONFIGURATION_REQUIRED", "PROCESSING_FAILED",
      "RETRYING", "STALLED", "COMMAND_FAILED", "COMMAND_UNKNOWN",
      "SEARCH_DEGRADED", "SEARCH_FAILED", "PREPARATION_SKIPPED", "PREPARATION_FAILED"];
    const issues = stages.flatMap((stage) => reasons.map((reason) => ({
      stage, reason, severity: "warn", count: 1, oldestAgeSeconds: 1
    })));
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, processing: { enabled: true, issues } } }))
      .not.toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, processing: { enabled: true,
      issues: [...issues, { ...issues[0], stage: "OTHER" }] } } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, processing: { enabled: true,
      issues: [{ ...issues[0], reason: "HISTORY_INCOMPLETE" }] } } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory, processing: { enabled: true,
      issues: [{ ...issues[0], autoHeal: "RETRYING" }] } } })).toBeNull();
  });

  it("reports maintenance under its own stage and has no retired synthesis stage", () => {
    const memory = response().memory;
    const maintenance = { stage: "MAINTENANCE", reason: "PROCESSING_FAILED", severity: "bad",
      count: 1, oldestAgeSeconds: 60 };
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      processing: { enabled: true, issues: [maintenance] } } })).not.toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      processing: { enabled: true, issues: [{ ...maintenance, stage: "SYNTHESIS" }] } } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      worker: memoryWorkerStatusFixture({ activeStages: ["SYNTHESIS"] as never }) } })).toBeNull();
  });

  it("keeps queue age and rebuild readiness internally consistent", () => {
    expect(decodeAdminMemoryStatusResponse({ memory: {
      ...response().memory, queue: { inProgress: 2, length: 0, oldestAgeSeconds: null }
    } })).not.toBeNull();
    expect(decodeAdminMemoryStatusResponse({
      memory: {
        ...response().memory,
        queue: { inProgress: 0, length: 0, oldestAgeSeconds: 4 }
      }
    })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({
      memory: {
        ...response().memory,
        index: { generation: "MIXED", readiness: "REBUILDING" },
        rebuild: { state: "IN_PROGRESS" }
      }
    })).not.toBeNull();
  });

  it("accepts one bounded rebuild command", () => {
    expect(decodeAdminMemoryRebuildInput({ action: "REBUILD_REQUIRED" }))
      .toEqual({ action: "REBUILD_REQUIRED" });
    expect(decodeAdminMemoryRebuildInput({ action: "REEMBED", userId: "private" }))
      .toBeNull();
  });

  it("accepts a bounded optimistic timeout update", () => {
    expect(decodeAdminMemorySearchTimeoutInput({ expectedVersion: 4, timeoutSeconds: 1 }))
      .toEqual({ expectedVersion: 4, timeoutSeconds: 1 });
    expect(decodeAdminMemorySearchTimeoutInput({
      expectedVersion: 4,
      timeoutSeconds: 30
    })).toEqual({ expectedVersion: 4, timeoutSeconds: 30 });
    expect(decodeAdminMemorySearchTimeoutInput({ expectedVersion: 4, timeoutSeconds: 120 }))
      .toEqual({ expectedVersion: 4, timeoutSeconds: 120 });
    expect(decodeAdminMemorySearchTimeoutInput({ expectedVersion: 4, timeoutSeconds: 0 })).toBeNull();
    expect(decodeAdminMemorySearchTimeoutInput({
      expectedVersion: 4,
      timeoutSeconds: 121
    })).toBeNull();
  });

  it("rejects raw errors and accepts a bounded unresolved failure outside the queue", () => {
    expect(decodeAdminMemoryStatusResponse({
      memory: {
        ...response().memory,
        activeIssueCode: "memory_job_handler_unavailable"
      }
    })).toBeNull();
    const issue = { stage: "LEARNING", reason: "PROCESSING_FAILED", severity: "bad", count: 1, oldestAgeSeconds: 120 };
    const memory = { ...response().memory, processing: { enabled: true, issues: [issue] } };
    expect(decodeAdminMemoryStatusResponse({ memory })).not.toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      processing: { enabled: true, issues: [{ ...issue, reason: "private-provider-body" }] }
    } })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({ memory: { ...memory,
      processing: { enabled: true, issues: [{ ...issue, userId: "private-owner" }] }
    } })).toBeNull();
  });

  it("accepts distinct causes in one stage, but rejects duplicate issues", () => {
    const issue = { stage: "HISTORY", reason: "PROCESSING_FAILED", severity: "bad", count: 1, oldestAgeSeconds: 120 };
    const retrying = { ...issue, reason: "RETRYING", severity: "warn" };
    const decode = (issues: unknown[]) => decodeAdminMemoryStatusResponse({ memory: {
      ...response().memory, processing: { enabled: true, issues }
    } });
    expect(decode([issue, retrying])).not.toBeNull();
    expect(decode([issue, { ...issue, count: 2 }])).toBeNull();
    expect(decode([retrying, { ...retrying, oldestAgeSeconds: 60 }])).toBeNull();
  });
});
