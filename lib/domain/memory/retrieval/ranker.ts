import {
  MEMORY_RETRIEVAL_FEATURE_VERSION,
  MEMORY_RETRIEVAL_FEATURE_WEIGHTS,
  MEMORY_RETRIEVAL_LANE_LIMITS,
  MEMORY_RETRIEVAL_LANE_ORDER,
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_MIN_FINAL_SCORE,
  MEMORY_RETRIEVAL_RRF_K,
  type MemoryRetrievalLane
} from "./config";
import type {
  MemoryCandidateMetadata,
  MemoryLaneCandidate,
  MemoryLaneResult,
  MemoryRankedCandidate,
  MemoryRetrievalFeatureSnapshot,
  MemoryRetrievalPlan
} from "./contracts";
import { memoryTemporalFit } from "./temporal";

type Aggregate = Readonly<{
  candidate: MemoryLaneCandidate;
  laneRanks: Partial<Record<MemoryRetrievalLane, number>>;
  rrfScore: number;
}>;

function validDate(value: Date | null): boolean {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validMetadata(value: MemoryCandidateMetadata): boolean {
  return value.dedupeKey.length > 0 && value.dedupeKey.length <= 256 &&
    validUnit(value.confidence) && validUnit(value.importance) && validUnit(value.scopeAffinity) &&
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
        !["EPISODE", "FACT_VERSION", "RECALL_CHUNK"].includes(candidate.itemType) ||
        !Number.isFinite(candidate.rawScore) || candidate.rawScore <= 0 ||
        !validMetadata(candidate.metadata)
      ) continue;
      bucket.push(candidate);
    }
  }
  const bounded: MemoryLaneCandidate[] = [];
  for (const lane of MEMORY_RETRIEVAL_LANE_ORDER) {
    const seen = new Set<string>();
    const limit = MEMORY_RETRIEVAL_LANE_LIMITS[lane];
    for (const candidate of byLane.get(lane) ?? []) {
      const key = candidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      bounded.push(candidate);
      if (seen.size >= limit || bounded.length >= MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES) break;
    }
    if (bounded.length >= MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES) break;
  }
  return bounded;
}

function exactCanonical(plan: MemoryRetrievalPlan, aggregate: Aggregate): number {
  const key = aggregate.candidate.metadata.canonicalKey;
  if (aggregate.laneRanks.FACT_CANONICAL !== undefined) return 1;
  return key && plan.canonicalKeyHints.includes(key) ? 1 : 0;
}

function languageMatch(plan: MemoryRetrievalPlan, languageCode: string): number {
  const normalized = languageCode.toLocaleLowerCase("und");
  if (plan.language === "MIXED" || normalized === "auto") return 0.75;
  if (plan.language === "RU") return normalized.startsWith("ru") ? 1 : 0;
  if (plan.language === "EN") return normalized.startsWith("en") ? 1 : 0;
  return 0.5;
}

function temperature(value: MemoryCandidateMetadata["temperatureClass"]): number {
  if (value === "HOT") return 1;
  if (value === "WARM") return 0.6;
  if (value === "COLD") return 0.2;
  return 0.5;
}

function directness(value: MemoryCandidateMetadata["directness"]): number {
  if (value === "DIRECT") return 1;
  if (value === "PARAPHRASED") return 0.65;
  if (value === "INFERRED") return 0.2;
  return 0.5;
}

function sourceRecency(metadata: MemoryCandidateMetadata, now: Date): number {
  const date = metadata.occurredTo ?? metadata.occurredFrom ?? metadata.systemFrom;
  if (!date) return 0.5;
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1_000));
  return Math.exp(-ageDays / 365);
}

