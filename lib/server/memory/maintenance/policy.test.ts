import { describe, expect, it } from "vitest";
import { memorySha256 } from "../persistence/lexical";
import { isSupportedMemoryMaintenancePolicy, memoryMaintenancePlan, MEMORY_MAINTENANCE_POLICY_VERSION,
  MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS } from "./policy";

describe("versioned maintenance provenance", () => {
  it("retains accepted v1 removal authority without accepting arbitrary historical labels", () => {
    expect(MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS).toEqual(["memory-maintenance-policy-v1", "memory-maintenance-policy-v2"]);
    expect(isSupportedMemoryMaintenancePolicy("memory-maintenance-policy-v1")).toBe(true);
    expect(isSupportedMemoryMaintenancePolicy(MEMORY_MAINTENANCE_POLICY_VERSION)).toBe(true);
    for (const unsupported of [null, "memory-maintenance-policy-v0", "memory-maintenance-policy-v3", ["memory-maintenance-policy-v1"]]) {
      expect(isSupportedMemoryMaintenancePolicy(unsupported)).toBe(false);
    }
  });
  it("uses a new plan identity for v2 while keeping unchanged v2 work idempotent", () => {
    const plan = memoryMaintenancePlan([]);
    const v1 = memorySha256({ policyVersion: "memory-maintenance-policy-v1", sources: [] });
    expect(plan.sourceSnapshotHash).not.toBe(v1);
    expect(memoryMaintenancePlan([]).sourceSnapshotHash).toBe(plan.sourceSnapshotHash);
  });
});
