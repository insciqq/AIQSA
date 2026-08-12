import type { MemoryJobDescriptor } from "../../coordinator/types";
import type { MemoryExecutionVersions } from "../../execution";
import { memorySha256 } from "../../persistence/lexical";

export const MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION =
  "memory-fact-consolidation-v1";
export const MEMORY_FACT_CONSOLIDATION_POLICY_VERSION =
  "memory-fact-consolidation-policy-v1";
export const MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION =
  "memory-fact-consolidation-prompt-v3";
export const MEMORY_FACT_CONSOLIDATION_SCHEMA_VERSION =
  "memory-fact-consolidation-schema-v1";
export const MEMORY_FACT_VERIFICATION_PIPELINE_VERSION =
  "memory-fact-verification-v2";
export const MEMORY_FACT_VERIFICATION_POLICY_VERSION =
  "memory-fact-verification-policy-v1";
export const MEMORY_FACT_VERIFICATION_PROMPT_VERSION =
  "memory-fact-verification-prompt-v1";
export const MEMORY_FACT_VERIFICATION_SCHEMA_VERSION =
  "memory-fact-verification-schema-v1";

export const MEMORY_FACT_MAX_RELATED_FACTS = 12;
export const MEMORY_FACT_MAX_RELATED_VERSIONS = 3;
export const MEMORY_FACT_CONSOLIDATION_JOB_PREFIX = "consolidate-candidate:";
export const MEMORY_FACT_VERIFICATION_JOB_PREFIX = "verify-candidate:";

export const MEMORY_FACT_CONSOLIDATION_OPERATIONS = [
  "ADD",
  "REINFORCE",
  "SUPERSEDE",
  "CONFLICT",
  "EXPIRE",
  "NOOP",
  "DEFER"
] as const;

export type MemoryFactConsolidationOperation =
  (typeof MEMORY_FACT_CONSOLIDATION_OPERATIONS)[number];

export const MEMORY_FACT_CONSOLIDATION_REASON_CODES = [
  "new_supported_fact",
  "same_current_value",
  "direct_newer_evidence",
  "simultaneous_contradiction",
  "direct_end_evidence",
  "duplicate_or_explicit",
  "insufficient_support"
] as const;

export type MemoryFactConsolidationReasonCode =
  (typeof MEMORY_FACT_CONSOLIDATION_REASON_CODES)[number];

export const MEMORY_FACT_VERIFICATION_REASON_CODES = [
  "supported_transition",
  "source_mismatch",
  "temporal_uncertain",
  "authority_conflict",
  "scope_risk",
  "insufficient_support"
] as const;

export type MemoryFactVerificationReasonCode =
  (typeof MEMORY_FACT_VERIFICATION_REASON_CODES)[number];

export type MemoryFactCandidateScope = Readonly<
  | { targetId: null; type: "GLOBAL_USER" }
  | { targetId: string; type: "ASSISTANT" | "CHAT" | "FOLDER" }
>;

export type MemoryFactCandidateEvidenceSnapshot = Readonly<{
  endOffset: number;
  messageId: string;
  observedAt: string;
  quote: string;
  sourceTextHash: string;
  startOffset: number;
}>;

