import type { ModelToolCall } from "../../../tools/types";
import {
  MEMORY_FACT_CONSOLIDATION_MODEL_OPERATIONS,
  MEMORY_FACT_CONSOLIDATION_REASON_CODES,
  MEMORY_FACT_VERIFICATION_REASON_CODES,
  memoryFactConsolidationOutputHash,
  memoryFactVerificationOutputHash,
  type MemoryFactConsolidationInput,
  type MemoryFactConsolidationOperation,
  type MemoryFactConsolidationPlan,
  type MemoryFactConsolidationReasonCode,
  type MemoryFactVerificationInput,
  type MemoryFactVerificationPlan,
  type MemoryFactVerificationReasonCode
} from "./contract";
import {
  MEMORY_FACT_CONSOLIDATION_TOOL_NAME,
  MEMORY_FACT_VERIFICATION_TOOL_NAME
} from "./prompt";

const consolidationKeys = [
  "candidate_id",
  "effective_from",
  "evidence_ids",
  "operation",
  "reason_code",
  "target_fact_id",
  "target_version_id"
].sort();
const verificationKeys = [
  "candidate_id",
  "decision_id",
  "reason_code",
  "verdict"
] as const;
const verificationKeySet = new Set<string>(verificationKeys);
const controlPattern = /[\u0000-\u001f\u007f]/u;
const operations = new Set<string>(MEMORY_FACT_CONSOLIDATION_MODEL_OPERATIONS);
const consolidationReasons = new Set<string>(MEMORY_FACT_CONSOLIDATION_REASON_CODES);
const verificationReasons = new Set<string>(MEMORY_FACT_VERIFICATION_REASON_CODES);
const targetOperations = new Set<MemoryFactConsolidationOperation>([
  "REINFORCE",
  "SUPERSEDE",
  "CONFLICT",
  "EXPIRE"
]);

export const MEMORY_FACT_VERIFICATION_OUTPUT_ISSUES = [
  "tool_call_missing",
  "tool_call_count_invalid",
  "tool_name_invalid",
  "arguments_invalid",
  "candidate_id_missing",
  "decision_id_missing",
  "reason_code_missing",
  "verdict_missing",
  "multiple_required_keys_missing",
  "arguments_unexpected_keys",
  "arguments_required_keys_missing_and_unexpected",
  "candidate_id_mismatch",
  "decision_id_mismatch",
  "verdict_invalid",
  "reason_code_invalid",
  "approve_reason_mismatch",
  "non_approve_reason_mismatch"
] as const;

export type MemoryFactVerificationOutputIssue =
  (typeof MEMORY_FACT_VERIFICATION_OUTPUT_ISSUES)[number];
export type MemoryFactVerificationArgumentKey = (typeof verificationKeys)[number];

export type MemoryFactVerificationOutputInspection = Readonly<
  | {
      issue: MemoryFactVerificationOutputIssue;
      missingRequiredKeys: readonly MemoryFactVerificationArgumentKey[];
      ok: false;
      plan: null;
      unexpectedKeyCount: number;
    }
  | {
      issue: null;
      missingRequiredKeys: readonly [];
      ok: true;
      plan: MemoryFactVerificationPlan;
      unexpectedKeyCount: 0;
    }
>;
const operationReason: Readonly<Record<
  MemoryFactConsolidationOperation,
  MemoryFactConsolidationReasonCode
>> = Object.freeze({
  ADD: "new_supported_fact",
  CONFLICT: "simultaneous_contradiction",
  DEFER: "insufficient_support",
  EXPIRE: "direct_end_evidence",
  NOOP: "duplicate_or_explicit",
  REINFORCE: "same_current_value",
  SUPERSEDE: "direct_newer_evidence"
});

export class MemoryFactConsolidationDecodeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryFactConsolidationDecodeError";
  }
}

function fail(code = "memory_fact_consolidation_output_invalid"): never {
  throw new MemoryFactConsolidationDecodeError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function exactString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" || !value || value.trim() !== value ||
    value.length > maxLength || controlPattern.test(value)
  ) fail();
  return value;
}

function nullableId(value: unknown): string | null {
  return value === null ? null : exactString(value, 256);
}

function canonicalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const text = exactString(value, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    fail("memory_fact_consolidation_temporal_invalid");
  }
  return parsed.toISOString();
}

function exactEvidenceIds(
  value: unknown,
  input: MemoryFactConsolidationInput
): string[] {
  if (!Array.isArray(value) || value.length !== input.candidate.evidence.length) fail();
  const expected = input.candidate.evidence.map((evidence) => evidence.messageId);
  const actual = value.map((entry) => exactString(entry, 256));
  if (
    new Set(actual).size !== actual.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) fail("memory_fact_consolidation_evidence_invalid");
  return actual;
}

function exactTarget(
  input: MemoryFactConsolidationInput,
  factId: string,
  versionId: string
): boolean {
  const fact = input.relatedFacts.find((candidate) => candidate.id === factId);
  if (
    !fact || fact.state !== "ACTIVE" || fact.currentVersionId !== versionId ||
    fact.scope.type !== input.candidate.scope.type ||
    fact.scope.targetId !== input.candidate.scope.targetId
  ) return false;
  return fact.versions.some((version) =>
    version.id === versionId && version.state === "ACTIVE");
}

