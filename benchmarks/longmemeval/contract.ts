import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type { MemoryRebuildStatus } from "../../lib/contracts/memory";

export const LONGMEMEVAL_REPOSITORY_COMMIT =
  "9e0b455f4ef0e2ab8f2e582289761153549043fc";
export const LONGMEMEVAL_S_SHA256 =
  "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
export const LONGMEMEVAL_ORACLE_SHA256 =
  "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c";
export const LONGMEMEVAL_EVALUATOR_SHA256 =
  "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251";
export const LONGMEMEVAL_SAMPLE_SEED = "aiqsa-longmemeval-20260826";
export const LONGMEMEVAL_MAX_CONCURRENCY = 32;
export const LONGMEMEVAL_MAX_CASE_CONCURRENCY = 32;
export const LONGMEMEVAL_MAX_SESSION_CONCURRENCY = 16;
export const LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY = 32;
export const LONGMEMEVAL_PROFILES = ["official", "product"] as const;
export const LONGMEMEVAL_SYSTEM_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna"
] as const;
export const LONGMEMEVAL_QUESTION_TYPES = [
  "knowledge-update",
  "multi-session",
  "single-session-assistant",
  "single-session-preference",
  "single-session-user",
  "temporal-reasoning"
] as const;

export type LongMemEvalProfile = (typeof LONGMEMEVAL_PROFILES)[number];
export type LongMemEvalSystemModelId =
  (typeof LONGMEMEVAL_SYSTEM_MODEL_IDS)[number];

export function longMemEvalHybridRebuildFailed(
  state: MemoryRebuildStatus["state"] | null
): boolean {
  return state === null || state === "CANCELLED" || state === "FAILED" ||
    state === "STALE";
}

export type LongMemEvalProfileManifest = Readonly<{
  automaticFactLearning: boolean;
  id: LongMemEvalProfile;
  label: "official-history-recall" | "product-full-memory";
  officialComparable: boolean;
  patternSynthesis: boolean;
  version: 2;
}>;

export function decodeLongMemEvalProfile(value: unknown): LongMemEvalProfile {
  if (typeof value === "string" &&
    (LONGMEMEVAL_PROFILES as readonly string[]).includes(value)) {
    return value as LongMemEvalProfile;
  }
  throw new Error("longmemeval_profile_invalid");
}

export function decodeLongMemEvalSystemModelId(
  value: unknown
): LongMemEvalSystemModelId {
  if (typeof value === "string" &&
    (LONGMEMEVAL_SYSTEM_MODEL_IDS as readonly string[]).includes(value)) {
    return value as LongMemEvalSystemModelId;
  }
  throw new Error("longmemeval_system_model_invalid");
}

export function longMemEvalProfileManifest(
  profile: LongMemEvalProfile
): LongMemEvalProfileManifest {
  return profile === "official"
    ? Object.freeze({
        automaticFactLearning: false,
        id: profile,
        label: "official-history-recall" as const,
        officialComparable: true,
        patternSynthesis: false,
        version: 2 as const
      })
    : Object.freeze({
        automaticFactLearning: true,
        id: profile,
        label: "product-full-memory" as const,
        officialComparable: false,
        patternSynthesis: true,
        version: 2 as const
      });
}

export function decodeLongMemEvalProfileManifest(
  value: unknown
): LongMemEvalProfileManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("longmemeval_profile_manifest_invalid");
  }
  const record = value as Record<string, unknown>;
  const profile = decodeLongMemEvalProfile(record.id);
  const expected = longMemEvalProfileManifest(profile);
  if (
    record.automaticFactLearning !== expected.automaticFactLearning ||
    record.label !== expected.label ||
    record.officialComparable !== expected.officialComparable ||
    record.patternSynthesis !== expected.patternSynthesis ||
    record.version !== expected.version
  ) {
    throw new Error("longmemeval_profile_manifest_invalid");
  }
  return expected;
}

export type LongMemEvalLearningEvidence = Readonly<{
  appliedSynthesisExecutions: number;
  assistantEvidence: number;
  automaticFactLearning: boolean;
  automaticFactVersions: number;
  classifiedAutomaticFactVersions: number;
  classifiedPatternVersions: number;
  directUserEvidence: number;
  eligibleSynthesisSources: number;
  expectedSettlements: number;
  extractionJobs: number;
  factVersionRelations: number;
  lastSynthesisAtRecorded: boolean;
  patternVersions: number;
  relationJobs: number;
  retainedSynthesisPayloads: number;
  successfulFactExtractionExecutions: number;
  successfulFactExtractionJobs: number;
  successfulSynthesisExecutions: number;
  successfulSynthesisJobs: number;
  synthesizedFromRelations: number;
  synthesisDue: boolean;
  synthesisEnabled: boolean;
  synthesisJobs: number;
  synthesisScheduleReason: string;
  synthesisThreshold: number;
}>;

