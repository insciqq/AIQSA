import type { ModelToolCall } from "../../../tools/types";
import {
  MEMORY_FACT_CONSOLIDATION_OPERATIONS,
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
].sort();
const controlPattern = /[\u0000-\u001f\u007f]/u;
const operations = new Set<string>(MEMORY_FACT_CONSOLIDATION_OPERATIONS);
const consolidationReasons = new Set<string>(MEMORY_FACT_CONSOLIDATION_REASON_CODES);
const verificationReasons = new Set<string>(MEMORY_FACT_VERIFICATION_REASON_CODES);
const targetOperations = new Set<MemoryFactConsolidationOperation>([
  "REINFORCE",
  "SUPERSEDE",
  "CONFLICT",
  "EXPIRE"
]);
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
    fact.canonicalKey !== input.candidate.canonicalKey ||
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
  if (
    !calls || calls.length !== 1 ||
    calls[0]?.name !== MEMORY_FACT_VERIFICATION_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, verificationKeys)
  ) fail("memory_fact_verification_output_invalid");
  const args = calls[0].arguments;
  if (
    args.candidate_id !== input.candidate.id ||
    args.decision_id !== input.decision.id ||
    typeof args.verdict !== "string" ||
    !["APPROVE", "DEFER", "REJECT"].includes(args.verdict) ||
    typeof args.reason_code !== "string" ||
    !verificationReasons.has(args.reason_code) ||
    (args.verdict === "APPROVE" && args.reason_code !== "supported_transition") ||
    (args.verdict !== "APPROVE" && args.reason_code === "supported_transition")
  ) fail("memory_fact_verification_output_invalid");
  const withoutHash: Omit<MemoryFactVerificationPlan, "outputHash"> = {
    candidateId: input.candidate.id,
    decisionId: input.decision.id,
    reasonCode: args.reason_code as MemoryFactVerificationReasonCode,
    verdict: args.verdict as MemoryFactVerificationPlan["verdict"]
  };
  return {
    ...withoutHash,
    outputHash: memoryFactVerificationOutputHash(input, withoutHash)
  };
}
