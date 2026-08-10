import { describe, expect, it } from "vitest";
import {
  MEMORY_EGRESS_CONSENT_MODE_ENV,
  resolveMemoryEgressConsentMode
} from "./consentMode";
import { MemoryExecutionError } from "./errors";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  requireAcceptedMemoryUtilityPolicy,
  type ResolvedMemoryUtilityPolicy
} from "./policy";

describe("Memory egress consent mode", () => {
  it("defaults absent and blank installation policy to ADMIN", () => {
    expect(resolveMemoryEgressConsentMode({})).toBe("ADMIN");
    expect(resolveMemoryEgressConsentMode({
      [MEMORY_EGRESS_CONSENT_MODE_ENV]: "  "
    })).toBe("ADMIN");
  });

  it("accepts exact policy values and fails malformed overrides safely", () => {
    expect(resolveMemoryEgressConsentMode({
      [MEMORY_EGRESS_CONSENT_MODE_ENV]: "ADMIN"
    })).toBe("ADMIN");
    expect(resolveMemoryEgressConsentMode({
      [MEMORY_EGRESS_CONSENT_MODE_ENV]: "PER_USER"
    })).toBe("PER_USER");
    expect(resolveMemoryEgressConsentMode({
      [MEMORY_EGRESS_CONSENT_MODE_ENV]: "admin"
    })).toBe("PER_USER");
    expect(resolveMemoryEgressConsentMode({
      [MEMORY_EGRESS_CONSENT_MODE_ENV]: "unexpected-private-value"
    })).toBe("PER_USER");
  });

  it("keeps per-user acceptance machinery while ADMIN owns the default trust decision", () => {
    const policy: ResolvedMemoryUtilityPolicy = {
      destinations: [],
      fingerprint: "a".repeat(64),
      policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
      targets: new Map()
    };
    const unaccepted = {
      acceptedUtilityEgressAt: null,
      acceptedUtilityEgressFingerprint: null,
      acceptedUtilityPolicyVersion: null
    };

    expect(() => requireAcceptedMemoryUtilityPolicy(unaccepted, policy, "ADMIN"))
      .not.toThrow();
    expect(() => requireAcceptedMemoryUtilityPolicy(unaccepted, policy, "PER_USER"))
      .toThrowError(new MemoryExecutionError("memory_execution_egress_consent_required"));
    expect(() => requireAcceptedMemoryUtilityPolicy({
      acceptedUtilityEgressAt: new Date("2026-08-11T00:00:00.000Z"),
      acceptedUtilityEgressFingerprint: policy.fingerprint,
      acceptedUtilityPolicyVersion: policy.policyVersion
    }, policy, "PER_USER")).not.toThrow();
  });
});
