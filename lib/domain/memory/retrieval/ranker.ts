import {
  MEMORY_RETRIEVAL_FUSION_VERSION,
  MEMORY_RETRIEVAL_LANE_LIMITS,
  MEMORY_RETRIEVAL_LANE_ORDER,
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_RRF_K,
  type MemoryRetrievalLane
} from "./config";
import type {
  MemoryCandidateMetadata,
  MemoryLaneCandidate,
  MemoryLaneResult,
  MemoryRankedCandidate,
  MemoryRetrievalPlan
} from "./contracts";

type Aggregate = Readonly<{
  candidate: MemoryLaneCandidate;
  laneRanks: Partial<Record<MemoryRetrievalLane, number>>;
  rrfScore: number;
}>;

function validDate(value: Date | null): boolean {
  return value === null || value instanceof Date && Number.isFinite(value.getTime());
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validMetadata(value: MemoryCandidateMetadata): boolean {
  return value.dedupeKey.length > 0 && value.dedupeKey.length <= 256 &&
    validUnit(value.confidence) && validUnit(value.importance) &&
    validUnit(value.scopeAffinity) &&
    [value.occurredFrom, value.occurredTo, value.systemFrom, value.validFrom, value.validTo]
      .every(validDate) &&
    (!value.occurredFrom || !value.occurredTo || value.occurredFrom < value.occurredTo) &&
    (!value.validFrom || !value.validTo || value.validFrom < value.validTo) &&
    value.current !== value.historical;
}

function candidateKey(candidate: Pick<MemoryLaneCandidate, "itemId" | "itemType">): string {
  return `${candidate.itemType}:${candidate.itemId}`;
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function sameMetadata(left: MemoryCandidateMetadata, right: MemoryCandidateMetadata): boolean {
  return left.canonicalKey === right.canonicalKey && left.category === right.category &&
    left.confidence === right.confidence && left.conflict === right.conflict &&
    left.coreEligible === right.coreEligible && left.coreSalience === right.coreSalience &&
    left.current === right.current && left.dedupeKey === right.dedupeKey &&
    left.directness === right.directness && left.factId === right.factId &&
    left.historical === right.historical &&
    left.historySafetyClass === right.historySafetyClass &&
    left.importance === right.importance && left.languageCode === right.languageCode &&
    left.modality === right.modality && sameDate(left.occurredFrom, right.occurredFrom) &&
    sameDate(left.occurredTo, right.occurredTo) && left.pinned === right.pinned &&
    left.scopeAffinity === right.scopeAffinity && left.scopeType === right.scopeType &&
    left.sensitivityClass === right.sensitivityClass &&
    left.sourceAssistantId === right.sourceAssistantId &&
    left.sourceChatId === right.sourceChatId && left.sourceFolderId === right.sourceFolderId &&
    left.sourceMode === right.sourceMode && sameDate(left.systemFrom, right.systemFrom) &&
    left.temperatureClass === right.temperatureClass &&
    sameDate(left.validFrom, right.validFrom) && sameDate(left.validTo, right.validTo);
}

function boundedCandidates(results: readonly MemoryLaneResult[]): readonly MemoryLaneCandidate[] {
  const byLane = new Map<MemoryRetrievalLane, MemoryLaneCandidate[]>();
  for (const lane of MEMORY_RETRIEVAL_LANE_ORDER) byLane.set(lane, []);
  for (const result of results) {
    if (!MEMORY_RETRIEVAL_LANE_ORDER.includes(result.lane)) continue;
    const bucket = byLane.get(result.lane)!;
    for (const candidate of result.candidates) {
      if (
        candidate.lane !== result.lane || !candidate.hardFilterPassed ||
        !candidate.itemId || candidate.itemId.length > 256 ||
        !["FACT_VERSION", "RECALL_CHUNK"].includes(candidate.itemType) ||
        !Number.isFinite(candidate.rawScore) || !validMetadata(candidate.metadata)
      ) continue;
      bucket.push(candidate);
    }
  }
  const bounded: MemoryLaneCandidate[] = [];
  for (const lane of MEMORY_RETRIEVAL_LANE_ORDER) {
    const seen = new Set<string>();
    for (const candidate of byLane.get(lane) ?? []) {
      const key = candidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      bounded.push(candidate);
      if (
        seen.size >= MEMORY_RETRIEVAL_LANE_LIMITS[lane] ||
        bounded.length >= MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES
      ) break;
    }
    if (bounded.length >= MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES) break;
  }
  return bounded;
}

function selectionReason(laneRanks: Aggregate["laneRanks"]): string {
  return MEMORY_RETRIEVAL_LANE_ORDER
    .filter((lane) => laneRanks[lane] !== undefined)
    .map((lane) => lane.toLocaleLowerCase("und"))
    .join("+");
}

/** Relative ranks are the only cross-lane score. Raw lexical and cosine values
 * remain inspection evidence and are never combined or thresholded here. */
export function fuseMemoryRetrievalCandidates(
  plan: MemoryRetrievalPlan,
  results: readonly MemoryLaneResult[],
  now: Date
): readonly MemoryRankedCandidate[] {
  if (!plan.queryPresent) return [];
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("memory_retrieval_rank_invalid");
  }
  const aggregates = new Map<string, Aggregate>();
  const invalidKeys = new Set<string>();
  const ranksByLane = new Map<MemoryRetrievalLane, number>();
  for (const candidate of boundedCandidates(results)) {
    const rank = (ranksByLane.get(candidate.lane) ?? 0) + 1;
    ranksByLane.set(candidate.lane, rank);
    const key = candidateKey(candidate);
    const previous = aggregates.get(key);
    if (previous && !sameMetadata(previous.candidate.metadata, candidate.metadata)) {
      invalidKeys.add(key);
      continue;
    }
    aggregates.set(key, {
      candidate: previous?.candidate ?? candidate,
      laneRanks: { ...(previous?.laneRanks ?? {}), [candidate.lane]: rank },
      rrfScore: (previous?.rrfScore ?? 0) + 1 / (MEMORY_RETRIEVAL_RRF_K + rank)
    });
  }
  const ranked = [...aggregates.entries()].flatMap(([key, aggregate]) => {
    if (invalidKeys.has(key)) return [];
    const laneCount = Object.keys(aggregate.laneRanks).length;
    return [{
      entryId: aggregate.candidate.entryId,
      featureSnapshot: {
        fusionVersion: MEMORY_RETRIEVAL_FUSION_VERSION,
        laneCount,
        tier: "DYNAMIC" as const
      },
      finalScore: aggregate.rrfScore,
      itemId: aggregate.candidate.itemId,
      itemType: aggregate.candidate.itemType,
      laneRanks: aggregate.laneRanks,
      metadata: aggregate.candidate.metadata,
      rrfScore: aggregate.rrfScore,
      selectionReason: selectionReason(aggregate.laneRanks)
    } satisfies MemoryRankedCandidate];
  }).sort((left, right) =>
    right.rrfScore - left.rrfScore ||
    left.itemType.localeCompare(right.itemType) ||
    left.itemId.localeCompare(right.itemId)
  );
  const dedupe = new Set<string>();
  return ranked.filter((candidate) => {
    if (dedupe.has(candidate.metadata.dedupeKey)) return false;
    dedupe.add(candidate.metadata.dedupeKey);
    return true;
  }).slice(0, MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES);
}
