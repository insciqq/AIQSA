import { memoryRecoveryStatusFixture, memoryWorkerStatusFixture } from "@/tests/support/memoryStatus";
import { describe, expect, it } from "vitest";
import {
  decodeAdminMemoryAdmissionTimeoutInput,
  decodeAdminMemoryActionInput,
  decodeAdminMemoryRebuildInput,
  decodeAdminMemoryStatusResponse
} from "./adminMemory";

function response() {
  return {
    memory: {
      admissionTimeout: { seconds: 15, version: 4 },
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
    expect(decodeAdminMemoryStatusResponse({
      ...response(),
      memoryEgress: { currentFingerprint: "a".repeat(64) }
    })).toBeNull();
    expect(decodeAdminMemoryStatusResponse({
      memory: { ...response().memory, destinationMatrix: [] }
    })).toBeNull();
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
    expect(decodeAdminMemoryAdmissionTimeoutInput({
      expectedVersion: 4,
      timeoutSeconds: 30
    })).toEqual({ expectedVersion: 4, timeoutSeconds: 30 });
    expect(decodeAdminMemoryAdmissionTimeoutInput({
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

  it("accepts distinct causes and healing states in one stage, but rejects duplicate issues", () => {
    const issue = { stage: "HISTORY", reason: "PROCESSING_FAILED", severity: "bad", count: 1, oldestAgeSeconds: 120 };
    const incomplete = { ...issue, reason: "HISTORY_INCOMPLETE", severity: "warn", autoHeal: "UNAVAILABLE" };
    const decode = (issues: unknown[]) => decodeAdminMemoryStatusResponse({ memory: {
      ...response().memory, processing: { enabled: true, issues }
    } });
    expect(decode([issue, incomplete, { ...incomplete, autoHeal: "RETRYING" }])).not.toBeNull();
    expect(decode([issue, { ...issue, count: 2 }])).toBeNull();
    expect(decode([incomplete, { ...incomplete, oldestAgeSeconds: 60 }])).toBeNull();
  });
});
