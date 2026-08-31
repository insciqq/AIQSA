import {
  Prisma,
  type MemorySearchItemType,
  type PrismaClient
} from "@prisma/client";
import {
  allocateMemoryRetrievalLaneLimits,
  executeMemoryRetrievalLaneTasks,
  fuseMemoryRetrievalCandidates,
  MEMORY_CONTEXT_AGGREGATION_MAX_SOURCE_CHATS,
  MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS,
  MEMORY_CORE_MAX_FACTS,
  MEMORY_RETRIEVAL_BASELINE_FACT_EVIDENCE_ROOTS,
  MEMORY_RETRIEVAL_BASELINE_HISTORY_EVIDENCE_ROOTS,
  MEMORY_RETRIEVAL_COMPLEX_DIGEST_CHATS,
  MEMORY_RETRIEVAL_COMPLEX_RAW_ANCHORS_PER_CHAT,
  MEMORY_RETRIEVAL_EXECUTION_LANE_ORDER,
  MEMORY_RETRIEVAL_FUSION_VERSION,
  MEMORY_RETRIEVAL_LANE_WEIGHTS,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_SOURCE_CHATS,
  MEMORY_LEXICAL_QUERY_MAX_TERMS,
  MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
  MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_RRF_K,
  MEMORY_RETRIEVAL_MAX_SEMANTIC_QUERY_VARIANTS,
  MEMORY_RETRIEVAL_TARGETED_DIGEST_CHATS,
  MEMORY_RETRIEVAL_TARGETED_RAW_ANCHORS_PER_CHAT,
  MEMORY_RETRIEVAL_TARGETED_SESSION_EXPANSION_SOURCE_CHATS,
  MEMORY_RETRIEVAL_MAX_TEMPORAL_QUERY_VARIANTS,
  MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS,
  MEMORY_TEMPORAL_QUERY_EXPRESSION_TYPES,
  MEMORY_TEMPORAL_QUERY_PARSER_VERSION,
  MEMORY_NGRAM_QUERY_MAX_TERMS,
  analyzeMemoryLexicalQuery,
  memoryRetrievalEvidenceRootKey,
  memoryRetrievalLaneLimit,
  type MemoryCandidateMetadata,
  type MemoryCoreCandidate,
  type MemoryDeterministicMatch,
  type MemoryExpandedCandidate,
  type MemoryLaneCandidate,
  type MemoryLaneResult,
  type MemoryRankedCandidate,
  type MemoryRetrievalLane,
  type MemoryRetrievalLaneLimitAllocation,
  type MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import {
  boundedMemoryRecallRoundEvidenceText,
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../history/rounds";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from
  "../history/segments";
import { MEMORY_TOOL_EVENT_PROJECTION_VERSION } from "../history/toolEvents";
import { memoryUserTestimonyText } from "../history/userTestimony";
import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets
} from "../explicit/safety";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256
} from "../persistence/lexical";
import { normalizeMemoryEntityAlias } from "../learning/entities/normalization";
import { memoryAdmissibleEntityAliasPredicate } from
  "../learning/entities/authority";
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";
import { memoryCanonicalFactRootIdSql } from "../persistence/canonicalFact";
import {
  memoryPersonalEvidenceRowPredicate,
  memoryPersonalFactEvidencePredicate
} from "../persistence/eligibility";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import {
  memoryHistoryChunkSourceAuthorityPredicate,
  memoryHistoryRoundSourceAuthorityPredicate
} from "../persistence/pauseIntervals";
import {
  createPrismaMemoryVectorRepository,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
  type MemoryVectorLaneEvidence,
  type MemoryVectorProfile
} from "./vector";
import {
  MEMORY_READ_BUDGET_MS,
  MemoryReadBudgetError,
  withMemoryReadBudget
} from "./readBudget";
import {
  MEMORY_LEXICAL_PROVIDER_MAX_CANDIDATES_PER_VARIANT,
  MEMORY_LEXICAL_PROVIDER_MAX_FINAL_CANDIDATES,
  assertMemoryLexicalSearchResult,
  hasAcceptedCompleteMemoryLexicalVariant,
  memoryLexicalProjectionReadinessScope,
  type MemoryLexicalCandidateProvider,
  type MemoryLexicalLaneEvidence,
  type MemoryLexicalProviderBackend,
  type MemoryLexicalProviderEvidence,
  type MemoryLexicalRawCandidate,
  type MemoryLexicalSearchRequest,
  type MemoryLexicalSearchResult
} from "./lexical/contract";
import {
  isPostgresUnicodeMemoryLexicalLane,
  type PostgresUnicodeMemoryLexicalLane
} from "./lexical/postgresUnicodeProvider";
import {
  defaultMemoryLexicalCutoverRuntime,
  supportsMemoryLexicalCanonicalGuardFallback
} from "./lexical/cutover";
import {
  defaultMemoryLexicalShadowRuntime,
  isShadowedMemoryLexicalLane,
  memoryLexicalShadowLaneReceipt,
  type MemoryLexicalShadowLaneReceipt,
  type MemoryLexicalShadowRuntime,
  type MemoryLexicalShadowStage
} from "./lexical/shadow";

export type { MemoryLexicalLaneEvidence } from "./lexical/contract";

export const MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION =
  "memory-local-retrieval-repository-v46";
export const MEMORY_SPECULATIVE_BASELINE_SETTLE_MS = 1_200;
const MEMORY_NGRAM_FALLBACK_MAX_TERMS = 8;
const MEMORY_NGRAM_FALLBACK_MAX_TERMS_PER_VARIANT = 4;
const MEMORY_LEXICAL_AUTHORITY_PREFILTER_MAX_PER_VARIANT = 500;
const MEMORY_EXACT_AUTHORITY_PREFILTER_MAX_CANDIDATES = 500;
const MEMORY_LEXICAL_NGRAM_AUTHORITY_OVERFETCH_MULTIPLIER = 8;

const denseOnlyRetrieval = Symbol("memory-dense-only-retrieval");
type MemoryLocalRetrievalInternalInput = MemoryLocalRetrievalInput & Readonly<{
  [denseOnlyRetrieval]?: true;
}>;

type MemorySearchEntryRelation =
  | "BOUNDED_CANDIDATES"
  | "PERSISTED";

function memorySearchEntryRelationSql(
  relation: MemorySearchEntryRelation
): Prisma.Sql {
  return relation === "BOUNDED_CANDIDATES"
    ? Prisma.sql`candidate_entries AS entry`
    : Prisma.sql`"MemorySearchEntry" AS entry`;
}

function memorySearchEntryNormalizedTextSql(
  relation: MemorySearchEntryRelation
): Prisma.Sql {
  return relation !== "PERSISTED"
    ? Prisma.sql`NULL::text`
    : Prisma.sql`entry."normalizedSearchText"`;
}

function memorySearchEntrySimpleVectorSql(
  relation: MemorySearchEntryRelation
): Prisma.Sql {
  return relation !== "PERSISTED"
    ? Prisma.sql`NULL::tsvector`
    : Prisma.sql`entry."searchVectorSimple"`;
}

function boundedMemorySearchEntryColumnsSql(): Prisma.Sql {
  return Prisma.sql`entry."id", entry."userId", entry."indexGenerationId",
    entry."itemType", entry."factVersionId", entry."recallChunkId",
    entry."recallRoundId", entry."recallRoundSegmentId", entry."toolEventId",
    entry."safeContentHash"`;
}

export type MemoryLocalRetrievalStatus = "DISABLED" | "READY" | "UNAVAILABLE";

export type MemoryLocalRetrievalSnapshot = Readonly<{
  activeGenerationId: string | null;
  assistantId: string | null;
  chatId: string;
  chatMemoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  decayEnabled: boolean;
  decayPolicyVersion: string | null;
  folderId: string | null;
  historyAuthorityRevision: number | null;
  indexMode: "HYBRID" | "LEXICAL_ONLY" | null;
  contextualKeyPolicyVersion?: string | null;
  memoryGeneration: number;
  memoryRevision: number;
  reason: string;
  referenceChatHistory: boolean;
  repositoryVersion: string;
  roundProjectionVersion?: string | null;
  roundSegmentProjectionVersion?: string | null;
  settingsRevision: number;
  status: MemoryLocalRetrievalStatus;
  useMemoryFacts: boolean;
  userId: string;
}>;

const memoryLexicalReadinessScopes = new WeakMap<
  MemoryLocalRetrievalSnapshot,
  object
>();

export type MemoryLocalVectorQuery = Readonly<{
  minimumScore: number;
  profile: MemoryVectorProfile;
  vector: readonly number[];
}>;

export type MemoryLocalRetrievalInput = Readonly<{
  assistantId: string | null;
  /** Original-query ordinary-read floor. Null/omitted for typed bounded modes. */
  baselinePlan?: MemoryRetrievalPlan;
  chatId: string;
  now: Date;
  plan: MemoryRetrievalPlan;
  settleSignal?: AbortSignal;
  /** Stable capability issued by this repository for the current admission. */
  sourceSnapshot?: MemoryLocalRetrievalSnapshot;
  userId: string;
  vector?: MemoryLocalVectorQuery;
}>;

export type MemorySourceFamilyRetrievalEvidence = Readonly<{
  baselineFactCandidateCount: number;
  baselineHistoryCandidateCount: number;
  baselineOnlyCandidateCount: number;
  plannerExcludedFamilyRecoveredCount: number;
  plannerOnlyCandidateCount: number;
}>;

export type MemoryDigestRetrievalEvidence = Readonly<{
  digestOnlyChatCount: number;
  navigationCandidateCount: number;
  rawAnchorCount: number;
  rawCandidateCount: number;
  secondStageQueryCount: number;
  selectedChatCount: number;
}>;

export type MemoryLocalRetrievalResult = Readonly<{
  core: readonly MemoryCoreCandidate[];
  digestEvidence?: MemoryDigestRetrievalEvidence;
  laneResults: readonly MemoryLaneResult[];
  lexicalEvidence: readonly MemoryLexicalLaneEvidence[];
  lexicalFailures: readonly MemoryRetrievalLane[];
  lexicalState: "DEGRADED" | "DISABLED" | "FAILED" | "READY";
  snapshot: MemoryLocalRetrievalSnapshot;
  sourceFamilyEvidence?: MemorySourceFamilyRetrievalEvidence;
  vectorEvidence: readonly MemoryVectorLaneEvidence[];
  vectorState: "DEGRADED" | "DISABLED" | "NOT_CONFIGURED" | "READY";
}>;

type SnapshotRow = Readonly<{
  activeIndexGenerationId: string | null;
  assistantOwnerId: string | null;
  chatFolderId: string | null;
  chatId: string | null;
  chatMemoryMode: string | null;
  decayEnabled: boolean | null;
  decayPolicyVersion: string | null;
  folderOwnerId: string | null;
  generationId: string | null;
  generationIndexMode: "HYBRID" | "LEXICAL_ONLY" | null;
  generationChunkingVersion: string | null;
  generationContextualKeyPolicyVersion: string | null;
  generationLanguageProfile: string | null;
  generationNormalizationVersion: string | null;
  generationPipelineVersion: string | null;
  generationRoundProjectionVersion: string | null;
  generationRoundSegmentProjectionVersion: string | null;
  generationState: string | null;
  memoryGeneration: number | null;
  memoryRevision: number | null;
  ownerStatus: string;
  referenceChatHistory: boolean | null;
  settingsRevision: number | null;
  useMemoryFacts: boolean | null;
}>;

type CandidateRow = Readonly<{
  canonicalKey: string | null;
  category: string | null;
  confidence: number;
  conflict: boolean;
  coreEligible: boolean;
  coreSalience: string;
  current: boolean;
  dedupeKey: string;
  deterministicMatch: string | null;
  directness: string | null;
  displayText: string | null;
  dimensionKey: string | null;
  entryId: string | null;
  entityIds: string[];
  evidenceRootHash: string | null;
  expectedAt: Date | null;
  expiresAt: Date | null;
  factId: string | null;
  historical: boolean;
  historySafetyClass: string | null;
  importance: number;
  identityKind: string | null;
  itemId: string;
  itemType: MemorySearchItemType;
  languageCode: string;
  lastConfirmedAt: Date | null;
  lastUsedAt: Date | null;
  lifecycleState: string | null;
  matchedSegmentId: string | null;
  matchedSegmentPosition: string | null;
  matchedEntityRole: string | null;
  modality: string | null;
  observedAt: Date | null;
  occurredAt: Date | null;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  pinned: boolean;
  parentChunkId: string | null;
  predicateKey: string | null;
  rawScore: number;
  relationDepth: number;
  safeContentHash: string | null;
  scopeAffinity: number;
  scopeType: string | null;
  sensitivityClass: string | null;
  sourceAssistantId: string | null;
  sourceChatId: string | null;
  sourceFolderId: string | null;
  sourceMode: string | null;
  sourceAuthority: string;
  subjectKey: string | null;
  synthesisDepth: number;
  structuredValue: Prisma.JsonValue | null;
  systemFrom: Date | null;
  temperatureClass: string | null;
  temperatureScore: number;
  validFrom: Date | null;
  validTo: Date | null;
}>;

type SessionCompletionRow = Readonly<{
  evidenceRootHash: string;
  itemId: string;
  languageCode: string;
  matchedSegmentId: string | null;
  matchedSegmentPosition: string | null;
  occurredFrom: Date;
  occurredTo: Date;
  parentChunkId: string;
  roundOrdinal: number;
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  sourceChatId: string;
  sourceFolderId: string | null;
}>;

type CoreRow = CandidateRow & Readonly<{ safeText: string }>;

type ExpandedRow = Readonly<{
  itemId: string;
  itemType: MemorySearchItemType;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  projectionKind: "CHAT_DIGEST_SAFE_TEXT" | "FACT_DISPLAY_TEXT" |
    "RECALL_CHUNK_SAFE_PROJECTED_TEXT" | "RECALL_ROUND_RAW_SAFE_TEXT" |
    "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT";
  retrievalHint: string | null;
  safeText: string;
  sourceChatId: string | null;
  patternSupportingEvidence: Prisma.JsonValue;
  supportingEvidence: Prisma.JsonValue;
  supportingItemId: string | null;
}>;

type UserSegmentExpandedRow = ExpandedRow & Readonly<{
  userSpans: Prisma.JsonValue;
}>;