export function longMemEvalProductMemoryPipelineComplete(
  evidence: LongMemEvalLearningEvidence
): boolean {
  const counts = Object.values(evidence).filter(
    (value): value is number => typeof value === "number"
  );
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    evidence.synthesisThreshold < 1 ||
    !/^[A-Z_]{2,64}$/u.test(evidence.synthesisScheduleReason)) {
    return false;
  }
  const automaticLearningComplete = evidence.automaticFactLearning &&
    evidence.expectedSettlements > 0 &&
    evidence.extractionJobs === evidence.expectedSettlements &&
    evidence.successfulFactExtractionJobs > 0 &&
    evidence.successfulFactExtractionJobs <= evidence.extractionJobs &&
    evidence.successfulFactExtractionExecutions ===
      evidence.successfulFactExtractionJobs &&
    evidence.automaticFactVersions > 0 &&
    evidence.classifiedAutomaticFactVersions === evidence.automaticFactVersions &&
    evidence.directUserEvidence > 0 && evidence.assistantEvidence === 0 &&
    evidence.classifiedPatternVersions === evidence.patternVersions;
  if (!automaticLearningComplete || !evidence.synthesisEnabled) return false;
  if (evidence.synthesisJobs === 0) {
    return !evidence.synthesisDue &&
      evidence.successfulSynthesisExecutions === 0 &&
      evidence.successfulSynthesisJobs === 0 &&
      evidence.appliedSynthesisExecutions === 0 &&
      evidence.retainedSynthesisPayloads === 0 &&
      !evidence.lastSynthesisAtRecorded && evidence.patternVersions === 0 &&
      evidence.synthesizedFromRelations === 0;
  }
  return evidence.successfulSynthesisJobs === evidence.synthesisJobs &&
    evidence.successfulSynthesisExecutions >= evidence.successfulSynthesisJobs &&
    evidence.appliedSynthesisExecutions === evidence.successfulSynthesisJobs &&
    evidence.retainedSynthesisPayloads === 0 && evidence.lastSynthesisAtRecorded &&
    (evidence.patternVersions === 0 ||
      evidence.synthesizedFromRelations >= evidence.patternVersions * 3);
}

export const LONGMEMEVAL_MEMORY_SOTA_BASELINE_CONFIGURATION = Object.freeze({
  aggregationContextHardCapTokens: 10_000,
  aggregationContextTargetTokens: 10_000,
  aggregationHistoryCandidatesToReranker: 60,
  aggregationPreFusionCandidates: 200,
  aggregationRankedCandidates: 120,
  automaticFactLearning: false,
  embeddingBatchSize: 1,
  embeddingDimension: 1_536,
  embeddingModel: "qwen/qwen3-embedding-8b",
  rerankerScoreFloor: 0.6,
  targetedContextHardCapTokens: 5_000,
  targetedContextTargetTokens: 4_000,
  targetedDigestLane: false,
  targetedHistoryCandidatesToReranker: 10,
  targetedHistoryExactLane: 4,
  targetedHistoryFtsSimpleLane: 6,
  targetedHistoryRecentLane: 3,
  targetedHistoryVectorLane: 6,
  targetedPreFusionCandidates: 30,
  targetedRankedCandidates: 30,
  version: "memory-sota-baseline-2026-08-27"
} as const);

export type LongMemEvalQuestionType =
  (typeof LONGMEMEVAL_QUESTION_TYPES)[number];

export type LongMemEvalTurn = Readonly<{
  content: string;
  role: "assistant" | "user";
}>;

export type LongMemEvalImportTurnPlan = Readonly<{
  appendedAssistantSettlement: boolean;
  turns: readonly LongMemEvalTurn[];
}>;

/**
 * A production chat source becomes indexable only after an assistant leaf has
 * settled. External transcripts may validly stop on a user turn, so the
 * adapter closes that transport shape with an empty assistant settlement. No
 * official turn is removed, rewritten, or used to choose this behavior.
 */
export function longMemEvalSettledImportTurns(
  turns: readonly LongMemEvalTurn[]
): LongMemEvalImportTurnPlan {
  if (turns.length === 0) {
    throw new Error("longmemeval_import_session_invalid");
  }
  const appendedAssistantSettlement = turns.at(-1)?.role === "user";
  return Object.freeze({
    appendedAssistantSettlement,
    turns: Object.freeze([
      ...turns,
      ...(appendedAssistantSettlement
        ? [Object.freeze({ content: "", role: "assistant" as const })]
        : [])
    ])
  });
}

