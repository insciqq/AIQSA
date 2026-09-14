import { MEMORY_STATEMENT_MAX_LENGTH } from "../../../../contracts/memory";
import type { MemoryJobDescriptor } from "../../coordinator/types";
import { memoryExecutionSha256 } from "../../execution/canonical";

export const MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION = "memory-explicit-relation-v1";
export const MEMORY_EXPLICIT_RELATION_POLICY_VERSION = "memory-explicit-relation-policy-v1";
export const MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES = 12;
export const MEMORY_EXPLICIT_RELATION_RECENT_CANDIDATES = 4;

export function memoryExplicitRelationJobFingerprint(targetFactVersionId: string): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.explicit-relation-job",
    pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
    targetFactVersionId
  });
}

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
  statement: string;
  systemFrom: string;
  validFrom: string | null;
  validTo: string | null;
  versionId: string;
}>;

export type MemoryExplicitRelationSnapshot = Readonly<{
  candidates: readonly MemoryExplicitRelationFact[];
  memoryGeneration: number;
  source: MemoryExplicitRelationFact;
  userId: string;
}>;

export type MemoryExplicitRelationDecision = Readonly<{
  confidenceBand: "HIGH" | "MEDIUM" | "LOW";
  relation: "EQUIVALENT" | "DISTINCT" | "UNCERTAIN";
  targetRef: string;
}>;

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
    typeof fact.statement === "string" && fact.statement.trim().length > 0 &&
    fact.statement.length <= MEMORY_STATEMENT_MAX_LENGTH &&
    timestamp(fact.createdAt) && timestamp(fact.systemFrom) &&
    (fact.observedAt === null || timestamp(fact.observedAt)) &&
    groundedDates.every((key) => fact[key] === null || timestamp(fact[key]));
}

export function assertMemoryExplicitRelationSnapshot(
  snapshot: MemoryExplicitRelationSnapshot
): void {
  const facts = [snapshot.source, ...snapshot.candidates];
  if (!identifier(snapshot.userId) ||
    !Number.isSafeInteger(snapshot.memoryGeneration) || snapshot.memoryGeneration < 0 ||
    snapshot.candidates.length > MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES ||
    facts.some((fact) => !validFact(fact) || fact.scopeId !== snapshot.source.scopeId) ||
    new Set(facts.map(({ factId }) => factId)).size !== facts.length ||
    new Set(facts.map(({ versionId }) => versionId)).size !== facts.length) {
    throw new Error("memory_explicit_relation_snapshot_invalid");
  }
}

export function isMemoryExplicitRelationJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "RESOLVE_FACT_RELATIONS" &&
    job.pipelineVersion === MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION &&
    identifier(job.targetFactVersionId) && identifier(job.userId) &&
    job.chatId === null && job.sourceMessageId === null &&
    job.activeLeafMessageId === null && job.branchGeneration === null &&
    job.sourceRevision === null && job.sourceHash === null &&
    Number.isSafeInteger(job.memoryGenerationSnapshot) && job.memoryGenerationSnapshot >= 0;
}

export function memoryExplicitRelationSnapshotHash(
  snapshot: MemoryExplicitRelationSnapshot
): string {
  assertMemoryExplicitRelationSnapshot(snapshot);
  return memoryExecutionSha256({
    domain: "aiqsa.memory.explicit-relation-snapshot",
    pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
    policyVersion: MEMORY_EXPLICIT_RELATION_POLICY_VERSION,
    snapshot
  });
}

export function memoryExplicitRelationRef(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 ||
    index >= MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES) {
    throw new Error("memory_explicit_relation_ref_invalid");
  }
  return `R${index + 1}`;
}

/** Full high-confidence equivalence is the only permitted mutation. No
 * rewriting, enrichment, correction or inference is delegated to this job.
 * Fresh repository authority and accepted provider proof are still required
 * when applying this plan. */
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
  const ordered = [snapshot.source, ...equivalents].sort((left, right) => {
    const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (time !== 0) return time;
    return left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0;
  });
  return Object.freeze({
    canonical: ordered[0]!,
    redundant: Object.freeze(ordered.slice(1))
  });
}