const opaqueTokenPattern = /^[^\u0000-\u0020\u007f]{1,256}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const modalities = new Set([
  "STATE", "PREFERENCE", "CONSTRAINT", "CONSIDERATION", "INTENTION",
  "PLAN", "EVENT", "HABIT", "WORKFLOW", "PATTERN"
]);
const directnessValues = new Set(["DIRECT", "PARAPHRASED", "INFERRED"]);
const scopeTypes = new Set(["GLOBAL_USER", "FOLDER", "ASSISTANT", "CHAT"]);
const sensitivityClasses = new Set(["NORMAL", "SENSITIVE", "HIGHLY_SENSITIVE", "SECRET"]);
const sourceModes = new Set(["EXPLICIT", "AUTOMATIC"]);
const temperatureClasses = new Set(["HOT", "WARM", "COLD"]);
const historySafetyClasses = new Set([
  "NORMAL", "SENSITIVE", "HIGHLY_SENSITIVE", "SECRET_TAINTED"
]);
const coreSaliences = new Set(["HIGH", "MEDIUM", "LOW", "NONE"]);
const identityKinds = new Set(["SLOT", "PROPOSITION"]);
const lifecycleStates = new Set(["ACTIVE", "SUPERSEDED"]);
const entityRoles = new Set(["SUBJECT", "OBJECT", "MENTION"]);
const roundSegmentPositions = new Set(["MIDDLE", "PREFIX", "SINGLE", "SUFFIX"]);
const sourceAuthorities = new Set([
  "EXPLICIT", "DIRECT_AUTOMATIC", "PAST_CHAT", "SYNTHESIS", "TOOL_OBSERVATION"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const retrievalSourceKinds = new Set(["EVENT", "FACT", "HISTORY"]);
const retrievalModes = new Set([
  "CURRENT_PROFILE", "TARGETED_CURRENT", "HISTORICAL_MEMORY",
  "PAST_CHAT_SEARCH", "HISTORY_OVERVIEW"
]);
const temporalIntents = new Set(["CURRENT", "HISTORICAL", "AS_OF", "BETWEEN", "ANY"]);
const semanticVariantKinds = new Set([
  "DECOMPOSED", "ENTITY_EXPANSION", "ORIGINAL", "PLANNER_REWRITE"
]);
const temporalVariantKinds = new Set(["FILTERED", "UNRESTRICTED"]);
const temporalParserStates = new Set(["AMBIGUOUS", "INVALID", "MATCHED", "NO_MATCH"]);
const temporalParserConfidences = new Set(["HIGH", "MEDIUM"]);
const temporalExpressionTypes = new Set(MEMORY_TEMPORAL_QUERY_EXPRESSION_TYPES);
const opaqueEntityRefPattern = /^[^\u0000-\u0020\u007f]{1,2048}$/u;

function validToken(value: unknown): value is string {
  return typeof value === "string" && opaqueTokenPattern.test(value);
}

function validDate(value: Date | null): boolean {
  return value === null || value instanceof Date && Number.isFinite(value.getTime());
}

function validTemporalQuery(plan: MemoryRetrievalPlan): boolean {
  const result = plan.temporalQuery;
  if (!result || typeof result !== "object" ||
    result.parserVersion !== MEMORY_TEMPORAL_QUERY_PARSER_VERSION ||
    !temporalParserStates.has(result.state) ||
    !Number.isSafeInteger(result.matchedExpressionCount) ||
    result.matchedExpressionCount < 0 ||
    result.matchedExpressionCount > MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS) return false;
  if (result.state !== "MATCHED") {
    return result.confidence === null && result.expressionType === null &&
      result.interval === null;
  }
  if (!result.interval || result.confidence === null || result.expressionType === null ||
    !temporalParserConfidences.has(result.confidence) ||
    !temporalExpressionTypes.has(result.expressionType) ||
    !validDate(result.interval.from) || !validDate(result.interval.to) ||
    result.interval.from === null && result.interval.to === null ||
    result.interval.from !== null && result.interval.to !== null &&
      result.interval.from >= result.interval.to) return false;
  return result.matchedExpressionCount >= 1;
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function nullableClosed(value: string | null, allowed: ReadonlySet<string>): boolean {
  return value === null || allowed.has(value);
}

function decodeMetadata(row: CandidateRow): MemoryCandidateMetadata {
  const safeDisplayText = row.displayText === null
    ? null
    : safeMemoryProjectionText(row.displayText);
  if (
    !validToken(row.itemId) || !validToken(row.dedupeKey) ||
    (row.entryId !== null && !validToken(row.entryId)) ||
    !["FACT_VERSION", "RECALL_CHUNK", "RECALL_ROUND", "TOOL_EVENT"]
      .includes(row.itemType) ||
    (row.evidenceRootHash !== null && !fingerprintPattern.test(row.evidenceRootHash)) ||
    (row.parentChunkId !== null && !validToken(row.parentChunkId)) ||
    !Number.isFinite(row.rawScore) ||
    !validUnit(row.confidence) || !validUnit(row.importance) || !validUnit(row.scopeAffinity) ||
    !validUnit(row.temperatureScore) ||
    !nullableClosed(row.directness, directnessValues) ||
    !nullableClosed(row.identityKind, identityKinds) ||
    !nullableClosed(row.lifecycleState, lifecycleStates) ||
    !nullableClosed(row.matchedEntityRole, entityRoles) ||
    !nullableClosed(row.modality, modalities) ||
    !nullableClosed(row.scopeType, scopeTypes) ||
    !nullableClosed(row.sensitivityClass, sensitivityClasses) ||
    !nullableClosed(row.sourceMode, sourceModes) ||
    !nullableClosed(row.temperatureClass, temperatureClasses) ||
    !nullableClosed(row.historySafetyClass, historySafetyClasses) ||
    !coreSaliences.has(row.coreSalience) ||
    !sourceAuthorities.has(row.sourceAuthority) ||
    !Array.isArray(row.entityIds) || row.entityIds.length > 32 ||
    new Set(row.entityIds).size !== row.entityIds.length ||
    row.entityIds.some((id) => !validToken(id)) ||
    !Number.isSafeInteger(row.relationDepth) || row.relationDepth < 0 ||
    !Number.isSafeInteger(row.synthesisDepth) || row.synthesisDepth < 0 ||
    [row.expectedAt, row.expiresAt, row.lastConfirmedAt, row.lastUsedAt,
      row.observedAt, row.occurredAt,
      row.occurredFrom, row.occurredTo, row.systemFrom, row.validFrom, row.validTo]
      .some((value) => !validDate(value)) ||
    row.current === row.historical ||
    row.itemType === "FACT_VERSION" && row.entryId !== null && (
      !row.safeContentHash || row.structuredValue === null || safeDisplayText === null ||
      ![
        memorySha256({
          displayText: row.displayText,
          structuredValue: row.structuredValue
        }),
        memorySha256({
          displayText: safeDisplayText,
          structuredValue: row.structuredValue
        })
      ].includes(row.safeContentHash)
    )
  ) throw new Error("memory_retrieval_result_invalid");
  return {
    canonicalKey: row.canonicalKey,
    category: row.category,
    confidence: row.confidence,
    conflict: row.conflict,
    coreEligible: row.coreEligible,
    coreSalience: row.coreSalience as MemoryCandidateMetadata["coreSalience"],
    current: row.current,
    dedupeKey: row.dedupeKey,
    directness: row.directness as MemoryCandidateMetadata["directness"],
    dimensionKey: row.dimensionKey,
    entityIds: row.entityIds,
    evidenceRootHash: row.evidenceRootHash,
    expectedAt: row.expectedAt,
    expiresAt: row.expiresAt,
    factId: row.factId,
    historical: row.historical,
    historySafetyClass: row.historySafetyClass as MemoryCandidateMetadata["historySafetyClass"],
    importance: row.importance,
    identityKind: row.identityKind as MemoryCandidateMetadata["identityKind"],
    languageCode: row.languageCode,
    lastConfirmedAt: row.lastConfirmedAt,
    lastUsedAt: row.lastUsedAt,
    lifecycleState: row.lifecycleState as MemoryCandidateMetadata["lifecycleState"],
    matchedEntityRole: row.matchedEntityRole as MemoryCandidateMetadata["matchedEntityRole"],
    modality: row.modality as MemoryCandidateMetadata["modality"],
    observedAt: row.observedAt,
    occurredAt: row.occurredAt,
    occurredFrom: row.occurredFrom,
    occurredTo: row.occurredTo,
    pinned: row.pinned,
    parentChunkId: row.parentChunkId,
    predicateKey: row.predicateKey,
    relationDepth: row.relationDepth,
    scopeAffinity: row.scopeAffinity,
    scopeType: row.scopeType as MemoryCandidateMetadata["scopeType"],
    sensitivityClass: row.sensitivityClass as MemoryCandidateMetadata["sensitivityClass"],
    sourceAssistantId: row.sourceAssistantId,
    sourceChatId: row.sourceChatId,
    sourceFolderId: row.sourceFolderId,
    sourceMode: row.sourceMode as MemoryCandidateMetadata["sourceMode"],
    sourceAuthority: row.sourceAuthority as MemoryCandidateMetadata["sourceAuthority"],
    subjectKey: row.subjectKey,
    synthesisDepth: row.synthesisDepth,
    systemFrom: row.systemFrom,
    temperatureClass: row.temperatureClass as MemoryCandidateMetadata["temperatureClass"],
    temperatureScore: row.temperatureScore,
    validFrom: row.validFrom,
    validTo: row.validTo
  };
}

function decodeCandidate(row: CandidateRow, lane: MemoryRetrievalLane): MemoryLaneCandidate {
  if (row.deterministicMatch !== null &&
    !["EXACT_ALIAS_SINGLE_ROOT", "EXACT_TEXT", "PROFILE"]
      .includes(row.deterministicMatch)) {
    throw new Error("memory_retrieval_result_invalid");
  }
  const hasSegment = row.matchedSegmentId !== null ||
    row.matchedSegmentPosition !== null;
  if (hasSegment && (
    row.itemType !== "RECALL_ROUND" ||
    !validToken(row.matchedSegmentId) ||
    row.matchedSegmentPosition === null ||
    !roundSegmentPositions.has(row.matchedSegmentPosition)
  )) throw new Error("memory_retrieval_result_invalid");
  return {
    deterministicMatch: row.deterministicMatch as MemoryDeterministicMatch | null,
    entryId: row.entryId,
    hardFilterPassed: true,
    itemId: row.itemId,
    itemType: row.itemType as MemoryLaneCandidate["itemType"],
    lane,
    matchedSegmentId: row.matchedSegmentId,
    matchedSegmentPosition: row.matchedSegmentPosition as
      MemoryLaneCandidate["matchedSegmentPosition"],
    metadata: decodeMetadata(row),
    rawScore: row.rawScore
  };
}

function safeMemoryProjectionText(value: string): string | null {
  const redaction = redactMemorySecrets(value);
  if (redaction.containsSecret &&
    !memoryRedactionHasMeaningfulRemainder(value, redaction)) return null;
  return redaction.redactedText.length <= 4_000 ? redaction.redactedText : null;
}

/**
 * Segment offsets are UTF-16 indices produced by the TypeScript projector;
 * PostgreSQL substring offsets count Unicode code points. Slice only here so
 * supplementary characters cannot move an authority boundary. The SQL query
 * supplies spans only after role/source-map joins have matched canonically.
 */
function projectUserTestimonyExpandedRow(
  row: UserSegmentExpandedRow
): ExpandedRow | null {
  const safeText = memoryUserTestimonyText(row.safeText, row.userSpans);
  if (!safeText) return null;
  const { userSpans: _userSpans, ...expanded } = row;
  return {
    ...expanded,
    retrievalHint: null,
    safeText,
    supportingEvidence: []
  };
}

function decodedContextualEvidence(row: ExpandedRow): Readonly<{
  retrievalHint: string | null;
  supportingEvidence: NonNullable<MemoryExpandedCandidate["supportingEvidence"]>;
}> {
  if (row.retrievalHint === null) {
    return { retrievalHint: null, supportingEvidence: Object.freeze([]) };
  }
  const retrievalHint = safeMemoryProjectionText(row.retrievalHint);
  if (!retrievalHint || !Array.isArray(row.supportingEvidence) ||
    row.supportingEvidence.length > 2) {
    return { retrievalHint: null, supportingEvidence: Object.freeze([]) };
  }
  const decoded = row.supportingEvidence.flatMap((value) => {
    if (!isRecord(value) ||
      Object.keys(value).sort().join("\u0000") !==
        "itemId\u0000occurredFrom\u0000occurredTo\u0000safeText\u0000sourceChatId" ||
      !validToken(value.itemId) || !validToken(value.sourceChatId) ||
      typeof value.safeText !== "string" || !value.safeText.trim() ||
      typeof value.occurredFrom !== "string" ||
      typeof value.occurredTo !== "string") return [];
    const occurredFrom = new Date(value.occurredFrom);
    const occurredTo = new Date(value.occurredTo);
    const safeText = safeMemoryProjectionText(
      boundedMemoryRecallRoundEvidenceText(value.safeText)
    );
    return safeText && !Number.isNaN(occurredFrom.getTime()) &&
      !Number.isNaN(occurredTo.getTime()) && occurredTo >= occurredFrom
      ? [{
          itemId: value.itemId,
          occurredFrom,
          occurredTo,
          safeText,
          sourceChatId: value.sourceChatId
        }]
      : [];
  });
  if (decoded.length !== row.supportingEvidence.length ||
    new Set(decoded.map(({ itemId }) => itemId)).size !== decoded.length ||
    decoded.some(({ sourceChatId }) => sourceChatId !== row.sourceChatId)) {
    return { retrievalHint: null, supportingEvidence: Object.freeze([]) };
  }
  return {
    retrievalHint,
    supportingEvidence: Object.freeze(decoded)
  };
}

function decodedPatternSupportingEvidence(
  row: ExpandedRow
): NonNullable<MemoryExpandedCandidate["patternSupportingEvidence"]> {
  if (!Array.isArray(row.patternSupportingEvidence) ||
    row.patternSupportingEvidence.length > MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS) {
    return Object.freeze([]);
  }
  const decoded = row.patternSupportingEvidence.flatMap((value) => {
    if (!isRecord(value) ||
      Object.keys(value).sort().join("\u0000") !==
        "itemId\u0000observedAt\u0000safeText\u0000sourceAuthority\u0000sourceChatId\u0000sourceRootHash" ||
      !validToken(value.itemId) || typeof value.safeText !== "string" ||
      (value.sourceAuthority !== "DIRECT_AUTOMATIC" &&
        value.sourceAuthority !== "EXPLICIT") ||
      (value.sourceChatId !== null && !validToken(value.sourceChatId)) ||
      typeof value.sourceRootHash !== "string" ||
      !fingerprintPattern.test(value.sourceRootHash) ||
      typeof value.observedAt !== "string") return [];
    const observedAt = new Date(value.observedAt);
    const safeText = safeMemoryProjectionText(value.safeText);
    return safeText && !Number.isNaN(observedAt.getTime())
      ? [{
          itemId: value.itemId,
          observedAt,
          safeText,
          sourceAuthority: value.sourceAuthority as
            "DIRECT_AUTOMATIC" | "EXPLICIT",
          sourceChatId: value.sourceChatId,
          sourceRootHash: value.sourceRootHash
        }]
      : [];
  });
  if (decoded.length !== row.patternSupportingEvidence.length ||
    new Set(decoded.map(({ itemId }) => itemId)).size !== decoded.length ||
    new Set(decoded.map(({ sourceRootHash }) => sourceRootHash)).size !== decoded.length) {
    return Object.freeze([]);
  }
  return Object.freeze(decoded);
}

function decodeExpanded(row: ExpandedRow): MemoryExpandedCandidate | null {
  if (
    !validToken(row.itemId) ||
    !["FACT_VERSION", "RECALL_CHUNK", "RECALL_ROUND", "TOOL_EVENT"]
      .includes(row.itemType) ||
    !["CHAT_DIGEST_SAFE_TEXT", "FACT_DISPLAY_TEXT",
      "RECALL_CHUNK_SAFE_PROJECTED_TEXT", "RECALL_ROUND_RAW_SAFE_TEXT",
      "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT", "TOOL_EVENT_SAFE_TEXT"]
      .includes(row.projectionKind) ||
    typeof row.safeText !== "string" || !row.safeText.trim() || row.safeText.length > 4_000 ||
    row.safeText.includes("\u0000") ||
    (row.sourceChatId !== null && !validToken(row.sourceChatId)) ||
    (row.supportingItemId !== null && !validToken(row.supportingItemId)) ||
    !validDate(row.occurredFrom) || !validDate(row.occurredTo)
  ) throw new Error("memory_expansion_result_invalid");
  const safeText = safeMemoryProjectionText(row.safeText);
  if (!safeText) return null;
  const contextual = decodedContextualEvidence(row);
  const patternSupportingEvidence = decodedPatternSupportingEvidence(row);
  const { patternSupportingEvidence: _rawPatternSupportingEvidence, ...projection } = row;
  return {
    ...projection,
    itemType: row.itemType as MemoryExpandedCandidate["itemType"],
    ...(patternSupportingEvidence.length > 0 ? { patternSupportingEvidence } : {}),
    retrievalHint: contextual.retrievalHint,
    safeText,
    supportingEvidence: contextual.supportingEvidence
  };
}

function orderedExpandedCandidates(
  candidates: readonly MemoryRankedCandidate[],
  rows: readonly ExpandedRow[]
): readonly MemoryExpandedCandidate[] {
  const decoded = rows.flatMap((row) => {
    const expanded = decodeExpanded(row);
    return expanded ? [expanded] : [];
  });
  const keys = decoded.map((row) => `${row.itemType}:${row.itemId}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("memory_expansion_result_invalid");
  }
  const byKey = new Map(decoded.map((row) => [`${row.itemType}:${row.itemId}`, row]));
  return candidates.flatMap((candidate) => {
    const value = byKey.get(`${candidate.itemType}:${candidate.itemId}`);
    return value ? [value] : [];
  });
}

function valuesSql(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

function boundedMemorySearchEntryCandidatesSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  candidatePredicate: Prisma.Sql
): Prisma.Sql {
  if (!snapshot.activeGenerationId) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`candidate_entries AS MATERIALIZED (
    SELECT ${boundedMemorySearchEntryColumnsSql()}
    FROM "MemorySearchEntry" AS entry
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."indexGenerationId" = ${snapshot.activeGenerationId}
      AND (${candidatePredicate})
  )`;
}

function memoryRoundSearchEntryItemTypePredicate(
  snapshot: MemoryLocalRetrievalSnapshot
): Prisma.Sql {
  return snapshot.roundSegmentProjectionVersion ===
    MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION
    ? Prisma.sql`entry."itemType" =
        'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"`
    : Prisma.sql`entry."itemType" = 'RECALL_ROUND'::"MemorySearchItemType"`;
}

function expectedGenerationPipeline(indexMode: "HYBRID" | "LEXICAL_ONLY"): string {
  return indexMode === "HYBRID"
    ? MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    : MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION;
}

const memoryLocalRetrievalSnapshotKeys = Object.freeze([
  "activeGenerationId",
  "assistantId",
  "chatId",
  "chatMemoryMode",
  "contextualKeyPolicyVersion",
  "decayEnabled",
  "decayPolicyVersion",
  "folderId",
  "historyAuthorityRevision",
  "indexMode",
  "memoryGeneration",
  "memoryRevision",
  "reason",
  "referenceChatHistory",
  "repositoryVersion",
  "roundProjectionVersion",
  "roundSegmentProjectionVersion",
  "settingsRevision",
  "status",
  "useMemoryFacts",
  "userId"
] as const);

function nullableToken(value: unknown): value is string | null {
  return value === null || validToken(value);
}

function snapshotAuthorityFingerprint(snapshot: MemoryLocalRetrievalSnapshot): string {
  const keys = Object.keys(snapshot).sort();
  if (
    keys.length !== memoryLocalRetrievalSnapshotKeys.length ||
    keys.some((key, index) => key !== memoryLocalRetrievalSnapshotKeys[index]) ||
    !nullableToken(snapshot.activeGenerationId) ||
    !nullableToken(snapshot.assistantId) ||
    !validToken(snapshot.chatId) ||
    !["EXCLUDED", "NORMAL", "TEMPORARY"].includes(snapshot.chatMemoryMode) ||
    !nullableToken(snapshot.contextualKeyPolicyVersion ?? null) ||
    typeof snapshot.decayEnabled !== "boolean" ||
    !nullableToken(snapshot.decayPolicyVersion) ||
    !nullableToken(snapshot.folderId) ||
    (snapshot.historyAuthorityRevision !== null && (
      !Number.isSafeInteger(snapshot.historyAuthorityRevision) ||
      snapshot.historyAuthorityRevision < 0
    )) ||
    !["HYBRID", "LEXICAL_ONLY", null].includes(snapshot.indexMode) ||
    !Number.isSafeInteger(snapshot.memoryGeneration) || snapshot.memoryGeneration < 0 ||
    !Number.isSafeInteger(snapshot.memoryRevision) || snapshot.memoryRevision < 0 ||
    !validToken(snapshot.reason) ||
    typeof snapshot.referenceChatHistory !== "boolean" ||
    snapshot.repositoryVersion !== MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION ||
    !nullableToken(snapshot.roundProjectionVersion ?? null) ||
    !nullableToken(snapshot.roundSegmentProjectionVersion ?? null) ||
    !Number.isSafeInteger(snapshot.settingsRevision) || snapshot.settingsRevision < 0 ||
    !["DISABLED", "READY", "UNAVAILABLE"].includes(snapshot.status) ||
    typeof snapshot.useMemoryFacts !== "boolean" ||
    !validToken(snapshot.userId)
  ) throw new Error("memory_retrieval_snapshot_invalid");
  return memorySha256(Object.fromEntries(
    memoryLocalRetrievalSnapshotKeys.map((key) => [key, snapshot[key]])
  ));
}

async function loadSnapshot(
  client: PrismaClient,
  input: MemoryLocalRetrievalInput
): Promise<MemoryLocalRetrievalSnapshot> {
  if (
    !validToken(input.userId) || !validToken(input.chatId) ||
    (input.assistantId !== null && !validToken(input.assistantId)) ||
    !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())
  ) throw new Error("memory_retrieval_context_invalid");
  const rows = await withMemoryReadBudget(
    client,
    MEMORY_READ_BUDGET_MS.SNAPSHOT_CORE,
    (tx) => tx.$queryRaw<SnapshotRow[]>(Prisma.sql`
    SELECT
      owner."status"::text AS "ownerStatus",
      current_chat."id" AS "chatId",
      current_chat."folderId" AS "chatFolderId",
      current_chat."memoryMode"::text AS "chatMemoryMode",
      current_folder."userId" AS "folderOwnerId",
      selected_assistant."ownerUserId" AS "assistantOwnerId",
      settings."useMemoryFacts", settings."referenceChatHistory",
      settings."decayEnabled", settings."decayPolicyVersion",
      settings."memoryGeneration", settings."memoryRevision", settings."settingsRevision",
      settings."activeIndexGenerationId",
      generation."id" AS "generationId",
      generation."state"::text AS "generationState",
      generation."indexMode"::text AS "generationIndexMode",
      generation."chunkingVersion" AS "generationChunkingVersion",
      generation."contextualKeyPolicyVersion" AS
        "generationContextualKeyPolicyVersion",
      generation."languageProfile" AS "generationLanguageProfile",
      generation."normalizationVersion" AS "generationNormalizationVersion",
      generation."retrievalPipelineVersion" AS "generationPipelineVersion",
      generation."roundProjectionVersion" AS "generationRoundProjectionVersion",
      generation."roundSegmentProjectionVersion" AS
        "generationRoundSegmentProjectionVersion"
    FROM "User" AS owner
    LEFT JOIN "Chat" AS current_chat
      ON current_chat."userId" = owner."id" AND current_chat."id" = ${input.chatId}
    LEFT JOIN "Folder" AS current_folder
      ON current_folder."userId" = owner."id" AND current_folder."id" = current_chat."folderId"
    LEFT JOIN "AssistantDefinition" AS selected_assistant
      ON selected_assistant."ownerUserId" = owner."id"
      AND selected_assistant."id" = ${input.assistantId}
      AND selected_assistant."archivedAt" IS NULL
    LEFT JOIN "UserMemorySettings" AS settings ON settings."userId" = owner."id"
    LEFT JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
    WHERE owner."id" = ${input.userId}
    LIMIT 1
    `)
  );
  const row = rows[0];
  if (!row || row.ownerStatus !== "active" || row.chatId !== input.chatId) {
    throw new Error("memory_retrieval_context_unavailable");
  }
  if (row.chatFolderId !== null && row.folderOwnerId !== input.userId) {
    throw new Error("memory_retrieval_context_unavailable");
  }
  const assistantId = input.assistantId !== null && row.assistantOwnerId === input.userId
    ? input.assistantId
    : null;
  const useMemoryFacts = row.useMemoryFacts === true;
  const referenceChatHistory = row.referenceChatHistory === true;
  const memoryRevision = Number.isSafeInteger(row.memoryRevision)
    ? Number(row.memoryRevision)
    : 0;
  const indexMode = row.generationIndexMode;
  const generationReady = useMemoryFacts && row.activeIndexGenerationId !== null &&
    row.generationId === row.activeIndexGenerationId &&
    row.generationState === "ACTIVE" &&
    (indexMode === "HYBRID" || indexMode === "LEXICAL_ONLY") &&
    row.generationChunkingVersion === MEMORY_LEXICAL_CHUNKING_VERSION &&
    row.generationLanguageProfile === MEMORY_LEXICAL_ANALYSIS_PROFILE &&
    row.generationNormalizationVersion === MEMORY_LEXICAL_NORMALIZATION_VERSION &&
    row.generationPipelineVersion === expectedGenerationPipeline(indexMode);
  const base = {
    activeGenerationId: row.activeIndexGenerationId,
    assistantId,
    chatId: input.chatId,
    chatMemoryMode: row.chatMemoryMode === "EXCLUDED" || row.chatMemoryMode === "TEMPORARY"
      ? row.chatMemoryMode
      : "NORMAL",
    decayEnabled: row.decayEnabled === true,
    decayPolicyVersion: row.decayPolicyVersion ?? null,
    folderId: row.chatFolderId,
    historyAuthorityRevision: referenceChatHistory ? memoryRevision : null,
    indexMode: generationReady ? indexMode : null,
    contextualKeyPolicyVersion: generationReady
      ? row.generationContextualKeyPolicyVersion
      : null,
    memoryGeneration: Number.isSafeInteger(row.memoryGeneration) ? Number(row.memoryGeneration) : 0,
    memoryRevision,
    referenceChatHistory,
    repositoryVersion: MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION,
    roundProjectionVersion: generationReady
      ? row.generationRoundProjectionVersion
      : null,
    roundSegmentProjectionVersion: generationReady
      ? row.generationRoundSegmentProjectionVersion
      : null,
    settingsRevision: Number.isSafeInteger(row.settingsRevision) ? Number(row.settingsRevision) : 0,
    useMemoryFacts,
    userId: input.userId
  } as const;
  if (row.chatMemoryMode === "TEMPORARY") {
    return { ...base, reason: "temporary_chat", status: "DISABLED" };
  }
  if (!useMemoryFacts) {
    return { ...base, reason: "memory_paused", status: "DISABLED" };
  }
  return {
    ...base,
    reason: generationReady ? "ready" : "memory_index_unavailable",
    status: "READY"
  };
}

export function memoryActiveSuppressionPredicate(userId: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "MemorySuppression" AS global_suppression
    WHERE global_suppression."userId" = ${userId}
      AND global_suppression."scope" = 'ALL'::"MemorySuppressionScope"
      AND (global_suppression."expiresAt" IS NULL OR global_suppression."expiresAt" > CURRENT_TIMESTAMP)
  )`;
}

export function memoryFactScopePredicate(
  _snapshot: Pick<MemoryLocalRetrievalSnapshot, "assistantId" | "chatId" | "folderId" | "userId">
): Prisma.Sql {
  return memoryCanonicalGlobalScopePredicate();
}

export function memoryChunkSourceSafetyPredicate(): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1 FROM "MemorySuppression" AS history_suppression
      WHERE history_suppression."userId" = chunk."userId"
        AND (history_suppression."expiresAt" IS NULL
          OR history_suppression."expiresAt" > CURRENT_TIMESTAMP)
        AND (history_suppression."scope" = 'ALL'::"MemorySuppressionScope" OR (
          history_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
          AND history_suppression."sourceChatId" = chunk."chatId"
          AND (history_suppression."sourceBranchGeneration" IS NULL
            OR history_suppression."sourceBranchGeneration" = chunk."branchGeneration")
          AND EXISTS (SELECT 1 FROM "MemoryRecallChunkMessage" AS suppressed_chunk_message
            WHERE suppressed_chunk_message."userId" = chunk."userId"
              AND suppressed_chunk_message."chunkId" = chunk."id"
              AND suppressed_chunk_message."messageId" = history_suppression."sourceMessageId")
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySourceBarrier" AS history_barrier
      WHERE history_barrier."userId" = chunk."userId"
        AND history_barrier."kind" IN (
          'HISTORY_INDEX'::"MemorySourceBarrierKind", 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        AND history_barrier."explicitOverrideAllowed" = FALSE
        AND (chunk."createdAt" <= history_barrier."createdAt" OR EXISTS (
          SELECT 1 FROM "MemoryRecallChunkMessage" AS barrier_chunk_message
          INNER JOIN "Message" AS barrier_message
            ON barrier_message."chatId" = barrier_chunk_message."chatId"
            AND barrier_message."id" = barrier_chunk_message."messageId"
          WHERE barrier_chunk_message."userId" = chunk."userId"
            AND barrier_chunk_message."chunkId" = chunk."id"
            AND barrier_message."createdAt" <= history_barrier."sourceCreatedAtCutoff"
        ))
    )
  `;
}

export function memoryRoundSourceSafetyPredicate(): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1 FROM "MemorySuppression" AS history_suppression
      WHERE history_suppression."userId" = round."userId"
        AND (history_suppression."expiresAt" IS NULL
          OR history_suppression."expiresAt" > CURRENT_TIMESTAMP)
        AND (history_suppression."scope" = 'ALL'::"MemorySuppressionScope" OR (
          history_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
          AND history_suppression."sourceChatId" = round."chatId"
          AND (history_suppression."sourceBranchGeneration" IS NULL
            OR history_suppression."sourceBranchGeneration" = round."branchGeneration")
          AND EXISTS (SELECT 1 FROM "MemoryRecallRoundMessage" AS suppressed_round_message
            WHERE suppressed_round_message."userId" = round."userId"
              AND suppressed_round_message."roundId" = round."id"
              AND suppressed_round_message."messageId" =
                history_suppression."sourceMessageId")
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySourceBarrier" AS history_barrier
      WHERE history_barrier."userId" = round."userId"
        AND history_barrier."kind" IN (
          'HISTORY_INDEX'::"MemorySourceBarrierKind", 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        AND history_barrier."explicitOverrideAllowed" = FALSE
        AND (round."createdAt" <= history_barrier."createdAt" OR EXISTS (
          SELECT 1 FROM "MemoryRecallRoundMessage" AS barrier_round_message
          INNER JOIN "Message" AS barrier_message
            ON barrier_message."chatId" = barrier_round_message."chatId"
            AND barrier_message."id" = barrier_round_message."messageId"
          WHERE barrier_round_message."userId" = round."userId"
            AND barrier_round_message."roundId" = round."id"
            AND barrier_message."createdAt" <= history_barrier."sourceCreatedAtCutoff"
        ))
    )
  `;
}

function factKindPredicate(plan: MemoryRetrievalPlan): Prisma.Sql {
  const fact = plan.filters.sourceKinds.includes("FACT");
  const event = plan.filters.sourceKinds.includes("EVENT");
  if (fact && event) return Prisma.sql`TRUE`;
  if (event) return Prisma.sql`version."modality" = 'EVENT'::"MemoryFactModality"`;
  if (fact) return Prisma.sql`version."modality" <> 'EVENT'::"MemoryFactModality"`;
  return Prisma.sql`FALSE`;
}

function factPlanPredicates(plan: MemoryRetrievalPlan): Prisma.Sql {
  const patterns = plan.includePatterns
    ? Prisma.sql`TRUE`
    : Prisma.sql`version."modality" <> 'PATTERN'::"MemoryFactModality"`;
  const scope = plan.filters.scopeType
    ? Prisma.sql`scope."scopeType"::text = ${plan.filters.scopeType}`
    : Prisma.sql`TRUE`;
  const target = plan.filters.scopeTargetId
    ? Prisma.sql`scope."targetIdSnapshot" = ${plan.filters.scopeTargetId}`
    : Prisma.sql`TRUE`;
  return Prisma.sql`${patterns} AND ${factKindPredicate(plan)} AND ${scope} AND ${target}`;
}

function historyPlanPredicates(plan: MemoryRetrievalPlan): Prisma.Sql {
  if (!plan.filters.sourceKinds.includes("HISTORY")) return Prisma.sql`FALSE`;
  const scope = plan.filters.scopeType === null
    ? Prisma.sql`TRUE`
    : plan.filters.scopeType === "CHAT"
      ? plan.filters.scopeTargetId
        ? Prisma.sql`chunk."chatId" = ${plan.filters.scopeTargetId}`
        : Prisma.sql`TRUE`
      : plan.filters.scopeType === "FOLDER" && plan.filters.scopeTargetId
        ? Prisma.sql`chunk."sourceFolderId" = ${plan.filters.scopeTargetId}`
        : plan.filters.scopeType === "ASSISTANT" && plan.filters.scopeTargetId
          ? Prisma.sql`chunk."sourceAssistantId" = ${plan.filters.scopeTargetId}`
          : Prisma.sql`FALSE`;
  return scope;
}

function historyRoundPlanPredicates(plan: MemoryRetrievalPlan): Prisma.Sql {
  if (!plan.filters.sourceKinds.includes("HISTORY")) return Prisma.sql`FALSE`;
  return plan.filters.scopeType === null
    ? Prisma.sql`TRUE`
    : plan.filters.scopeType === "CHAT"
      ? plan.filters.scopeTargetId
        ? Prisma.sql`round."chatId" = ${plan.filters.scopeTargetId}`
        : Prisma.sql`TRUE`
      : plan.filters.scopeType === "FOLDER" && plan.filters.scopeTargetId
        ? Prisma.sql`round."sourceFolderId" = ${plan.filters.scopeTargetId}`
        : plan.filters.scopeType === "ASSISTANT" && plan.filters.scopeTargetId
          ? Prisma.sql`round."sourceAssistantId" = ${plan.filters.scopeTargetId}`
          : Prisma.sql`FALSE`;
}

function toolEventPlanPredicates(plan: MemoryRetrievalPlan): Prisma.Sql {
  if (!plan.filters.sourceKinds.includes("HISTORY")) return Prisma.sql`FALSE`;
  return plan.filters.scopeType === null
    ? Prisma.sql`TRUE`
    : plan.filters.scopeType === "CHAT"
      ? plan.filters.scopeTargetId
        ? Prisma.sql`tool_event."chatId" = ${plan.filters.scopeTargetId}`
        : Prisma.sql`TRUE`
      : plan.filters.scopeType === "FOLDER" && plan.filters.scopeTargetId
        ? Prisma.sql`tool_event."sourceFolderId" = ${plan.filters.scopeTargetId}`
        : plan.filters.scopeType === "ASSISTANT" && plan.filters.scopeTargetId
          ? Prisma.sql`tool_event."sourceAssistantId" = ${plan.filters.scopeTargetId}`
          : Prisma.sql`FALSE`;
}

function historyDigestPlanPredicates(plan: MemoryRetrievalPlan): Prisma.Sql {
  const digestMode = plan.mode === "HISTORY_OVERVIEW" ||
    plan.mode === "PAST_CHAT_SEARCH";
  if (!digestMode ||
    !plan.filters.sourceKinds.includes("HISTORY")) return Prisma.sql`FALSE`;
  const scope = plan.filters.scopeType === null
    ? Prisma.sql`TRUE`
    : plan.filters.scopeType === "CHAT"
      ? plan.filters.scopeTargetId
        ? Prisma.sql`digest."chatId" = ${plan.filters.scopeTargetId}`
        : Prisma.sql`TRUE`
      : plan.filters.scopeType === "FOLDER" && plan.filters.scopeTargetId
        ? Prisma.sql`digest."sourceFolderId" = ${plan.filters.scopeTargetId}`
        : plan.filters.scopeType === "ASSISTANT" && plan.filters.scopeTargetId
          ? Prisma.sql`digest."sourceAssistantId" = ${plan.filters.scopeTargetId}`
          : Prisma.sql`FALSE`;
  return scope;
}

function factColumns(
  entry: Prisma.Sql,
  matchedEntityRole: Prisma.Sql = Prisma.sql`NULL::text`,
  safeContentHash: Prisma.Sql = Prisma.sql`NULL::text`
): Prisma.Sql {
  return Prisma.sql`
    ${entry} AS "entryId", version."id" AS "itemId",
    ${safeContentHash} AS "safeContentHash", version."displayText",
    version."structuredValue",
    NULL::text AS "evidenceRootHash", NULL::text AS "parentChunkId",
    NULL::text AS "matchedSegmentId", NULL::text AS "matchedSegmentPosition",
    'FACT_VERSION'::"MemorySearchItemType" AS "itemType", root_fact."id" AS "factId",
    (CASE WHEN version."state" = 'SUPERSEDED'::"MemoryFactVersionState"
      THEN 'fact-history:' || encode(digest(convert_to(jsonb_build_object(
        'rootFactId', root_fact."id",
        'structuredValue', version."structuredValue",
        'modality', version."modality"::text,
        'occurredAt', version."occurredAt",
        'validFrom', version."validFrom",
        'validTo', version."validTo",
        'expectedAt', version."expectedAt"
      )::text, 'UTF8'), 'sha256'), 'hex')
      ELSE 'fact:' || root_fact."id" END)::text AS "dedupeKey",
    root_fact."canonicalKey", root_fact."category",
    root_fact."identityKind"::text AS "identityKind",
    root_fact."subjectKey", root_fact."predicateKey", root_fact."dimensionKey",
    version."languageCode", version."modality"::text AS "modality",
    version."sourceMode"::text AS "sourceMode", version."directness"::text AS "directness",
    CASE WHEN version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode" THEN 'EXPLICIT'
      WHEN version."modality" = 'PATTERN'::"MemoryFactModality"
        THEN 'SYNTHESIS' ELSE 'DIRECT_AUTOMATIC' END::text AS "sourceAuthority",
    version."sensitivityClass"::text AS "sensitivityClass",
    NULL::text AS "historySafetyClass", root_scope."scopeType"::text AS "scopeType",
    root_scope."folderId" AS "sourceFolderId",
    root_scope."assistantId" AS "sourceAssistantId",
    root_scope."chatId" AS "sourceChatId", root_fact."pinned",
    root_fact."temperatureClass"::text AS "temperatureClass",
    root_fact."temperatureScore"::double precision AS "temperatureScore",
    root_fact."lastUsedAt", root_fact."lastConfirmedAt",
    version."confidence"::double precision AS "confidence",
    version."importance"::double precision AS "importance",
    version."coreEligible", version."coreSalience"::text AS "coreSalience",
    CASE scope."scopeType" WHEN 'CHAT'::"MemoryScopeType" THEN 1.0
      WHEN 'ASSISTANT'::"MemoryScopeType" THEN 0.9
      WHEN 'FOLDER'::"MemoryScopeType" THEN 0.8 ELSE 0.7 END::double precision AS "scopeAffinity",
    (version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND root_fact."currentVersionId" = version."id") AS "current",
    (version."state" = 'SUPERSEDED'::"MemoryFactVersionState") AS "historical",
    FALSE AS "conflict", version."state"::text AS "lifecycleState",
    version."observedAt", version."occurredAt", version."expectedAt", version."expiresAt",
    version."validFrom", version."validTo", version."systemFrom",
    ARRAY(SELECT DISTINCT aiqsa_memory_entity_root_id(
        link."userId", link."entityId"
      ) FROM "MemoryFactVersionEntity" AS link
      WHERE link."userId" = version."userId"
        AND link."factVersionId" = version."id"
        AND aiqsa_memory_entity_root_id(
          link."userId", link."entityId"
        ) IS NOT NULL
      ORDER BY aiqsa_memory_entity_root_id(link."userId", link."entityId")
      LIMIT 32)::text[] AS "entityIds",
    ${matchedEntityRole} AS "matchedEntityRole",
    0::integer AS "relationDepth", version."synthesisDepth" AS "synthesisDepth",
    NULL::timestamp AS "occurredFrom", NULL::timestamp AS "occurredTo"
  `;
}

function factLifecyclePredicate(plan: MemoryRetrievalPlan): Prisma.Sql {
  if (plan.mode === "HISTORICAL_MEMORY") {
    return Prisma.sql`(
      (
        version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND fact."currentVersionId" = version."id"
      )
      OR (
        version."state" = 'SUPERSEDED'::"MemoryFactVersionState"
        AND version."systemTo" IS NOT NULL
        AND (
          fact."state" = 'ACTIVE'::"MemoryFactState"
          OR (fact."state" = 'RETRACTED'::"MemoryFactState"
            AND fact."movedToFactId" IS NOT NULL)
        )
      )
    )`;
  }
  return Prisma.sql`
    version."state" = 'ACTIVE'::"MemoryFactVersionState"
    AND version."systemTo" IS NULL
    AND fact."state" = 'ACTIVE'::"MemoryFactState"
    AND fact."currentVersionId" = version."id"
  `;
}

function memoryFactConversationFeedbackPredicate(
  snapshot: MemoryLocalRetrievalSnapshot
): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemoryFeedback" AS negative_feedback
    INNER JOIN "ModelRun" AS negative_run
      ON negative_run."userId" = negative_feedback."userId"
      AND negative_run."id" = negative_feedback."modelRunId"
    WHERE negative_feedback."userId" = ${snapshot.userId}
      AND negative_feedback."feedbackType" = 'NOT_USEFUL'::"MemoryFeedbackType"
      AND negative_feedback."memoryFactVersionId" = version."id"
      AND negative_feedback."contentPurgedAt" IS NULL
      AND negative_run."chatId" = ${snapshot.chatId}
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryFeedback" AS feedback_retraction
        WHERE feedback_retraction."userId" = negative_feedback."userId"
          AND feedback_retraction."feedbackType" = 'RETRACT'::"MemoryFeedbackType"
          AND feedback_retraction."retractsFeedbackId" = negative_feedback."id"
          AND feedback_retraction."contentPurgedAt" IS NULL
      )
  )`;
}

function memoryChunkConversationFeedbackPredicate(
  snapshot: MemoryLocalRetrievalSnapshot
): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemoryFeedback" AS negative_feedback
    INNER JOIN "ModelRun" AS negative_run
      ON negative_run."userId" = negative_feedback."userId"
      AND negative_run."id" = negative_feedback."modelRunId"
    WHERE negative_feedback."userId" = ${snapshot.userId}
      AND negative_feedback."feedbackType" = 'NOT_USEFUL'::"MemoryFeedbackType"
      AND negative_feedback."recallChunkId" = chunk."id"
      AND negative_feedback."contentPurgedAt" IS NULL
      AND negative_run."chatId" = ${snapshot.chatId}
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryFeedback" AS feedback_retraction
        WHERE feedback_retraction."userId" = negative_feedback."userId"
          AND feedback_retraction."feedbackType" = 'RETRACT'::"MemoryFeedbackType"
          AND feedback_retraction."retractsFeedbackId" = negative_feedback."id"
          AND feedback_retraction."contentPurgedAt" IS NULL
      )
  )`;
}

function memoryRoundConversationFeedbackPredicate(
  snapshot: MemoryLocalRetrievalSnapshot
): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemoryFeedback" AS negative_feedback
    INNER JOIN "ModelRun" AS negative_run
      ON negative_run."userId" = negative_feedback."userId"
      AND negative_run."id" = negative_feedback."modelRunId"
    WHERE negative_feedback."userId" = ${snapshot.userId}
      AND negative_feedback."feedbackType" = 'NOT_USEFUL'::"MemoryFeedbackType"
      AND negative_feedback."recallRoundId" = round."id"
      AND negative_feedback."contentPurgedAt" IS NULL
      AND negative_run."chatId" = ${snapshot.chatId}
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryFeedback" AS feedback_retraction
        WHERE feedback_retraction."userId" = negative_feedback."userId"
          AND feedback_retraction."feedbackType" = 'RETRACT'::"MemoryFeedbackType"
          AND feedback_retraction."retractsFeedbackId" = negative_feedback."id"
          AND feedback_retraction."contentPurgedAt" IS NULL
      )
  )`;
}

function factEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  searchAuthority: "DIRECT" | "INDEXED" = "INDEXED",
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  entryRelation: MemorySearchEntryRelation = "PERSISTED"
): Prisma.Sql {
  if (searchAuthority === "INDEXED" &&
    (!snapshot.activeGenerationId || !snapshot.indexMode)) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  const source = searchAuthority === "INDEXED"
    ? Prisma.sql`
        FROM ${memorySearchEntryRelationSql(entryRelation)}
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = entry."userId" AND settings."useMemoryFacts" = TRUE
          AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
        INNER JOIN "MemoryIndexGeneration" AS generation
          ON generation."userId" = settings."userId"
          AND generation."id" = settings."activeIndexGenerationId"
          AND generation."id" = entry."indexGenerationId"
          AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
          AND generation."chunkingVersion" = ${MEMORY_LEXICAL_CHUNKING_VERSION}
          AND generation."languageProfile" = ${MEMORY_LEXICAL_ANALYSIS_PROFILE}
          AND generation."normalizationVersion" =
            ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
          AND generation."retrievalPipelineVersion" =
            ${expectedGenerationPipeline(snapshot.indexMode!)}
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = entry."userId" AND version."id" = entry."factVersionId"
      `
    : Prisma.sql`
        FROM "MemoryFactVersion" AS version
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = version."userId" AND settings."useMemoryFacts" = TRUE
      `;
  const entryId = searchAuthority === "INDEXED"
    ? Prisma.sql`entry."id"`
    : Prisma.sql`NULL::text`;
  const safeContentHash = searchAuthority === "INDEXED"
    ? Prisma.sql`entry."safeContentHash"`
    : Prisma.sql`NULL::text`;
  const normalizedSearchText = searchAuthority === "INDEXED"
    ? memorySearchEntryNormalizedTextSql(entryRelation)
    : Prisma.sql`version."normalizedSearchText"`;
  const searchVector = searchAuthority === "INDEXED"
    ? memorySearchEntrySimpleVectorSql(entryRelation)
    : Prisma.sql`NULL::tsvector`;
  const indexedEntry = searchAuthority === "INDEXED"
    ? Prisma.sql`AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"`
    : Prisma.sql``;
  return Prisma.sql`
    SELECT DISTINCT ON (candidate."dedupeKey") candidate.*
    FROM (
      SELECT ${factColumns(entryId, Prisma.sql`NULL::text`, safeContentHash)},
        ${normalizedSearchText} AS "normalizedSearchText",
        ${searchVector} AS "searchVectorSimple",
        (fact."id" = root_fact."id") AS "canonicalSource"
      ${source}
    AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryFact" AS root_fact
      ON root_fact."userId" = fact."userId"
      AND root_fact."id" = ${memoryCanonicalFactRootIdSql(
        snapshot.userId,
        Prisma.sql`fact."id"`
      )}
      AND root_fact."state" = 'ACTIVE'::"MemoryFactState"
      AND root_fact."movedToFactId" IS NULL
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "MemoryScope" AS root_scope
      ON root_scope."userId" = root_fact."userId"
      AND root_scope."id" = root_fact."scopeId"
      AND root_scope."state" = 'ACTIVE'::"MemoryScopeState"
    WHERE version."userId" = ${snapshot.userId}
      ${indexedEntry}
      AND (${candidatePredicate})
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
      AND ${factLifecyclePredicate(plan)}
      AND ${memoryFactScopePredicate(snapshot)}
      AND ${memoryReusableFactAuthorityPredicate(snapshot.userId, {
        includePatterns: plan.includePatterns,
        lifecycle: plan.mode === "HISTORICAL_MEMORY"
          ? "CURRENT_OR_HISTORICAL"
          : "CURRENT"
      })}
      AND ${memoryActiveSuppressionPredicate(snapshot.userId)}
      AND ${memoryFactConversationFeedbackPredicate(snapshot)}
      AND ${factPlanPredicates(plan)}
    ) AS candidate
    ORDER BY candidate."dedupeKey", candidate."current" DESC,
      candidate."canonicalSource" DESC,
      candidate."systemFrom" DESC NULLS LAST, candidate."itemId"
  `;
}

function coreSql(snapshot: MemoryLocalRetrievalSnapshot): Prisma.Sql {
  return Prisma.sql`
    SELECT ${factColumns(Prisma.sql`NULL::text`)}, version."displayText" AS "safeText",
      0.0::double precision AS "rawScore"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
      AND fact."state" = 'ACTIVE'::"MemoryFactState" AND fact."currentVersionId" = version."id"
    INNER JOIN "MemoryFact" AS root_fact
      ON root_fact."userId" = fact."userId"
      AND root_fact."id" = ${memoryCanonicalFactRootIdSql(
        snapshot.userId,
        Prisma.sql`fact."id"`
      )}
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "MemoryScope" AS root_scope
      ON root_scope."userId" = root_fact."userId"
      AND root_scope."id" = root_fact."scopeId"
      AND root_scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId" AND settings."useMemoryFacts" = TRUE
    WHERE version."userId" = ${snapshot.userId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState" AND version."systemTo" IS NULL
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND version."modality" = 'PREFERENCE'::"MemoryFactModality"
      AND version."category" = 'preferences'
      AND version."coreEligible" = TRUE
      AND ${memoryFactScopePredicate(snapshot)}
      AND ${memoryPersonalFactEvidencePredicate(snapshot.userId, { exactVNext: true })}
      AND ${memoryActiveSuppressionPredicate(snapshot.userId)}
      AND ${memoryFactConversationFeedbackPredicate(snapshot)}
    ORDER BY fact."pinned" DESC,
      (version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode") DESC,
      CASE version."coreSalience" WHEN 'HIGH'::"MemoryCoreSalience" THEN 0
        WHEN 'MEDIUM'::"MemoryCoreSalience" THEN 1
        WHEN 'LOW'::"MemoryCoreSalience" THEN 2 ELSE 3 END,
      fact."id", version."id"
    LIMIT ${MEMORY_CORE_MAX_FACTS * 2}
  `;
}

function coreReason(row: CoreRow): string {
  if (row.pinned) return "core.pinned";
  if (row.sourceMode === "EXPLICIT") return "core.explicit";
  return `core.${row.coreSalience.toLocaleLowerCase("und")}`;
}

async function loadCore(
  client: PrismaClient,
  snapshot: MemoryLocalRetrievalSnapshot
): Promise<readonly MemoryCoreCandidate[]> {
  if (!snapshot.useMemoryFacts || snapshot.status !== "READY") return [];
  const rows = await withMemoryReadBudget(
    client,
    MEMORY_READ_BUDGET_MS.SNAPSHOT_CORE,
    (tx) => tx.$queryRaw<CoreRow[]>(coreSql(snapshot))
  );
  return rows.flatMap((row): readonly MemoryCoreCandidate[] => {
    const safeText = safeMemoryProjectionText(row.safeText);
    if (!safeText) return [];
    const metadata = decodeMetadata(row);
    const candidate: MemoryRankedCandidate = {
      entryId: null,
      featureSnapshot: {
        authorityRank: metadata.sourceAuthority === "EXPLICIT" ? 3 : 2,
        fusionVersion: MEMORY_RETRIEVAL_FUSION_VERSION,
        laneCount: 0,
        temporalFit: 1,
        tier: "CORE"
      },
      finalScore: 0,
      itemId: row.itemId,
      itemType: "FACT_VERSION",
      laneRanks: {},
      metadata,
      rrfScore: 0,
      selectionReason: coreReason(row)
    };
    return [{
      candidate,
      expansion: {
        itemId: row.itemId,
        itemType: "FACT_VERSION",
        occurredFrom: null,
        occurredTo: null,
        projectionKind: "FACT_DISPLAY_TEXT",
        safeText,
        sourceChatId: null,
        supportingItemId: null
      }
    }];
  });
}

function historyDigestEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  boundedCandidateSourceLookup = false
): Prisma.Sql {
  if (snapshot.historyAuthorityRevision === null) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT NULL::text AS "entryId", chunk."id" AS "itemId",
      digest."contentHash" AS "safeContentHash", NULL::text AS "displayText",
      NULL::jsonb AS "structuredValue",
      NULL::text AS "evidenceRootHash", NULL::text AS "parentChunkId",
      NULL::text AS "matchedSegmentId", NULL::text AS "matchedSegmentPosition",
      'RECALL_CHUNK'::"MemorySearchItemType" AS "itemType", NULL::text AS "factId",
      ('history-overview:' || digest."id")::text AS "dedupeKey",
      NULL::text AS "canonicalKey", NULL::text AS "category", digest."languageCode",
      NULL::text AS "identityKind", NULL::text AS "subjectKey",
      NULL::text AS "predicateKey", NULL::text AS "dimensionKey",
      NULL::text AS "modality", NULL::text AS "sourceMode", NULL::text AS "directness",
      'PAST_CHAT'::text AS "sourceAuthority",
      NULL::text AS "sensitivityClass", digest."safetyClass"::text AS "historySafetyClass",
      NULL::text AS "scopeType", digest."sourceFolderId", digest."sourceAssistantId",
      digest."chatId" AS "sourceChatId", FALSE AS "pinned",
      NULL::text AS "temperatureClass", 0.0::double precision AS "temperatureScore",
      NULL::timestamp AS "lastUsedAt", NULL::timestamp AS "lastConfirmedAt",
      1.0::double precision AS "confidence",
      0.6::double precision AS "importance", FALSE AS "coreEligible",
      'NONE'::text AS "coreSalience",
      CASE WHEN digest."chatId" = ${snapshot.chatId} THEN 1.0
        WHEN digest."sourceAssistantId" = ${snapshot.assistantId}
          AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
        WHEN digest."sourceFolderId" = ${snapshot.folderId}
          AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8 ELSE 0.5
      END::double precision AS "scopeAffinity",
      TRUE AS "current", FALSE AS "historical", FALSE AS "conflict",
      NULL::text AS "lifecycleState", ARRAY[]::text[] AS "entityIds",
      NULL::text AS "matchedEntityRole", 0::integer AS "relationDepth",
      0::integer AS "synthesisDepth",
      NULL::timestamp AS "observedAt", NULL::timestamp AS "occurredAt",
      NULL::timestamp AS "expectedAt", NULL::timestamp AS "expiresAt",
      NULL::timestamp AS "validFrom", NULL::timestamp AS "validTo",
      NULL::timestamp AS "systemFrom", digest."occurredFrom", digest."occurredTo",
      digest."normalizedSafeSearchText" AS "normalizedSearchText",
      to_tsvector('simple', digest."normalizedSafeSearchText") AS "searchVectorSimple"
    FROM "ChatMemoryDigest" AS digest
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = digest."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
    INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = digest."userId" AND chunk."chatId" = digest."chatId"
      AND chunk."id" = digest."anchorChunkId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = digest."userId" AND source_chat."id" = digest."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = digest."userId" AND checkpoint."chatId" = digest."chatId"
    WHERE digest."userId" = ${snapshot.userId}
      AND (${candidatePredicate})
      AND digest."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND digest."pipelineVersion" = ${MEMORY_CHAT_DIGEST_PIPELINE_VERSION}
      AND digest."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND digest."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND digest."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND digest."branchGeneration" = checkpoint."branchGeneration"
      AND digest."sourceRevisionAtCreation" = checkpoint."sourceRevision"
      AND digest."activeLeafMessageId" = checkpoint."activeLeafMessageId"
      AND digest."sourceContentHash" = checkpoint."sourceContentHash"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND chunk."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND chunk."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND ${memoryHistoryChunkSourceAuthorityPredicate({
        boundedCandidateSourceLookup,
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND EXISTS (
        SELECT 1 FROM "ChatMemoryDigestChunk" AS digest_anchor
        WHERE digest_anchor."digestId" = digest."id"
          AND digest_anchor."chunkId" = digest."anchorChunkId"
      )
      AND EXISTS (
        SELECT 1 FROM "ChatMemoryDigestMessage" AS digest_source_message
        WHERE digest_source_message."digestId" = digest."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ChatMemoryDigestChunk" AS digest_source
        LEFT JOIN "MemoryRecallChunk" AS source_chunk
          ON source_chunk."userId" = digest_source."userId"
          AND source_chunk."chatId" = digest_source."chatId"
          AND source_chunk."id" = digest_source."chunkId"
        WHERE digest_source."digestId" = digest."id"
          AND (source_chunk."id" IS NULL
            OR source_chunk."state" <> 'ACTIVE'::"MemoryHistoryItemState"
            OR source_chunk."chunkingVersion" <> ${MEMORY_HISTORY_CHUNKING_VERSION}
            OR source_chunk."sourceProjectionVersion" <>
              ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
            OR source_chunk."safetyClass" NOT IN (
              'NORMAL'::"MemoryDerivedSafetyClass",
              'SENSITIVE'::"MemoryDerivedSafetyClass"
            )
            OR source_chunk."redactionState" = 'EXCLUDED'::"MemoryRedactionState")
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ChatMemoryDigestMessage" AS digest_source_message
        LEFT JOIN "Message" AS current_source_message
          ON current_source_message."chatId" = digest_source_message."chatId"
          AND current_source_message."id" = digest_source_message."messageId"
        WHERE digest_source_message."digestId" = digest."id"
          AND (
            current_source_message."id" IS NULL
            OR current_source_message."updatedAt" <>
              digest_source_message."sourceMessageUpdatedAt"
            OR NOT EXISTS (
              WITH RECURSIVE active_path AS (
                SELECT message."id", message."parentMessageId"
                FROM "Message" AS message
                WHERE message."chatId" = source_chat."id"
                  AND message."id" = source_chat."activeLeafMessageId"
                UNION ALL
                SELECT parent."id", parent."parentMessageId"
                FROM active_path AS child
                INNER JOIN "Message" AS parent
                  ON parent."chatId" = source_chat."id"
                  AND parent."id" = child."parentMessageId"
              )
              SELECT 1 FROM active_path
              WHERE active_path."id" = digest_source_message."messageId"
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ChatMemoryDigestMessage" AS digest_message
        INNER JOIN "MemorySuppression" AS suppression
          ON suppression."userId" = digest_message."userId"
          AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
          AND (suppression."scope" = 'ALL'::"MemorySuppressionScope" OR (
            suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND suppression."sourceChatId" = digest_message."chatId"
            AND suppression."sourceMessageId" = digest_message."messageId"
          ))
        WHERE digest_message."digestId" = digest."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySourceBarrier" AS history_barrier
        WHERE history_barrier."userId" = digest."userId"
          AND history_barrier."kind" IN (
            'HISTORY_INDEX'::"MemorySourceBarrierKind",
            'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
          AND history_barrier."explicitOverrideAllowed" = FALSE
          AND (digest."createdAt" <= history_barrier."createdAt" OR EXISTS (
            SELECT 1 FROM "ChatMemoryDigestMessage" AS barrier_source
            INNER JOIN "Message" AS barrier_message
              ON barrier_message."chatId" = barrier_source."chatId"
              AND barrier_message."id" = barrier_source."messageId"
            WHERE barrier_source."digestId" = digest."id"
              AND barrier_message."createdAt" <= history_barrier."sourceCreatedAtCutoff"
          ))
      )
      AND ${memoryChunkConversationFeedbackPredicate(snapshot)}
      AND ${historyDigestPlanPredicates(plan)}
  `;
}

function historyChunkEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  entryRelation: MemorySearchEntryRelation = "PERSISTED"
): Prisma.Sql {
  if (!snapshot.activeGenerationId || snapshot.historyAuthorityRevision === null) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT entry."id" AS "entryId", chunk."id" AS "itemId",
      entry."safeContentHash", NULL::text AS "displayText",
      NULL::jsonb AS "structuredValue",
      chunk."evidenceRootHash", NULL::text AS "parentChunkId",
      NULL::text AS "matchedSegmentId", NULL::text AS "matchedSegmentPosition",
      'RECALL_CHUNK'::"MemorySearchItemType" AS "itemType", NULL::text AS "factId",
      ('history:' || entry."safeContentHash")::text AS "dedupeKey",
      NULL::text AS "canonicalKey", NULL::text AS "category", chunk."languageCode",
      NULL::text AS "identityKind", NULL::text AS "subjectKey",
      NULL::text AS "predicateKey", NULL::text AS "dimensionKey",
      NULL::text AS "modality", NULL::text AS "sourceMode", NULL::text AS "directness",
      'PAST_CHAT'::text AS "sourceAuthority",
      NULL::text AS "sensitivityClass", chunk."safetyClass"::text AS "historySafetyClass",
      NULL::text AS "scopeType", chunk."sourceFolderId", chunk."sourceAssistantId",
      chunk."chatId" AS "sourceChatId", FALSE AS "pinned", NULL::text AS "temperatureClass",
      0.0::double precision AS "temperatureScore",
      NULL::timestamp AS "lastUsedAt", NULL::timestamp AS "lastConfirmedAt",
      1.0::double precision AS "confidence", 0.5::double precision AS "importance",
      FALSE AS "coreEligible", 'NONE'::text AS "coreSalience",
      CASE WHEN chunk."chatId" = ${snapshot.chatId} THEN 1.0
        WHEN chunk."sourceAssistantId" = ${snapshot.assistantId}
          AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
        WHEN chunk."sourceFolderId" = ${snapshot.folderId}
          AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8 ELSE 0.5
      END::double precision AS "scopeAffinity",
      TRUE AS "current", FALSE AS "historical", FALSE AS "conflict",
      NULL::text AS "lifecycleState", ARRAY[]::text[] AS "entityIds",
      NULL::text AS "matchedEntityRole", 0::integer AS "relationDepth",
      0::integer AS "synthesisDepth",
      NULL::timestamp AS "observedAt", NULL::timestamp AS "occurredAt",
      NULL::timestamp AS "expectedAt", NULL::timestamp AS "expiresAt",
      NULL::timestamp AS "validFrom", NULL::timestamp AS "validTo",
      NULL::timestamp AS "systemFrom", chunk."occurredFrom", chunk."occurredTo",
      ${memorySearchEntryNormalizedTextSql(entryRelation)} AS
        "normalizedSearchText",
      ${memorySearchEntrySimpleVectorSql(entryRelation)} AS "searchVectorSimple"
    FROM ${memorySearchEntryRelationSql(entryRelation)}
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId" AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND generation."chunkingVersion" = ${MEMORY_LEXICAL_CHUNKING_VERSION}
      AND generation."languageProfile" = ${MEMORY_LEXICAL_ANALYSIS_PROFILE}
      AND generation."normalizationVersion" = ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
      AND generation."retrievalPipelineVersion" =
        ${expectedGenerationPipeline(snapshot.indexMode!)}
    INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = entry."userId" AND chunk."id" = entry."recallChunkId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = chunk."userId" AND source_chat."id" = chunk."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId" AND checkpoint."chatId" = chunk."chatId"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND (${candidatePredicate})
      AND entry."safeContentHash" = chunk."contentHash"
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND chunk."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND chunk."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass",
        'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."projectId" IS NULL
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND ${memoryHistoryChunkSourceAuthorityPredicate({
        boundedCandidateSourceLookup: entryRelation === "BOUNDED_CANDIDATES",
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryChunkConversationFeedbackPredicate(snapshot)}
      AND ${memoryChunkSourceSafetyPredicate()}
      AND ${historyPlanPredicates(plan)}
  `;
}

function historyLegacyRoundEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  entryRelation: MemorySearchEntryRelation = "PERSISTED"
): Prisma.Sql {
  if (!snapshot.activeGenerationId || snapshot.historyAuthorityRevision === null) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT entry."id" AS "entryId", round."id" AS "itemId",
      entry."safeContentHash", NULL::text AS "displayText",
      NULL::jsonb AS "structuredValue", round."evidenceRootHash",
      round."parentChunkId", NULL::text AS "matchedSegmentId",
      NULL::text AS "matchedSegmentPosition",
      'RECALL_ROUND'::"MemorySearchItemType" AS "itemType", NULL::text AS "factId",
      ('history:' || round."evidenceRootHash")::text AS "dedupeKey",
      NULL::text AS "canonicalKey", NULL::text AS "category", round."languageCode",
      NULL::text AS "identityKind", NULL::text AS "subjectKey",
      NULL::text AS "predicateKey", NULL::text AS "dimensionKey",
      NULL::text AS "modality", NULL::text AS "sourceMode", NULL::text AS "directness",
      'PAST_CHAT'::text AS "sourceAuthority",
      NULL::text AS "sensitivityClass", round."safetyClass"::text AS "historySafetyClass",
      NULL::text AS "scopeType", round."sourceFolderId", round."sourceAssistantId",
      round."chatId" AS "sourceChatId", FALSE AS "pinned",
      NULL::text AS "temperatureClass", 0.0::double precision AS "temperatureScore",
      NULL::timestamp AS "lastUsedAt", NULL::timestamp AS "lastConfirmedAt",
      1.0::double precision AS "confidence", 0.5::double precision AS "importance",
      FALSE AS "coreEligible", 'NONE'::text AS "coreSalience",
      CASE WHEN round."chatId" = ${snapshot.chatId} THEN 1.0
        WHEN round."sourceAssistantId" = ${snapshot.assistantId}
          AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
        WHEN round."sourceFolderId" = ${snapshot.folderId}
          AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8 ELSE 0.5
      END::double precision AS "scopeAffinity",
      TRUE AS "current", FALSE AS "historical", FALSE AS "conflict",
      NULL::text AS "lifecycleState", ARRAY[]::text[] AS "entityIds",
      NULL::text AS "matchedEntityRole", 0::integer AS "relationDepth",
      0::integer AS "synthesisDepth",
      NULL::timestamp AS "observedAt", NULL::timestamp AS "occurredAt",
      NULL::timestamp AS "expectedAt", NULL::timestamp AS "expiresAt",
      NULL::timestamp AS "validFrom", NULL::timestamp AS "validTo",
      NULL::timestamp AS "systemFrom", round."occurredFrom", round."occurredTo",
      ${memorySearchEntryNormalizedTextSql(entryRelation)} AS
        "normalizedSearchText",
      ${memorySearchEntrySimpleVectorSql(entryRelation)} AS "searchVectorSimple"
    FROM ${memorySearchEntryRelationSql(entryRelation)}
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND generation."chunkingVersion" = ${MEMORY_LEXICAL_CHUNKING_VERSION}
      AND generation."languageProfile" = ${MEMORY_LEXICAL_ANALYSIS_PROFILE}
      AND generation."normalizationVersion" = ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
      AND generation."retrievalPipelineVersion" =
        ${expectedGenerationPipeline(snapshot.indexMode!)}
      AND generation."roundProjectionVersion" =
        ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND generation."contextualKeyPolicyVersion" =
        ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND generation."roundSegmentProjectionVersion" IS NULL
    INNER JOIN "MemoryRecallRound" AS round
      ON round."userId" = entry."userId" AND round."id" = entry."recallRoundId"
    INNER JOIN "MemoryRecallChunk" AS parent_chunk
      ON parent_chunk."userId" = round."userId"
      AND parent_chunk."id" = round."parentChunkId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = round."userId" AND source_chat."id" = round."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = round."userId" AND checkpoint."chatId" = round."chatId"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND (${candidatePredicate})
      AND entry."safeContentHash" = round."contextualSearchHash"
      AND round."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND round."projectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND round."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND round."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND round."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND round."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND parent_chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND parent_chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND parent_chunk."sourceProjectionVersion" =
        ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."projectId" IS NULL
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND ${memoryHistoryRoundSourceAuthorityPredicate({
        boundedCandidateSourceLookup: entryRelation === "BOUNDED_CANDIDATES",
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryRoundConversationFeedbackPredicate(snapshot)}
      AND ${memoryRoundSourceSafetyPredicate()}
      AND ${historyRoundPlanPredicates(plan)}
  `;
}

function historySegmentRoundEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  entryRelation: MemorySearchEntryRelation = "PERSISTED"
): Prisma.Sql {
  if (!snapshot.activeGenerationId || snapshot.historyAuthorityRevision === null) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT entry."id" AS "entryId", round."id" AS "itemId",
      entry."safeContentHash", NULL::text AS "displayText",
      NULL::jsonb AS "structuredValue", segment."evidenceRootHash",
      round."parentChunkId", segment."id" AS "matchedSegmentId",
      segment."position" AS "matchedSegmentPosition",
      'RECALL_ROUND'::"MemorySearchItemType" AS "itemType", NULL::text AS "factId",
      ('history:' || segment."evidenceRootHash")::text AS "dedupeKey",
      NULL::text AS "canonicalKey", NULL::text AS "category", segment."languageCode",
      NULL::text AS "identityKind", NULL::text AS "subjectKey",
      NULL::text AS "predicateKey", NULL::text AS "dimensionKey",
      NULL::text AS "modality", NULL::text AS "sourceMode", NULL::text AS "directness",
      'PAST_CHAT'::text AS "sourceAuthority",
      NULL::text AS "sensitivityClass", segment."safetyClass"::text AS "historySafetyClass",
      NULL::text AS "scopeType", round."sourceFolderId", round."sourceAssistantId",
      round."chatId" AS "sourceChatId", FALSE AS "pinned",
      NULL::text AS "temperatureClass", 0.0::double precision AS "temperatureScore",
      NULL::timestamp AS "lastUsedAt", NULL::timestamp AS "lastConfirmedAt",
      1.0::double precision AS "confidence", 0.5::double precision AS "importance",
      FALSE AS "coreEligible", 'NONE'::text AS "coreSalience",
      CASE WHEN round."chatId" = ${snapshot.chatId} THEN 1.0
        WHEN round."sourceAssistantId" = ${snapshot.assistantId}
          AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
        WHEN round."sourceFolderId" = ${snapshot.folderId}
          AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8 ELSE 0.5
      END::double precision AS "scopeAffinity",
      TRUE AS "current", FALSE AS "historical", FALSE AS "conflict",
      NULL::text AS "lifecycleState", ARRAY[]::text[] AS "entityIds",
      NULL::text AS "matchedEntityRole", 0::integer AS "relationDepth",
      0::integer AS "synthesisDepth",
      NULL::timestamp AS "observedAt", NULL::timestamp AS "occurredAt",
      NULL::timestamp AS "expectedAt", NULL::timestamp AS "expiresAt",
      NULL::timestamp AS "validFrom", NULL::timestamp AS "validTo",
      NULL::timestamp AS "systemFrom", segment."occurredFrom", segment."occurredTo",
      ${memorySearchEntryNormalizedTextSql(entryRelation)} AS
        "normalizedSearchText",
      ${memorySearchEntrySimpleVectorSql(entryRelation)} AS "searchVectorSimple"
    FROM ${memorySearchEntryRelationSql(entryRelation)}
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND generation."chunkingVersion" = ${MEMORY_LEXICAL_CHUNKING_VERSION}
      AND generation."languageProfile" = ${MEMORY_LEXICAL_ANALYSIS_PROFILE}
      AND generation."normalizationVersion" = ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
      AND generation."retrievalPipelineVersion" =
        ${expectedGenerationPipeline(snapshot.indexMode!)}
      AND generation."roundProjectionVersion" =
        ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND generation."contextualKeyPolicyVersion" =
        ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND generation."roundSegmentProjectionVersion" =
        ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
    INNER JOIN "MemoryRecallRoundSegment" AS segment
      ON segment."userId" = entry."userId"
      AND segment."id" = entry."recallRoundSegmentId"
      AND segment."roundId" = entry."recallRoundId"
    INNER JOIN "MemoryRecallRound" AS round
      ON round."userId" = segment."userId" AND round."id" = segment."roundId"
    INNER JOIN "MemoryRecallChunk" AS parent_chunk
      ON parent_chunk."userId" = round."userId"
      AND parent_chunk."id" = round."parentChunkId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = round."userId" AND source_chat."id" = round."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = round."userId" AND checkpoint."chatId" = round."chatId"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
      AND (${candidatePredicate})
      AND entry."safeContentHash" = segment."contextualSearchHash"
      AND segment."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND segment."projectionVersion" =
        ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
      AND segment."contextualKeyPolicyVersion" =
        ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND segment."evidenceRootHash" = round."evidenceRootHash"
      AND segment."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND segment."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND round."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND round."projectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND round."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND round."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND round."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND round."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND parent_chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND parent_chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND parent_chunk."sourceProjectionVersion" =
        ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."projectId" IS NULL
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND ${memoryHistoryRoundSourceAuthorityPredicate({
        boundedCandidateSourceLookup: entryRelation === "BOUNDED_CANDIDATES",
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryRoundConversationFeedbackPredicate(snapshot)}
      AND ${memoryRoundSourceSafetyPredicate()}
      AND ${historyRoundPlanPredicates(plan)}
  `;
}

function historyRoundEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  entryRelation: MemorySearchEntryRelation = "PERSISTED"
): Prisma.Sql {
  return snapshot.roundSegmentProjectionVersion ===
    MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION
    ? historySegmentRoundEligibleSelect(snapshot, plan, candidatePredicate, entryRelation)
    : historyLegacyRoundEligibleSelect(snapshot, plan, candidatePredicate, entryRelation);
}

function toolEventEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  entryRelation: MemorySearchEntryRelation = "PERSISTED"
): Prisma.Sql {
  if (!snapshot.activeGenerationId || snapshot.historyAuthorityRevision === null) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT entry."id" AS "entryId", tool_event."id" AS "itemId",
      entry."safeContentHash", NULL::text AS "displayText",
      NULL::jsonb AS "structuredValue", tool_event."evidenceRootHash",
      NULL::text AS "parentChunkId", NULL::text AS "matchedSegmentId",
      NULL::text AS "matchedSegmentPosition",
      'TOOL_EVENT'::"MemorySearchItemType" AS "itemType", NULL::text AS "factId",
      ('tool-event:' || tool_event."evidenceRootHash")::text AS "dedupeKey",
      NULL::text AS "canonicalKey", NULL::text AS "category",
      tool_event."languageCode", NULL::text AS "identityKind",
      NULL::text AS "subjectKey", NULL::text AS "predicateKey",
      NULL::text AS "dimensionKey", 'EVENT'::text AS "modality",
      NULL::text AS "sourceMode", NULL::text AS "directness",
      'TOOL_OBSERVATION'::text AS "sourceAuthority",
      NULL::text AS "sensitivityClass",
      tool_event."safetyClass"::text AS "historySafetyClass",
      NULL::text AS "scopeType", tool_event."sourceFolderId",
      tool_event."sourceAssistantId", tool_event."chatId" AS "sourceChatId",
      FALSE AS "pinned", NULL::text AS "temperatureClass",
      0.0::double precision AS "temperatureScore",
      NULL::timestamp AS "lastUsedAt", NULL::timestamp AS "lastConfirmedAt",
      1.0::double precision AS "confidence", 0.45::double precision AS "importance",
      FALSE AS "coreEligible", 'NONE'::text AS "coreSalience",
      CASE WHEN tool_event."chatId" = ${snapshot.chatId} THEN 1.0
        WHEN tool_event."sourceAssistantId" = ${snapshot.assistantId}
          AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
        WHEN tool_event."sourceFolderId" = ${snapshot.folderId}
          AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8 ELSE 0.5
      END::double precision AS "scopeAffinity",
      TRUE AS "current", FALSE AS "historical", FALSE AS "conflict",
      NULL::text AS "lifecycleState", ARRAY[]::text[] AS "entityIds",
      NULL::text AS "matchedEntityRole", 0::integer AS "relationDepth",
      0::integer AS "synthesisDepth", tool_event."occurredAt" AS "observedAt",
      tool_event."occurredAt", NULL::timestamp AS "expectedAt",
      NULL::timestamp AS "expiresAt", NULL::timestamp AS "validFrom",
      NULL::timestamp AS "validTo", NULL::timestamp AS "systemFrom",
      tool_event."occurredAt" AS "occurredFrom",
      tool_event."occurredAt" AS "occurredTo",
      ${memorySearchEntryNormalizedTextSql(entryRelation)} AS
        "normalizedSearchText",
      ${memorySearchEntrySimpleVectorSql(entryRelation)} AS "searchVectorSimple"
    FROM ${memorySearchEntryRelationSql(entryRelation)}
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND generation."chunkingVersion" = ${MEMORY_LEXICAL_CHUNKING_VERSION}
      AND generation."languageProfile" = ${MEMORY_LEXICAL_ANALYSIS_PROFILE}
      AND generation."normalizationVersion" = ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
      AND generation."retrievalPipelineVersion" =
        ${expectedGenerationPipeline(snapshot.indexMode!)}
    INNER JOIN "MemoryToolEvent" AS tool_event
      ON tool_event."userId" = entry."userId"
      AND tool_event."id" = entry."toolEventId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = tool_event."userId"
      AND source_chat."id" = tool_event."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = tool_event."userId"
      AND checkpoint."chatId" = tool_event."chatId"
    INNER JOIN "ChatMemoryCheckpointMessage" AS checkpoint_message
      ON checkpoint_message."userId" = tool_event."userId"
      AND checkpoint_message."chatId" = tool_event."chatId"
      AND checkpoint_message."messageId" = tool_event."assistantMessageId"
    INNER JOIN "Message" AS source_message
      ON source_message."chatId" = tool_event."chatId"
      AND source_message."id" = tool_event."assistantMessageId"
      AND source_message."updatedAt" = checkpoint_message."sourceMessageUpdatedAt"
    INNER JOIN "ModelRun" AS source_run
      ON source_run."userId" = tool_event."userId"
      AND source_run."id" = tool_event."modelRunId"
      AND source_run."chatId" = tool_event."chatId"
      AND source_run."assistantMessageId" = tool_event."assistantMessageId"
      AND source_run."status" = 'complete'::"ModelRunStatus"
    INNER JOIN "ModelRunToolCall" AS source_call
      ON source_call."modelRunId" = tool_event."modelRunId"
      AND source_call."id" = tool_event."modelRunToolCallId"
      AND source_call."state" IN (
        'complete'::"ModelRunToolCallState", 'error'::"ModelRunToolCallState"
      )
      AND source_call."completedAt" = tool_event."occurredAt"
      AND source_call."updatedAt" = tool_event."sourceCallUpdatedAtAtCreation"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
      AND (${candidatePredicate})
      AND entry."safeContentHash" = tool_event."contentHash"
      AND tool_event."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND tool_event."projectionVersion" = ${MEMORY_TOOL_EVENT_PROJECTION_VERSION}
      AND tool_event."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND tool_event."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."projectId" IS NULL
      AND source_chat."permanentDeletionAt" IS NULL
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND checkpoint."branchGeneration" = tool_event."branchGeneration"
      AND checkpoint."sourceRevision" = tool_event."sourceRevisionAtCreation"
      AND checkpoint."lastIndexedMessageId" = checkpoint."activeLeafMessageId"
      AND (
        checkpoint."sourceRevision" = source_chat."memorySourceRevision"
        AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
        OR EXISTS (
          SELECT 1 FROM "Message" AS paused_leaf
          INNER JOIN "MemoryPauseInterval" AS pause_interval
            ON pause_interval."userId" = source_chat."userId"
            AND pause_interval."scope" IN (
              'MASTER'::"MemoryPauseScope", 'SEARCH_HISTORY'::"MemoryPauseScope"
            )
            AND paused_leaf."createdAt" >= pause_interval."pausedAt"
            AND (pause_interval."resumedAt" IS NULL
              OR paused_leaf."createdAt" <= pause_interval."resumedAt")
          WHERE paused_leaf."chatId" = source_chat."id"
            AND paused_leaf."id" = source_chat."activeLeafMessageId"
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySuppression" AS suppression
        WHERE suppression."userId" = tool_event."userId"
          AND (suppression."expiresAt" IS NULL
            OR suppression."expiresAt" > CURRENT_TIMESTAMP)
          AND (suppression."scope" = 'ALL'::"MemorySuppressionScope" OR (
            suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND suppression."sourceChatId" = tool_event."chatId"
            AND suppression."sourceMessageId" = tool_event."assistantMessageId"
          ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = tool_event."userId"
          AND barrier."kind" IN (
            'HISTORY_INDEX'::"MemorySourceBarrierKind",
            'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
          AND barrier."explicitOverrideAllowed" = FALSE
          AND source_message."createdAt" <= barrier."sourceCreatedAtCutoff"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryPauseInterval" AS source_pause
        WHERE source_pause."userId" = tool_event."userId"
          AND source_pause."scope" IN (
            'MASTER'::"MemoryPauseScope", 'SEARCH_HISTORY'::"MemoryPauseScope"
          )
          AND source_message."createdAt" >= source_pause."pausedAt"
          AND (source_pause."resumedAt" IS NULL
            OR source_message."createdAt" <= source_pause."resumedAt")
      )
      AND ${toolEventPlanPredicates(plan)}
  `;
}

function historyEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  candidatePredicate: Prisma.Sql = Prisma.sql`TRUE`,
  sourceChatIds?: readonly string[],
  entryRelation: MemorySearchEntryRelation = "PERSISTED"
): Prisma.Sql {
  if (sourceChatIds && (
    sourceChatIds.length < 1 ||
    sourceChatIds.length > MEMORY_RETRIEVAL_COMPLEX_DIGEST_CHATS ||
    new Set(sourceChatIds).size !== sourceChatIds.length ||
    sourceChatIds.some((sourceChatId) => !validToken(sourceChatId))
  )) throw new Error("memory_retrieval_source_chat_filter_invalid");
  if (plan.mode === "HISTORY_OVERVIEW") {
    if (sourceChatIds) throw new Error("memory_retrieval_source_chat_filter_invalid");
    return historyDigestEligibleSelect(snapshot, plan);
  }
  const boundedCandidatePredicate = sourceChatIds
    ? Prisma.sql`(${candidatePredicate}) AND source_chat."id" IN (${valuesSql(
        sourceChatIds
      )})`
    : candidatePredicate;
  const projection = Prisma.sql`
    SELECT * FROM (${historyChunkEligibleSelect(
      snapshot,
      plan,
      boundedCandidatePredicate,
      entryRelation
    )} UNION ALL ${historyRoundEligibleSelect(
      snapshot,
      plan,
      boundedCandidatePredicate,
      entryRelation
    )} UNION ALL ${toolEventEligibleSelect(
      snapshot,
      plan,
      boundedCandidatePredicate,
      entryRelation
    )}) AS history_projection
  `;
  return sourceChatIds
    ? Prisma.sql`
        SELECT * FROM (${projection}) AS source_filtered_history
        WHERE source_filtered_history."sourceChatId" IN (${valuesSql(sourceChatIds)})
      `
    : projection;
}

type MemoryTemporalSqlConstraint = Readonly<{
  confidence: "HIGH" | "MEDIUM";
  from: Date | null;
  to: Date | null;
}>;

function temporalSqlConstraints(
  plan: MemoryRetrievalPlan
): readonly MemoryTemporalSqlConstraint[] {
  const constraints: MemoryTemporalSqlConstraint[] = [];
  if (plan.temporalQuery.state === "MATCHED" &&
    plan.temporalQuery.confidence && plan.temporalQuery.interval) {
    constraints.push({
      confidence: plan.temporalQuery.confidence,
      from: plan.temporalQuery.interval.from,
      to: plan.temporalQuery.interval.to
    });
  }
  if (plan.filters.asOf) {
    const toMs = plan.filters.asOf.getTime() + 1;
    const to = new Date(toMs);
    if (Number.isFinite(to.getTime())) {
      constraints.push({
        confidence: "HIGH",
        from: plan.filters.asOf,
        to
      });
    }
  } else if (plan.filters.from || plan.filters.to) {
    constraints.push({
      confidence: "HIGH",
      from: plan.filters.from,
      to: plan.filters.to
    });
  }
  const seen = new Set<string>();
  return constraints.filter((constraint) => {
    const key = `${constraint.from?.getTime() ?? "open"}:` +
      `${constraint.to?.getTime() ?? "open"}:${constraint.confidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 2);
}

function temporalOverlapPredicate(
  start: Prisma.Sql,
  end: Prisma.Sql,
  constraint: MemoryTemporalSqlConstraint
): Prisma.Sql {
  const from = constraint.from
    ? Prisma.sql`(${end} > ${constraint.from} OR (
        ${end} = ${start} AND ${start} >= ${constraint.from}
      ))`
    : Prisma.sql`TRUE`;
  const to = constraint.to
    ? Prisma.sql`${start} < ${constraint.to}`
    : Prisma.sql`TRUE`;
  return Prisma.sql`(${from} AND ${to})`;
}

function anyTemporalOverlapPredicate(
  start: Prisma.Sql,
  end: Prisma.Sql,
  constraints: readonly MemoryTemporalSqlConstraint[]
): Prisma.Sql {
  if (constraints.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(
    constraints.map((constraint) => temporalOverlapPredicate(start, end, constraint)),
    " OR "
  )})`;
}

function temporalSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  limit: number,
  unrestricted: boolean,
  sourceChatIds?: readonly string[]
): Prisma.Sql {
  const constraints = temporalSqlConstraints(plan);
  if (constraints.length === 0) throw new Error("memory_retrieval_lane_invalid");
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(snapshot, plan, "DIRECT")
    : historyEligibleSelect(snapshot, plan, Prisma.sql`TRUE`, sourceChatIds);
  const start = itemType === "FACT_VERSION"
    ? Prisma.sql`COALESCE(
        eligible."occurredAt", eligible."expectedAt", eligible."validFrom",
        eligible."observedAt", eligible."systemFrom"
      )`
    : Prisma.sql`eligible."occurredFrom"`;
  const end = itemType === "FACT_VERSION"
    ? Prisma.sql`CASE
        WHEN eligible."occurredAt" IS NOT NULL OR eligible."expectedAt" IS NOT NULL
          THEN ${start}
        ELSE COALESCE(eligible."validTo", ${start})
      END`
    : Prisma.sql`COALESCE(eligible."occurredTo", ${start})`;
  const match = anyTemporalOverlapPredicate(start, end, constraints);
  const highConfidenceMatch = anyTemporalOverlapPredicate(
    start,
    end,
    constraints.filter(({ confidence }) => confidence === "HIGH")
  );
  const hardFilter = unrestricted || !constraints.some(({ confidence }) =>
    confidence === "HIGH")
    ? Prisma.sql`TRUE`
    : highConfidenceMatch;
  const score = unrestricted
    ? Prisma.sql`0.0`
    : Prisma.sql`CASE WHEN ${match} THEN 1.0 ELSE 0.0 END`;
  const order = unrestricted
    ? Prisma.sql`${start} DESC, eligible."itemId"`
    : Prisma.sql`${score} DESC, ${start} DESC, eligible."itemId"`;
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    SELECT ${candidateColumns(score)} FROM eligible
    WHERE ${start} IS NOT NULL AND ${hardFilter}
    ORDER BY ${order}
    LIMIT ${limit}
  `;
}

function candidateColumns(
  rawScore: Prisma.Sql,
  matchedEntityRole: Prisma.Sql = Prisma.sql`eligible."matchedEntityRole"`,
  deterministicMatch: Prisma.Sql = Prisma.sql`NULL::text`
): Prisma.Sql {
  return Prisma.sql`
    eligible."entryId", eligible."itemId", eligible."itemType", eligible."factId",
    eligible."safeContentHash", eligible."displayText", eligible."structuredValue",
    eligible."evidenceRootHash", eligible."parentChunkId",
    eligible."matchedSegmentId", eligible."matchedSegmentPosition",
    eligible."dedupeKey", eligible."canonicalKey", eligible."category", eligible."languageCode",
    eligible."identityKind", eligible."subjectKey", eligible."predicateKey",
    eligible."dimensionKey", eligible."entityIds", ${matchedEntityRole} AS "matchedEntityRole",
    eligible."modality", eligible."sourceMode", eligible."directness",
    eligible."sourceAuthority", eligible."lifecycleState",
    eligible."sensitivityClass", eligible."historySafetyClass", eligible."scopeType",
    eligible."sourceFolderId", eligible."sourceAssistantId", eligible."sourceChatId",
    eligible."pinned", eligible."temperatureClass", eligible."temperatureScore",
    eligible."lastUsedAt", eligible."lastConfirmedAt",
    eligible."confidence", eligible."importance",
    eligible."coreEligible", eligible."coreSalience", eligible."scopeAffinity",
    eligible."current", eligible."historical", eligible."conflict",
    eligible."observedAt", eligible."occurredAt", eligible."expectedAt", eligible."expiresAt",
    eligible."relationDepth", eligible."synthesisDepth",
    eligible."validFrom", eligible."validTo", eligible."systemFrom",
    eligible."occurredFrom", eligible."occurredTo", ${rawScore}::double precision AS "rawScore",
    ${deterministicMatch} AS "deterministicMatch"
  `;
}

function historySearchEntryItemTypePredicate(): Prisma.Sql {
  return Prisma.sql`entry."itemType" IN (
    'RECALL_CHUNK'::"MemorySearchItemType",
    'RECALL_ROUND'::"MemorySearchItemType",
    'RECALL_ROUND_SEGMENT'::"MemorySearchItemType",
    'TOOL_EVENT'::"MemorySearchItemType"
  )`;
}

function historySearchEntrySourcePredicate(
  sourceChatIds?: readonly string[]
): Prisma.Sql {
  if (!sourceChatIds) return Prisma.sql`TRUE`;
  return Prisma.sql`(
    (entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType" AND EXISTS (
      SELECT 1 FROM "MemoryRecallChunk" AS candidate_chunk
      WHERE candidate_chunk."userId" = entry."userId"
        AND candidate_chunk."id" = entry."recallChunkId"
        AND candidate_chunk."chatId" IN (${valuesSql(sourceChatIds)})
    )) OR
    (entry."itemType" IN (
      'RECALL_ROUND'::"MemorySearchItemType",
      'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
    ) AND EXISTS (
      SELECT 1 FROM "MemoryRecallRound" AS candidate_round
      WHERE candidate_round."userId" = entry."userId"
        AND candidate_round."id" = entry."recallRoundId"
        AND candidate_round."chatId" IN (${valuesSql(sourceChatIds)})
    )) OR
    (entry."itemType" = 'TOOL_EVENT'::"MemorySearchItemType" AND EXISTS (
      SELECT 1 FROM "MemoryToolEvent" AS candidate_tool_event
      WHERE candidate_tool_event."userId" = entry."userId"
        AND candidate_tool_event."id" = entry."toolEventId"
        AND candidate_tool_event."chatId" IN (${valuesSql(sourceChatIds)})
    ))
  )`;
}

function exactSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  limit: number,
  sourceChatIds?: readonly string[]
): Prisma.Sql {
  const exactResult = Prisma.sql`
    SELECT ${candidateColumns(
      Prisma.sql`1.0`,
      Prisma.sql`eligible."matchedEntityRole"`,
      Prisma.sql`'EXACT_TEXT'::text`
    )} FROM eligible
    WHERE eligible."normalizedSearchText" = ${plan.normalizedExactQuery}
    ORDER BY eligible."itemId" LIMIT ${limit}
  `;
  if (itemType === "FACT_VERSION") {
    const eligible = factEligibleSelect(
      snapshot,
      plan,
      "DIRECT",
      Prisma.sql`version."normalizedSearchText" = ${plan.normalizedExactQuery}`
    );
    return Prisma.sql`
      WITH eligible AS MATERIALIZED (${eligible})
      ${exactResult}
    `;
  }
  if (!snapshot.activeGenerationId) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  const eligible = historyEligibleSelect(
    snapshot,
    plan,
    Prisma.sql`TRUE`,
    sourceChatIds,
    "BOUNDED_CANDIDATES"
  );
  return Prisma.sql`
    WITH candidate_entries AS MATERIALIZED (
      SELECT ${boundedMemorySearchEntryColumnsSql()}
      FROM "MemorySearchEntry" AS entry
      WHERE entry."userId" = ${snapshot.userId}
        AND entry."indexGenerationId" = ${snapshot.activeGenerationId}
        AND ${historySearchEntryItemTypePredicate()}
        AND entry."normalizedSearchText" = ${plan.normalizedExactQuery}
        AND ${historySearchEntrySourcePredicate(sourceChatIds)}
      ORDER BY entry."id"
      LIMIT ${MEMORY_EXACT_AUTHORITY_PREFILTER_MAX_CANDIDATES}
    ),
    eligible AS MATERIALIZED (${eligible})
    ${exactResult}
  `;
}

function entityQueryTerms(query: string): readonly string[] {
  const words = query.normalize("NFKC")
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, 32) ?? [];
  const values = new Set<string>();
  const whole = normalizeMemoryEntityAlias(query);
  if (whole) values.add(whole);
  for (let start = 0; start < words.length; start += 1) {
    for (let width = 1; width <= 5 && start + width <= words.length; width += 1) {
      const normalized = normalizeMemoryEntityAlias(
        words.slice(start, start + width).join(" ")
      );
      if (normalized && normalized.length >= 2) values.add(normalized);
      if (values.size >= 64) return [...values];
    }
  }
  return [...values];
}

function plannedEntityTerms(plan: MemoryRetrievalPlan): Readonly<{
  hinted: readonly string[];
  terms: readonly string[];
}> {
  const hinted = [...new Set(plan.entityMentions
    .map((mention) => normalizeMemoryEntityAlias(mention.text))
    .filter((term): term is string => term !== null))];
  return {
    hinted,
    terms: [...new Set([
      ...plan.semanticQueryVariants.flatMap(({ text }) => entityQueryTerms(text)),
      ...hinted
    ])]
  };
}

function entitySql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  limit: number
): Prisma.Sql {
  const { hinted: hintedTerms, terms } = plannedEntityTerms(plan);
  if (terms.length === 0) throw new Error("memory_retrieval_lane_invalid");
  const exactHint = hintedTerms.length > 0
    ? Prisma.sql`alias."normalizedAlias" IN (${Prisma.join(hintedTerms)})`
    : Prisma.sql`FALSE`;
  return Prisma.sql`
    WITH RECURSIVE
    matched_alias_entities AS MATERIALIZED (
      SELECT DISTINCT alias."entityId", alias."normalizedAlias",
        ${exactHint} AS "exactHint"
      FROM "MemoryEntityAlias" AS alias
      WHERE alias."userId" = ${snapshot.userId}
        AND alias."normalizedAlias" IN (${Prisma.join(terms)})
        AND ${memoryAdmissibleEntityAliasPredicate(snapshot.userId)}
    ),
    matched_roots AS MATERIALIZED (
      SELECT DISTINCT matched."normalizedAlias", matched."exactHint",
        aiqsa_memory_entity_root_id(
        ${snapshot.userId}, matched."entityId"
      ) AS "rootId"
      FROM matched_alias_entities AS matched
      WHERE aiqsa_memory_entity_root_id(
        ${snapshot.userId}, matched."entityId"
      ) IS NOT NULL
    ),
    unambiguous_exact_roots AS MATERIALIZED (
      SELECT MIN(matched."rootId") AS "rootId"
      FROM matched_roots AS matched
      WHERE matched."exactHint"
      GROUP BY matched."normalizedAlias"
      HAVING COUNT(DISTINCT matched."rootId") = 1
    ),
    root_members AS (
      SELECT DISTINCT matched."rootId", matched."rootId" AS "entityId",
        ARRAY[matched."rootId"]::text[] AS visited, FALSE AS cycle
      FROM matched_roots AS matched

      UNION ALL

      SELECT members."rootId", child."id", members.visited || child."id",
        child."id" = ANY(members.visited)
      FROM root_members AS members
      INNER JOIN "MemoryEntity" AS child
        ON child."userId" = ${snapshot.userId}
        AND child."mergedIntoId" = members."entityId"
      WHERE NOT members.cycle
    ),
    linked AS MATERIALIZED (
      SELECT link."factVersionId", MAX(CASE link."role"
        WHEN 'SUBJECT'::"MemoryEntityLinkRole" THEN 1.0
        WHEN 'OBJECT'::"MemoryEntityLinkRole" THEN 0.85
        ELSE 0.7 END)::double precision AS score,
        (ARRAY_AGG(link."role"::text ORDER BY CASE link."role"
          WHEN 'SUBJECT'::"MemoryEntityLinkRole" THEN 0
          WHEN 'OBJECT'::"MemoryEntityLinkRole" THEN 1 ELSE 2 END,
          link."role"::text))[1] AS role,
        BOOL_OR(exact_root."rootId" IS NOT NULL) AS "deterministic"
      FROM "MemoryFactVersionEntity" AS link
      INNER JOIN root_members AS member
        ON member."entityId" = link."entityId" AND NOT member.cycle
      LEFT JOIN unambiguous_exact_roots AS exact_root
        ON exact_root."rootId" = member."rootId"
      WHERE link."userId" = ${snapshot.userId}
      GROUP BY link."factVersionId"
    ),
    eligible AS MATERIALIZED (${factEligibleSelect(
      snapshot,
      plan,
      "DIRECT",
      Prisma.sql`EXISTS (
        SELECT 1 FROM linked
        WHERE linked."factVersionId" = version."id"
      )`
    )})
    SELECT ${candidateColumns(
      Prisma.sql`linked.score`,
      Prisma.sql`linked.role`,
      Prisma.sql`CASE WHEN linked."deterministic"
        THEN 'EXACT_ALIAS_SINGLE_ROOT'::text ELSE NULL::text END`
    )}
    FROM eligible
    INNER JOIN linked ON linked."factVersionId" = eligible."itemId"
    ORDER BY linked.score DESC, eligible."itemId"
    LIMIT ${limit}
  `;
}

async function hasPotentialEntityAlias(
  client: PrismaClient,
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): Promise<boolean> {
  const { terms } = plannedEntityTerms(plan);
  if (terms.length === 0) return false;
  return await withMemoryReadBudget(
    client,
    MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE,
    (tx) => tx.memoryEntityAlias.findFirst({
      select: { id: true },
      where: {
        normalizedAlias: { in: [...terms] },
        userId: snapshot.userId
      }
    })
  ) !== null;
}

function profileSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  limit: number
): Prisma.Sql {
  const eligible = factEligibleSelect(snapshot, plan, "DIRECT");
  const authorityScore = Prisma.sql`CASE
    WHEN eligible."sourceMode" = 'EXPLICIT' THEN 1.0
    ELSE 0.8
  END`;
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    SELECT ${candidateColumns(
      authorityScore,
      Prisma.sql`eligible."matchedEntityRole"`,
      Prisma.sql`'PROFILE'::text`
    )} FROM eligible
    ORDER BY (eligible."sourceMode" = 'EXPLICIT') DESC,
      eligible."pinned" DESC,
      eligible."importance" DESC,
      eligible."confidence" DESC,
      eligible."systemFrom" DESC,
      eligible."itemId"
    LIMIT ${limit}
  `;
}

function distinctiveFtsTerms(terms: readonly string[]): readonly string[] {
  const distinctTerms = [...new Set(terms)].slice(0, MEMORY_LEXICAL_QUERY_MAX_TERMS);
  // A natural-language question contains short connective terms that are
  // common to unrelated memories. Search the longer, more distinctive half
  // independently; authoritative rejoin and bounded packing still own admission.
  // Keeping at least two terms preserves compact requests such as "tea style".
  return distinctTerms
    .map((term, index) => ({ index, length: Array.from(term).length, term }))
    .sort((left, right) => right.length - left.length || left.index - right.index)
    .slice(0, Math.min(distinctTerms.length, Math.max(2, Math.ceil(distinctTerms.length / 2))))
    .map(({ term }) => term);
}

type MemorySemanticLexicalTermKind = "NGRAM" | "UNICODE";

/** Preserves bounded evidence from every semantic query variant instead of
 * letting a verbose rewrite evict the original user's distinctive terms. */
export function memorySemanticLexicalTerms(
  plan: MemoryRetrievalPlan,
  kind: MemorySemanticLexicalTermKind
): readonly string[] {
  return memorySemanticLexicalTermVariants(plan, kind).map(({ term }) => term);
}

function memorySemanticLexicalTermVariants(
  plan: MemoryRetrievalPlan,
  kind: MemorySemanticLexicalTermKind
): readonly Readonly<{ term: string; variantOrdinal: number }>[] {
  const texts = plan.semanticQueryVariants.length > 0
    ? plan.semanticQueryVariants.map(({ text }) => text)
    : plan.lexicalQuery ? [plan.lexicalQuery] : [];
  const maximumTerms = kind === "NGRAM"
    ? Math.min(MEMORY_NGRAM_QUERY_MAX_TERMS, MEMORY_NGRAM_FALLBACK_MAX_TERMS)
    : MEMORY_LEXICAL_QUERY_MAX_TERMS;
  const candidates = texts.map((text, variantOrdinal) => {
    const analysis = analyzeMemoryLexicalQuery(text);
    const terms = kind === "NGRAM"
      ? distinctiveFtsTerms(analysis.ngramTerms)
          .slice(0, MEMORY_NGRAM_FALLBACK_MAX_TERMS_PER_VARIANT)
      : distinctiveFtsTerms(analysis.logicalTerms);
    return { terms, variantOrdinal };
  });
  const selectedByVariant = candidates.map(() =>
    [] as Array<Readonly<{ term: string; variantOrdinal: number }>>);
  const nextIndexes = candidates.map(() => 0);
  const seen = new Set<string>();
  let selectedCount = 0;
  while (selectedCount < maximumTerms) {
    let progressed = false;
    for (const candidate of candidates) {
      let term: string | undefined;
      while (nextIndexes[candidate.variantOrdinal]! < candidate.terms.length) {
        const next = candidate.terms[nextIndexes[candidate.variantOrdinal]!]!;
        nextIndexes[candidate.variantOrdinal]! += 1;
        if (!seen.has(next)) {
          term = next;
          break;
        }
      }
      if (term === undefined) continue;
      seen.add(term);
      selectedByVariant[candidate.variantOrdinal]!.push({
        term,
        variantOrdinal: candidate.variantOrdinal
      });
      selectedCount += 1;
      progressed = true;
      if (selectedCount >= maximumTerms) break;
    }
    if (!progressed) break;
  }
  // Keep the original variant first in the materialized query while the
  // round-robin allocation above prevents any verbose variant from consuming
  // the complete bounded term budget.
  return selectedByVariant.flat();
}

function providerTermKind(
  lane: PostgresUnicodeMemoryLexicalLane
): MemorySemanticLexicalTermKind {
  if (lane === "FACT_LEXICAL_NGRAM" || lane === "HISTORY_RECALL_LEXICAL_NGRAM") {
    return "NGRAM";
  }
  return "UNICODE";
}

function memoryLexicalSearchRequest(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  lane: PostgresUnicodeMemoryLexicalLane,
  finalLimit: number,
  admittedLimit: number,
  sourceChatIds?: readonly string[],
  deadlineAtMs = Date.now() + MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE
): MemoryLexicalSearchRequest {
  if (!snapshot.activeGenerationId || !plan.lexicalQuery) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  const readinessScope = memoryLexicalReadinessScopes.get(snapshot);
  if (!readinessScope) throw new Error("memory_retrieval_snapshot_invalid");
  const texts = plan.semanticQueryVariants.length > 0
    ? plan.semanticQueryVariants.map(({ text }) => text)
    : [plan.lexicalQuery];
  const termsByVariant = new Map<number, string[]>();
  for (const { term, variantOrdinal } of memorySemanticLexicalTermVariants(
    plan,
    providerTermKind(lane)
  )) {
    const terms = termsByVariant.get(variantOrdinal) ?? [];
    terms.push(term);
    termsByVariant.set(variantOrdinal, terms);
  }
  const variants = texts.map((text, ordinal) => Object.freeze({
    logicalTerms: Object.freeze((termsByVariant.get(ordinal) ?? []).map(
      (value, termOrdinal) => Object.freeze({
        characterLength: Array.from(value).length,
        ordinal: termOrdinal,
        value
      })
    )),
    normalizedText: analyzeMemoryLexicalQuery(text).normalized,
    ordinal
  }));
  if (variants.every(({ logicalTerms }) => logicalTerms.length === 0)) {
    throw new Error("memory_retrieval_lane_invalid");
  }
  if (!Number.isSafeInteger(admittedLimit) || admittedLimit < 1 ||
    admittedLimit > finalLimit) {
    throw new Error("memory_retrieval_lane_invalid");
  }
  const ngram = lane === "FACT_LEXICAL_NGRAM" ||
    lane === "HISTORY_RECALL_LEXICAL_NGRAM";
  // Authority filters and source-diverse selection need headroom, but the
  // canonical PostgreSQL rejoin must not inherit the provider's maximum for
  // every semantic variant. Share one bounded overfetch pool across variants.
  const ngramAuthorityCandidateBudget = Math.min(
    MEMORY_LEXICAL_PROVIDER_MAX_FINAL_CANDIDATES,
    admittedLimit * MEMORY_LEXICAL_NGRAM_AUTHORITY_OVERFETCH_MULTIPLIER
  );
  const candidateLimitPerVariant = ngram
    ? Math.min(
        MEMORY_LEXICAL_PROVIDER_MAX_CANDIDATES_PER_VARIANT,
        Math.ceil(ngramAuthorityCandidateBudget / variants.length)
      )
    : Math.min(
        MEMORY_LEXICAL_PROVIDER_MAX_CANDIDATES_PER_VARIANT,
        finalLimit * 2
      );
  return Object.freeze({
    [memoryLexicalProjectionReadinessScope]: readinessScope,
    activeGenerationId: snapshot.activeGenerationId,
    analysisProfileVersion: MEMORY_LEXICAL_ANALYSIS_PROFILE,
    candidateLimitPerVariant,
    deadlineAtMs,
    finalLimit,
    itemFamily: lane.startsWith("FACT_") ? "FACT" : "HISTORY",
    memoryRevisionSnapshot: snapshot.memoryRevision,
    ...(sourceChatIds ? { sourceChatIds: Object.freeze([...sourceChatIds]) } : {}),
    userId: snapshot.userId,
    variants: Object.freeze(variants)
  });
}

type MemoryFtsLaneSettings = Readonly<{
  configuration: Prisma.Sql;
  entryVector: Prisma.Sql;
  termVariants: readonly Readonly<{ term: string; variantOrdinal: number }>[];
}>;

function ftsLaneSettings(
  plan: MemoryRetrievalPlan,
  lane: MemoryRetrievalLane
): MemoryFtsLaneSettings {
  if (!plan.lexicalQuery) throw new Error("memory_retrieval_lane_invalid");
  if (lane === "FACT_LEXICAL_UNICODE" || lane === "HISTORY_RECALL_LEXICAL_UNICODE") {
    return {
      configuration: Prisma.sql`'simple'::regconfig`,
      entryVector: Prisma.sql`entry."searchVectorSimple"`,
      termVariants: memorySemanticLexicalTermVariants(plan, "UNICODE")
    };
  }
  throw new Error("memory_retrieval_lane_invalid");
}

function ftsSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  lane: MemoryRetrievalLane,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  limit: number,
  sourceChatIds?: readonly string[]
): Prisma.Sql {
  if (!snapshot.activeGenerationId) throw new Error("memory_retrieval_snapshot_invalid");
  const settings = ftsLaneSettings(plan, lane);
  const terms = settings.termVariants.map(({ term }) => term);
  const variantOrdinals = settings.termVariants.map(({ variantOrdinal }) =>
    variantOrdinal);
  if (terms.length === 0) throw new Error("memory_retrieval_lane_invalid");
  const itemTypePredicate = itemType === "FACT_VERSION"
    ? Prisma.sql`entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"`
    : historySearchEntryItemTypePredicate();
  const sourcePredicate = itemType === "FACT_VERSION"
    ? Prisma.sql`TRUE`
    : historySearchEntrySourcePredicate(sourceChatIds);
  const perVariantCandidateLimit = Math.min(
    MEMORY_LEXICAL_AUTHORITY_PREFILTER_MAX_PER_VARIANT,
    limit * 2
  );
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(
        snapshot,
        plan,
        "INDEXED",
        Prisma.sql`TRUE`,
        "BOUNDED_CANDIDATES"
      )
    : historyEligibleSelect(
        snapshot,
        plan,
        Prisma.sql`TRUE`,
        sourceChatIds,
        "BOUNDED_CANDIDATES"
      );
  return Prisma.sql`
    WITH query_terms AS MATERIALIZED (
      SELECT DISTINCT term, "variantOrdinal",
        char_length(term)::integer AS "termLength",
        plainto_tsquery(${settings.configuration}, term) AS query
      FROM unnest(${terms}::text[], ${variantOrdinals}::integer[])
        AS terms(term, "variantOrdinal")
      WHERE plainto_tsquery(${settings.configuration}, term) <> ''::tsquery
    ),
    candidate_matches AS MATERIALIZED (
      SELECT entry."id" AS "entryId", query_terms."variantOrdinal",
        COUNT(*)::integer AS "matchedTermCount",
        COALESCE(MAX(query_terms."termLength"), 0)::integer AS
          "maximumMatchedTermLength",
        COALESCE(SUM(ts_rank_cd(${settings.entryVector}, query_terms.query)),
          0.0)::double precision AS "rankScore"
      FROM "MemorySearchEntry" AS entry
      INNER JOIN query_terms
        ON ${settings.entryVector} @@ query_terms.query
      WHERE entry."userId" = ${snapshot.userId}
        AND entry."indexGenerationId" = ${snapshot.activeGenerationId}
        AND ${itemTypePredicate}
        AND ${sourcePredicate}
      GROUP BY entry."id", query_terms."variantOrdinal"
    ),
    ranked_entry_matches AS MATERIALIZED (
      SELECT candidate_matches.*,
        ROW_NUMBER() OVER (
          PARTITION BY candidate_matches."variantOrdinal"
          ORDER BY candidate_matches."maximumMatchedTermLength" DESC,
            candidate_matches."matchedTermCount" DESC,
            candidate_matches."rankScore" DESC,
            candidate_matches."entryId"
        )::integer AS "candidateRankWithinVariant"
      FROM candidate_matches
    ),
    bounded_entry_matches AS MATERIALIZED (
      SELECT * FROM ranked_entry_matches
      WHERE ranked_entry_matches."candidateRankWithinVariant" <=
        ${perVariantCandidateLimit}
    ),
    matching_entries AS MATERIALIZED (
      SELECT DISTINCT bounded_entry_matches."entryId"
      FROM bounded_entry_matches
    ),
    candidate_entries AS MATERIALIZED (
      SELECT ${boundedMemorySearchEntryColumnsSql()}
      FROM matching_entries AS matching_entry
      INNER JOIN "MemorySearchEntry" AS entry
        ON entry."id" = matching_entry."entryId"
      WHERE entry."userId" = ${snapshot.userId}
        AND entry."indexGenerationId" = ${snapshot.activeGenerationId}
    ),
    eligible AS MATERIALIZED (${eligible}),
    matched_variants AS MATERIALIZED (
      SELECT eligible.*, term_match."variantOrdinal",
        term_match."matchedTermCount", term_match."maximumMatchedTermLength",
        term_match."rankScore"
      FROM eligible
      INNER JOIN bounded_entry_matches AS term_match
        ON term_match."entryId" = eligible."entryId"
    ),
    ranked_variants AS MATERIALIZED (
      SELECT matched_variants.*,
        ROW_NUMBER() OVER (
          PARTITION BY matched_variants."variantOrdinal"
          ORDER BY matched_variants."maximumMatchedTermLength" DESC,
            matched_variants."matchedTermCount" DESC,
            matched_variants."rankScore" DESC, matched_variants."itemId"
        )::integer AS "rankWithinVariant"
      FROM matched_variants
    ),
    balanced_candidates AS MATERIALIZED (
      SELECT DISTINCT ON (ranked_variants."itemType", ranked_variants."itemId")
        ranked_variants.*
      FROM ranked_variants
      ORDER BY ranked_variants."itemType", ranked_variants."itemId",
        ranked_variants."rankWithinVariant", ranked_variants."variantOrdinal"
    )
    SELECT ${candidateColumns(Prisma.sql`eligible."rankScore"`)}
    FROM balanced_candidates AS eligible
    ORDER BY eligible."rankWithinVariant", eligible."variantOrdinal",
      eligible."maximumMatchedTermLength" DESC,
      eligible."matchedTermCount" DESC, eligible."rankScore" DESC,
      eligible."itemId" LIMIT ${limit}
  `;
}

function targetedDigestFtsSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  limit: number
): Prisma.Sql {
  if (plan.mode !== "PAST_CHAT_SEARCH") {
    throw new Error("memory_retrieval_lane_invalid");
  }
  if (!plan.lexicalQuery) throw new Error("memory_retrieval_lane_invalid");
  const termVariants = memorySemanticLexicalTermVariants(plan, "UNICODE");
  const terms = termVariants.map(({ term }) => term);
  const variantOrdinals = termVariants.map(({ variantOrdinal }) => variantOrdinal);
  if (terms.length === 0) throw new Error("memory_retrieval_lane_invalid");
  return Prisma.sql`
    WITH all_digest_navigation AS MATERIALIZED (${historyDigestEligibleSelect(snapshot, plan)}),
    query_terms AS MATERIALIZED (
      SELECT DISTINCT term, "variantOrdinal",
        char_length(term)::integer AS "termLength",
        plainto_tsquery('simple', term) AS query
      FROM unnest(${terms}::text[], ${variantOrdinals}::integer[])
        AS terms(term, "variantOrdinal")
      WHERE plainto_tsquery('simple', term) <> ''::tsquery
    ),
    matched_navigation AS MATERIALIZED (
      SELECT navigation.*, term_match."variantOrdinal",
        term_match."matchedTermCount",
        term_match."maximumMatchedTermLength", term_match."rankScore"
      FROM all_digest_navigation AS navigation
      CROSS JOIN LATERAL (
        SELECT query_terms."variantOrdinal",
          COUNT(*)::integer AS "matchedTermCount",
          COALESCE(MAX(query_terms."termLength"), 0)::integer AS
            "maximumMatchedTermLength",
          COALESCE(SUM(ts_rank_cd(navigation."searchVectorSimple", query_terms.query)),
            0.0)::double precision AS "rankScore"
        FROM query_terms
        WHERE navigation."searchVectorSimple" @@ query_terms.query
        GROUP BY query_terms."variantOrdinal"
      ) AS term_match
    ),
    ranked_navigation AS MATERIALIZED (
      SELECT matched_navigation.*,
        ROW_NUMBER() OVER (
          PARTITION BY matched_navigation."variantOrdinal"
          ORDER BY matched_navigation."maximumMatchedTermLength" DESC,
            matched_navigation."matchedTermCount" DESC,
            matched_navigation."rankScore" DESC,
            matched_navigation."occurredTo" DESC NULLS LAST,
            matched_navigation."itemId"
        )::integer AS "rankWithinVariant"
      FROM matched_navigation
    ),
    digest_navigation AS MATERIALIZED (
      SELECT DISTINCT ON (navigation."sourceChatId") navigation.*
      FROM ranked_navigation AS navigation
      ORDER BY navigation."sourceChatId",
        navigation."rankWithinVariant", navigation."variantOrdinal"
    )
    SELECT ${candidateColumns(Prisma.sql`eligible."rankScore"`)}
    FROM digest_navigation AS eligible
    ORDER BY eligible."rankWithinVariant", eligible."variantOrdinal",
      eligible."maximumMatchedTermLength" DESC,
      eligible."matchedTermCount" DESC, eligible."rankScore" DESC,
      eligible."occurredTo" DESC NULLS LAST, eligible."itemId" LIMIT ${limit}
  `;
}

function recentSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  limit: number
): Prisma.Sql {
  if (!plan.recencyRequested && plan.mode !== "HISTORY_OVERVIEW" &&
    !plan.aggregationRequested) {
    throw new Error("memory_retrieval_lane_invalid");
  }
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(snapshot, plan)
    : historyEligibleSelect(snapshot, plan);
  const timestamp = itemType === "FACT_VERSION"
    ? Prisma.sql`eligible."systemFrom"`
    : Prisma.sql`eligible."occurredTo"`;
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    SELECT ${candidateColumns(Prisma.sql`EXTRACT(EPOCH FROM ${timestamp})`)} FROM eligible
    WHERE ${timestamp} IS NOT NULL
    ORDER BY ${timestamp} DESC, eligible."itemId" LIMIT ${limit}
  `;
}

function memoryLexicalRawCandidatesSql(
  candidates: readonly MemoryLexicalRawCandidate[]
): Prisma.Sql {
  if (candidates.length === 0) {
    throw new Error("memory_lexical_search_result_invalid");
  }
  return Prisma.join(candidates.map((candidate) => Prisma.sql`(
    ${candidate.searchEntryId}::text,
    ${candidate.safeContentHash}::text,
    ${candidate.variantOrdinal}::integer,
    ${candidate.rankWithinVariant}::integer,
    ${candidate.matchedTermCount}::integer,
    ${candidate.maximumMatchedTermLength}::integer,
    ${candidate.backendScore}::double precision
  )`));
}

function boundMemoryLexicalCanonicalSearchResult(
  result: MemoryLexicalSearchResult
): MemoryLexicalSearchResult {
  if (result.candidates.length <=
    MEMORY_LEXICAL_PROVIDER_MAX_FINAL_CANDIDATES) return result;
  const candidates = Object.freeze([...result.candidates].sort((left, right) =>
    left.rankWithinVariant - right.rankWithinVariant ||
    left.variantOrdinal - right.variantOrdinal ||
    right.maximumMatchedTermLength - left.maximumMatchedTermLength ||
    right.matchedTermCount - left.matchedTermCount ||
    right.backendScore - left.backendScore ||
    left.searchEntryId.localeCompare(right.searchEntryId)
  ).slice(0, MEMORY_LEXICAL_PROVIDER_MAX_FINAL_CANDIDATES));
  return Object.freeze({
    candidates,
    evidence: Object.freeze({
      ...result.evidence,
      rawCandidateCount: candidates.length
    })
  });
}

/** Re-authorizes provider identities through the existing canonical selectors.
 * Provider rank evidence affects ordering only after owner, generation, hash,
 * source, suppression, safety, lifecycle, and current-version fences pass. */
function memoryLexicalCanonicalRejoinSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  lane: PostgresUnicodeMemoryLexicalLane,
  candidates: readonly MemoryLexicalRawCandidate[],
  limit: number,
  sourceChatIds?: readonly string[]
): Prisma.Sql {
  const eligible = lane.startsWith("FACT_")
    ? factEligibleSelect(
        snapshot,
        plan,
        "INDEXED",
        Prisma.sql`TRUE`,
        "BOUNDED_CANDIDATES"
      )
    : historyEligibleSelect(
        snapshot,
        plan,
        Prisma.sql`TRUE`,
        sourceChatIds,
        "BOUNDED_CANDIDATES"
      );
  return Prisma.sql`
    WITH lexical_raw_candidates (
      "searchEntryId", "safeContentHash", "variantOrdinal",
      "providerRankWithinVariant", "matchedTermCount",
      "maximumMatchedTermLength", "rankScore"
    ) AS MATERIALIZED (
      VALUES ${memoryLexicalRawCandidatesSql(candidates)}
    ),
    lexical_candidate_entry_ids AS MATERIALIZED (
      SELECT DISTINCT lexical_candidate."searchEntryId",
        lexical_candidate."safeContentHash"
      FROM lexical_raw_candidates AS lexical_candidate
    ),
    candidate_entries AS MATERIALIZED (
      SELECT ${boundedMemorySearchEntryColumnsSql()}
      FROM lexical_candidate_entry_ids AS lexical_candidate
      INNER JOIN "MemorySearchEntry" AS entry
        ON entry."id" = lexical_candidate."searchEntryId"
        AND entry."safeContentHash" = lexical_candidate."safeContentHash"
      WHERE entry."userId" = ${snapshot.userId}
        AND entry."indexGenerationId" = ${snapshot.activeGenerationId}
    ),
    eligible AS MATERIALIZED (${eligible}),
    matched_variants AS MATERIALIZED (
      SELECT eligible.*, lexical_candidate."variantOrdinal",
        lexical_candidate."matchedTermCount",
        lexical_candidate."maximumMatchedTermLength",
        lexical_candidate."rankScore"
      FROM eligible
      INNER JOIN lexical_raw_candidates AS lexical_candidate
        ON lexical_candidate."searchEntryId" = eligible."entryId"
        AND lexical_candidate."safeContentHash" = eligible."safeContentHash"
    ),
    ranked_variants AS MATERIALIZED (
      SELECT matched_variants.*,
        ROW_NUMBER() OVER (
          PARTITION BY matched_variants."variantOrdinal"
          ORDER BY matched_variants."maximumMatchedTermLength" DESC,
            matched_variants."matchedTermCount" DESC,
            matched_variants."rankScore" DESC, matched_variants."itemId"
        )::integer AS "rankWithinVariant"
      FROM matched_variants
    ),
    balanced_candidates AS MATERIALIZED (
      SELECT DISTINCT ON (ranked_variants."itemType", ranked_variants."itemId")
        ranked_variants.*
      FROM ranked_variants
      ORDER BY ranked_variants."itemType", ranked_variants."itemId",
        ranked_variants."rankWithinVariant", ranked_variants."variantOrdinal"
    )
    SELECT ${candidateColumns(Prisma.sql`eligible."rankScore"`)}
    FROM balanced_candidates AS eligible
    ORDER BY eligible."rankWithinVariant", eligible."variantOrdinal",
      eligible."maximumMatchedTermLength" DESC,
      eligible."matchedTermCount" DESC, eligible."rankScore" DESC,
      eligible."itemId" LIMIT ${limit}
  `;
}

async function queryLane(
  client: PrismaClient,
  lane: MemoryRetrievalLane,
  limit: number,
  sql: Prisma.Sql,
  options: Readonly<{
    maximumRows?: number;
    preserveExplicitJoinOrder?: boolean;
    readBudgetMs?: number;
    recordCanonicalEntryIds?: (entryIds: readonly string[]) => void;
    recordCounts?: (rawCandidateCount: number, canonicalAcceptedCount: number) => void;
    sourceDiversity?: boolean;
  }> = {}
): Promise<MemoryLaneResult> {
  const taggedSql = Prisma.sql`
    /* aiqsa_memory_retrieval_lane:${Prisma.raw(lane)} */
    ${sql}
  `;
  const rows = await withMemoryReadBudget(
    client,
    options.readBudgetMs ?? MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE,
    (tx) => tx.$queryRaw<CandidateRow[]>(taggedSql),
    { preserveExplicitJoinOrder: options.preserveExplicitJoinOrder }
  );
  const maximumRows = options.maximumRows ?? limit;
  if (!Number.isSafeInteger(maximumRows) || maximumRows < limit ||
    maximumRows > MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES ||
    rows.length > maximumRows) throw new Error("memory_retrieval_result_invalid");
  const decoded = rows.map((row) => decodeCandidate(row, lane));
  const exactKeys = decoded.map((candidate) =>
    `${candidate.itemType}:${candidate.itemId}:${candidate.matchedSegmentId ?? "parent"}`);
  if (new Set(exactKeys).size !== decoded.length) {
    throw new Error("memory_retrieval_result_invalid");
  }
  if (options.recordCanonicalEntryIds) {
    const entryIds = decoded.map(({ entryId }) => {
      if (!entryId) throw new Error("memory_retrieval_result_invalid");
      return entryId;
    });
    if (new Set(entryIds).size !== entryIds.length) {
      throw new Error("memory_retrieval_result_invalid");
    }
    options.recordCanonicalEntryIds(Object.freeze(entryIds));
  }
  const byPublicItem = new Map<string, MemoryLaneCandidate>();
  for (const candidate of decoded) {
    const key = `${candidate.itemType}:${candidate.itemId}`;
    if (!byPublicItem.has(key)) byPublicItem.set(key, candidate);
  }
  const collapsed = [...byPublicItem.values()];
  const candidates = options.sourceDiversity
    ? selectMemorySourceDiverseLaneCandidates(collapsed, limit)
    : collapsed.slice(0, limit);
  if (candidates.length > limit) throw new Error("memory_retrieval_result_invalid");
  options.recordCounts?.(rows.length, candidates.length);
  return { candidates, lane };
}

export function selectMemorySourceDiverseLaneCandidates<T extends Readonly<{
  itemId: string;
  metadata: Readonly<{ sourceChatId: string | null }>;
}>>(candidates: readonly T[], limit: number): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit < 1 ||
    limit > MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES ||
    candidates.length > MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES ||
    candidates.some(({ metadata }) => !metadata.sourceChatId)) {
    throw new Error("memory_retrieval_result_invalid");
  }
  const firstBySource: T[] = [];
  const remaining: T[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const sourceChatId = candidate.metadata.sourceChatId!;
    if (seen.has(sourceChatId)) remaining.push(candidate);
    else {
      seen.add(sourceChatId);
      firstBySource.push(candidate);
    }
  }
  return [...firstBySource, ...remaining].slice(0, limit);
}

function localLexicalLanes(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): readonly MemoryRetrievalLane[] {
  if (!plan.queryPresent) return [];
  const lexical = plan.lexicalQuery
    ? analyzeMemoryLexicalQuery(plan.lexicalQuery)
    : null;
  const indexed = snapshot.activeGenerationId !== null && snapshot.indexMode !== null;
  const temporal = !plan.profileRequested && plan.temporalQueryVariants.some(({ kind }) =>
    kind === "FILTERED");
  const lanes: MemoryRetrievalLane[] = [];
  if (snapshot.useMemoryFacts &&
    (plan.filters.sourceKinds.includes("FACT") || plan.filters.sourceKinds.includes("EVENT"))) {
    if (plan.profileRequested) lanes.push("FACT_PROFILE");
    else {
      lanes.push("FACT_EXACT");
      if (plan.semanticQueryVariants.some(({ text }) =>
        entityQueryTerms(text).length > 0)) lanes.push("FACT_ENTITY");
      if (temporal) {
        lanes.push("FACT_TEMPORAL_FILTERED", "FACT_TEMPORAL_UNRESTRICTED");
      }
      if (indexed && lexical) {
        lanes.push("FACT_LEXICAL_UNICODE");
        if (lexical.ngramTerms.length > 0) lanes.push("FACT_LEXICAL_NGRAM");
      }
      if (indexed && plan.recencyRequested) lanes.push("FACT_RECENT");
    }
  }
  if (indexed && !plan.profileRequested && snapshot.useMemoryFacts &&
    snapshot.referenceChatHistory && plan.filters.sourceKinds.includes("HISTORY")) {
    if (temporal) {
      lanes.push(
        "HISTORY_RECALL_TEMPORAL_FILTERED",
        "HISTORY_RECALL_TEMPORAL_UNRESTRICTED"
      );
    }
    if (plan.mode === "HISTORY_OVERVIEW") {
      if (lexical) lanes.push("HISTORY_RECALL_LEXICAL_UNICODE");
      lanes.push("HISTORY_RECALL_RECENT");
    } else {
      lanes.push("HISTORY_RECALL_EXACT");
      if (plan.mode === "PAST_CHAT_SEARCH" && lexical) {
        lanes.push("HISTORY_DIGEST_FTS_SIMPLE");
      }
      if (lexical) {
        lanes.push("HISTORY_RECALL_LEXICAL_UNICODE");
        if (lexical.ngramTerms.length > 0) {
          lanes.push("HISTORY_RECALL_LEXICAL_NGRAM");
        }
      }
      if (plan.recencyRequested) lanes.push("HISTORY_RECALL_RECENT");
    }
  }
  const priority = new Map<MemoryRetrievalLane, number>(
    MEMORY_RETRIEVAL_EXECUTION_LANE_ORDER.map((lane, index) => [lane, index])
  );
  return lanes.sort((left, right) =>
    (priority.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (priority.get(right) ?? Number.MAX_SAFE_INTEGER));
}

async function prepareMemoryLexicalProviderReadiness(input: Readonly<{
  plan: MemoryRetrievalPlan;
  providerForLane: MemoryLexicalProviderForLane;
  snapshot: MemoryLocalRetrievalSnapshot;
}>): Promise<void> {
  const lane = localLexicalLanes(input.snapshot, input.plan).find(
    isPostgresUnicodeMemoryLexicalLane
  );
  if (!lane) return;
  const provider = input.providerForLane(lane);
  if (!provider.prepare) return;
  const request = memoryLexicalSearchRequest(
    input.snapshot,
    input.plan,
    lane,
    memoryRetrievalLaneLimit(lane, input.plan.aggregationRequested),
    memoryRetrievalLaneLimit(lane, input.plan.aggregationRequested)
  );
  try {
    await provider.prepare(request);
  } catch {
    // Preparation is candidate-free and optional. The subsequent provider
    // search consumes the same cached proof and owns normal degraded evidence,
    // fallback, and circuit-breaker accounting.
  }
}

function allocatedLimit(
  allocation: MemoryRetrievalLaneLimitAllocation,
  lane: MemoryRetrievalLane,
  aggregationRequested: boolean
): number {
  const limit = allocation[lane];
  if (!Number.isSafeInteger(limit) || !limit || limit < 1 ||
    limit > memoryRetrievalLaneLimit(lane, aggregationRequested)) {
    throw new Error("memory_retrieval_lane_contract_invalid");
  }
  return limit;
}

function laneSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  lane: MemoryRetrievalLane,
  limit: number,
  sourceChatIds?: readonly string[]
): Prisma.Sql {
  if (lane === "HISTORY_DIGEST_FTS_SIMPLE") {
    return targetedDigestFtsSql(snapshot, plan, limit);
  }
  const itemType = lane.startsWith("FACT_") ? "FACT_VERSION" : "RECALL_CHUNK";
  if (lane.endsWith("_TEMPORAL_FILTERED")) {
    return temporalSql(snapshot, plan, itemType, limit, false, sourceChatIds);
  }
  if (lane.endsWith("_TEMPORAL_UNRESTRICTED")) {
    return temporalSql(snapshot, plan, itemType, limit, true, sourceChatIds);
  }
  if (lane === "FACT_PROFILE") return profileSql(snapshot, plan, limit);
  if (lane === "FACT_ENTITY") return entitySql(snapshot, plan, limit);
  if (lane.endsWith("_EXACT")) {
    return exactSql(snapshot, plan, itemType, limit, sourceChatIds);
  }
  if (plan.mode === "HISTORY_OVERVIEW" &&
    lane === "HISTORY_RECALL_LEXICAL_UNICODE") {
    return ftsSql(snapshot, plan, lane, itemType, limit, sourceChatIds);
  }
  if (lane.endsWith("_RECENT")) return recentSql(snapshot, plan, itemType, limit);
  throw new Error("memory_retrieval_lane_contract_invalid");
}

type MemoryRetrievalLaneTask =
  Parameters<typeof executeMemoryRetrievalLaneTasks>[0][number];

/** Transliteration/n-gram recovery is a bounded lexical fallback. It is
 * suppressed only when the corresponding Unicode/folded provider produced a
 * complete variant that survived canonical rejoin. Independent exact, dense,
 * digest, or partial lexical candidates cannot prove lexical query coverage. */
export function shouldRunMemoryNgramFallback(
  lane: MemoryRetrievalLane,
  laneResults: readonly MemoryLaneResult[],
  completePrimaryLanes: ReadonlySet<MemoryRetrievalLane>
): boolean {
  if (lane !== "FACT_LEXICAL_NGRAM" && lane !== "HISTORY_RECALL_LEXICAL_NGRAM") {
    throw new Error("memory_ngram_fallback_lane_invalid");
  }
  const primaryLane = lane === "FACT_LEXICAL_NGRAM"
    ? "FACT_LEXICAL_UNICODE"
    : "HISTORY_RECALL_LEXICAL_UNICODE";
  const primary = laneResults.find((result) => result.lane === primaryLane);
  return !primary || primary.candidates.length === 0 ||
    !completePrimaryLanes.has(primaryLane);
}

const memoryExecutionLanePriority = new Map<MemoryRetrievalLane, number>(
  MEMORY_RETRIEVAL_EXECUTION_LANE_ORDER.map((lane, index) => [lane, index])
);

function orderedExecutionLaneResults(
  laneResults: readonly MemoryLaneResult[]
): readonly MemoryLaneResult[] {
  return [...laneResults].sort((left, right) =>
    (memoryExecutionLanePriority.get(left.lane) ?? Number.MAX_SAFE_INTEGER) -
      (memoryExecutionLanePriority.get(right.lane) ?? Number.MAX_SAFE_INTEGER));
}

const MEMORY_LEXICAL_EVIDENCE_MAX_DURATION_MS = 60_000;

function lexicalMatchMode(
  lane: MemoryRetrievalLane
): MemoryLexicalLaneEvidence["matchMode"] {
  if (lane.endsWith("_LEXICAL_NGRAM")) return "NGRAM";
  if (lane.endsWith("_LEXICAL_UNICODE")) return "UNICODE";
  return null;
}

type MemoryLexicalEvidenceRecorder = Readonly<{
  complete(entry: MemoryLexicalLaneEvidence): MemoryLexicalLaneEvidence | null;
  counts(rawCandidateCount: number, canonicalAcceptedCount: number): void;
  failure(error: unknown): MemoryLexicalLaneEvidence | null;
  settled(): MemoryLexicalLaneEvidence | null;
  success(): MemoryLexicalLaneEvidence | null;
}>;

function createLexicalEvidenceRecorder(
  evidence: MemoryLexicalLaneEvidence[],
  lane: MemoryRetrievalLane,
  requestedLimit: number,
  providerBackend: MemoryLexicalProviderBackend = "POSTGRES"
): MemoryLexicalEvidenceRecorder {
  const backend: MemoryLexicalProviderEvidence["backend"] =
    providerBackend === "OPENSEARCH" ? "OPENSEARCH" : "POSTGRES";
  const startedAt = Date.now();
  let canonicalAcceptedCount = 0;
  let rawCandidateCount = 0;
  let recorded = false;
  const record = (
    failureCode: MemoryLexicalLaneEvidence["failureCode"]
  ): MemoryLexicalLaneEvidence | null => {
    if (recorded) return null;
    recorded = true;
    const durationMs = Math.min(
      MEMORY_LEXICAL_EVIDENCE_MAX_DURATION_MS,
      Math.max(0, Date.now() - startedAt)
    );
    const entry = Object.freeze({
      backend,
      canonicalAcceptedCount,
      durationMs,
      failureCode,
      fallbackUsed: lane.endsWith("_LEXICAL_NGRAM"),
      lane,
      matchMode: lexicalMatchMode(lane),
      opaqueId: null,
      projectionCaughtUp: backend === "POSTGRES" ? true : null,
      projectionEventLag: null,
      projectionRevisionLag: null,
      projectionVisibleAgeMs: null,
      rawCandidateCount,
      rejectedAuthorityCount: 0,
      rejectedGenerationCount: 0,
      rejectedHashCount: 0,
      requestedLimit,
      timedOut: failureCode === "memory_lexical_settle_timeout" ||
        failureCode === "memory_read_lock_timeout" ||
        failureCode === "memory_read_statement_timeout"
    });
    evidence.push(entry);
    return entry;
  };
  return Object.freeze({
    complete(entry) {
      if (recorded) return null;
      recorded = true;
      evidence.push(Object.freeze(entry));
      return entry;
    },
    counts(raw, accepted) {
      if (!Number.isSafeInteger(raw) || raw < 0 ||
        !Number.isSafeInteger(accepted) || accepted < 0 || accepted > raw) {
        throw new Error("memory_lexical_evidence_invalid");
      }
      rawCandidateCount = raw;
      canonicalAcceptedCount = accepted;
    },
    failure(error) {
      return record(error instanceof MemoryReadBudgetError
        ? error.code
        : "memory_lexical_lane_unavailable");
    },
    settled() {
      return record("memory_lexical_settle_timeout");
    },
    success() {
      return record(null);
    }
  });
}

export type MemoryLexicalProviderForLane = (
  lane: PostgresUnicodeMemoryLexicalLane
) => MemoryLexicalCandidateProvider;

type MemoryLexicalRejectionCounts = Readonly<{
  rejectedAuthorityCount: number;
  rejectedGenerationCount: number;
  rejectedHashCount: number;
}>;

type MemoryLexicalRejectionRow = Readonly<{
  actualGenerationId: string | null;
  actualSafeContentHash: string | null;
  actualUserId: string | null;
  expectedSafeContentHash: string;
  searchEntryId: string;
}>;

/** Classifies only opaque provider identities. Canonical selector failures
 * that are not an exact generation/hash mismatch remain authority failures;
 * no Memory text or public item identity is materialized. */
export async function classifyMemoryLexicalCanonicalRejections(input: Readonly<{
  acceptedSearchEntryIds: readonly string[];
  candidates: readonly MemoryLexicalRawCandidate[];
  client: PrismaClient;
  deadlineAtMs: number;
  snapshot: MemoryLocalRetrievalSnapshot;
}>): Promise<MemoryLexicalRejectionCounts> {
  const byEntry = new Map<string, string>();
  for (const candidate of input.candidates) {
    const current = byEntry.get(candidate.searchEntryId);
    if (current !== undefined && current !== candidate.safeContentHash) {
      throw new Error("memory_lexical_search_result_invalid");
    }
    byEntry.set(candidate.searchEntryId, candidate.safeContentHash);
  }
  if (byEntry.size === 0) return Object.freeze({
    rejectedAuthorityCount: 0,
    rejectedGenerationCount: 0,
    rejectedHashCount: 0
  });
  const acceptedIds = new Set(input.acceptedSearchEntryIds);
  if (acceptedIds.size !== input.acceptedSearchEntryIds.length ||
    input.acceptedSearchEntryIds.some((entryId) => !byEntry.has(entryId))) {
    throw new Error("memory_lexical_search_result_invalid");
  }
  const values = [...byEntry].map(([searchEntryId, safeContentHash]) =>
    Prisma.sql`(${searchEntryId}::text, ${safeContentHash}::text)`);
  const remainingMs = Math.min(
    MEMORY_READ_BUDGET_MS.CANONICAL_REJOIN_EXPANSION,
    input.deadlineAtMs - Date.now()
  );
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
    throw new MemoryReadBudgetError("memory_read_statement_timeout");
  }
  const rows = await withMemoryReadBudget(
    input.client,
    remainingMs,
    (tx) => tx.$queryRaw<MemoryLexicalRejectionRow[]>(Prisma.sql`
      /* aiqsa_memory_retrieval_lane:OPENSEARCH_CANONICAL_REJECTION_AUDIT */
      WITH lexical_candidates (
        "searchEntryId", "expectedSafeContentHash"
      ) AS MATERIALIZED (
        VALUES ${Prisma.join(values)}
      )
      SELECT
        lexical_candidates."searchEntryId",
        lexical_candidates."expectedSafeContentHash",
        entry."userId" AS "actualUserId",
        entry."indexGenerationId" AS "actualGenerationId",
        entry."safeContentHash" AS "actualSafeContentHash"
      FROM lexical_candidates
      LEFT JOIN "MemorySearchEntry" AS entry
        ON entry."id" = lexical_candidates."searchEntryId"
      ORDER BY lexical_candidates."searchEntryId"
    `)
  );
  if (rows.length !== byEntry.size || new Set(rows.map(({ searchEntryId }) =>
    searchEntryId)).size !== rows.length) {
    throw new Error("memory_lexical_search_result_invalid");
  }
  let rejectedAuthorityCount = 0;
  let rejectedGenerationCount = 0;
  let rejectedHashCount = 0;
  for (const row of rows) {
    if (row.expectedSafeContentHash !== byEntry.get(row.searchEntryId)) {
      throw new Error("memory_lexical_search_result_invalid");
    }
    if (acceptedIds.has(row.searchEntryId)) continue;
    if (row.actualUserId !== input.snapshot.userId) {
      rejectedAuthorityCount += 1;
    } else if (row.actualGenerationId !== input.snapshot.activeGenerationId) {
      rejectedGenerationCount += 1;
    } else if (row.actualSafeContentHash !== row.expectedSafeContentHash) {
      rejectedHashCount += 1;
    } else {
      rejectedAuthorityCount += 1;
    }
  }
  return Object.freeze({
    rejectedAuthorityCount,
    rejectedGenerationCount,
    rejectedHashCount
  });
}

async function queryProviderBackedLexicalLane(input: Readonly<{
  client: PrismaClient;
  deadlineAtMs?: number;
  lane: PostgresUnicodeMemoryLexicalLane;
  limit: number;
  plan: MemoryRetrievalPlan;
  provider: MemoryLexicalCandidateProvider;
  queryLimit: number;
  snapshot: MemoryLocalRetrievalSnapshot;
  sourceChatIds?: readonly string[];
  sourceDiversity: boolean;
}>): Promise<Readonly<{
  completeVariantAccepted: boolean;
  evidence: MemoryLexicalLaneEvidence;
  rawCandidates: readonly MemoryLexicalRawCandidate[];
  result: MemoryLaneResult;
}>> {
  const startedAt = Date.now();
  const request = memoryLexicalSearchRequest(
    input.snapshot,
    input.plan,
    input.lane,
    input.queryLimit,
    input.limit,
    input.sourceChatIds,
    input.deadlineAtMs
  );
  let searched = await input.provider.search(request);
  assertMemoryLexicalSearchResult(request, searched, input.provider.backend);
  searched = boundMemoryLexicalCanonicalSearchResult(searched);
  assertMemoryLexicalSearchResult(request, searched, input.provider.backend);
  if (searched.evidence.lane !== input.lane) {
    throw new Error("memory_lexical_search_result_invalid");
  }
  const canonicalize = async (
    current: MemoryLexicalSearchResult
  ): Promise<Readonly<{
    acceptedCount: number;
    acceptedSearchEntryIds: readonly string[];
    result: MemoryLaneResult;
  }>> => {
    let acceptedCount = 0;
    let acceptedSearchEntryIds: readonly string[] = Object.freeze([]);
    const readBudgetMs = input.deadlineAtMs === undefined
      ? MEMORY_READ_BUDGET_MS.CANONICAL_REJOIN_EXPANSION
      : Math.min(
          MEMORY_READ_BUDGET_MS.CANONICAL_REJOIN_EXPANSION,
          request.deadlineAtMs - Date.now()
        );
    if (current.candidates.length > 0 &&
      (!Number.isSafeInteger(readBudgetMs) || readBudgetMs < 1)) {
      throw new MemoryReadBudgetError("memory_read_statement_timeout");
    }
    const result = current.candidates.length === 0
      ? { candidates: [], lane: input.lane } satisfies MemoryLaneResult
      : await queryLane(
          input.client,
          input.lane,
          input.limit,
          memoryLexicalCanonicalRejoinSql(
            input.snapshot,
            input.plan,
            input.lane,
            current.candidates,
            current.candidates.length,
            input.sourceChatIds
          ),
          {
            maximumRows: Math.max(input.limit, current.candidates.length),
            preserveExplicitJoinOrder: true,
            readBudgetMs,
            recordCanonicalEntryIds(entryIds) {
              acceptedSearchEntryIds = entryIds;
              acceptedCount = entryIds.length;
            },
            sourceDiversity: input.sourceDiversity
          }
        );
    if (acceptedCount > current.candidates.length) {
      throw new Error("memory_lexical_search_result_invalid");
    }
    return Object.freeze({ acceptedCount, acceptedSearchEntryIds, result });
  };
  let canonical = await canonicalize(searched);
  const rejections = searched.evidence.backend === "OPENSEARCH"
    ? await classifyMemoryLexicalCanonicalRejections({
        acceptedSearchEntryIds: canonical.acceptedSearchEntryIds,
        candidates: searched.candidates,
        client: input.client,
        deadlineAtMs: input.deadlineAtMs ??
          Date.now() + MEMORY_READ_BUDGET_MS.CANONICAL_REJOIN_EXPANSION,
        snapshot: input.snapshot
      })
    : Object.freeze({
        rejectedAuthorityCount: 0,
        rejectedGenerationCount: 0,
        rejectedHashCount: 0
      });
  const rejectedCandidateCount = rejections.rejectedAuthorityCount +
    rejections.rejectedGenerationCount + rejections.rejectedHashCount;
  if (searched.evidence.backend === "OPENSEARCH" &&
    searched.evidence.failureCode === null &&
    searched.evidence.projectionCaughtUp === true &&
    searched.candidates.length > 0 && canonical.acceptedCount === 0 &&
    rejectedCandidateCount > 0 &&
    supportsMemoryLexicalCanonicalGuardFallback(input.provider)) {
    searched = await input.provider.fallbackAfterCanonicalGuard(
      request,
      searched.evidence
    );
    assertMemoryLexicalSearchResult(request, searched, "POSTGRES");
    searched = boundMemoryLexicalCanonicalSearchResult(searched);
    assertMemoryLexicalSearchResult(request, searched, "POSTGRES");
    if (searched.evidence.lane !== input.lane) {
      throw new Error("memory_lexical_search_result_invalid");
    }
    canonical = await canonicalize(searched);
  }
  return Object.freeze({
    completeVariantAccepted: hasAcceptedCompleteMemoryLexicalVariant({
      acceptedSearchEntryIds: canonical.acceptedSearchEntryIds,
      candidates: searched.candidates,
      request
    }),
    evidence: Object.freeze({
      ...searched.evidence,
      canonicalAcceptedCount: canonical.acceptedCount,
      durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
      ...rejections
    }),
    rawCandidates: searched.candidates,
    result: canonical.result
  });
}

function orderedLexicalEvidence(
  evidence: readonly MemoryLexicalLaneEvidence[]
): readonly MemoryLexicalLaneEvidence[] {
  return Object.freeze([...evidence].sort((left, right) =>
    left.lane.localeCompare(right.lane) ||
    left.backend.localeCompare(right.backend) ||
    left.requestedLimit - right.requestedLimit ||
    (left.failureCode ?? "").localeCompare(right.failureCode ?? "") ||
    left.rawCandidateCount - right.rawCandidateCount ||
    left.canonicalAcceptedCount - right.canonicalAcceptedCount ||
    left.durationMs - right.durationMs));
}

type MemoryLexicalShadowLaneSpec = Readonly<{
  lane: PostgresUnicodeMemoryLexicalLane;
  limit: number;
  queryLimit: number;
  sourceDiversity: boolean;
}>;

type MemoryLexicalShadowLaneExecution = Readonly<{
  completeVariantAccepted: boolean;
  evidence: MemoryLexicalLaneEvidence;
  rawCandidates: readonly MemoryLexicalRawCandidate[];
  result: MemoryLaneResult;
}>;

async function executeMemoryLexicalShadowLane(input: Readonly<{
  client: PrismaClient;
  deadlineAtMs: number;
  plan: MemoryRetrievalPlan;
  runtime: MemoryLexicalShadowRuntime;
  snapshot: MemoryLocalRetrievalSnapshot;
  sourceChatIds?: readonly string[];
  spec: MemoryLexicalShadowLaneSpec;
}>): Promise<MemoryLexicalShadowLaneExecution> {
  try {
    return await queryProviderBackedLexicalLane({
      client: input.client,
      deadlineAtMs: input.deadlineAtMs,
      lane: input.spec.lane,
      limit: input.spec.limit,
      plan: input.plan,
      provider: input.runtime.providerForLane(input.spec.lane),
      queryLimit: input.spec.queryLimit,
      snapshot: input.snapshot,
      sourceChatIds: input.sourceChatIds,
      sourceDiversity: input.spec.sourceDiversity
    });
  } catch (error) {
    const evidence: MemoryLexicalLaneEvidence[] = [];
    const recorder = createLexicalEvidenceRecorder(
      evidence,
      input.spec.lane,
      input.spec.queryLimit,
      "OPENSEARCH"
    );
    const recorded = recorder.failure(error);
    if (!recorded) throw new Error("memory_lexical_evidence_invalid");
    return Object.freeze({
      completeVariantAccepted: false,
      evidence: recorded,
      rawCandidates: Object.freeze([]),
      result: Object.freeze({ candidates: Object.freeze([]), lane: input.spec.lane })
    });
  }
}

function shadowLaneReceipt(input: Readonly<{
  execution: MemoryLexicalShadowLaneExecution;
  postgresEvidence: readonly MemoryLexicalLaneEvidence[];
  referenceResults: readonly MemoryLaneResult[];
}>): MemoryLexicalShadowLaneReceipt {
  const lane = input.execution.result.lane;
  if (!isShadowedMemoryLexicalLane(lane)) {
    throw new Error("memory_lexical_shadow_lane_invalid");
  }
  const reference = input.referenceResults.find((result) => result.lane === lane);
  const postgres = input.postgresEvidence.find((entry) =>
    entry.backend === "POSTGRES" && entry.lane === lane);
  return memoryLexicalShadowLaneReceipt({
    candidate: input.execution.result.candidates,
    lane,
    openSearchCandidates: input.execution.rawCandidates,
    openSearchEvidence: input.execution.evidence,
    postgresCanonicalAcceptedCount:
      postgres?.canonicalAcceptedCount ?? reference?.candidates.length ?? 0,
    postgresRawCandidateCount:
      postgres?.rawCandidateCount ?? reference?.candidates.length ?? 0,
    reference: reference?.candidates ?? []
  });
}

function scheduleMemoryLexicalShadowStage(input: Readonly<{
  client: PrismaClient;
  plan: MemoryRetrievalPlan;
  postgresEvidence: readonly MemoryLexicalLaneEvidence[];
  referenceResults: readonly MemoryLaneResult[];
  runtime: MemoryLexicalShadowRuntime | null;
  snapshot: MemoryLocalRetrievalSnapshot;
  sourceChatIds?: readonly string[];
  specs: readonly MemoryLexicalShadowLaneSpec[];
  stage: MemoryLexicalShadowStage;
}>): void {
  if (!input.runtime || input.specs.length === 0) return;
  input.runtime.submit({
    stage: input.stage,
    async work(deadlineAtMs) {
      const primarySpecs = input.specs.filter(({ lane }) =>
        lane.endsWith("_LEXICAL_UNICODE"));
      const primary = await Promise.all(primarySpecs.map((spec) =>
        executeMemoryLexicalShadowLane({
          client: input.client,
          deadlineAtMs,
          plan: input.plan,
          runtime: input.runtime!,
          snapshot: input.snapshot,
          sourceChatIds: input.sourceChatIds,
          spec
        })));
      const completePrimaryLanes = new Set<MemoryRetrievalLane>(primary
        .filter(({ completeVariantAccepted }) => completeVariantAccepted)
        .map(({ result }) => result.lane));
      const fallbackSpecs = input.specs.filter(({ lane }) =>
        lane.endsWith("_LEXICAL_NGRAM") && primary.some((execution) =>
          execution.result.lane.startsWith(lane.startsWith("FACT_")
            ? "FACT_"
            : "HISTORY_") && execution.evidence.failureCode === null &&
          execution.evidence.projectionCaughtUp === true) &&
        shouldRunMemoryNgramFallback(
          lane,
          primary.map(({ result }) => result),
          completePrimaryLanes
        ));
      const fallback = await Promise.all(fallbackSpecs.map((spec) =>
        executeMemoryLexicalShadowLane({
          client: input.client,
          deadlineAtMs,
          plan: input.plan,
          runtime: input.runtime!,
          snapshot: input.snapshot,
          sourceChatIds: input.sourceChatIds,
          spec
        })));
      return [...primary, ...fallback]
        .map((execution) => shadowLaneReceipt({
          execution,
          postgresEvidence: input.postgresEvidence,
          referenceResults: input.referenceResults
        }))
        .sort((left, right) => left.lane.localeCompare(right.lane));
    }
  });
}

function pushLexicalTasks(
  tasks: MemoryRetrievalLaneTask[],
  client: PrismaClient,
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  allocation: MemoryRetrievalLaneLimitAllocation,
  evidence: MemoryLexicalLaneEvidence[],
  providerForLane: MemoryLexicalProviderForLane,
  executionTier: "BASELINE" | "ENRICHED" = "ENRICHED"
): Readonly<{
  completePrimaryLanes(): ReadonlySet<MemoryRetrievalLane>;
  deferredTasks: readonly MemoryRetrievalLaneTask[];
  evidence(): readonly MemoryLexicalLaneEvidence[];
  failures(): readonly MemoryRetrievalLane[];
  shadowSpecs: readonly MemoryLexicalShadowLaneSpec[];
  state(): MemoryLocalRetrievalResult["lexicalState"];
}> {
  const completePrimaryLanes = new Set<MemoryRetrievalLane>();
  const failures: MemoryRetrievalLane[] = [];
  const executionEvidence: MemoryLexicalLaneEvidence[] = [];
  const deferredTasks: MemoryRetrievalLaneTask[] = [];
  const shadowSpecs: MemoryLexicalShadowLaneSpec[] = [];
  const lanes = localLexicalLanes(snapshot, plan);
  for (const lane of lanes) {
    const limit = allocatedLimit(allocation, lane, plan.aggregationRequested);
    const sourceDiversity = plan.aggregationRequested &&
      lane.startsWith("HISTORY_RECALL_");
    const queryLimit = sourceDiversity
      ? MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES
      : limit;
    const providerBacked = plan.mode !== "HISTORY_OVERVIEW" &&
      isPostgresUnicodeMemoryLexicalLane(lane);
    const provider = providerBacked ? providerForLane(lane) : null;
    const sql = providerBacked ? null : laneSql(snapshot, plan, lane, queryLimit);
    const recorder = createLexicalEvidenceRecorder(
      evidence,
      lane,
      queryLimit,
      provider?.backend
    );
    if (isShadowedMemoryLexicalLane(lane)) shadowSpecs.push(Object.freeze({
      lane,
      limit,
      queryLimit,
      sourceDiversity
    }));
    const task: MemoryRetrievalLaneTask = {
      executionId: `${executionTier}:${lane}`,
      async execute() {
        try {
          if (lane === "FACT_ENTITY" &&
            !await hasPotentialEntityAlias(client, snapshot, plan)) {
            const recorded = recorder.success();
            if (recorded) executionEvidence.push(recorded);
            return { candidates: [], lane };
          }
          if (provider && isPostgresUnicodeMemoryLexicalLane(lane)) {
            const queried = await queryProviderBackedLexicalLane({
              client,
              lane,
              limit,
              plan,
              provider,
              queryLimit,
              snapshot,
              sourceDiversity
            });
            if (queried.completeVariantAccepted) completePrimaryLanes.add(lane);
            const recorded = recorder.complete(queried.evidence);
            if (recorded) executionEvidence.push(recorded);
            return queried.result;
          }
          if (!sql) throw new Error("memory_retrieval_lane_contract_invalid");
          const result = await queryLane(client, lane, limit, sql, {
            maximumRows: queryLimit,
            recordCounts: recorder.counts,
            sourceDiversity
          });
          const recorded = recorder.success();
          if (recorded) executionEvidence.push(recorded);
          return result;
        } catch (error) {
          const recorded = recorder.failure(error);
          if (recorded) {
            executionEvidence.push(recorded);
            failures.push(lane);
          }
          return { candidates: [], lane };
        }
      },
      lane,
      onUnavailable() {
        const recorded = recorder.settled();
        if (recorded) {
          executionEvidence.push(recorded);
          failures.push(lane);
        }
      }
    };
    if (lane === "FACT_LEXICAL_NGRAM" || lane === "HISTORY_RECALL_LEXICAL_NGRAM") {
      deferredTasks.push(task);
    } else {
      tasks.push(task);
    }
  }
  return {
    completePrimaryLanes: () => new Set(completePrimaryLanes),
    deferredTasks: Object.freeze(deferredTasks),
    evidence: () => orderedLexicalEvidence(executionEvidence),
    failures: () => [...failures].sort((left, right) => left.localeCompare(right)),
    shadowSpecs: Object.freeze(shadowSpecs),
    state: () => lanes.length === 0 ? "DISABLED" : failures.length === 0 ? "READY"
      : failures.length === lanes.length ? "FAILED" : "DEGRADED"
  };
}

function vectorRawCandidatesSql(
  hits: readonly Readonly<{ entryId: string; score: number }>[]
): Prisma.Sql {
  if (hits.length === 0) throw new Error("memory_vector_search_result_invalid");
  return Prisma.join(hits.map((hit) => Prisma.sql`(
    ${hit.entryId}::text,
    ${hit.score}::double precision
  )`));
}

function vectorMetadataSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  hits: readonly Readonly<{ entryId: string; score: number }>[],
  limit: number,
  sourceChatIds?: readonly string[]
): Prisma.Sql {
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(
        snapshot,
        plan,
        "INDEXED",
        Prisma.sql`TRUE`,
        "BOUNDED_CANDIDATES"
      )
    : historyEligibleSelect(
        snapshot,
        plan,
        Prisma.sql`TRUE`,
        sourceChatIds,
        "BOUNDED_CANDIDATES"
      );
  return Prisma.sql`
    WITH vector_raw_candidates ("searchEntryId", "rankScore") AS MATERIALIZED (
      VALUES ${vectorRawCandidatesSql(hits)}
    ),
    candidate_entries AS MATERIALIZED (
      SELECT ${boundedMemorySearchEntryColumnsSql()}
      FROM vector_raw_candidates AS vector_candidate
      INNER JOIN "MemorySearchEntry" AS entry
        ON entry."id" = vector_candidate."searchEntryId"
      WHERE entry."userId" = ${snapshot.userId}
        AND entry."indexGenerationId" = ${snapshot.activeGenerationId}
    ),
    eligible AS MATERIALIZED (${eligible}),
    matched_candidates AS MATERIALIZED (
      SELECT eligible.*, vector_candidate."rankScore"
      FROM eligible
      INNER JOIN vector_raw_candidates AS vector_candidate
        ON vector_candidate."searchEntryId" = eligible."entryId"
    )
    SELECT ${candidateColumns(Prisma.sql`eligible."rankScore"`)}
    FROM matched_candidates AS eligible
    ORDER BY eligible."rankScore" DESC, eligible."itemId" LIMIT ${limit}
  `;
}

function localVectorLanes(
  snapshot: MemoryLocalRetrievalSnapshot,
  input: MemoryLocalRetrievalInput
): readonly MemoryRetrievalLane[] {
  if (!input.plan.queryPresent || !input.vector || snapshot.indexMode !== "HYBRID") return [];
  const lanes: MemoryRetrievalLane[] = [];
  if (!input.plan.profileRequested && snapshot.useMemoryFacts &&
    (input.plan.filters.sourceKinds.includes("FACT") ||
    input.plan.filters.sourceKinds.includes("EVENT"))) lanes.push("FACT_VECTOR");
  if (!input.plan.profileRequested && input.plan.mode !== "HISTORY_OVERVIEW" &&
    snapshot.useMemoryFacts && snapshot.referenceChatHistory &&
    input.plan.filters.sourceKinds.includes("HISTORY")) {
    lanes.push("HISTORY_RECALL_VECTOR");
  }
  return lanes;
}

function pushVectorTasks(
  tasks: Array<Parameters<typeof executeMemoryRetrievalLaneTasks>[0][number]>,
  client: PrismaClient,
  snapshot: MemoryLocalRetrievalSnapshot,
  input: MemoryLocalRetrievalInput,
  evidence: MemoryVectorLaneEvidence[],
  allocation: MemoryRetrievalLaneLimitAllocation,
  executionTier: "BASELINE" | "ENRICHED" = "ENRICHED"
): Readonly<{ state(): MemoryLocalRetrievalResult["vectorState"] }> {
  if (!input.vector || snapshot.indexMode !== "HYBRID") {
    return { state: () => input.vector ? "DISABLED" : "NOT_CONFIGURED" };
  }
  const lanes = localVectorLanes(snapshot, input);
  if (lanes.length === 0) return { state: () => "DISABLED" };
  const itemTypes = [...new Set(lanes.flatMap((lane) =>
    lane === "FACT_VECTOR"
      ? ["FACT_VERSION" as const]
      : [
          "RECALL_CHUNK" as const,
          ...(input.plan.filters.sourceKinds.includes("HISTORY")
            ? ["TOOL_EVENT" as const]
            : []),
          snapshot.roundSegmentProjectionVersion ===
            MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION
            ? "RECALL_ROUND_SEGMENT" as const
            : "RECALL_ROUND" as const
        ]))];
  const limit = Math.max(...lanes.map((lane) =>
    allocatedLimit(allocation, lane, input.plan.aggregationRequested)));
  let state: MemoryLocalRetrievalResult["vectorState"] = "READY";
  const result = createPrismaMemoryVectorRepository(client).search({
    eligibility: {
      allowedFactSensitivity: ["NORMAL", "SENSITIVE"],
      allowedHistorySafety: ["NORMAL", "SENSITIVE"],
      assistantId: snapshot.assistantId,
      chatId: snapshot.chatId,
      factMode: input.plan.mode === "HISTORICAL_MEMORY" ? "HISTORICAL" : "CURRENT",
      includePatterns: input.plan.includePatterns,
      factTemporalAsOf: null,
      folderId: snapshot.folderId,
      occurredFrom: null,
      occurredTo: null,
      sourceAssistantId: input.plan.filters.scopeType === "ASSISTANT"
        ? input.plan.filters.scopeTargetId
        : null,
      sourceChatIds: input.plan.filters.scopeType === "CHAT" &&
        input.plan.filters.scopeTargetId
        ? [input.plan.filters.scopeTargetId]
        : null,
      sourceFolderId: input.plan.filters.scopeType === "FOLDER"
        ? input.plan.filters.scopeTargetId
        : null
    },
    itemTypes,
    limit,
    minimumScore: input.vector.minimumScore,
    profile: input.vector.profile,
    userId: snapshot.userId,
    vector: input.vector.vector
  }).then((value) => {
    if (value.status === "DEGRADED") state = "DEGRADED";
    else evidence.push(...value.lanes);
    return value;
  }).catch(() => {
    state = "DEGRADED";
    return { hits: [], lanes: [], reason: "memory_vector_unavailable" as const,
      status: "DEGRADED" as const };
  });
  for (const lane of lanes) {
    const itemType = lane === "FACT_VECTOR" ? "FACT_VERSION" as const :
      "RECALL_CHUNK" as const;
    const laneLimit = allocatedLimit(allocation, lane, input.plan.aggregationRequested);
    tasks.push({
      executionId: `${executionTier}:${lane}`,
      async execute() {
        const searched = await result;
        if (searched.status !== "READY") return { candidates: [], lane };
        const hits = searched.hits.filter((hit) => lane === "FACT_VECTOR"
          ? hit.itemType === "FACT_VERSION"
          : hit.itemType === "RECALL_CHUNK" || hit.itemType === "RECALL_ROUND" ||
            hit.itemType === "RECALL_ROUND_SEGMENT" || hit.itemType === "TOOL_EVENT");
        return hits.length === 0 ? { candidates: [], lane }
          : queryLane(client, lane, laneLimit,
              vectorMetadataSql(snapshot, input.plan, itemType, hits, laneLimit), {
                readBudgetMs: MEMORY_READ_BUDGET_MS.VECTOR_METADATA_REJOIN,
                sourceDiversity: input.plan.aggregationRequested &&
                  lane === "HISTORY_RECALL_VECTOR"
              });
      },
      lane,
      onUnavailable() {
        state = "DEGRADED";
      }
    });
  }
  return { state: () => state };
}

type MemoryIntraChatRawSelection = Readonly<{
  candidates: readonly MemoryLaneCandidate[];
  rawCandidateCount: number;
}>;

function historyRepresentationPriority(candidate: Pick<
  MemoryLaneCandidate,
  "itemType" | "matchedSegmentId"
>): number {
  return candidate.itemType === "RECALL_ROUND"
    ? candidate.matchedSegmentId ? 2 : 1
    : 0;
}

/** Rank-only Stage B fusion. Raw scores remain lane-local diagnostics; the
 * synthetic lane carries one contribution per evidence root into global RRF. */
export function selectMemoryIntraChatRawCandidates(input: Readonly<{
  excludedEvidenceRoots?: readonly string[];
  laneResults: readonly MemoryLaneResult[];
  perChatLimit: number;
  selectedSourceChatIds: readonly string[];
}>): MemoryIntraChatRawSelection {
  if (
    input.selectedSourceChatIds.length < 1 ||
    input.selectedSourceChatIds.length > MEMORY_RETRIEVAL_COMPLEX_DIGEST_CHATS ||
    new Set(input.selectedSourceChatIds).size !== input.selectedSourceChatIds.length ||
    input.selectedSourceChatIds.some((sourceChatId) => !validToken(sourceChatId)) ||
    ![
      MEMORY_RETRIEVAL_TARGETED_RAW_ANCHORS_PER_CHAT,
      MEMORY_RETRIEVAL_COMPLEX_RAW_ANCHORS_PER_CHAT
    ].includes(input.perChatLimit)
  ) throw new Error("memory_intra_chat_selection_invalid");
  const selectedSources = new Set(input.selectedSourceChatIds);
  const sourceOrder = new Map(input.selectedSourceChatIds.map((sourceChatId, index) =>
    [sourceChatId, index]));
  const excludedRoots = new Set(input.excludedEvidenceRoots ?? []);
  type Aggregate = {
    candidate: MemoryLaneCandidate;
    deterministicMatch: MemoryDeterministicMatch | null;
    score: number;
  };
  const byRoot = new Map<string, Aggregate>();
  for (const result of input.laneResults) {
    if (!result.lane.startsWith("HISTORY_RECALL_") ||
      result.lane === "HISTORY_RECALL_RECENT") {
      throw new Error("memory_intra_chat_selection_invalid");
    }
    const laneCandidates: MemoryLaneCandidate[] = [];
    const indexesByRoot = new Map<string, number>();
    for (const candidate of result.candidates) {
      const sourceChatId = candidate.metadata.sourceChatId;
      if (candidate.lane !== result.lane || candidate.itemType === "FACT_VERSION" ||
        !sourceChatId || !selectedSources.has(sourceChatId)) {
        throw new Error("memory_intra_chat_selection_invalid");
      }
      const root = memoryRetrievalEvidenceRootKey(candidate);
      const previousIndex = indexesByRoot.get(root);
      if (previousIndex === undefined) {
        indexesByRoot.set(root, laneCandidates.length);
        laneCandidates.push(candidate);
      } else if (historyRepresentationPriority(candidate) >
        historyRepresentationPriority(laneCandidates[previousIndex]!)) {
        laneCandidates[previousIndex] = candidate;
      }
    }
    laneCandidates.forEach((candidate, index) => {
      const root = memoryRetrievalEvidenceRootKey(candidate);
      const previous = byRoot.get(root);
      const deterministicMatch = previous?.deterministicMatch ??
        candidate.deterministicMatch ?? null;
      const representative = previous &&
        historyRepresentationPriority(previous.candidate) >=
          historyRepresentationPriority(candidate)
        ? previous.candidate
        : candidate;
      byRoot.set(root, {
        candidate: representative,
        deterministicMatch,
        score: (previous?.score ?? 0) +
          MEMORY_RETRIEVAL_LANE_WEIGHTS[result.lane] /
            (MEMORY_RETRIEVAL_RRF_K + index + 1)
      });
    });
  }
  const selected: MemoryLaneCandidate[] = [];
  const countsBySource = new Map<string, number>();
  const maximum = input.selectedSourceChatIds.length * input.perChatLimit;
  for (const [root, aggregate] of [...byRoot.entries()].sort((left, right) =>
    right[1].score - left[1].score ||
    (sourceOrder.get(left[1].candidate.metadata.sourceChatId!) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(right[1].candidate.metadata.sourceChatId!) ?? Number.MAX_SAFE_INTEGER) ||
    historyRepresentationPriority(right[1].candidate) -
      historyRepresentationPriority(left[1].candidate) ||
    left[1].candidate.itemId.localeCompare(right[1].candidate.itemId))) {
    if (excludedRoots.has(root)) continue;
    const sourceChatId = aggregate.candidate.metadata.sourceChatId!;
    const sourceCount = countsBySource.get(sourceChatId) ?? 0;
    if (sourceCount >= input.perChatLimit) continue;
    countsBySource.set(sourceChatId, sourceCount + 1);
    selected.push({
      ...aggregate.candidate,
      deterministicMatch: aggregate.deterministicMatch,
      lane: "HISTORY_INTRA_CHAT_RAW",
      rawScore: aggregate.score
    });
    if (selected.length >= maximum) break;
  }
  return Object.freeze({
    candidates: Object.freeze(selected),
    rawCandidateCount: byRoot.size
  });
}

const emptyDigestEvidence = Object.freeze({
  digestOnlyChatCount: 0,
  navigationCandidateCount: 0,
  rawAnchorCount: 0,
  rawCandidateCount: 0,
  secondStageQueryCount: 0,
  selectedChatCount: 0
}) satisfies MemoryDigestRetrievalEvidence;

type MemoryDigestIntraChatStageResult = Readonly<{
  digestEvidence: MemoryDigestRetrievalEvidence;
  laneResults: readonly MemoryLaneResult[];
  lexicalFailures: readonly MemoryRetrievalLane[];
  lexicalState: MemoryLocalRetrievalResult["lexicalState"];
  vectorState: MemoryLocalRetrievalResult["vectorState"];
}>;

async function executeDigestIntraChatStage(input: Readonly<{
  client: PrismaClient;
  lexicalEvidence: MemoryLexicalLaneEvidence[];
  providerForLane: MemoryLexicalProviderForLane;
  retrievalInput: MemoryLocalRetrievalInput;
  shadowRuntime: MemoryLexicalShadowRuntime | null;
  snapshot: MemoryLocalRetrievalSnapshot;
  laneResults: readonly MemoryLaneResult[];
  settleSignal?: AbortSignal;
  vectorEvidence: MemoryVectorLaneEvidence[];
}>): Promise<MemoryDigestIntraChatStageResult> {
  const digestResult = input.laneResults.find(({ lane }) =>
    lane === "HISTORY_DIGEST_FTS_SIMPLE");
  const navigationCandidates = digestResult?.candidates ?? [];
  const chatLimit = input.retrievalInput.plan.aggregationRequested
    ? MEMORY_RETRIEVAL_COMPLEX_DIGEST_CHATS
    : MEMORY_RETRIEVAL_TARGETED_DIGEST_CHATS;
  const selectedDigests: MemoryLaneCandidate[] = [];
  const selectedSourceChatIds: string[] = [];
  const seenSources = new Set<string>();
  for (const candidate of navigationCandidates) {
    const sourceChatId = candidate.metadata.sourceChatId;
    if (!sourceChatId || seenSources.has(sourceChatId)) continue;
    seenSources.add(sourceChatId);
    selectedSourceChatIds.push(sourceChatId);
    selectedDigests.push(candidate);
    if (selectedSourceChatIds.length >= chatLimit) break;
  }
  if (selectedSourceChatIds.length === 0) {
    return {
      digestEvidence: emptyDigestEvidence,
      laneResults: input.laneResults,
      lexicalFailures: [],
      lexicalState: "DISABLED",
      vectorState: "DISABLED"
    };
  }

  const perChatLimit = input.retrievalInput.plan.aggregationRequested
    ? MEMORY_RETRIEVAL_COMPLEX_RAW_ANCHORS_PER_CHAT
    : MEMORY_RETRIEVAL_TARGETED_RAW_ANCHORS_PER_CHAT;
  const rawLimit = selectedSourceChatIds.length * perChatLimit;
  const queryLimit = Math.min(
    MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES,
    rawLimit * 2
  );
  const tasks: MemoryRetrievalLaneTask[] = [];
  const completePrimaryLanes = new Set<MemoryRetrievalLane>();
  const deferredNgramTasks: MemoryRetrievalLaneTask[] = [];
  const executionEvidence: MemoryLexicalLaneEvidence[] = [];
  const lexicalFailures: MemoryRetrievalLane[] = [];
  const shadowSpecs: MemoryLexicalShadowLaneSpec[] = [];
  const lexicalLanes = localLexicalLanes(
    input.snapshot,
    input.retrievalInput.plan
  ).filter((lane) => lane.startsWith("HISTORY_RECALL_") &&
    lane !== "HISTORY_RECALL_RECENT");
  for (const lane of lexicalLanes) {
    const provider = isPostgresUnicodeMemoryLexicalLane(lane)
      ? input.providerForLane(lane)
      : null;
    const recorder = createLexicalEvidenceRecorder(
      input.lexicalEvidence,
      lane,
      queryLimit,
      provider?.backend
    );
    if (isShadowedMemoryLexicalLane(lane)) shadowSpecs.push(Object.freeze({
      lane,
      limit: queryLimit,
      queryLimit,
      sourceDiversity: true
    }));
    const task: MemoryRetrievalLaneTask = {
      executionId: `INTRA_CHAT:${lane}`,
      async execute() {
        try {
          if (provider && isPostgresUnicodeMemoryLexicalLane(lane)) {
            const queried = await queryProviderBackedLexicalLane({
              client: input.client,
              lane,
              limit: queryLimit,
              plan: input.retrievalInput.plan,
              provider,
              queryLimit,
              snapshot: input.snapshot,
              sourceChatIds: selectedSourceChatIds,
              sourceDiversity: true
            });
            if (queried.completeVariantAccepted) completePrimaryLanes.add(lane);
            const recorded = recorder.complete(queried.evidence);
            if (recorded) executionEvidence.push(recorded);
            return queried.result;
          }
          const result = await queryLane(
            input.client,
            lane,
            queryLimit,
            laneSql(
              input.snapshot,
              input.retrievalInput.plan,
              lane,
              queryLimit,
              selectedSourceChatIds
            ),
            {
              maximumRows: queryLimit,
              recordCounts: recorder.counts,
              sourceDiversity: true
            }
          );
          const recorded = recorder.success();
          if (recorded) executionEvidence.push(recorded);
          return result;
        } catch (error) {
          const recorded = recorder.failure(error);
          if (recorded) {
            executionEvidence.push(recorded);
            lexicalFailures.push(lane);
          }
          return { candidates: [], lane };
        }
      },
      lane,
      onUnavailable() {
        const recorded = recorder.settled();
        if (recorded) {
          executionEvidence.push(recorded);
          lexicalFailures.push(lane);
        }
      }
    };
    if (lane === "HISTORY_RECALL_LEXICAL_NGRAM") deferredNgramTasks.push(task);
    else tasks.push(task);
  }

  let vectorState: MemoryLocalRetrievalResult["vectorState"] =
    input.retrievalInput.vector ? "DISABLED" : "NOT_CONFIGURED";
  if (input.retrievalInput.vector && input.snapshot.indexMode === "HYBRID") {
    vectorState = "READY";
    const vector = input.retrievalInput.vector;
    const vectorResult = createPrismaMemoryVectorRepository(input.client).search({
      eligibility: {
        allowedFactSensitivity: ["NORMAL", "SENSITIVE"],
        allowedHistorySafety: ["NORMAL", "SENSITIVE"],
        assistantId: input.snapshot.assistantId,
        chatId: input.snapshot.chatId,
        factMode: "CURRENT",
        includePatterns: false,
        factTemporalAsOf: null,
        folderId: input.snapshot.folderId,
        occurredFrom: null,
        occurredTo: null,
        sourceAssistantId: input.retrievalInput.plan.filters.scopeType === "ASSISTANT"
          ? input.retrievalInput.plan.filters.scopeTargetId
          : null,
        sourceChatIds: selectedSourceChatIds,
        sourceFolderId: input.retrievalInput.plan.filters.scopeType === "FOLDER"
          ? input.retrievalInput.plan.filters.scopeTargetId
          : null
      },
      itemTypes: [
        "RECALL_CHUNK",
        input.snapshot.roundSegmentProjectionVersion ===
          MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION
          ? "RECALL_ROUND_SEGMENT"
          : "RECALL_ROUND"
      ],
      limit: rawLimit,
      minimumScore: vector.minimumScore,
      profile: vector.profile,
      userId: input.snapshot.userId,
      vector: vector.vector
    }).then((result) => {
      if (result.status === "READY") input.vectorEvidence.push(...result.lanes);
      else vectorState = "DEGRADED";
      return result;
    }).catch(() => {
      vectorState = "DEGRADED";
      return { hits: [], lanes: [], reason: "memory_vector_unavailable" as const,
        status: "DEGRADED" as const };
    });
    tasks.push({
      executionId: "INTRA_CHAT:HISTORY_RECALL_VECTOR",
      async execute() {
        const searched = await vectorResult;
        if (searched.status !== "READY") {
          return { candidates: [], lane: "HISTORY_RECALL_VECTOR" };
        }
        const hits = searched.hits.filter((hit) =>
          hit.itemType === "RECALL_CHUNK" || hit.itemType === "RECALL_ROUND" ||
          hit.itemType === "RECALL_ROUND_SEGMENT");
        if (hits.length === 0) {
          return { candidates: [], lane: "HISTORY_RECALL_VECTOR" };
        }
        try {
          return await queryLane(
            input.client,
            "HISTORY_RECALL_VECTOR",
            rawLimit,
            vectorMetadataSql(
              input.snapshot,
              input.retrievalInput.plan,
              "RECALL_CHUNK",
              hits,
              rawLimit,
              selectedSourceChatIds
            ),
            {
              maximumRows: rawLimit,
              readBudgetMs: MEMORY_READ_BUDGET_MS.VECTOR_METADATA_REJOIN,
              sourceDiversity: true
            }
          );
        } catch {
          vectorState = "DEGRADED";
          return { candidates: [], lane: "HISTORY_RECALL_VECTOR" };
        }
      },
      lane: "HISTORY_RECALL_VECTOR"
    });
  }

  const primaryStageResults = await executeMemoryRetrievalLaneTasks(
    tasks,
    MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
    input.settleSignal
  );
  const runnableNgramTasks = deferredNgramTasks.filter((task) =>
    shouldRunMemoryNgramFallback(
      task.lane,
      primaryStageResults,
      completePrimaryLanes
    ));
  const trigramResults = runnableNgramTasks.length > 0
    ? await executeMemoryRetrievalLaneTasks(
        runnableNgramTasks,
        MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
        input.settleSignal
      )
    : [];
  const trigramByExecutionId = new Map(runnableNgramTasks.map((task, index) => [
    task.executionId!,
    trigramResults[index]!
  ]));
  const stageResults = orderedExecutionLaneResults([
    ...primaryStageResults,
    ...deferredNgramTasks.map((task) =>
      trigramByExecutionId.get(task.executionId!) ?? {
        candidates: [],
        lane: task.lane
      })
  ]);
  scheduleMemoryLexicalShadowStage({
    client: input.client,
    plan: input.retrievalInput.plan,
    postgresEvidence: executionEvidence,
    referenceResults: stageResults,
    runtime: input.shadowRuntime,
    snapshot: input.snapshot,
    sourceChatIds: selectedSourceChatIds,
    specs: shadowSpecs,
    stage: "INTRA_CHAT"
  });
  const selectedRaw = selectMemoryIntraChatRawCandidates({
    laneResults: stageResults,
    perChatLimit,
    selectedSourceChatIds
  });
  const stageRawSourceChats = new Set(selectedRaw.candidates.flatMap((candidate) =>
    candidate.metadata.sourceChatId ? [candidate.metadata.sourceChatId] : []));
  // The focused result replaces matching global projections from the same
  // selected chats. This preserves separate Stage B attribution without
  // allowing a duplicate root to contribute a second global RRF vote.
  const deduplicatedGlobalResults = input.laneResults.map((result) =>
    result.lane === "HISTORY_DIGEST_FTS_SIMPLE"
      ? result
      : {
          candidates: result.candidates.filter((candidate) =>
            candidate.itemType === "FACT_VERSION" ||
            !candidate.metadata.sourceChatId ||
            !stageRawSourceChats.has(candidate.metadata.sourceChatId)),
          lane: result.lane
        });
  const globalRawResults = deduplicatedGlobalResults.filter(({ lane }) =>
    lane !== "HISTORY_DIGEST_FTS_SIMPLE");
  const rawSourceChats = new Set([
    ...globalRawResults.flatMap(({ candidates }) => candidates.flatMap((candidate) =>
      candidate.itemType !== "FACT_VERSION" && candidate.metadata.sourceChatId
        ? [candidate.metadata.sourceChatId]
        : [])),
    ...selectedRaw.candidates.flatMap((candidate) =>
      candidate.metadata.sourceChatId ? [candidate.metadata.sourceChatId] : [])
  ]);
  const retainedDigests = selectedDigests.filter((candidate) =>
    !rawSourceChats.has(candidate.metadata.sourceChatId!));
  const laneResults: MemoryLaneResult[] = [];
  for (const result of deduplicatedGlobalResults) {
    if (result.lane !== "HISTORY_DIGEST_FTS_SIMPLE") {
      laneResults.push(result);
      continue;
    }
    laneResults.push({ candidates: retainedDigests, lane: result.lane });
    if (selectedRaw.candidates.length > 0) laneResults.push({
      candidates: selectedRaw.candidates,
      lane: "HISTORY_INTRA_CHAT_RAW"
    });
  }
  const distinctLexicalFailures = [...new Set(lexicalFailures)];
  const lexicalState: MemoryLocalRetrievalResult["lexicalState"] =
    distinctLexicalFailures.length === 0 ? "READY"
      : distinctLexicalFailures.length === lexicalLanes.length ? "FAILED" : "DEGRADED";
  return {
    digestEvidence: Object.freeze({
      digestOnlyChatCount: retainedDigests.length,
      navigationCandidateCount: navigationCandidates.length,
      rawAnchorCount: selectedRaw.candidates.length,
      rawCandidateCount: selectedRaw.rawCandidateCount,
      secondStageQueryCount: 1,
      selectedChatCount: selectedSourceChatIds.length
    }),
    laneResults: Object.freeze(laneResults),
    lexicalFailures: Object.freeze(distinctLexicalFailures),
    lexicalState,
    vectorState
  };
}

function suppressDigestCandidatesWithRawEvidence(
  laneResults: readonly MemoryLaneResult[]
): readonly MemoryLaneResult[] {
  const rawSourceChats = new Set(laneResults.flatMap(({ lane, candidates }) =>
    lane === "HISTORY_DIGEST_FTS_SIMPLE"
      ? []
      : candidates.flatMap((candidate) =>
          candidate.itemType !== "FACT_VERSION" && candidate.metadata.sourceChatId
            ? [candidate.metadata.sourceChatId]
            : [])));
  return laneResults.map((result) => result.lane === "HISTORY_DIGEST_FTS_SIMPLE"
    ? {
        candidates: result.candidates.filter((candidate) =>
          !rawSourceChats.has(candidate.metadata.sourceChatId!)),
        lane: result.lane
      }
    : result);
}

function currentFactExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${factEligibleSelect(
      snapshot,
      plan,
      "DIRECT",
      Prisma.sql`version."id" IN (${valuesSql(ids)})`
    )})
    SELECT eligible."itemId", eligible."itemType", version."displayText" AS "safeText",
      'FACT_DISPLAY_TEXT'::text AS "projectionKind", NULL::text AS "sourceChatId",
      NULL::text AS "supportingItemId", NULL::timestamp AS "occurredFrom",
      NULL::timestamp AS "occurredTo", NULL::text AS "retrievalHint",
      COALESCE(pattern_supports."evidence", '[]'::jsonb) AS "patternSupportingEvidence",
      '[]'::jsonb AS "supportingEvidence"
    FROM eligible INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = ${snapshot.userId} AND version."id" = eligible."itemId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'itemId', bounded."itemId",
        'observedAt', bounded."observedAt",
        'safeText', bounded."safeText",
        'sourceAuthority', bounded."sourceAuthority",
        'sourceChatId', bounded."sourceChatId",
        'sourceRootHash', bounded."sourceRootHash"
      ) ORDER BY bounded."observedAt" DESC, bounded."itemId"), '[]'::jsonb) AS "evidence"
      FROM (
        SELECT ranked."itemId", ranked."observedAt", ranked."safeText",
          ranked."sourceAuthority", ranked."sourceChatId", ranked."sourceRootHash"
        FROM (
          SELECT support_source.*,
            ROW_NUMBER() OVER (
              PARTITION BY support_source."sourceRootHash"
              ORDER BY support_source."observedAt" DESC, support_source."itemId"
            ) AS "rootOrdinal"
          FROM (
            SELECT source_version."id" AS "itemId",
              source_version."displayText" AS "safeText",
              source_version."observedAt",
              CASE WHEN source_version."sourceMode" =
                  'EXPLICIT'::"MemoryFactSourceMode"
                THEN 'EXPLICIT' ELSE 'DIRECT_AUTOMATIC' END::text
                AS "sourceAuthority",
              automatic_root."chatId" AS "sourceChatId",
              encode(digest(convert_to(
                CASE WHEN source_version."sourceMode" =
                    'EXPLICIT'::"MemoryFactSourceMode"
                  THEN 'explicit:' || source_version."id"
                  ELSE 'message:' || automatic_root."messageId" END,
                'UTF8'
              ), 'sha256'), 'hex') AS "sourceRootHash"
            FROM "MemoryFactVersionRelation" AS relation
            INNER JOIN "MemoryFactVersion" AS source_version
              ON source_version."userId" = relation."userId"
              AND source_version."id" = relation."targetVersionId"
            LEFT JOIN LATERAL (
              SELECT support."chatId", support."messageId"
              FROM "MemoryEvidence" AS support
              INNER JOIN "Chat" AS evidence_chat
                ON evidence_chat."userId" = support."userId"
                AND evidence_chat."id" = support."chatId"
                AND evidence_chat."projectId" IS NULL
                AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
                AND evidence_chat."permanentDeletionAt" IS NULL
              INNER JOIN "Message" AS evidence_message
                ON evidence_message."chatId" = support."chatId"
                AND evidence_message."id" = support."messageId"
                AND evidence_message."role" = 'user'
              WHERE source_version."sourceMode" =
                  'AUTOMATIC'::"MemoryFactSourceMode"
                AND ${memoryPersonalEvidenceRowPredicate(
                  snapshot.userId,
                  Prisma.sql`source_version."id"`,
                  { exactVNext: true }
                )}
              ORDER BY support."observedAt" DESC, support."id"
              LIMIT 1
            ) AS automatic_root ON TRUE
            WHERE relation."userId" = ${snapshot.userId}
              AND relation."sourceVersionId" = eligible."itemId"
              AND relation."kind" =
                'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
              AND (
                source_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
                OR automatic_root."messageId" IS NOT NULL
              )
          ) AS support_source
        ) AS ranked
        WHERE ranked."rootOrdinal" = 1
        ORDER BY ranked."observedAt" DESC, ranked."itemId"
        LIMIT ${MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS}
      ) AS bounded
    ) AS pattern_supports
      ON version."modality" = 'PATTERN'::"MemoryFactModality"
    WHERE eligible."itemId" IN (${valuesSql(ids)}) ORDER BY eligible."itemId"
  `;
}

function chunkExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH ${boundedMemorySearchEntryCandidatesSql(
      snapshot,
      Prisma.sql`entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
        AND entry."recallChunkId" IN (${valuesSql(ids)})`
    )},
    eligible AS MATERIALIZED (${historyChunkEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`TRUE`,
      "BOUNDED_CANDIDATES"
    )})
    SELECT eligible."itemId", eligible."itemType", chunk."safeProjectedText" AS "safeText",
      'RECALL_CHUNK_SAFE_PROJECTED_TEXT'::text AS "projectionKind",
      chunk."chatId" AS "sourceChatId", NULL::text AS "supportingItemId",
      chunk."occurredFrom", chunk."occurredTo", NULL::text AS "retrievalHint",
      '[]'::jsonb AS "patternSupportingEvidence",
      '[]'::jsonb AS "supportingEvidence"
    FROM eligible INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = ${snapshot.userId} AND chunk."id" = eligible."itemId"
    WHERE eligible."itemId" IN (${valuesSql(ids)}) ORDER BY eligible."itemId"
  `;
}

function toolEventExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH ${boundedMemorySearchEntryCandidatesSql(
      snapshot,
      Prisma.sql`entry."itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
        AND entry."toolEventId" IN (${valuesSql(ids)})`
    )},
    eligible AS MATERIALIZED (${toolEventEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`TRUE`,
      "BOUNDED_CANDIDATES"
    )})
    SELECT eligible."itemId", eligible."itemType",
      tool_event."safeProjectedText" AS "safeText",
      'TOOL_EVENT_SAFE_TEXT'::text AS "projectionKind",
      tool_event."chatId" AS "sourceChatId", NULL::text AS "supportingItemId",
      tool_event."occurredAt" AS "occurredFrom",
      tool_event."occurredAt" AS "occurredTo", NULL::text AS "retrievalHint",
      '[]'::jsonb AS "patternSupportingEvidence",
      '[]'::jsonb AS "supportingEvidence"
    FROM eligible
    INNER JOIN "MemoryToolEvent" AS tool_event
      ON tool_event."userId" = ${snapshot.userId}
      AND tool_event."id" = eligible."itemId"
    WHERE eligible."itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
      AND eligible."itemId" IN (${valuesSql(ids)})
    ORDER BY eligible."itemId"
  `;
}

function rawRoundExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH ${boundedMemorySearchEntryCandidatesSql(
      snapshot,
      Prisma.sql`${memoryRoundSearchEntryItemTypePredicate(snapshot)}
        AND entry."recallRoundId" IN (${valuesSql(ids)})`
    )},
    eligible AS MATERIALIZED (${historyRoundEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`TRUE`,
      "BOUNDED_CANDIDATES"
    )})
    SELECT DISTINCT ON (eligible."itemId")
      eligible."itemId", eligible."itemType",
      CASE WHEN char_length(round."rawSafeText") <= 4000
        THEN round."rawSafeText"
        ELSE substring(round."rawSafeText" FROM 1 FOR 4000)
      END AS "safeText",
      'RECALL_ROUND_RAW_SAFE_TEXT'::text AS "projectionKind",
      round."chatId" AS "sourceChatId", round."parentChunkId" AS "supportingItemId",
      round."occurredFrom", round."occurredTo", NULL::text AS "retrievalHint",
      '[]'::jsonb AS "patternSupportingEvidence",
      '[]'::jsonb AS "supportingEvidence"
    FROM eligible INNER JOIN "MemoryRecallRound" AS round
      ON round."userId" = ${snapshot.userId} AND round."id" = eligible."itemId"
    WHERE eligible."itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
      AND eligible."itemId" IN (${valuesSql(ids)})
    ORDER BY eligible."itemId", eligible."matchedSegmentId" NULLS FIRST
  `;
}

type RoundSegmentSelection = Readonly<{ itemId: string; segmentId: string }>;

function segmentRoundExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  selections: readonly RoundSegmentSelection[],
  evidenceView: "FULL" | "USER_TESTIMONY" = "FULL"
): Prisma.Sql {
  const userSpanColumn = evidenceView === "USER_TESTIMONY"
    ? Prisma.sql`, user_spans."spans" AS "userSpans"`
    : Prisma.sql``;
  const userSpanJoin = evidenceView === "USER_TESTIMONY"
    ? Prisma.sql`
      INNER JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'ordinal', segment_message."ordinal",
          'start', segment_message."segmentStartOffset",
          'end', segment_message."segmentEndOffset"
        ) ORDER BY segment_message."ordinal") AS "spans"
        FROM "MemoryRecallRoundSegmentMessage" AS segment_message
        INNER JOIN "MemoryRecallRoundMessage" AS round_message
          ON round_message."userId" = segment_message."userId"
          AND round_message."chatId" = segment_message."chatId"
          AND round_message."roundId" = segment_message."roundId"
          AND round_message."messageId" = segment_message."messageId"
          AND round_message."ordinal" = segment_message."ordinal"
          AND round_message."role" = segment_message."role"
          AND round_message."safeTextHash" = segment_message."safeTextHash"
          AND round_message."sourceMessageContentHash" =
            segment_message."sourceMessageContentHash"
          AND round_message."sourceMessageUpdatedAt" =
            segment_message."sourceMessageUpdatedAt"
        WHERE segment_message."userId" = ${snapshot.userId}
          AND segment_message."chatId" = current_round."chatId"
          AND segment_message."roundId" = current_round."id"
          AND segment_message."segmentId" = segment."id"
          AND segment_message."role" = 'user'
          AND segment_message."sourceStartOffset" >= round_message."sourceStartOffset"
          AND segment_message."sourceEndOffset" <= round_message."sourceEndOffset"
          AND segment_message."sourceEndOffset" > segment_message."sourceStartOffset"
          AND segment_message."segmentEndOffset" > segment_message."segmentStartOffset"
        HAVING COUNT(*) BETWEEN 1 AND 32
      ) AS user_spans ON TRUE`
    : Prisma.sql``;
  return Prisma.sql`
    WITH ${boundedMemorySearchEntryCandidatesSql(
      snapshot,
      Prisma.sql`entry."itemType" =
          'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
        AND (entry."recallRoundId", entry."recallRoundSegmentId") IN (
        ${Prisma.join(selections.map(({ itemId, segmentId }) =>
          Prisma.sql`(${itemId}, ${segmentId})`))}
      )`
    )},
    eligible AS MATERIALIZED (${historySegmentRoundEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`TRUE`,
      "BOUNDED_CANDIDATES"
    )}),
    selected("itemId", "segmentId") AS (VALUES ${Prisma.join(
      selections.map(({ itemId, segmentId }) => Prisma.sql`(${itemId}, ${segmentId})`)
    )})
    SELECT eligible."itemId", eligible."itemType",
      segment."rawSafeText" AS "safeText",
      'RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT'::text AS "projectionKind",
      current_round."chatId" AS "sourceChatId",
      current_round."parentChunkId" AS "supportingItemId",
      segment."occurredFrom", segment."occurredTo",
      CASE WHEN segment."contextualKeyState" = 'GENERATED'
          AND dependencies."allValid"
        THEN segment."contextualNarrativeText" ELSE NULL END AS "retrievalHint",
      '[]'::jsonb AS "patternSupportingEvidence",
      CASE WHEN segment."contextualKeyState" = 'GENERATED'
          AND dependencies."allValid"
        THEN dependencies."supportingEvidence" ELSE '[]'::jsonb
      END AS "supportingEvidence"${userSpanColumn}
    FROM eligible
    INNER JOIN selected
      ON selected."itemId" = eligible."itemId"
      AND selected."segmentId" = eligible."matchedSegmentId"
    INNER JOIN "MemoryRecallRoundSegment" AS segment
      ON segment."userId" = ${snapshot.userId}
      AND segment."roundId" = eligible."itemId"
      AND segment."id" = eligible."matchedSegmentId"
    INNER JOIN "MemoryRecallRound" AS current_round
      ON current_round."userId" = segment."userId"
      AND current_round."id" = segment."roundId"
      AND current_round."supportingRoundIds" = segment."supportingRoundIds"
      AND (segment."contextualKeyState" <> 'GENERATED'
        OR current_round."contextualKeyState" = 'GENERATED')
    ${userSpanJoin}
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) = cardinality(segment."supportingRoundIds")
          AND COUNT(*) = COUNT(DISTINCT dependency_ref."roundId")
          AND cardinality(segment."supportingRoundIds") <= 2 AS "allValid",
        COALESCE(jsonb_agg(jsonb_build_object(
          'itemId', round."id",
          'occurredFrom', round."occurredFrom",
          'occurredTo', round."occurredTo",
          'safeText', CASE WHEN char_length(round."rawSafeText") <= 4000
            THEN round."rawSafeText"
            ELSE substring(round."rawSafeText" FROM 1 FOR 4000) END,
          'sourceChatId', round."chatId"
        ) ORDER BY dependency_ref."ordinal"), '[]'::jsonb) AS "supportingEvidence"
      FROM unnest(segment."supportingRoundIds") WITH ORDINALITY
        AS dependency_ref("roundId", "ordinal")
      INNER JOIN "MemoryRecallRound" AS round
        ON round."userId" = segment."userId"
        AND round."id" = dependency_ref."roundId"
        AND round."id" <> segment."roundId"
        AND round."chatId" = current_round."chatId"
        AND round."roundOrdinal" < current_round."roundOrdinal"
      INNER JOIN "MemoryRecallChunk" AS parent_chunk
        ON parent_chunk."userId" = round."userId"
        AND parent_chunk."id" = round."parentChunkId"
      INNER JOIN "Chat" AS dependency_source_chat
        ON dependency_source_chat."userId" = round."userId"
        AND dependency_source_chat."id" = round."chatId"
      INNER JOIN "ChatMemoryCheckpoint" AS dependency_checkpoint
        ON dependency_checkpoint."userId" = round."userId"
        AND dependency_checkpoint."chatId" = round."chatId"
      WHERE round."state" = 'ACTIVE'::"MemoryHistoryItemState"
        AND round."projectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
        AND round."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
        AND round."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
        AND round."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
        AND round."safetyClass" IN (
          'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
        )
        AND parent_chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
        AND parent_chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
        AND parent_chunk."sourceProjectionVersion" =
          ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
        AND dependency_checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
        AND dependency_checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
        AND ${memoryHistoryRoundSourceAuthorityPredicate({
          boundedCandidateSourceLookup: true,
          chat: "dependency_source_chat",
          checkpoint: "dependency_checkpoint"
        })}
        AND ${memoryRoundConversationFeedbackPredicate(snapshot)}
        AND ${memoryRoundSourceSafetyPredicate()}
        AND EXISTS (
          SELECT 1
          FROM "MemorySearchEntry" AS dependency_entry
          INNER JOIN "MemoryRecallRoundSegment" AS dependency_segment
            ON dependency_segment."userId" = dependency_entry."userId"
            AND dependency_segment."roundId" = dependency_entry."recallRoundId"
            AND dependency_segment."id" = dependency_entry."recallRoundSegmentId"
            AND dependency_segment."state" = 'ACTIVE'::"MemoryHistoryItemState"
            AND dependency_segment."evidenceRootHash" = round."evidenceRootHash"
            AND dependency_segment."sourceRevisionAtCreation" =
              round."sourceRevisionAtCreation"
            AND dependency_segment."contextualKeyPolicyVersion" =
              ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
            AND dependency_segment."projectionVersion" =
              ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
            AND dependency_segment."redactionState" <>
              'EXCLUDED'::"MemoryRedactionState"
            AND dependency_segment."safetyClass" IN (
              'NORMAL'::"MemoryDerivedSafetyClass",
              'SENSITIVE'::"MemoryDerivedSafetyClass"
            )
          WHERE dependency_entry."userId" = round."userId"
            AND dependency_entry."indexGenerationId" = ${snapshot.activeGenerationId}
            AND dependency_entry."recallRoundId" = round."id"
            AND dependency_entry."itemType" =
              'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
            AND dependency_entry."safeContentHash" =
              dependency_segment."contextualSearchHash"
        )
    ) AS dependencies ON TRUE
    WHERE eligible."itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
    ORDER BY eligible."itemId"
  `;
}

function digestExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${historyDigestEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`chunk."id" IN (${valuesSql(ids)})`,
      true
    )})
    SELECT eligible."itemId", eligible."itemType",
      digest."safeDigestText" AS "safeText",
      'CHAT_DIGEST_SAFE_TEXT'::text AS "projectionKind",
      digest."chatId" AS "sourceChatId", digest."id" AS "supportingItemId",
      digest."occurredFrom", digest."occurredTo", NULL::text AS "retrievalHint",
      '[]'::jsonb AS "patternSupportingEvidence",
      '[]'::jsonb AS "supportingEvidence"
    FROM eligible
    INNER JOIN "ChatMemoryDigest" AS digest
      ON digest."userId" = ${snapshot.userId}
      AND digest."chatId" = eligible."sourceChatId"
      AND digest."anchorChunkId" = eligible."itemId"
      AND digest."state" = 'ACTIVE'::"MemoryHistoryItemState"
    WHERE eligible."itemId" IN (${valuesSql(ids)})
    ORDER BY eligible."itemId"
  `;
}

