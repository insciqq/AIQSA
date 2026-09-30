import type {
  MemoryDirectness,
  MemoryFactModality,
  MemoryFactSourceMode,
  MemorySensitivityClass
} from "@prisma/client";
import { memorySha256 } from "../persistence/lexical";
import { MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS } from "../../../domain/memory/retrieval/config";

export const MEMORY_SYNTHESIS_PIPELINE_VERSION = "memory-synthesis-v2";
export const MEMORY_SYNTHESIS_POLICY_VERSION = "memory-synthesis-policy-v6";
export const MEMORY_SYNTHESIS_PROMPT_VERSION = "memory-synthesis-prompt-v9";
export const MEMORY_SYNTHESIS_SCHEMA_VERSION = "memory-synthesis-schema-v4";
export const MEMORY_SYNTHESIS_RETRIEVAL_CONFIG_FINGERPRINT =
  "memory-synthesis-retrieval-none-v1";

export const MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES = 3;
export const MEMORY_SYNTHESIS_MIN_COMBINED_SOURCES = 2;
export const MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES =
  MEMORY_SYNTHESIS_MIN_COMBINED_SOURCES;
export const MEMORY_SYNTHESIS_COMBINED_REASONS = [
  "combined_overlapping_facts",
  "combined_refined_facts",
  "combined_episode_facts"
] as const;

export function memorySynthesisIsCombination(reasonCode: string): boolean {
  return (MEMORY_SYNTHESIS_COMBINED_REASONS as readonly string[]).includes(reasonCode);
}
export const MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER = 8;
export const MEMORY_SYNTHESIS_NEW_FACT_TRIGGER = 12;
export const MEMORY_SYNTHESIS_QUIET_PERIOD_MS = 30 * 60 * 1_000;
export const MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_SYNTHESIS_MAX_SOURCES = 40;
export const MEMORY_SYNTHESIS_MAX_CLUSTERS = 8;
export const MEMORY_SYNTHESIS_MAX_PATTERNS = 4;
export const MEMORY_SYNTHESIS_MAX_SOURCE_CHARACTERS = 48_000;
export const MEMORY_SYNTHESIS_CLUSTER_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;
export const MEMORY_SYNTHESIS_COOLDOWN_MS = 12 * 60 * 60 * 1_000;
export const MEMORY_SYNTHESIS_MAX_SCHEDULED_OWNERS = 24;
export const MEMORY_SYNTHESIS_AUTHORITY_MULTIPLIER = 0.5;

export type MemorySynthesisActivity = Readonly<{
  changedFactCount: number;
  eligibleSourceCount: number;
  firstChangedAt: Date | null;
  lastChangedAt: Date | null;
  lastSynthesisAt: Date | null;
  newEvidenceChatCount: number;
}>;

export type MemorySynthesisScheduleReason =
  | "ACCUMULATING"
  | "CHAT_ACTIVITY"
  | "COOLDOWN"
  | "FACT_ACTIVITY"
  | "INSUFFICIENT_SOURCES"
  | "INVALID"
  | "LOW_ACTIVITY_FALLBACK"
  | "NO_NEW_ACTIVITY"
  | "QUIET_PERIOD";

export type MemorySynthesisScheduleDecision = Readonly<{
  due: boolean;
  reason: MemorySynthesisScheduleReason;
}>;

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Dream scheduling follows evidence-bearing activity, never wall-clock polling
 * alone. The quiet period avoids synthesizing a conversation while it is still
 * changing; the cooldown is only a cost/race ceiling, not a periodic trigger.
 */
