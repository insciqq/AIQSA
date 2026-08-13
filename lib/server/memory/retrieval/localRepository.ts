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
import {
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256
} from "../persistence/lexical";
import {
  createPrismaMemoryVectorRepository,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
  type MemoryVectorLaneEvidence,
  type MemoryVectorProfile
} from "./vector";

export const MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION =
  "memory-local-retrieval-repository-v3";

export type MemoryLocalRetrievalStatus = "DISABLED" | "READY" | "UNAVAILABLE";

export type MemoryLocalRetrievalSnapshot = Readonly<{
  activeGenerationId: string | null;
  assistantId: string | null;
  chatId: string;
  chatMemoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
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
  entryId: string | null;
  factId: string | null;
  historical: boolean;
  historySafetyClass: string | null;
  importance: number;
  itemId: string;
  itemType: MemorySearchItemType;
  languageCode: string;
  modality: string | null;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  pinned: boolean;
  rawScore: number;
  scopeAffinity: number;
  scopeType: string | null;
  sensitivityClass: string | null;
  sourceAssistantId: string | null;
  sourceChatId: string | null;
  sourceFolderId: string | null;
  sourceMode: string | null;
  systemFrom: Date | null;
  temperatureClass: string | null;
  validFrom: Date | null;
  validTo: Date | null;
}>;

type CoreRow = CandidateRow & Readonly<{ safeText: string }>;

type ExpandedRow = Readonly<{
  itemId: string;
  itemType: MemorySearchItemType;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  projectionKind: "FACT_DISPLAY_TEXT" | "RECALL_CHUNK_SAFE_PROJECTED_TEXT";
  safeText: string;
  sourceChatId: string | null;
  supportingItemId: null;
}>;

const opaqueTokenPattern = /^[^\u0000-\u0020\u007f]{1,256}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const modalities = new Set([
  "STATE", "PREFERENCE", "CONSTRAINT", "CONSIDERATION", "INTENTION",
  "PLAN", "EVENT", "HABIT", "WORKFLOW"
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
    !nullableClosed(row.directness, directnessValues) ||
    !nullableClosed(row.modality, modalities) ||
    !nullableClosed(row.scopeType, scopeTypes) ||
    !nullableClosed(row.sensitivityClass, sensitivityClasses) ||
    !nullableClosed(row.sourceMode, sourceModes) ||
    !nullableClosed(row.temperatureClass, temperatureClasses) ||
    !nullableClosed(row.historySafetyClass, historySafetyClasses) ||
    !coreSaliences.has(row.coreSalience) ||
    [row.occurredFrom, row.occurredTo, row.systemFrom, row.validFrom, row.validTo]
      .some((value) => !validDate(value)) ||
    row.current === row.historical
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
    factId: row.factId,
    historical: row.historical,
    historySafetyClass: row.historySafetyClass as MemoryCandidateMetadata["historySafetyClass"],
    importance: row.importance,
    languageCode: row.languageCode,
    modality: row.modality as MemoryCandidateMetadata["modality"],
    occurredFrom: row.occurredFrom,
    occurredTo: row.occurredTo,
    pinned: row.pinned,
    scopeAffinity: row.scopeAffinity,
    scopeType: row.scopeType as MemoryCandidateMetadata["scopeType"],
    sensitivityClass: row.sensitivityClass as MemoryCandidateMetadata["sensitivityClass"],
    sourceAssistantId: row.sourceAssistantId,
    sourceChatId: row.sourceChatId,
    sourceFolderId: row.sourceFolderId,
    sourceMode: row.sourceMode as MemoryCandidateMetadata["sourceMode"],
    systemFrom: row.systemFrom,
    temperatureClass: row.temperatureClass as MemoryCandidateMetadata["temperatureClass"],
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
    !["FACT_DISPLAY_TEXT", "RECALL_CHUNK_SAFE_PROJECTED_TEXT"].includes(row.projectionKind) ||
    typeof row.safeText !== "string" || !row.safeText.trim() || row.safeText.length > 4_000 ||
    row.safeText.includes("\u0000") ||
    (row.sourceChatId !== null && !validToken(row.sourceChatId)) ||
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
  const [barriers, suppressions] = await Promise.all([
    client.memorySourceBarrier.findMany({
      orderBy: [{ sourceCreatedAtCutoff: "asc" }, { id: "asc" }],
      select: { id: true, kind: true, memoryGeneration: true, sourceCreatedAtCutoff: true },
      where: { userId }
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
        sourceEpisodeId: true,
        sourceMessageId: true
      },
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], userId }
    })
  ]);
  return memorySha256({ barriers, suppressions });
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
  const generationReady = row.activeIndexGenerationId !== null &&
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
  if (!useMemoryFacts && !referenceChatHistory) {
    return { ...base, reason: "memory_reads_disabled", status: "DISABLED" };
  }
  const suppressionIdentity = referenceChatHistory
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
  snapshot: Pick<MemoryLocalRetrievalSnapshot, "assistantId" | "chatId" | "folderId" | "userId">
): Prisma.Sql {
  return Prisma.sql`(
    (scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      AND scope."targetIdSnapshot" IS NULL AND scope."folderId" IS NULL
      AND scope."assistantId" IS NULL AND scope."chatId" IS NULL)
    OR (scope."scopeType" = 'FOLDER'::"MemoryScopeType"
      AND scope."folderId" = ${snapshot.folderId} AND scope."targetIdSnapshot" = scope."folderId"
      AND scope."assistantId" IS NULL AND scope."chatId" IS NULL
      AND EXISTS (SELECT 1 FROM "Folder" AS scope_folder
        WHERE scope_folder."userId" = fact."userId" AND scope_folder."id" = scope."folderId"))
    OR (scope."scopeType" = 'ASSISTANT'::"MemoryScopeType"
      AND scope."assistantId" = ${snapshot.assistantId}
      AND scope."targetIdSnapshot" = scope."assistantId"
      AND scope."folderId" IS NULL AND scope."chatId" IS NULL
      AND EXISTS (SELECT 1 FROM "AssistantDefinition" AS scope_assistant
        WHERE scope_assistant."ownerUserId" = fact."userId"
          AND scope_assistant."id" = scope."assistantId"
          AND scope_assistant."archivedAt" IS NULL))
    OR (scope."scopeType" = 'CHAT'::"MemoryScopeType"
      AND scope."chatId" = ${snapshot.chatId} AND scope."targetIdSnapshot" = scope."chatId"
      AND scope."folderId" IS NULL AND scope."assistantId" IS NULL
      AND EXISTS (SELECT 1 FROM "Chat" AS scope_chat
        WHERE scope_chat."userId" = fact."userId" AND scope_chat."id" = scope."chatId"
          AND scope_chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"))
  )`;
}