function sessionEvidenceScore(candidates: readonly MemoryRankedCandidate[]): number {
  const top = candidates.slice(0, 3).map(({ finalScore }) => finalScore);
  const best = Math.max(...top);
  const average = top.reduce((sum, value) => sum + value, 0) / top.length;
  return Math.min(1, best + average * 0.1);
}

function sessionEvidenceLaneRanks(
  candidates: readonly MemoryRankedCandidate[]
): MemoryRankedCandidate["laneRanks"] {
  const laneRanks: Partial<Record<MemoryRetrievalLane, number>> = {};
  for (const candidate of candidates) {
    for (const [lane, rank] of Object.entries(candidate.laneRanks) as
      Array<[MemoryRetrievalLane, number]>) {
      laneRanks[lane] = Math.min(laneRanks[lane] ?? rank, rank);
    }
  }
  return laneRanks;
}

function selectMemorySessionRepresentatives(
  candidates: readonly MemoryRankedCandidate[],
  limit: number
): readonly MemoryRankedCandidate[] {
  type SourceGroup = Readonly<{
    candidates: readonly MemoryRankedCandidate[];
    firstIndex: number;
    sourceChatId: string;
  }>;
  const groups = new Map<string, {
    candidates: MemoryRankedCandidate[];
    firstIndex: number;
    sourceChatId: string;
  }>();
  candidates.forEach((candidate, index) => {
    if (candidate.itemType === "FACT_VERSION" || !candidate.metadata.sourceChatId) return;
    const sourceChatId = candidate.metadata.sourceChatId;
    const group = groups.get(sourceChatId);
    if (group) group.candidates.push(candidate);
    else groups.set(sourceChatId, { candidates: [candidate], firstIndex: index, sourceChatId });
  });
  return ([...groups.values()] as SourceGroup[])
    .sort((left, right) =>
      sessionEvidenceScore(right.candidates) -
        sessionEvidenceScore(left.candidates) ||
      left.firstIndex - right.firstIndex ||
      left.sourceChatId.localeCompare(right.sourceChatId))
    .slice(0, limit)
    .map((group) => {
      const representative = group.candidates[0]!;
      const laneRanks = sessionEvidenceLaneRanks(group.candidates);
      return {
        ...representative,
        featureSnapshot: {
          ...representative.featureSnapshot,
          laneCount: Object.keys(laneRanks).length
        },
        finalScore: sessionEvidenceScore(group.candidates),
        laneRanks
      };
    });
}

