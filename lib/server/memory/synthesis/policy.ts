import type {
  MemoryDirectness,
  MemoryFactModality,
  MemoryFactSourceMode
} from "@prisma/client";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_SYNTHESIS_PIPELINE_VERSION = "memory-synthesis-v2";
export const MEMORY_SYNTHESIS_POLICY_VERSION = "memory-synthesis-policy-v2";
export const MEMORY_SYNTHESIS_PROMPT_VERSION = "memory-synthesis-prompt-v3";
export const MEMORY_SYNTHESIS_SCHEMA_VERSION = "memory-synthesis-schema-v2";
export const MEMORY_SYNTHESIS_RETRIEVAL_CONFIG_FINGERPRINT =
  "memory-synthesis-retrieval-none-v1";

export const MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES = 20;
export const MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES = 3;
export const MEMORY_SYNTHESIS_MAX_SOURCES = 40;
export const MEMORY_SYNTHESIS_MAX_CLUSTERS = 8;
export const MEMORY_SYNTHESIS_MAX_PATTERNS = 4;
export const MEMORY_SYNTHESIS_MAX_SOURCE_CHARACTERS = 48_000;
export const MEMORY_SYNTHESIS_CLUSTER_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;
export const MEMORY_SYNTHESIS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;
export const MEMORY_SYNTHESIS_MAX_SCHEDULED_OWNERS = 24;
export const MEMORY_SYNTHESIS_AUTHORITY_MULTIPLIER = 0.5;

export type MemorySynthesisSource = Readonly<{
  canonicalKey: string;
  category: string;
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
  sourceSetFingerprint: string;
}>): string {
  return memorySha256({
    canonicalPatternIdentity: input.canonicalPatternIdentity,
    domain: "aiqsa.memory.synthesis-pattern",
    policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
    sourceSetFingerprint: input.sourceSetFingerprint,
    version: 2
  });
}

function clusterKey(source: MemorySynthesisSource): string {
  const entityAnchor = [...source.entityIds].sort()[0] ?? null;
  const subject = source.subjectKey ?? source.canonicalKey;
  return [
    entityAnchor ? `entity:${entityAnchor}` : `subject:${subject}`,
    `category:${source.category}`,
    `modality:${source.modality}`,
    `predicate:${source.predicateKey ?? "none"}`
  ].join("|");
}

function diversityScore(sources: readonly MemorySynthesisBoundSource[]): number {
  const messages = new Set(sources.flatMap(({ sourceMessageIds }) => sourceMessageIds));
  const chats = new Set(sources.flatMap(({ sourceChatIds }) => sourceChatIds));
  return Math.min(messages.size, 8) * 2 + Math.min(chats.size, 8);
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
        sources: []
      };
      windows.push(window);
      groups.set(semanticKey, windows);
    }
    window.sources.push(source);
  }
  const clusters = [...groups.values()].flat()
    .filter(({ sources }) => sources.length >= MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES)
    .map(({ key, sources }) => ({
      entityRefs: [...new Set(sources.flatMap(({ entityRefs }) => entityRefs))]
        .sort().slice(0, 8),
      key,
      sources: Object.freeze(sources)
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
        refs: sources.map(({ ref }) => ref)
      })),
      domain: "aiqsa.memory.synthesis-source-snapshot",
      entityBindings,
      sourceSetFingerprint,
      version: 1
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
 * corpus-wide scheduling threshold to the pattern's three-source minimum. */
export function buildMemoryTargetedSynthesisPlan(input: Readonly<{
  boundary: Date;
  generation: number;
  sources: readonly MemorySynthesisSource[];
}>): MemorySynthesisPlan | null {
  return buildMemorySynthesisPlanWithMinimum(
    input,
    MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES
  );
}
