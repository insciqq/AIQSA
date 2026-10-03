import { describe, expect, it } from "vitest";
import { memorySha256 } from "../persistence/lexical";
import { isSupportedMemoryMaintenancePolicy, memoryMaintenanceOrdinal, memoryMaintenanceOrdinals, memoryMaintenancePlan,
  memoryMaintenancePlanHash, memoryMaintenanceReasonDisposition, MEMORY_MAINTENANCE_BLOCKED_REASONS,
  MEMORY_MAINTENANCE_CALL_ATTEMPTS, MEMORY_MAINTENANCE_POLICY_VERSION, MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS,
  MEMORY_MAINTENANCE_UNREVIEWABLE_REASONS, MEMORY_MAINTENANCE_VERSIONS, type MemoryMaintenanceSource } from "./policy";

const source: MemoryMaintenanceSource = {
  ref: "S1", factId: "fact-1", versionId: "version-1", statement: "Synthetic statement.", category: "other",
  modality: "STATE", confidence: 0.6, usefulness: null, observedAt: new Date("2026-09-01"),
  evidenceThrough: new Date("2026-09-01"), sourceSnapshotHash: "a".repeat(64), evidence: []
};

describe("versioned maintenance provenance", () => {
  it("retains accepted v1 and v2 removal authority without accepting arbitrary historical labels", () => {
    expect(MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS).toEqual([
      "memory-maintenance-policy-v1", "memory-maintenance-policy-v2", "memory-maintenance-policy-v3"
    ]);
    expect(MEMORY_MAINTENANCE_POLICY_VERSION).toBe("memory-maintenance-policy-v3");
    for (const supported of MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS) {
      expect(isSupportedMemoryMaintenancePolicy(supported)).toBe(true);
    }
    for (const unsupported of [null, "memory-maintenance-policy-v0", "memory-maintenance-policy-v4", ["memory-maintenance-policy-v1"]]) {
      expect(isSupportedMemoryMaintenancePolicy(unsupported)).toBe(false);
    }
  });
  it("re-keys staged receipts for the marked conservative keep without reopening review coverage", () => {
    // Coverage and plan identity follow the policy version; the request is unchanged, so only the schema moved.
    expect(MEMORY_MAINTENANCE_VERSIONS).toMatchObject({ policyVersion: "memory-maintenance-policy-v3",
      promptVersion: "memory-maintenance-prompt-v3", schemaVersion: "memory-maintenance-schema-v5" });
    expect(memoryMaintenancePlan([]).sourceSnapshotHash)
      .toBe(memorySha256({ policyVersion: "memory-maintenance-policy-v3", sources: [] }));
  });
  it("uses a new plan identity for v3 that is derivable from reviewed refs, versions and hashes alone", () => {
    const plan = memoryMaintenancePlan([]);
    const v2 = memorySha256({ policyVersion: "memory-maintenance-policy-v2", sources: [] });
    expect(plan.sourceSnapshotHash).not.toBe(v2);
    expect(memoryMaintenancePlan([]).sourceSnapshotHash).toBe(plan.sourceSnapshotHash);
    expect(memoryMaintenancePlanHash([{ ref: source.ref, versionId: source.versionId, sourceSnapshotHash: source.sourceSnapshotHash }]))
      .toBe(memoryMaintenancePlan([source]).sourceSnapshotHash);
  });
  it("maps every fixed reason code to exactly one non-final disposition", () => {
    expect(MEMORY_MAINTENANCE_BLOCKED_REASONS.map(memoryMaintenanceReasonDisposition)).toEqual(["BLOCKED", "BLOCKED", "BLOCKED"]);
    expect(MEMORY_MAINTENANCE_UNREVIEWABLE_REASONS.map(memoryMaintenanceReasonDisposition))
      .toEqual(["UNREVIEWABLE", "UNREVIEWABLE", "UNREVIEWABLE"]);
    expect(new Set([...MEMORY_MAINTENANCE_BLOCKED_REASONS, ...MEMORY_MAINTENANCE_UNREVIEWABLE_REASONS]).size).toBe(6);
    expect([...MEMORY_MAINTENANCE_BLOCKED_REASONS, ...MEMORY_MAINTENANCE_UNREVIEWABLE_REASONS]
      .every((reason) => reason.length <= 32 && /^[a-z_]+$/u.test(reason))).toBe(true);
  });
  it("gives every call attempt its own receipt ordinal within the database range, keeping the first ones of earlier releases", () => {
    expect(MEMORY_MAINTENANCE_CALL_ATTEMPTS).toBe(3);
    expect(memoryMaintenanceOrdinals("review")).toEqual([0, 2, 4]);
    expect(memoryMaintenanceOrdinals("verify")).toEqual([1, 3, 5]);
    expect([memoryMaintenanceOrdinal("review", 0), memoryMaintenanceOrdinal("verify", 0)]).toEqual([0, 1]);
    for (const attempt of [-1, 3, 1.5, Number.NaN]) {
      expect(() => memoryMaintenanceOrdinal("review", attempt)).toThrow("memory_maintenance_ordinal_invalid");
    }
  });
});