export function selectMemoryAggregationSessionRepresentatives(
  candidates: readonly MemoryRankedCandidate[]
): readonly MemoryRankedCandidate[] {
  return selectMemorySessionRepresentatives(
    candidates,
    MEMORY_RETRIEVAL_MAX_AGGREGATION_SOURCE_CHATS
  );
}

/**
 * Selects a small source-session frontier after semantic ordering. The later
 * completion query may add exact user-authored episodes from those sessions
 * but cannot introduce an unrelated source.
 */
export function selectMemoryTargetedSessionRepresentatives(
  candidates: readonly MemoryRankedCandidate[]
): readonly MemoryRankedCandidate[] {
  return selectMemorySessionRepresentatives(
    candidates,
    MEMORY_RETRIEVAL_TARGETED_SESSION_EXPANSION_SOURCE_CHATS
  );
}

function aggregationDigestCandidatesSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  sourceChatIds: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${historyDigestEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`digest."chatId" IN (${valuesSql(sourceChatIds)})`,
      true
    )})
    SELECT ${candidateColumns(Prisma.sql`0.0::double precision`)}
    FROM eligible
    WHERE eligible."sourceChatId" IN (${valuesSql(sourceChatIds)})
    ORDER BY eligible."sourceChatId", eligible."itemId"
  `;
}

/**
 * Completes a reranker-selected session with a small chronological raw-round
 * window. The source-session decision remains owned by retrieval + rerank;
 * this query cannot introduce another chat and every returned round passes
 * the same generation, deletion, suppression, branch, safety, and scope
 * predicates as ordinary history retrieval.
 */
function aggregationSessionRoundCompletionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  sourceChatIds: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH ${boundedMemorySearchEntryCandidatesSql(
      snapshot,
      Prisma.sql`${memoryRoundSearchEntryItemTypePredicate(snapshot)}
        AND EXISTS (
          SELECT 1 FROM "MemoryRecallRound" AS candidate_round
          WHERE candidate_round."userId" = entry."userId"
            AND candidate_round."id" = entry."recallRoundId"
            AND candidate_round."chatId" IN (${valuesSql(sourceChatIds)})
        )`
    )},
    eligible AS MATERIALIZED (${historyRoundEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`TRUE`,
      "BOUNDED_CANDIDATES"
    )}),
    eligible_rounds AS MATERIALIZED (
      SELECT DISTINCT eligible."itemId", eligible."sourceChatId"
      FROM eligible
      WHERE eligible."sourceChatId" IN (${valuesSql(sourceChatIds)})
    ),
    ranked_rounds AS (
      SELECT memory_round."id" AS "itemId",
        memory_round."parentChunkId",
        memory_round."chatId" AS "sourceChatId",
        memory_round."sourceFolderId",
        memory_round."sourceAssistantId",
        memory_round."evidenceRootHash",
        memory_round."languageCode",
        memory_round."occurredFrom",
        memory_round."occurredTo",
        memory_round."roundOrdinal",
        memory_round."safetyClass"::text AS "safetyClass",
        ROW_NUMBER() OVER (
          PARTITION BY memory_round."chatId"
          ORDER BY memory_round."roundOrdinal", memory_round."id"
        ) AS "sourceOrdinal"
      FROM eligible_rounds
      INNER JOIN "MemoryRecallRound" AS memory_round
        ON memory_round."userId" = ${snapshot.userId}
        AND memory_round."id" = eligible_rounds."itemId"
        AND memory_round."chatId" = eligible_rounds."sourceChatId"
    )
    SELECT "itemId", "parentChunkId", "sourceChatId", "sourceFolderId",
      "sourceAssistantId", "evidenceRootHash", "languageCode",
      NULL::text AS "matchedSegmentId", NULL::text AS "matchedSegmentPosition",
      "occurredFrom", "occurredTo", "roundOrdinal", "safetyClass"
    FROM ranked_rounds
    WHERE "sourceOrdinal" <= ${MEMORY_RETRIEVAL_COMPLEX_RAW_ANCHORS_PER_CHAT}
    ORDER BY "sourceChatId", "roundOrdinal", "itemId"
  `;
}

