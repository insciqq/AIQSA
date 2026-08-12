import type { MemoryJobDescriptor } from "../coordinator/types";
import type {
  MemoryFactConsolidationInput,
  MemoryFactConsolidationOperation,
  MemoryFactConsolidationPlan,
  MemoryFactVerificationPlan,
  MemoryFactVerificationReasonCode
} from "../learning/consolidation/contract";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_GLOBAL_DREAM_PIPELINE_VERSION = "memory-global-dream-v1";
export const MEMORY_GLOBAL_DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_GLOBAL_DREAM_MAX_JOBS_PER_OWNER = 8;
export const MEMORY_GLOBAL_DREAM_DISCOVERY_OWNER_LIMIT = 25;
export const MEMORY_GLOBAL_DREAM_MAX_EVIDENCE = 6;

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const sha256 = "[a-f0-9]{64}";
const snapshot = "[a-f0-9]{32}";
const identityPattern = new RegExp(
  `^gd1:(i|t):(${uuid}):(${snapshot})$|^gd1:p:(${uuid}):(${uuid}):(${snapshot})$|^gd1:d:(${sha256}):(${snapshot})$`,
  "u"
);

export type MemoryGlobalDreamIdentity =
  | Readonly<{
      factId: string;
      kind: "EXPIRE_TEMPORAL" | "RETRACT_INVALID";
      snapshotPrefix: string;
    }>
  | Readonly<{
      kind: "RECONCILE_PAIR";
      snapshotPrefix: string;
      sourceFactId: string;
      targetFactId: string;
    }>
  | Readonly<{
      candidateId: string;
      kind: "REVISIT_DEFERRED";
      snapshotPrefix: string;
    }>;

type MemoryGlobalDreamLocalSelectionFields = Readonly<{
  factId: string;
  resultHash: string;
  snapshotHash: string;
  versionId: string;
}>;

export type MemoryGlobalDreamLocalSelection =
  | (MemoryGlobalDreamLocalSelectionFields & Readonly<{ kind: "EXPIRE_TEMPORAL" }>)
  | (MemoryGlobalDreamLocalSelectionFields & Readonly<{ kind: "RETRACT_INVALID" }>);

type MemoryGlobalDreamSemanticSelectionFields = Readonly<{
  input: MemoryFactConsolidationInput;
  resultHash: string;
  scopeChanged: boolean;
  snapshotHash: string;
  sourceEvidenceIds: readonly string[];
  targetEvidenceIds: readonly string[];
}>;

export type MemoryGlobalDreamSemanticSelection =
  | (MemoryGlobalDreamSemanticSelectionFields & Readonly<{
      kind: "RECONCILE_PAIR";
      sourceFactId: string;
      sourceVersionId: string;
      targetFactId: string;
      targetVersionId: string;
    }>)
  | (MemoryGlobalDreamSemanticSelectionFields & Readonly<{
      kind: "REVISIT_DEFERRED";
      sourceFactId: null;
      sourceVersionId: null;
      targetFactId: string;
      targetVersionId: string;
    }>);

export type MemoryGlobalDreamSelection =
  | MemoryGlobalDreamLocalSelection
  | MemoryGlobalDreamSemanticSelection;

export type MemoryGlobalDreamPrepared =
  | Readonly<{
      decision: Readonly<{
        errorCode: string;
        status: "CANCELLED" | "STALE";
      }>;
    }>
  | Readonly<{ selection: MemoryGlobalDreamSelection }>;

type MemoryGlobalDreamFingerprintIdentity<T> = T extends unknown
  ? Omit<T, "snapshotPrefix"> & Readonly<{ snapshotHash: string }>
  : never;

function snapshotPrefix(snapshotHash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(snapshotHash)) {
    throw new Error("memory_global_dream_snapshot_invalid");
  }
  return snapshotHash.slice(0, 32);
}

export function memoryGlobalDreamJobFingerprint(
  identity: MemoryGlobalDreamFingerprintIdentity<MemoryGlobalDreamIdentity>
): string {
  const prefix = snapshotPrefix(identity.snapshotHash);
  if (identity.kind === "RETRACT_INVALID") {
    return `gd1:i:${identity.factId}:${prefix}`;
  }
  if (identity.kind === "EXPIRE_TEMPORAL") {
    return `gd1:t:${identity.factId}:${prefix}`;
  }
  if (identity.kind === "RECONCILE_PAIR") {
    return `gd1:p:${identity.targetFactId}:${identity.sourceFactId}:${prefix}`;
  }
  if ("candidateId" in identity) return `gd1:d:${identity.candidateId}:${prefix}`;
  throw new Error("memory_global_dream_identity_invalid");
}

