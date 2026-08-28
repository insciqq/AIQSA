import {
  MEMORY_RETRIEVAL_FUSION_VERSION,
  MEMORY_RETRIEVAL_LANE_WEIGHTS,
  MEMORY_RETRIEVAL_LANE_ORDER,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_RRF_K,
  MEMORY_RETRIEVAL_SUPPORTING_AUTHORITY_MULTIPLIER,
  MEMORY_RETRIEVAL_SYNTHESIS_AUTHORITY_MULTIPLIER,
  memoryRetrievalLaneLimit,
  type MemoryRetrievalLane
} from "./config";
import type {
  MemoryCandidateMetadata,
  MemoryDeterministicMatch,
  MemoryLaneCandidate,
  MemoryLaneResult,
  MemoryRankedCandidate,
  MemoryRetrievalPlan
} from "./contracts";
import { MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE } from
  "../../../contracts/memory";

type Aggregate = Readonly<{
  candidate: MemoryLaneCandidate;
  deterministicMatches: readonly MemoryDeterministicMatch[];
  laneRanks: Partial<Record<MemoryRetrievalLane, number>>;
  rrfScore: number;
}>;

function validDate(value: Date | null): boolean {
  return value === null || value instanceof Date && Number.isFinite(value.getTime());
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validOccurredInterval(value: MemoryCandidateMetadata): boolean {
  if (!value.occurredFrom || !value.occurredTo) return true;
  if (value.occurredFrom < value.occurredTo) return true;
  return value.occurredAt !== null &&
    value.occurredFrom.getTime() === value.occurredAt.getTime() &&
    value.occurredTo.getTime() === value.occurredAt.getTime();
}

function validMetadata(value: MemoryCandidateMetadata): boolean {
  return value.dedupeKey.length > 0 && value.dedupeKey.length <= 256 &&
    (value.evidenceRootHash === undefined || value.evidenceRootHash === null ||
      /^[a-f0-9]{64}$/u.test(value.evidenceRootHash)) &&
    (value.parentChunkId === undefined || value.parentChunkId === null ||
      value.parentChunkId.length > 0 && value.parentChunkId.length <= 256) &&
    validUnit(value.confidence) && validUnit(value.importance) &&
    validUnit(value.scopeAffinity) && validUnit(value.temperatureScore) &&
    [value.expectedAt, value.expiresAt, value.lastConfirmedAt, value.lastUsedAt,
      value.observedAt, value.occurredAt,
      value.occurredFrom, value.occurredTo, value.systemFrom, value.validFrom, value.validTo]
      .every(validDate) &&
    validOccurredInterval(value) &&
    (!value.validFrom || !value.validTo || value.validFrom < value.validTo) &&
    value.current !== value.historical &&
    Number.isSafeInteger(value.relationDepth) && value.relationDepth >= 0 &&
    Number.isSafeInteger(value.synthesisDepth) && value.synthesisDepth >= 0 &&
    value.entityIds.length <= 32 && new Set(value.entityIds).size === value.entityIds.length &&
    value.entityIds.every((id) => id.length > 0 && id.length <= 256) &&
    (value.current
      ? value.lifecycleState === "ACTIVE" ||
        value.sourceAuthority === "PAST_CHAT" ||
        value.sourceAuthority === "TOOL_OBSERVATION"
      : true) &&
    (value.historical ? value.lifecycleState === "SUPERSEDED" : true);
}

function candidateKey(candidate: Pick<
  MemoryLaneCandidate,
  "itemId" | "itemType" | "matchedSegmentId"
>): string {
  return `${candidate.itemType}:${candidate.itemId}` +
    (candidate.matchedSegmentId ? `:segment:${candidate.matchedSegmentId}` : "");
}

function validSegmentIdentity(candidate: MemoryLaneCandidate): boolean {
  const id = candidate.matchedSegmentId ?? null;
  const position = candidate.matchedSegmentPosition ?? null;
  if (id === null || position === null) return id === null && position === null;
  return candidate.itemType === "RECALL_ROUND" &&
    id.length > 0 && id.length <= 256 &&
    ["MIDDLE", "PREFIX", "SINGLE", "SUFFIX"].includes(position);
}

function historyRepresentationPriority(candidate: Pick<
  MemoryLaneCandidate,
  "itemType" | "matchedSegmentId"
>): number {
  return candidate.itemType === "RECALL_ROUND"
    ? candidate.matchedSegmentId ? 2 : 1
    : 0;
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function sameMetadata(left: MemoryCandidateMetadata, right: MemoryCandidateMetadata): boolean {
  return left.canonicalKey === right.canonicalKey && left.category === right.category &&
    left.confidence === right.confidence && left.conflict === right.conflict &&
    left.coreEligible === right.coreEligible && left.coreSalience === right.coreSalience &&
    left.current === right.current && left.dedupeKey === right.dedupeKey &&
    left.directness === right.directness && left.dimensionKey === right.dimensionKey &&
    left.entityIds.length === right.entityIds.length &&
    left.entityIds.every((id, index) => id === right.entityIds[index]) &&
    (left.evidenceRootHash ?? null) === (right.evidenceRootHash ?? null) &&
    sameDate(left.expectedAt, right.expectedAt) && sameDate(left.expiresAt, right.expiresAt) &&
    left.factId === right.factId &&
    left.historical === right.historical &&
    left.historySafetyClass === right.historySafetyClass &&
    left.importance === right.importance && left.identityKind === right.identityKind &&
    left.languageCode === right.languageCode &&
    sameDate(left.lastConfirmedAt, right.lastConfirmedAt) &&
    sameDate(left.lastUsedAt, right.lastUsedAt) &&
    left.lifecycleState === right.lifecycleState &&
    left.matchedEntityRole === right.matchedEntityRole &&
    left.modality === right.modality && sameDate(left.occurredFrom, right.occurredFrom) &&
    sameDate(left.occurredTo, right.occurredTo) &&
    sameDate(left.observedAt, right.observedAt) && sameDate(left.occurredAt, right.occurredAt) &&
    left.pinned === right.pinned && left.predicateKey === right.predicateKey &&
    (left.parentChunkId ?? null) === (right.parentChunkId ?? null) &&
    left.relationDepth === right.relationDepth &&
    left.scopeAffinity === right.scopeAffinity && left.scopeType === right.scopeType &&
    left.sensitivityClass === right.sensitivityClass &&
    left.sourceAssistantId === right.sourceAssistantId &&
    left.sourceChatId === right.sourceChatId && left.sourceFolderId === right.sourceFolderId &&
    left.sourceMode === right.sourceMode && left.sourceAuthority === right.sourceAuthority &&
    left.subjectKey === right.subjectKey && left.synthesisDepth === right.synthesisDepth &&
    sameDate(left.systemFrom, right.systemFrom) &&
    left.temperatureClass === right.temperatureClass &&
    left.temperatureScore === right.temperatureScore &&
    sameDate(left.validFrom, right.validFrom) && sameDate(left.validTo, right.validTo);
}

export function memoryCandidateIsSupportingObservation(
  metadata: MemoryCandidateMetadata
): boolean {
  return metadata.sourceAuthority === "DIRECT_AUTOMATIC" &&
    metadata.confidence === MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE;
}

export function memoryRetrievalAuthorityMultiplier(
  metadata: MemoryCandidateMetadata
): number {
  if (memoryCandidateIsSupportingObservation(metadata) ||
    metadata.sourceAuthority === "TOOL_OBSERVATION") {
    return MEMORY_RETRIEVAL_SUPPORTING_AUTHORITY_MULTIPLIER;
  }
  return metadata.sourceAuthority === "SYNTHESIS"
    ? MEMORY_RETRIEVAL_SYNTHESIS_AUTHORITY_MULTIPLIER
    : 1;
}

function authorityRank(metadata: MemoryCandidateMetadata): number {
  if (memoryCandidateIsSupportingObservation(metadata)) return 1;
  switch (metadata.sourceAuthority) {
    case "EXPLICIT": return 3;
    case "DIRECT_AUTOMATIC": return 2;
    case "SYNTHESIS": return 1;
    case "TOOL_OBSERVATION": return 1;
    case "PAST_CHAT": return 0;
  }
}

function temporalEvidenceInterval(metadata: MemoryCandidateMetadata): Readonly<{
  from: Date;
  to: Date;
}> | null {
  const point = metadata.occurredAt ?? metadata.expectedAt;
  const from = metadata.occurredFrom ?? point ?? metadata.validFrom ??
    metadata.observedAt ?? metadata.systemFrom;
  if (!from) return null;
  const to = metadata.occurredTo ?? (point ? point : metadata.validTo) ?? from;
  return { from, to };
}

function parsedTemporalFit(
  plan: MemoryRetrievalPlan,
  metadata: MemoryCandidateMetadata
): number | null {
  const query = plan.temporalQuery;
  if (query.state !== "MATCHED" || !query.interval || !query.confidence) return null;
  const evidence = temporalEvidenceInterval(metadata);
  if (!evidence) return query.confidence === "HIGH" ? 0.5 : 0.85;
  const pointEvidence = evidence.from.getTime() === evidence.to.getTime();
  const afterStart = query.interval.from === null ||
    evidence.to > query.interval.from ||
    pointEvidence && evidence.from >= query.interval.from;
  const beforeEnd = query.interval.to === null || evidence.from < query.interval.to;
  if (afterStart && beforeEnd) return 1;
  return query.confidence === "HIGH" ? 0.5 : 0.85;
}

function temporalFit(plan: MemoryRetrievalPlan, metadata: MemoryCandidateMetadata): number {
  const parsed = parsedTemporalFit(plan, metadata);
  if (parsed !== null) return parsed;
  switch (plan.temporalIntent) {
    case "CURRENT": return metadata.current ? 1 : 0;
    case "HISTORICAL": return metadata.historical ? 1 : 0.9;
    case "AS_OF":
    case "BETWEEN": return metadata.historical ? 1 : 0.95;
    case "ANY": return metadata.current ? 1 : 0.95;
  }
}

function boundedCandidates(
  plan: MemoryRetrievalPlan,
  results: readonly MemoryLaneResult[]
): readonly MemoryLaneCandidate[] {
  const candidateCeiling = plan.aggregationRequested
    ? MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES
    : MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES;
  const byLane = new Map<MemoryRetrievalLane, MemoryLaneCandidate[]>();
  for (const lane of MEMORY_RETRIEVAL_LANE_ORDER) byLane.set(lane, []);
  for (const result of results) {
    if (
      !MEMORY_RETRIEVAL_LANE_ORDER.includes(result.lane) ||
      (plan.profileRequested ? result.lane !== "FACT_PROFILE" : result.lane === "FACT_PROFILE")
    ) continue;
    const bucket = byLane.get(result.lane)!;
    for (const candidate of result.candidates) {
      if (
        candidate.lane !== result.lane || !candidate.hardFilterPassed ||
        !candidate.itemId || candidate.itemId.length > 256 ||
        !["FACT_VERSION", "RECALL_CHUNK", "RECALL_ROUND", "TOOL_EVENT"].includes(
          candidate.itemType
        ) ||
        !validSegmentIdentity(candidate) ||
        (result.lane === "FACT_PROFILE" && candidate.itemType !== "FACT_VERSION") ||
        !Number.isFinite(candidate.rawScore) || !validMetadata(candidate.metadata)
      ) continue;
      bucket.push(candidate);
    }
  }
  const bounded: MemoryLaneCandidate[] = [];
  for (const lane of MEMORY_RETRIEVAL_LANE_ORDER) {
    const laneCandidates: MemoryLaneCandidate[] = [];
    const seen = new Map<string, number>();
    const laneLimit = memoryRetrievalLaneLimit(lane, plan.aggregationRequested);
    for (const candidate of byLane.get(lane) ?? []) {
      const key = candidate.itemType === "FACT_VERSION"
        ? candidateKey(candidate)
        : memoryRetrievalEvidenceRootKey(candidate);
      const previousIndex = seen.get(key);
      if (previousIndex !== undefined) {
        const previous = laneCandidates[previousIndex]!;
        if (historyRepresentationPriority(candidate) >
          historyRepresentationPriority(previous)) {
          laneCandidates[previousIndex] = candidate;
        }
        continue;
      }
      if (laneCandidates.length >= laneLimit ||
        bounded.length + laneCandidates.length >= candidateCeiling) continue;
      seen.set(key, laneCandidates.length);
      laneCandidates.push(candidate);
    }
    bounded.push(...laneCandidates);
    if (bounded.length >= candidateCeiling) break;
  }
  return bounded;
}

function selectionReason(laneRanks: Aggregate["laneRanks"]): string {
  return MEMORY_RETRIEVAL_LANE_ORDER
    .filter((lane) => laneRanks[lane] !== undefined)
    .map((lane) => lane.toLocaleLowerCase("und"))
    .join("+");
}

export function memoryRetrievalEvidenceRootKey(
  candidate: Pick<MemoryLaneCandidate, "itemType" | "metadata">
): string {
  // The same projection reached through several lanes is one piece of
  // evidence, while byte-identical projections from different conversations
  // remain independent source roots.
  return candidate.itemType !== "FACT_VERSION"
    ? `history:${candidate.metadata.sourceChatId ?? "missing-source"}:` +
      (candidate.metadata.evidenceRootHash ?? candidate.metadata.dedupeKey)
    : `fact:${candidate.metadata.dedupeKey}`;
}

const deterministicMatchOrder: readonly MemoryDeterministicMatch[] = [
  "PROFILE", "EXACT_TEXT", "EXACT_ALIAS_SINGLE_ROOT"
];

/** Relative ranks are the only cross-lane score. Raw lexical and cosine values
 * remain per-lane diagnostics and are never combined or thresholded here. */
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
  for (const candidate of boundedCandidates(plan, results)) {
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
      deterministicMatches: deterministicMatchOrder.filter((match) =>
        previous?.deterministicMatches.includes(match) ||
        candidate.deterministicMatch === match),
      laneRanks: { ...(previous?.laneRanks ?? {}), [candidate.lane]: rank },
      rrfScore: (previous?.rrfScore ?? 0) +
        MEMORY_RETRIEVAL_LANE_WEIGHTS[candidate.lane] /
          (MEMORY_RETRIEVAL_RRF_K + rank)
    });
  }
  const itemRanked = [...aggregates.entries()].flatMap(([key, aggregate]) => {
    if (invalidKeys.has(key)) return [];
    const laneCount = Object.keys(aggregate.laneRanks).length;
    return [{
      entryId: aggregate.candidate.entryId,
      featureSnapshot: {
        authorityRank: authorityRank(aggregate.candidate.metadata),
        deterministicMatches: aggregate.deterministicMatches,
        directFactAuthority: aggregate.candidate.itemType === "FACT_VERSION" &&
          aggregate.candidate.entryId === null,
        fusionVersion: MEMORY_RETRIEVAL_FUSION_VERSION,
        laneCount,
        temporalFit: temporalFit(plan, aggregate.candidate.metadata),
        tier: "DYNAMIC" as const
      },
      finalScore: aggregate.rrfScore * memoryRetrievalAuthorityMultiplier(
        aggregate.candidate.metadata
      ),
      itemId: aggregate.candidate.itemId,
      itemType: aggregate.candidate.itemType,
      laneRanks: aggregate.laneRanks,
      matchedSegmentId: aggregate.candidate.matchedSegmentId ?? null,
      matchedSegmentPosition: aggregate.candidate.matchedSegmentPosition ?? null,
      metadata: aggregate.candidate.metadata,
      rrfScore: aggregate.rrfScore,
      selectionReason: selectionReason(aggregate.laneRanks)
    } satisfies MemoryRankedCandidate];
  }).sort((left, right) =>
    right.finalScore - left.finalScore ||
    right.featureSnapshot.temporalFit - left.featureSnapshot.temporalFit ||
    right.featureSnapshot.authorityRank - left.featureSnapshot.authorityRank ||
    left.itemType.localeCompare(right.itemType) ||
    left.itemId.localeCompare(right.itemId)
  );
  const byEvidenceRoot = new Map<string, MemoryRankedCandidate>();
  for (const candidate of itemRanked) {
    const root = memoryRetrievalEvidenceRootKey(candidate);
    const previous = byEvidenceRoot.get(root);
    if (!previous) {
      byEvidenceRoot.set(root, candidate);
      continue;
    }
    // Fact-root behavior remains first-wins. Equivalent history projections
    // instead contribute their distinct lane evidence once and select the
    // authoritative round representation over its parent chunk.
    if (candidate.itemType === "FACT_VERSION" ||
      previous.itemType === "FACT_VERSION") continue;
    const representative = historyRepresentationPriority(candidate) >
        historyRepresentationPriority(previous)
      ? candidate
      : previous;
    const laneRanks: Partial<Record<MemoryRetrievalLane, number>> = {
      ...previous.laneRanks
    };
    for (const lane of MEMORY_RETRIEVAL_LANE_ORDER) {
      const nextRank = candidate.laneRanks[lane];
      if (nextRank === undefined) continue;
      laneRanks[lane] = Math.min(laneRanks[lane] ?? nextRank, nextRank);
    }
    const rrfScore = MEMORY_RETRIEVAL_LANE_ORDER.reduce((sum, lane) => {
      const rank = laneRanks[lane];
      return rank === undefined
        ? sum
        : sum + MEMORY_RETRIEVAL_LANE_WEIGHTS[lane] /
          (MEMORY_RETRIEVAL_RRF_K + rank);
    }, 0);
    const deterministicMatches = deterministicMatchOrder.filter((match) =>
      previous.featureSnapshot.deterministicMatches?.includes(match) ||
      candidate.featureSnapshot.deterministicMatches?.includes(match));
    byEvidenceRoot.set(root, {
      ...representative,
      featureSnapshot: {
        ...representative.featureSnapshot,
        deterministicMatches,
        laneCount: Object.keys(laneRanks).length
      },
      finalScore: rrfScore,
      laneRanks,
      rrfScore,
      selectionReason: selectionReason(laneRanks)
    });
  }
  return [...byEvidenceRoot.values()].sort((left, right) =>
    right.finalScore - left.finalScore ||
    right.featureSnapshot.temporalFit - left.featureSnapshot.temporalFit ||
    right.featureSnapshot.authorityRank - left.featureSnapshot.authorityRank ||
    Number(right.itemType === "RECALL_ROUND") -
      Number(left.itemType === "RECALL_ROUND") ||
    left.itemType.localeCompare(right.itemType) ||
    left.itemId.localeCompare(right.itemId)
  ).slice(0, plan.aggregationRequested
    ? MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES
    : MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES);
}