/**
 * Expands only already selected targeted source sessions into a bounded
 * chronological floor of exact user-authored episodes. Segment/message joins
 * are rechecked against the canonical round source map so role metadata cannot
 * turn assistant text into user testimony. The later expansion query repeats
 * the full authority rejoin before any text reaches the reranker or reader.
 */
function targetedSessionUserCompletionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  sourceChatIds: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH ${boundedMemorySearchEntryCandidatesSql(
      snapshot,
      Prisma.sql`entry."itemType" =
          'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
        AND EXISTS (
          SELECT 1 FROM "MemoryRecallRound" AS candidate_round
          WHERE candidate_round."userId" = entry."userId"
            AND candidate_round."id" = entry."recallRoundId"
            AND candidate_round."chatId" IN (${valuesSql(sourceChatIds)})
        )`
    )},
    eligible AS MATERIALIZED (${historySegmentRoundEligibleSelect(
      snapshot,
      plan,
      Prisma.sql`TRUE`,
      "BOUNDED_CANDIDATES"
    )}),
    user_round_segments AS MATERIALIZED (
      SELECT DISTINCT ON (eligible."itemId")
        memory_round."id" AS "itemId",
        memory_round."parentChunkId",
        memory_round."chatId" AS "sourceChatId",
        memory_round."sourceFolderId",
        memory_round."sourceAssistantId",
        memory_round."evidenceRootHash",
        segment."languageCode",
        segment."id" AS "matchedSegmentId",
        segment."position" AS "matchedSegmentPosition",
        segment."occurredFrom",
        segment."occurredTo",
        memory_round."roundOrdinal",
        segment."safetyClass"::text AS "safetyClass"
      FROM eligible
      INNER JOIN "MemoryRecallRoundSegment" AS segment
        ON segment."userId" = ${snapshot.userId}
        AND segment."roundId" = eligible."itemId"
        AND segment."id" = eligible."matchedSegmentId"
      INNER JOIN "MemoryRecallRound" AS memory_round
        ON memory_round."userId" = segment."userId"
        AND memory_round."id" = segment."roundId"
        AND memory_round."chatId" = eligible."sourceChatId"
      WHERE eligible."sourceChatId" IN (${valuesSql(sourceChatIds)})
        AND EXISTS (
          SELECT 1
          FROM "MemoryRecallRoundSegmentMessage" AS segment_message
          INNER JOIN "MemoryRecallRoundMessage" AS round_message
            ON round_message."userId" = segment_message."userId"
            AND round_message."chatId" = segment_message."chatId"
            AND round_message."roundId" = segment_message."roundId"
            AND round_message."messageId" = segment_message."messageId"
            AND round_message."ordinal" = segment_message."ordinal"
            AND round_message."role" = segment_message."role"
            AND round_message."safeTextHash" = segment_message."safeTextHash"
            AND round_message."sourceMessageContentHash" =
              segment_message."sourceMessageContentHash"
            AND round_message."sourceMessageUpdatedAt" =
              segment_message."sourceMessageUpdatedAt"
          WHERE segment_message."userId" = ${snapshot.userId}
            AND segment_message."chatId" = memory_round."chatId"
            AND segment_message."roundId" = memory_round."id"
            AND segment_message."segmentId" = segment."id"
            AND segment_message."role" = 'user'
            AND segment_message."sourceStartOffset" >=
              round_message."sourceStartOffset"
            AND segment_message."sourceEndOffset" <=
              round_message."sourceEndOffset"
            AND segment_message."sourceEndOffset" >
              segment_message."sourceStartOffset"
            AND segment_message."segmentEndOffset" >
              segment_message."segmentStartOffset"
        )
      ORDER BY eligible."itemId", segment."segmentOrdinal", segment."id"
    ),
    ranked_user_rounds AS (
      SELECT user_round_segments.*,
        ROW_NUMBER() OVER (
          PARTITION BY user_round_segments."sourceChatId"
          ORDER BY user_round_segments."roundOrdinal",
            user_round_segments."itemId"
        ) AS "sourceOrdinal"
      FROM user_round_segments
    )
    SELECT "itemId", "parentChunkId", "sourceChatId", "sourceFolderId",
      "sourceAssistantId", "evidenceRootHash", "languageCode",
      "matchedSegmentId", "matchedSegmentPosition", "occurredFrom",
      "occurredTo", "roundOrdinal", "safetyClass"
    FROM ranked_user_rounds
    WHERE "sourceOrdinal" <= ${MEMORY_RETRIEVAL_TARGETED_RAW_ANCHORS_PER_CHAT}
    ORDER BY "sourceChatId", "roundOrdinal", "itemId"
  `;
}

export type MemorySessionEvidenceCompletion = Readonly<{
  candidates: readonly MemoryRankedCandidate[];
  sourceChatCount: number;
}>;

function decodeMemorySessionEvidenceCompletion(
  rows: readonly SessionCompletionRow[],
  selectedSources: readonly MemoryRankedCandidate[],
  aggregationRequested: boolean
): MemorySessionEvidenceCompletion {
  const sourceLimit = aggregationRequested
    ? MEMORY_CONTEXT_AGGREGATION_MAX_SOURCE_CHATS
    : MEMORY_RETRIEVAL_TARGETED_SESSION_EXPANSION_SOURCE_CHATS;
  const perSourceLimit = aggregationRequested
    ? MEMORY_RETRIEVAL_COMPLEX_RAW_ANCHORS_PER_CHAT
    : MEMORY_RETRIEVAL_TARGETED_RAW_ANCHORS_PER_CHAT;
  const selectedBySource = new Map<string, MemoryRankedCandidate>();
  for (const selected of selectedSources) {
    if (selected.itemType === "FACT_VERSION") continue;
    const sourceChatId = selected.metadata.sourceChatId;
    if (!sourceChatId || selectedBySource.has(sourceChatId)) continue;
    selectedBySource.set(sourceChatId, selected);
    if (selectedBySource.size >= sourceLimit) break;
  }
  const sourceOrder = new Map([...selectedBySource.keys()].map((sourceChatId, index) =>
    [sourceChatId, index]));
  const seenItems = new Set<string>();
  const countsBySource = new Map<string, number>();
  const decoded: Array<Readonly<{
    candidate: MemoryRankedCandidate;
    roundOrdinal: number;
  }>> = [];
  for (const row of rows) {
    const selected = selectedBySource.get(row.sourceChatId);
    const sourceCount = countsBySource.get(row.sourceChatId) ?? 0;
    const hasSegment = row.matchedSegmentId !== null ||
      row.matchedSegmentPosition !== null;
    if (
      !selected || !validToken(row.itemId) || !validToken(row.parentChunkId) ||
      !validToken(row.sourceChatId) ||
      (row.sourceFolderId !== null && !validToken(row.sourceFolderId)) ||
      (row.sourceAssistantId !== null && !validToken(row.sourceAssistantId)) ||
      !fingerprintPattern.test(row.evidenceRootHash) ||
      typeof row.languageCode !== "string" || row.languageCode.length < 1 ||
      row.languageCode.length > 35 ||
      !Number.isSafeInteger(row.roundOrdinal) || row.roundOrdinal < 0 ||
      !validDate(row.occurredFrom) || !validDate(row.occurredTo) ||
      row.occurredTo < row.occurredFrom ||
      (row.safetyClass !== "NORMAL" && row.safetyClass !== "SENSITIVE") ||
      (aggregationRequested
        ? hasSegment
        : !hasSegment || !validToken(row.matchedSegmentId) ||
          row.matchedSegmentPosition === null ||
          !roundSegmentPositions.has(row.matchedSegmentPosition)) ||
      seenItems.has(row.itemId) ||
      sourceCount >= perSourceLimit
    ) throw new Error("memory_session_completion_result_invalid");
    seenItems.add(row.itemId);
    countsBySource.set(row.sourceChatId, sourceCount + 1);
    const completionReason = aggregationRequested
      ? "aggregation_session_completion"
      : "targeted_session_completion_user_evidence";
    const selectionReason = `${selected.selectionReason}+${completionReason}`;
    decoded.push({
      candidate: {
        ...selected,
        entryId: null,
        featureSnapshot: {
          ...selected.featureSnapshot,
          deterministicMatches: [],
          directFactAuthority: false
        },
        ...(aggregationRequested ? {} : { historyEvidenceView: "USER_TESTIMONY" as const }),
        itemId: row.itemId,
        itemType: "RECALL_ROUND",
        matchedSegmentId: row.matchedSegmentId,
        matchedSegmentPosition: row.matchedSegmentPosition as
          MemoryRankedCandidate["matchedSegmentPosition"],
        metadata: {
          ...selected.metadata,
          dedupeKey: `history:${row.evidenceRootHash}`,
          evidenceRootHash: row.evidenceRootHash,
          historySafetyClass: row.safetyClass,
          languageCode: row.languageCode,
          occurredFrom: row.occurredFrom,
          occurredTo: row.occurredTo,
          parentChunkId: row.parentChunkId,
          sourceAssistantId: row.sourceAssistantId,
          sourceAuthority: "PAST_CHAT",
          sourceChatId: row.sourceChatId,
          sourceFolderId: row.sourceFolderId
        },
        selectionReason: selectionReason.length <= 128
          ? selectionReason
          : completionReason
      },
      roundOrdinal: row.roundOrdinal
    });
  }
  decoded.sort((left, right) =>
    (sourceOrder.get(left.candidate.metadata.sourceChatId!) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(right.candidate.metadata.sourceChatId!) ?? Number.MAX_SAFE_INTEGER) ||
    left.roundOrdinal - right.roundOrdinal ||
    left.candidate.itemId.localeCompare(right.candidate.itemId));
  return Object.freeze({
    candidates: Object.freeze(decoded.map(({ candidate }) => candidate)),
    sourceChatCount: selectedBySource.size
  });
}

/** Replaces a session-navigation representative with the authoritative digest
 * anchor identity as one atomic item reference. Mixing a round itemType with a
 * chunk itemId makes the subsequent authoritative expansion query the wrong
 * table and silently loses the selected source. */
export function projectMemoryAggregationDigestRepresentative(
  representative: MemoryRankedCandidate,
  digest: Pick<MemoryLaneCandidate, "itemId" | "itemType" | "metadata">
): MemoryRankedCandidate {
  if (
    representative.itemType === "FACT_VERSION" ||
    digest.itemType !== "RECALL_CHUNK" ||
    !representative.metadata.sourceChatId ||
    digest.metadata.sourceChatId !== representative.metadata.sourceChatId
  ) throw new Error("memory_aggregation_projection_result_invalid");
  return {
    ...representative,
    entryId: null,
    itemId: digest.itemId,
    itemType: digest.itemType,
    matchedSegmentId: null,
    matchedSegmentPosition: null,
    metadata: digest.metadata,
    selectionReason: `${representative.selectionReason}+aggregation_session_digest`
  };
}

function validPlan(plan: MemoryRetrievalPlan): boolean {
  const requestedKinds = plan.filters.sourceKinds;
  const facts = requestedKinds.includes("FACT") || requestedKinds.includes("EVENT");
  const history = requestedKinds.includes("HISTORY");
  const temporalShape = plan.temporalIntent === "AS_OF"
    ? plan.filters.asOf !== null && plan.filters.from === null && plan.filters.to === null
    : plan.temporalIntent === "BETWEEN"
      ? plan.filters.asOf === null &&
        (plan.filters.from !== null || plan.filters.to !== null)
      : plan.filters.asOf === null && plan.filters.from === null && plan.filters.to === null;
  const modeShape = plan.mode === "CURRENT_PROFILE"
    ? plan.profileRequested && facts && !history && plan.temporalIntent === "CURRENT"
    : plan.mode === "TARGETED_CURRENT"
      ? !plan.profileRequested && (facts || requestedKinds.length === 0) &&
        (plan.temporalIntent === "CURRENT" || plan.temporalIntent === "ANY")
      : plan.mode === "HISTORICAL_MEMORY"
        ? !plan.profileRequested && facts && !history && plan.temporalIntent !== "CURRENT"
        : plan.mode === "PAST_CHAT_SEARCH"
          ? !plan.profileRequested && !facts && history &&
            plan.temporalIntent !== "HISTORICAL"
          : !plan.profileRequested && !facts && history && !plan.recencyRequested;
  return typeof plan.applyResponsePreferences === "boolean" &&
    typeof plan.aggregationRequested === "boolean" &&
    (!plan.aggregationRequested || plan.mode === "PAST_CHAT_SEARCH" ||
      plan.mode === "HISTORY_OVERVIEW") &&
    Array.isArray(plan.entityMentions) && plan.entityMentions.length <= 8 &&
    plan.entityMentions.every((mention) =>
      typeof mention.text === "string" && mention.text.trim() === mention.text &&
      mention.text.length >= 1 && mention.text.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(mention.text) &&
      Number.isSafeInteger(mention.occurrenceIndex) && mention.occurrenceIndex >= 0 &&
      mention.occurrenceIndex <= 15 &&
      (mention.resolvedRef === null || opaqueEntityRefPattern.test(mention.resolvedRef))) &&
    typeof plan.includePatterns === "boolean" &&
    (!plan.includePatterns || plan.mode === "TARGETED_CURRENT") &&
    typeof plan.profileRequested === "boolean" &&
    retrievalModes.has(plan.mode) && temporalIntents.has(plan.temporalIntent) &&
    Array.isArray(requestedKinds) &&
    requestedKinds.length <= retrievalSourceKinds.size &&
    (requestedKinds.length > 0 || plan.applyResponsePreferences) &&
    new Set(requestedKinds).size === requestedKinds.length &&
    requestedKinds.every((kind) => retrievalSourceKinds.has(kind)) &&
    typeof plan.originalSanitizedQuery === "string" &&
    plan.originalSanitizedQuery === plan.normalizedQuery &&
    plan.normalizedQuery.length <= 2_000 &&
    plan.normalizedExactQuery.length <= 2_000 &&
    plan.queryPresent === (plan.originalSanitizedQuery.length > 0) &&
    Array.isArray(plan.semanticQueryVariants) &&
    plan.semanticQueryVariants.length <= MEMORY_RETRIEVAL_MAX_SEMANTIC_QUERY_VARIANTS &&
    (plan.queryPresent
      ? plan.semanticQueryVariants.length >= 1
      : plan.semanticQueryVariants.length === 0) &&
    plan.semanticQueryVariants.every((variant) =>
      semanticVariantKinds.has(variant.kind) && typeof variant.text === "string" &&
      variant.text.length > 0 && variant.text.length <= 2_000) &&
    new Set(plan.semanticQueryVariants.map(({ text }) =>
      text.toLocaleLowerCase("und"))).size === plan.semanticQueryVariants.length &&
    (!plan.queryPresent || plan.semanticQueryVariants[0]?.kind === "ORIGINAL" &&
      plan.semanticQueryVariants[0].text === plan.originalSanitizedQuery) &&
    Array.isArray(plan.temporalQueryVariants) &&
    plan.temporalQueryVariants.length <= MEMORY_RETRIEVAL_MAX_TEMPORAL_QUERY_VARIANTS &&
    (plan.queryPresent
      ? plan.temporalQueryVariants.length >= 1
      : plan.temporalQueryVariants.length === 0) &&
    plan.temporalQueryVariants.every((variant) =>
      temporalVariantKinds.has(variant.kind) && typeof variant.text === "string" &&
      variant.text.length > 0 && variant.text.length <= 2_000) &&
    new Set(plan.temporalQueryVariants.map(({ kind, text }) =>
      `${kind}:${text.toLocaleLowerCase("und")}`)).size === plan.temporalQueryVariants.length &&
    (!plan.queryPresent || plan.temporalQueryVariants.some((variant) =>
      variant.kind === "UNRESTRICTED" && variant.text === plan.originalSanitizedQuery)) &&
    validTemporalQuery(plan) &&
    (plan.temporalIntent === "AS_OF" || plan.temporalIntent === "BETWEEN" ||
      plan.temporalQuery.state === "MATCHED"
      ? plan.temporalQueryVariants.some((variant) =>
          variant.kind === "FILTERED" && variant.text === plan.originalSanitizedQuery)
      : plan.temporalQueryVariants.every((variant) => variant.kind === "UNRESTRICTED")) &&
    typeof plan.recencyRequested === "boolean" &&
    validDate(plan.filters.asOf) && validDate(plan.filters.from) && validDate(plan.filters.to) &&
    !(plan.filters.asOf && (plan.filters.from || plan.filters.to)) &&
    temporalShape && modeShape &&
    (!plan.profileRequested || !plan.recencyRequested) &&
    (plan.lexicalQuery === null || plan.lexicalQuery.length <= 2_000);
}

function validBaselinePlan(
  baseline: MemoryRetrievalPlan,
  enriched: MemoryRetrievalPlan,
  snapshot: MemoryLocalRetrievalSnapshot
): boolean {
  const kinds = baseline.filters.sourceKinds;
  const coveredKinds = new Set([
    ...kinds,
    ...enriched.filters.sourceKinds
  ]);
  const facts = kinds.includes("FACT") || kinds.includes("EVENT");
  return validPlan(baseline) && !baseline.aggregationRequested &&
    !baseline.applyResponsePreferences && !baseline.includePatterns &&
    !baseline.profileRequested && !baseline.recencyRequested &&
    baseline.mode === (facts ? "TARGETED_CURRENT" : "PAST_CHAT_SEARCH") &&
    baseline.temporalIntent === "ANY" &&
    baseline.originalSanitizedQuery === enriched.originalSanitizedQuery &&
    baseline.semanticQueryVariants.length === 1 &&
    baseline.semanticQueryVariants[0]?.kind === "ORIGINAL" &&
    baseline.temporalQueryVariants.some((variant) =>
      variant.kind === "UNRESTRICTED" &&
      variant.text === baseline.originalSanitizedQuery) &&
    baseline.filters.asOf === null && baseline.filters.from === null &&
    baseline.filters.to === null && baseline.filters.scopeType === null &&
    baseline.filters.scopeTargetId === null &&
    (!facts || snapshot.useMemoryFacts) &&
    (!kinds.includes("HISTORY") || snapshot.referenceChatHistory) &&
    (!snapshot.useMemoryFacts || coveredKinds.has("FACT") && coveredKinds.has("EVENT")) &&
    (!snapshot.referenceChatHistory || coveredKinds.has("HISTORY"));
}

const emptySourceFamilyEvidence = Object.freeze({
  baselineFactCandidateCount: 0,
  baselineHistoryCandidateCount: 0,
  baselineOnlyCandidateCount: 0,
  plannerExcludedFamilyRecoveredCount: 0,
  plannerOnlyCandidateCount: 0
}) satisfies MemorySourceFamilyRetrievalEvidence;

function sourceKindForCandidate(
  candidate: Pick<MemoryRankedCandidate, "itemType" | "metadata">
): "EVENT" | "FACT" | "HISTORY" {
  if (candidate.itemType === "TOOL_EVENT") return "HISTORY";
  if (candidate.itemType !== "FACT_VERSION") return "HISTORY";
  return candidate.metadata.modality === "EVENT" ? "EVENT" : "FACT";
}

function baselineLaneCandidate(
  candidate: MemoryRankedCandidate,
  lane: "FACT_BASELINE_ORIGINAL" | "HISTORY_BASELINE_ORIGINAL"
): MemoryLaneCandidate {
  return {
    deterministicMatch: candidate.featureSnapshot.deterministicMatches?.[0] ?? null,
    entryId: candidate.entryId,
    hardFilterPassed: true,
    itemId: candidate.itemId,
    itemType: candidate.itemType,
    lane,
    matchedSegmentId: candidate.matchedSegmentId ?? null,
    matchedSegmentPosition: candidate.matchedSegmentPosition ?? null,
    metadata: candidate.metadata,
    rawScore: candidate.rrfScore
  };
}

/** Fuses and caps the original-query plan before adding only evidence roots
 * that planner-enriched retrieval did not already recover. Duplicate roots
 * therefore contribute exactly once to the final rank-only RRF. */
export function applyMemorySourceFamilyRecallFloor(input: Readonly<{
  baselineLaneResults: readonly MemoryLaneResult[];
  baselinePlan: MemoryRetrievalPlan;
  enrichedLaneResults: readonly MemoryLaneResult[];
  enrichedPlan: MemoryRetrievalPlan;
  now: Date;
}>): Readonly<{
  evidence: MemorySourceFamilyRetrievalEvidence;
  laneResults: readonly MemoryLaneResult[];
}> {
  const baselineRanked = fuseMemoryRetrievalCandidates(
    input.baselinePlan,
    input.baselineLaneResults,
    input.now
  );
  const enrichedRanked = fuseMemoryRetrievalCandidates(
    input.enrichedPlan,
    input.enrichedLaneResults,
    input.now
  );
  const selectedBaseline: MemoryRankedCandidate[] = [];
  let factCount = 0;
  let historyCount = 0;
  for (const candidate of baselineRanked) {
    if (candidate.itemType === "FACT_VERSION") {
      if (factCount >= MEMORY_RETRIEVAL_BASELINE_FACT_EVIDENCE_ROOTS) continue;
      factCount += 1;
    } else {
      if (historyCount >= MEMORY_RETRIEVAL_BASELINE_HISTORY_EVIDENCE_ROOTS) continue;
      historyCount += 1;
    }
    selectedBaseline.push(candidate);
  }
  const enrichedRoots = new Set(enrichedRanked.map(memoryRetrievalEvidenceRootKey));
  const baselineRoots = new Set(baselineRanked.map(memoryRetrievalEvidenceRootKey));
  const baselineOnly = selectedBaseline.filter((candidate) =>
    !enrichedRoots.has(memoryRetrievalEvidenceRootKey(candidate)));
  const factCandidates = baselineOnly.filter((candidate) =>
    candidate.itemType === "FACT_VERSION").map((candidate) =>
      baselineLaneCandidate(candidate, "FACT_BASELINE_ORIGINAL"));
  const historyCandidates = baselineOnly.filter((candidate) =>
    candidate.itemType !== "FACT_VERSION").map((candidate) =>
      baselineLaneCandidate(candidate, "HISTORY_BASELINE_ORIGINAL"));
  const baselineOnlyResults: MemoryLaneResult[] = [];
  if (factCandidates.length > 0) baselineOnlyResults.push({
    candidates: factCandidates,
    lane: "FACT_BASELINE_ORIGINAL"
  });
  if (historyCandidates.length > 0) baselineOnlyResults.push({
    candidates: historyCandidates,
    lane: "HISTORY_BASELINE_ORIGINAL"
  });
  return Object.freeze({
    evidence: Object.freeze({
      baselineFactCandidateCount: factCount,
      baselineHistoryCandidateCount: historyCount,
      baselineOnlyCandidateCount: baselineOnly.length,
      plannerExcludedFamilyRecoveredCount: baselineOnly.filter((candidate) =>
        !input.enrichedPlan.filters.sourceKinds.includes(
          sourceKindForCandidate(candidate)
        )).length,
      plannerOnlyCandidateCount: enrichedRanked.filter((candidate) =>
        !baselineRoots.has(memoryRetrievalEvidenceRootKey(candidate))).length
    }),
    laneResults: Object.freeze([...baselineOnlyResults, ...input.enrichedLaneResults])
  });
}

function emptyResult(
  snapshot: MemoryLocalRetrievalSnapshot,
  core: readonly MemoryCoreCandidate[] = [],
  vectorState: MemoryLocalRetrievalResult["vectorState"] = "DISABLED"
): MemoryLocalRetrievalResult {
  return {
    core,
    digestEvidence: emptyDigestEvidence,
    laneResults: [],
    lexicalEvidence: [],
    lexicalFailures: [],
    lexicalState: "DISABLED",
    snapshot,
    sourceFamilyEvidence: emptySourceFamilyEvidence,
    vectorEvidence: [],
    vectorState
  };
}

function validRankedSegmentIdentity(candidate: MemoryRankedCandidate): boolean {
  const id = candidate.matchedSegmentId ?? null;
  const position = candidate.matchedSegmentPosition ?? null;
  if (id === null || position === null) return id === null && position === null;
  return candidate.itemType === "RECALL_ROUND" && validToken(id) &&
    roundSegmentPositions.has(position);
}

function validRankedHistoryEvidenceView(candidate: MemoryRankedCandidate): boolean {
  if (candidate.historyEvidenceView === undefined) return true;
  return candidate.historyEvidenceView === "USER_TESTIMONY" &&
    candidate.itemType === "RECALL_ROUND" && Boolean(candidate.matchedSegmentId);
}

function partitionRoundExpansionCandidates(
  candidates: readonly MemoryRankedCandidate[]
): Readonly<{
  legacyIds: readonly string[];
  segments: readonly RoundSegmentSelection[];
  userSegments: readonly RoundSegmentSelection[];
}> {
  const rounds = candidates.filter((candidate) => candidate.itemType === "RECALL_ROUND");
  return {
    legacyIds: rounds.flatMap((candidate) =>
      candidate.matchedSegmentId ? [] : [candidate.itemId]),
    segments: rounds.flatMap((candidate) =>
      candidate.matchedSegmentId && candidate.historyEvidenceView === undefined
      ? [{ itemId: candidate.itemId, segmentId: candidate.matchedSegmentId }]
      : []),
    userSegments: rounds.flatMap((candidate) =>
      candidate.matchedSegmentId && candidate.historyEvidenceView === "USER_TESTIMONY"
        ? [{ itemId: candidate.itemId, segmentId: candidate.matchedSegmentId }]
        : [])
  };
}

function usesDigestOnlyProjection(candidate: MemoryRankedCandidate): boolean {
  if (candidate.itemType !== "RECALL_CHUNK" ||
    candidate.laneRanks.HISTORY_DIGEST_FTS_SIMPLE === undefined) return false;
  return !Object.keys(candidate.laneRanks).some((lane) =>
    lane === "HISTORY_INTRA_CHAT_RAW" ||
    lane === "HISTORY_BASELINE_ORIGINAL" ||
    lane.startsWith("HISTORY_RECALL_"));
}

async function settleMemoryLocalRead<T>(
  signal: AbortSignal | undefined,
  execute: () => Promise<T>,
  fallback: T
): Promise<T> {
  if (signal?.aborted) return fallback;
  const execution = execute();
  if (!signal) return execution;
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<Readonly<{ status: "ABORTED" }>>((resolve) => {
    onAbort = () => resolve(Object.freeze({ status: "ABORTED" }));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const result = await Promise.race([
      execution.then((value) => Object.freeze({ status: "READY" as const, value })),
      aborted
    ]);
    if (result.status === "ABORTED") {
      // Prisma reads are side-effect free but not transport-cancellable. Keep
      // the detached operation observed while returning the bounded fallback.
      void execution.catch(() => undefined);
      return fallback;
    }
    return result.value;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export type PrismaLocalMemoryRetrievalRepositoryDependencies = Readonly<{
  lexicalCandidateProviderForLane?: MemoryLexicalProviderForLane;
  lexicalShadowRuntime?: MemoryLexicalShadowRuntime | null;
}>;

export function createPrismaLocalMemoryRetrievalRepository(
  client: PrismaClient = prisma,
  dependencies: PrismaLocalMemoryRetrievalRepositoryDependencies = {}
) {
  const defaultLexicalRuntime = dependencies.lexicalCandidateProviderForLane
    ? null
    : defaultMemoryLexicalCutoverRuntime(client);
  const providerForLane: MemoryLexicalProviderForLane =
    dependencies.lexicalCandidateProviderForLane ??
    defaultLexicalRuntime!.providerForLane;
  const lexicalShadowRuntime = dependencies.lexicalShadowRuntime === undefined
    ? defaultMemoryLexicalShadowRuntime(client)
    : dependencies.lexicalShadowRuntime;
  type IssuedSnapshotMetadata = Readonly<{ authorityFingerprint: string }>;
  const issuedSnapshots = new WeakMap<
    MemoryLocalRetrievalSnapshot,
    IssuedSnapshotMetadata
  >();
  const issueSnapshot = (
    snapshot: MemoryLocalRetrievalSnapshot
  ): MemoryLocalRetrievalSnapshot => {
    const authorityFingerprint = snapshotAuthorityFingerprint(snapshot);
    const frozen = Object.freeze(snapshot);
    issuedSnapshots.set(frozen, Object.freeze({ authorityFingerprint }));
    memoryLexicalReadinessScopes.set(frozen, Object.freeze({}));
    return frozen;
  };
  const reusableSnapshot = (
    snapshot: MemoryLocalRetrievalSnapshot,
    input: MemoryLocalRetrievalInput
  ): boolean => {
    const issued = issuedSnapshots.get(snapshot);
    if (!issued) return false;
    try {
      return issued.authorityFingerprint === snapshotAuthorityFingerprint(snapshot) &&
        snapshot.userId === input.userId && snapshot.chatId === input.chatId &&
        snapshot.assistantId === input.assistantId;
    } catch {
      return false;
    }
  };
  const canonicalRead = <Row>(sql: Prisma.Sql): Promise<Row[]> =>
    withMemoryReadBudget(
      client,
      MEMORY_READ_BUDGET_MS.CANONICAL_REJOIN_EXPANSION,
      (tx) => tx.$queryRaw<Row[]>(sql)
    );
  const repository = {
    async expand(
      snapshot: MemoryLocalRetrievalSnapshot,
      plan: MemoryRetrievalPlan,
      candidates: readonly MemoryRankedCandidate[]
    ): Promise<readonly MemoryExpandedCandidate[]> {
      if (
        snapshot.status !== "READY" ||
        candidates.length > (plan.aggregationRequested
          ? MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES
          : MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES) ||
        new Set(candidates.map((candidate) => `${candidate.itemType}:${candidate.itemId}`)).size !==
          candidates.length || candidates.some((candidate) =>
          !validToken(candidate.itemId) || !validRankedSegmentIdentity(candidate) ||
          !validRankedHistoryEvidenceView(candidate))
      ) throw new Error("memory_expansion_contract_invalid");
      const factIds = candidates.filter((candidate) => candidate.itemType === "FACT_VERSION")
        .map((candidate) => candidate.itemId);
      const digestChunkIds = candidates.filter(usesDigestOnlyProjection)
        .map((candidate) => candidate.itemId);
      const rawChunkIds = candidates.filter((candidate) =>
        candidate.itemType === "RECALL_CHUNK" && !usesDigestOnlyProjection(candidate))
        .map((candidate) => candidate.itemId);
      const toolEventIds = candidates.filter((candidate) =>
        candidate.itemType === "TOOL_EVENT").map((candidate) => candidate.itemId);
      const chunkIds = [...digestChunkIds, ...rawChunkIds];
      const roundSelections = partitionRoundExpansionCandidates(candidates);
      if ((chunkIds.length > 0 || toolEventIds.length > 0 ||
        roundSelections.legacyIds.length > 0 ||
        roundSelections.segments.length > 0 || roundSelections.userSegments.length > 0) &&
        (!snapshot.activeGenerationId || !snapshot.indexMode)) {
        throw new Error("memory_expansion_contract_invalid");
      }
      if (candidates.length === 0) return [];
      const queries: Promise<ExpandedRow[]>[] = [];
      if (factIds.length > 0) queries.push(canonicalRead<ExpandedRow>(
        currentFactExpansionSql(snapshot, plan, factIds)));
      if (digestChunkIds.length > 0) queries.push(canonicalRead<ExpandedRow>(
        digestExpansionSql(snapshot, plan, digestChunkIds)));
      if (rawChunkIds.length > 0) queries.push(canonicalRead<ExpandedRow>(
        plan.mode === "HISTORY_OVERVIEW"
          ? digestExpansionSql(snapshot, plan, rawChunkIds)
          : chunkExpansionSql(snapshot, plan, rawChunkIds)));
      if (toolEventIds.length > 0) queries.push(canonicalRead<ExpandedRow>(
        toolEventExpansionSql(snapshot, plan, toolEventIds)));
      if (roundSelections.legacyIds.length > 0) {
        queries.push(canonicalRead<ExpandedRow>(rawRoundExpansionSql(
          snapshot,
          plan,
          roundSelections.legacyIds
        )).then((rows) => rows.map((row) => ({
          ...row,
          safeText: boundedMemoryRecallRoundEvidenceText(row.safeText)
        }))));
      }
      if (roundSelections.segments.length > 0) {
        queries.push(canonicalRead<ExpandedRow>(segmentRoundExpansionSql(
          snapshot,
          plan,
          roundSelections.segments
        )));
      }
      if (roundSelections.userSegments.length > 0) {
        queries.push(canonicalRead<UserSegmentExpandedRow>(segmentRoundExpansionSql(
          snapshot,
          plan,
          roundSelections.userSegments,
          "USER_TESTIMONY"
        )).then((rows) => rows.flatMap((row) => {
          const projected = projectUserTestimonyExpandedRow(row);
          return projected ? [projected] : [];
        })));
      }
      return orderedExpandedCandidates(candidates, (await Promise.all(queries)).flat());
    },

    async expandAggregationNavigation(
      snapshot: MemoryLocalRetrievalSnapshot,
      plan: MemoryRetrievalPlan,
      candidates: readonly MemoryRankedCandidate[]
    ): Promise<readonly MemoryExpandedCandidate[]> {
      if (
        snapshot.status !== "READY" ||
        !plan.aggregationRequested || plan.mode !== "PAST_CHAT_SEARCH" ||
        candidates.length > MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES ||
        new Set(candidates.map((candidate) => `${candidate.itemType}:${candidate.itemId}`)).size !==
          candidates.length || candidates.some((candidate) =>
          !validToken(candidate.itemId) || !validRankedSegmentIdentity(candidate) ||
          candidate.historyEvidenceView !== undefined)
      ) throw new Error("memory_aggregation_navigation_contract_invalid");
      const factIds = candidates.filter((candidate) => candidate.itemType === "FACT_VERSION")
        .map((candidate) => candidate.itemId);
      const chunkIds = candidates.filter((candidate) => candidate.itemType === "RECALL_CHUNK")
        .map((candidate) => candidate.itemId);
      const toolEventIds = candidates.filter((candidate) =>
        candidate.itemType === "TOOL_EVENT").map((candidate) => candidate.itemId);
      const roundSelections = partitionRoundExpansionCandidates(candidates);
      if ((chunkIds.length > 0 || toolEventIds.length > 0 ||
        roundSelections.legacyIds.length > 0 ||
        roundSelections.segments.length > 0 || roundSelections.userSegments.length > 0) &&
        (!snapshot.activeGenerationId || !snapshot.indexMode)) {
        throw new Error("memory_aggregation_navigation_contract_invalid");
      }
      if (candidates.length === 0) return [];
      const initialQueries: Promise<ExpandedRow[]>[] = [];
      if (factIds.length > 0) initialQueries.push(canonicalRead<ExpandedRow>(
        currentFactExpansionSql(snapshot, plan, factIds)));
      if (chunkIds.length > 0) initialQueries.push(canonicalRead<ExpandedRow>(
        digestExpansionSql(snapshot, plan, chunkIds)));
      if (toolEventIds.length > 0) initialQueries.push(canonicalRead<ExpandedRow>(
        toolEventExpansionSql(snapshot, plan, toolEventIds)));
      if (roundSelections.legacyIds.length > 0) {
        initialQueries.push(canonicalRead<ExpandedRow>(rawRoundExpansionSql(
          snapshot,
          plan,
          roundSelections.legacyIds
        )).then((rows) => rows.map((row) => ({
          ...row,
          safeText: boundedMemoryRecallRoundEvidenceText(row.safeText)
        }))));
      }
      if (roundSelections.segments.length > 0) {
        initialQueries.push(canonicalRead<ExpandedRow>(segmentRoundExpansionSql(
          snapshot,
          plan,
          roundSelections.segments
        )));
      }
      if (roundSelections.userSegments.length > 0) {
        throw new Error("memory_aggregation_navigation_contract_invalid");
      }
      const initialRows = (await Promise.all(initialQueries)).flat();
      const digestChunkIds = new Set(initialRows.flatMap((row) =>
        row.itemType === "RECALL_CHUNK" && row.projectionKind === "CHAT_DIGEST_SAFE_TEXT"
          ? [row.itemId]
          : []));
      const rawFallbackIds = chunkIds.filter((itemId) => !digestChunkIds.has(itemId));
      const rawFallbackRows = rawFallbackIds.length === 0
        ? []
        : await canonicalRead<ExpandedRow>(
            chunkExpansionSql(snapshot, plan, rawFallbackIds));
      return orderedExpandedCandidates(candidates, [...initialRows, ...rawFallbackRows]);
    },

    async projectAggregationSessions(
      snapshot: MemoryLocalRetrievalSnapshot,
      plan: MemoryRetrievalPlan,
      candidates: readonly MemoryRankedCandidate[]
    ): Promise<readonly MemoryRankedCandidate[]> {
      if (
        snapshot.status !== "READY" ||
        !plan.aggregationRequested || plan.mode !== "PAST_CHAT_SEARCH" ||
        candidates.length > MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES ||
        new Set(candidates.map((candidate) => `${candidate.itemType}:${candidate.itemId}`)).size !==
          candidates.length ||
        candidates.some((candidate) => !validToken(candidate.itemId))
      ) throw new Error("memory_aggregation_projection_contract_invalid");
      const facts = candidates.filter((candidate) => candidate.itemType === "FACT_VERSION");
      const representatives = selectMemoryAggregationSessionRepresentatives(candidates);
      if (representatives.length === 0) return facts;
      const sourceChatIds = representatives.map(({ metadata }) => metadata.sourceChatId!);
      const rows = await canonicalRead<CandidateRow>(
        aggregationDigestCandidatesSql(snapshot, plan, sourceChatIds)
      );
      const bySource = new Map<string, MemoryLaneCandidate>();
      for (const row of rows) {
        const candidate = decodeCandidate(row, "HISTORY_DIGEST_FTS_SIMPLE");
        const sourceChatId = candidate.metadata.sourceChatId;
        if (candidate.itemType !== "RECALL_CHUNK" || !sourceChatId ||
          bySource.has(sourceChatId)) {
          throw new Error("memory_aggregation_projection_result_invalid");
        }
        bySource.set(sourceChatId, candidate);
      }
      const history = representatives.flatMap((representative) => {
        const sourceChatId = representative.metadata.sourceChatId;
        const row = sourceChatId ? bySource.get(sourceChatId) : undefined;
        if (!row) return [{
          ...representative,
          selectionReason: `${representative.selectionReason}+aggregation_session_raw_fallback`
        } satisfies MemoryRankedCandidate];
        return [projectMemoryAggregationDigestRepresentative(representative, row)];
      });
      return [...facts, ...history];
    },

    async completeSessionEvidence(
      snapshot: MemoryLocalRetrievalSnapshot,
      plan: MemoryRetrievalPlan,
      selectedSources: readonly MemoryRankedCandidate[]
    ): Promise<MemorySessionEvidenceCompletion> {
      const candidateLimit = plan.aggregationRequested
        ? MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES
        : MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES;
      const sourceLimit = plan.aggregationRequested
        ? MEMORY_CONTEXT_AGGREGATION_MAX_SOURCE_CHATS
        : MEMORY_RETRIEVAL_TARGETED_SESSION_EXPANSION_SOURCE_CHATS;
      const perSourceLimit = plan.aggregationRequested
        ? MEMORY_RETRIEVAL_COMPLEX_RAW_ANCHORS_PER_CHAT
        : MEMORY_RETRIEVAL_TARGETED_RAW_ANCHORS_PER_CHAT;
      if (
        snapshot.status !== "READY" ||
        plan.mode !== "PAST_CHAT_SEARCH" || selectedSources.length > candidateLimit ||
        new Set(selectedSources.map((candidate) =>
          `${candidate.itemType}:${candidate.itemId}`)).size !== selectedSources.length ||
        selectedSources.some((candidate) => !validToken(candidate.itemId))
      ) throw new Error("memory_session_completion_contract_invalid");
      const sourceChatIds = [...new Set(selectedSources.flatMap((candidate) =>
        candidate.itemType !== "FACT_VERSION" && candidate.metadata.sourceChatId
          ? [candidate.metadata.sourceChatId] : []))].slice(0, sourceLimit);
      if (sourceChatIds.length === 0) return Object.freeze({
        candidates: Object.freeze([]),
        sourceChatCount: 0
      });
      if (sourceChatIds.some((sourceChatId) => !validToken(sourceChatId))) {
        throw new Error("memory_session_completion_contract_invalid");
      }
      const rows = await canonicalRead<SessionCompletionRow>(
        plan.aggregationRequested
          ? aggregationSessionRoundCompletionSql(snapshot, plan, sourceChatIds)
          : targetedSessionUserCompletionSql(snapshot, plan, sourceChatIds)
      );
      if (rows.length > sourceChatIds.length * perSourceLimit) {
        throw new Error("memory_session_completion_result_invalid");
      }
      return decodeMemorySessionEvidenceCompletion(
        rows,
        selectedSources,
        plan.aggregationRequested
      );
    },

    async snapshot(input: MemoryLocalRetrievalInput): Promise<MemoryLocalRetrievalSnapshot> {
      return issueSnapshot(await loadSnapshot(client, input));
    },

    async retrieve(input: MemoryLocalRetrievalInput): Promise<MemoryLocalRetrievalResult> {
      if (!validPlan(input.plan)) throw new Error("memory_retrieval_plan_invalid");
      const denseOnly = (input as MemoryLocalRetrievalInternalInput)[denseOnlyRetrieval] === true;
      if (denseOnly && (!input.vector || input.baselinePlan)) {
        throw new Error("memory_dense_retrieval_contract_invalid");
      }
      const snapshot = input.sourceSnapshot ?? issueSnapshot(await loadSnapshot(client, input));
      if (input.sourceSnapshot) {
        if (!reusableSnapshot(snapshot, input)) {
          throw new Error("memory_retrieval_source_snapshot_invalid");
        }
      }
      if (input.baselinePlan &&
        !validBaselinePlan(input.baselinePlan, input.plan, snapshot)) {
        throw new Error("memory_retrieval_baseline_plan_invalid");
      }
      if (snapshot.status !== "READY") return emptyResult(snapshot);
      if (!denseOnly && input.plan.queryPresent) {
        await prepareMemoryLexicalProviderReadiness({
          plan: input.plan,
          providerForLane,
          snapshot
        });
      }
      const core = !denseOnly && input.plan.applyResponsePreferences
        ? await settleMemoryLocalRead(
            input.settleSignal,
            () => loadCore(client, snapshot),
            []
          )
        : [];
      if (!input.plan.queryPresent) {
        return emptyResult(snapshot, core, input.vector ? "DISABLED" : "NOT_CONFIGURED");
      }
      const tasks: Array<Parameters<typeof executeMemoryRetrievalLaneTasks>[0][number]> = [];
      const lexicalEvidence: MemoryLexicalLaneEvidence[] = [];
      const vectorEvidence: MemoryVectorLaneEvidence[] = [];
      const lexicalExecutions: Array<ReturnType<typeof pushLexicalTasks>> = [];
      const vectorExecutions: Array<ReturnType<typeof pushVectorTasks>> = [];
      let baselineLexicalExecution: ReturnType<typeof pushLexicalTasks> | null = null;
      let enrichedLexicalExecution: ReturnType<typeof pushLexicalTasks> | null = null;
      let baselineTaskCount = 0;
      const separateBaseline = !denseOnly && input.baselinePlan &&
        input.baselinePlan !== input.plan
        ? input.baselinePlan
        : null;
      if (separateBaseline) {
        const baselineInput = { ...input, plan: separateBaseline };
        const baselineLexicalLanes = localLexicalLanes(snapshot, separateBaseline);
        const baselineVectorLanes = localVectorLanes(snapshot, baselineInput);
        const baselineEnabled = [...baselineLexicalLanes, ...baselineVectorLanes];
        if (baselineEnabled.length > 0) {
          const baselineAllocation = allocateMemoryRetrievalLaneLimits(baselineEnabled);
          baselineLexicalExecution = pushLexicalTasks(
            tasks,
            client,
            snapshot,
            separateBaseline,
            baselineAllocation,
            lexicalEvidence,
            providerForLane,
            "BASELINE"
          );
          lexicalExecutions.push(baselineLexicalExecution);
          vectorExecutions.push(pushVectorTasks(
            tasks,
            client,
            snapshot,
            baselineInput,
            vectorEvidence,
            baselineAllocation,
            "BASELINE"
          ));
        }
        baselineTaskCount = tasks.length;
      }
      const enrichedLexicalLanes = denseOnly ? [] : localLexicalLanes(snapshot, input.plan);
      const enrichedVectorLanes = localVectorLanes(snapshot, input);
      const enrichedEnabled = [...enrichedLexicalLanes, ...enrichedVectorLanes];
      if (enrichedEnabled.length > 0) {
        const enrichedAllocation = allocateMemoryRetrievalLaneLimits(
          enrichedEnabled,
          input.plan.aggregationRequested
        );
        if (enrichedLexicalLanes.length > 0) {
          enrichedLexicalExecution = pushLexicalTasks(
            tasks,
            client,
            snapshot,
            input.plan,
            enrichedAllocation,
            lexicalEvidence,
            providerForLane,
            "ENRICHED"
          );
          lexicalExecutions.push(enrichedLexicalExecution);
        }
        vectorExecutions.push(pushVectorTasks(
          tasks,
          client,
          snapshot,
          input,
          vectorEvidence,
          enrichedAllocation,
          "ENRICHED"
        ));
      }
      if (tasks.length === 0) return emptyResult(snapshot, core,
        input.vector ? "DISABLED" : "NOT_CONFIGURED");
      const executed = await executeMemoryRetrievalLaneTasks(
        tasks,
        MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
        input.settleSignal
      );
      let baselineLaneResults = separateBaseline
        ? executed.slice(0, baselineTaskCount)
        : input.baselinePlan ? executed : [];
      let enrichedLaneResults = separateBaseline
        ? executed.slice(baselineTaskCount)
        : executed;
      const deferredStages = [
        ...(separateBaseline && baselineLexicalExecution
          ? [{
              execution: baselineLexicalExecution,
              laneResults: baselineLaneResults
            }]
          : []),
        ...(enrichedLexicalExecution
          ? [{
              execution: enrichedLexicalExecution,
              laneResults: enrichedLaneResults
            }]
          : [])
      ];
      const runnableDeferredTasks = deferredStages.flatMap(({ execution, laneResults }) =>
        execution.deferredTasks.filter((task) =>
          shouldRunMemoryNgramFallback(
            task.lane,
            laneResults,
            execution.completePrimaryLanes()
          )));
      const deferredResults = runnableDeferredTasks.length > 0
        ? await executeMemoryRetrievalLaneTasks(
            runnableDeferredTasks,
            MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
            input.settleSignal
          )
        : [];
      const deferredByExecutionId = new Map(runnableDeferredTasks.map((task, index) => [
        task.executionId!,
        deferredResults[index]!
      ]));
      const withDeferredResults = (
        execution: ReturnType<typeof pushLexicalTasks> | null,
        laneResults: readonly MemoryLaneResult[]
      ) => orderedExecutionLaneResults([
        ...laneResults,
        ...(execution?.deferredTasks.map((task) =>
          deferredByExecutionId.get(task.executionId!) ?? {
            candidates: [],
            lane: task.lane
          }) ?? [])
      ]);
      baselineLaneResults = withDeferredResults(
        baselineLexicalExecution,
        baselineLaneResults
      );
      enrichedLaneResults = withDeferredResults(
        enrichedLexicalExecution,
        enrichedLaneResults
      );
      if (separateBaseline && baselineLexicalExecution) {
        scheduleMemoryLexicalShadowStage({
          client,
          plan: separateBaseline,
          postgresEvidence: baselineLexicalExecution.evidence(),
          referenceResults: baselineLaneResults,
          runtime: lexicalShadowRuntime,
          snapshot,
          specs: baselineLexicalExecution.shadowSpecs,
          stage: "BASELINE"
        });
      }
      if (enrichedLexicalExecution) {
        scheduleMemoryLexicalShadowStage({
          client,
          plan: input.plan,
          postgresEvidence: enrichedLexicalExecution.evidence(),
          referenceResults: enrichedLaneResults,
          runtime: lexicalShadowRuntime,
          snapshot,
          specs: enrichedLexicalExecution.shadowSpecs,
          stage: "ENRICHED"
        });
      }
      const stageLexicalStates: MemoryLocalRetrievalResult["lexicalState"][] = [];
      const stageVectorStates: MemoryLocalRetrievalResult["vectorState"][] = [];
      const stageLexicalFailures: MemoryRetrievalLane[] = [];
      if (separateBaseline) {
        const baselineStage = await executeDigestIntraChatStage({
          client,
          laneResults: baselineLaneResults,
          lexicalEvidence,
          providerForLane,
          retrievalInput: { ...input, plan: separateBaseline },
          shadowRuntime: lexicalShadowRuntime,
          settleSignal: input.settleSignal,
          snapshot,
          vectorEvidence
        });
        baselineLaneResults = baselineStage.laneResults;
        if (baselineStage.digestEvidence.secondStageQueryCount > 0) {
          stageLexicalStates.push(baselineStage.lexicalState);
          stageVectorStates.push(baselineStage.vectorState);
          stageLexicalFailures.push(...baselineStage.lexicalFailures);
        }
      }
      const enrichedStage = await executeDigestIntraChatStage({
        client,
        laneResults: enrichedLaneResults,
        lexicalEvidence,
        providerForLane,
        retrievalInput: input,
        shadowRuntime: lexicalShadowRuntime,
        settleSignal: input.settleSignal,
        snapshot,
        vectorEvidence
      });
      enrichedLaneResults = enrichedStage.laneResults;
      if (!separateBaseline && input.baselinePlan) {
        baselineLaneResults = enrichedLaneResults;
      }
      if (enrichedStage.digestEvidence.secondStageQueryCount > 0) {
        stageLexicalStates.push(enrichedStage.lexicalState);
        stageVectorStates.push(enrichedStage.vectorState);
        stageLexicalFailures.push(...enrichedStage.lexicalFailures);
      }
      const sourceFamily = input.baselinePlan
        ? applyMemorySourceFamilyRecallFloor({
            baselineLaneResults,
            baselinePlan: input.baselinePlan,
            enrichedLaneResults,
            enrichedPlan: input.plan,
            now: input.now
          })
        : { evidence: emptySourceFamilyEvidence, laneResults: enrichedLaneResults };
      const lexicalExecutionStates = [
        ...lexicalExecutions.map((execution) => execution.state()),
        ...stageLexicalStates
      ];
      const activeLexicalStates = lexicalExecutionStates.filter((state) =>
        state !== "DISABLED");
      const lexicalState: MemoryLocalRetrievalResult["lexicalState"] =
        activeLexicalStates.length === 0 ? "DISABLED"
          : activeLexicalStates.every((state) => state === "FAILED") ? "FAILED"
            : activeLexicalStates.some((state) => state !== "READY") ? "DEGRADED"
              : "READY";
      const vectorExecutionStates = [
        ...vectorExecutions.map((execution) => execution.state()),
        ...stageVectorStates
      ];
      const vectorState: MemoryLocalRetrievalResult["vectorState"] =
        vectorExecutionStates.some((state) => state === "DEGRADED") ? "DEGRADED"
          : vectorExecutionStates.some((state) => state === "READY") ? "READY"
            : vectorExecutionStates.length > 0 && vectorExecutionStates.every((state) =>
                state === "NOT_CONFIGURED") ? "NOT_CONFIGURED"
              : "DISABLED";
      const lexicalFailures = [...new Set([
        ...lexicalExecutions.flatMap((execution) => execution.failures()),
        ...stageLexicalFailures
      ])].sort((left, right) => left.localeCompare(right));
      const distinctVectorEvidence = [...new Map(vectorEvidence.map((entry) => [
        JSON.stringify(entry),
        entry
      ])).values()].sort((left, right) => left.itemType.localeCompare(right.itemType));
      return {
        core,
        digestEvidence: enrichedStage.digestEvidence,
        laneResults: suppressDigestCandidatesWithRawEvidence(sourceFamily.laneResults),
        lexicalEvidence: orderedLexicalEvidence(lexicalEvidence),
        lexicalFailures,
        lexicalState,
        snapshot,
        sourceFamilyEvidence: sourceFamily.evidence,
        vectorEvidence: distinctVectorEvidence,
        vectorState
      };
    }
  };
  const retrieveSpeculatively = async (
    input: MemoryLocalRetrievalInput,
    parentSignal?: AbortSignal,
    denseOnly = false
  ): Promise<MemoryLocalRetrievalResult> => {
    const controller = new AbortController();
    const forwardAbort = () => {
      if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted) forwardAbort();
    else parentSignal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = !controller.signal.aborted
      ? setTimeout(() => controller.abort({ code: "memory_speculative_baseline_settle" }),
          MEMORY_SPECULATIVE_BASELINE_SETTLE_MS)
      : null;
    try {
      const retrievalInput: MemoryLocalRetrievalInternalInput = denseOnly
        ? { ...input, [denseOnlyRetrieval]: true, settleSignal: controller.signal }
        : { ...input, settleSignal: controller.signal };
      return await repository.retrieve(retrievalInput);
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", forwardAbort);
    }
  };
  return Object.freeze({
    ...repository,
    /** Reader-first latency hedge. This deliberately executes only the
     * deterministic original-query plan supplied by admission: no vector,
     * planner rewrite, digest navigation, or provider-owned signal can delay
     * the complete exact/FTS/trigram baseline. */
    async retrieveSpeculativeBaseline(
      input: MemoryLocalRetrievalInput,
      parentSignal?: AbortSignal
    ) {
      return retrieveSpeculatively(input, parentSignal);
    },
    /** Once the original-query embedding is ready, execute only its dense
     * lanes. Admission joins this result with the already-running lexical
     * baseline, so one hedge never duplicates non-cancellable sparse SQL. */
    async retrieveSpeculativeDense(
      input: MemoryLocalRetrievalInput,
      parentSignal?: AbortSignal
    ) {
      if (!input.vector) throw new Error("memory_speculative_dense_vector_missing");
      return retrieveSpeculatively(input, parentSignal, true);
    }
  });
}

export type PrismaLocalMemoryRetrievalRepository = ReturnType<
  typeof createPrismaLocalMemoryRetrievalRepository
>;
