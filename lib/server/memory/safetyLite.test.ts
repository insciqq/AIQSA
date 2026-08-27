import { describe, expect, it } from "vitest";
import {
  MEMORY_SAFETY_LITE_POLICY_VERSION,
  memorySafetyLiteFactClassification
} from "./safetyLite";

describe("Memory Safety Lite classification", () => {
  const now = new Date("2026-08-27T09:30:00.000Z");

  it.each([
    ["lite_non_secret_default", "CLASSIFIED"],
    ["lite_span_redacted", "CLASSIFIED"],
    ["lite_secret_only", "SECRET_FENCED"]
  ] as const)("maps %s to %s without semantic provider identity", (reason, state) => {
    expect(memorySafetyLiteFactClassification(now, reason)).toEqual({
      safetyClassificationReasonCode: reason,
      safetyClassificationState: state,
      safetyClassifiedAt: now,
      safetyClassifierExecutionId: null,
      safetyClassifierModelId: null,
      safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
      safetyClassifierProviderId: null
    });
  });

  it("rejects an invalid classification clock", () => {
    expect(() => memorySafetyLiteFactClassification(new Date(Number.NaN)))
      .toThrow("memory_safety_lite_timestamp_invalid");
  });
});