export type LongMemEvalCase = Readonly<{
  answer: number | string;
  answerSessionIds: readonly string[];
  haystackDates: readonly string[];
  haystackSessionIds: readonly string[];
  haystackSessions: readonly (readonly LongMemEvalTurn[])[];
  question: string;
  questionDate: string;
  questionId: string;
  questionType: LongMemEvalQuestionType;
}>;

export type LongMemEvalSelection = Readonly<{
  cases: readonly LongMemEvalCase[];
  mode: "explicit" | "seeded_hash";
  seed: string;
}>;

export type LongMemEvalQualificationGate = Readonly<{
  degradedMemoryOutcomes: number;
  executionFailures: number;
  passed: boolean;
  successfulCases: number;
  unhealthyMemoryOutcomes: number;
}>;

/** Oracle correctness and runtime health are independent qualification axes.
 * A correct answer never waives a non-USED Memory execution: DEGRADED,
 * FAILED_SAFE, EMPTY, or DISABLED all mean that the paid recall case did not
 * exercise a healthy Memory path. The reason must be diagnosed and the clean
 * qualification rerun. Purpose-built fallback tests do not use this gate. */
export function longMemEvalQualificationGate(input: Readonly<{
  executionFailures: number;
  memoryOutcomes: readonly string[];
}>): LongMemEvalQualificationGate {
  if (!Number.isSafeInteger(input.executionFailures) ||
    input.executionFailures < 0 ||
    input.memoryOutcomes.some((outcome) => !outcome || outcome.length > 64 ||
      !/^[A-Z][A-Z_]*$/u.test(outcome))) {
    throw new Error("longmemeval_qualification_gate_input_invalid");
  }
  const degradedMemoryOutcomes = input.memoryOutcomes.filter((outcome) =>
    outcome === "DEGRADED").length;
  const unhealthyMemoryOutcomes = input.memoryOutcomes.filter((outcome) =>
    outcome !== "USED").length;
  return Object.freeze({
    degradedMemoryOutcomes,
    executionFailures: input.executionFailures,
    passed: input.memoryOutcomes.length > 0 &&
      input.executionFailures === 0 && unhealthyMemoryOutcomes === 0,
    successfulCases: input.memoryOutcomes.length,
    unhealthyMemoryOutcomes
  });
}

export type LongMemEvalComponentCandidate = Readonly<{
  evidenceHandle: string;
  roundId?: string | null;
  sessionId: string;
}>;

export type LongMemEvalComponentMetrics = Readonly<{
  evidenceMrr: number | null;
  evidenceNdcgAtK: number | null;
  k: number;
  roundRecallAtK: number | null;
  sourceSessionRecallAtK: number | null;
}>;

export type LongMemEvalBaselineManifest = Readonly<{
  configuration: typeof LONGMEMEVAL_MEMORY_SOTA_BASELINE_CONFIGURATION;
  questionCount: number;
  questionIdDigest: string;
  selectionMode: LongMemEvalSelection["mode"];
  seed: string;
  version: 1;
}>;

export type LongMemEvalRetrievalAudit = Readonly<{
  aggregationBoundaryCount: number | null;
  aggregationGroupCounts: Readonly<Record<string, number>>;
  aggregationGuideFormat: string | null;
  aggregationMemberCount: number | null;
  aggregationOperation: string | null;
  aggregationRequested: boolean | null;
  aggregationResolution: string | null;
  aggregationState: string | null;
  budgetProfile: string | null;
  candidateCountsByLane: Readonly<Record<string, number>>;
  candidatesRetainedAfterRejoin: number | null;
  candidatesRetainedAfterReranker: number | null;
  candidatesSentToReranker: number | null;
  componentMetricsVersion: string | null;
  digestHits: number | null;
  embeddingBatchSizeDistribution: Readonly<Record<string, number>>;
  hardCapTokens: number | null;
  itemCount: number | null;
  mode: string | null;
  omissionCounts: Readonly<Record<string, number>>;
  packedTokens: number | null;
  plannerFallbackUsed: boolean | null;
  providerTokenLimit: number | null;
  queryVariantCounts: Readonly<Record<string, number>>;
  rawChunkExpansions: number | null;
  rawRoundExpansions: number | null;
  reason: string | null;
  relevanceAcceptedCount: number | null;
  relevanceCandidateCount: number | null;
  relevanceDecisionCounts: Readonly<Record<string, number>>;
  relevanceRejoinedCount: number | null;
  rerankerFallbackUsed: boolean | null;
  safetyFindingCounts: Readonly<Record<string, number>>;
  safetyMetricsState: string | null;
  selectedSourceChats: number | null;
  targetTokens: number | null;
  temporalFilteredCandidateCount: number | null;
  temporalParserConfidence: number | null;
  temporalParserState: string | null;
  temporalParserType: string | null;
  temporalUnrestrictedCandidateCount: number | null;
  uniqueEvidenceRootsAfterFusion: number | null;
  uniqueEvidenceRootsBeforeFusion: number | null;
  utilityCallCounts: Readonly<Record<string, number>>;
  utilityFailureReasonCounts: Readonly<Record<string, number>>;
}>;

