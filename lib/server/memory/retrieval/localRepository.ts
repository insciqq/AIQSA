import {
  Prisma,
  type MemorySearchItemType,
  type PrismaClient
} from "@prisma/client";
import {
  allocateMemoryRetrievalLaneLimits,
  executeMemoryRetrievalLaneTasks,
  MEMORY_CORE_MAX_FACTS,
  MEMORY_RETRIEVAL_FUSION_VERSION,
  MEMORY_RETRIEVAL_LANE_LIMITS,
  MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES,
  type MemoryCandidateMetadata,
  type MemoryCoreCandidate,
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
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256
} from "../persistence/lexical";
import { normalizeMemoryEntityAlias } from "../learning/entities/normalization";
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";
import { memoryPersonalFactEvidencePredicate } from "../persistence/eligibility";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import { memoryHistoryChunkSourceAuthorityPredicate } from "../persistence/pauseIntervals";
import {
  createPrismaMemoryVectorRepository,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
  type MemoryVectorLaneEvidence,
  type MemoryVectorProfile
} from "./vector";

export const MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION =
  "memory-local-retrieval-repository-v4";

export type MemoryLocalRetrievalStatus = "DISABLED" | "READY" | "UNAVAILABLE";

export type MemoryLocalRetrievalSnapshot = Readonly<{
  activeGenerationId: string | null;
  assistantId: string | null;
  chatId: string;
  chatMemoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  decayEnabled: boolean;
  decayPolicyVersion: string | null;
  folderId: string | null;
  historySuppressionIdentitySnapshot: string | null;
  indexMode: "HYBRID" | "LEXICAL_ONLY" | null;
  memoryGeneration: number;
  memoryRevision: number;
  reason: string;
  referenceChatHistory: boolean;
  repositoryVersion: string;
  settingsRevision: number;
  status: MemoryLocalRetrievalStatus;
  useMemoryFacts: boolean;
  userId: string;
}>;

export type MemoryLocalVectorQuery = Readonly<{
  minimumScore: number;
  profile: MemoryVectorProfile;
  vector: readonly number[];
}>;

export type MemoryLocalRetrievalInput = Readonly<{
  assistantId: string | null;
  chatId: string;
  now: Date;
  plan: MemoryRetrievalPlan;
  userId: string;
  vector?: MemoryLocalVectorQuery;
}>;