export function parseMemoryGlobalDreamJobFingerprint(
  value: string
): MemoryGlobalDreamIdentity | null {
  const match = identityPattern.exec(value);
  if (!match) return null;
  if (match[1] && match[2] && match[3]) {
    return {
      factId: match[2],
      kind: match[1] === "i" ? "RETRACT_INVALID" : "EXPIRE_TEMPORAL",
      snapshotPrefix: match[3]
    };
  }
  if (match[4] && match[5] && match[6]) {
    return {
      kind: "RECONCILE_PAIR",
      snapshotPrefix: match[6],
      sourceFactId: match[5],
      targetFactId: match[4]
    };
  }
  if (match[7] && match[8]) {
    return {
      candidateId: match[7],
      kind: "REVISIT_DEFERRED",
      snapshotPrefix: match[8]
    };
  }
  return null;
}

function counter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

export function memoryGlobalDreamJobIsValid(job: MemoryJobDescriptor): boolean {
  return job.kind === "GLOBAL_DREAM" &&
    job.pipelineVersion === MEMORY_GLOBAL_DREAM_PIPELINE_VERSION &&
    job.chatId === null && job.activeLeafMessageId === null &&
    job.branchGeneration === null && job.sourceRevision === null &&
    job.sourceHash === null && counter(job.memoryGenerationSnapshot) &&
    counter(job.memoryRevisionSnapshot) &&
    parseMemoryGlobalDreamJobFingerprint(job.idempotencyFingerprint) !== null;
}

const targetOperations = new Set<MemoryFactConsolidationOperation>([
  "CONFLICT", "EXPIRE", "REINFORCE", "SUPERSEDE"
]);

export function memoryGlobalDreamPlanStage(
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan
): string {
  const targetIndex = plan.targetFactId === null
    ? -1
    : input.relatedFacts.findIndex(({ id }) => id === plan.targetFactId);
  if (
    plan.candidateId !== input.candidate.id ||
    (targetOperations.has(plan.operation) ? targetIndex < 0 : targetIndex !== -1)
  ) throw new Error("memory_global_dream_plan_invalid");
  return `gd_plan_${plan.operation}_${targetIndex < 0 ? "x" : targetIndex}`;
}

export function parseMemoryGlobalDreamPlanStage(
  value: string | null
): Readonly<{
  operation: MemoryFactConsolidationOperation;
  targetIndex: number | null;
}> | null {
  const match = /^gd_plan_(ADD|REINFORCE|SUPERSEDE|CONFLICT|EXPIRE|NOOP|DEFER)_(x|\d{1,2})$/u
    .exec(value ?? "");
  if (!match) return null;
  const operation = match[1] as MemoryFactConsolidationOperation;
  const targetIndex = match[2] === "x" ? null : Number(match[2]);
  if (
    (targetOperations.has(operation) !== (targetIndex !== null)) ||
    (targetIndex !== null && (!Number.isSafeInteger(targetIndex) || targetIndex > 11))
  ) return null;
  return { operation, targetIndex };
}

export function memoryGlobalDreamVerificationStage(
  input: MemoryFactConsolidationInput,
  consolidation: MemoryFactConsolidationPlan,
  plan: MemoryFactVerificationPlan
): string {
  const consolidationStage = memoryGlobalDreamPlanStage(input, consolidation)
    .replace(/^gd_plan_/u, "");
  return `gd_final_${consolidationStage}_${plan.verdict}_${plan.reasonCode}`;
}

export function parseMemoryGlobalDreamVerificationStage(
  value: string | null
): Readonly<{
  operation: MemoryFactConsolidationOperation;
  reasonCode: MemoryFactVerificationReasonCode;
  targetIndex: number | null;
  verdict: MemoryFactVerificationPlan["verdict"];
}> | null {
  const match = /^gd_final_(ADD|REINFORCE|SUPERSEDE|CONFLICT|EXPIRE|NOOP|DEFER)_(x|\d{1,2})_(APPROVE|DEFER|REJECT)_(supported_transition|source_mismatch|temporal_uncertain|authority_conflict|scope_risk|insufficient_support)$/u
    .exec(value ?? "");
  if (!match) return null;
  const operation = match[1] as MemoryFactConsolidationOperation;
  const targetIndex = match[2] === "x" ? null : Number(match[2]);
  const verdict = match[3] as MemoryFactVerificationPlan["verdict"];
  const reasonCode = match[4] as MemoryFactVerificationReasonCode;
  if (
    (targetOperations.has(operation) !== (targetIndex !== null)) ||
    (targetIndex !== null && (!Number.isSafeInteger(targetIndex) || targetIndex > 11)) ||
    (verdict === "APPROVE") !== (reasonCode === "supported_transition")
  ) return null;
  return { operation, reasonCode, targetIndex, verdict };
}

export function memoryGlobalDreamResultHash(
  value: Readonly<Record<string, unknown>>
): string {
  return memorySha256({
    domain: "aiqsa.memory.global-dream-result",
    value,
    version: 1
  });
}