export type MemoryFactCandidateSnapshot = Readonly<{
  branchGeneration: number;
  canonicalKey: string;
  category: string;
  chatId: string;
  confidence: number;
  directness: "DIRECT";
  displayText: string;
  evidence: readonly MemoryFactCandidateEvidenceSnapshot[];
  id: string;
  importance: number;
  languageCode: string;
  modality:
    | "CONSIDERATION"
    | "CONSTRAINT"
    | "EVENT"
    | "HABIT"
    | "INTENTION"
    | "PLAN"
    | "PREFERENCE"
    | "STATE"
    | "WORKFLOW";
  negated: boolean;
  proposedValue: unknown;
  rawTemporalExpression: string | null;
  scope: MemoryFactCandidateScope;
  sensitivity: "NORMAL";
  sourceHash: string;
  sourceProjectionVersion: string;
  sourceRevision: number;
  sourceTimezone: string;
  temporalResolverVersion: string | null;
  temporalResolutionEvidence: Readonly<Record<string, unknown>> | null;
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryRelatedFactVersionSnapshot = Readonly<{
  category: string;
  confidence: number;
  directness: "DIRECT" | "INFERRED" | "PARAPHRASED";
  displayText: string;
  id: string;
  importance: number;
  languageCode: string;
  latestEvidenceAt: string | null;
  modality: MemoryFactCandidateSnapshot["modality"];
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state:
    | "ACTIVE"
    | "CONFLICTING"
    | "EXPIRED"
    | "ORPHANED"
    | "RETRACTED"
    | "SUPERSEDED";
  structuredValue: unknown;
  supportCount: number;
  systemFrom: string;
  systemTo: string | null;
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryRelatedFactSnapshot = Readonly<{
  canonicalKey: string;
  category: string;
  currentVersionId: string | null;
  id: string;
  scope: MemoryFactCandidateScope;
  state: "ACTIVE" | "CONFLICTED" | "EXPIRED" | "ORPHANED" | "RETRACTED";
  versions: readonly MemoryRelatedFactVersionSnapshot[];
}>;

export type MemoryFactConsolidationInput = Readonly<{
  candidate: MemoryFactCandidateSnapshot;
  inputHash: string;
  relatedFacts: readonly MemoryRelatedFactSnapshot[];
  relatedSnapshotHash: string;
}>;

export type MemoryFactConsolidationPlan = Readonly<{
  candidateId: string;
  effectiveFrom: string | null;
  evidenceIds: readonly string[];
  operation: MemoryFactConsolidationOperation;
  outputHash: string;
  reasonCode: MemoryFactConsolidationReasonCode;
  targetFactId: string | null;
  targetVersionId: string | null;
}>;

export type MemoryFactDecisionSnapshot = Readonly<{
  consolidationInputHash: string;
  consolidationOutputHash: string;
  id: string;
  operation: MemoryFactConsolidationOperation;
  reasonCode: MemoryFactConsolidationReasonCode;
  relatedSnapshotHash: string;
  requiresVerification: true;
  targetFactId: string | null;
  targetVersionId: string | null;
}>;

export type MemoryFactVerificationInput = Readonly<{
  candidate: MemoryFactCandidateSnapshot;
  decision: MemoryFactDecisionSnapshot;
  inputHash: string;
  target: MemoryRelatedFactSnapshot | null;
}>;

export type MemoryFactVerificationPlan = Readonly<{
  candidateId: string;
  decisionId: string;
  outputHash: string;
  reasonCode: MemoryFactVerificationReasonCode;
  verdict: "APPROVE" | "DEFER" | "REJECT";
}>;

export const MEMORY_FACT_CONSOLIDATION_RETRIEVAL_CONFIG_FINGERPRINT =
  memorySha256({
    entityTermOverlap: true,
    exactCanonicalFirst: true,
    maxFacts: MEMORY_FACT_MAX_RELATED_FACTS,
    maxVersionsPerFact: MEMORY_FACT_MAX_RELATED_VERSIONS,
    profileDisclosure: "bounded-scope-neighborhood",
    temporalOverlapRanking: true,
    version: 2
  });

export const MEMORY_FACT_CONSOLIDATION_VERSIONS: MemoryExecutionVersions =
  Object.freeze({
    pipelineVersion: MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
    policyVersion: MEMORY_FACT_CONSOLIDATION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION,
    retrievalConfigFingerprint:
      MEMORY_FACT_CONSOLIDATION_RETRIEVAL_CONFIG_FINGERPRINT,
    schemaVersion: MEMORY_FACT_CONSOLIDATION_SCHEMA_VERSION
  });

export const MEMORY_FACT_VERIFICATION_RETRIEVAL_CONFIG_FINGERPRINT =
  memorySha256({ profileDisclosure: "candidate-target-only", version: 1 });

export const MEMORY_FACT_VERIFICATION_VERSIONS: MemoryExecutionVersions =
  Object.freeze({
    pipelineVersion: MEMORY_FACT_VERIFICATION_PIPELINE_VERSION,
    policyVersion: MEMORY_FACT_VERIFICATION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_VERIFICATION_PROMPT_VERSION,
    retrievalConfigFingerprint:
      MEMORY_FACT_VERIFICATION_RETRIEVAL_CONFIG_FINGERPRINT,
    schemaVersion: MEMORY_FACT_VERIFICATION_SCHEMA_VERSION
  });

const sha256Pattern = /^[a-f0-9]{64}$/u;
const consolidationJobPattern = new RegExp(
  `^${MEMORY_FACT_CONSOLIDATION_JOB_PREFIX}([a-f0-9]{64}):([a-z0-9]{1,7}):([a-f0-9]{24})$`,
  "u"
);
const verificationJobPattern = new RegExp(
  `^${MEMORY_FACT_VERIFICATION_JOB_PREFIX}([a-f0-9]{64})$`,
  "u"
);

function sourceCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

export function memoryFactConsolidationJobFingerprint(input: Readonly<{
  candidateId: string;
  sourceHash: string;
  sourceRevision: number;
}>): string {
  if (
    !sha256Pattern.test(input.candidateId) ||
    !sha256Pattern.test(input.sourceHash) ||
    !sourceCounter(input.sourceRevision)
  ) throw new Error("memory_fact_consolidation_identity_invalid");
  return `${MEMORY_FACT_CONSOLIDATION_JOB_PREFIX}${input.candidateId}:${
    input.sourceRevision.toString(36)
  }:${input.sourceHash.slice(0, 24)}`;
}

export function parseMemoryFactConsolidationJob(
  job: MemoryJobDescriptor
): Readonly<{ candidateId: string }> | null {
  const match = consolidationJobPattern.exec(job.idempotencyFingerprint);
  if (
    !match || job.kind !== "CONSOLIDATE_CANDIDATE" ||
    job.pipelineVersion !== MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION ||
    job.chatId === null || job.activeLeafMessageId === null ||
    job.branchGeneration === null || job.sourceRevision === null ||
    job.sourceHash === null ||
    Number.parseInt(match[2]!, 36) !== job.sourceRevision ||
    match[3] !== job.sourceHash.slice(0, 24)
  ) return null;
  return { candidateId: match[1]! };
}

export function memoryFactVerificationJobFingerprint(decisionId: string): string {
  if (!sha256Pattern.test(decisionId)) {
    throw new Error("memory_fact_verification_identity_invalid");
  }
  return `${MEMORY_FACT_VERIFICATION_JOB_PREFIX}${decisionId}`;
}

export function parseMemoryFactVerificationJob(
  job: MemoryJobDescriptor
): Readonly<{ decisionId: string }> | null {
  const match = verificationJobPattern.exec(job.idempotencyFingerprint);
  if (
    !match || job.kind !== "VERIFY_CANDIDATE" ||
    job.pipelineVersion !== MEMORY_FACT_VERIFICATION_PIPELINE_VERSION ||
    job.chatId === null || job.activeLeafMessageId === null ||
    job.branchGeneration === null || job.sourceRevision === null ||
    job.sourceHash === null
  ) return null;
  return { decisionId: match[1]! };
}

export function memoryFactRelatedSnapshotHash(
  relatedFacts: readonly MemoryRelatedFactSnapshot[]
): string {
  return memorySha256({ relatedFacts, version: 1 });
}

export function memoryFactConsolidationInputHash(
  input: Omit<MemoryFactConsolidationInput, "inputHash">
): string {
  return memorySha256({
    ...input,
    policyVersion: MEMORY_FACT_CONSOLIDATION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION,
    schemaVersion: MEMORY_FACT_CONSOLIDATION_SCHEMA_VERSION
  });
}

export function memoryFactConsolidationOutputHash(
  input: MemoryFactConsolidationInput,
  plan: Omit<MemoryFactConsolidationPlan, "outputHash">
): string {
  return memorySha256({ inputHash: input.inputHash, plan, version: 1 });
}

export function memoryFactDecisionId(
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan
): string {
  return memorySha256({
    candidateId: input.candidate.id,
    consolidationInputHash: input.inputHash,
    consolidationOutputHash: plan.outputHash,
    domain: "aiqsa.memory.fact-decision",
    relatedSnapshotHash: input.relatedSnapshotHash,
    version: 1
  });
}

export function memoryFactVerificationInputHash(
  input: Omit<MemoryFactVerificationInput, "inputHash">
): string {
  return memorySha256({
    ...input,
    policyVersion: MEMORY_FACT_VERIFICATION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_VERIFICATION_PROMPT_VERSION,
    schemaVersion: MEMORY_FACT_VERIFICATION_SCHEMA_VERSION
  });
}

export function memoryFactVerificationOutputHash(
  input: MemoryFactVerificationInput,
  plan: Omit<MemoryFactVerificationPlan, "outputHash">
): string {
  return memorySha256({ inputHash: input.inputHash, plan, version: 1 });
}
