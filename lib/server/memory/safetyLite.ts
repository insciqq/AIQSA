export const MEMORY_SAFETY_LITE_POLICY_VERSION = "memory-safety-lite-v1";

export const MEMORY_SAFETY_LITE_REASON_CODES = [
  "lite_non_secret_default",
  "lite_secret_only",
  "lite_span_redacted"
] as const;

export type MemorySafetyLiteReasonCode =
  (typeof MEMORY_SAFETY_LITE_REASON_CODES)[number];

export type MemorySafetyLiteFactClassification = Readonly<{
  safetyClassificationReasonCode: MemorySafetyLiteReasonCode;
  safetyClassificationState: "CLASSIFIED" | "SECRET_FENCED";
  safetyClassifiedAt: Date;
  safetyClassifierExecutionId: null;
  safetyClassifierModelId: null;
  safetyClassifierPolicyVersion: typeof MEMORY_SAFETY_LITE_POLICY_VERSION;
  safetyClassifierProviderId: null;
}>;

/** Synchronous classification for a projection that has already crossed the
 * local span-redaction boundary. It intentionally creates no model/provider
 * identity because Safety Lite is not a semantic model execution. */
export function memorySafetyLiteFactClassification(
  now: Date,
  reasonCode: MemorySafetyLiteReasonCode = "lite_non_secret_default"
): MemorySafetyLiteFactClassification {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("memory_safety_lite_timestamp_invalid");
  }
  return {
    safetyClassificationReasonCode: reasonCode,
    safetyClassificationState: reasonCode === "lite_secret_only"
      ? "SECRET_FENCED"
      : "CLASSIFIED",
    safetyClassifiedAt: now,
    safetyClassifierExecutionId: null,
    safetyClassifierModelId: null,
    safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
    safetyClassifierProviderId: null
  };
}

export function memorySafetyLiteReasonForRedaction(
  redacted: boolean
): MemorySafetyLiteReasonCode {
  return redacted ? "lite_span_redacted" : "lite_non_secret_default";
}
