import { describe, expect, it } from "vitest";
import {
  decodeAdminMemoryAdmissionTimeoutInput,
  decodeAdminMemoryRebuildInput,
  decodeAdminMemoryStatusResponse
} from "./adminMemory";

function response() {
  return {
    memory: {
      admissionTimeout: { seconds: 15, version: 4 },
      activeIssueCode: null,
      configuredTargets: [
        { model: "Utility model", provider: "Primary provider" },
        { model: "Embedding model", provider: "Vector provider" }
      ],
      index: { generation: 3, readiness: "READY" },
      queue: { length: 0, oldestAgeSeconds: null },
      rebuild: { state: "NOT_REQUIRED" },
      worker: { state: "RUNNING" }
    }
  };
}

describe("administrator Memory status contract", () => {
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
    expect(decodeAdminMemoryStatusResponse({
      memory: {
        ...response().memory,
        queue: { length: 0, oldestAgeSeconds: 4 }
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

  it("does not present a historical issue as active when the queue is empty", () => {
    expect(decodeAdminMemoryStatusResponse({
      memory: {
        ...response().memory,
        activeIssueCode: "memory_job_handler_unavailable"
      }
    })).toBeNull();
  });
});