/** Builds a content-free provider-request distribution from the durable
 * document-batch receipts. Query embeddings remain one-input requests. */
export function longMemEvalEmbeddingBatchSizeDistribution(input: Readonly<{
  documentBatches: readonly Readonly<{
    executionBindingId: string;
    itemCount: number;
  }>[];
  successfulExecutions: readonly Readonly<{
    id: string;
    logicalRole: string;
  }>[];
}>): Readonly<Record<string, number>> {
  const documentExecutionIds = new Set(input.successfulExecutions
    .filter(({ logicalRole }) => logicalRole === "MEMORY_DOCUMENT_EMBED")
    .map(({ id }) => id));
  const observedDocumentIds = new Set<string>();
  const sizes: number[] = [];
  for (const batch of input.documentBatches) {
    if (!documentExecutionIds.has(batch.executionBindingId) ||
      observedDocumentIds.has(batch.executionBindingId) ||
      !Number.isSafeInteger(batch.itemCount) || batch.itemCount < 1 ||
      batch.itemCount > 128) {
      throw new Error("longmemeval_embedding_batch_receipt_invalid");
    }
    observedDocumentIds.add(batch.executionBindingId);
    sizes.push(batch.itemCount);
  }
  if (observedDocumentIds.size !== documentExecutionIds.size) {
    throw new Error("longmemeval_embedding_batch_receipt_incomplete");
  }
  sizes.push(...input.successfulExecutions.flatMap(({ logicalRole }) =>
    logicalRole === "MEMORY_QUERY_EMBED" ? [1] : []));
  const distribution: Record<string, number> = {};
  for (const size of sizes.sort((left, right) => left - right)) {
    const key = String(size);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return Object.freeze(distribution);
}

export function longMemEvalExpectedUtilityModelId(input: Readonly<{
  embeddingModelId: string;
  logicalRole: string;
  rerankerModelId: string | null;
  systemModelId: string;
}>): string {
  if (input.logicalRole === "MEMORY_DOCUMENT_EMBED" ||
    input.logicalRole === "MEMORY_QUERY_EMBED") {
    return input.embeddingModelId;
  }
  if (input.logicalRole === "MEMORY_RERANK" && input.rerankerModelId) {
    return input.rerankerModelId;
  }
  return input.systemModelId;
}

/** Runs bounded independent work concurrently while preserving input order.
 * On failure it stops admitting new work, waits for already-started work to
 * settle, and only then rejects so callers can safely clean up shared state. */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
    concurrency > LONGMEMEVAL_MAX_CONCURRENCY) {
    throw new Error("longmemeval_concurrency_invalid");
  }
  if (items.length === 0) return Object.freeze([]);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        results[index] = await operation(items[index]!, index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    worker
  ));
  if (failed) throw firstError;
  return Object.freeze(results);
}

/** Splits official-evaluator inputs round-robin so long and short calls are
 * spread across workers without changing either item content or shard order. */
export function partitionLongMemEvalEvaluation<T>(
  items: readonly T[],
  concurrency: number
): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
    concurrency > LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY) {
    throw new Error("longmemeval_evaluator_concurrency_invalid");
  }
  if (items.length === 0) return Object.freeze([]);
  const shards = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => [] as T[]
  );
  items.forEach((item, index) => shards[index % shards.length]!.push(item));
  return Object.freeze(shards.map((shard) => Object.freeze(shard)));
}

export type LongMemEvalEvaluationValue<T> = Readonly<{
  questionId: string;
  value: T;
}>;

/** Merges independently evaluated shards into the original answer order and
 * fails closed for every missing, duplicate, or unexpected question id. */
