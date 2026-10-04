import { MEMORY_STATEMENT_MAX_LENGTH } from "../../../../contracts/memory";
import type { MemoryJobDescriptor } from "../../coordinator/types";
import { memoryExecutionSha256 } from "../../execution/canonical";
import { normalizeMemorySearchText } from "../../persistence/lexical";

/** Retired explicit-only protocol. Its queued jobs and retained results still
 * complete unchanged; new comparisons are admitted only under v2. */
export const MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION = "memory-explicit-relation-v1";
export const MEMORY_EXPLICIT_RELATION_V1_POLICY_VERSION = "memory-explicit-relation-policy-v1";
/** Current protocol: an explicit save is also compared with unprotected
 * automatic facts, and a new automatic fact with explicit saves. */
export const MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION = "memory-explicit-relation-v2";
export const MEMORY_EXPLICIT_RELATION_POLICY_VERSION = "memory-explicit-relation-policy-v2";
export const MEMORY_EXPLICIT_RELATION_PIPELINE_VERSIONS = Object.freeze([
  MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION,
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION
] as const);
export type MemoryExplicitRelationPipelineVersion =
  typeof MEMORY_EXPLICIT_RELATION_PIPELINE_VERSIONS[number];

export const MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES = 12;
export const MEMORY_EXPLICIT_RELATION_RECENT_CANDIDATES = 4;
/** Facts whose normalized text equals the source's, found without the index. */
export const MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_CANDIDATES = 4;
/** Bounded scan for equal-text twins; ranked retrieval covers older facts. */
export const MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_SCAN = 512;
/** Relation reason of an explicit save merged into an older explicit save. */
export const MEMORY_EXPLICIT_EQUIVALENCE_REASON = "explicit_semantic_equivalence";
/** Relation reason of an automatic version merged into an explicit save. */
export const MEMORY_AUTOMATIC_EXPLICIT_EQUIVALENCE_REASON = "automatic_explicit_equivalence";

export function isMemoryExplicitRelationPipelineVersion(
  value: unknown
): value is MemoryExplicitRelationPipelineVersion {
  return MEMORY_EXPLICIT_RELATION_PIPELINE_VERSIONS.includes(
    value as MemoryExplicitRelationPipelineVersion
  );
}

export function memoryExplicitRelationPolicyVersion(
  pipelineVersion: MemoryExplicitRelationPipelineVersion
): string {
  return pipelineVersion === MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION
    ? MEMORY_EXPLICIT_RELATION_V1_POLICY_VERSION
    : MEMORY_EXPLICIT_RELATION_POLICY_VERSION;
}

export function memoryExplicitRelationJobFingerprint(
  targetFactVersionId: string,
  pipelineVersion: MemoryExplicitRelationPipelineVersion = MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION
): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.explicit-relation-job",
    pipelineVersion,
    targetFactVersionId
  });
}

/** Candidate key of the equal-text lane and its triggers: normalized search
 * text without Unicode punctuation or symbols, so "Ada." finds "ada". It only
 * selects candidates for the semantic comparison and never authorizes a merge. */
export function memoryEquivalenceTextKey(text: string): string {
  return normalizeMemorySearchText(text).replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}

export type MemoryExplicitRelationSourceMode = "AUTOMATIC" | "EXPLICIT";

/** Identity, exact evidence and lifecycle fields stay local. Only statement,
 * modality and grounded dates are needed by the semantic comparison. */
export type MemoryExplicitRelationFact = Readonly<{
  createdAt: string;
  evidenceHash: string;
  expectedAt: string | null;
  expiresAt: string | null;
  factId: string;
  modality: string;
  observedAt: string | null;
  occurredAt: string | null;
  pinned: boolean;
  scopeId: string;
  /** EXPLICIT: a current owner save/edit receipt. AUTOMATIC (v2 only): an
   * unprotected learned fact with exact current direct-user message support. */
  sourceMode: MemoryExplicitRelationSourceMode;
  statement: string;
  systemFrom: string;
  validFrom: string | null;
  validTo: string | null;
  versionId: string;
}>;

