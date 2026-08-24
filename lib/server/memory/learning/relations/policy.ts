import { memorySha256 } from "../../persistence/lexical";

export const MEMORY_FACT_RELATION_PIPELINE_VERSION = "memory-fact-relation-v2";
export const MEMORY_FACT_RELATION_POLICY_VERSION = "memory-fact-relation-policy-v2";
export const MEMORY_FACT_RELATION_PROMPT_VERSION = "memory-fact-relation-prompt-v1";
export const MEMORY_FACT_RELATION_SCHEMA_VERSION = "memory-fact-relation-schema-v1";

export type MemoryRelationOperation =
  | "MERGE_NEW_INTO_TARGET"
  | "MERGE_TARGET_INTO_NEW"
  | "SUPERSEDE_TARGET"
  | "MOVE_TO_DISTINCT_FACT"
  | "ACTIVATE_AFTER_EXPIRY"
  | "CONFLICT"
  | "EXPIRE"
  | "AMBIGUOUS";

export type MemoryRelationVersionSnapshot = Readonly<{
  canonicalKey: string;
  dimensionKey: string | null;
  directness: "DIRECT" | "INFERRED" | "PARAPHRASED";
  displayText: string;
  entities: readonly Readonly<{
    canonicalKey: string;
    entityType: string;
    role: "MENTION" | "OBJECT" | "SUBJECT";
  }>[];
  expectedAt: string | null;
  expiresAt: string | null;
  factId: string;
  identityKind: "PROPOSITION" | "SLOT";
  mergedIntoVersionId: string | null;
  observedAt: string | null;
  occurredAt: string | null;
  predicateKey: string | null;
  ref: string;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state: "ACTIVE" | "PENDING_RELATION";
  structuredValue: unknown;
  subjectKey: string | null;
  supersedesVersionId: string | null;
  systemFrom: string;
  validFrom: string | null;
  validTo: string | null;
  versionId: string;
}>;

export type MemoryRelationEvidenceSnapshot = Readonly<{
  branchGeneration: number | null;
  evidenceFingerprint: string | null;
  evidenceId: string;
  messageId: string | null;
  observedAt: string;
  safeSourceHash: string;
  sourceMessageContentHash: string | null;
  sourceProjectionVersion: string;
}>;

export type MemoryRelationDependencySnapshot = Readonly<{
  dependencyId: string;
  dependencyKind:
    | "COREFERENCE_ANTECEDENT"
    | "CORRECTION_TARGET"
    | "RELATION_CONTEXT"
    | "TEMPORAL_CONTEXT";
  sourceFactVersionId: string | null;
  sourceMessageContentHash: string | null;
  sourceMessageId: string | null;
  sourceMessageUpdatedAt: string | null;
  sourceProjectionVersion: string | null;
}>;

export type MemoryRelationTraceSnapshot = Readonly<{
  kind: "DUPLICATE_OF" | "ENRICHES" | "MERGED_INTO" | "MOVED_FROM" | "SYNTHESIZED_FROM";
  relationId: string;
  sourceVersionId: string;
  targetVersionId: string;
}>;

export type MemoryRelationSnapshot = Readonly<{
  correctionTargetVersionId: string | null;
  current: MemoryRelationVersionSnapshot;
  dependencies: readonly MemoryRelationDependencySnapshot[];
  evidence: readonly MemoryRelationEvidenceSnapshot[];
  memoryGeneration: number;
  memoryRevision: number;
  pending: MemoryRelationVersionSnapshot;
  related: readonly MemoryRelationVersionSnapshot[];
  relations: readonly MemoryRelationTraceSnapshot[];
  sourceIdentity: Readonly<{
    activeLeafMessageId: string | null;
    branchGeneration: number | null;
    chatId: string;
    sourceHash: string | null;
    sourceMessageId: string;
    sourceRevision: number | null;
  }>;
  sourceText: string;
}>;

