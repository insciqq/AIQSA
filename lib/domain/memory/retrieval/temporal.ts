import { MEMORY_TEMPORAL_RESOLVER_VERSION } from "./config";
import type {
  MemoryRankedCandidate,
  MemoryRetrievalPlan,
  MemoryTemporalDecision
} from "./contracts";

function validDate(value: Date | null): boolean {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

function overlaps(
  leftFrom: Date | null,
  leftTo: Date | null,
  rightFrom: Date | null,
  rightTo: Date | null
): boolean {
  if (![leftFrom, leftTo, rightFrom, rightTo].every(validDate)) return false;
  const leftStart = leftFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const leftEnd = leftTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightStart = rightFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightEnd = rightTo?.getTime() ?? Number.POSITIVE_INFINITY;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function qualification(
  plan: MemoryRetrievalPlan,
  kind: "CONFLICT" | "HISTORICAL" | "UNCONFIRMED"
): string {
  const russian = plan.language === "RU" || plan.language === "MIXED";
  if (kind === "CONFLICT") {
    return russian
      ? "В памяти есть нерешённое противоречие; не считайте это установленным фактом."
      : "Memory contains an unresolved conflict; do not treat this as established fact.";
  }
  if (kind === "UNCONFIRMED") {
    return russian
      ? "Это сохранено как план, намерение или рассмотренный вариант; подтверждения исполнения нет."
      : "This is stored as a plan, intention, or consideration; completion is not confirmed.";
  }
  return russian
    ? "Это историческое состояние, а не утверждение о текущем положении дел."
    : "This is historical state, not a claim about the current situation.";
}

function candidateRange(candidate: MemoryRankedCandidate): Readonly<{
  from: Date | null;
  to: Date | null;
}> {
  if (candidate.itemType === "FACT_VERSION") {
    return { from: candidate.metadata.validFrom, to: candidate.metadata.validTo };
  }
  return { from: candidate.metadata.occurredFrom, to: candidate.metadata.occurredTo };
}

export function memoryTemporalFit(
  plan: MemoryRetrievalPlan,
  candidate: Pick<MemoryRankedCandidate, "itemType" | "metadata">
): number {
  const range = candidate.itemType === "FACT_VERSION"
    ? { from: candidate.metadata.validFrom, to: candidate.metadata.validTo }
    : { from: candidate.metadata.occurredFrom, to: candidate.metadata.occurredTo };
  if (plan.temporal.mode === "RANGE") {
    if (range.from === null && range.to === null) return 0;
    return overlaps(plan.temporal.from, plan.temporal.to, range.from, range.to) ? 1 : 0;
  }
  if (plan.temporal.mode === "AMBIGUOUS") return 0;
  if (plan.temporal.mode === "HISTORICAL") {
    return candidate.metadata.historical || candidate.itemType !== "FACT_VERSION" ? 0.8 : 0;
  }
  return candidate.metadata.current ? 1 : 0;
}

export function resolveMemoryTemporalCandidate(
  plan: MemoryRetrievalPlan,
  candidate: MemoryRankedCandidate
): MemoryTemporalDecision {
  if (plan.temporal.resolverVersion !== MEMORY_TEMPORAL_RESOLVER_VERSION) {
    return { disposition: "OMIT", qualification: null, reason: "temporal_resolver_mismatch", temporalFit: 0 };
  }
  const fit = memoryTemporalFit(plan, candidate);
  const range = candidateRange(candidate);
  if (plan.temporal.mode === "RANGE" && !overlaps(
    plan.temporal.from,
    plan.temporal.to,
    range.from,
    range.to
  )) {
    return { disposition: "OMIT", qualification: null, reason: "outside_requested_time", temporalFit: 0 };
  }
  if (candidate.metadata.historical && plan.temporal.mode === "CURRENT") {
    return { disposition: "OMIT", qualification: null, reason: "historical_not_requested", temporalFit: 0 };
  }
  if (plan.temporal.mode === "AMBIGUOUS") {
    return { disposition: "OMIT", qualification: null, reason: "temporal_time_ambiguous", temporalFit: 0 };
  }
  if (fit <= 0) {
    return {
      disposition: "OMIT",
      qualification: null,
      reason: plan.temporal.mode === "HISTORICAL"
        ? "current_fact_not_historical"
        : "outside_requested_time",
      temporalFit: 0
    };
  }
  if (candidate.metadata.conflict) {
    return {
      disposition: "INCLUDE_QUALIFIED",
      qualification: qualification(plan, "CONFLICT"),
      reason: "unresolved_conflict",
      temporalFit: fit
    };
  }
  if (
    candidate.itemType === "FACT_VERSION" &&
    candidate.metadata.modality !== null &&
    ["CONSIDERATION", "INTENTION", "PLAN"].includes(candidate.metadata.modality)
  ) {
    return {
      disposition: "INCLUDE_QUALIFIED",
      qualification: qualification(plan, "UNCONFIRMED"),
      reason: "unconfirmed_modality",
      temporalFit: fit
    };
  }
  if (candidate.metadata.historical || plan.temporal.mode === "HISTORICAL") {
    return {
      disposition: "INCLUDE_QUALIFIED",
      qualification: qualification(plan, "HISTORICAL"),
      reason: "historical_qualified",
      temporalFit: fit
    };
  }
  return {
    disposition: "INCLUDE_CURRENT",
    qualification: null,
    reason: "current_supported",
    temporalFit: fit
  };
}