export type MemoryExplicitRelationSnapshot = Readonly<{
  candidates: readonly MemoryExplicitRelationFact[];
  memoryGeneration: number;
  pipelineVersion: MemoryExplicitRelationPipelineVersion;
  source: MemoryExplicitRelationFact;
  userId: string;
}>;

export type MemoryExplicitRelationDecision = Readonly<{
  confidenceBand: "HIGH" | "MEDIUM" | "LOW";
  relation: "EQUIVALENT" | "DISTINCT" | "UNCERTAIN";
  targetRef: string;
}>;

/** The canonical is always an explicit save. Redundant facts are in age order. */
export type MemoryExplicitRelationMerge = Readonly<{
  canonical: MemoryExplicitRelationFact;
  redundant: readonly MemoryExplicitRelationFact[];
}>;

const sha256 = /^[a-f0-9]{64}$/u;
const groundedDates = ["expectedAt", "expiresAt", "occurredAt", "validFrom", "validTo"] as const;

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 35 &&
    Number.isFinite(Date.parse(value));
}

function validFact(fact: MemoryExplicitRelationFact): boolean {
  return identifier(fact.factId) && identifier(fact.versionId) &&
    identifier(fact.scopeId) && identifier(fact.modality) &&
    typeof fact.pinned === "boolean" && sha256.test(fact.evidenceHash) &&
    (fact.sourceMode === "EXPLICIT" || fact.sourceMode === "AUTOMATIC") &&
    typeof fact.statement === "string" && fact.statement.trim().length > 0 &&
    fact.statement.length <= MEMORY_STATEMENT_MAX_LENGTH &&
    timestamp(fact.createdAt) && timestamp(fact.systemFrom) &&
    (fact.observedAt === null || timestamp(fact.observedAt)) &&
    groundedDates.every((key) => fact[key] === null || timestamp(fact[key]));
}

/** v1 compares explicit saves only. v2 adds unpinned automatic facts, but an
 * automatic fact is compared only with explicit saves, never with another
 * automatic fact. */
function validParticipants(snapshot: MemoryExplicitRelationSnapshot): boolean {
  const facts = [snapshot.source, ...snapshot.candidates];
  if (facts.some(({ pinned, sourceMode }) => sourceMode === "AUTOMATIC" && pinned)) return false;
  if (snapshot.pipelineVersion === MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION) {
    return facts.every(({ sourceMode }) => sourceMode === "EXPLICIT");
  }
  return snapshot.source.sourceMode === "EXPLICIT" ||
    snapshot.candidates.every(({ sourceMode }) => sourceMode === "EXPLICIT");
}

export function assertMemoryExplicitRelationSnapshot(
  snapshot: MemoryExplicitRelationSnapshot
): void {
  const facts = [snapshot.source, ...snapshot.candidates];
  if (!identifier(snapshot.userId) ||
    !isMemoryExplicitRelationPipelineVersion(snapshot.pipelineVersion) ||
    !Number.isSafeInteger(snapshot.memoryGeneration) || snapshot.memoryGeneration < 0 ||
    snapshot.candidates.length > MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES ||
    facts.some((fact) => !validFact(fact) || fact.scopeId !== snapshot.source.scopeId) ||
    new Set(facts.map(({ factId }) => factId)).size !== facts.length ||
    new Set(facts.map(({ versionId }) => versionId)).size !== facts.length ||
    !validParticipants(snapshot)) {
    throw new Error("memory_explicit_relation_snapshot_invalid");
  }
}

export function isMemoryExplicitRelationJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "RESOLVE_FACT_RELATIONS" &&
    isMemoryExplicitRelationPipelineVersion(job.pipelineVersion) &&
    identifier(job.targetFactVersionId) && identifier(job.userId) &&
    job.chatId === null && job.sourceMessageId === null &&
    job.activeLeafMessageId === null && job.branchGeneration === null &&
    job.sourceRevision === null && job.sourceHash === null &&
    Number.isSafeInteger(job.memoryGenerationSnapshot) && job.memoryGenerationSnapshot >= 0;
}

