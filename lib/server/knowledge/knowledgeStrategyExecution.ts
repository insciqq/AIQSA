import { createHash } from "node:crypto";

export const KNOWLEDGE_STRATEGY_EXECUTION_VERSION = 1 as const;
export const KNOWLEDGE_STRATEGY_MAX_SOURCES = 999;
export const KNOWLEDGE_STRATEGY_MAX_TARGETS = 128;
export const KNOWLEDGE_STRATEGY_MAX_STEPS = 4_096;
export const KNOWLEDGE_STRATEGY_MAX_DEPENDENCIES = 16_384;
export const KNOWLEDGE_STRATEGY_MAX_ITEMS = 10_000_000;
export const KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL = 999_999;
export const KNOWLEDGE_STRATEGY_MAX_REASONS = 64;

export const KNOWLEDGE_STRATEGIES = Object.freeze([
  "full_context",
  "comparison",
  "exhaustive",
  "corpus_summary",
  "multi_hop"
] as const);

export const KNOWLEDGE_STRATEGY_EXECUTION_STATES = Object.freeze([
  "planned",
  "running",
  "settled",
  "partial",
  "failed",
  "ambiguous",
  "cancelled"
] as const);

export const KNOWLEDGE_STRATEGY_STEP_STATES = Object.freeze([
  "pending",
  "running",
  "settled",
  "failed",
  "ambiguous",
  "cancelled",
  "purged"
] as const);

export const KNOWLEDGE_STRATEGY_STEP_RESULT_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "ambiguous",
  "cancelled",
  "unavailable"
] as const);

export const KNOWLEDGE_STRATEGY_STEP_KINDS = Object.freeze([
  "full_context_page",
  "comparison_target",
  "exhaustive_page",
  "corpus_summary_map",
  "corpus_summary_reduce",
  "multi_hop_root",
  "multi_hop_follow_up"
] as const);

export const KNOWLEDGE_STRATEGY_COVERAGE_STATUSES = Object.freeze([
  "verified",
  "partial",
  "degraded"
] as const);

export type KnowledgeMeasuredStrategy = typeof KNOWLEDGE_STRATEGIES[number];
export type KnowledgeStrategyExecutionState =
  typeof KNOWLEDGE_STRATEGY_EXECUTION_STATES[number];
export type KnowledgeStrategyStepState = typeof KNOWLEDGE_STRATEGY_STEP_STATES[number];
export type KnowledgeStrategyStepResultStatus =
  typeof KNOWLEDGE_STRATEGY_STEP_RESULT_STATUSES[number];
export type KnowledgeStrategyStepKind = typeof KNOWLEDGE_STRATEGY_STEP_KINDS[number];
export type KnowledgeStrategyCoverageStatus =
  typeof KNOWLEDGE_STRATEGY_COVERAGE_STATUSES[number];

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_ALIAS = /^S[1-9]\d{0,2}$/u;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapedJsonString(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case "<": return "\\u003c";
      case ">": return "\\u003e";
      case "&": return "\\u0026";
      case "\u2028": return "\\u2028";
      default: return "\\u2029";
    }
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapedJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("knowledge_strategy_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${escapedJsonString(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("knowledge_strategy_non_json_value");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function throwInvalid(code: string): never {
  throw new Error(code);
}