export type MemoryRelationDecision = Readonly<{
  confidence: number;
  operation: MemoryRelationOperation;
  reasonCode: string;
  targetVersionId: string | null;
}>;

type TransitionRegistry = Readonly<Record<string, ReadonlySet<string>>>;

const PRODUCT_STATUS_TRANSITIONS: TransitionRegistry = Object.freeze({
  borrowed: new Set(["owned", "returned", "no_longer_owned"]),
  cancelled: new Set([
    "considering", "planned", "ordered", "owned", "borrowed", "work_device",
    "shared"
  ]),
  considering: new Set(["planned", "ordered", "owned", "cancelled"]),
  no_longer_owned: new Set([
    "considering", "planned", "ordered", "owned", "borrowed", "work_device",
    "shared"
  ]),
  ordered: new Set(["owned", "cancelled"]),
  owned: new Set(["returned", "sold", "no_longer_owned"]),
  planned: new Set(["ordered", "owned", "cancelled"]),
  returned: new Set([
    "considering", "planned", "ordered", "owned", "borrowed", "work_device",
    "shared"
  ]),
  shared: new Set(["owned", "returned", "no_longer_owned"]),
  sold: new Set([
    "considering", "planned", "ordered", "owned", "borrowed", "work_device",
    "shared"
  ]),
  work_device: new Set(["owned", "returned", "no_longer_owned"])
});

const GOAL_STATUS_TRANSITIONS: TransitionRegistry = Object.freeze({
  abandoned: new Set(["planned", "in_progress"]),
  blocked: new Set(["in_progress", "paused", "completed", "cancelled", "abandoned"]),
  cancelled: new Set(["planned", "in_progress"]),
  completed: new Set(["in_progress"]),
  considering: new Set(["planned", "in_progress", "cancelled", "abandoned"]),
  in_progress: new Set(["paused", "blocked", "completed", "cancelled", "abandoned"]),
  paused: new Set(["in_progress", "blocked", "completed", "cancelled", "abandoned"]),
  planned: new Set(["in_progress", "paused", "blocked", "completed", "cancelled", "abandoned"])
});

const PROJECT_STATUS_TRANSITIONS: TransitionRegistry = Object.freeze({
  active: new Set(["paused", "blocked", "completed", "cancelled"]),
  archived: new Set(["active"]),
  blocked: new Set(["active", "paused", "completed", "cancelled"]),
  cancelled: new Set(["planned", "active"]),
  completed: new Set(["archived", "active"]),
  paused: new Set(["active", "blocked", "completed", "cancelled"]),
  planned: new Set(["active", "paused", "blocked", "completed", "cancelled"])
});

const EMPLOYMENT_STATUS_TRANSITIONS: TransitionRegistry = Object.freeze({
  current: new Set(["leave_planned", "former"]),
  leave_planned: new Set(["former"]),
  former: new Set(["current"])
});

