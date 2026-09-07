import { isKnowledgeSelectorValidationFailureReason, type KnowledgeSelectorValidationFailureReason } from "./answerGroundingV5";

const reasons = ["invalid_output", "timeout", "refusal", "transport", "provider_error"] as const;
type FailureReason = typeof reasons[number];
export type KnowledgeContributionOperationFailureV1 = Readonly<{
  kind: "contribution_operation_failed";
  reason: FailureReason;
  validationReason?: KnowledgeSelectorValidationFailureReason;
  version: 1;
}>;

/** Accepted recovery/repair state contains only closed codes, never a rejected
 * provider payload. Older three-field failure records retain their meaning. */
export function knowledgeContributionOperationFailureV1(
  reason: FailureReason,
  validationReason?: KnowledgeSelectorValidationFailureReason
): KnowledgeContributionOperationFailureV1 {
  if (!reasons.includes(reason) || validationReason !== undefined &&
    (reason !== "invalid_output" || !isKnowledgeSelectorValidationFailureReason(validationReason))) {
    throw new Error("knowledge_contribution_failure_invalid");
  }
  return Object.freeze({ kind: "contribution_operation_failed", reason,
    ...(validationReason === undefined ? {} : { validationReason }), version: 1 });
}

export function decodeKnowledgeContributionOperationFailureV1(value: unknown): KnowledgeContributionOperationFailureV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const keys = ["kind", "reason", "version", ...(Object.hasOwn(fields, "validationReason") ? ["validationReason"] : [])];
  if (Object.keys(fields).length !== keys.length || keys.some((key) => !Object.hasOwn(fields, key)) ||
    fields.kind !== "contribution_operation_failed" || fields.version !== 1 || !reasons.includes(fields.reason as FailureReason) ||
    Object.hasOwn(fields, "validationReason") && (fields.reason !== "invalid_output" || !isKnowledgeSelectorValidationFailureReason(fields.validationReason))) return null;
  return knowledgeContributionOperationFailureV1(fields.reason as FailureReason,
    fields.validationReason as KnowledgeSelectorValidationFailureReason | undefined);
}
