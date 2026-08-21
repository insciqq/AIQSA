import type {
  MemoryFactConsolidationInput,
  MemoryFactConsolidationPlan,
  MemoryRelatedFactVersionSnapshot
} from "./contract";

export type MemoryFactConsolidationPolicyDecision =
  | Readonly<{ requiresVerification: false; status: "VALID" }>
  | Readonly<{ reasonCode: string; status: "DEFER" }>;

function candidateObservedAt(input: MemoryFactConsolidationInput): number {
  return Math.max(...input.candidate.evidence.map((evidence) =>
    new Date(evidence.observedAt).getTime()));
}

function targetVersion(
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan
): MemoryRelatedFactVersionSnapshot | null {
  if (!plan.targetFactId || !plan.targetVersionId) return null;
  const fact = input.relatedFacts.find((candidate) =>
    candidate.id === plan.targetFactId &&
    candidate.currentVersionId === plan.targetVersionId &&
    candidate.state === "ACTIVE" &&
    candidate.scope.type === input.candidate.scope.type &&
    candidate.scope.targetId === input.candidate.scope.targetId);
  return fact?.versions.find((version) =>
    version.id === plan.targetVersionId && version.state === "ACTIVE") ?? null;
}

function targetObservedAt(version: MemoryRelatedFactVersionSnapshot): number {
  return new Date(version.latestEvidenceAt ?? version.systemFrom).getTime();
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

  // v1 has no deferred/conflict/verification states.  A strict model may
  // reject a candidate explicitly; that is a terminal, non-mutating result.
  if (plan.operation === "REJECT") {
    return { requiresVerification: false, status: "VALID" };
  }
  if (plan.operation === "REPLACE") {
    const target = targetVersion(input, plan);
    if (!target) return { reasonCode: "target_precondition_invalid", status: "DEFER" };
    // Saved (explicit) memory wins unless the current direct-user candidate
    // is itself marked as an explicit correction.
    if (target.sourceMode === "EXPLICIT" && input.candidate.correction !== true) {
      return { reasonCode: "explicit_authority_retained", status: "DEFER" };
    }
    return { requiresVerification: false, status: "VALID" };
  }

  if (plan.operation === "NOOP") {
    return { requiresVerification: false, status: "VALID" };
  }
  if (plan.operation === "DEFER") {
    return { reasonCode: "consolidation_deferred", status: "DEFER" };
  }
  if (plan.operation === "ADD") {
    return plan.targetFactId === null && plan.targetVersionId === null
      ? { requiresVerification: false, status: "VALID" }
      : { reasonCode: "add_precondition_invalid", status: "DEFER" };
  }

  const target = targetVersion(input, plan);
  if (!target) return { reasonCode: "target_precondition_invalid", status: "DEFER" };
  if (target.sourceMode === "EXPLICIT") {
    return { reasonCode: "explicit_authority_retained", status: "DEFER" };
  }
  if (plan.operation === "REINFORCE") {
    return { requiresVerification: false, status: "VALID" };
  }

  const candidateAt = candidateObservedAt(input);
  const targetAt = targetObservedAt(target);
  if (!Number.isFinite(candidateAt) || !Number.isFinite(targetAt)) {
    return { reasonCode: "temporal_precondition_invalid", status: "DEFER" };
  }
  const targetValidFrom = target.validFrom === null
    ? null
    : new Date(target.validFrom).getTime();
  if (
    targetValidFrom !== null &&
    (!Number.isFinite(targetValidFrom) || candidateAt < targetValidFrom)
  ) {
    return {
      reasonCode: `${plan.operation.toLowerCase()}_precondition_invalid`,
      status: "DEFER"
    };
  }
  if (plan.operation === "SUPERSEDE" && candidateAt > targetAt) {
    return { requiresVerification: false, status: "VALID" };
  }
  if (plan.operation === "CONFLICT" && candidateAt === targetAt) {
    return { requiresVerification: false, status: "VALID" };
  }
  if (plan.operation === "EXPIRE" && candidateAt > targetAt) {
    return { requiresVerification: false, status: "VALID" };
  }
  return {
    reasonCode: `${plan.operation.toLowerCase()}_precondition_invalid`,
    status: "DEFER"
  };
}