export function mergeLongMemEvalEvaluationResults<T>(
  expectedQuestionIds: readonly string[],
  shards: readonly (readonly LongMemEvalEvaluationValue<T>[])[]
): readonly T[] {
  if (new Set(expectedQuestionIds).size !== expectedQuestionIds.length) {
    throw new Error("longmemeval_evaluator_expected_ids_invalid");
  }
  const expected = new Set(expectedQuestionIds);
  const values = new Map<string, T>();
  for (const shard of shards) {
    for (const result of shard) {
      if (!expected.has(result.questionId) || values.has(result.questionId)) {
        throw new Error("longmemeval_evaluator_result_invalid");
      }
      values.set(result.questionId, result.value);
    }
  }
  if (values.size !== expectedQuestionIds.length) {
    throw new Error("longmemeval_evaluator_result_incomplete");
  }
  return Object.freeze(expectedQuestionIds.map((questionId) =>
    values.get(questionId)!));
}

const questionTypeSet = new Set<string>(LONGMEMEVAL_QUESTION_TYPES);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function sanitizedCounts(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => /^[A-Za-z0-9_.:-]{1,64}$/u.test(key) &&
      nonNegativeInteger(count) !== null)
    .slice(0, 64)
    .map(([key, count]) => [key, Number(count)])));
}

function uppercaseCode(value: unknown, maximum = 32): string | null {
  return typeof value === "string" &&
    new RegExp(`^[A-Z_]{1,${maximum}}$`, "u").test(value)
    ? value
    : null;
}

function versionCode(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,95}$/u.test(value) ? value : null;
}

function boundedConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 1 ? value : null;
}

/** Retains only aggregate, text-free retrieval evidence before the disposable
 * benchmark identity (and its private Memory rows) is deleted. */
export function sanitizeLongMemEvalRetrievalAudit(
  value: unknown
): LongMemEvalRetrievalAudit {
  const budget = isRecord(value) ? value : {};
  const plan = isRecord(budget.plan) ? budget.plan : {};
  const component = isRecord(budget.componentMetrics) ? budget.componentMetrics : {};
  const mode = typeof plan.mode === "string" &&
    /^[A-Z_]{1,32}$/u.test(plan.mode) ? plan.mode : null;
  const reason = typeof budget.reason === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(budget.reason) ? budget.reason : null;
  return Object.freeze({
    aggregationBoundaryCount: nonNegativeInteger(budget.aggregationBoundaryCount),
    aggregationGroupCounts: sanitizedCounts(budget.aggregationGroupCounts),
    aggregationGuideFormat: uppercaseCode(budget.aggregationGuideFormat),
    aggregationMemberCount: nonNegativeInteger(budget.aggregationMemberCount),
    aggregationOperation: uppercaseCode(budget.aggregationOperation),
    aggregationRequested: typeof plan.aggregationRequested === "boolean"
      ? plan.aggregationRequested
      : null,
    aggregationResolution: uppercaseCode(budget.aggregationResolution),
    aggregationState: uppercaseCode(budget.aggregationState),
    budgetProfile: uppercaseCode(budget.budgetProfile),
    candidateCountsByLane: sanitizedCounts(component.candidateCountsByLane),
    candidatesRetainedAfterRejoin:
      nonNegativeInteger(component.candidatesRetainedAfterRejoin),
    candidatesRetainedAfterReranker:
      nonNegativeInteger(component.candidatesRetainedAfterReranker),
    candidatesSentToReranker: nonNegativeInteger(component.candidatesSentToReranker),
    componentMetricsVersion: versionCode(component.version),
    digestHits: nonNegativeInteger(component.digestHits),
    embeddingBatchSizeDistribution:
      sanitizedCounts(component.embeddingBatchSizeDistribution),
    hardCapTokens: nonNegativeInteger(budget.hardCapTokens),
    itemCount: nonNegativeInteger(budget.itemCount),
    mode,
    omissionCounts: sanitizedCounts(budget.omissionCounts),
    packedTokens: nonNegativeInteger(budget.packedTokens),
    plannerFallbackUsed: typeof component.plannerFallbackUsed === "boolean"
      ? component.plannerFallbackUsed
      : null,
    providerTokenLimit: nonNegativeInteger(budget.providerTokenLimit),
    queryVariantCounts: sanitizedCounts(component.queryVariantCounts),
    rawChunkExpansions: nonNegativeInteger(component.rawChunkExpansions),
    rawRoundExpansions: nonNegativeInteger(component.rawRoundExpansions),
    reason,
    relevanceAcceptedCount: nonNegativeInteger(budget.relevanceAcceptedCount),
    relevanceCandidateCount: nonNegativeInteger(budget.relevanceCandidateCount),
    relevanceDecisionCounts: sanitizedCounts(budget.relevanceDecisionCounts),
    relevanceRejoinedCount: nonNegativeInteger(budget.relevanceRejoinedCount),
    rerankerFallbackUsed: typeof component.rerankerFallbackUsed === "boolean"
      ? component.rerankerFallbackUsed
      : null,
    safetyFindingCounts: sanitizedCounts(component.safetyFindingCounts),
    safetyMetricsState: uppercaseCode(component.safetyMetricsState),
    selectedSourceChats: nonNegativeInteger(component.selectedSourceChats),
    targetTokens: nonNegativeInteger(budget.targetTokens),
    temporalFilteredCandidateCount:
      nonNegativeInteger(component.temporalFilteredCandidateCount),
    temporalParserConfidence: boundedConfidence(component.temporalParserConfidence),
    temporalParserState: uppercaseCode(component.temporalParserState),
    temporalParserType: uppercaseCode(component.temporalParserType),
    temporalUnrestrictedCandidateCount:
      nonNegativeInteger(component.temporalUnrestrictedCandidateCount),
    uniqueEvidenceRootsAfterFusion:
      nonNegativeInteger(component.uniqueEvidenceRootsAfterFusion),
    uniqueEvidenceRootsBeforeFusion:
      nonNegativeInteger(component.uniqueEvidenceRootsBeforeFusion),
    utilityCallCounts: sanitizedCounts(component.utilityCallCounts),
    utilityFailureReasonCounts: sanitizedCounts(component.utilityFailureReasonCounts)
  });
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(code);
  }
  return value;
}

