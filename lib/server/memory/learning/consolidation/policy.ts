import { memoryStableJson, normalizeMemorySearchText } from "../../persistence/lexical";
import type {
  MemoryFactConsolidationInput,
  MemoryFactConsolidationPlan,
  MemoryRelatedFactVersionSnapshot
} from "./contract";

export type MemoryFactConsolidationPolicyDecision =
  | Readonly<{ requiresVerification: boolean; status: "VALID" }>
  | Readonly<{ reasonCode: string; status: "DEFER" }>;

const highRiskCategoryPattern = /(?:^|[_-])(?:identity|location|possession|employment|employer|job|address|residence|ownership)(?:$|[_-])/iu;

function candidateObservedAt(input: MemoryFactConsolidationInput): number {
  return Math.max(...input.candidate.evidence.map((evidence) =>
    new Date(evidence.observedAt).getTime()));
}

function equivalentValue(
  input: MemoryFactConsolidationInput,
  version: MemoryRelatedFactVersionSnapshot
): boolean {
  try {
    return version.category === input.candidate.category &&
      version.modality === input.candidate.modality &&
      normalizeMemorySearchText(version.displayText) ===
        normalizeMemorySearchText(input.candidate.displayText) &&
      memoryStableJson(version.structuredValue) ===
        memoryStableJson(input.candidate.proposedValue) &&
      version.validFrom === input.candidate.validFrom &&
      version.validTo === input.candidate.validTo;
  } catch {
    return false;
  }
}

function targetVersion(
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan
): MemoryRelatedFactVersionSnapshot | null {
  if (!plan.targetFactId || !plan.targetVersionId) return null;
  const fact = input.relatedFacts.find((candidate) =>
    candidate.id === plan.targetFactId &&
    candidate.currentVersionId === plan.targetVersionId &&
    candidate.state === "ACTIVE");
  return fact?.versions.find((version) =>
    version.id === plan.targetVersionId && version.state === "ACTIVE") ?? null;
}

function hasRetainedExplicitAuthority(input: MemoryFactConsolidationInput): boolean {
  return input.relatedFacts.some((fact) =>
    fact.canonicalKey === input.candidate.canonicalKey &&
    fact.scope.type === input.candidate.scope.type &&
    fact.scope.targetId === input.candidate.scope.targetId &&
    fact.versions.some((version) => version.sourceMode === "EXPLICIT"));
}

function needsRiskVerification(input: MemoryFactConsolidationInput): boolean {
  const candidate = input.candidate;
  if (candidate.importance >= 0.8 || candidate.confidence < 0.82) return true;
  if (highRiskCategoryPattern.test(candidate.category)) return true;
  if (
    candidate.scope.type === "GLOBAL_USER" &&
    input.relatedFacts.some((fact) =>
      fact.canonicalKey === candidate.canonicalKey &&
      fact.scope.type !== "GLOBAL_USER")
  ) return true;
  return candidate.importance >= 0.65 && [
    "CONSTRAINT",
    "PREFERENCE",
    "WORKFLOW"
  ].includes(candidate.modality);
}

export function evaluateMemoryFactConsolidationPlan(
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan
): MemoryFactConsolidationPolicyDecision {
  if (
    plan.candidateId !== input.candidate.id ||
    plan.evidenceIds.length !== input.candidate.evidence.length ||
    plan.evidenceIds.some((id, index) =>
      id !== input.candidate.evidence[index]?.messageId)
  ) return { reasonCode: "evidence_precondition_invalid", status: "DEFER" };

  if (plan.operation === "NOOP" || plan.operation === "DEFER") {
    return { requiresVerification: false, status: "VALID" };
  }

  const exactFacts = input.relatedFacts.filter((fact) =>
    fact.canonicalKey === input.candidate.canonicalKey &&
    fact.scope.type === input.candidate.scope.type &&
    fact.scope.targetId === input.candidate.scope.targetId);
  const activeExact = exactFacts.filter((fact) => fact.state === "ACTIVE");
  const target = targetVersion(input, plan);

  if (plan.operation === "ADD") {
    if (
      input.candidate.negated ||
      activeExact.length > 0 ||
      exactFacts.some((fact) => fact.state === "CONFLICTED" || fact.state === "ORPHANED") ||
      hasRetainedExplicitAuthority(input)
    ) return { reasonCode: "add_precondition_invalid", status: "DEFER" };
    return {
      requiresVerification: needsRiskVerification(input),
      status: "VALID"
    };
  }

  if (!target || activeExact.length !== 1) {
    return { reasonCode: "target_precondition_invalid", status: "DEFER" };
  }
  const equivalent = equivalentValue(input, target);
  if (plan.operation === "REINFORCE") {
    if (input.candidate.negated || !equivalent) {
      return { reasonCode: "reinforce_precondition_invalid", status: "DEFER" };
    }
    return { requiresVerification: false, status: "VALID" };
  }
  if (plan.operation === "SUPERSEDE") {
    const targetEvidenceAt = target.latestEvidenceAt
      ? new Date(target.latestEvidenceAt).getTime()
      : new Date(target.systemFrom).getTime();
    if (
      input.candidate.negated || equivalent || target.sourceMode !== "AUTOMATIC" ||
      !Number.isFinite(targetEvidenceAt) || candidateObservedAt(input) <= targetEvidenceAt
    ) return { reasonCode: "supersede_precondition_invalid", status: "DEFER" };
    return { requiresVerification: true, status: "VALID" };
  }
  if (plan.operation === "CONFLICT") {
    if (input.candidate.negated || equivalent) {
      return { reasonCode: "conflict_precondition_invalid", status: "DEFER" };
    }
    return { requiresVerification: true, status: "VALID" };
  }
  if (
    plan.operation !== "EXPIRE" ||
    !input.candidate.negated ||
    equivalent ||
    target.sourceMode !== "AUTOMATIC"
  ) return { reasonCode: "expire_precondition_invalid", status: "DEFER" };
  const observedEnd = candidateObservedAt(input);
  const targetEvidenceAt = target.latestEvidenceAt
    ? new Date(target.latestEvidenceAt).getTime()
    : new Date(target.systemFrom).getTime();
  const targetValidFrom = target.validFrom
    ? new Date(target.validFrom).getTime()
    : null;
  if (
    !Number.isFinite(observedEnd) ||
    !Number.isFinite(targetEvidenceAt) ||
    observedEnd <= targetEvidenceAt ||
    (targetValidFrom !== null && (
      !Number.isFinite(targetValidFrom) || observedEnd <= targetValidFrom
    ))
  ) return { reasonCode: "expire_precondition_invalid", status: "DEFER" };
  return { requiresVerification: true, status: "VALID" };
}