const explicitRestartEdges = new Set([
  "goal_status:abandoned:planned",
  "goal_status:abandoned:in_progress",
  "goal_status:cancelled:planned",
  "goal_status:cancelled:in_progress",
  "goal_status:completed:in_progress",
  "project_status:archived:active",
  "project_status:cancelled:planned",
  "project_status:cancelled:active",
  "project_status:completed:active"
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

function primaryValue(
  predicate: string,
  structuredValue: unknown
): string | null {
  if (["product_status", "goal_status", "project_status", "employment_status"]
    .includes(predicate)) {
    return stringField(structuredValue, "state");
  }
  if (predicate === "residence") return stringField(structuredValue, "placeKey");
  if (predicate === "preference") return stringField(structuredValue, "value");
  if (predicate === "constraint") {
    const object = record(structuredValue);
    return object ? memorySha256({ limit: object.limit ?? null, value: object.value ?? null }) : null;
  }
  if (predicate === "routine") {
    const object = record(structuredValue);
    return object ? memorySha256({
      frequency: object.frequency ?? null,
      schedule: object.schedule ?? null,
      value: object.value ?? null
    }) : null;
  }
  return null;
}

function temporalCompatible(
  left: MemoryRelationVersionSnapshot,
  right: MemoryRelationVersionSnapshot
): boolean {
  return (["occurredAt", "expectedAt", "validFrom", "validTo", "expiresAt"] as const)
    .every((field) => left[field] === null || right[field] === null ||
      left[field] === right[field]);
}

function richness(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + richness(item), 0);
  if (typeof value !== "object") return 1;
  return Object.values(value as Record<string, unknown>)
    .reduce((total: number, item) => total + richness(item), 0);
}

function representationRichness(version: MemoryRelationVersionSnapshot): number {
  return richness(version.structuredValue) +
    [version.occurredAt, version.expectedAt, version.validFrom, version.validTo]
      .filter((value) => value !== null).length +
    Math.min(version.displayText.length, 512) / 512;
}

function explicitChangeSignal(sourceText: string): boolean {
  return /(?:\b(?:actually|changed|instead|now|reopen(?:ed)?|restart(?:ed)?|again|no longer|formerly|currently)\b|(?:^|[^\p{L}])(?:теперь|сейчас|вообще-то|снова|возобновил|перезапустил|больше не|раньше)(?:$|[^\p{L}]))/iu
    .test(sourceText);
}

function retrospectiveResidence(snapshot: MemoryRelationSnapshot): boolean {
  return snapshot.pending.predicateKey === "residence" &&
    /(?:\b(?:previously|used to|formerly)\b|(?:^|[^\p{L}])раньше(?:$|[^\p{L}]))/iu
      .test(snapshot.sourceText);
}

export function memorySlotTransitionAllowed(input: Readonly<{
  correction: boolean;
  explicitSignal: boolean;
  from: string;
  predicate: string;
  to: string;
}>): boolean {
  if (input.correction) return true;
  const registry = input.predicate === "product_status"
    ? PRODUCT_STATUS_TRANSITIONS
    : input.predicate === "goal_status"
      ? GOAL_STATUS_TRANSITIONS
      : input.predicate === "project_status"
        ? PROJECT_STATUS_TRANSITIONS
        : input.predicate === "employment_status"
          ? EMPLOYMENT_STATUS_TRANSITIONS
          : null;
  if (registry) {
    const allowed = registry[input.from]?.has(input.to) === true;
    if (!allowed) return false;
    return !explicitRestartEdges.has(
      `${input.predicate}:${input.from}:${input.to}`
    ) || input.explicitSignal;
  }
  if (input.predicate === "residence") return true;
  if (["preference", "constraint", "routine"].includes(input.predicate)) {
    return input.explicitSignal;
  }
  return false;
}

function decision(
  operation: MemoryRelationOperation,
  targetVersionId: string | null,
  reasonCode: string,
  confidence = 1
): MemoryRelationDecision {
  return Object.freeze({ confidence, operation, reasonCode, targetVersionId });
}

function mergeDecision(
  current: MemoryRelationVersionSnapshot,
  pending: MemoryRelationVersionSnapshot
): MemoryRelationDecision {
  if (current.sourceMode === "EXPLICIT" && pending.sourceMode === "AUTOMATIC") {
    return decision("MERGE_NEW_INTO_TARGET", current.versionId,
      "explicit_canonical_authority");
  }
  const newIsRicher = representationRichness(pending) >
    representationRichness(current);
  return newIsRicher
    ? decision("MERGE_TARGET_INTO_NEW", current.versionId,
      "compatible_richer_representation")
    : decision("MERGE_NEW_INTO_TARGET", current.versionId,
      "compatible_redundant_representation");
}

function sharedSubjectEntity(
  left: MemoryRelationVersionSnapshot,
  right: MemoryRelationVersionSnapshot
): boolean {
  const leftSubjects = new Set(left.entities
    .filter(({ role }) => role === "SUBJECT")
    .map(({ canonicalKey }) => canonicalKey));
  return right.entities.some(({ canonicalKey, role }) =>
    role === "SUBJECT" && leftSubjects.has(canonicalKey));
}

export function decideMemoryFactRelation(
  snapshot: MemoryRelationSnapshot,
  now = new Date()
): MemoryRelationDecision {
  const pending = snapshot.pending;
  const current = snapshot.current;
  if (!Number.isFinite(now.getTime())) {
    return decision("CONFLICT", current.versionId, "invalid_resolution_clock");
  }
  if (pending.expiresAt !== null && new Date(pending.expiresAt) <= now) {
    return decision("EXPIRE", current.versionId, "explicit_ttl_elapsed");
  }
  if (current.expiresAt !== null && new Date(current.expiresAt) <= now &&
    pending.factId === current.factId) {
    return decision("ACTIVATE_AFTER_EXPIRY", current.versionId,
      "expired_current_replaced");
  }
  const correction = snapshot.correctionTargetVersionId === current.versionId;
  if (pending.identityKind !== "SLOT" || current.identityKind !== "SLOT" ||
    pending.predicateKey === null || pending.predicateKey !== current.predicateKey) {
    return decision("CONFLICT", current.versionId, "slot_identity_mismatch");
  }
  if (retrospectiveResidence(snapshot)) {
    return decision("CONFLICT", current.versionId, "retrospective_state_not_current");
  }
  const predicate = pending.predicateKey;
  const oldValue = primaryValue(predicate, current.structuredValue);
  const newValue = primaryValue(predicate, pending.structuredValue);
  if (oldValue === null || newValue === null) {
    return decision("AMBIGUOUS", current.versionId, "unsupported_structured_value", 0);
  }
  if (pending.factId !== current.factId) {
    if (correction) {
      return decision("MOVE_TO_DISTINCT_FACT", current.versionId,
        "explicit_identity_correction");
    }
    const compatibleIdentity = pending.dimensionKey === current.dimensionKey &&
      (pending.subjectKey === current.subjectKey || sharedSubjectEntity(pending, current));
    return compatibleIdentity && oldValue === newValue &&
      temporalCompatible(current, pending)
      ? mergeDecision(current, pending)
      : decision("CONFLICT", current.versionId, "cross_fact_relation_unproven");
  }
  if (pending.canonicalKey !== current.canonicalKey) {
    return decision("CONFLICT", current.versionId, "slot_identity_mismatch");
  }
  if (oldValue === newValue && temporalCompatible(current, pending)) {
    return mergeDecision(current, pending);
  }
  if (current.sourceMode === "EXPLICIT" && pending.sourceMode === "AUTOMATIC") {
    return decision("CONFLICT", current.versionId, "explicit_current_conflict");
  }
  if (memorySlotTransitionAllowed({
    correction,
    explicitSignal: explicitChangeSignal(snapshot.sourceText) ||
      predicate === "residence" ||
      (["constraint", "routine"].includes(predicate) &&
        (pending.directness === "DIRECT" || pending.sourceMode === "EXPLICIT")),
    from: oldValue,
    predicate,
    to: newValue
  })) {
    return decision("SUPERSEDE_TARGET", current.versionId,
      correction ? "explicit_correction" : "allowed_state_transition");
  }
  return decision("AMBIGUOUS", current.versionId, "transition_not_deterministic", 0);
}

export function relationSnapshotHash(snapshot: MemoryRelationSnapshot): string {
  return memorySha256({
    domain: "aiqsa.memory.fact-relation-snapshot",
    pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
    policyVersion: MEMORY_FACT_RELATION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_RELATION_PROMPT_VERSION,
    schemaVersion: MEMORY_FACT_RELATION_SCHEMA_VERSION,
    snapshot,
    version: 2
  });
}