/** The exact v1 shape, so a v1 result retained before this release still
 * proves its snapshot after the upgrade. */
function v1HashedSnapshot(snapshot: MemoryExplicitRelationSnapshot) {
  const fact = ({ sourceMode: _sourceMode, ...rest }: MemoryExplicitRelationFact) => rest;
  return {
    candidates: snapshot.candidates.map(fact),
    memoryGeneration: snapshot.memoryGeneration,
    source: fact(snapshot.source),
    userId: snapshot.userId
  };
}

export function memoryExplicitRelationSnapshotHash(
  snapshot: MemoryExplicitRelationSnapshot
): string {
  assertMemoryExplicitRelationSnapshot(snapshot);
  return memoryExecutionSha256({
    domain: "aiqsa.memory.explicit-relation-snapshot",
    pipelineVersion: snapshot.pipelineVersion,
    policyVersion: memoryExplicitRelationPolicyVersion(snapshot.pipelineVersion),
    snapshot: snapshot.pipelineVersion === MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION
      ? v1HashedSnapshot(snapshot)
      : snapshot
  });
}

export function memoryExplicitRelationRef(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 ||
    index >= MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES) {
    throw new Error("memory_explicit_relation_ref_invalid");
  }
  return `R${index + 1}`;
}

function byAge(left: MemoryExplicitRelationFact, right: MemoryExplicitRelationFact): number {
  const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (time !== 0) return time;
  return left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0;
}

/** Full high-confidence equivalence is the only permitted mutation. No
 * rewriting, enrichment, correction or inference is delegated to this job.
 * Fresh repository authority and accepted provider proof are still required
 * when applying this plan.
 *
 * Explicit authority wins whatever the age: the canonical is the oldest
 * equivalent explicit save, never an automatic fact. Explicit saves merge only
 * when an explicit save is the compared source (the unchanged homogeneous
 * rule); an equivalent automatic fact joins that explicit canonical. */
export function selectMemoryExplicitRelationMerge(
  snapshot: MemoryExplicitRelationSnapshot,
  decisions: readonly MemoryExplicitRelationDecision[]
): MemoryExplicitRelationMerge | null {
  assertMemoryExplicitRelationSnapshot(snapshot);
  const byRef = new Map(decisions.map((decision) => [decision.targetRef, decision]));
  if (decisions.length !== snapshot.candidates.length || byRef.size !== decisions.length ||
    snapshot.candidates.some((_, index) => !byRef.has(memoryExplicitRelationRef(index))) ||
    decisions.some((decision) =>
      !["HIGH", "MEDIUM", "LOW"].includes(decision.confidenceBand) ||
      !["EQUIVALENT", "DISTINCT", "UNCERTAIN"].includes(decision.relation))) {
    throw new Error("memory_explicit_relation_decision_invalid");
  }
  const equivalents = snapshot.candidates.filter((candidate, index) => {
    const decision = byRef.get(memoryExplicitRelationRef(index))!;
    return decision.relation === "EQUIVALENT" && decision.confidenceBand === "HIGH" &&
      candidate.modality === snapshot.source.modality &&
      groundedDates.every((key) => candidate[key] === snapshot.source[key]);
  });
  if (equivalents.length === 0) return null;
  const ordered = [snapshot.source, ...equivalents].sort(byAge);
  const canonical = ordered.find(({ sourceMode }) => sourceMode === "EXPLICIT");
  if (!canonical) return null;
  const redundant = ordered.filter((fact) => fact !== canonical &&
    (fact.sourceMode === "AUTOMATIC" || snapshot.source.sourceMode === "EXPLICIT"));
  if (redundant.length === 0) return null;
  return Object.freeze({ canonical, redundant: Object.freeze(redundant) });
}