export type KnowledgeAcceptedSourceTupleV1 = Readonly<{
  bindingId: string;
  hierarchicalArtifactId: string;
  hierarchicalChecksum: string;
  ordinal: number;
  passageCount: number;
  sourceAlias: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceVersionNumber: number;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const acceptedSourceKeys = [
  "bindingId",
  "hierarchicalArtifactId",
  "hierarchicalChecksum",
  "ordinal",
  "passageCount",
  "sourceAlias",
  "sourceArtifactId",
  "sourceId",
  "sourceVersionId",
  "sourceVersionNumber",
  "version"
] as const;

export function decodeKnowledgeAcceptedSourceTupleV1(
  value: unknown
): KnowledgeAcceptedSourceTupleV1 | null {
  if (!record(value) || !exactKeys(value, acceptedSourceKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !identifier(value.bindingId) || !identifier(value.hierarchicalArtifactId) ||
    !hash(value.hierarchicalChecksum) ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES - 1) ||
    !boundedInteger(value.passageCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    typeof value.sourceAlias !== "string" || !SOURCE_ALIAS.test(value.sourceAlias) ||
    value.sourceAlias !== `S${Number(value.ordinal) + 1}` ||
    !identifier(value.sourceArtifactId) || !identifier(value.sourceId) ||
    !identifier(value.sourceVersionId) ||
    !boundedInteger(value.sourceVersionNumber, 1, 2_147_483_647)) return null;
  return Object.freeze({
    bindingId: value.bindingId,
    hierarchicalArtifactId: value.hierarchicalArtifactId,
    hierarchicalChecksum: value.hierarchicalChecksum,
    ordinal: Number(value.ordinal),
    passageCount: Number(value.passageCount),
    sourceAlias: value.sourceAlias,
    sourceArtifactId: value.sourceArtifactId,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    sourceVersionNumber: Number(value.sourceVersionNumber),
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function decodeKnowledgeAcceptedSourceSetV1(
  value: unknown
): readonly KnowledgeAcceptedSourceTupleV1[] | null {
  if (!Array.isArray(value) || value.length < 1 ||
    value.length > KNOWLEDGE_STRATEGY_MAX_SOURCES) return null;
  const decoded = value.map(decodeKnowledgeAcceptedSourceTupleV1);
  if (decoded.some((source) => source === null)) return null;
  const sources = [...decoded] as KnowledgeAcceptedSourceTupleV1[];
  sources.sort((left, right) => left.ordinal - right.ordinal ||
    compareStrings(left.bindingId, right.bindingId));
  const uniqueFields: Array<keyof Pick<KnowledgeAcceptedSourceTupleV1,
    "bindingId" | "hierarchicalArtifactId" | "ordinal" | "sourceAlias" |
    "sourceArtifactId" | "sourceId" | "sourceVersionId">> = [
      "bindingId",
      "hierarchicalArtifactId",
      "ordinal",
      "sourceAlias",
      "sourceArtifactId",
      "sourceId",
      "sourceVersionId"
    ];
  if (uniqueFields.some((field) =>
    new Set(sources.map((source) => source[field])).size !== sources.length) ||
    sources.reduce((sum, source) => sum + source.passageCount, 0) >
      KNOWLEDGE_STRATEGY_MAX_ITEMS) return null;
  return Object.freeze(sources);
}

export function canonicalKnowledgeAcceptedSourceTupleV1(value: unknown): string {
  const decoded = decodeKnowledgeAcceptedSourceTupleV1(value) ??
    throwInvalid("knowledge_accepted_source_tuple_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeAcceptedSourceTupleV1(value: unknown): string {
  return sha256(canonicalKnowledgeAcceptedSourceTupleV1(value));
}

export function canonicalKnowledgeAcceptedSourceSetV1(value: unknown): string {
  const decoded = decodeKnowledgeAcceptedSourceSetV1(value) ??
    throwInvalid("knowledge_accepted_source_set_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeAcceptedSourceSetV1(value: unknown): string {
  return sha256(canonicalKnowledgeAcceptedSourceSetV1(value));
}

export type KnowledgeStrategyPassageItemV1 = Readonly<{
  contentHash: string;
  passageId: string;
  passageOrdinal: number;
  sourceArtifactId: string;
  sourceBindingId: string;
  sourceOrdinal: number;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const passageItemKeys = [
  "contentHash",
  "passageId",
  "passageOrdinal",
  "sourceArtifactId",
  "sourceBindingId",
  "sourceOrdinal",
  "version"
] as const;

export function decodeKnowledgeStrategyPassageItemV1(
  value: unknown
): KnowledgeStrategyPassageItemV1 | null {
  if (!record(value) || !exactKeys(value, passageItemKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION || !hash(value.contentHash) ||
    !identifier(value.passageId) ||
    !boundedInteger(value.passageOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS - 1) ||
    !identifier(value.sourceArtifactId) || !identifier(value.sourceBindingId) ||
    !boundedInteger(value.sourceOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES - 1)) return null;
  return Object.freeze({
    contentHash: value.contentHash,
    passageId: value.passageId,
    passageOrdinal: Number(value.passageOrdinal),
    sourceArtifactId: value.sourceArtifactId,
    sourceBindingId: value.sourceBindingId,
    sourceOrdinal: Number(value.sourceOrdinal),
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function canonicalKnowledgeStrategyPassageItemV1(value: unknown): string {
  const decoded = decodeKnowledgeStrategyPassageItemV1(value) ??
    throwInvalid("knowledge_strategy_passage_item_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyPassageItemV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyPassageItemV1(value));
}

export function canonicalKnowledgeStrategyPassageItemsV1(value: unknown): string {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_STRATEGY_MAX_ITEMS) {
    throwInvalid("knowledge_strategy_passage_items_invalid");
  }
  const decoded = value.map(decodeKnowledgeStrategyPassageItemV1);
  if (decoded.some((item) => item === null)) {
    throwInvalid("knowledge_strategy_passage_items_invalid");
  }
  const items = decoded as KnowledgeStrategyPassageItemV1[];
  if (items.some((item, index) => index > 0 && (
    item.sourceOrdinal < items[index - 1]!.sourceOrdinal ||
    item.sourceOrdinal === items[index - 1]!.sourceOrdinal &&
      item.passageOrdinal <= items[index - 1]!.passageOrdinal
  )) || new Set(items.map((item) => item.passageId)).size !== items.length) {
    throwInvalid("knowledge_strategy_passage_items_not_stable");
  }
  return canonicalJson(items);
}

export function hashKnowledgeStrategyPassageItemsV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyPassageItemsV1(value));
}

export type KnowledgeStrategyCursorV1 = Readonly<{
  executionId: string;
  nextPassageOrdinal: number;
  pageOrdinal: number;
  previousItemHash: string;
  sourceBindingId: string;
  sourceOrdinal: number;
  streamId: string;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const cursorKeys = [
  "executionId",
  "nextPassageOrdinal",
  "pageOrdinal",
  "previousItemHash",
  "sourceBindingId",
  "sourceOrdinal",
  "streamId",
  "version"
] as const;

export function decodeKnowledgeStrategyCursorV1(value: unknown): KnowledgeStrategyCursorV1 | null {
  if (!record(value) || !exactKeys(value, cursorKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !identifier(value.executionId) ||
    !boundedInteger(value.nextPassageOrdinal, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !boundedInteger(value.pageOrdinal, 1, KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL) ||
    !hash(value.previousItemHash) || !identifier(value.sourceBindingId) ||
    !boundedInteger(value.sourceOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES - 1) ||
    !identifier(value.streamId)) return null;
  return Object.freeze({
    executionId: value.executionId,
    nextPassageOrdinal: Number(value.nextPassageOrdinal),
    pageOrdinal: Number(value.pageOrdinal),
    previousItemHash: value.previousItemHash,
    sourceBindingId: value.sourceBindingId,
    sourceOrdinal: Number(value.sourceOrdinal),
    streamId: value.streamId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function canonicalKnowledgeStrategyCursorV1(value: unknown): string {
  const decoded = decodeKnowledgeStrategyCursorV1(value) ??
    throwInvalid("knowledge_strategy_cursor_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyCursorV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyCursorV1(value));
}

export const KNOWLEDGE_STRATEGY_TARGET_ADMISSION_STATES = Object.freeze([
  "resolved",
  "not_present",
  "not_ready",
  "ambiguous"
] as const);

export type KnowledgeStrategyTargetAdmissionState =
  typeof KNOWLEDGE_STRATEGY_TARGET_ADMISSION_STATES[number];

export type KnowledgeStrategyTargetV1 = Readonly<{
  admission: KnowledgeStrategyTargetAdmissionState;
  ordinal: number;
  referenceHash: string;
  sourceBindingId: string | null;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const targetKeys = [
  "admission",
  "ordinal",
  "referenceHash",
  "sourceBindingId",
  "version"
] as const;

export function decodeKnowledgeStrategyTargetV1(value: unknown): KnowledgeStrategyTargetV1 | null {
  if (!record(value) || !exactKeys(value, targetKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    typeof value.admission !== "string" ||
    !(KNOWLEDGE_STRATEGY_TARGET_ADMISSION_STATES as readonly string[])
      .includes(value.admission) ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAX_TARGETS - 1) ||
    !hash(value.referenceHash) ||
    value.sourceBindingId !== null && !identifier(value.sourceBindingId) ||
    value.admission === "resolved" && value.sourceBindingId === null ||
    value.admission !== "resolved" && value.sourceBindingId !== null) return null;
  return Object.freeze({
    admission: value.admission as KnowledgeStrategyTargetAdmissionState,
    ordinal: Number(value.ordinal),
    referenceHash: value.referenceHash,
    sourceBindingId: value.sourceBindingId as string | null,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function decodeKnowledgeStrategyTargetSetV1(
  value: unknown
): readonly KnowledgeStrategyTargetV1[] | null {
  if (!Array.isArray(value) || value.length < 2 ||
    value.length > KNOWLEDGE_STRATEGY_MAX_TARGETS) return null;
  const decoded = value.map(decodeKnowledgeStrategyTargetV1);
  if (decoded.some((target) => target === null)) return null;
  const targets = [...decoded] as KnowledgeStrategyTargetV1[];
  targets.sort((left, right) => left.ordinal - right.ordinal ||
    compareStrings(left.referenceHash, right.referenceHash));
  if (targets.some((target, index) => target.ordinal !== index) ||
    new Set(targets.map(({ referenceHash }) => referenceHash)).size !== targets.length) return null;
  const resolved = targets.flatMap(({ sourceBindingId }) =>
    sourceBindingId === null ? [] : [sourceBindingId]);
  if (new Set(resolved).size !== resolved.length) return null;
  return Object.freeze(targets);
}

export function canonicalKnowledgeStrategyTargetSetV1(value: unknown): string {
  const decoded = decodeKnowledgeStrategyTargetSetV1(value) ??
    throwInvalid("knowledge_strategy_target_set_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyTargetSetV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyTargetSetV1(value));
}

export type KnowledgeFullContextConfigV1 = Readonly<{
  expectedPassageCount: number;
  fallback: "corpus_summary" | "focused";
  kind: "full_context";
}>;

export type KnowledgeComparisonConfigV1 = Readonly<{
  dimensionHash: string;
  kind: "comparison";
  targetSetHash: string;
  targets: readonly KnowledgeStrategyTargetV1[];
}>;

export type KnowledgeExhaustiveConfigV1 = Readonly<{
  expectedPassageCount: number;
  kind: "exhaustive";
  queryHash: string;
}>;

export type KnowledgeCorpusSummaryConfigV1 = Readonly<{
  expectedPassageCount: number;
  kind: "corpus_summary";
  mapInputHash: string;
  reduceInputHash: string;
}>;

export type KnowledgeMultiHopConfigV1 = Readonly<{
  atomicQuestionHashes: readonly string[];
  kind: "multi_hop";
}>;

export type KnowledgeStrategyExecutionConfigV1 =
  | KnowledgeComparisonConfigV1
  | KnowledgeCorpusSummaryConfigV1
  | KnowledgeExhaustiveConfigV1
  | KnowledgeFullContextConfigV1
  | KnowledgeMultiHopConfigV1;

export type KnowledgeStrategyExecutionPlanV1 = Readonly<{
  config: KnowledgeStrategyExecutionConfigV1;
  executionId: string;
  modelRunId: string;
  plannerVersion: number;
  sourceSet: readonly KnowledgeAcceptedSourceTupleV1[];
  sourceSetHash: string;
  strategy: KnowledgeMeasuredStrategy;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

export type KnowledgeStrategyExecutionRequestV1 = KnowledgeStrategyExecutionPlanV1 & Readonly<{
  planHash: string;
}>;

const executionPlanKeys = [
  "config",
  "executionId",
  "modelRunId",
  "plannerVersion",
  "sourceSet",
  "sourceSetHash",
  "strategy",
  "version"
] as const;
const executionRequestKeys = [...executionPlanKeys, "planHash"] as const;

function decodeConfig(
  value: unknown,
  strategy: KnowledgeMeasuredStrategy,
  sourceSet: readonly KnowledgeAcceptedSourceTupleV1[]
): KnowledgeStrategyExecutionConfigV1 | null {
  if (!record(value) || value.kind !== strategy) return null;
  const expectedPassageCount = sourceSet.reduce((sum, source) => sum + source.passageCount, 0);
  switch (strategy) {
    case "full_context":
      if (!exactKeys(value, ["expectedPassageCount", "fallback", "kind"]) ||
        value.expectedPassageCount !== expectedPassageCount ||
        value.fallback !== "corpus_summary" && value.fallback !== "focused") return null;
      return Object.freeze({
        expectedPassageCount,
        fallback: value.fallback,
        kind: strategy
      });
    case "comparison": {
      if (!exactKeys(value, ["dimensionHash", "kind", "targetSetHash", "targets"]) ||
        !hash(value.dimensionHash) || !hash(value.targetSetHash)) return null;
      const targets = decodeKnowledgeStrategyTargetSetV1(value.targets);
      if (!targets || hashKnowledgeStrategyTargetSetV1(targets) !== value.targetSetHash) return null;
      const sourceIds = new Set(sourceSet.map(({ bindingId }) => bindingId));
      if (targets.some(({ sourceBindingId }) =>
        sourceBindingId !== null && !sourceIds.has(sourceBindingId))) return null;
      return Object.freeze({
        dimensionHash: value.dimensionHash,
        kind: strategy,
        targetSetHash: value.targetSetHash,
        targets
      });
    }
    case "exhaustive":
      if (!exactKeys(value, ["expectedPassageCount", "kind", "queryHash"]) ||
        value.expectedPassageCount !== expectedPassageCount || !hash(value.queryHash)) return null;
      return Object.freeze({ expectedPassageCount, kind: strategy, queryHash: value.queryHash });
    case "corpus_summary":
      if (!exactKeys(value, [
        "expectedPassageCount",
        "kind",
        "mapInputHash",
        "reduceInputHash"
      ]) || value.expectedPassageCount !== expectedPassageCount ||
        !hash(value.mapInputHash) || !hash(value.reduceInputHash) ||
        value.mapInputHash === value.reduceInputHash) return null;
      return Object.freeze({
        expectedPassageCount,
        kind: strategy,
        mapInputHash: value.mapInputHash,
        reduceInputHash: value.reduceInputHash
      });
    case "multi_hop": {
      if (!exactKeys(value, ["atomicQuestionHashes", "kind"]) ||
        !Array.isArray(value.atomicQuestionHashes) ||
        value.atomicQuestionHashes.length < 2 || value.atomicQuestionHashes.length > 64 ||
        value.atomicQuestionHashes.some((entry) => !hash(entry)) ||
        new Set(value.atomicQuestionHashes).size !== value.atomicQuestionHashes.length) return null;
      return Object.freeze({
        atomicQuestionHashes: Object.freeze([...(value.atomicQuestionHashes as string[])]),
        kind: strategy
      });
    }
  }
}

function decodeExecutionPlan(value: unknown): KnowledgeStrategyExecutionPlanV1 | null {
  if (!record(value) || !exactKeys(value, executionPlanKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !identifier(value.executionId) || !identifier(value.modelRunId) ||
    !boundedInteger(value.plannerVersion, 1, 256) ||
    typeof value.strategy !== "string" ||
    !(KNOWLEDGE_STRATEGIES as readonly string[]).includes(value.strategy) ||
    !hash(value.sourceSetHash)) return null;
  const sourceSet = decodeKnowledgeAcceptedSourceSetV1(value.sourceSet);
  if (!sourceSet || hashKnowledgeAcceptedSourceSetV1(sourceSet) !== value.sourceSetHash) return null;
  const strategy = value.strategy as KnowledgeMeasuredStrategy;
  const config = decodeConfig(value.config, strategy, sourceSet);
  if (!config) return null;
  return Object.freeze({
    config,
    executionId: value.executionId,
    modelRunId: value.modelRunId,
    plannerVersion: Number(value.plannerVersion),
    sourceSet,
    sourceSetHash: value.sourceSetHash,
    strategy,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function canonicalKnowledgeStrategyExecutionPlanV1(value: unknown): string {
  const decoded = decodeExecutionPlan(value) ??
    throwInvalid("knowledge_strategy_execution_plan_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyExecutionPlanV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyExecutionPlanV1(value));
}

export function sealKnowledgeStrategyExecutionRequestV1(
  value: unknown
): KnowledgeStrategyExecutionRequestV1 {
  const plan = decodeExecutionPlan(value) ??
    throwInvalid("knowledge_strategy_execution_plan_invalid");
  return deepFreeze({ ...plan, planHash: hashKnowledgeStrategyExecutionPlanV1(plan) });
}

export function decodeKnowledgeStrategyExecutionRequestV1(
  value: unknown
): KnowledgeStrategyExecutionRequestV1 | null {
  if (!record(value) || !exactKeys(value, executionRequestKeys) || !hash(value.planHash)) return null;
  const { planHash, ...untrustedPlan } = value;
  const plan = decodeExecutionPlan(untrustedPlan);
  if (!plan || hashKnowledgeStrategyExecutionPlanV1(plan) !== planHash) return null;
  return deepFreeze({ ...plan, planHash });
}

export function createKnowledgeStrategyExecutionRequestV1(
  value: unknown
): KnowledgeStrategyExecutionRequestV1 {
  return decodeKnowledgeStrategyExecutionRequestV1(value) ??
    throwInvalid("knowledge_strategy_execution_request_invalid");
}

export function canonicalKnowledgeStrategyExecutionRequestV1(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyExecutionRequestV1(value));
}

export function hashKnowledgeStrategyExecutionRequestV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyExecutionRequestV1(value));
}

export type KnowledgeStrategyStepRequestV1 = Readonly<{
  comparisonDimensionHash: string | null;
  cursor: KnowledgeStrategyCursorV1 | null;
  evidenceInputHash: string | null;
  executionId: string;
  inputHash: string;
  kind: KnowledgeStrategyStepKind;
  ordinal: number;
  pageOrdinal: number;
  phaseOrdinal: number;
  required: boolean;
  sourceBindingId: string | null;
  sourceSetHash: string;
  stepId: string;
  strategy: KnowledgeMeasuredStrategy;
  streamId: string;
  targetOrdinal: number | null;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const stepRequestKeys = [
  "comparisonDimensionHash",
  "cursor",
  "evidenceInputHash",
  "executionId",
  "inputHash",
  "kind",
  "ordinal",
  "pageOrdinal",
  "phaseOrdinal",
  "required",
  "sourceBindingId",
  "sourceSetHash",
  "stepId",
  "strategy",
  "streamId",
  "targetOrdinal",
  "version"
] as const;

const stepKindStrategy = Object.freeze({
  comparison_target: "comparison",
  corpus_summary_map: "corpus_summary",
  corpus_summary_reduce: "corpus_summary",
  exhaustive_page: "exhaustive",
  full_context_page: "full_context",
  multi_hop_follow_up: "multi_hop",
  multi_hop_root: "multi_hop"
} satisfies Record<KnowledgeStrategyStepKind, KnowledgeMeasuredStrategy>);

function paginatedStepKind(kind: KnowledgeStrategyStepKind): boolean {
  return kind === "full_context_page" || kind === "comparison_target" ||
    kind === "exhaustive_page" || kind === "corpus_summary_map";
}

export function decodeKnowledgeStrategyStepRequestV1(
  value: unknown
): KnowledgeStrategyStepRequestV1 | null {
  if (!record(value) || !exactKeys(value, stepRequestKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !identifier(value.executionId) || !hash(value.inputHash) ||
    typeof value.kind !== "string" ||
    !(KNOWLEDGE_STRATEGY_STEP_KINDS as readonly string[]).includes(value.kind) ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAX_STEPS - 1) ||
    !boundedInteger(value.pageOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL) ||
    !boundedInteger(value.phaseOrdinal, 0, 63) || typeof value.required !== "boolean" ||
    value.sourceBindingId !== null && !identifier(value.sourceBindingId) ||
    !hash(value.sourceSetHash) || !identifier(value.stepId) ||
    typeof value.strategy !== "string" ||
    !(KNOWLEDGE_STRATEGIES as readonly string[]).includes(value.strategy) ||
    !identifier(value.streamId) ||
    value.targetOrdinal !== null &&
      !boundedInteger(value.targetOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_TARGETS - 1) ||
    value.comparisonDimensionHash !== null && !hash(value.comparisonDimensionHash) ||
    value.evidenceInputHash !== null && !hash(value.evidenceInputHash)) return null;

  const kind = value.kind as KnowledgeStrategyStepKind;
  const strategy = value.strategy as KnowledgeMeasuredStrategy;
  if (stepKindStrategy[kind] !== strategy) return null;
  const sourceRequired = kind === "full_context_page" || kind === "comparison_target" ||
    kind === "exhaustive_page" || kind === "corpus_summary_map";
  const comparison = kind === "comparison_target";
  const evidenceBound = kind === "multi_hop_follow_up" ||
    kind === "corpus_summary_reduce";
  if (sourceRequired !== (value.sourceBindingId !== null) ||
    comparison !== (value.targetOrdinal !== null) ||
    comparison !== (value.comparisonDimensionHash !== null) ||
    evidenceBound !== (value.evidenceInputHash !== null)) return null;

  const cursorValue = value.cursor === null ? null : decodeKnowledgeStrategyCursorV1(value.cursor);
  if (value.cursor !== null && !cursorValue) return null;
  if (paginatedStepKind(kind)) {
    if (value.pageOrdinal === 0 && cursorValue !== null ||
      Number(value.pageOrdinal) > 0 && cursorValue === null) return null;
    if (cursorValue && (
      cursorValue.executionId !== value.executionId ||
      cursorValue.streamId !== value.streamId ||
      cursorValue.sourceBindingId !== value.sourceBindingId ||
      cursorValue.pageOrdinal !== value.pageOrdinal
    )) return null;
  } else if (value.pageOrdinal !== 0 || cursorValue !== null) return null;

  return deepFreeze({
    comparisonDimensionHash: value.comparisonDimensionHash as string | null,
    cursor: cursorValue,
    evidenceInputHash: value.evidenceInputHash as string | null,
    executionId: value.executionId,
    inputHash: value.inputHash,
    kind,
    ordinal: Number(value.ordinal),
    pageOrdinal: Number(value.pageOrdinal),
    phaseOrdinal: Number(value.phaseOrdinal),
    required: value.required,
    sourceBindingId: value.sourceBindingId as string | null,
    sourceSetHash: value.sourceSetHash,
    stepId: value.stepId,
    strategy,
    streamId: value.streamId,
    targetOrdinal: value.targetOrdinal === null ? null : Number(value.targetOrdinal),
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function createKnowledgeStrategyStepRequestV1(value: unknown): KnowledgeStrategyStepRequestV1 {
  return decodeKnowledgeStrategyStepRequestV1(value) ??
    throwInvalid("knowledge_strategy_step_request_invalid");
}

export function canonicalKnowledgeStrategyStepRequestV1(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyStepRequestV1(value));
}

export function hashKnowledgeStrategyStepRequestV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyStepRequestV1(value));
}

export const KNOWLEDGE_STRATEGY_STEP_MATERIALIZATION_MODES = Object.freeze([
  "complete",
  "cursor_from_predecessor",
  "evidence_from_prerequisites"
] as const);

export type KnowledgeStrategyStepMaterializationMode =
  typeof KNOWLEDGE_STRATEGY_STEP_MATERIALIZATION_MODES[number];

export type KnowledgeStrategyStepTemplateV1 = Readonly<{
  comparisonDimensionHash: string | null;
  cursor: KnowledgeStrategyCursorV1 | null;
  evidenceInputHash: string | null;
  executionId: string;
  inputHash: string;
  kind: KnowledgeStrategyStepKind;
  materializationMode: KnowledgeStrategyStepMaterializationMode;
  ordinal: number;
  pageOrdinal: number;
  phaseOrdinal: number;
  required: boolean;
  sourceBindingId: string | null;
  sourceSetHash: string;
  stepId: string;
  strategy: KnowledgeMeasuredStrategy;
  streamId: string;
  targetOrdinal: number | null;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const stepTemplateKeys = [
  "comparisonDimensionHash",
  "cursor",
  "evidenceInputHash",
  "executionId",
  "inputHash",
  "kind",
  "materializationMode",
  "ordinal",
  "pageOrdinal",
  "phaseOrdinal",
  "required",
  "sourceBindingId",
  "sourceSetHash",
  "stepId",
  "strategy",
  "streamId",
  "targetOrdinal",
  "version"
] as const;

function stepRequestShapeFromTemplate(
  template: Omit<KnowledgeStrategyStepTemplateV1, "materializationMode">
): KnowledgeStrategyStepRequestV1 {
  return template;
}

export function decodeKnowledgeStrategyStepTemplateV1(
  value: unknown
): KnowledgeStrategyStepTemplateV1 | null {
  if (!record(value) || !exactKeys(value, stepTemplateKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    typeof value.materializationMode !== "string" ||
    !(KNOWLEDGE_STRATEGY_STEP_MATERIALIZATION_MODES as readonly string[])
      .includes(value.materializationMode) ||
    !identifier(value.executionId) || !hash(value.inputHash) ||
    typeof value.kind !== "string" ||
    !(KNOWLEDGE_STRATEGY_STEP_KINDS as readonly string[]).includes(value.kind) ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAX_STEPS - 1) ||
    !boundedInteger(value.pageOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL) ||
    !boundedInteger(value.phaseOrdinal, 0, 63) || typeof value.required !== "boolean" ||
    value.sourceBindingId !== null && !identifier(value.sourceBindingId) ||
    !hash(value.sourceSetHash) || !identifier(value.stepId) ||
    typeof value.strategy !== "string" ||
    !(KNOWLEDGE_STRATEGIES as readonly string[]).includes(value.strategy) ||
    !identifier(value.streamId) ||
    value.targetOrdinal !== null &&
      !boundedInteger(value.targetOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_TARGETS - 1) ||
    value.comparisonDimensionHash !== null && !hash(value.comparisonDimensionHash) ||
    value.evidenceInputHash !== null && !hash(value.evidenceInputHash)) return null;

  const kind = value.kind as KnowledgeStrategyStepKind;
  const strategy = value.strategy as KnowledgeMeasuredStrategy;
  const materializationMode = value.materializationMode as
    KnowledgeStrategyStepMaterializationMode;
  const sourceRequired = paginatedStepKind(kind);
  const comparison = kind === "comparison_target";
  if (stepKindStrategy[kind] !== strategy ||
    sourceRequired !== (value.sourceBindingId !== null) ||
    comparison !== (value.targetOrdinal !== null) ||
    comparison !== (value.comparisonDimensionHash !== null)) return null;

  const cursor = value.cursor === null ? null : decodeKnowledgeStrategyCursorV1(value.cursor);
  if (value.cursor !== null && !cursor) return null;
  const template = {
    comparisonDimensionHash: value.comparisonDimensionHash as string | null,
    cursor,
    evidenceInputHash: value.evidenceInputHash as string | null,
    executionId: value.executionId,
    inputHash: value.inputHash,
    kind,
    materializationMode,
    ordinal: Number(value.ordinal),
    pageOrdinal: Number(value.pageOrdinal),
    phaseOrdinal: Number(value.phaseOrdinal),
    required: value.required,
    sourceBindingId: value.sourceBindingId as string | null,
    sourceSetHash: value.sourceSetHash,
    stepId: value.stepId,
    strategy,
    streamId: value.streamId,
    targetOrdinal: value.targetOrdinal === null ? null : Number(value.targetOrdinal),
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  } satisfies KnowledgeStrategyStepTemplateV1;
  if (materializationMode === "complete") {
    const { materializationMode: _mode, ...requestShape } = template;
    if (!decodeKnowledgeStrategyStepRequestV1(stepRequestShapeFromTemplate(requestShape))) {
      return null;
    }
  } else if (materializationMode === "cursor_from_predecessor") {
    if (!paginatedStepKind(kind) || template.pageOrdinal === 0 || cursor !== null ||
      template.evidenceInputHash !== null) return null;
  } else if (kind !== "multi_hop_follow_up" && kind !== "corpus_summary_reduce" ||
    template.pageOrdinal !== 0 ||
    cursor !== null || template.evidenceInputHash !== null) return null;
  return deepFreeze(template);
}

export function createKnowledgeStrategyStepTemplateV1(
  value: unknown
): KnowledgeStrategyStepTemplateV1 {
  return decodeKnowledgeStrategyStepTemplateV1(value) ??
    throwInvalid("knowledge_strategy_step_template_invalid");
}

export function canonicalKnowledgeStrategyStepTemplateV1(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyStepTemplateV1(value));
}

export function hashKnowledgeStrategyStepTemplateV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyStepTemplateV1(value));
}

export type KnowledgeStrategyStepEvidenceV1 = Readonly<{
  executionId: string;
  kind: KnowledgeStrategyStepKind;
  ordinal: number;
  requestHash: string;
  resultHash: string;
  stepId: string;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const stepEvidenceKeys = [
  "executionId",
  "kind",
  "ordinal",
  "requestHash",
  "resultHash",
  "stepId",
  "version"
] as const;

export function decodeKnowledgeStrategyStepEvidenceV1(
  value: unknown
): KnowledgeStrategyStepEvidenceV1 | null {
  if (!record(value) || !exactKeys(value, stepEvidenceKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !identifier(value.executionId) || typeof value.kind !== "string" ||
    !(KNOWLEDGE_STRATEGY_STEP_KINDS as readonly string[]).includes(value.kind) ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAX_STEPS - 1) ||
    !hash(value.requestHash) || !hash(value.resultHash) || !identifier(value.stepId)) return null;
  return Object.freeze({
    executionId: value.executionId,
    kind: value.kind as KnowledgeStrategyStepKind,
    ordinal: Number(value.ordinal),
    requestHash: value.requestHash,
    resultHash: value.resultHash,
    stepId: value.stepId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function createKnowledgeStrategyStepEvidenceV1(
  value: unknown
): KnowledgeStrategyStepEvidenceV1 {
  return decodeKnowledgeStrategyStepEvidenceV1(value) ??
    throwInvalid("knowledge_strategy_step_evidence_invalid");
}

export function sealKnowledgeStrategyStepEvidenceV1(
  stepValue: unknown,
  receiptValue: unknown
): KnowledgeStrategyStepEvidenceV1 {
  const step = createKnowledgeStrategyStepRequestV1(stepValue);
  const receipt = createKnowledgeStrategyStepReceiptV1(receiptValue);
  const requestHash = hashKnowledgeStrategyStepRequestV1(step);
  if (receipt.executionId !== step.executionId || receipt.stepId !== step.stepId ||
    receipt.requestHash !== requestHash) {
    throwInvalid("knowledge_strategy_step_evidence_binding_mismatch");
  }
  return Object.freeze({
    executionId: step.executionId,
    kind: step.kind,
    ordinal: step.ordinal,
    requestHash,
    resultHash: hashKnowledgeStrategyStepReceiptV1(receipt),
    stepId: step.stepId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function canonicalKnowledgeStrategyStepEvidenceV1(value: unknown): string {
  const decoded = decodeKnowledgeStrategyStepEvidenceV1(value) ??
    throwInvalid("knowledge_strategy_step_evidence_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyStepEvidenceV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyStepEvidenceV1(value));
}

export type KnowledgeStrategyDependencyV1 = Readonly<{
  dependentStepId: string;
  executionId: string;
  prerequisiteStepId: string;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const dependencyKeys = [
  "dependentStepId",
  "executionId",
  "prerequisiteStepId",
  "version"
] as const;

export function decodeKnowledgeStrategyDependencyV1(
  value: unknown
): KnowledgeStrategyDependencyV1 | null {
  if (!record(value) || !exactKeys(value, dependencyKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !identifier(value.dependentStepId) || !identifier(value.executionId) ||
    !identifier(value.prerequisiteStepId)) return null;
  return Object.freeze({
    dependentStepId: value.dependentStepId,
    executionId: value.executionId,
    prerequisiteStepId: value.prerequisiteStepId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function createKnowledgeStrategyDependencyV1(value: unknown): KnowledgeStrategyDependencyV1 {
  return decodeKnowledgeStrategyDependencyV1(value) ??
    throwInvalid("knowledge_strategy_dependency_invalid");
}

export function canonicalKnowledgeStrategyDependencyV1(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyDependencyV1(value));
}

export function hashKnowledgeStrategyDependencyV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyDependencyV1(value));
}

export type KnowledgeStrategyStepReceiptV1 = Readonly<{
  cursorExhausted: boolean;
  executionId: string;
  lastItemHash: string | null;
  nextCursor: KnowledgeStrategyCursorV1 | null;
  processedItemCount: number;
  processedItemsHash: string;
  reasonCode: string | null;
  requestHash: string;
  status: KnowledgeStrategyStepResultStatus;
  stepId: string;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const stepReceiptKeys = [
  "cursorExhausted",
  "executionId",
  "lastItemHash",
  "nextCursor",
  "processedItemCount",
  "processedItemsHash",
  "reasonCode",
  "requestHash",
  "status",
  "stepId",
  "version"
] as const;

export function decodeKnowledgeStrategyStepReceiptV1(
  value: unknown
): KnowledgeStrategyStepReceiptV1 | null {
  if (!record(value) || !exactKeys(value, stepReceiptKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    typeof value.cursorExhausted !== "boolean" || !identifier(value.executionId) ||
    value.lastItemHash !== null && !hash(value.lastItemHash) ||
    !boundedInteger(value.processedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.processedItemsHash) ||
    value.reasonCode !== null && !reasonCode(value.reasonCode) ||
    !hash(value.requestHash) || typeof value.status !== "string" ||
    !(KNOWLEDGE_STRATEGY_STEP_RESULT_STATUSES as readonly string[]).includes(value.status) ||
    !identifier(value.stepId)) return null;
  const nextCursor = value.nextCursor === null
    ? null
    : decodeKnowledgeStrategyCursorV1(value.nextCursor);
  if (value.nextCursor !== null && !nextCursor) return null;
  const succeeded = value.status === "succeeded";
  if (succeeded && value.reasonCode !== null || !succeeded && value.reasonCode === null ||
    succeeded && value.cursorExhausted !== (nextCursor === null) ||
    !succeeded && (value.cursorExhausted || nextCursor !== null) ||
    (Number(value.processedItemCount) === 0) !== (value.lastItemHash === null) ||
    nextCursor !== null && nextCursor.previousItemHash !== value.lastItemHash) return null;
  return deepFreeze({
    cursorExhausted: value.cursorExhausted,
    executionId: value.executionId,
    lastItemHash: value.lastItemHash as string | null,
    nextCursor,
    processedItemCount: Number(value.processedItemCount),
    processedItemsHash: value.processedItemsHash,
    reasonCode: value.reasonCode as string | null,
    requestHash: value.requestHash,
    status: value.status as KnowledgeStrategyStepResultStatus,
    stepId: value.stepId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function createKnowledgeStrategyStepReceiptV1(value: unknown): KnowledgeStrategyStepReceiptV1 {
  return decodeKnowledgeStrategyStepReceiptV1(value) ??
    throwInvalid("knowledge_strategy_step_receipt_invalid");
}

export function canonicalKnowledgeStrategyStepReceiptV1(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyStepReceiptV1(value));
}

export function hashKnowledgeStrategyStepReceiptV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyStepReceiptV1(value));
}

export type KnowledgeStrategyDependencyEvidenceEntryV1 = Readonly<{
  processedItemsHash: string;
  requestHash: string;
  resultHash: string;
  stepId: string;
}>;

export type KnowledgeStrategyDependencyEvidenceInputV1 = Readonly<{
  dependentStepId: string;
  executionId: string;
  prerequisites: readonly KnowledgeStrategyDependencyEvidenceEntryV1[];
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

export function decodeKnowledgeStrategyDependencyEvidenceInputV1(
  value: unknown
): KnowledgeStrategyDependencyEvidenceInputV1 | null {
  if (!record(value) || !exactKeys(value, [
    "dependentStepId",
    "executionId",
    "prerequisites",
    "version"
  ]) || value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !identifier(value.dependentStepId) || !identifier(value.executionId) ||
    !Array.isArray(value.prerequisites) || value.prerequisites.length < 1 ||
    value.prerequisites.length > KNOWLEDGE_STRATEGY_MAX_STEPS) return null;
  const prerequisites: KnowledgeStrategyDependencyEvidenceEntryV1[] = [];
  for (const entry of value.prerequisites) {
    if (!record(entry) || !exactKeys(entry, [
      "processedItemsHash",
      "requestHash",
      "resultHash",
      "stepId"
    ]) || !hash(entry.processedItemsHash) || !hash(entry.requestHash) ||
      !hash(entry.resultHash) || !identifier(entry.stepId)) return null;
    prerequisites.push(Object.freeze({
      processedItemsHash: entry.processedItemsHash,
      requestHash: entry.requestHash,
      resultHash: entry.resultHash,
      stepId: entry.stepId
    }));
  }
  prerequisites.sort((left, right) => compareStrings(left.stepId, right.stepId));
  if (new Set(prerequisites.map(({ stepId }) => stepId)).size !== prerequisites.length) return null;
  return deepFreeze({
    dependentStepId: value.dependentStepId,
    executionId: value.executionId,
    prerequisites,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function canonicalKnowledgeStrategyDependencyEvidenceInputV1(value: unknown): string {
  const decoded = decodeKnowledgeStrategyDependencyEvidenceInputV1(value) ??
    throwInvalid("knowledge_strategy_dependency_evidence_input_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyDependencyEvidenceInputV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyDependencyEvidenceInputV1(value));
}

export function deriveKnowledgeStrategyDependencyEvidenceInputV1(
  executionId: string,
  dependentStepId: string,
  dependencies: readonly KnowledgeStrategyDependencyV1[],
  receipts: readonly KnowledgeStrategyStepReceiptV1[]
): KnowledgeStrategyDependencyEvidenceInputV1 | null {
  if (!identifier(executionId) || !identifier(dependentStepId)) return null;
  const prerequisiteIds = dependencies.filter((dependency) =>
    dependency.executionId === executionId && dependency.dependentStepId === dependentStepId)
    .map(({ prerequisiteStepId }) => prerequisiteStepId);
  if (prerequisiteIds.length < 1 || new Set(prerequisiteIds).size !== prerequisiteIds.length) {
    return null;
  }
  const receiptsById = new Map(receipts.map((receipt) => [receipt.stepId, receipt]));
  const prerequisiteReceipts = prerequisiteIds.map((stepId) => receiptsById.get(stepId));
  if (prerequisiteReceipts.some((receipt) => !receipt ||
    receipt.executionId !== executionId || receipt.status !== "succeeded")) return null;
  return decodeKnowledgeStrategyDependencyEvidenceInputV1({
    dependentStepId,
    executionId,
    prerequisites: (prerequisiteReceipts as KnowledgeStrategyStepReceiptV1[]).map((receipt) => ({
      processedItemsHash: receipt.processedItemsHash,
      requestHash: receipt.requestHash,
      resultHash: hashKnowledgeStrategyStepReceiptV1(receipt),
      stepId: receipt.stepId
    })),
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export type KnowledgeStrategyMaterializationPrerequisiteV1 = Readonly<{
  receipt: KnowledgeStrategyStepReceiptV1;
  request: KnowledgeStrategyStepRequestV1;
}>;

export function decodeKnowledgeStrategyMaterializationPrerequisiteV1(
  value: unknown
): KnowledgeStrategyMaterializationPrerequisiteV1 | null {
  if (!record(value) || !exactKeys(value, ["receipt", "request"])) return null;
  const request = decodeKnowledgeStrategyStepRequestV1(value.request);
  const receipt = decodeKnowledgeStrategyStepReceiptV1(value.receipt);
  if (!request || !receipt || receipt.executionId !== request.executionId ||
    receipt.stepId !== request.stepId ||
    receipt.requestHash !== hashKnowledgeStrategyStepRequestV1(request)) return null;
  return deepFreeze({ receipt, request });
}

function directDependencyIdsForMaterialization(
  template: KnowledgeStrategyStepTemplateV1,
  dependencies: readonly KnowledgeStrategyDependencyV1[]
): readonly string[] | null {
  if (dependencies.length > KNOWLEDGE_STRATEGY_MAX_DEPENDENCIES ||
    dependencies.some((dependency) =>
      !decodeKnowledgeStrategyDependencyV1(dependency) ||
      dependency.executionId !== template.executionId)) return null;
  const directIds = dependencies.filter(({ dependentStepId }) =>
    dependentStepId === template.stepId).map(({ prerequisiteStepId }) => prerequisiteStepId)
    .sort(compareStrings);
  return new Set(directIds).size === directIds.length ? directIds : null;
}

export function materializeKnowledgeStrategyStepRequestV1(
  templateValue: unknown,
  dependencies: readonly KnowledgeStrategyDependencyV1[],
  prerequisiteValues: readonly unknown[]
): KnowledgeStrategyStepRequestV1 | null {
  const template = decodeKnowledgeStrategyStepTemplateV1(templateValue);
  if (!template || !Array.isArray(dependencies) || !Array.isArray(prerequisiteValues) ||
    prerequisiteValues.length > KNOWLEDGE_STRATEGY_MAX_STEPS) return null;
  const { materializationMode, ...requestShape } = template;
  if (materializationMode === "complete") {
    return decodeKnowledgeStrategyStepRequestV1(stepRequestShapeFromTemplate(requestShape));
  }

  const directIds = directDependencyIdsForMaterialization(template, dependencies);
  if (!directIds || directIds.length === 0) return null;
  const prerequisites: KnowledgeStrategyMaterializationPrerequisiteV1[] = [];
  for (const prerequisiteValue of prerequisiteValues) {
    const prerequisite = decodeKnowledgeStrategyMaterializationPrerequisiteV1(prerequisiteValue);
    if (!prerequisite || prerequisite.request.executionId !== template.executionId ||
      prerequisite.receipt.status !== "succeeded") return null;
    prerequisites.push(prerequisite);
  }
  prerequisites.sort((left, right) => compareStrings(left.request.stepId, right.request.stepId));
  if (new Set(prerequisites.map(({ request }) => request.stepId)).size !==
      prerequisites.length ||
    canonicalJson(prerequisites.map(({ request }) => request.stepId)) !==
      canonicalJson(directIds)) return null;

  if (materializationMode === "cursor_from_predecessor") {
    const immediatePredecessors = prerequisites.filter(({ request }) =>
      request.kind === template.kind && request.streamId === template.streamId &&
      request.sourceBindingId === template.sourceBindingId &&
      request.targetOrdinal === template.targetOrdinal &&
      request.pageOrdinal === template.pageOrdinal - 1);
    if (immediatePredecessors.length !== 1) return null;
    const predecessorReceipt = immediatePredecessors[0]!.receipt;
    if (!predecessorReceipt.nextCursor || predecessorReceipt.cursorExhausted) return null;
    return decodeKnowledgeStrategyStepRequestV1({
      ...requestShape,
      cursor: predecessorReceipt.nextCursor
    });
  }

  const evidenceInput = deriveKnowledgeStrategyDependencyEvidenceInputV1(
    template.executionId,
    template.stepId,
    dependencies,
    prerequisites.map(({ receipt }) => receipt)
  );
  if (!evidenceInput) return null;
  return decodeKnowledgeStrategyStepRequestV1({
    ...requestShape,
    evidenceInputHash: hashKnowledgeStrategyDependencyEvidenceInputV1(evidenceInput)
  });
}

export function validateKnowledgeStrategyStepMaterializationV1(
  templateValue: unknown,
  requestValue: unknown,
  dependencies: readonly KnowledgeStrategyDependencyV1[],
  prerequisiteValues: readonly unknown[]
): boolean {
  const expected = materializeKnowledgeStrategyStepRequestV1(
    templateValue,
    dependencies,
    prerequisiteValues
  );
  const request = decodeKnowledgeStrategyStepRequestV1(requestValue);
  return expected !== null && request !== null &&
    canonicalKnowledgeStrategyStepRequestV1(expected) ===
      canonicalKnowledgeStrategyStepRequestV1(request);
}

type KnowledgeStrategyOutcomeStepProjectionV1 = Readonly<{
  evidence: KnowledgeStrategyStepEvidenceV1 | null;
  ordinal: number;
  pageOrdinal: number;
  processedItemCount: number | null;
  processedItemsHash: string | null;
  requestHash: string;
  stepId: string;
}>;

function outcomeStepProjections(
  steps: readonly KnowledgeStrategyStepRequestV1[],
  receipts: readonly KnowledgeStrategyStepReceiptV1[],
  include: (step: KnowledgeStrategyStepRequestV1) => boolean
): readonly KnowledgeStrategyOutcomeStepProjectionV1[] | null {
  if (!Array.isArray(steps) || steps.length > KNOWLEDGE_STRATEGY_MAX_STEPS ||
    !Array.isArray(receipts) || receipts.length > KNOWLEDGE_STRATEGY_MAX_STEPS) return null;
  const decodedSteps = steps.map(decodeKnowledgeStrategyStepRequestV1);
  const decodedReceipts = receipts.map(decodeKnowledgeStrategyStepReceiptV1);
  if (decodedSteps.some((step) => step === null) ||
    decodedReceipts.some((receipt) => receipt === null)) return null;
  const strictSteps = decodedSteps as KnowledgeStrategyStepRequestV1[];
  const strictReceipts = decodedReceipts as KnowledgeStrategyStepReceiptV1[];
  if (new Set(strictSteps.map(({ stepId }) => stepId)).size !== strictSteps.length ||
    new Set(strictSteps.map(({ ordinal }) => ordinal)).size !== strictSteps.length ||
    new Set(strictReceipts.map(({ stepId }) => stepId)).size !== strictReceipts.length) return null;
  const stepsById = new Map(strictSteps.map((step) => [step.stepId, step]));
  const receiptsById = new Map(strictReceipts.map((receipt) => [receipt.stepId, receipt]));
  if (strictReceipts.some((receipt) => {
    const step = stepsById.get(receipt.stepId);
    return !step || receipt.executionId !== step.executionId ||
      receipt.requestHash !== hashKnowledgeStrategyStepRequestV1(step);
  })) return null;
  const selected = strictSteps.filter(include).sort((left, right) =>
    left.pageOrdinal - right.pageOrdinal || left.ordinal - right.ordinal ||
    compareStrings(left.stepId, right.stepId));
  return deepFreeze(selected.map((step) => {
    const receipt = receiptsById.get(step.stepId) ?? null;
    return {
      evidence: receipt ? sealKnowledgeStrategyStepEvidenceV1(step, receipt) : null,
      ordinal: step.ordinal,
      pageOrdinal: step.pageOrdinal,
      processedItemCount: receipt?.processedItemCount ?? null,
      processedItemsHash: receipt?.processedItemsHash ?? null,
      requestHash: hashKnowledgeStrategyStepRequestV1(step),
      stepId: step.stepId
    };
  }));
}

function sourceProcessedItemsHashOrNull(
  sourceBindingId: string,
  steps: readonly KnowledgeStrategyStepRequestV1[],
  receipts: readonly KnowledgeStrategyStepReceiptV1[]
): string | null {
  if (!identifier(sourceBindingId)) return null;
  const projections = outcomeStepProjections(
    steps,
    receipts,
    (step) => step.sourceBindingId === sourceBindingId
  );
  return projections ? sha256(canonicalJson({
    kind: "source_processed_items",
    sourceBindingId,
    steps: projections,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  })) : null;
}

export function hashKnowledgeStrategySourceProcessedItemsV1(
  sourceBindingId: string,
  steps: readonly KnowledgeStrategyStepRequestV1[],
  receipts: readonly KnowledgeStrategyStepReceiptV1[]
): string {
  return sourceProcessedItemsHashOrNull(sourceBindingId, steps, receipts) ??
    throwInvalid("knowledge_strategy_source_processed_items_invalid");
}

function targetEvidenceItemsHashOrNull(
  targetOrdinal: number,
  steps: readonly KnowledgeStrategyStepRequestV1[],
  receipts: readonly KnowledgeStrategyStepReceiptV1[]
): string | null {
  if (!boundedInteger(targetOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_TARGETS - 1)) return null;
  const projections = outcomeStepProjections(
    steps,
    receipts,
    (step) => step.targetOrdinal === targetOrdinal
  );
  return projections ? sha256(canonicalJson({
    kind: "target_evidence_items",
    steps: projections,
    targetOrdinal,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  })) : null;
}

export function hashKnowledgeStrategyTargetEvidenceItemsV1(
  targetOrdinal: number,
  steps: readonly KnowledgeStrategyStepRequestV1[],
  receipts: readonly KnowledgeStrategyStepReceiptV1[]
): string {
  return targetEvidenceItemsHashOrNull(targetOrdinal, steps, receipts) ??
    throwInvalid("knowledge_strategy_target_evidence_items_invalid");
}

export const KNOWLEDGE_STRATEGY_SOURCE_OUTCOME_STATUSES = Object.freeze([
  "covered",
  "not_found",
  "not_ready",
  "unavailable",
  "failed",
  "ambiguous",
  "cancelled"
] as const);

export const KNOWLEDGE_STRATEGY_TARGET_OUTCOME_STATUSES = Object.freeze([
  "covered",
  "not_found",
  "not_present",
  "not_ready",
  "unavailable",
  "failed",
  "ambiguous",
  "cancelled"
] as const);

export type KnowledgeStrategySourceOutcomeStatus =
  typeof KNOWLEDGE_STRATEGY_SOURCE_OUTCOME_STATUSES[number];
export type KnowledgeStrategyTargetOutcomeStatus =
  typeof KNOWLEDGE_STRATEGY_TARGET_OUTCOME_STATUSES[number];

export type KnowledgeStrategySourceOutcomeV1 = Readonly<{
  cursorExhausted: boolean;
  expectedPassageCount: number;
  processedItemsHash: string;
  processedPassageCount: number;
  reasonCode: string | null;
  sourceBindingId: string;
  status: KnowledgeStrategySourceOutcomeStatus;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const sourceOutcomeKeys = [
  "cursorExhausted",
  "expectedPassageCount",
  "processedItemsHash",
  "processedPassageCount",
  "reasonCode",
  "sourceBindingId",
  "status",
  "version"
] as const;

export function decodeKnowledgeStrategySourceOutcomeV1(
  value: unknown
): KnowledgeStrategySourceOutcomeV1 | null {
  if (!record(value) || !exactKeys(value, sourceOutcomeKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    typeof value.cursorExhausted !== "boolean" ||
    !boundedInteger(value.expectedPassageCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.processedItemsHash) ||
    !boundedInteger(value.processedPassageCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    Number(value.processedPassageCount) > Number(value.expectedPassageCount) ||
    value.reasonCode !== null && !reasonCode(value.reasonCode) ||
    !identifier(value.sourceBindingId) || typeof value.status !== "string" ||
    !(KNOWLEDGE_STRATEGY_SOURCE_OUTCOME_STATUSES as readonly string[])
      .includes(value.status)) return null;
  const complete = value.status === "covered" || value.status === "not_found";
  if (complete !== value.cursorExhausted || complete !== (value.reasonCode === null)) return null;
  return Object.freeze({
    cursorExhausted: value.cursorExhausted,
    expectedPassageCount: Number(value.expectedPassageCount),
    processedItemsHash: value.processedItemsHash,
    processedPassageCount: Number(value.processedPassageCount),
    reasonCode: value.reasonCode as string | null,
    sourceBindingId: value.sourceBindingId,
    status: value.status as KnowledgeStrategySourceOutcomeStatus,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export type KnowledgeStrategyTargetOutcomeV1 = Readonly<{
  evidenceItemCount: number;
  evidenceItemsHash: string;
  ordinal: number;
  reasonCode: string | null;
  referenceHash: string;
  sourceBindingId: string | null;
  status: KnowledgeStrategyTargetOutcomeStatus;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const targetOutcomeKeys = [
  "evidenceItemCount",
  "evidenceItemsHash",
  "ordinal",
  "reasonCode",
  "referenceHash",
  "sourceBindingId",
  "status",
  "version"
] as const;

export function decodeKnowledgeStrategyTargetOutcomeV1(
  value: unknown
): KnowledgeStrategyTargetOutcomeV1 | null {
  if (!record(value) || !exactKeys(value, targetOutcomeKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !boundedInteger(value.evidenceItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.evidenceItemsHash) ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAX_TARGETS - 1) ||
    value.reasonCode !== null && !reasonCode(value.reasonCode) ||
    !hash(value.referenceHash) ||
    value.sourceBindingId !== null && !identifier(value.sourceBindingId) ||
    typeof value.status !== "string" ||
    !(KNOWLEDGE_STRATEGY_TARGET_OUTCOME_STATUSES as readonly string[])
      .includes(value.status)) return null;
  const status = value.status as KnowledgeStrategyTargetOutcomeStatus;
  const clean = status === "covered" || status === "not_found" || status === "not_present";
  if (clean !== (value.reasonCode === null) ||
    status === "covered" && (value.sourceBindingId === null || value.evidenceItemCount === 0) ||
    status === "not_found" && (value.sourceBindingId === null || value.evidenceItemCount !== 0) ||
    status === "not_present" && (value.sourceBindingId !== null || value.evidenceItemCount !== 0) ||
    !clean && value.evidenceItemCount !== 0) return null;
  return Object.freeze({
    evidenceItemCount: Number(value.evidenceItemCount),
    evidenceItemsHash: value.evidenceItemsHash,
    ordinal: Number(value.ordinal),
    reasonCode: value.reasonCode as string | null,
    referenceHash: value.referenceHash,
    sourceBindingId: value.sourceBindingId as string | null,
    status,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export type KnowledgeStrategyDispatchReceiptV1 = Readonly<{
  excludedItemCount: number;
  expectedItemCount: number;
  expectedItemsHash: string;
  includedItemCount: number;
  includedItemsHash: string;
  manifestHash: string;
  shortenedItemCount: number;
  unavailableItemCount: number;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

/**
 * Content-free projection of a durably validated corpus-summary map output.
 *
 * The private map output owns Source identities and summary text. Coverage only
 * needs its sealed receipt to prove that every frozen Source was completely
 * mapped and that the reduce input was derived from those exact outputs.
 */
export type KnowledgeStrategyMapOutputReceiptProofV2 = Readonly<{
  executionId: string;
  inputPageReceiptCount: number;
  inputPageReceiptsHash: string;
  inputPassageCount: number;
  inputPassageItemsHash: string;
  inputSectionCount: number;
  inputSectionHashesHash: string;
  mapInputHash: string;
  outputHash: string;
  processedPassageCount: number;
  receiptHash: string;
  sourceBindingId: string;
  sourceOrdinal: number;
  summaryItemCount: number;
  summaryItemsHash: string;
  terminalStepId: string;
  version: 2;
}>;

const mapOutputReceiptProofBodyKeys = [
  "executionId",
  "inputPageReceiptCount",
  "inputPageReceiptsHash",
  "inputPassageCount",
  "inputPassageItemsHash",
  "inputSectionCount",
  "inputSectionHashesHash",
  "mapInputHash",
  "outputHash",
  "processedPassageCount",
  "sourceBindingId",
  "sourceOrdinal",
  "summaryItemCount",
  "summaryItemsHash",
  "terminalStepId",
  "version"
] as const;
const mapOutputReceiptProofKeys = [...mapOutputReceiptProofBodyKeys, "receiptHash"] as const;

export function decodeKnowledgeStrategyMapOutputReceiptProofV2(
  value: unknown
): KnowledgeStrategyMapOutputReceiptProofV2 | null {
  if (!record(value) || !exactKeys(value, mapOutputReceiptProofKeys) || value.version !== 2 ||
    !identifier(value.executionId) ||
    !boundedInteger(value.inputPageReceiptCount, 1, KNOWLEDGE_STRATEGY_MAX_STEPS) ||
    !hash(value.inputPageReceiptsHash) ||
    !boundedInteger(value.inputPassageCount, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.inputPassageItemsHash) ||
    !boundedInteger(value.inputSectionCount, 1, 64) ||
    !hash(value.inputSectionHashesHash) || !hash(value.mapInputHash) ||
    !hash(value.outputHash) ||
    !boundedInteger(value.processedPassageCount, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    value.processedPassageCount !== value.inputPassageCount || !hash(value.receiptHash) ||
    !identifier(value.sourceBindingId) ||
    !boundedInteger(value.sourceOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES - 1) ||
    !boundedInteger(value.summaryItemCount, 1, 64) ||
    value.summaryItemCount !== value.inputSectionCount || !hash(value.summaryItemsHash) ||
    !identifier(value.terminalStepId)) return null;
  const body = Object.fromEntries(mapOutputReceiptProofBodyKeys.map((key) => [key, value[key]]));
  if (sha256(canonicalJson(body)) !== value.receiptHash) return null;
  return deepFreeze({
    executionId: value.executionId,
    inputPageReceiptCount: Number(value.inputPageReceiptCount),
    inputPageReceiptsHash: value.inputPageReceiptsHash,
    inputPassageCount: Number(value.inputPassageCount),
    inputPassageItemsHash: value.inputPassageItemsHash,
    inputSectionCount: Number(value.inputSectionCount),
    inputSectionHashesHash: value.inputSectionHashesHash,
    mapInputHash: value.mapInputHash,
    outputHash: value.outputHash,
    processedPassageCount: Number(value.processedPassageCount),
    receiptHash: value.receiptHash,
    sourceBindingId: value.sourceBindingId,
    sourceOrdinal: Number(value.sourceOrdinal),
    summaryItemCount: Number(value.summaryItemCount),
    summaryItemsHash: value.summaryItemsHash,
    terminalStepId: value.terminalStepId,
    version: 2
  });
}

export function createKnowledgeStrategyMapOutputReceiptProofV2(
  value: unknown
): KnowledgeStrategyMapOutputReceiptProofV2 {
  return decodeKnowledgeStrategyMapOutputReceiptProofV2(value) ??
    throwInvalid("knowledge_strategy_map_output_receipt_proof_invalid");
}

export function canonicalKnowledgeStrategyMapOutputReceiptProofV2(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyMapOutputReceiptProofV2(value));
}

export function hashKnowledgeStrategyMapOutputReceiptProofV2(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyMapOutputReceiptProofV2(value));
}

export type KnowledgeStrategySummaryDispatchBindingV2 = Readonly<{
  evidenceHash: string;
  evidenceId: string;
  itemHash: string;
  outputHash: string;
  sourceBindingId: string;
  sourceOrdinal: number;
  version: 2;
}>;

const summaryDispatchBindingKeys = [
  "evidenceHash",
  "evidenceId",
  "itemHash",
  "outputHash",
  "sourceBindingId",
  "sourceOrdinal",
  "version"
] as const;

export function decodeKnowledgeStrategySummaryDispatchBindingV2(
  value: unknown
): KnowledgeStrategySummaryDispatchBindingV2 | null {
  if (!record(value) || !exactKeys(value, summaryDispatchBindingKeys) || value.version !== 2 ||
    !hash(value.evidenceHash) || typeof value.evidenceId !== "string" ||
    value.evidenceId.length < 1 || value.evidenceId.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(value.evidenceId) || !hash(value.itemHash) ||
    !hash(value.outputHash) || !identifier(value.sourceBindingId) ||
    !boundedInteger(value.sourceOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES - 1)) return null;
  return Object.freeze({
    evidenceHash: value.evidenceHash,
    evidenceId: value.evidenceId,
    itemHash: value.itemHash,
    outputHash: value.outputHash,
    sourceBindingId: value.sourceBindingId,
    sourceOrdinal: Number(value.sourceOrdinal),
    version: 2
  });
}

export function createKnowledgeStrategySummaryDispatchBindingV2(
  value: unknown
): KnowledgeStrategySummaryDispatchBindingV2 {
  return decodeKnowledgeStrategySummaryDispatchBindingV2(value) ??
    throwInvalid("knowledge_strategy_summary_dispatch_binding_invalid");
}

export function hashKnowledgeStrategySummaryDispatchBindingsV2(
  values: readonly unknown[]
): string {
  if (!Array.isArray(values) || values.length < 1 ||
    values.length > KNOWLEDGE_STRATEGY_MAX_SOURCES) {
    throwInvalid("knowledge_strategy_summary_dispatch_bindings_invalid");
  }
  const decoded = values.map(createKnowledgeStrategySummaryDispatchBindingV2)
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  if (new Set(decoded.map(({ sourceBindingId }) => sourceBindingId)).size !== decoded.length ||
    new Set(decoded.map(({ evidenceId }) => evidenceId)).size !== decoded.length) {
    throwInvalid("knowledge_strategy_summary_dispatch_bindings_invalid");
  }
  return sha256(canonicalJson(decoded));
}

export function hashKnowledgeStrategySummaryEvidenceSetV2(
  values: readonly unknown[]
): string {
  if (!Array.isArray(values) || values.length < 1 ||
    values.length > KNOWLEDGE_STRATEGY_MAX_SOURCES) {
    throwInvalid("knowledge_strategy_summary_dispatch_bindings_invalid");
  }
  const decoded = values.map(createKnowledgeStrategySummaryDispatchBindingV2)
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  if (new Set(decoded.map(({ sourceBindingId }) => sourceBindingId)).size !== decoded.length) {
    throwInvalid("knowledge_strategy_summary_dispatch_bindings_invalid");
  }
  return sha256(canonicalJson(decoded.map((binding) => ({
    evidenceHash: binding.evidenceHash,
    outputHash: binding.outputHash,
    sourceBindingId: binding.sourceBindingId,
    sourceOrdinal: binding.sourceOrdinal,
    version: 2 as const
  }))));
}

export function deriveKnowledgeStrategyMapOutputDependencyHashV2(input: Readonly<{
  dependentStepId: string;
  executionId: string;
  receipts: readonly unknown[];
  sourceSetHash: string;
}>): string {
  if (!identifier(input.dependentStepId) || !identifier(input.executionId) ||
    !hash(input.sourceSetHash) || !Array.isArray(input.receipts) || input.receipts.length < 1 ||
    input.receipts.length > KNOWLEDGE_STRATEGY_MAX_SOURCES) {
    throwInvalid("knowledge_strategy_map_output_dependency_invalid");
  }
  const receipts = input.receipts.map(createKnowledgeStrategyMapOutputReceiptProofV2)
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  if (new Set(receipts.map(({ sourceBindingId }) => sourceBindingId)).size !== receipts.length ||
    new Set(receipts.map(({ terminalStepId }) => terminalStepId)).size !== receipts.length ||
    receipts.some(({ executionId }) => executionId !== input.executionId)) {
    throwInvalid("knowledge_strategy_map_output_dependency_invalid");
  }
  const mapOutputs = receipts.map((receipt) => ({
    outputHash: receipt.outputHash,
    receiptHash: receipt.receiptHash,
    sourceBindingId: receipt.sourceBindingId,
    sourceOrdinal: receipt.sourceOrdinal,
    summaryItemsHash: receipt.summaryItemsHash,
    terminalStepId: receipt.terminalStepId,
    version: 2 as const
  }));
  const body = {
    dependentStepId: input.dependentStepId,
    executionId: input.executionId,
    mapOutputCount: mapOutputs.length,
    mapOutputs,
    mapOutputsHash: sha256(canonicalJson(mapOutputs)),
    sourceSetHash: input.sourceSetHash,
    version: 2 as const
  };
  return sha256(canonicalJson(body));
}

const dispatchReceiptKeys = [
  "excludedItemCount",
  "expectedItemCount",
  "expectedItemsHash",
  "includedItemCount",
  "includedItemsHash",
  "manifestHash",
  "shortenedItemCount",
  "unavailableItemCount",
  "version"
] as const;

export function decodeKnowledgeStrategyDispatchReceiptV1(
  value: unknown
): KnowledgeStrategyDispatchReceiptV1 | null {
  if (!record(value) || !exactKeys(value, dispatchReceiptKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !boundedInteger(value.excludedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !boundedInteger(value.expectedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.expectedItemsHash) ||
    !boundedInteger(value.includedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.includedItemsHash) || !hash(value.manifestHash) ||
    !boundedInteger(value.shortenedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !boundedInteger(value.unavailableItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    Number(value.includedItemCount) + Number(value.excludedItemCount) +
      Number(value.unavailableItemCount) !== Number(value.expectedItemCount) ||
    Number(value.shortenedItemCount) > Number(value.includedItemCount)) return null;
  return Object.freeze({
    excludedItemCount: Number(value.excludedItemCount),
    expectedItemCount: Number(value.expectedItemCount),
    expectedItemsHash: value.expectedItemsHash,
    includedItemCount: Number(value.includedItemCount),
    includedItemsHash: value.includedItemsHash,
    manifestHash: value.manifestHash,
    shortenedItemCount: Number(value.shortenedItemCount),
    unavailableItemCount: Number(value.unavailableItemCount),
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export type KnowledgeStrategyCoverageRequestV1 = Readonly<{
  dependencies: readonly KnowledgeStrategyDependencyV1[];
  dispatch: KnowledgeStrategyDispatchReceiptV1;
  executionHash: string;
  mapOutputReceipts: readonly KnowledgeStrategyMapOutputReceiptProofV2[];
  observedSourceSet: readonly KnowledgeAcceptedSourceTupleV1[];
  observedSourceSetHash: string;
  sourceOutcomes: readonly KnowledgeStrategySourceOutcomeV1[];
  stepReceipts: readonly KnowledgeStrategyStepReceiptV1[];
  steps: readonly KnowledgeStrategyStepRequestV1[];
  summaryDispatchBindings: readonly KnowledgeStrategySummaryDispatchBindingV2[];
  targetOutcomes: readonly KnowledgeStrategyTargetOutcomeV1[];
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

const coverageRequestKeys = [
  "dependencies",
  "dispatch",
  "executionHash",
  "mapOutputReceipts",
  "observedSourceSet",
  "observedSourceSetHash",
  "sourceOutcomes",
  "stepReceipts",
  "steps",
  "summaryDispatchBindings",
  "targetOutcomes",
  "version"
] as const;

function decodeBoundedArray<T>(
  value: unknown,
  maximum: number,
  decode: (entry: unknown) => T | null
): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const decoded = value.map(decode);
  return decoded.some((entry) => entry === null) ? null : decoded as T[];
}

export function decodeKnowledgeStrategyCoverageRequestV1(
  value: unknown
): KnowledgeStrategyCoverageRequestV1 | null {
  if (!record(value) || !exactKeys(value, coverageRequestKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !hash(value.executionHash) || !hash(value.observedSourceSetHash)) return null;
  const observedSourceSet = decodeKnowledgeAcceptedSourceSetV1(value.observedSourceSet);
  const steps = decodeBoundedArray(
    value.steps,
    KNOWLEDGE_STRATEGY_MAX_STEPS,
    decodeKnowledgeStrategyStepRequestV1
  );
  const dependencies = decodeBoundedArray(
    value.dependencies,
    KNOWLEDGE_STRATEGY_MAX_DEPENDENCIES,
    decodeKnowledgeStrategyDependencyV1
  );
  const stepReceipts = decodeBoundedArray(
    value.stepReceipts,
    KNOWLEDGE_STRATEGY_MAX_STEPS,
    decodeKnowledgeStrategyStepReceiptV1
  );
  const mapOutputReceipts = decodeBoundedArray(
    value.mapOutputReceipts,
    KNOWLEDGE_STRATEGY_MAX_SOURCES,
    decodeKnowledgeStrategyMapOutputReceiptProofV2
  );
  const summaryDispatchBindings = decodeBoundedArray(
    value.summaryDispatchBindings,
    KNOWLEDGE_STRATEGY_MAX_SOURCES,
    decodeKnowledgeStrategySummaryDispatchBindingV2
  );
  const sourceOutcomes = decodeBoundedArray(
    value.sourceOutcomes,
    KNOWLEDGE_STRATEGY_MAX_SOURCES,
    decodeKnowledgeStrategySourceOutcomeV1
  );
  const targetOutcomes = decodeBoundedArray(
    value.targetOutcomes,
    KNOWLEDGE_STRATEGY_MAX_TARGETS,
    decodeKnowledgeStrategyTargetOutcomeV1
  );
  const dispatch = decodeKnowledgeStrategyDispatchReceiptV1(value.dispatch);
  if (!observedSourceSet ||
    hashKnowledgeAcceptedSourceSetV1(observedSourceSet) !== value.observedSourceSetHash ||
    !steps || !dependencies || !stepReceipts || !mapOutputReceipts ||
    !summaryDispatchBindings || !sourceOutcomes || !targetOutcomes ||
    !dispatch) return null;
  steps.sort((left, right) => left.ordinal - right.ordinal ||
    compareStrings(left.stepId, right.stepId));
  dependencies.sort((left, right) =>
    compareStrings(left.dependentStepId, right.dependentStepId) ||
    compareStrings(left.prerequisiteStepId, right.prerequisiteStepId));
  stepReceipts.sort((left, right) => compareStrings(left.stepId, right.stepId));
  sourceOutcomes.sort((left, right) =>
    compareStrings(left.sourceBindingId, right.sourceBindingId));
  mapOutputReceipts.sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  summaryDispatchBindings.sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  targetOutcomes.sort((left, right) => left.ordinal - right.ordinal);
  if (new Set(steps.map(({ stepId }) => stepId)).size !== steps.length ||
    new Set(steps.map(({ ordinal }) => ordinal)).size !== steps.length ||
    new Set(dependencies.map((dependency) =>
      `${dependency.prerequisiteStepId}\u0000${dependency.dependentStepId}`)).size !==
      dependencies.length ||
    new Set(stepReceipts.map(({ stepId }) => stepId)).size !== stepReceipts.length ||
    new Set(sourceOutcomes.map(({ sourceBindingId }) => sourceBindingId)).size !==
      sourceOutcomes.length ||
    new Set(mapOutputReceipts.map(({ sourceBindingId }) => sourceBindingId)).size !==
      mapOutputReceipts.length ||
    new Set(mapOutputReceipts.map(({ terminalStepId }) => terminalStepId)).size !==
      mapOutputReceipts.length ||
    new Set(summaryDispatchBindings.map(({ sourceBindingId }) => sourceBindingId)).size !==
      summaryDispatchBindings.length ||
    new Set(summaryDispatchBindings.map(({ evidenceId }) => evidenceId)).size !==
      summaryDispatchBindings.length ||
    new Set(targetOutcomes.map(({ ordinal }) => ordinal)).size !== targetOutcomes.length) return null;
  return deepFreeze({
    dependencies,
    dispatch,
    executionHash: value.executionHash,
    mapOutputReceipts,
    observedSourceSet,
    observedSourceSetHash: value.observedSourceSetHash,
    sourceOutcomes,
    stepReceipts,
    steps,
    summaryDispatchBindings,
    targetOutcomes,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function createKnowledgeStrategyCoverageRequestV1(
  value: unknown
): KnowledgeStrategyCoverageRequestV1 {
  return decodeKnowledgeStrategyCoverageRequestV1(value) ??
    throwInvalid("knowledge_strategy_coverage_request_invalid");
}

export function canonicalKnowledgeStrategyCoverageRequestV1(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyCoverageRequestV1(value));
}

export function hashKnowledgeStrategyCoverageRequestV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyCoverageRequestV1(value));
}

export type KnowledgeStrategyCoverageReceiptV1 = Readonly<{
  dispatchExpectedItemCount: number;
  dispatchIncludedItemCount: number;
  dispatchManifestHash: string;
  executionHash: string;
  executionId: string;
  expectedItemsHash: string;
  includedItemsHash: string;
  observedSourceSetHash: string;
  processedItemsHash: string;
  processedPassageCount: number;
  processedSourceCount: number;
  reasonCodes: readonly string[];
  receiptHash: string;
  requiredStepCount: number;
  settledTargetCount: number;
  status: KnowledgeStrategyCoverageStatus;
  strategy: KnowledgeMeasuredStrategy;
  sourceSetHash: string;
  terminalRequiredStepCount: number;
  totalPassageCount: number;
  totalSourceCount: number;
  totalTargetCount: number;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

export type KnowledgeStrategyCoverageReceiptBodyV1 = Omit<
  KnowledgeStrategyCoverageReceiptV1,
  "receiptHash"
>;

const coverageReceiptBodyKeys = [
  "dispatchExpectedItemCount",
  "dispatchIncludedItemCount",
  "dispatchManifestHash",
  "executionHash",
  "executionId",
  "expectedItemsHash",
  "includedItemsHash",
  "observedSourceSetHash",
  "processedItemsHash",
  "processedPassageCount",
  "processedSourceCount",
  "reasonCodes",
  "requiredStepCount",
  "settledTargetCount",
  "status",
  "strategy",
  "sourceSetHash",
  "terminalRequiredStepCount",
  "totalPassageCount",
  "totalSourceCount",
  "totalTargetCount",
  "version"
] as const;
const coverageReceiptKeys = [...coverageReceiptBodyKeys, "receiptHash"] as const;

function decodeCoverageReceiptBody(value: unknown): KnowledgeStrategyCoverageReceiptBodyV1 | null {
  if (!record(value) || !exactKeys(value, coverageReceiptBodyKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !boundedInteger(value.dispatchExpectedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !boundedInteger(value.dispatchIncludedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    Number(value.dispatchIncludedItemCount) > Number(value.dispatchExpectedItemCount) ||
    !hash(value.dispatchManifestHash) ||
    !hash(value.executionHash) || !identifier(value.executionId) ||
    !hash(value.expectedItemsHash) || !hash(value.includedItemsHash) ||
    !hash(value.observedSourceSetHash) ||
    !hash(value.processedItemsHash) ||
    !boundedInteger(value.processedPassageCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !boundedInteger(value.processedSourceCount, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES) ||
    !Array.isArray(value.reasonCodes) || value.reasonCodes.length > KNOWLEDGE_STRATEGY_MAX_REASONS ||
    value.reasonCodes.some((entry) => !reasonCode(entry)) ||
    new Set(value.reasonCodes).size !== value.reasonCodes.length ||
    !boundedInteger(value.requiredStepCount, 0, KNOWLEDGE_STRATEGY_MAX_STEPS) ||
    !boundedInteger(value.settledTargetCount, 0, KNOWLEDGE_STRATEGY_MAX_TARGETS) ||
    typeof value.status !== "string" ||
    !(KNOWLEDGE_STRATEGY_COVERAGE_STATUSES as readonly string[]).includes(value.status) ||
    typeof value.strategy !== "string" ||
    !(KNOWLEDGE_STRATEGIES as readonly string[]).includes(value.strategy) ||
    !hash(value.sourceSetHash) ||
    !boundedInteger(value.terminalRequiredStepCount, 0, KNOWLEDGE_STRATEGY_MAX_STEPS) ||
    Number(value.terminalRequiredStepCount) > Number(value.requiredStepCount) ||
    !boundedInteger(value.totalPassageCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    Number(value.processedPassageCount) > Number(value.totalPassageCount) ||
    !boundedInteger(value.totalSourceCount, 1, KNOWLEDGE_STRATEGY_MAX_SOURCES) ||
    Number(value.processedSourceCount) > Number(value.totalSourceCount) ||
    !boundedInteger(value.totalTargetCount, 0, KNOWLEDGE_STRATEGY_MAX_TARGETS) ||
    Number(value.settledTargetCount) > Number(value.totalTargetCount)) return null;
  const sortedReasons = [...(value.reasonCodes as string[])].sort(compareStrings);
  const exhaustiveStrategy = value.strategy === "full_context" ||
    value.strategy === "exhaustive" || value.strategy === "corpus_summary";
  const verifiedTruth = value.sourceSetHash === value.observedSourceSetHash &&
    (!exhaustiveStrategy ||
      value.processedPassageCount === value.totalPassageCount &&
      value.processedSourceCount === value.totalSourceCount) &&
    value.terminalRequiredStepCount === value.requiredStepCount &&
    value.settledTargetCount === value.totalTargetCount &&
    value.dispatchExpectedItemCount === value.dispatchIncludedItemCount &&
    value.expectedItemsHash === value.includedItemsHash;
  if (sortedReasons.some((entry, index) =>
    entry !== (value.reasonCodes as string[])[index]) ||
    (value.status === "verified") !== (sortedReasons.length === 0 && verifiedTruth)) return null;
  return deepFreeze({
    dispatchExpectedItemCount: Number(value.dispatchExpectedItemCount),
    dispatchIncludedItemCount: Number(value.dispatchIncludedItemCount),
    dispatchManifestHash: value.dispatchManifestHash,
    executionHash: value.executionHash,
    executionId: value.executionId,
    expectedItemsHash: value.expectedItemsHash,
    includedItemsHash: value.includedItemsHash,
    observedSourceSetHash: value.observedSourceSetHash,
    processedItemsHash: value.processedItemsHash,
    processedPassageCount: Number(value.processedPassageCount),
    processedSourceCount: Number(value.processedSourceCount),
    reasonCodes: Object.freeze(sortedReasons),
    requiredStepCount: Number(value.requiredStepCount),
    settledTargetCount: Number(value.settledTargetCount),
    status: value.status as KnowledgeStrategyCoverageStatus,
    strategy: value.strategy as KnowledgeMeasuredStrategy,
    sourceSetHash: value.sourceSetHash,
    terminalRequiredStepCount: Number(value.terminalRequiredStepCount),
    totalPassageCount: Number(value.totalPassageCount),
    totalSourceCount: Number(value.totalSourceCount),
    totalTargetCount: Number(value.totalTargetCount),
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function sealKnowledgeStrategyCoverageReceiptV1(
  value: unknown
): KnowledgeStrategyCoverageReceiptV1 {
  const body = decodeCoverageReceiptBody(value) ??
    throwInvalid("knowledge_strategy_coverage_receipt_body_invalid");
  return deepFreeze({ ...body, receiptHash: sha256(canonicalJson(body)) });
}

export function decodeKnowledgeStrategyCoverageReceiptV1(
  value: unknown
): KnowledgeStrategyCoverageReceiptV1 | null {
  if (!record(value) || !exactKeys(value, coverageReceiptKeys) || !hash(value.receiptHash)) return null;
  const { receiptHash, ...untrustedBody } = value;
  const body = decodeCoverageReceiptBody(untrustedBody);
  if (!body || sha256(canonicalJson(body)) !== receiptHash) return null;
  return deepFreeze({ ...body, receiptHash });
}

export function createKnowledgeStrategyCoverageReceiptV1(
  value: unknown
): KnowledgeStrategyCoverageReceiptV1 {
  return decodeKnowledgeStrategyCoverageReceiptV1(value) ??
    throwInvalid("knowledge_strategy_coverage_receipt_invalid");
}

export function canonicalKnowledgeStrategyCoverageReceiptV1(value: unknown): string {
  return canonicalJson(createKnowledgeStrategyCoverageReceiptV1(value));
}

export function hashKnowledgeStrategyCoverageReceiptV1(value: unknown): string {
  return sha256(canonicalKnowledgeStrategyCoverageReceiptV1(value));
}

export function createKnowledgeStrategyNextCursorV1(
  stepValue: unknown,
  lastItemValue: unknown
): KnowledgeStrategyCursorV1 {
  const step = createKnowledgeStrategyStepRequestV1(stepValue);
  const lastItem = decodeKnowledgeStrategyPassageItemV1(lastItemValue) ??
    throwInvalid("knowledge_strategy_cursor_last_item_invalid");
  if (!paginatedStepKind(step.kind) || step.sourceBindingId !== lastItem.sourceBindingId) {
    throwInvalid("knowledge_strategy_cursor_step_mismatch");
  }
  if (step.pageOrdinal >= KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL ||
    step.cursor !== null && step.cursor.sourceOrdinal !== lastItem.sourceOrdinal) {
    throwInvalid("knowledge_strategy_cursor_boundary_mismatch");
  }
  const minimumOrdinal = step.cursor?.nextPassageOrdinal ?? 0;
  if (lastItem.passageOrdinal < minimumOrdinal) {
    throwInvalid("knowledge_strategy_cursor_not_monotonic");
  }
  return Object.freeze({
    executionId: step.executionId,
    nextPassageOrdinal: lastItem.passageOrdinal + 1,
    pageOrdinal: step.pageOrdinal + 1,
    previousItemHash: hashKnowledgeStrategyPassageItemV1(lastItem),
    sourceBindingId: lastItem.sourceBindingId,
    sourceOrdinal: lastItem.sourceOrdinal,
    streamId: step.streamId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export const KNOWLEDGE_STRATEGY_DAG_FAILURES = Object.freeze([
  "invalid_execution_id",
  "step_limit",
  "dependency_limit",
  "duplicate_step",
  "duplicate_step_ordinal",
  "cross_execution",
  "missing_step",
  "self_dependency",
  "duplicate_dependency",
  "cycle"
] as const);

export type KnowledgeStrategyDagFailure = typeof KNOWLEDGE_STRATEGY_DAG_FAILURES[number];
export type KnowledgeStrategyDagValidationV1 =
  | Readonly<{
      topologicalStepIds: readonly string[];
      valid: true;
    }>
  | Readonly<{
      reason: KnowledgeStrategyDagFailure;
      valid: false;
    }>;

type KnowledgeStrategyStepIdentityV1 =
  KnowledgeStrategyStepRequestV1 | KnowledgeStrategyStepTemplateV1;

export function validateKnowledgeStrategyDagV1(
  executionId: string,
  steps: readonly KnowledgeStrategyStepIdentityV1[],
  dependencies: readonly KnowledgeStrategyDependencyV1[]
): KnowledgeStrategyDagValidationV1 {
  if (!identifier(executionId)) return Object.freeze({ reason: "invalid_execution_id", valid: false });
  if (steps.length > KNOWLEDGE_STRATEGY_MAX_STEPS) {
    return Object.freeze({ reason: "step_limit", valid: false });
  }
  if (dependencies.length > KNOWLEDGE_STRATEGY_MAX_DEPENDENCIES) {
    return Object.freeze({ reason: "dependency_limit", valid: false });
  }
  if (new Set(steps.map(({ stepId }) => stepId)).size !== steps.length) {
    return Object.freeze({ reason: "duplicate_step", valid: false });
  }
  if (new Set(steps.map(({ ordinal }) => ordinal)).size !== steps.length) {
    return Object.freeze({ reason: "duplicate_step_ordinal", valid: false });
  }
  if (steps.some((step) => step.executionId !== executionId) ||
    dependencies.some((dependency) => dependency.executionId !== executionId)) {
    return Object.freeze({ reason: "cross_execution", valid: false });
  }
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  if (dependencies.some((dependency) =>
    !byId.has(dependency.prerequisiteStepId) || !byId.has(dependency.dependentStepId))) {
    return Object.freeze({ reason: "missing_step", valid: false });
  }
  if (dependencies.some((dependency) =>
    dependency.prerequisiteStepId === dependency.dependentStepId)) {
    return Object.freeze({ reason: "self_dependency", valid: false });
  }
  const edgeKeys = dependencies.map((dependency) =>
    `${dependency.prerequisiteStepId}\u0000${dependency.dependentStepId}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) {
    return Object.freeze({ reason: "duplicate_dependency", valid: false });
  }

  const indegree = new Map(steps.map((step) => [step.stepId, 0]));
  const outgoing = new Map(steps.map((step) => [step.stepId, [] as string[]]));
  for (const dependency of dependencies) {
    indegree.set(dependency.dependentStepId, indegree.get(dependency.dependentStepId)! + 1);
    outgoing.get(dependency.prerequisiteStepId)!.push(dependency.dependentStepId);
  }
  const ready = steps.filter((step) => indegree.get(step.stepId) === 0)
    .sort((left, right) => left.ordinal - right.ordinal || compareStrings(left.stepId, right.stepId));
  const topologicalStepIds: string[] = [];
  while (ready.length > 0) {
    const step = ready.shift()!;
    topologicalStepIds.push(step.stepId);
    for (const dependentId of outgoing.get(step.stepId)!) {
      const nextIndegree = indegree.get(dependentId)! - 1;
      indegree.set(dependentId, nextIndegree);
      if (nextIndegree === 0) {
        const dependent = byId.get(dependentId)!;
        ready.push(dependent);
        ready.sort((left, right) => left.ordinal - right.ordinal ||
          compareStrings(left.stepId, right.stepId));
      }
    }
  }
  if (topologicalStepIds.length !== steps.length) {
    return Object.freeze({ reason: "cycle", valid: false });
  }
  return deepFreeze({ topologicalStepIds, valid: true });
}

export type KnowledgeStrategyStepStateSnapshotV1 = Readonly<{
  executionId: string;
  resultStatus: KnowledgeStrategyStepResultStatus | null;
  state: KnowledgeStrategyStepState;
  stepId: string;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

export function eligibleKnowledgeStrategyStepIdsV1(
  executionId: string,
  steps: readonly KnowledgeStrategyStepRequestV1[],
  dependencies: readonly KnowledgeStrategyDependencyV1[],
  snapshots: readonly KnowledgeStrategyStepStateSnapshotV1[]
): readonly string[] {
  const dag = validateKnowledgeStrategyDagV1(executionId, steps, dependencies);
  if (!dag.valid || snapshots.length !== steps.length ||
    new Set(snapshots.map(({ stepId }) => stepId)).size !== snapshots.length ||
    snapshots.some((snapshot) => snapshot.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
      snapshot.executionId !== executionId ||
      !(KNOWLEDGE_STRATEGY_STEP_STATES as readonly string[]).includes(snapshot.state) ||
      snapshot.resultStatus !== null &&
        !(KNOWLEDGE_STRATEGY_STEP_RESULT_STATUSES as readonly string[])
          .includes(snapshot.resultStatus))) return Object.freeze([]);
  const byStepId = new Map(snapshots.map((snapshot) => [snapshot.stepId, snapshot]));
  if (steps.some((step) => !byStepId.has(step.stepId))) return Object.freeze([]);
  const prerequisites = new Map(steps.map((step) => [step.stepId, [] as string[]]));
  for (const dependency of dependencies) {
    prerequisites.get(dependency.dependentStepId)!.push(dependency.prerequisiteStepId);
  }
  return Object.freeze(dag.topologicalStepIds.filter((stepId) => {
    const snapshot = byStepId.get(stepId)!;
    return snapshot.state === "pending" && snapshot.resultStatus === null &&
      prerequisites.get(stepId)!.every((prerequisiteId) => {
        const prerequisite = byStepId.get(prerequisiteId)!;
        return prerequisite.state === "settled" && prerequisite.resultStatus === "succeeded";
      });
  }));
}

export type KnowledgeStrategyStepLifecycleV1 = Readonly<{
  attemptCount: number;
  executionId: string;
  failureCode: string | null;
  irreversibleDispatch: boolean;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  receiptHash: string | null;
  state: KnowledgeStrategyStepState;
  stateVersion: number;
  stepId: string;
  version: typeof KNOWLEDGE_STRATEGY_EXECUTION_VERSION;
}>;

export const KNOWLEDGE_STRATEGY_STEP_TRANSITION_ACTIONS = Object.freeze([
  "claim",
  "release",
  "mark_dispatched",
  "settle",
  "fail",
  "mark_ambiguous",
  "cancel",
  "purge"
] as const);

export type KnowledgeStrategyStepTransitionAction =
  typeof KNOWLEDGE_STRATEGY_STEP_TRANSITION_ACTIONS[number];

export type KnowledgeStrategyStepCasTransitionV1 = Readonly<{
  action: KnowledgeStrategyStepTransitionAction;
  at: string;
  expectedLeaseToken: string | null;
  expectedState: KnowledgeStrategyStepState;
  expectedStateVersion: number;
  failureCode: string | null;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  receiptHash: string | null;
}>;

export type KnowledgeStrategyStepCasResultV1 =
  | Readonly<{ kind: "cas_mismatch" }>
  | Readonly<{ kind: "illegal_transition" }>
  | Readonly<{ kind: "transitioned"; value: KnowledgeStrategyStepLifecycleV1 }>;

export function decodeKnowledgeStrategyStepLifecycleV1(
  value: unknown
): KnowledgeStrategyStepLifecycleV1 | null {
  const keys = [
    "attemptCount",
    "executionId",
    "failureCode",
    "irreversibleDispatch",
    "leaseExpiresAt",
    "leaseToken",
    "receiptHash",
    "state",
    "stateVersion",
    "stepId",
    "version"
  ] as const;
  if (!record(value) || !exactKeys(value, keys) ||
    value.version !== KNOWLEDGE_STRATEGY_EXECUTION_VERSION ||
    !boundedInteger(value.attemptCount, 0, 1_000_000) || !identifier(value.executionId) ||
    value.failureCode !== null && !reasonCode(value.failureCode) ||
    typeof value.irreversibleDispatch !== "boolean" ||
    value.leaseExpiresAt !== null && !timestamp(value.leaseExpiresAt) ||
    value.leaseToken !== null && !identifier(value.leaseToken) ||
    value.receiptHash !== null && !hash(value.receiptHash) ||
    typeof value.state !== "string" ||
    !(KNOWLEDGE_STRATEGY_STEP_STATES as readonly string[]).includes(value.state) ||
    !boundedInteger(value.stateVersion, 0, 2_147_483_647) || !identifier(value.stepId)) return null;
  const state = value.state as KnowledgeStrategyStepState;
  const running = state === "running";
  if (running !== (value.leaseToken !== null && value.leaseExpiresAt !== null) ||
    (state === "settled") !== (value.receiptHash !== null) ||
    (["failed", "ambiguous", "cancelled"].includes(state)) !==
      (value.failureCode !== null) ||
    state === "pending" && (value.receiptHash !== null || value.failureCode !== null ||
      value.irreversibleDispatch) ||
    state === "purged" && (value.receiptHash !== null || value.failureCode !== null) ||
    value.irreversibleDispatch && !["running", "settled", "ambiguous", "purged"]
      .includes(state)) return null;
  return Object.freeze({
    attemptCount: Number(value.attemptCount),
    executionId: value.executionId,
    failureCode: value.failureCode as string | null,
    irreversibleDispatch: value.irreversibleDispatch,
    leaseExpiresAt: value.leaseExpiresAt as string | null,
    leaseToken: value.leaseToken as string | null,
    receiptHash: value.receiptHash as string | null,
    state,
    stateVersion: Number(value.stateVersion),
    stepId: value.stepId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

export function isLegalKnowledgeStrategyStepTransitionV1(
  current: KnowledgeStrategyStepLifecycleV1,
  action: KnowledgeStrategyStepTransitionAction
): boolean {
  switch (action) {
    case "claim": return current.state === "pending";
    case "release": return current.state === "running" && !current.irreversibleDispatch;
    case "mark_dispatched": return current.state === "running" && !current.irreversibleDispatch;
    case "settle": return current.state === "running";
    case "fail": return current.state === "running" && !current.irreversibleDispatch;
    case "mark_ambiguous": return current.state === "running" && current.irreversibleDispatch;
    case "cancel": return current.state === "pending" ||
      current.state === "running" && !current.irreversibleDispatch;
    case "purge": return ["settled", "failed", "ambiguous", "cancelled"]
      .includes(current.state);
  }
}

export function applyKnowledgeStrategyStepCasTransitionV1(
  currentValue: unknown,
  transition: KnowledgeStrategyStepCasTransitionV1
): KnowledgeStrategyStepCasResultV1 {
  const current = decodeKnowledgeStrategyStepLifecycleV1(currentValue);
  if (!current || !timestamp(transition.at) ||
    !(KNOWLEDGE_STRATEGY_STEP_TRANSITION_ACTIONS as readonly string[])
      .includes(transition.action) ||
    !boundedInteger(transition.expectedStateVersion, 0, 2_147_483_647) ||
    transition.expectedLeaseToken !== null && !identifier(transition.expectedLeaseToken) ||
    transition.leaseToken !== null && !identifier(transition.leaseToken) ||
    transition.leaseExpiresAt !== null && !timestamp(transition.leaseExpiresAt) ||
    transition.receiptHash !== null && !hash(transition.receiptHash) ||
    transition.failureCode !== null && !reasonCode(transition.failureCode)) {
    return Object.freeze({ kind: "illegal_transition" });
  }
  if (current.state !== transition.expectedState ||
    current.stateVersion !== transition.expectedStateVersion ||
    current.leaseToken !== transition.expectedLeaseToken) {
    return Object.freeze({ kind: "cas_mismatch" });
  }
  if (!isLegalKnowledgeStrategyStepTransitionV1(current, transition.action)) {
    return Object.freeze({ kind: "illegal_transition" });
  }
  const base = {
    ...current,
    stateVersion: current.stateVersion + 1
  };
  let next: KnowledgeStrategyStepLifecycleV1;
  switch (transition.action) {
    case "claim":
      if (!transition.leaseToken || !transition.leaseExpiresAt ||
        transition.failureCode || transition.receiptHash ||
        Date.parse(transition.leaseExpiresAt) <= Date.parse(transition.at)) {
        return Object.freeze({ kind: "illegal_transition" });
      }
      next = {
        ...base,
        attemptCount: current.attemptCount + 1,
        leaseExpiresAt: transition.leaseExpiresAt,
        leaseToken: transition.leaseToken,
        state: "running"
      };
      break;
    case "release":
      if (transition.leaseToken || transition.leaseExpiresAt ||
        transition.failureCode || transition.receiptHash) {
        return Object.freeze({ kind: "illegal_transition" });
      }
      next = { ...base, leaseExpiresAt: null, leaseToken: null, state: "pending" };
      break;
    case "mark_dispatched":
      if (transition.leaseToken || transition.leaseExpiresAt ||
        transition.failureCode || transition.receiptHash) {
        return Object.freeze({ kind: "illegal_transition" });
      }
      next = { ...base, irreversibleDispatch: true };
      break;
    case "settle":
      if (!transition.receiptHash || transition.failureCode ||
        transition.leaseToken || transition.leaseExpiresAt) {
        return Object.freeze({ kind: "illegal_transition" });
      }
      next = {
        ...base,
        leaseExpiresAt: null,
        leaseToken: null,
        receiptHash: transition.receiptHash,
        state: "settled"
      };
      break;
    case "fail":
    case "mark_ambiguous":
    case "cancel":
      if (!transition.failureCode || transition.receiptHash ||
        transition.leaseToken || transition.leaseExpiresAt) {
        return Object.freeze({ kind: "illegal_transition" });
      }
      next = {
        ...base,
        failureCode: transition.failureCode,
        leaseExpiresAt: null,
        leaseToken: null,
        state: transition.action === "fail"
          ? "failed"
          : transition.action === "mark_ambiguous" ? "ambiguous" : "cancelled"
      };
      break;
    case "purge":
      if (transition.failureCode || transition.receiptHash ||
        transition.leaseToken || transition.leaseExpiresAt) {
        return Object.freeze({ kind: "illegal_transition" });
      }
      next = {
        ...base,
        failureCode: null,
        irreversibleDispatch: current.irreversibleDispatch,
        receiptHash: null,
        state: "purged"
      };
      break;
  }
  const decoded = decodeKnowledgeStrategyStepLifecycleV1(next);
  return decoded
    ? deepFreeze({ kind: "transitioned", value: decoded })
    : Object.freeze({ kind: "illegal_transition" });
}

function directPrerequisites(
  steps: readonly KnowledgeStrategyStepIdentityV1[],
  dependencies: readonly KnowledgeStrategyDependencyV1[]
): Map<string, Set<string>> {
  const result = new Map(steps.map((step) => [step.stepId, new Set<string>()]));
  for (const dependency of dependencies) {
    result.get(dependency.dependentStepId)?.add(dependency.prerequisiteStepId);
  }
  return result;
}

function allAncestors(
  stepId: string,
  prerequisites: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlySet<string> {
  const result = new Set<string>();
  const pending = [...(prerequisites.get(stepId) ?? [])];
  while (pending.length > 0) {
    const prerequisiteId = pending.pop()!;
    if (result.has(prerequisiteId)) continue;
    result.add(prerequisiteId);
    pending.push(...(prerequisites.get(prerequisiteId) ?? []));
  }
  return result;
}

function paginationInvariantReasons(
  steps: readonly KnowledgeStrategyStepIdentityV1[],
  dependencies: readonly KnowledgeStrategyDependencyV1[],
  templates: boolean
): readonly string[] {
  const reasons = new Set<string>();
  const prerequisiteMap = directPrerequisites(steps, dependencies);
  const streams = new Map<string, KnowledgeStrategyStepIdentityV1[]>();
  for (const step of steps.filter(({ kind }) => paginatedStepKind(kind))) {
    const stream = streams.get(step.streamId) ?? [];
    stream.push(step);
    streams.set(step.streamId, stream);
  }
  for (const stream of streams.values()) {
    stream.sort((left, right) => left.pageOrdinal - right.pageOrdinal);
    const first = stream[0]!;
    if (first.pageOrdinal !== 0 || first.cursor !== null ||
      templates && (!("materializationMode" in first) ||
        first.materializationMode !== "complete")) reasons.add("pagination_start_invalid");
    for (let index = 1; index < stream.length; index += 1) {
      const previous = stream[index - 1]!;
      const current = stream[index]!;
      const continuationInvalid = templates
        ? !("materializationMode" in current) ||
          current.materializationMode !== "cursor_from_predecessor" || current.cursor !== null
        : current.cursor === null;
      if (current.pageOrdinal !== previous.pageOrdinal + 1 || continuationInvalid ||
        current.kind !== first.kind || current.sourceBindingId !== first.sourceBindingId ||
        current.targetOrdinal !== first.targetOrdinal ||
        !prerequisiteMap.get(current.stepId)?.has(previous.stepId)) {
        reasons.add("pagination_chain_invalid");
      }
    }
  }
  return Object.freeze([...reasons].sort(compareStrings));
}

export function knowledgeStrategyInvariantReasonCodesV1(
  executionValue: unknown,
  steps: readonly KnowledgeStrategyStepRequestV1[],
  dependencies: readonly KnowledgeStrategyDependencyV1[]
): readonly string[] {
  return strategyInvariantReasonCodesV1(executionValue, steps, dependencies, false);
}

export function knowledgeStrategyTemplateInvariantReasonCodesV1(
  executionValue: unknown,
  templates: readonly KnowledgeStrategyStepTemplateV1[],
  dependencies: readonly KnowledgeStrategyDependencyV1[]
): readonly string[] {
  if (!Array.isArray(templates) || templates.some((template) =>
    !decodeKnowledgeStrategyStepTemplateV1(template))) {
    return Object.freeze(["strategy_template_invalid"]);
  }
  if (!Array.isArray(dependencies) || dependencies.some((dependency) =>
    !decodeKnowledgeStrategyDependencyV1(dependency))) {
    return Object.freeze(["strategy_dependency_invalid"]);
  }
  return strategyInvariantReasonCodesV1(executionValue, templates, dependencies, true);
}

function strategyInvariantReasonCodesV1(
  executionValue: unknown,
  steps: readonly KnowledgeStrategyStepIdentityV1[],
  dependencies: readonly KnowledgeStrategyDependencyV1[],
  templates: boolean
): readonly string[] {
  const execution = createKnowledgeStrategyExecutionRequestV1(executionValue);
  const reasons = new Set<string>();
  const dag = validateKnowledgeStrategyDagV1(execution.executionId, steps, dependencies);
  if (!dag.valid) reasons.add(`dag_${dag.reason}`);
  if (steps.length === 0) reasons.add("strategy_steps_missing");
  if (steps.some((step) => step.executionId !== execution.executionId ||
    step.strategy !== execution.strategy || step.sourceSetHash !== execution.sourceSetHash)) {
    reasons.add("strategy_step_binding_mismatch");
  }
  const sourceIds = new Set(execution.sourceSet.map(({ bindingId }) => bindingId));
  if (steps.some(({ sourceBindingId }) =>
    sourceBindingId !== null && !sourceIds.has(sourceBindingId))) {
    reasons.add("strategy_source_scope_expanded");
  }
  const sourcesByBindingId = new Map(execution.sourceSet.map((source) =>
    [source.bindingId, source]));
  if (steps.some((step) => step.cursor !== null &&
    sourcesByBindingId.get(step.sourceBindingId ?? "")?.ordinal !==
      step.cursor.sourceOrdinal)) reasons.add("strategy_cursor_source_mismatch");
  for (const reason of paginationInvariantReasons(steps, dependencies, templates)) {
    reasons.add(reason);
  }
  const prerequisites = directPrerequisites(steps, dependencies);
  const config = execution.config;

  switch (config.kind) {
    case "full_context": {
      if (steps.some(({ kind }) => kind !== "full_context_page")) {
        reasons.add("full_context_step_kind_invalid");
      }
      const firstPages = steps.filter(({ kind, pageOrdinal }) =>
        kind === "full_context_page" && pageOrdinal === 0);
      if (firstPages.length !== execution.sourceSet.length ||
        new Set(firstPages.map(({ sourceBindingId }) => sourceBindingId)).size !==
        execution.sourceSet.length || execution.sourceSet.some(({ bindingId }) =>
        !firstPages.some((step) => step.sourceBindingId === bindingId && step.required))) {
        reasons.add("full_context_source_missing");
      }
      break;
    }
    case "exhaustive": {
      if (steps.some(({ kind, inputHash }) => kind !== "exhaustive_page" ||
        inputHash !== config.queryHash)) reasons.add("exhaustive_step_invalid");
      const firstPages = steps.filter(({ pageOrdinal }) => pageOrdinal === 0);
      if (firstPages.length !== execution.sourceSet.length ||
        new Set(firstPages.map(({ sourceBindingId }) => sourceBindingId)).size !==
        execution.sourceSet.length || execution.sourceSet.some(({ bindingId }) =>
        !firstPages.some((step) => step.sourceBindingId === bindingId && step.required))) {
        reasons.add("exhaustive_source_missing");
      }
      break;
    }
    case "comparison": {
      if (steps.some(({ kind, comparisonDimensionHash }) =>
        kind !== "comparison_target" ||
        comparisonDimensionHash !== config.dimensionHash)) {
        reasons.add("comparison_dimension_mismatch");
      }
      for (const target of config.targets) {
        const targetSteps = steps.filter((step) => step.targetOrdinal === target.ordinal);
        if (target.admission === "resolved") {
          const firstPages = targetSteps.filter(({ pageOrdinal }) => pageOrdinal === 0);
          if (firstPages.length !== 1 || firstPages[0]!.sourceBindingId !== target.sourceBindingId ||
            !firstPages[0]!.required) reasons.add("comparison_target_step_missing");
        } else if (targetSteps.length > 0) reasons.add("comparison_unresolved_target_dispatched");
      }
      if (steps.some((step) => !config.targets.some((target) =>
        target.ordinal === step.targetOrdinal && target.sourceBindingId === step.sourceBindingId))) {
        reasons.add("comparison_target_scope_mismatch");
      }
      break;
    }
    case "corpus_summary": {
      const mapSteps = steps.filter(({ kind }) => kind === "corpus_summary_map");
      const reduceSteps = steps.filter(({ kind }) => kind === "corpus_summary_reduce");
      if (mapSteps.some(({ inputHash }) => inputHash !== config.mapInputHash) ||
        reduceSteps.some(({ inputHash }) => inputHash !== config.reduceInputHash)) {
        reasons.add("corpus_summary_input_mismatch");
      }
      const firstMaps = mapSteps.filter(({ pageOrdinal }) => pageOrdinal === 0);
      if (firstMaps.length !== execution.sourceSet.length ||
        new Set(firstMaps.map(({ sourceBindingId }) => sourceBindingId)).size !==
        execution.sourceSet.length || execution.sourceSet.some(({ bindingId }) =>
        !firstMaps.some((step) => step.sourceBindingId === bindingId && step.required))) {
        reasons.add("corpus_summary_map_missing");
      }
      if (reduceSteps.length !== 1 || !reduceSteps[0]!.required) {
        reasons.add("corpus_summary_reduce_missing");
      } else {
        if (templates && (!("materializationMode" in reduceSteps[0]!) ||
          reduceSteps[0]!.materializationMode !== "evidence_from_prerequisites")) {
          reasons.add("corpus_summary_reduce_materialization_invalid");
        }
        const reduceAncestors = allAncestors(reduceSteps[0]!.stepId, prerequisites);
        const terminalMaps = mapSteps.filter((step) => !mapSteps.some((candidate) =>
          candidate.streamId === step.streamId && candidate.pageOrdinal > step.pageOrdinal));
        if (terminalMaps.some(({ stepId }) => !reduceAncestors.has(stepId))) {
          reasons.add("corpus_summary_reduce_dependency_missing");
        }
      }
      if (steps.some(({ kind }) =>
        kind !== "corpus_summary_map" && kind !== "corpus_summary_reduce")) {
        reasons.add("corpus_summary_step_kind_invalid");
      }
      break;
    }
    case "multi_hop": {
      const roots = steps.filter(({ kind }) => kind === "multi_hop_root");
      const followUps = steps.filter(({ kind }) => kind === "multi_hop_follow_up");
      const ordered = [...steps].sort((left, right) => left.ordinal - right.ordinal ||
        compareStrings(left.stepId, right.stepId));
      if (roots.length !== 1 || roots[0]!.ordinal !== 0 || !roots[0]!.required ||
        roots[0]!.inputHash !== config.atomicQuestionHashes[0]) {
        reasons.add("multi_hop_atomic_root_missing");
      }
      if (roots.some(({ stepId }) => (prerequisites.get(stepId)?.size ?? 0) > 0)) {
        reasons.add("multi_hop_root_dependency_invalid");
      }
      if (followUps.length !== config.atomicQuestionHashes.length - 1 ||
        ordered.length !== config.atomicQuestionHashes.length ||
        ordered.some((step, ordinal) => ordinal > 0 && (
          step.kind !== "multi_hop_follow_up" || step.ordinal !== ordinal || !step.required ||
          step.inputHash !== config.atomicQuestionHashes[ordinal]
        ))) reasons.add("multi_hop_follow_up_input_mismatch");
      if (ordered.some((step, ordinal) => ordinal > 0 && (
        (prerequisites.get(step.stepId)?.size ?? 0) !== 1 ||
        !prerequisites.get(step.stepId)?.has(ordered[ordinal - 1]!.stepId)
      ))) {
        reasons.add("multi_hop_follow_up_dependency_missing");
      }
      if (templates && (roots.some((root) =>
        !("materializationMode" in root) || root.materializationMode !== "complete") ||
        followUps.some((followUp) => !("materializationMode" in followUp) ||
          followUp.materializationMode !== "evidence_from_prerequisites"))) {
        reasons.add("multi_hop_template_materialization_invalid");
      }
      if (steps.some(({ kind }) => kind !== "multi_hop_root" &&
        kind !== "multi_hop_follow_up")) reasons.add("multi_hop_step_kind_invalid");
      break;
    }
  }
  return Object.freeze([...reasons].sort(compareStrings));
}

function requiredSourceBindingIds(
  execution: KnowledgeStrategyExecutionRequestV1
): ReadonlySet<string> {
  if (execution.config.kind === "multi_hop") return new Set();
  if (execution.config.kind === "comparison") {
    return new Set(execution.config.targets.flatMap(({ sourceBindingId }) =>
      sourceBindingId === null ? [] : [sourceBindingId]));
  }
  return new Set(execution.sourceSet.map(({ bindingId }) => bindingId));
}

function aggregateProcessedItemsHash(
  outcomes: readonly KnowledgeStrategySourceOutcomeV1[]
): string {
  return sha256(canonicalJson(outcomes.map((outcome) => ({
    processedItemsHash: outcome.processedItemsHash,
    sourceBindingId: outcome.sourceBindingId
  }))));
}

function multiHopProcessedItems(
  steps: readonly KnowledgeStrategyStepRequestV1[],
  receipts: readonly KnowledgeStrategyStepReceiptV1[]
): Readonly<{ count: number; hash: string }> {
  const projections = outcomeStepProjections(
    steps,
    receipts,
    ({ kind }) => kind === "multi_hop_root" || kind === "multi_hop_follow_up"
  );
  if (!projections) throwInvalid("knowledge_strategy_multi_hop_processed_items_invalid");
  return Object.freeze({
    count: projections.reduce((sum, projection) =>
      sum + (projection.processedItemCount ?? 0), 0),
    hash: sha256(canonicalJson({
      kind: "multi_hop_processed_items",
      steps: projections,
      version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
    }))
  });
}

function corpusMapPageReceiptsHash(
  steps: readonly KnowledgeStrategyStepRequestV1[],
  receiptsById: ReadonlyMap<string, KnowledgeStrategyStepReceiptV1>
): string | null {
  const ordered = [...steps].sort((left, right) => left.pageOrdinal - right.pageOrdinal ||
    left.ordinal - right.ordinal || compareStrings(left.stepId, right.stepId));
  if (ordered.length < 1 || ordered.some((step, pageOrdinal) =>
    step.kind !== "corpus_summary_map" || step.pageOrdinal !== pageOrdinal)) return null;
  const bindings = ordered.map((step) => {
    const receipt = receiptsById.get(step.stepId);
    return receipt ? {
      pageOrdinal: step.pageOrdinal,
      processedItemCount: receipt.processedItemCount,
      processedItemsHash: receipt.processedItemsHash,
      receiptHash: hashKnowledgeStrategyStepReceiptV1(receipt),
      requestHash: hashKnowledgeStrategyStepRequestV1(step),
      stepId: step.stepId,
      version: 2 as const
    } : null;
  });
  return bindings.some((binding) => binding === null)
    ? null
    : sha256(canonicalJson(bindings));
}

function summaryDispatchProjectionHash(
  bindings: readonly KnowledgeStrategySummaryDispatchBindingV2[]
): string {
  return sha256(canonicalJson(bindings.map(({ evidenceId, itemHash }) => ({
    evidenceId,
    itemHash
  })).sort((left, right) => compareStrings(left.evidenceId, right.evidenceId))));
}

export function deriveKnowledgeStrategyCoverageReceiptV1(
  executionValue: unknown,
  coverageValue: unknown
): KnowledgeStrategyCoverageReceiptV1 {
  const execution = createKnowledgeStrategyExecutionRequestV1(executionValue);
  const coverage = createKnowledgeStrategyCoverageRequestV1(coverageValue);
  const degraded = new Set<string>();
  const partial = new Set<string>();
  const executionHash = hashKnowledgeStrategyExecutionRequestV1(execution);
  if (coverage.executionHash !== executionHash) degraded.add("execution_hash_mismatch");
  if (coverage.observedSourceSetHash !== execution.sourceSetHash) {
    degraded.add("source_set_mismatch");
  }
  for (const reason of knowledgeStrategyInvariantReasonCodesV1(
    execution,
    coverage.steps,
    coverage.dependencies
  )) degraded.add(reason);

  const stepsById = new Map(coverage.steps.map((step) => [step.stepId, step]));
  const receiptsById = new Map(coverage.stepReceipts.map((receipt) => [receipt.stepId, receipt]));
  for (const receipt of coverage.stepReceipts) {
    const step = stepsById.get(receipt.stepId);
    if (!step || receipt.executionId !== execution.executionId ||
      receipt.requestHash !== (step ? hashKnowledgeStrategyStepRequestV1(step) : "")) {
      degraded.add("step_receipt_binding_mismatch");
      continue;
    }
    if (receipt.status !== "succeeded") degraded.add(`step_${receipt.status}`);
    if (!paginatedStepKind(step.kind) && !receipt.cursorExhausted) {
      degraded.add("non_paginated_cursor_open");
    }
    if (receipt.nextCursor) {
      const startOrdinal = step.cursor?.nextPassageOrdinal ?? 0;
      if (receipt.nextCursor.nextPassageOrdinal !==
        startOrdinal + receipt.processedItemCount) degraded.add("cursor_offset_mismatch");
      const matchingSuccessors = coverage.steps.filter((candidate) => candidate.cursor !== null &&
        hashKnowledgeStrategyCursorV1(candidate.cursor) ===
          hashKnowledgeStrategyCursorV1(receipt.nextCursor));
      const samePageSuccessors = coverage.steps.filter((candidate) =>
        candidate.streamId === step.streamId && candidate.pageOrdinal === step.pageOrdinal + 1);
      if (matchingSuccessors.length === 0) {
        if (samePageSuccessors.length > 0) degraded.add("cursor_chain_mismatch");
        else partial.add("cursor_not_exhausted");
      } else if (matchingSuccessors.length > 1) {
        degraded.add("cursor_chain_ambiguous");
      } else if (!receiptsById.has(matchingSuccessors[0]!.stepId)) {
        partial.add("cursor_successor_pending");
      }
    }
  }
  for (const step of coverage.steps) {
    const receipt = receiptsById.get(step.stepId);
    if (step.required && !receipt) partial.add("required_step_pending");
    if (step.cursor) {
      const predecessor = coverage.steps.find((candidate) =>
        candidate.streamId === step.streamId && candidate.pageOrdinal === step.pageOrdinal - 1);
      const predecessorReceipt = predecessor ? receiptsById.get(predecessor.stepId) : undefined;
      if (!predecessor) degraded.add("cursor_predecessor_missing");
      else if (!predecessorReceipt) partial.add("cursor_predecessor_pending");
      else if (!predecessorReceipt.nextCursor ||
        hashKnowledgeStrategyCursorV1(predecessorReceipt.nextCursor) !==
          hashKnowledgeStrategyCursorV1(step.cursor)) degraded.add("cursor_predecessor_mismatch");
    }
    if (step.kind === "multi_hop_follow_up") {
      const evidenceInput = deriveKnowledgeStrategyDependencyEvidenceInputV1(
        execution.executionId,
        step.stepId,
        coverage.dependencies,
        coverage.stepReceipts
      );
      if (!evidenceInput) degraded.add("multi_hop_evidence_input_unverifiable");
      else if (hashKnowledgeStrategyDependencyEvidenceInputV1(evidenceInput) !==
        step.evidenceInputHash) degraded.add("multi_hop_evidence_input_mismatch");
      if (receipt && (
        receipt.processedItemCount === 0 || receipt.lastItemHash === step.evidenceInputHash ||
        receipt.processedItemsHash === step.evidenceInputHash
      )) degraded.add("multi_hop_follow_up_evidence_missing");
    }
  }

  if (execution.strategy !== "corpus_summary") {
    if (coverage.mapOutputReceipts.length > 0) degraded.add("unexpected_map_output_receipt");
    if (coverage.summaryDispatchBindings.length > 0) {
      degraded.add("unexpected_summary_dispatch_binding");
    }
  } else {
    const reduceStep = coverage.steps.find(({ kind }) => kind === "corpus_summary_reduce");
    const reduceReceipt = reduceStep ? receiptsById.get(reduceStep.stepId) : undefined;
    if (!reduceStep || !reduceReceipt) {
      partial.add("corpus_summary_reduce_pending");
    }
    if (coverage.mapOutputReceipts.length !== execution.sourceSet.length) {
      partial.add("corpus_summary_map_output_pending");
    }
    if (coverage.summaryDispatchBindings.length !== execution.sourceSet.length) {
      partial.add("corpus_summary_summary_dispatch_pending");
    }
    for (const source of execution.sourceSet) {
      const sourceSteps = coverage.steps.filter((step) =>
        step.kind === "corpus_summary_map" && step.sourceBindingId === source.bindingId);
      const terminalStep = [...sourceSteps].sort((left, right) =>
        right.pageOrdinal - left.pageOrdinal || right.ordinal - left.ordinal)[0];
      const mapReceipt = coverage.mapOutputReceipts.find(({ sourceBindingId }) =>
        sourceBindingId === source.bindingId);
      const summaryBinding = coverage.summaryDispatchBindings.find(({ sourceBindingId }) =>
        sourceBindingId === source.bindingId);
      const pageReceiptsHash = corpusMapPageReceiptsHash(sourceSteps, receiptsById);
      const processedPassages = sourceSteps.reduce((sum, step) =>
        sum + (receiptsById.get(step.stepId)?.processedItemCount ?? 0), 0);
      if (!terminalStep || !mapReceipt || mapReceipt.executionId !== execution.executionId ||
        mapReceipt.sourceOrdinal !== source.ordinal ||
        mapReceipt.terminalStepId !== terminalStep.stepId ||
        mapReceipt.inputPageReceiptCount !== sourceSteps.length ||
        mapReceipt.inputPageReceiptsHash !== pageReceiptsHash ||
        mapReceipt.inputPassageCount !== source.passageCount ||
        mapReceipt.processedPassageCount !== source.passageCount ||
        processedPassages !== source.passageCount) {
        degraded.add("corpus_summary_map_output_mismatch");
      }
      if (!mapReceipt || !summaryBinding ||
        summaryBinding.sourceOrdinal !== source.ordinal ||
        summaryBinding.outputHash !== mapReceipt.outputHash) {
        degraded.add("corpus_summary_summary_dispatch_mismatch");
      }
    }
    if (reduceStep) {
      try {
        const dependencyHash = deriveKnowledgeStrategyMapOutputDependencyHashV2({
          dependentStepId: reduceStep.stepId,
          executionId: execution.executionId,
          receipts: coverage.mapOutputReceipts,
          sourceSetHash: execution.sourceSetHash
        });
        if (reduceStep.evidenceInputHash !== dependencyHash) {
          degraded.add("corpus_summary_reduce_evidence_input_mismatch");
        }
      } catch {
        degraded.add("corpus_summary_reduce_evidence_input_unverifiable");
      }
    }
    if (summaryDispatchProjectionHash(coverage.summaryDispatchBindings) !==
      coverage.dispatch.includedItemsHash ||
      coverage.dispatch.expectedItemsHash !== coverage.dispatch.includedItemsHash) {
      degraded.add("corpus_summary_summary_manifest_mismatch");
    }
    if (reduceReceipt) {
      let summaryEvidenceSetHash: string | null = null;
      try {
        summaryEvidenceSetHash = hashKnowledgeStrategySummaryEvidenceSetV2(
          coverage.summaryDispatchBindings
        );
      } catch {
        // A missing Source summary is already classified as partial above.
      }
      if (reduceReceipt.processedItemCount !== coverage.summaryDispatchBindings.length ||
        summaryEvidenceSetHash !== null &&
          reduceReceipt.processedItemsHash !== summaryEvidenceSetHash) {
        degraded.add("corpus_summary_reduce_output_mismatch");
      }
    }
  }

  const sourcesById = new Map(execution.sourceSet.map((source) => [source.bindingId, source]));
  for (const outcome of coverage.sourceOutcomes) {
    const source = sourcesById.get(outcome.sourceBindingId);
    if (!source || outcome.expectedPassageCount !== source.passageCount) {
      degraded.add("source_outcome_binding_mismatch");
      continue;
    }
    const expectedProcessedItemsHash = sourceProcessedItemsHashOrNull(
      outcome.sourceBindingId,
      coverage.steps,
      coverage.stepReceipts
    );
    if (!expectedProcessedItemsHash ||
      outcome.processedItemsHash !== expectedProcessedItemsHash) {
      degraded.add("source_processed_items_hash_mismatch");
    }
    const settledStepPassages = coverage.steps.reduce((sum, sourceStep) => {
      const sourceReceipt = receiptsById.get(sourceStep.stepId);
      return sourceStep.sourceBindingId === outcome.sourceBindingId &&
        sourceReceipt
        ? sum + sourceReceipt.processedItemCount
        : sum;
    }, 0);
    if (settledStepPassages !== outcome.processedPassageCount) {
      degraded.add("source_step_count_mismatch");
    }
    if (["not_ready", "unavailable", "failed", "ambiguous", "cancelled"]
      .includes(outcome.status)) degraded.add(`source_${outcome.status}`);
    if (execution.strategy === "full_context" || execution.strategy === "corpus_summary") {
      if (outcome.status !== "covered" ||
        outcome.processedPassageCount !== outcome.expectedPassageCount) {
        degraded.add("source_complete_read_missing");
      }
    } else if (execution.strategy === "exhaustive" &&
      outcome.processedPassageCount !== outcome.expectedPassageCount) {
      partial.add("source_scan_incomplete");
    }
  }
  const requiredSources = requiredSourceBindingIds(execution);
  for (const sourceBindingId of requiredSources) {
    if (!coverage.sourceOutcomes.some((outcome) =>
      outcome.sourceBindingId === sourceBindingId)) partial.add("source_outcome_pending");
  }
  if (coverage.sourceOutcomes.some(({ sourceBindingId }) =>
    !requiredSources.has(sourceBindingId) && execution.strategy !== "multi_hop")) {
    degraded.add("source_outcome_scope_expanded");
  }

  if (execution.config.kind === "comparison") {
    const comparisonConfig = execution.config;
    if (coverage.targetOutcomes.length !== comparisonConfig.targets.length) {
      partial.add("target_outcome_pending");
    }
    for (const target of comparisonConfig.targets) {
      const outcome = coverage.targetOutcomes.find(({ ordinal }) => ordinal === target.ordinal);
      if (!outcome) continue;
      const expectedEvidenceItemsHash = targetEvidenceItemsHashOrNull(
        target.ordinal,
        coverage.steps,
        coverage.stepReceipts
      );
      if (!expectedEvidenceItemsHash ||
        outcome.evidenceItemsHash !== expectedEvidenceItemsHash) {
        degraded.add("target_evidence_items_hash_mismatch");
      }
      const processedTargetItemCount = coverage.steps.reduce((sum, targetStep) => {
        const targetReceipt = receiptsById.get(targetStep.stepId);
        return targetStep.targetOrdinal === target.ordinal && targetReceipt
          ? sum + targetReceipt.processedItemCount
          : sum;
      }, 0);
      if (outcome.evidenceItemCount > processedTargetItemCount) {
        degraded.add("target_evidence_item_count_mismatch");
      }
      if (outcome.referenceHash !== target.referenceHash ||
        outcome.sourceBindingId !== target.sourceBindingId) {
        degraded.add("target_outcome_binding_mismatch");
      }
      if (target.admission === "resolved" &&
        outcome.status !== "covered" && outcome.status !== "not_found" ||
        target.admission === "not_present" && outcome.status !== "not_present" ||
        target.admission === "not_ready" && outcome.status !== "not_ready" ||
        target.admission === "ambiguous" && outcome.status !== "ambiguous") {
        degraded.add("target_outcome_status_mismatch");
      }
      if (["not_ready", "unavailable", "failed", "ambiguous", "cancelled"]
        .includes(outcome.status)) degraded.add(`target_${outcome.status}`);
    }
  } else if (coverage.targetOutcomes.length > 0) {
    degraded.add("unexpected_target_outcome");
  }

  if (coverage.dispatch.excludedItemCount > 0 ||
    coverage.dispatch.shortenedItemCount > 0 ||
    coverage.dispatch.unavailableItemCount > 0 ||
    coverage.dispatch.includedItemCount !== coverage.dispatch.expectedItemCount ||
    coverage.dispatch.includedItemsHash !== coverage.dispatch.expectedItemsHash) {
    degraded.add("dispatch_evidence_incomplete");
  }

  const totalPassageCount = execution.sourceSet.reduce((sum, source) =>
    sum + source.passageCount, 0);
  if ((execution.strategy === "full_context" || execution.strategy === "exhaustive") &&
    coverage.dispatch.includedItemCount !== totalPassageCount) {
    degraded.add(`${execution.strategy}_dispatch_incomplete`);
  }
  if (execution.strategy === "corpus_summary" &&
    coverage.dispatch.includedItemCount !== execution.sourceSet.length) {
    degraded.add("corpus_summary_dispatch_incomplete");
  }
  if (execution.strategy === "comparison") {
    const coveredTargets = coverage.targetOutcomes.filter(({ status: outcomeStatus }) =>
      outcomeStatus === "covered").length;
    if (coverage.dispatch.includedItemCount < coveredTargets) {
      degraded.add("comparison_target_dispatch_incomplete");
    }
  }
  if (execution.strategy === "multi_hop") {
    const settledHops = coverage.steps.filter(({ kind, stepId }) =>
      (kind === "multi_hop_root" || kind === "multi_hop_follow_up") &&
      receiptsById.get(stepId)?.status === "succeeded").length;
    if (coverage.dispatch.includedItemCount < settledHops) {
      degraded.add("multi_hop_dispatch_incomplete");
    }
  }

  const reasonCodes = [...new Set([...degraded, ...partial])].sort(compareStrings);
  const status: KnowledgeStrategyCoverageStatus = degraded.size > 0
    ? "degraded"
    : partial.size > 0 ? "partial" : "verified";
  const requiredSteps = coverage.steps.filter(({ required }) => required);
  const cleanSourceOutcomes = coverage.sourceOutcomes.filter(({ status: outcomeStatus }) =>
    outcomeStatus === "covered" || outcomeStatus === "not_found");
  const multiHopProcessed = execution.strategy === "multi_hop"
    ? multiHopProcessedItems(coverage.steps, coverage.stepReceipts)
    : null;
  const body: KnowledgeStrategyCoverageReceiptBodyV1 = {
    dispatchExpectedItemCount: coverage.dispatch.expectedItemCount,
    dispatchIncludedItemCount: coverage.dispatch.includedItemCount,
    dispatchManifestHash: coverage.dispatch.manifestHash,
    executionHash,
    executionId: execution.executionId,
    expectedItemsHash: coverage.dispatch.expectedItemsHash,
    includedItemsHash: coverage.dispatch.includedItemsHash,
    observedSourceSetHash: coverage.observedSourceSetHash,
    processedItemsHash: multiHopProcessed?.hash ??
      aggregateProcessedItemsHash(coverage.sourceOutcomes),
    processedPassageCount: multiHopProcessed?.count ??
      coverage.sourceOutcomes.reduce((sum, outcome) =>
        sum + outcome.processedPassageCount, 0),
    processedSourceCount: cleanSourceOutcomes.length,
    reasonCodes,
    requiredStepCount: requiredSteps.length,
    settledTargetCount: coverage.targetOutcomes.length,
    status,
    strategy: execution.strategy,
    sourceSetHash: execution.sourceSetHash,
    terminalRequiredStepCount: requiredSteps.filter(({ stepId }) =>
      receiptsById.has(stepId)).length,
    totalPassageCount,
    totalSourceCount: execution.sourceSet.length,
    totalTargetCount: execution.config.kind === "comparison"
      ? execution.config.targets.length
      : 0,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  };
  return sealKnowledgeStrategyCoverageReceiptV1(body);
}

export type KnowledgeUniversalClaimKind = "negative_none" | "positive_all";
export type KnowledgeUniversalClaimLanguage = "en" | "ru";

export type KnowledgeUniversalClaimMatchV1 = Readonly<{
  index: number;
  kind: KnowledgeUniversalClaimKind;
  language: KnowledgeUniversalClaimLanguage;
  length: number;
}>;

export type KnowledgeUniversalClaimGateV1 = Readonly<{
  allowed: boolean;
  claims: readonly KnowledgeUniversalClaimMatchV1[];
  reasonCodes: readonly string[];
}>;

const MAX_CLAIM_TEXT_CHARACTERS = 200_000;
const universalClaimPatterns: readonly Readonly<{
  kind: KnowledgeUniversalClaimKind;
  language: KnowledgeUniversalClaimLanguage;
  pattern: RegExp;
}>[] = Object.freeze([
  {
    kind: "negative_none",
    language: "en",
    pattern: /\b(?:none|no)\s+(?:of\s+the\s+)?(?:selected\s+)?(?:documents?|sources?|files?|passages?|records?|reports?)\b/giu
  },
  {
    kind: "negative_none",
    language: "en",
    pattern: /\b(?:not\s+(?:found|present|mentioned)|does\s+not\s+appear)\s+in\s+any\s+(?:document|source|file|passage|record|report)s?\b/giu
  },
  {
    kind: "positive_all",
    language: "en",
    pattern: /\b(?:all|every|each)\s+(?:of\s+the\s+)?(?:selected\s+)?(?:documents?|sources?|files?|passages?|records?|reports?)\b/giu
  },
  {
    kind: "positive_all",
    language: "en",
    pattern: /\b(?:across|in)\s+all\s+(?:selected\s+)?(?:documents?|sources?|files?|passages?|records?|reports?)\b/giu
  },
  {
    kind: "positive_all",
    language: "en",
    pattern: /\b(?:across|throughout|in)\s+(?:the\s+)?(?:entire|whole)\s+(?:selected\s+)?corpus\b/giu
  },
  {
    kind: "positive_all",
    language: "en",
    pattern: /\b(?:the\s+)?(?:entire|whole)\s+(?:selected\s+)?corpus\b/giu
  },
  {
    kind: "positive_all",
    language: "en",
    pattern: /\bwithout\s+(?:any\s+)?exceptions?\b/giu
  },
  {
    kind: "negative_none",
    language: "en",
    pattern: /\bnothing(?:\s+(?:was\s+)?(?:found|appears|is\s+mentioned))?\s+(?:anywhere\s+)?(?:across|in)\s+(?:the\s+)?(?:selected\s+)?corpus\b/giu
  },
  {
    kind: "negative_none",
    language: "ru",
    pattern: /(?<!\p{L})(?:ни\s+в\s+одном|ни\s+один|ни\s+одна|ни\s+одно)\s+(?:выбранн\p{L}*\s+)?(?:документ\p{L}*|источник\p{L}*|файл\p{L}*|фрагмент\p{L}*|отч[её]т\p{L}*)(?!\p{L})/giu
  },
  {
    kind: "negative_none",
    language: "ru",
    pattern: /(?<!\p{L})нигде\s+в\s+(?:выбранн\p{L}*\s+)?(?:документ\p{L}*|источник\p{L}*|файл\p{L}*|отч[её]т\p{L}*)(?!\p{L})/giu
  },
  {
    kind: "negative_none",
    language: "ru",
    pattern: /(?<!\p{L})ни\s+один\s+из\s+выбранн\p{L}*\s+(?:документ\p{L}*|источник\p{L}*|файл\p{L}*|отч[её]т\p{L}*)(?!\p{L})/giu
  },
  {
    kind: "positive_all",
    language: "ru",
    pattern: /(?<!\p{L})(?:все|всех|каждый|каждом|каждой)\s+(?:выбранн\p{L}*\s+)?(?:документ\p{L}*|источник\p{L}*|файл\p{L}*|фрагмент\p{L}*|отч[её]т\p{L}*)(?!\p{L})/giu
  },
  {
    kind: "positive_all",
    language: "ru",
    pattern: /(?<!\p{L})во\s+всех\s+(?:выбранн\p{L}*\s+)?(?:документ\p{L}*|источник\p{L}*|файл\p{L}*|отч[её]т\p{L}*)(?!\p{L})/giu
  },
  {
    kind: "positive_all",
    language: "ru",
    pattern: /(?<!\p{L})(?:весь\s+корпус|во\s+вс[её]м\s+корпусе|по\s+всему\s+корпусу|без\s+исключений)(?!\p{L})/giu
  }
]);

export function detectKnowledgeUniversalClaimsV1(
  text: string
): readonly KnowledgeUniversalClaimMatchV1[] {
  if (typeof text !== "string" || text.length > MAX_CLAIM_TEXT_CHARACTERS) {
    throwInvalid("knowledge_universal_claim_text_invalid");
  }
  const matches: KnowledgeUniversalClaimMatchV1[] = [];
  for (const entry of universalClaimPatterns) {
    for (const match of text.matchAll(entry.pattern)) {
      if (match.index === undefined || !match[0]) continue;
      matches.push(Object.freeze({
        index: match.index,
        kind: entry.kind,
        language: entry.language,
        length: match[0].length
      }));
    }
  }
  matches.sort((left, right) => left.index - right.index ||
    right.length - left.length || compareStrings(left.kind, right.kind));
  const deduplicated: KnowledgeUniversalClaimMatchV1[] = [];
  for (const match of matches) {
    const overlapping = deduplicated.some((accepted) =>
      accepted.kind === match.kind && accepted.language === match.language &&
      match.index < accepted.index + accepted.length &&
      accepted.index < match.index + match.length);
    if (!overlapping) deduplicated.push(match);
  }
  return Object.freeze(deduplicated);
}

export function containsKnowledgeNegativeUniversalClaimV1(text: string): boolean {
  return detectKnowledgeUniversalClaimsV1(text).some(({ kind }) => kind === "negative_none");
}

export function gateKnowledgeUniversalClaimsV1(
  text: string,
  coverageValue: unknown,
  expectedDispatchManifestHash?: string
): KnowledgeUniversalClaimGateV1 {
  const claims = detectKnowledgeUniversalClaimsV1(text);
  if (claims.length === 0) {
    return deepFreeze({ allowed: true, claims, reasonCodes: [] });
  }
  const coverage = decodeKnowledgeStrategyCoverageReceiptV1(coverageValue);
  if (!coverage) {
    return deepFreeze({
      allowed: false,
      claims,
      reasonCodes: ["coverage_receipt_invalid"]
    });
  }
  const reasons = new Set<string>();
  if (expectedDispatchManifestHash === undefined) {
    reasons.add("dispatch_manifest_missing");
  } else if (!hash(expectedDispatchManifestHash) ||
      coverage.dispatchManifestHash !== expectedDispatchManifestHash) {
    reasons.add("dispatch_manifest_mismatch");
  }
  if (coverage.status !== "verified") reasons.add("coverage_not_verified");
  if (coverage.sourceSetHash !== coverage.observedSourceSetHash) {
    reasons.add("source_set_not_exact");
  }
  if (coverage.requiredStepCount !== coverage.terminalRequiredStepCount) {
    reasons.add("required_steps_incomplete");
  }
  if (coverage.dispatchExpectedItemCount !== coverage.dispatchIncludedItemCount ||
    coverage.expectedItemsHash !== coverage.includedItemsHash) {
    reasons.add("dispatch_not_exact");
  }
  const positiveAllowed = coverage.strategy === "full_context" ||
    coverage.strategy === "exhaustive" || coverage.strategy === "corpus_summary";
  if (claims.some(({ kind }) => kind === "positive_all") && !positiveAllowed) {
    reasons.add("positive_universal_strategy_invalid");
  }
  const negativeAllowed = coverage.strategy === "full_context" ||
    coverage.strategy === "exhaustive";
  if (claims.some(({ kind }) => kind === "negative_none") && !negativeAllowed) {
    reasons.add("negative_universal_strategy_invalid");
  }
  if (coverage.processedSourceCount !== coverage.totalSourceCount ||
    coverage.processedPassageCount !== coverage.totalPassageCount) {
    reasons.add("corpus_not_exhausted");
  }
  return deepFreeze({
    allowed: reasons.size === 0,
    claims,
    reasonCodes: [...reasons].sort(compareStrings)
  });
}
