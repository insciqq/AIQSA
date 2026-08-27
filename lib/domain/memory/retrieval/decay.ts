import type {
  MemoryCandidateMetadata,
  MemoryRankedCandidate,
  MemoryRetrievalFeatureSnapshot,
  MemoryRetrievalMode
} from "./contracts";

export const MEMORY_DECAY_POLICY_VERSION = "memory-decay-v1";
export const MEMORY_DECAY_MIN_FACTOR = 0.3;
export const MEMORY_DECAY_MAX_FACTOR = 1.5;
export const MEMORY_DECAY_MAX_RETAINED_TOUCHES = 20;
export const MEMORY_DECAY_TOUCH_INCREMENT =
  1 / MEMORY_DECAY_MAX_RETAINED_TOUCHES;

const DAY_MS = 24 * 60 * 60 * 1_000;

type DecayAnchor = NonNullable<MemoryRetrievalFeatureSnapshot["decayAnchor"]>;

export type MemoryDecayFactor = Readonly<{
  anchor: DecayAnchor | null;
  factor: number;
}>;

function finiteDate(value: Date | null, now: Date): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) &&
    value.getTime() <= now.getTime()
    ? value
    : null;
}

function anchor(
  metadata: MemoryCandidateMetadata,
  now: Date
): Readonly<{ at: Date; kind: DecayAnchor }> | null {
  const choices = [
    [metadata.lastUsedAt, "LAST_USED"],
    [metadata.lastConfirmedAt, "LAST_CONFIRMED"],
    [metadata.occurredAt, "OCCURRED"],
    [metadata.observedAt, "OBSERVED"],
    [metadata.systemFrom, "SYSTEM_FROM"]
  ] as const;
  for (const [value, kind] of choices) {
    const at = finiteDate(value, now);
    if (at) return { at, kind };
  }
  return null;
}

function policyShape(metadata: MemoryCandidateMetadata): Readonly<{
  floor: number;
  halfLifeDays: number;
}> {
  if (metadata.sourceAuthority === "SYNTHESIS" || metadata.modality === "PATTERN") {
    return { floor: 0.3, halfLifeDays: 90 };
  }
  if (metadata.sourceAuthority === "EXPLICIT") {
    return { floor: 0.8, halfLifeDays: 720 };
  }
  if (
    metadata.sourceAuthority === "DIRECT_AUTOMATIC" && metadata.confidence === 1 &&
    metadata.current &&
    (metadata.identityKind === "SLOT" || metadata.modality === "STATE")
  ) {
    return { floor: 0.85, halfLifeDays: 540 };
  }
  return { floor: 0.5, halfLifeDays: 180 };
}

function bounded(value: number): number {
  return Math.min(MEMORY_DECAY_MAX_FACTOR, Math.max(MEMORY_DECAY_MIN_FACTOR, value));
}

/** Versioned search-time policy. expectedAt and mutable index/update time are
 * deliberately absent from the fallback chain. */
export function memoryDecayFactor(
  metadata: MemoryCandidateMetadata,
  input: Readonly<{ historical: boolean; now: Date }>
): MemoryDecayFactor {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("memory_decay_time_invalid");
  }
  if (!Number.isFinite(metadata.temperatureScore) ||
    metadata.temperatureScore < 0 || metadata.temperatureScore > 1) {
    throw new Error("memory_decay_metadata_invalid");
  }
  const selected = anchor(metadata, input.now);
  if (!selected) return { anchor: null, factor: 1 };

  const shape = policyShape(metadata);
  const historyMultiplier = input.historical ? 4 : 1;
  const ageDays = Math.max(0, input.now.getTime() - selected.at.getTime()) / DAY_MS;
  const freshness = 2 ** (-ageDays / (shape.halfLifeDays * historyMultiplier));
  const recency = shape.floor + (1 - shape.floor) * freshness;
  const useFreshness = selected.kind === "LAST_USED"
    ? 2 ** (-ageDays / (180 * historyMultiplier))
    : 0;
  const reuseBoost = metadata.temperatureScore * 0.5 * useFreshness;
  const authorityFloor = metadata.current && metadata.identityKind === "SLOT" &&
    (metadata.pinned || metadata.sourceAuthority === "EXPLICIT")
    ? 1
    : MEMORY_DECAY_MIN_FACTOR;
  const factor = bounded(Math.max(authorityFloor, recency + reuseBoost));
  return {
    anchor: selected.kind,
    factor: Math.round(factor * 1_000_000) / 1_000_000
  };
}

function chronological(candidate: MemoryRankedCandidate): number {
  return (candidate.metadata.occurredAt ?? candidate.metadata.validFrom ??
    candidate.metadata.observedAt ?? candidate.metadata.systemFrom)?.getTime() ?? 0;
}

/** Applies only after authoritative rejoin and optional semantic ordering.
 * Disabled or unknown policy versions return the exact original array and objects. */
export function applyMemoryDecay(
  candidates: readonly MemoryRankedCandidate[],
  input: Readonly<{
    enabled: boolean;
    mode: MemoryRetrievalMode;
    now: Date;
    policyVersion: string | null;
  }>
): readonly MemoryRankedCandidate[] {
  if (!input.enabled || input.policyVersion !== MEMORY_DECAY_POLICY_VERSION) {
    return candidates;
  }
  const historical = input.mode === "HISTORICAL_MEMORY";
  const scored = candidates.map((candidate) => {
    const decay = candidate.itemType === "FACT_VERSION"
      ? memoryDecayFactor(candidate.metadata, { historical, now: input.now })
      : { anchor: null, factor: 1 } as const;
    const adjustedScore = candidate.finalScore * decay.factor;
    return {
      adjustedScore,
      candidate: {
        ...candidate,
        featureSnapshot: {
          ...candidate.featureSnapshot,
          decayAdjustedScore: adjustedScore,
          decayAnchor: decay.anchor,
          decayFactor: decay.factor,
          decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION
        }
      }
    };
  });
  scored.sort((left, right) => {
    if (historical) {
      const order = chronological(left.candidate) - chronological(right.candidate);
      if (order !== 0) return order;
    }
    return right.adjustedScore - left.adjustedScore ||
      right.candidate.finalScore - left.candidate.finalScore ||
      left.candidate.itemType.localeCompare(right.candidate.itemType) ||
      left.candidate.itemId.localeCompare(right.candidate.itemId);
  });
  return scored.map(({ candidate }) => candidate);
}