export type MemoryLocalRetrievalResult = Readonly<{
  core: readonly MemoryCoreCandidate[];
  laneResults: readonly MemoryLaneResult[];
  lexicalFailures: readonly MemoryRetrievalLane[];
  lexicalState: "DEGRADED" | "DISABLED" | "FAILED" | "READY";
  snapshot: MemoryLocalRetrievalSnapshot;
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
  generationPipelineVersion: string | null;
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
  directness: string | null;
  displayText: string | null;
  dimensionKey: string | null;
  entryId: string | null;
  entityIds: string[];
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
  matchedEntityRole: string | null;
  modality: string | null;
  observedAt: Date | null;
  occurredAt: Date | null;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  pinned: boolean;
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

type CoreRow = CandidateRow & Readonly<{ safeText: string }>;

type ExpandedRow = Readonly<{
  itemId: string;
  itemType: MemorySearchItemType;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  projectionKind: "CHAT_DIGEST_SAFE_TEXT" | "FACT_DISPLAY_TEXT" |
    "RECALL_CHUNK_SAFE_PROJECTED_TEXT";
  safeText: string;
  sourceChatId: string | null;
  supportingItemId: string | null;
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
const sourceAuthorities = new Set([
  "EXPLICIT", "DIRECT_AUTOMATIC", "PAST_CHAT", "SYNTHESIS"
]);
const retrievalSourceKinds = new Set(["EVENT", "FACT", "HISTORY"]);
const retrievalModes = new Set([
  "CURRENT_PROFILE", "TARGETED_CURRENT", "HISTORICAL_MEMORY",
  "PAST_CHAT_SEARCH", "HISTORY_OVERVIEW"
]);
const temporalIntents = new Set(["CURRENT", "HISTORICAL", "AS_OF", "BETWEEN", "ANY"]);

function validToken(value: unknown): value is string {
  return typeof value === "string" && opaqueTokenPattern.test(value);
}

function validDate(value: Date | null): boolean {
  return value === null || value instanceof Date && Number.isFinite(value.getTime());
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function nullableClosed(value: string | null, allowed: ReadonlySet<string>): boolean {
  return value === null || allowed.has(value);
}

function decodeMetadata(row: CandidateRow): MemoryCandidateMetadata {
  if (
    !validToken(row.itemId) || !validToken(row.dedupeKey) ||
    (row.entryId !== null && !validToken(row.entryId)) ||
    !["FACT_VERSION", "RECALL_CHUNK"].includes(row.itemType) ||
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
      !row.safeContentHash || row.structuredValue === null ||
      row.safeContentHash !== memorySha256({
        displayText: row.displayText,
        structuredValue: row.structuredValue
      })
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
  return {
    entryId: row.entryId,
    hardFilterPassed: true,
    itemId: row.itemId,
    itemType: row.itemType as "FACT_VERSION" | "RECALL_CHUNK",
    lane,
    metadata: decodeMetadata(row),
    rawScore: row.rawScore
  };
}

function decodeExpanded(row: ExpandedRow): MemoryExpandedCandidate {
  if (
    !validToken(row.itemId) ||
    !["FACT_VERSION", "RECALL_CHUNK"].includes(row.itemType) ||
    !["CHAT_DIGEST_SAFE_TEXT", "FACT_DISPLAY_TEXT",
      "RECALL_CHUNK_SAFE_PROJECTED_TEXT"].includes(row.projectionKind) ||
    typeof row.safeText !== "string" || !row.safeText.trim() || row.safeText.length > 4_000 ||
    row.safeText.includes("\u0000") ||
    (row.sourceChatId !== null && !validToken(row.sourceChatId)) ||
    (row.supportingItemId !== null && !validToken(row.supportingItemId)) ||
    !validDate(row.occurredFrom) || !validDate(row.occurredTo)
  ) throw new Error("memory_expansion_result_invalid");
  return {
    ...row,
    itemType: row.itemType as "FACT_VERSION" | "RECALL_CHUNK"
  };
}

function valuesSql(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

function expectedGenerationPipeline(indexMode: "HYBRID" | "LEXICAL_ONLY"): string {
  return indexMode === "HYBRID"
    ? MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    : MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION;
}

async function historySuppressionIdentity(
  client: PrismaClient,
  userId: string,
  now: Date
): Promise<string> {
  const [barriers, pauseIntervals, suppressions] = await Promise.all([
    client.memorySourceBarrier.findMany({
      orderBy: [{ sourceCreatedAtCutoff: "asc" }, { id: "asc" }],
      select: { id: true, kind: true, memoryGeneration: true, sourceCreatedAtCutoff: true },
      where: { explicitOverrideAllowed: false, userId }
    }),
    client.memoryPauseInterval.findMany({
      orderBy: [{ pausedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        memoryGeneration: true,
        pausedAt: true,
        resumedAt: true,
        scope: true
      },
      where: { scope: { in: ["MASTER", "SEARCH_HISTORY"] }, userId }
    }),
    client.memorySuppression.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        canonicalKeyHash: true,
        deletionGeneration: true,
        expiresAt: true,
        fingerprintKeyVersion: true,
        id: true,
        normalizedValueHash: true,
        normalizationVersion: true,
        scope: true,
        sourceBranchGeneration: true,
        sourceChatId: true,
        sourceMessageId: true
      },
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], userId }
    })
  ]);
  return memorySha256({ barriers, pauseIntervals, suppressions });
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
  const rows = await client.$queryRaw<SnapshotRow[]>(Prisma.sql`
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
      generation."retrievalPipelineVersion" AS "generationPipelineVersion"
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
  `);
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
  const indexMode = row.generationIndexMode;
  const generationReady = useMemoryFacts && row.activeIndexGenerationId !== null &&
    row.generationId === row.activeIndexGenerationId &&
    row.generationState === "ACTIVE" &&
    (indexMode === "HYBRID" || indexMode === "LEXICAL_ONLY") &&
    row.generationPipelineVersion === expectedGenerationPipeline(indexMode);
  const base = {
    activeGenerationId: row.activeIndexGenerationId,
    assistantId,
    chatId: input.chatId,
    chatMemoryMode: row.chatMemoryMode === "EXCLUDED" || row.chatMemoryMode === "TEMPORARY"
      ? row.chatMemoryMode
      : "NORMAL",
    decayEnabled: row.decayEnabled === true,
    decayPolicyVersion: row.decayPolicyVersion,
    folderId: row.chatFolderId,
    historySuppressionIdentitySnapshot: null,
    indexMode: generationReady ? indexMode : null,
    memoryGeneration: Number.isSafeInteger(row.memoryGeneration) ? Number(row.memoryGeneration) : 0,
    memoryRevision: Number.isSafeInteger(row.memoryRevision) ? Number(row.memoryRevision) : 0,
    referenceChatHistory,
    repositoryVersion: MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION,
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
  const suppressionIdentity = useMemoryFacts && referenceChatHistory
    ? await historySuppressionIdentity(client, input.userId, input.now)
    : null;
  if (suppressionIdentity !== null && !fingerprintPattern.test(suppressionIdentity)) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return {
    ...base,
    historySuppressionIdentitySnapshot: suppressionIdentity,
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

function factKindPredicate(plan: MemoryRetrievalPlan): Prisma.Sql {
  const fact = plan.filters.sourceKinds.includes("FACT");
  const event = plan.filters.sourceKinds.includes("EVENT");
  if (fact && event) return Prisma.sql`TRUE`;
  if (event) return Prisma.sql`version."modality" = 'EVENT'::"MemoryFactModality"`;
  if (fact) return Prisma.sql`version."modality" <> 'EVENT'::"MemoryFactModality"`;
  return Prisma.sql`FALSE`;
}

function factPlanPredicates(plan: MemoryRetrievalPlan): Prisma.Sql {
  const scope = plan.filters.scopeType
    ? Prisma.sql`scope."scopeType"::text = ${plan.filters.scopeType}`
    : Prisma.sql`TRUE`;
  const target = plan.filters.scopeTargetId
    ? Prisma.sql`scope."targetIdSnapshot" = ${plan.filters.scopeTargetId}`
    : Prisma.sql`TRUE`;
  const temporalStart = Prisma.sql`COALESCE(
    version."occurredAt", version."validFrom", version."observedAt", version."systemFrom"
  )`;
  const temporalEnd = Prisma.sql`COALESCE(version."validTo", version."systemTo")`;
  const from = plan.filters.from
    ? Prisma.sql`COALESCE(${temporalEnd}, ${temporalStart}) >= ${plan.filters.from}`
    : Prisma.sql`TRUE`;
  const to = plan.filters.to
    ? Prisma.sql`${temporalStart} < ${plan.filters.to}`
    : Prisma.sql`TRUE`;
  const asOf = plan.filters.asOf
    ? Prisma.sql`${temporalStart} <= ${plan.filters.asOf}
        AND (${temporalEnd} IS NULL OR ${temporalEnd} > ${plan.filters.asOf})`
    : Prisma.sql`TRUE`;
  return Prisma.sql`${factKindPredicate(plan)} AND ${scope} AND ${target}
    AND ${from} AND ${to} AND ${asOf}`;
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
  const from = plan.filters.from
    ? Prisma.sql`chunk."occurredTo" >= ${plan.filters.from}`
    : Prisma.sql`TRUE`;
  const to = plan.filters.to
    ? Prisma.sql`chunk."occurredFrom" < ${plan.filters.to}`
    : Prisma.sql`TRUE`;
  const asOf = plan.filters.asOf
    ? Prisma.sql`chunk."occurredFrom" <= ${plan.filters.asOf}
        AND chunk."occurredTo" > ${plan.filters.asOf}`
    : Prisma.sql`TRUE`;
  return Prisma.sql`${scope} AND ${from} AND ${to} AND ${asOf}`;
}

function historyDigestPlanPredicates(plan: MemoryRetrievalPlan): Prisma.Sql {
  if (plan.mode !== "HISTORY_OVERVIEW" ||
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
  const from = plan.filters.from
    ? Prisma.sql`digest."occurredTo" >= ${plan.filters.from}`
    : Prisma.sql`TRUE`;
  const to = plan.filters.to
    ? Prisma.sql`digest."occurredFrom" < ${plan.filters.to}`
    : Prisma.sql`TRUE`;
  const asOf = plan.filters.asOf
    ? Prisma.sql`digest."occurredFrom" <= ${plan.filters.asOf}
        AND digest."occurredTo" > ${plan.filters.asOf}`
    : Prisma.sql`TRUE`;
  return Prisma.sql`${scope} AND ${from} AND ${to} AND ${asOf}`;
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
    'FACT_VERSION'::"MemorySearchItemType" AS "itemType", fact."id" AS "factId",
    (CASE WHEN version."state" = 'SUPERSEDED'::"MemoryFactVersionState"
      THEN 'fact-version:' || version."id" ELSE 'fact:' || fact."id" END)::text AS "dedupeKey",
    fact."canonicalKey", fact."category", fact."identityKind"::text AS "identityKind",
    fact."subjectKey", fact."predicateKey", fact."dimensionKey",
    version."languageCode", version."modality"::text AS "modality",
    version."sourceMode"::text AS "sourceMode", version."directness"::text AS "directness",
    CASE WHEN version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode" THEN 'EXPLICIT'
      WHEN version."modality" = 'PATTERN'::"MemoryFactModality"
        THEN 'SYNTHESIS' ELSE 'DIRECT_AUTOMATIC' END::text AS "sourceAuthority",
    version."sensitivityClass"::text AS "sensitivityClass",
    NULL::text AS "historySafetyClass", scope."scopeType"::text AS "scopeType",
    scope."folderId" AS "sourceFolderId", scope."assistantId" AS "sourceAssistantId",
    scope."chatId" AS "sourceChatId", fact."pinned",
    fact."temperatureClass"::text AS "temperatureClass",
    fact."temperatureScore"::double precision AS "temperatureScore",
    fact."lastUsedAt", fact."lastConfirmedAt",
    version."confidence"::double precision AS "confidence",
    version."importance"::double precision AS "importance",
    version."coreEligible", version."coreSalience"::text AS "coreSalience",
    CASE scope."scopeType" WHEN 'CHAT'::"MemoryScopeType" THEN 1.0
      WHEN 'ASSISTANT'::"MemoryScopeType" THEN 0.9
      WHEN 'FOLDER'::"MemoryScopeType" THEN 0.8 ELSE 0.7 END::double precision AS "scopeAffinity",
    (version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND fact."currentVersionId" = version."id") AS "current",
    (version."state" = 'SUPERSEDED'::"MemoryFactVersionState") AS "historical",
    FALSE AS "conflict", version."state"::text AS "lifecycleState",
    version."observedAt", version."occurredAt", version."expectedAt", version."expiresAt",
    version."validFrom", version."validTo", version."systemFrom",
    ARRAY(SELECT link."entityId" FROM "MemoryFactVersionEntity" AS link
      WHERE link."userId" = version."userId" AND link."factVersionId" = version."id"
      ORDER BY link."entityId" LIMIT 32)::text[] AS "entityIds",
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

function factEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): Prisma.Sql {
  if (!snapshot.activeGenerationId) throw new Error("memory_retrieval_snapshot_invalid");
  return Prisma.sql`
    SELECT ${factColumns(
      Prisma.sql`entry."id"`,
      Prisma.sql`NULL::text`,
      Prisma.sql`entry."safeContentHash"`
    )},
      entry."normalizedSearchText", entry."searchVectorSimple"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId" AND settings."useMemoryFacts" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId" AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND generation."retrievalPipelineVersion" =
        ${expectedGenerationPipeline(snapshot.indexMode!)}
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = entry."userId" AND version."id" = entry."factVersionId"
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
      AND ${factLifecyclePredicate(plan)}
      AND ${memoryFactScopePredicate(snapshot)}
      AND ${memoryReusableFactAuthorityPredicate(snapshot.userId)}
      AND ${memoryActiveSuppressionPredicate(snapshot.userId)}
      AND ${memoryFactConversationFeedbackPredicate(snapshot)}
      AND ${factPlanPredicates(plan)}
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
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
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
  const rows = await client.$queryRaw<CoreRow[]>(coreSql(snapshot));
  return rows.map((row): MemoryCoreCandidate => {
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
    return {
      candidate,
      expansion: {
        itemId: row.itemId,
        itemType: "FACT_VERSION",
        occurredFrom: null,
        occurredTo: null,
        projectionKind: "FACT_DISPLAY_TEXT",
        safeText: row.safeText,
        sourceChatId: null,
        supportingItemId: null
      }
    };
  });
}

function historyDigestEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): Prisma.Sql {
  if (!snapshot.historySuppressionIdentitySnapshot) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT NULL::text AS "entryId", chunk."id" AS "itemId",
      digest."contentHash" AS "safeContentHash", NULL::text AS "displayText",
      NULL::jsonb AS "structuredValue",
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

function historyEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): Prisma.Sql {
  if (plan.mode === "HISTORY_OVERVIEW") {
    return historyDigestEligibleSelect(snapshot, plan);
  }
  if (!snapshot.activeGenerationId || !snapshot.historySuppressionIdentitySnapshot) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT entry."id" AS "entryId", chunk."id" AS "itemId",
      entry."safeContentHash", NULL::text AS "displayText",
      NULL::jsonb AS "structuredValue",
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
      entry."normalizedSearchText", entry."searchVectorSimple"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId" AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
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
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryChunkConversationFeedbackPredicate(snapshot)}
      AND ${memoryChunkSourceSafetyPredicate()}
      AND ${historyPlanPredicates(plan)}
  `;
}

function candidateColumns(
  rawScore: Prisma.Sql,
  matchedEntityRole: Prisma.Sql = Prisma.sql`eligible."matchedEntityRole"`
): Prisma.Sql {
  return Prisma.sql`
    eligible."entryId", eligible."itemId", eligible."itemType", eligible."factId",
    eligible."safeContentHash", eligible."displayText", eligible."structuredValue",
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
    eligible."occurredFrom", eligible."occurredTo", ${rawScore}::double precision AS "rawScore"
  `;
}

function exactSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  limit: number
): Prisma.Sql {
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(snapshot, plan)
    : historyEligibleSelect(snapshot, plan);
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    SELECT ${candidateColumns(Prisma.sql`1.0`)} FROM eligible
    WHERE eligible."normalizedSearchText" = ${plan.normalizedExactQuery}
    ORDER BY eligible."itemId" LIMIT ${limit}
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

function entitySql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  limit: number
): Prisma.Sql {
  const terms = entityQueryTerms(plan.normalizedQuery);
  if (terms.length === 0) throw new Error("memory_retrieval_lane_invalid");
  return Prisma.sql`
    WITH RECURSIVE
    eligible AS MATERIALIZED (${factEligibleSelect(snapshot, plan)}),
    matched_alias_entities AS MATERIALIZED (
      SELECT DISTINCT alias."entityId"
      FROM "MemoryEntityAlias" AS alias
      WHERE alias."userId" = ${snapshot.userId}
        AND alias."normalizedAlias" IN (${Prisma.join(terms)})
        AND EXISTS (
          SELECT 1 FROM "MemoryEntityAliasSupport" AS support
          WHERE support."userId" = alias."userId" AND support."aliasId" = alias."id"
        )
    ),
    entity_roots AS (
      SELECT entity."id" AS "originId", entity."id" AS "entityId",
        entity."mergedIntoId", ARRAY[entity."id"]::text[] AS visited,
        FALSE AS cycle
      FROM "MemoryEntity" AS entity
      INNER JOIN matched_alias_entities AS matched
        ON matched."entityId" = entity."id"
      WHERE entity."userId" = ${snapshot.userId}

      UNION ALL

      SELECT roots."originId", entity."id", entity."mergedIntoId",
        roots.visited || entity."id", entity."id" = ANY(roots.visited)
      FROM entity_roots AS roots
      INNER JOIN "MemoryEntity" AS entity
        ON entity."userId" = ${snapshot.userId}
        AND entity."id" = roots."mergedIntoId"
      WHERE NOT roots.cycle
    ),
    root_map AS MATERIALIZED (
      SELECT "originId", "entityId" AS "rootId"
      FROM entity_roots
      WHERE "mergedIntoId" IS NULL AND NOT cycle
    ),
    matched_roots AS MATERIALIZED (
      SELECT DISTINCT root_map."rootId" FROM root_map
    ),
    root_members AS (
      SELECT matched."rootId", matched."rootId" AS "entityId",
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
          link."role"::text))[1] AS role
      FROM "MemoryFactVersionEntity" AS link
      INNER JOIN root_members AS member
        ON member."entityId" = link."entityId" AND NOT member.cycle
      WHERE link."userId" = ${snapshot.userId}
      GROUP BY link."factVersionId"
    )
    SELECT ${candidateColumns(Prisma.sql`linked.score`, Prisma.sql`linked.role`)}
    FROM eligible
    INNER JOIN linked ON linked."factVersionId" = eligible."itemId"
    ORDER BY linked.score DESC, eligible."itemId"
    LIMIT ${limit}
  `;
}

function profileSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  limit: number
): Prisma.Sql {
  const eligible = factEligibleSelect(snapshot, plan);
  const authorityScore = Prisma.sql`CASE
    WHEN eligible."sourceMode" = 'EXPLICIT' THEN 1.0
    ELSE 0.8
  END`;
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    SELECT ${candidateColumns(authorityScore)} FROM eligible
    ORDER BY (eligible."sourceMode" = 'EXPLICIT') DESC,
      eligible."pinned" DESC,
      eligible."importance" DESC,
      eligible."confidence" DESC,
      eligible."systemFrom" DESC,
      eligible."itemId"
    LIMIT ${limit}
  `;
}

function ftsSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  limit: number
): Prisma.Sql {
  if (!plan.lexicalQuery) throw new Error("memory_retrieval_lane_invalid");
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(snapshot, plan)
    : historyEligibleSelect(snapshot, plan);
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible}),
    whole_query AS (SELECT plainto_tsquery('simple', ${plan.lexicalQuery}) AS query)
    SELECT ${candidateColumns(Prisma.sql`ts_rank_cd(eligible."searchVectorSimple", whole_query.query)`)}
    FROM eligible CROSS JOIN whole_query
    WHERE eligible."searchVectorSimple" @@ whole_query.query
    ORDER BY ts_rank_cd(eligible."searchVectorSimple", whole_query.query) DESC,
      eligible."itemId" LIMIT ${limit}
  `;
}

function recentSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  limit: number
): Prisma.Sql {
  if (!plan.recencyRequested && plan.mode !== "HISTORY_OVERVIEW") {
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

async function queryLane(
  client: PrismaClient,
  lane: MemoryRetrievalLane,
  limit: number,
  sql: Prisma.Sql
): Promise<MemoryLaneResult> {
  const rows = await client.$queryRaw<CandidateRow[]>(sql);
  if (rows.length > limit) throw new Error("memory_retrieval_result_invalid");
  const candidates = rows.map((row) => decodeCandidate(row, lane));
  if (new Set(candidates.map((candidate) => `${candidate.itemType}:${candidate.itemId}`)).size !==
    candidates.length) throw new Error("memory_retrieval_result_invalid");
  return { candidates, lane };
}

function localLexicalLanes(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): readonly MemoryRetrievalLane[] {
  if (!snapshot.activeGenerationId || !snapshot.indexMode || !plan.queryPresent) return [];
  const lanes: MemoryRetrievalLane[] = [];
  if (snapshot.useMemoryFacts &&
    (plan.filters.sourceKinds.includes("FACT") || plan.filters.sourceKinds.includes("EVENT"))) {
    if (plan.profileRequested) lanes.push("FACT_PROFILE");
    else {
      lanes.push("FACT_EXACT");
      lanes.push("FACT_ENTITY");
      if (plan.lexicalQuery) lanes.push("FACT_FTS_SIMPLE");
      if (plan.recencyRequested) lanes.push("FACT_RECENT");
    }
  }
  if (!plan.profileRequested && snapshot.useMemoryFacts && snapshot.referenceChatHistory &&
    plan.filters.sourceKinds.includes("HISTORY")) {
    if (plan.mode === "HISTORY_OVERVIEW") {
      if (plan.lexicalQuery) lanes.push("HISTORY_RECALL_FTS_SIMPLE");
      lanes.push("HISTORY_RECALL_RECENT");
    } else {
      lanes.push("HISTORY_RECALL_EXACT");
      if (plan.lexicalQuery) lanes.push("HISTORY_RECALL_FTS_SIMPLE");
      if (plan.recencyRequested) lanes.push("HISTORY_RECALL_RECENT");
    }
  }
  return lanes;
}

function allocatedLimit(
  allocation: MemoryRetrievalLaneLimitAllocation,
  lane: MemoryRetrievalLane
): number {
  const limit = allocation[lane];
  if (!Number.isSafeInteger(limit) || !limit || limit < 1 || limit > MEMORY_RETRIEVAL_LANE_LIMITS[lane]) {
    throw new Error("memory_retrieval_lane_contract_invalid");
  }
  return limit;
}

function laneSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  lane: MemoryRetrievalLane,
  limit: number
): Prisma.Sql {
  const itemType = lane.startsWith("FACT_") ? "FACT_VERSION" : "RECALL_CHUNK";
  if (lane === "FACT_PROFILE") return profileSql(snapshot, plan, limit);
  if (lane === "FACT_ENTITY") return entitySql(snapshot, plan, limit);
  if (lane.endsWith("_EXACT")) return exactSql(snapshot, plan, itemType, limit);
  if (lane.endsWith("_FTS_SIMPLE")) return ftsSql(snapshot, plan, itemType, limit);
  if (lane.endsWith("_RECENT")) return recentSql(snapshot, plan, itemType, limit);
  throw new Error("memory_retrieval_lane_contract_invalid");
}

function pushLexicalTasks(
  tasks: Array<Parameters<typeof executeMemoryRetrievalLaneTasks>[0][number]>,
  client: PrismaClient,
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  allocation: MemoryRetrievalLaneLimitAllocation
): Readonly<{
  failures(): readonly MemoryRetrievalLane[];
  state(): MemoryLocalRetrievalResult["lexicalState"];
}> {
  const failures: MemoryRetrievalLane[] = [];
  const lanes = localLexicalLanes(snapshot, plan);
  for (const lane of lanes) {
    const limit = allocatedLimit(allocation, lane);
    const sql = laneSql(snapshot, plan, lane, limit);
    tasks.push({
      async execute() {
        try {
          return await queryLane(client, lane, limit, sql);
        } catch {
          failures.push(lane);
          return { candidates: [], lane };
        }
      },
      lane
    });
  }
  return {
    failures: () => [...failures].sort((left, right) => left.localeCompare(right)),
    state: () => lanes.length === 0 ? "DISABLED" : failures.length === 0 ? "READY"
      : failures.length === lanes.length ? "FAILED" : "DEGRADED"
  };
}

function vectorScoreSql(hits: readonly Readonly<{ entryId: string; score: number }>[]): Prisma.Sql {
  return Prisma.sql`CASE eligible."entryId"
    ${Prisma.join(hits.map((hit) => Prisma.sql`WHEN ${hit.entryId} THEN ${hit.score}`), " ")}
    ELSE -1.0::double precision END`;
}

function vectorMetadataSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "FACT_VERSION" | "RECALL_CHUNK",
  hits: readonly Readonly<{ entryId: string; score: number }>[],
  limit: number
): Prisma.Sql {
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(snapshot, plan)
    : historyEligibleSelect(snapshot, plan);
  const score = vectorScoreSql(hits);
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    SELECT ${candidateColumns(score)} FROM eligible
    WHERE eligible."entryId" IN (${valuesSql(hits.map((hit) => hit.entryId))})
    ORDER BY ${score} DESC, eligible."itemId" LIMIT ${limit}
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
  allocation: MemoryRetrievalLaneLimitAllocation
): Readonly<{ state(): MemoryLocalRetrievalResult["vectorState"] }> {
  if (!input.vector || snapshot.indexMode !== "HYBRID") {
    return { state: () => input.vector ? "DISABLED" : "NOT_CONFIGURED" };
  }
  const lanes = localVectorLanes(snapshot, input);
  if (lanes.length === 0) return { state: () => "DISABLED" };
  const itemTypes = lanes.map((lane) =>
    lane === "FACT_VECTOR" ? "FACT_VERSION" as const : "RECALL_CHUNK" as const);
  const limit = Math.max(...lanes.map((lane) => allocatedLimit(allocation, lane)));
  let state: MemoryLocalRetrievalResult["vectorState"] = "READY";
  const result = createPrismaMemoryVectorRepository(client).search({
    eligibility: {
      allowedFactSensitivity: ["NORMAL", "SENSITIVE"],
      allowedHistorySafety: ["NORMAL", "SENSITIVE"],
      assistantId: snapshot.assistantId,
      chatId: snapshot.chatId,
      factMode: input.plan.mode === "HISTORICAL_MEMORY" ? "HISTORICAL" : "CURRENT",
      factTemporalAsOf: input.plan.filters.asOf,
      folderId: snapshot.folderId,
      occurredFrom: input.plan.filters.from,
      occurredTo: input.plan.filters.to,
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
  for (const itemType of itemTypes) {
    const lane: MemoryRetrievalLane = itemType === "FACT_VERSION"
      ? "FACT_VECTOR"
      : "HISTORY_RECALL_VECTOR";
    const laneLimit = allocatedLimit(allocation, lane);
    tasks.push({
      async execute() {
        const searched = await result;
        if (searched.status !== "READY") return { candidates: [], lane };
        const hits = searched.hits.filter((hit) => hit.itemType === itemType);
        return hits.length === 0 ? { candidates: [], lane }
          : queryLane(client, lane, laneLimit,
              vectorMetadataSql(snapshot, input.plan, itemType, hits, laneLimit));
      },
      lane
    });
  }
  return { state: () => state };
}

function currentFactExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${factEligibleSelect(snapshot, plan)})
    SELECT eligible."itemId", eligible."itemType", version."displayText" AS "safeText",
      'FACT_DISPLAY_TEXT'::text AS "projectionKind", NULL::text AS "sourceChatId",
      NULL::text AS "supportingItemId", NULL::timestamp AS "occurredFrom",
      NULL::timestamp AS "occurredTo"
    FROM eligible INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = ${snapshot.userId} AND version."id" = eligible."itemId"
    WHERE eligible."itemId" IN (${valuesSql(ids)}) ORDER BY eligible."itemId"
  `;
}

function chunkExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${historyEligibleSelect(snapshot, plan)})
    SELECT eligible."itemId", eligible."itemType", chunk."safeProjectedText" AS "safeText",
      'RECALL_CHUNK_SAFE_PROJECTED_TEXT'::text AS "projectionKind",
      chunk."chatId" AS "sourceChatId", NULL::text AS "supportingItemId",
      chunk."occurredFrom", chunk."occurredTo"
    FROM eligible INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = ${snapshot.userId} AND chunk."id" = eligible."itemId"
    WHERE eligible."itemId" IN (${valuesSql(ids)}) ORDER BY eligible."itemId"
  `;
}

function digestExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${historyDigestEligibleSelect(snapshot, plan)})
    SELECT eligible."itemId", eligible."itemType",
      digest."safeDigestText" AS "safeText",
      'CHAT_DIGEST_SAFE_TEXT'::text AS "projectionKind",
      digest."chatId" AS "sourceChatId", digest."id" AS "supportingItemId",
      digest."occurredFrom", digest."occurredTo"
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
        plan.temporalIntent === "CURRENT"
      : plan.mode === "HISTORICAL_MEMORY"
        ? !plan.profileRequested && facts && !history && plan.temporalIntent !== "CURRENT"
        : plan.mode === "PAST_CHAT_SEARCH"
          ? !plan.profileRequested && !facts && history &&
            plan.temporalIntent !== "HISTORICAL"
          : !plan.profileRequested && !facts && history && !plan.recencyRequested;
  return typeof plan.applyResponsePreferences === "boolean" &&
    typeof plan.profileRequested === "boolean" &&
    retrievalModes.has(plan.mode) && temporalIntents.has(plan.temporalIntent) &&
    Array.isArray(requestedKinds) &&
    requestedKinds.length <= retrievalSourceKinds.size &&
    (requestedKinds.length > 0 || plan.applyResponsePreferences) &&
    new Set(requestedKinds).size === requestedKinds.length &&
    requestedKinds.every((kind) => retrievalSourceKinds.has(kind)) &&
    plan.normalizedQuery.length <= 2_000 &&
    plan.normalizedExactQuery.length <= 2_000 &&
    plan.queryPresent === (plan.normalizedQuery.length > 0) &&
    typeof plan.recencyRequested === "boolean" &&
    validDate(plan.filters.asOf) && validDate(plan.filters.from) && validDate(plan.filters.to) &&
    !(plan.filters.asOf && (plan.filters.from || plan.filters.to)) &&
    temporalShape && modeShape &&
    (!plan.profileRequested || !plan.recencyRequested) &&
    (plan.lexicalQuery === null || plan.lexicalQuery.length <= 2_000);
}

function emptyResult(
  snapshot: MemoryLocalRetrievalSnapshot,
  core: readonly MemoryCoreCandidate[] = [],
  vectorState: MemoryLocalRetrievalResult["vectorState"] = "DISABLED"
): MemoryLocalRetrievalResult {
  return {
    core,
    laneResults: [],
    lexicalFailures: [],
    lexicalState: "DISABLED",
    snapshot,
    vectorEvidence: [],
    vectorState
  };
}

export function createPrismaLocalMemoryRetrievalRepository(client: PrismaClient = prisma) {
  return Object.freeze({
    async expand(
      snapshot: MemoryLocalRetrievalSnapshot,
      plan: MemoryRetrievalPlan,
      candidates: readonly MemoryRankedCandidate[]
    ): Promise<readonly MemoryExpandedCandidate[]> {
      if (
        snapshot.status !== "READY" || !snapshot.activeGenerationId || !snapshot.indexMode ||
        candidates.length > MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES ||
        new Set(candidates.map((candidate) => `${candidate.itemType}:${candidate.itemId}`)).size !==
          candidates.length || candidates.some((candidate) => !validToken(candidate.itemId))
      ) throw new Error("memory_expansion_contract_invalid");
      const factIds = candidates.filter((candidate) => candidate.itemType === "FACT_VERSION")
        .map((candidate) => candidate.itemId);
      const chunkIds = candidates.filter((candidate) => candidate.itemType === "RECALL_CHUNK")
        .map((candidate) => candidate.itemId);
      const queries: Promise<ExpandedRow[]>[] = [];
      if (factIds.length > 0) queries.push(client.$queryRaw<ExpandedRow[]>(
        currentFactExpansionSql(snapshot, plan, factIds)));
      if (chunkIds.length > 0) queries.push(client.$queryRaw<ExpandedRow[]>(
        plan.mode === "HISTORY_OVERVIEW"
          ? digestExpansionSql(snapshot, plan, chunkIds)
          : chunkExpansionSql(snapshot, plan, chunkIds)));
      const decoded = (await Promise.all(queries)).flat().map(decodeExpanded);
      const keys = decoded.map((row) => `${row.itemType}:${row.itemId}`);
      if (new Set(keys).size !== keys.length) throw new Error("memory_expansion_result_invalid");
      const byKey = new Map(decoded.map((row) => [`${row.itemType}:${row.itemId}`, row]));
      return candidates.flatMap((candidate) => {
        const value = byKey.get(`${candidate.itemType}:${candidate.itemId}`);
        return value ? [value] : [];
      });
    },

    snapshot(input: MemoryLocalRetrievalInput): Promise<MemoryLocalRetrievalSnapshot> {
      return loadSnapshot(client, input);
    },

    async retrieve(input: MemoryLocalRetrievalInput): Promise<MemoryLocalRetrievalResult> {
      if (!validPlan(input.plan)) throw new Error("memory_retrieval_plan_invalid");
      const snapshot = await loadSnapshot(client, input);
      if (snapshot.status !== "READY") return emptyResult(snapshot);
      const core = input.plan.applyResponsePreferences
        ? await loadCore(client, snapshot)
        : [];
      if (!input.plan.queryPresent || !snapshot.activeGenerationId || !snapshot.indexMode) {
        return emptyResult(snapshot, core, input.vector ? "DISABLED" : "NOT_CONFIGURED");
      }
      const lexicalLanes = localLexicalLanes(snapshot, input.plan);
      const vectorLanes = localVectorLanes(snapshot, input);
      const enabled = [...lexicalLanes, ...vectorLanes];
      if (enabled.length === 0) return emptyResult(snapshot, core,
        input.vector ? "DISABLED" : "NOT_CONFIGURED");
      const allocation = allocateMemoryRetrievalLaneLimits(enabled);
      const tasks: Array<Parameters<typeof executeMemoryRetrievalLaneTasks>[0][number]> = [];
      const lexical = pushLexicalTasks(tasks, client, snapshot, input.plan, allocation);
      const vectorEvidence: MemoryVectorLaneEvidence[] = [];
      const vector = pushVectorTasks(tasks, client, snapshot, input, vectorEvidence, allocation);
      const laneResults = await executeMemoryRetrievalLaneTasks(tasks);
      return {
        core,
        laneResults,
        lexicalFailures: lexical.failures(),
        lexicalState: lexical.state(),
        snapshot,
        vectorEvidence: vectorEvidence.sort((left, right) => left.itemType.localeCompare(right.itemType)),
        vectorState: vector.state()
      };
    }
  });
}

export type PrismaLocalMemoryRetrievalRepository = ReturnType<
  typeof createPrismaLocalMemoryRetrievalRepository
>;