export function decideMemorySynthesisSchedule(
  activity: MemorySynthesisActivity,
  now: Date
): MemorySynthesisScheduleDecision {
  const datesValid = validDate(now) &&
    (activity.firstChangedAt === null || validDate(activity.firstChangedAt)) &&
    (activity.lastChangedAt === null || validDate(activity.lastChangedAt)) &&
    (activity.lastSynthesisAt === null || validDate(activity.lastSynthesisAt));
  if (
    !datesValid ||
    !nonNegativeInteger(activity.changedFactCount) ||
    !nonNegativeInteger(activity.eligibleSourceCount) ||
    !nonNegativeInteger(activity.newEvidenceChatCount) ||
    (activity.firstChangedAt === null) !== (activity.lastChangedAt === null) ||
    (activity.firstChangedAt !== null && activity.lastChangedAt !== null &&
      activity.firstChangedAt > activity.lastChangedAt)
  ) {
    return { due: false, reason: "INVALID" };
  }
  if (activity.eligibleSourceCount < MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES) {
    return { due: false, reason: "INSUFFICIENT_SOURCES" };
  }
  if (
    activity.firstChangedAt === null || activity.lastChangedAt === null ||
    (activity.changedFactCount === 0 && activity.newEvidenceChatCount === 0)
  ) {
    return { due: false, reason: "NO_NEW_ACTIVITY" };
  }
  if (
    activity.lastSynthesisAt !== null &&
    activity.lastSynthesisAt.getTime() + MEMORY_SYNTHESIS_COOLDOWN_MS >
      now.getTime()
  ) {
    return { due: false, reason: "COOLDOWN" };
  }
  if (
    activity.lastChangedAt.getTime() + MEMORY_SYNTHESIS_QUIET_PERIOD_MS >
      now.getTime()
  ) {
    return { due: false, reason: "QUIET_PERIOD" };
  }
  if (activity.newEvidenceChatCount >= MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER) {
    return { due: true, reason: "CHAT_ACTIVITY" };
  }
  if (activity.changedFactCount >= MEMORY_SYNTHESIS_NEW_FACT_TRIGGER) {
    return { due: true, reason: "FACT_ACTIVITY" };
  }
  if (
    activity.firstChangedAt.getTime() +
      MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS <= now.getTime()
  ) {
    return { due: true, reason: "LOW_ACTIVITY_FALLBACK" };
  }
  return { due: false, reason: "ACCUMULATING" };
}

export type MemorySynthesisSource = Readonly<{
  canonicalKey: string;
  category: string;
  confidence: number;
  directness: MemoryDirectness;
  displayText: string;
  eligibilityHash: string;
  entityIds: readonly string[];
  factId: string;
  ingestionFingerprint: string | null;
  memoryGeneration: number;
  modality: MemoryFactModality;
  observedAt: Date;
  predicateKey: string | null;
  sourceChatIds: readonly string[];
  sourceMessageIds: readonly string[];
  sourceMode: MemoryFactSourceMode;
  sensitivityClass: MemorySensitivityClass;
  /** Exact current-source temporal bounds; observedAt is testimony time only. */
  validFrom?: Date | null;
  validTo?: Date | null;
  /** Stored semantic scope, used to keep relationship subjects isolated. */
  subjectScope?: "CURRENT_USER" | "USER_RELATIONSHIP_CONTEXT" | null;
  /** Root entity ids linked with role SUBJECT, preserving the grounded anchor. */
  subjectEntityIds?: readonly string[];
  structuredValue: unknown;
  subjectKey: string | null;
  versionId: string;
}>;

export type MemorySynthesisBoundSource = MemorySynthesisSource & Readonly<{
  entityRefs: readonly string[];
  ref: string;
}>;

export type MemorySynthesisEntityBinding = Readonly<{
  entityId: string;
  ref: string;
}>;

export type MemorySynthesisCluster = Readonly<{
  entityRefs: readonly string[];
  key: string;
  sources: readonly MemorySynthesisBoundSource[];
  subjectKey: string;
}>;