function benchmarkTurnContent(value: unknown, code: string): string {
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw new Error(code);
  }
  return value;
}

function stringArray(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(code);
  return Object.freeze(value.map((entry) => requiredString(entry, code)));
}

function decodeTurns(value: unknown, caseIndex: number): readonly LongMemEvalTurn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`longmemeval_session_invalid:${caseIndex}`);
  }
  return Object.freeze(value.map((candidate) => {
    if (!isRecord(candidate) ||
      (candidate.role !== "assistant" && candidate.role !== "user")) {
      throw new Error(`longmemeval_turn_invalid:${caseIndex}`);
    }
    return Object.freeze({
      content: benchmarkTurnContent(
        candidate.content,
        `longmemeval_turn_content_invalid:${caseIndex}`
      ),
      role: candidate.role
    });
  }));
}

function decodeCase(value: unknown, index: number): LongMemEvalCase {
  if (!isRecord(value)) throw new Error(`longmemeval_case_invalid:${index}`);
  const questionType = requiredString(
    value.question_type,
    `longmemeval_question_type_invalid:${index}`
  );
  if (!questionTypeSet.has(questionType)) {
    throw new Error(`longmemeval_question_type_invalid:${index}`);
  }
  if (typeof value.answer !== "string" && typeof value.answer !== "number") {
    throw new Error(`longmemeval_answer_invalid:${index}`);
  }
  if (!Array.isArray(value.haystack_sessions)) {
    throw new Error(`longmemeval_sessions_invalid:${index}`);
  }
  const haystackSessions = Object.freeze(
    value.haystack_sessions.map((session) => decodeTurns(session, index))
  );
  const haystackDates = stringArray(
    value.haystack_dates,
    `longmemeval_dates_invalid:${index}`
  );
  const haystackSessionIds = stringArray(
    value.haystack_session_ids,
    `longmemeval_session_ids_invalid:${index}`
  );
  if (haystackSessions.length !== haystackDates.length ||
    haystackSessions.length !== haystackSessionIds.length) {
    throw new Error(`longmemeval_session_alignment_invalid:${index}`);
  }
  for (const date of haystackDates) parseLongMemEvalDate(date);
  const questionDate = requiredString(
    value.question_date,
    `longmemeval_question_date_invalid:${index}`
  );
  parseLongMemEvalDate(questionDate);
  return Object.freeze({
    answer: value.answer,
    answerSessionIds: stringArray(
      value.answer_session_ids,
      `longmemeval_answer_session_ids_invalid:${index}`
    ),
    haystackDates,
    haystackSessionIds,
    haystackSessions,
    question: requiredString(value.question, `longmemeval_question_invalid:${index}`),
    questionDate,
    questionId: requiredString(
      value.question_id,
      `longmemeval_question_id_invalid:${index}`
    ),
    questionType: questionType as LongMemEvalQuestionType
  });
}