export function decodeMemoryFactConsolidation(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactConsolidationInput
): MemoryFactConsolidationPlan {
  if (
    !calls || calls.length !== 1 ||
    calls[0]?.name !== MEMORY_FACT_CONSOLIDATION_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, consolidationKeys)
  ) fail();
  const args = calls[0].arguments;
  if (args.candidate_id !== input.candidate.id) fail();
  if (typeof args.operation !== "string" || !operations.has(args.operation)) fail();
  const operation = args.operation as MemoryFactConsolidationOperation;
  if (
    typeof args.reason_code !== "string" ||
    !consolidationReasons.has(args.reason_code) ||
    args.reason_code !== operationReason[operation]
  ) fail();
  const reasonCode = args.reason_code as MemoryFactConsolidationReasonCode;
  const targetFactId = nullableId(args.target_fact_id);
  const targetVersionId = nullableId(args.target_version_id);
  if (targetOperations.has(operation)) {
    if (
      !targetFactId || !targetVersionId ||
      !exactTarget(input, targetFactId, targetVersionId)
    ) fail("memory_fact_consolidation_target_invalid");
  } else if (targetFactId !== null || targetVersionId !== null) {
    fail("memory_fact_consolidation_target_invalid");
  }
  const effectiveFrom = canonicalTimestamp(args.effective_from);
  if (
    (operation !== "SUPERSEDE" && effectiveFrom !== null) ||
    (operation === "SUPERSEDE" && effectiveFrom !== input.candidate.validFrom)
  ) fail("memory_fact_consolidation_temporal_invalid");
  const withoutHash: Omit<MemoryFactConsolidationPlan, "outputHash"> = {
    candidateId: input.candidate.id,
    effectiveFrom,
    evidenceIds: exactEvidenceIds(args.evidence_ids, input),
    operation,
    reasonCode,
    targetFactId,
    targetVersionId
  };
  return {
    ...withoutHash,
    outputHash: memoryFactConsolidationOutputHash(input, withoutHash)
  };
}

export function decodeMemoryFactVerification(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactVerificationInput
): MemoryFactVerificationPlan {
  const inspected = inspectMemoryFactVerificationOutput(calls, input);
  if (!inspected.ok) fail("memory_fact_verification_output_invalid");
  return inspected.plan;
}

/**
 * Produces a bounded, content-free runtime diagnostic.
 * Runtime decoding deliberately retains one public failure code so model output
 * details never become durable execution errors or logs.
 */
export function inspectMemoryFactVerificationOutput(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryFactVerificationInput
): MemoryFactVerificationOutputInspection {
  const invalid = (
    issue: MemoryFactVerificationOutputIssue,
    missingRequiredKeys: readonly MemoryFactVerificationArgumentKey[] = [],
    unexpectedKeyCount = 0
  ): MemoryFactVerificationOutputInspection => ({
    issue,
    missingRequiredKeys,
    ok: false,
    plan: null,
    unexpectedKeyCount
  });
  if (!calls || calls.length === 0) return invalid("tool_call_missing");
  if (calls.length !== 1) return invalid("tool_call_count_invalid");
  const call = calls[0]!;
  if (call.name !== MEMORY_FACT_VERIFICATION_TOOL_NAME) {
    return invalid("tool_name_invalid");
  }
  if (!isRecord(call.arguments)) return invalid("arguments_invalid");
  if (!hasExactKeys(call.arguments, verificationKeys)) {
    const actualKeys = new Set(Object.keys(call.arguments));
    const missingRequiredKeys = verificationKeys.filter((key) => !actualKeys.has(key));
    const unexpectedKeyCount = [...actualKeys]
      .filter((key) => !verificationKeySet.has(key)).length;
    if (missingRequiredKeys.length > 0 && unexpectedKeyCount > 0) {
      return invalid(
        "arguments_required_keys_missing_and_unexpected",
        missingRequiredKeys,
        unexpectedKeyCount
      );
    }
    if (missingRequiredKeys.length > 1) {
      return invalid("multiple_required_keys_missing", missingRequiredKeys);
    }
    if (missingRequiredKeys[0] === "candidate_id") {
      return invalid("candidate_id_missing", missingRequiredKeys);
    }
    if (missingRequiredKeys[0] === "decision_id") {
      return invalid("decision_id_missing", missingRequiredKeys);
    }
    if (missingRequiredKeys[0] === "reason_code") {
      return invalid("reason_code_missing", missingRequiredKeys);
    }
    if (missingRequiredKeys[0] === "verdict") {
      return invalid("verdict_missing", missingRequiredKeys);
    }
    return invalid("arguments_unexpected_keys", [], unexpectedKeyCount);
  }
  const args = call.arguments;
  if (args.candidate_id !== input.candidate.id) {
    return invalid("candidate_id_mismatch");
  }
  if (args.decision_id !== input.decision.id) {
    return invalid("decision_id_mismatch");
  }
  if (
    typeof args.verdict !== "string" ||
    !["APPROVE", "DEFER", "REJECT"].includes(args.verdict)
  ) return invalid("verdict_invalid");
  if (
    typeof args.reason_code !== "string" ||
    !verificationReasons.has(args.reason_code)
  ) return invalid("reason_code_invalid");
  if (args.verdict === "APPROVE" && args.reason_code !== "supported_transition") {
    return invalid("approve_reason_mismatch");
  }
  if (args.verdict !== "APPROVE" && args.reason_code === "supported_transition") {
    return invalid("non_approve_reason_mismatch");
  }
  const withoutHash: Omit<MemoryFactVerificationPlan, "outputHash"> = {
    candidateId: input.candidate.id,
    decisionId: input.decision.id,
    reasonCode: args.reason_code as MemoryFactVerificationReasonCode,
    verdict: args.verdict as MemoryFactVerificationPlan["verdict"]
  };
  return {
    issue: null,
    missingRequiredKeys: [],
    ok: true,
    plan: {
      ...withoutHash,
      outputHash: memoryFactVerificationOutputHash(input, withoutHash)
    },
    unexpectedKeyCount: 0
  };
}
