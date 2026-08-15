import { describe, expect, it } from "vitest";
import {
  MEMORY_DELETION_ADMISSION_POLICY,
  MEMORY_DELETION_ADMISSION_POLICY_VERSION
} from "./capabilityPolicy";

describe("Memory deletion admission policy", () => {
  it("requires exact operational composition before either admission path opens", () => {
    expect(MEMORY_DELETION_ADMISSION_POLICY).toEqual({
      accountMemoryDeletion: {
        enabled: true,
        reason: "OPERATIONAL_COMPOSITION_REQUIRED"
      },
      permanentChatDeletion: {
        enabled: true,
        reason: "OPERATIONAL_COMPOSITION_REQUIRED"
      },
      policyVersion: MEMORY_DELETION_ADMISSION_POLICY_VERSION
    });
    expect(MEMORY_DELETION_ADMISSION_POLICY_VERSION)
      .toBe("memory-deletion-admission-policy-v1");
  });
});