export function decodeLongMemEvalDataset(value: unknown): readonly LongMemEvalCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("longmemeval_dataset_invalid");
  }
  const cases = Object.freeze(value.map(decodeCase));
  if (new Set(cases.map((entry) => entry.questionId)).size !== cases.length) {
    throw new Error("longmemeval_question_ids_duplicate");
  }
  return cases;
}

export function parseLongMemEvalDate(value: string): Date {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(([A-Z][a-z]{2})\) (\d{2}):(\d{2})$/u
    .exec(value);
  if (!match) throw new Error("longmemeval_date_invalid");
  const [, yearText, monthText, dayText, weekday, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || hour > 23 || minute > 59 ||
    weekdays[date.getUTCDay()] !== weekday) {
    throw new Error("longmemeval_date_invalid");
  }
  return date;
}

export function longMemEvalQuestionPrompt(entry: Pick<
  LongMemEvalCase,
  "question" | "questionDate"
>): string {
  return [
    "Please answer the question based on the relevant chat history.",
    "",
    `Current Date: ${entry.questionDate}`,
    `Question: ${entry.question}`,
    "Answer:"
  ].join("\n");
}

function selectionHash(seed: string, questionId: string): string {
  return createHash("sha256")
    .update(seed, "utf8")
    .update("\u0000", "utf8")
    .update(questionId, "utf8")
    .digest("hex");
}

export function selectLongMemEvalCases(
  cases: readonly LongMemEvalCase[],
  input: Readonly<{
    questionIds?: readonly string[];
    sampleSize?: number;
    seed?: string;
  }>
): LongMemEvalSelection {
  const seed = input.seed?.trim() || LONGMEMEVAL_SAMPLE_SEED;
  const questionIds = input.questionIds?.map((value) => value.trim()) ?? [];
  if (questionIds.length > 0) {
    if (questionIds.some((value) => !value) ||
      new Set(questionIds).size !== questionIds.length) {
      throw new Error("longmemeval_question_selection_invalid");
    }
    const byId = new Map(cases.map((entry) => [entry.questionId, entry]));
    const selected = questionIds.map((id) => byId.get(id));
    if (selected.some((entry) => !entry)) {
      throw new Error("longmemeval_question_selection_missing");
    }
    return Object.freeze({
      cases: Object.freeze(selected as LongMemEvalCase[]),
      mode: "explicit",
      seed
    });
  }
  const sampleSize = input.sampleSize ?? 1;
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > cases.length) {
    throw new Error("longmemeval_sample_size_invalid");
  }
  const selected = [...cases]
    .sort((left, right) => {
      const byHash = selectionHash(seed, left.questionId)
        .localeCompare(selectionHash(seed, right.questionId));
      return byHash || left.questionId.localeCompare(right.questionId);
    })
    .slice(0, sampleSize);
  return Object.freeze({
    cases: Object.freeze(selected),
    mode: "seeded_hash",
    seed
  });
}

export function buildLongMemEvalBaselineManifest(
  selection: LongMemEvalSelection
): LongMemEvalBaselineManifest {
  const questionIdDigest = createHash("sha256")
    .update(selection.seed, "utf8")
    .update("\u0000", "utf8")
    .update(selection.cases.map(({ questionId }) => questionId).join("\u0000"), "utf8")
    .digest("hex");
  return Object.freeze({
    configuration: LONGMEMEVAL_MEMORY_SOTA_BASELINE_CONFIGURATION,
    questionCount: selection.cases.length,
    questionIdDigest,
    selectionMode: selection.mode,
    seed: selection.seed,
    version: 1
  });
}

function validatedMetricK(k: number, candidateCount: number): number {
  if (!Number.isSafeInteger(k) || k < 1 || k > 10_000 || candidateCount > 100_000) {
    throw new Error("longmemeval_component_metric_input_invalid");
  }
  return Math.min(k, candidateCount);
}

function uniqueNonEmpty(values: readonly string[]): ReadonlySet<string> {
  if (values.some((value) => typeof value !== "string" || !value ||
    value.includes("\u0000"))) {
    throw new Error("longmemeval_component_metric_input_invalid");
  }
  return new Set(values);
}

/** Benchmark-only component metrics. Gold session/round localization never
 * enters a runtime Memory request or candidate interface. */