export function memoryAutomaticFactEvidencePredicate(userId: string): Prisma.Sql {
  return Prisma.sql`(
    version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
    OR EXISTS (
      SELECT 1 FROM "MemoryEvidence" AS support
      INNER JOIN "Chat" AS evidence_chat
        ON evidence_chat."userId" = support."userId" AND evidence_chat."id" = support."chatId"
        AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND evidence_chat."memoryBranchGeneration" = support."branchGeneration"
      INNER JOIN "Message" AS evidence_message
        ON evidence_message."chatId" = support."chatId" AND evidence_message."id" = support."messageId"
        AND evidence_message."role" = 'user'
      WHERE support."userId" = ${userId} AND support."factVersionId" = version."id"
        AND support."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
        AND support."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
        AND support."sourceRole" = 'user'
        AND NOT EXISTS (
          SELECT 1 FROM "MemorySuppression" AS source_suppression
          WHERE source_suppression."userId" = support."userId"
            AND source_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND source_suppression."sourceChatId" = support."chatId"
            AND source_suppression."sourceMessageId" = support."messageId"
            AND (source_suppression."sourceBranchGeneration" IS NULL
              OR source_suppression."sourceBranchGeneration" = support."branchGeneration")
            AND (source_suppression."expiresAt" IS NULL
              OR source_suppression."expiresAt" > CURRENT_TIMESTAMP)
        )
        AND NOT EXISTS (
          SELECT 1 FROM "MemorySourceBarrier" AS source_barrier
          WHERE source_barrier."userId" = support."userId"
            AND source_barrier."kind" IN (
              'AUTOMATIC_FACTS'::"MemorySourceBarrierKind", 'ALL_REUSABLE'::"MemorySourceBarrierKind"
            )
            AND evidence_message."createdAt" <= source_barrier."sourceCreatedAtCutoff"
        )
    )
  )`;
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

// Recovery of already accepted legacy runs may still revalidate an episode.
// New retrieval never schedules, expands, or freezes this item type.
export function memoryEpisodeSourceSafetyPredicate(): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1 FROM "MemorySuppression" AS history_suppression
      WHERE history_suppression."userId" = episode."userId"
        AND (history_suppression."expiresAt" IS NULL
          OR history_suppression."expiresAt" > CURRENT_TIMESTAMP)
        AND (history_suppression."scope" = 'ALL'::"MemorySuppressionScope"
          OR (history_suppression."scope" = 'SOURCE_EPISODE'::"MemorySuppressionScope"
            AND history_suppression."sourceEpisodeId" = episode."id")
          OR (history_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND history_suppression."sourceChatId" = episode."chatId"
            AND (history_suppression."sourceBranchGeneration" IS NULL
              OR history_suppression."sourceBranchGeneration" = episode."branchGeneration")
            AND EXISTS (SELECT 1 FROM "MemoryEpisodeMessage" AS suppressed_episode_message
              WHERE suppressed_episode_message."userId" = episode."userId"
                AND suppressed_episode_message."episodeId" = episode."id"
                AND suppressed_episode_message."messageId" = history_suppression."sourceMessageId")))
    )
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySourceBarrier" AS history_barrier
      WHERE history_barrier."userId" = episode."userId"
        AND history_barrier."kind" IN (
          'HISTORY_INDEX'::"MemorySourceBarrierKind", 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        AND (episode."createdAt" <= history_barrier."createdAt" OR EXISTS (
          SELECT 1 FROM "MemoryEpisodeMessage" AS barrier_episode_message
          INNER JOIN "Message" AS barrier_message
            ON barrier_message."chatId" = barrier_episode_message."chatId"
            AND barrier_message."id" = barrier_episode_message."messageId"
          WHERE barrier_episode_message."userId" = episode."userId"
            AND barrier_episode_message."episodeId" = episode."id"
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
  const from = plan.filters.from
    ? Prisma.sql`COALESCE(version."validTo", version."systemFrom") >= ${plan.filters.from}`
    : Prisma.sql`TRUE`;
  const to = plan.filters.to
    ? Prisma.sql`COALESCE(version."validFrom", version."systemFrom") < ${plan.filters.to}`
    : Prisma.sql`TRUE`;
  return Prisma.sql`${factKindPredicate(plan)} AND ${scope} AND ${target} AND ${from} AND ${to}`;
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
  return Prisma.sql`${scope} AND ${from} AND ${to}`;
}

function factColumns(entry: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    ${entry} AS "entryId", version."id" AS "itemId",
    'FACT_VERSION'::"MemorySearchItemType" AS "itemType", fact."id" AS "factId",
    ('fact:' || fact."id")::text AS "dedupeKey", fact."canonicalKey", fact."category",
    version."languageCode", version."modality"::text AS "modality",
    version."sourceMode"::text AS "sourceMode", version."directness"::text AS "directness",
    version."sensitivityClass"::text AS "sensitivityClass",
    NULL::text AS "historySafetyClass", scope."scopeType"::text AS "scopeType",
    scope."folderId" AS "sourceFolderId", scope."assistantId" AS "sourceAssistantId",
    scope."chatId" AS "sourceChatId", fact."pinned", fact."temperatureClass"::text AS "temperatureClass",
    version."confidence"::double precision AS "confidence",
    version."importance"::double precision AS "importance",
    version."coreEligible", version."coreSalience"::text AS "coreSalience",
    CASE scope."scopeType" WHEN 'CHAT'::"MemoryScopeType" THEN 1.0
      WHEN 'ASSISTANT'::"MemoryScopeType" THEN 0.9
      WHEN 'FOLDER'::"MemoryScopeType" THEN 0.8 ELSE 0.7 END::double precision AS "scopeAffinity",
    TRUE AS "current", FALSE AS "historical", FALSE AS "conflict",
    version."validFrom", version."validTo", version."systemFrom",
    NULL::timestamp AS "occurredFrom", NULL::timestamp AS "occurredTo"
  `;
}

function factEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): Prisma.Sql {
  if (!snapshot.activeGenerationId) throw new Error("memory_retrieval_snapshot_invalid");
  return Prisma.sql`
    SELECT ${factColumns(Prisma.sql`entry."id"`)},
      entry."safeSearchText", entry."searchVectorSimple"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId" AND settings."useMemoryFacts" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId" AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = entry."userId" AND version."id" = entry."factVersionId"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState" AND version."systemTo" IS NULL
      AND version."contentPurgedAt" IS NULL AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
      AND fact."state" = 'ACTIVE'::"MemoryFactState" AND fact."currentVersionId" = version."id"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
      AND ${memoryFactScopePredicate(snapshot)}
      AND ${memoryAutomaticFactEvidencePredicate(snapshot.userId)}
      AND ${memoryActiveSuppressionPredicate(snapshot.userId)}
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
      AND version."contentPurgedAt" IS NULL AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
      AND (fact."pinned" OR version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        OR version."coreEligible")
      AND ${memoryFactScopePredicate(snapshot)}
      AND ${memoryAutomaticFactEvidencePredicate(snapshot.userId)}
      AND ${memoryActiveSuppressionPredicate(snapshot.userId)}
    ORDER BY fact."pinned" DESC,
      (version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode") DESC,
      CASE version."coreSalience" WHEN 'HIGH'::"MemoryCoreSalience" THEN 0
        WHEN 'MEDIUM'::"MemoryCoreSalience" THEN 1
        WHEN 'LOW'::"MemoryCoreSalience" THEN 2 ELSE 3 END,
      version."systemFrom" DESC, fact."id", version."id"
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
        fusionVersion: MEMORY_RETRIEVAL_FUSION_VERSION,
        laneCount: 0,
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

function historyEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): Prisma.Sql {
  if (!snapshot.activeGenerationId || !snapshot.historySuppressionIdentitySnapshot) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return Prisma.sql`
    SELECT entry."id" AS "entryId", chunk."id" AS "itemId",
      'RECALL_CHUNK'::"MemorySearchItemType" AS "itemType", NULL::text AS "factId",
      ('history:' || entry."safeContentHash")::text AS "dedupeKey",
      NULL::text AS "canonicalKey", NULL::text AS "category", chunk."languageCode",
      NULL::text AS "modality", NULL::text AS "sourceMode", NULL::text AS "directness",
      NULL::text AS "sensitivityClass", chunk."safetyClass"::text AS "historySafetyClass",
      NULL::text AS "scopeType", chunk."sourceFolderId", chunk."sourceAssistantId",
      chunk."chatId" AS "sourceChatId", FALSE AS "pinned", NULL::text AS "temperatureClass",
      1.0::double precision AS "confidence", 0.5::double precision AS "importance",
      FALSE AS "coreEligible", 'NONE'::text AS "coreSalience",
      CASE WHEN chunk."chatId" = ${snapshot.chatId} THEN 1.0
        WHEN chunk."sourceAssistantId" = ${snapshot.assistantId}
          AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
        WHEN chunk."sourceFolderId" = ${snapshot.folderId}
          AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8 ELSE 0.5
      END::double precision AS "scopeAffinity",
      TRUE AS "current", FALSE AS "historical", FALSE AS "conflict",
      NULL::timestamp AS "validFrom", NULL::timestamp AS "validTo",
      NULL::timestamp AS "systemFrom", chunk."occurredFrom", chunk."occurredTo",
      entry."safeSearchText", entry."searchVectorSimple"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId" AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId" AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = entry."userId" AND chunk."id" = entry."recallChunkId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = chunk."userId" AND source_chat."id" = chunk."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId" AND checkpoint."chatId" = chunk."chatId"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND chunk."safetyClass" = 'NORMAL'::"MemoryDerivedSafetyClass"
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."memoryBranchGeneration" = chunk."branchGeneration"
      AND source_chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"
      AND checkpoint."branchGeneration" = chunk."branchGeneration"
      AND checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
      AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND ${memoryChunkSourceSafetyPredicate()}
      AND ${historyPlanPredicates(plan)}
  `;
}

function candidateColumns(rawScore: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    eligible."entryId", eligible."itemId", eligible."itemType", eligible."factId",
    eligible."dedupeKey", eligible."canonicalKey", eligible."category", eligible."languageCode",
    eligible."modality", eligible."sourceMode", eligible."directness",
    eligible."sensitivityClass", eligible."historySafetyClass", eligible."scopeType",
    eligible."sourceFolderId", eligible."sourceAssistantId", eligible."sourceChatId",
    eligible."pinned", eligible."temperatureClass", eligible."confidence", eligible."importance",
    eligible."coreEligible", eligible."coreSalience", eligible."scopeAffinity",
    eligible."current", eligible."historical", eligible."conflict",
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
    WHERE eligible."safeSearchText" = ${plan.normalizedExactQuery}
    ORDER BY eligible."itemId" LIMIT ${limit}
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
    lanes.push("FACT_EXACT");
    if (plan.lexicalQuery) lanes.push("FACT_FTS_SIMPLE");
    lanes.push("FACT_RECENT");
  }
  if (snapshot.referenceChatHistory && plan.filters.sourceKinds.includes("HISTORY")) {
    lanes.push("HISTORY_RECALL_EXACT");
    if (plan.lexicalQuery) lanes.push("HISTORY_RECALL_FTS_SIMPLE");
    lanes.push("HISTORY_RECALL_RECENT");
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
  if (snapshot.useMemoryFacts && (input.plan.filters.sourceKinds.includes("FACT") ||
    input.plan.filters.sourceKinds.includes("EVENT"))) lanes.push("FACT_VECTOR");
  if (snapshot.referenceChatHistory && input.plan.filters.sourceKinds.includes("HISTORY")) {
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
      allowedFactSensitivity: ["NORMAL"],
      allowedHistorySafety: ["NORMAL"],
      assistantId: snapshot.assistantId,
      chatId: snapshot.chatId,
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

function validPlan(plan: MemoryRetrievalPlan): boolean {
  return plan.normalizedQuery.length <= 2_000 &&
    plan.normalizedExactQuery.length <= 2_000 &&
    plan.queryPresent === (plan.normalizedQuery.length > 0) &&
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
        chunkExpansionSql(snapshot, plan, chunkIds)));
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
      const core = await loadCore(client, snapshot);
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