export type MemorySynthesisPlan = Readonly<{
  clusters: readonly MemorySynthesisCluster[];
  entityBindings: readonly MemorySynthesisEntityBinding[];
  sourceSetFingerprint: string;
  sourceSnapshotHash: string;
  sources: readonly MemorySynthesisBoundSource[];
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sourceSort(left: MemorySynthesisSource, right: MemorySynthesisSource): number {
  return right.observedAt.getTime() - left.observedAt.getTime() ||
    left.versionId.localeCompare(right.versionId);
}

export function memorySynthesisSourceEligibilityHash(input: Readonly<{
  canonicalKey: string;
  directness: MemoryDirectness;
  factId: string;
  ingestionFingerprint: string | null;
  memoryGeneration: number;
  modality: MemoryFactModality;
  observedAt: Date;
  pipelineVersion: string;
  sourceMode: MemoryFactSourceMode;
  versionId: string;
}>): string {
  return memorySha256({
    canonicalKey: input.canonicalKey,
    directness: input.directness,
    domain: "aiqsa.memory.synthesis-source-eligibility",
    factId: input.factId,
    ingestionFingerprint: input.ingestionFingerprint,
    memoryGeneration: input.memoryGeneration,
    modality: input.modality,
    observedAt: input.observedAt.toISOString(),
    pipelineVersion: input.pipelineVersion,
    sourceMode: input.sourceMode,
    version: 1,
    versionId: input.versionId
  });
}

export function memorySynthesisSourceSetFingerprint(input: Readonly<{
  generation: number;
  sources: readonly Pick<MemorySynthesisSource, "eligibilityHash" | "versionId">[];
}>): string {
  return memorySha256({
    domain: "aiqsa.memory.synthesis-source-set",
    generation: input.generation,
    pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
    policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
    promptVersion: MEMORY_SYNTHESIS_PROMPT_VERSION,
    schemaVersion: MEMORY_SYNTHESIS_SCHEMA_VERSION,
    sources: [...input.sources]
      .sort((left, right) => left.versionId.localeCompare(right.versionId))
      .map(({ eligibilityHash, versionId }) => ({ eligibilityHash, versionId })),
    version: 2
  });
}

export function memorySynthesisJobFingerprint(input: Readonly<{
  sourceSetFingerprint: string;
  targetFactVersionId?: string;
  userId: string;
}>): string {
  return memorySha256({
    domain: "aiqsa.memory.synthesis-job",
    pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
    sourceSetFingerprint: input.sourceSetFingerprint,
    targetFactVersionId: input.targetFactVersionId,
    userId: input.userId,
    version: 2
  });
}

export function memorySynthesisPatternFingerprint(input: Readonly<{
  canonicalPatternIdentity: string;
  sourceEligibilityHashes: readonly string[];
}>): string {
  return memorySha256({
    canonicalPatternIdentity: input.canonicalPatternIdentity,
    domain: "aiqsa.memory.synthesis-pattern",
    policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
    sourceEligibilityHashes: [...input.sourceEligibilityHashes].sort(),
    version: 3
  });
}

function clusterKey(source: MemorySynthesisSource): string {
  // Only a grounded subject can join facts. Mentioned entities alone do not
  // identify a subject, especially for explicit Saved Memories.
  const subjectEntityAnchor = [...(source.subjectEntityIds ?? [])].sort()[0] ?? null;
  if (source.subjectScope === "CURRENT_USER") return "owner:current-user";
  if (subjectEntityAnchor) return `subject-entity:${subjectEntityAnchor}`;
  if (source.subjectKey) return `subject:${source.subjectKey}`;
  return `fact:${source.canonicalKey}`;
}

function diversityScore(sources: readonly MemorySynthesisBoundSource[]): number {
  const messages = new Set(sources.flatMap(({ sourceMessageIds }) => sourceMessageIds));
  const chats = new Set(sources.flatMap(({ sourceChatIds }) => sourceChatIds));
  return Math.min(messages.size, 8) * 2 + Math.min(chats.size, 8);
}

/** Both automatic and explicit sources need current direct user messages.
 * A saved version or repeated receipt is never an independent root. */
export function memorySynthesisSupportRootKeys(
  source: Pick<MemorySynthesisSource, "sourceMessageIds">
): readonly string[] {
  return Object.freeze([...new Set(source.sourceMessageIds)]
    .sort()
    .map((messageId) => `message:${messageId}`));
}

export function memorySynthesisDistinctSupportRootCount(
  sources: readonly Pick<MemorySynthesisSource,
    "factId" | "sourceMessageIds">[]
): number {
  const rootsByFact = new Map<string, Set<string>>();
  for (const source of sources) {
    const roots = rootsByFact.get(source.factId) ?? new Set<string>();
    for (const root of memorySynthesisSupportRootKeys(source)) roots.add(root);
    rootsByFact.set(source.factId, roots);
  }
  const assignedFactByRoot = new Map<string, string>();
  const assign = (factId: string, seen: Set<string>): boolean => {
    for (const root of rootsByFact.get(factId) ?? []) {
      if (seen.has(root)) continue;
      seen.add(root);
      const assigned = assignedFactByRoot.get(root);
      if (assigned === undefined || assign(assigned, seen)) {
        assignedFactByRoot.set(root, factId);
        return true;
      }
    }
    return false;
  };
  for (const factId of rootsByFact.keys()) assign(factId, new Set());
  return assignedFactByRoot.size;
}

/** Consolidation changes presentation, never the certainty of its sources.
 * Recurrence still needs three high-confidence facts with independent roots. */
export function memorySynthesisSourcesSupportReason(
  sources: readonly MemorySynthesisSource[],
  reasonCode: string
): boolean {
  const combined = memorySynthesisIsCombination(reasonCode);
  const minimum = combined
    ? MEMORY_SYNTHESIS_MIN_COMBINED_SOURCES
    : MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES;
  if (new Set(sources.map(({ factId }) => factId)).size < minimum ||
    (combined && sources.length > MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS) ||
    sources.some((source) => !Number.isFinite(source.confidence) ||
      source.confidence <= 0 || source.confidence > 1 ||
      source.sourceMessageIds.length === 0 ||
      (!combined && source.confidence !== 1))) return false;
  if (reasonCode === "combined_episode_facts") {
    return sources[0]!.sourceChatIds.some((chatId) =>
      sources.every((source) => source.sourceChatIds.includes(chatId)));
  }
  return memorySynthesisDistinctSupportRootCount(sources) >= minimum;
}

/** Deterministic, bounded clustering is deliberately conservative. The model
 * may propose wording only inside one supplied cluster and cannot join sources
 * that the server did not already group. */
function buildMemorySynthesisPlanWithMinimum(input: Readonly<{
  boundary: Date;
  generation: number;
  sources: readonly MemorySynthesisSource[];
}>, minimumEligibleSources: number): MemorySynthesisPlan | null {
  if (!validDate(input.boundary) || !Number.isSafeInteger(input.generation) ||
    input.generation < 0) return null;
  const unique = new Map<string, MemorySynthesisSource>();
  let characters = 0;
  for (const source of [...input.sources].sort(sourceSort)) {
    if (
      unique.size >= MEMORY_SYNTHESIS_MAX_SOURCES ||
      source.observedAt < input.boundary ||
      source.memoryGeneration !== input.generation ||
      source.modality === "PATTERN" ||
      source.directness === "INFERRED" ||
      !Number.isFinite(source.confidence) ||
      source.confidence <= 0 || source.confidence > 1 ||
      source.sourceMessageIds.length === 0 ||
      !source.displayText.trim() || source.displayText.includes("\u0000") ||
      source.displayText.length > 2_000 ||
      !/^[a-f0-9]{64}$/u.test(source.eligibilityHash) ||
      unique.has(source.versionId) ||
      [...unique.values()].some(({ factId }) => factId === source.factId)
    ) continue;
    if (characters + source.displayText.length > MEMORY_SYNTHESIS_MAX_SOURCE_CHARACTERS) {
      continue;
    }
    unique.set(source.versionId, source);
    characters += source.displayText.length;
  }
  const selected = [...unique.values()];
  if (selected.length < minimumEligibleSources) return null;
  const entityBindings = [...new Set(selected.flatMap(({ entityIds }) => entityIds))]
    .sort()
    .map((entityId, index) => Object.freeze({ entityId, ref: `E${index + 1}` }));
  const entityRefById = new Map(entityBindings.map(({ entityId, ref }) => [entityId, ref]));
  const bound = selected.map((source, index) => Object.freeze({
    ...source,
    entityRefs: Object.freeze(source.entityIds.flatMap((entityId) => {
      const ref = entityRefById.get(entityId);
      return ref ? [ref] : [];
    })),
    ref: `S${index + 1}`
  }));
  const groups = new Map<string, Array<{
    anchorMs: number;
    key: string;
    sources: MemorySynthesisBoundSource[];
    subjectKey: string;
  }>>();
  for (const source of bound) {
    const semanticKey = clusterKey(source);
    const windows = groups.get(semanticKey) ?? [];
    let window = windows.at(-1);
    if (!window || window.anchorMs - source.observedAt.getTime() >
      MEMORY_SYNTHESIS_CLUSTER_WINDOW_MS) {
      window = {
        anchorMs: source.observedAt.getTime(),
        key: `${semanticKey}|window:${source.observedAt.toISOString()}`,
        sources: [],
        subjectKey: semanticKey
      };
      windows.push(window);
      groups.set(semanticKey, windows);
    }
    window.sources.push(source);
  }
  const clusters = [...groups.values()].flat()
    .filter(({ sources }) => sources.length >= MEMORY_SYNTHESIS_MIN_COMBINED_SOURCES && (
      memorySynthesisDistinctSupportRootCount(sources) >= MEMORY_SYNTHESIS_MIN_COMBINED_SOURCES ||
      sources.some((source, index) => sources.slice(index + 1).some((other) =>
        source.sourceChatIds.some((chatId) => other.sourceChatIds.includes(chatId))))
    ))
    .map(({ key, sources, subjectKey }) => ({
      entityRefs: [...new Set(sources.flatMap(({ entityRefs }) => entityRefs))]
        .sort().slice(0, 8),
      key,
      sources: Object.freeze(sources),
      subjectKey
    }))
    .sort((left, right) =>
      diversityScore(right.sources) - diversityScore(left.sources) ||
      right.sources.length - left.sources.length || left.key.localeCompare(right.key))
    .slice(0, MEMORY_SYNTHESIS_MAX_CLUSTERS);
  if (clusters.length === 0) return null;
  const sourceSetFingerprint = memorySynthesisSourceSetFingerprint({
    generation: input.generation,
    sources: bound
  });
  return Object.freeze({
    clusters: Object.freeze(clusters),
    entityBindings: Object.freeze(entityBindings),
    sourceSetFingerprint,
    sourceSnapshotHash: memorySha256({
      clusters: clusters.map(({ key, sources }) => ({
        key,
        refs: sources.map(({ ref }) => ref),
        sourceMetadata: sources.map((source) => ({
          confidence: source.confidence,
          ref: source.ref,
          sourceChatIds: [...source.sourceChatIds].sort(),
          sourceMessageIds: [...source.sourceMessageIds].sort(),
          validFrom: source.validFrom?.toISOString() ?? null,
          validTo: source.validTo?.toISOString() ?? null
        }))
      })),
      domain: "aiqsa.memory.synthesis-source-snapshot",
      entityBindings,
      sourceSetFingerprint,
      version: 2
    }),
    sources: Object.freeze(bound)
  });
}

export function buildMemorySynthesisPlan(input: Readonly<{
  boundary: Date;
  generation: number;
  sources: readonly MemorySynthesisSource[];
}>): MemorySynthesisPlan | null {
  return buildMemorySynthesisPlanWithMinimum(
    input,
    MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES
  );
}

/** A source invalidation may authorize one replacement attempt for only the
 * affected cluster. It keeps every normal plan fence while lowering the
 * corpus-wide scheduling threshold to the consolidation minimum. */
export function buildMemoryTargetedSynthesisPlan(input: Readonly<{
  boundary: Date;
  generation: number;
  sources: readonly MemorySynthesisSource[];
}>): MemorySynthesisPlan | null {
  return buildMemorySynthesisPlanWithMinimum(
    input,
    MEMORY_SYNTHESIS_MIN_COMBINED_SOURCES
  );
}