export function evaluateLongMemEvalComponentMetrics(input: Readonly<{
  answerRoundIds?: readonly string[];
  answerSessionIds: readonly string[];
  candidates: readonly LongMemEvalComponentCandidate[];
  k: number;
}>): LongMemEvalComponentMetrics {
  const k = validatedMetricK(input.k, input.candidates.length);
  const sessionGold = uniqueNonEmpty(input.answerSessionIds);
  const roundGold = input.answerRoundIds === undefined
    ? null
    : uniqueNonEmpty(input.answerRoundIds);
  const seenHandles = new Set<string>();
  const candidates = input.candidates.map((candidate) => {
    if (!candidate.evidenceHandle || candidate.evidenceHandle.includes("\u0000") ||
      !candidate.sessionId || candidate.sessionId.includes("\u0000") ||
      seenHandles.has(candidate.evidenceHandle) ||
      (candidate.roundId !== undefined && candidate.roundId !== null &&
        (!candidate.roundId || candidate.roundId.includes("\u0000")))) {
      throw new Error("longmemeval_component_metric_input_invalid");
    }
    seenHandles.add(candidate.evidenceHandle);
    return candidate;
  });
  const topCandidates = candidates.slice(0, k);
  const foundSessions = new Set(topCandidates.flatMap((candidate) =>
    sessionGold.has(candidate.sessionId) ? [candidate.sessionId] : []));
  const foundRounds = roundGold === null ? null : new Set(topCandidates.flatMap((candidate) =>
    candidate.roundId && roundGold.has(candidate.roundId) ? [candidate.roundId] : []));
  const candidateRelevant = (candidate: LongMemEvalComponentCandidate) =>
    roundGold && roundGold.size > 0
      ? Boolean(candidate.roundId && roundGold.has(candidate.roundId))
      : sessionGold.has(candidate.sessionId);
  const relevance = candidates.map(candidateRelevant);
  const firstRelevant = relevance.findIndex(Boolean);
  const dcg = topCandidates.map(candidateRelevant).reduce((sum, relevant, index) =>
    relevant ? sum + 1 / Math.log2(index + 2) : sum, 0);
  const relevantRootCount = roundGold && roundGold.size > 0
    ? roundGold.size : sessionGold.size;
  const idealCount = Math.min(k, relevance.filter(Boolean).length);
  let idealDcg = 0;
  for (let index = 0; index < idealCount; index += 1) {
    idealDcg += 1 / Math.log2(index + 2);
  }
  return Object.freeze({
    evidenceMrr: relevantRootCount === 0 ? null
      : firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    evidenceNdcgAtK: relevantRootCount === 0 ? null
      : idealDcg === 0 ? 0 : dcg / idealDcg,
    k: input.k,
    roundRecallAtK: roundGold === null || roundGold.size === 0
      ? null
      : (foundRounds?.size ?? 0) / roundGold.size,
    sourceSessionRecallAtK: sessionGold.size === 0
      ? null
      : foundSessions.size / sessionGold.size
  });
}

export function longMemEvalReaderOracleGap(
  retrievedContextScore: number,
  oracleContextScore: number
): number {
  if (![retrievedContextScore, oracleContextScore].every((value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("longmemeval_reader_oracle_score_invalid");
  }
  return oracleContextScore - retrievedContextScore;
}

export function assertBenchmarkBaseUrl(value: string, expectedPort: number): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("longmemeval_base_url_invalid");
  }
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname) ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.port !== String(expectedPort) ||
    expectedPort === 3000) {
    throw new Error("longmemeval_base_url_not_isolated");
  }
  return parsed;
}

export function assertBenchmarkDatabaseUrl(value: string, expectedPort: number): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("longmemeval_database_url_invalid");
  }
  const queryKeys = [...parsed.searchParams.keys()];
  if (parsed.protocol !== "postgresql:" || !loopbackHosts.has(parsed.hostname) ||
    parsed.username !== "aiqsa_benchmark" ||
    parsed.password !== "aiqsa-memory-benchmark-dev-password" ||
    parsed.pathname !== "/aiqsa_memory_benchmark" ||
    parsed.port !== String(expectedPort) || expectedPort === 5432 ||
    queryKeys.length !== 1 || queryKeys[0] !== "schema" ||
    parsed.searchParams.get("schema") !== "public" || parsed.hash) {
    throw new Error("longmemeval_database_url_not_isolated");
  }
  return parsed;
}

export function resolveBenchmarkOutputDirectory(
  benchmarkRoot: string,
  candidate: string
): string {
  const resultsRoot = resolve(benchmarkRoot, "results");
  const output = resolve(benchmarkRoot, candidate);
  if (output === resultsRoot || !output.startsWith(`${resultsRoot}${sep}`)) {
    throw new Error("longmemeval_output_directory_not_isolated");
  }
  return output;
}