function features(
  plan: MemoryRetrievalPlan,
  aggregate: Aggregate,
  now: Date
): MemoryRetrievalFeatureSnapshot {
  const metadata = aggregate.candidate.metadata;
  return {
    conflictPenalty: metadata.conflict ? 1 : 0,
    currentness: metadata.current ? 1 : 0,
    directness: directness(metadata.directness),
    exactCanonical: exactCanonical(plan, aggregate),
    exactEntity: aggregate.laneRanks.HISTORY_ENTITY_TIME !== undefined ? 1 : 0,
    explicitAuthority: metadata.sourceMode === "EXPLICIT" ? 1 : 0,
    featureVersion: MEMORY_RETRIEVAL_FEATURE_VERSION,
    importance: metadata.importance,
    languageMatch: languageMatch(plan, metadata.languageCode),
    pinned: metadata.pinned ? 1 : 0,
    scopeAffinity: metadata.scopeAffinity,
    sensitivityPenalty: metadata.sensitivityClass === "SENSITIVE" ||
      metadata.historySafetyClass === "SENSITIVE" ? 1 : 0,
    sourceRecency: sourceRecency(metadata, now),
    temporalFit: memoryTemporalFit(plan, {
      itemType: aggregate.candidate.itemType,
      metadata
    }),
    temperature: temperature(metadata.temperatureClass)
  };
}

function weightedScore(snapshot: MemoryRetrievalFeatureSnapshot): number {
  return snapshot.conflictPenalty * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.conflictPenalty +
    snapshot.currentness * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.currentness +
    snapshot.directness * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.directness +
    snapshot.exactCanonical * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.exactCanonical +
    snapshot.exactEntity * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.exactEntity +
    snapshot.explicitAuthority * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.explicitAuthority +
    snapshot.importance * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.importance +
    snapshot.languageMatch * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.languageMatch +
    snapshot.pinned * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.pinned +
    snapshot.scopeAffinity * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.scopeAffinity +
    snapshot.sensitivityPenalty * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.sensitivityPenalty +
    snapshot.sourceRecency * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.sourceRecency +
    snapshot.temporalFit * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.temporalFit +
    snapshot.temperature * MEMORY_RETRIEVAL_FEATURE_WEIGHTS.temperature;
}

function selectionReason(laneRanks: Aggregate["laneRanks"]): string {
  return MEMORY_RETRIEVAL_LANE_ORDER
    .filter((lane) => laneRanks[lane] !== undefined)
    .map((lane) => lane.toLocaleLowerCase("und"))
    .join("+");
}

export function fuseMemoryRetrievalCandidates(
  plan: MemoryRetrievalPlan,
  results: readonly MemoryLaneResult[],
  now: Date
): readonly MemoryRankedCandidate[] {
  if (!plan.retrievalAllowed || plan.intent === "NONE") return [];
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("memory_retrieval_rank_invalid");
  }
  const candidates = boundedCandidates(results);
  const aggregates = new Map<string, Aggregate>();
  const invalidKeys = new Set<string>();
  const laneRanks = new Map<MemoryRetrievalLane, number>();
  for (const candidate of candidates) {
    const rank = (laneRanks.get(candidate.lane) ?? 0) + 1;
    laneRanks.set(candidate.lane, rank);
    const key = candidateKey(candidate);
    const previous = aggregates.get(key);
    if (previous && !sameMetadata(previous.candidate.metadata, candidate.metadata)) {
      invalidKeys.add(key);
      continue;
    }
    const ranks = { ...(previous?.laneRanks ?? {}), [candidate.lane]: rank };
    aggregates.set(key, {
      candidate: previous?.candidate ?? candidate,
      laneRanks: ranks,
      rrfScore: (previous?.rrfScore ?? 0) + 1 / (MEMORY_RETRIEVAL_RRF_K + rank)
    });
  }
  const ranked = [...aggregates.entries()].flatMap(([key, aggregate]) => {
    if (invalidKeys.has(key)) return [];
    const featureSnapshot = features(plan, aggregate, now);
    const finalScore = aggregate.rrfScore + weightedScore(featureSnapshot);
    if (!Number.isFinite(finalScore) || finalScore < MEMORY_RETRIEVAL_MIN_FINAL_SCORE ||
      featureSnapshot.temporalFit <= 0) return [];
    return [{
      entryId: aggregate.candidate.entryId,
      featureSnapshot,
      finalScore,
      itemId: aggregate.candidate.itemId,
      itemType: aggregate.candidate.itemType,
      laneRanks: aggregate.laneRanks,
      metadata: aggregate.candidate.metadata,
      rrfScore: aggregate.rrfScore,
      selectionReason: selectionReason(aggregate.laneRanks)
    } satisfies MemoryRankedCandidate];
  }).sort((left, right) =>
    right.finalScore - left.finalScore ||
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
