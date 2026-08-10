import {
  Prisma,
  type MemorySearchItemType,
  type PrismaClient
} from "@prisma/client";
import {
  allocateMemoryRetrievalLaneLimits,
  executeMemoryRetrievalLaneTasks,
  MEMORY_RETRIEVAL_LANE_LIMITS,
  MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES,
  type MemoryCandidateMetadata,
  type MemoryExpandedCandidate,
  type MemoryLaneCandidate,
  type MemoryLaneResult,
  type MemoryRankedCandidate,
  type MemoryRetrievalLane,
  type MemoryRetrievalLaneLimitAllocation,
  type MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
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
  "memory-local-retrieval-repository-v1";

export type MemoryLocalRetrievalStatus = "DISABLED" | "READY" | "UNAVAILABLE";

export type MemoryLocalRetrievalSnapshot = Readonly<{
  activeGenerationId: string | null;
  assistantId: string | null;
  chatId: string;
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
  laneResults: readonly MemoryLaneResult[];
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

type ExpandedRow = Readonly<{
  itemId: string;
  itemType: MemorySearchItemType;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  projectionKind:
    | "EPISODE_SAFE_SUMMARY"
    | "FACT_DISPLAY_TEXT"
    | "RECALL_CHUNK_SAFE_PROJECTED_TEXT";
  safeText: string;
  sourceChatId: string | null;
  supportingItemId: string | null;
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

function validToken(value: unknown): value is string {
  return typeof value === "string" && opaqueTokenPattern.test(value);
}

function validDate(value: Date | null): boolean {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function nullableClosed(value: string | null, allowed: ReadonlySet<string>): boolean {
  return value === null || allowed.has(value);
}

function decodeCandidate(row: CandidateRow, lane: MemoryRetrievalLane): MemoryLaneCandidate {
  if (
    !validToken(row.itemId) || !validToken(row.dedupeKey) ||
    (row.entryId !== null && !validToken(row.entryId)) ||
    !["FACT_VERSION", "EPISODE", "RECALL_CHUNK"].includes(row.itemType) ||
    !Number.isFinite(row.rawScore) || row.rawScore <= 0 ||
    !validUnit(row.confidence) || !validUnit(row.importance) || !validUnit(row.scopeAffinity) ||
    !nullableClosed(row.directness, directnessValues) ||
    !nullableClosed(row.modality, modalities) ||
    !nullableClosed(row.scopeType, scopeTypes) ||
    !nullableClosed(row.sensitivityClass, sensitivityClasses) ||
    !nullableClosed(row.sourceMode, sourceModes) ||
    !nullableClosed(row.temperatureClass, temperatureClasses) ||
    !nullableClosed(row.historySafetyClass, historySafetyClasses) ||
    [row.occurredFrom, row.occurredTo, row.systemFrom, row.validFrom, row.validTo]
      .some((value) => !validDate(value)) ||
    row.current === row.historical
  ) throw new Error("memory_retrieval_result_invalid");
  const metadata: MemoryCandidateMetadata = {
    canonicalKey: row.canonicalKey,
    category: row.category,
    confidence: row.confidence,
    conflict: row.conflict,
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
  return {
    entryId: row.entryId,
    hardFilterPassed: true,
    itemId: row.itemId,
    itemType: row.itemType,
    lane,
    metadata,
    rawScore: row.rawScore
  };
}

function decodeExpanded(row: ExpandedRow): MemoryExpandedCandidate {
  if (
    !validToken(row.itemId) ||
    !["FACT_VERSION", "EPISODE", "RECALL_CHUNK"].includes(row.itemType) ||
    !["FACT_DISPLAY_TEXT", "EPISODE_SAFE_SUMMARY", "RECALL_CHUNK_SAFE_PROJECTED_TEXT"]
      .includes(row.projectionKind) ||
    typeof row.safeText !== "string" || !row.safeText.trim() || row.safeText.length > 4_000 ||
    row.safeText.includes("\u0000") ||
    (row.sourceChatId !== null && !validToken(row.sourceChatId)) ||
    (row.supportingItemId !== null && !validToken(row.supportingItemId)) ||
    !validDate(row.occurredFrom) || !validDate(row.occurredTo)
  ) throw new Error("memory_expansion_result_invalid");
  return row;
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
      select: {
        id: true,
        kind: true,
        memoryGeneration: true,
        sourceCreatedAtCutoff: true
      },
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
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        userId
      }
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
      settings."useMemoryFacts",
      settings."referenceChatHistory",
      settings."memoryGeneration",
      settings."memoryRevision",
      settings."settingsRevision",
      settings."activeIndexGenerationId",
      generation."id" AS "generationId",
      generation."state"::text AS "generationState",
      generation."indexMode"::text AS "generationIndexMode",
      generation."retrievalPipelineVersion" AS "generationPipelineVersion"
    FROM "User" AS owner
    LEFT JOIN "Chat" AS current_chat
      ON current_chat."userId" = owner."id"
      AND current_chat."id" = ${input.chatId}
    LEFT JOIN "Folder" AS current_folder
      ON current_folder."userId" = owner."id"
      AND current_folder."id" = current_chat."folderId"
    LEFT JOIN "AssistantDefinition" AS selected_assistant
      ON selected_assistant."ownerUserId" = owner."id"
      AND selected_assistant."id" = ${input.assistantId}
      AND selected_assistant."archivedAt" IS NULL
    LEFT JOIN "UserMemorySettings" AS settings
      ON settings."userId" = owner."id"
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
  const base = {
    activeGenerationId: null,
    assistantId,
    chatId: input.chatId,
    folderId: row.chatFolderId,
    historySuppressionIdentitySnapshot: null,
    indexMode: null,
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
  const indexMode = row.generationIndexMode;
  const generationReady = row.activeIndexGenerationId !== null &&
    row.generationId === row.activeIndexGenerationId &&
    row.generationState === "ACTIVE" &&
    (indexMode === "HYBRID" || indexMode === "LEXICAL_ONLY") &&
    row.generationPipelineVersion === expectedGenerationPipeline(indexMode);
  if (!generationReady || !row.generationId || !indexMode) {
    return { ...base, reason: "memory_index_unavailable", status: "UNAVAILABLE" };
  }
  const suppressionIdentity = referenceChatHistory
    ? await historySuppressionIdentity(client, input.userId, input.now)
    : null;
  if (suppressionIdentity !== null && !fingerprintPattern.test(suppressionIdentity)) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  return {
    ...base,
    activeGenerationId: row.generationId,
    historySuppressionIdentitySnapshot: suppressionIdentity,
    indexMode,
    reason: "ready",
    status: "READY"
  };
}

function activeSuppressionPredicate(userId: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemorySuppression" AS global_suppression
    WHERE global_suppression."userId" = ${userId}
      AND global_suppression."scope" = 'ALL'::"MemorySuppressionScope"
      AND (
        global_suppression."expiresAt" IS NULL
        OR global_suppression."expiresAt" > CURRENT_TIMESTAMP
      )
  )`;
}

function factScopePredicate(snapshot: MemoryLocalRetrievalSnapshot): Prisma.Sql {
  return Prisma.sql`(
    (
      scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      AND scope."targetIdSnapshot" IS NULL
      AND scope."folderId" IS NULL
      AND scope."assistantId" IS NULL
      AND scope."chatId" IS NULL
    )
    OR (
      scope."scopeType" = 'FOLDER'::"MemoryScopeType"
      AND scope."folderId" = ${snapshot.folderId}
      AND scope."targetIdSnapshot" = scope."folderId"
      AND scope."assistantId" IS NULL
      AND scope."chatId" IS NULL
      AND EXISTS (
        SELECT 1 FROM "Folder" AS scope_folder
        WHERE scope_folder."userId" = fact."userId"
          AND scope_folder."id" = scope."folderId"
      )
    )
    OR (
      scope."scopeType" = 'ASSISTANT'::"MemoryScopeType"
      AND scope."assistantId" = ${snapshot.assistantId}
      AND scope."targetIdSnapshot" = scope."assistantId"
      AND scope."folderId" IS NULL
      AND scope."chatId" IS NULL
      AND EXISTS (
        SELECT 1 FROM "AssistantDefinition" AS scope_assistant
        WHERE scope_assistant."ownerUserId" = fact."userId"
          AND scope_assistant."id" = scope."assistantId"
          AND scope_assistant."archivedAt" IS NULL
      )
    )
    OR (
      scope."scopeType" = 'CHAT'::"MemoryScopeType"
      AND scope."chatId" = ${snapshot.chatId}
      AND scope."targetIdSnapshot" = scope."chatId"
      AND scope."folderId" IS NULL
      AND scope."assistantId" IS NULL
      AND EXISTS (
        SELECT 1 FROM "Chat" AS scope_chat
        WHERE scope_chat."userId" = fact."userId"
          AND scope_chat."id" = scope."chatId"
          AND scope_chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
      )
    )
  )`;
}

function automaticFactEvidencePredicate(userId: string): Prisma.Sql {
  return Prisma.sql`(
    version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
    OR EXISTS (
      SELECT 1
      FROM "MemoryEvidence" AS support
      INNER JOIN "Chat" AS evidence_chat
        ON evidence_chat."userId" = support."userId"
        AND evidence_chat."id" = support."chatId"
        AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND evidence_chat."memoryBranchGeneration" = support."branchGeneration"
      INNER JOIN "Message" AS evidence_message
        ON evidence_message."chatId" = support."chatId"
        AND evidence_message."id" = support."messageId"
        AND evidence_message."role" = 'user'
      WHERE support."userId" = ${userId}
        AND support."factVersionId" = version."id"
        AND support."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
        AND support."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
        AND support."sourceRole" = 'user'
        AND NOT EXISTS (
          SELECT 1
          FROM "MemorySuppression" AS source_suppression
          WHERE source_suppression."userId" = support."userId"
            AND source_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND source_suppression."sourceChatId" = support."chatId"
            AND source_suppression."sourceMessageId" = support."messageId"
            AND (
              source_suppression."sourceBranchGeneration" IS NULL
              OR source_suppression."sourceBranchGeneration" = support."branchGeneration"
            )
            AND (
              source_suppression."expiresAt" IS NULL
              OR source_suppression."expiresAt" > CURRENT_TIMESTAMP
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "MemorySourceBarrier" AS source_barrier
          WHERE source_barrier."userId" = support."userId"
            AND source_barrier."kind" IN (
              'AUTOMATIC_FACTS'::"MemorySourceBarrierKind",
              'ALL_REUSABLE'::"MemorySourceBarrierKind"
            )
            AND evidence_message."createdAt" <= source_barrier."sourceCreatedAtCutoff"
        )
    )
  )`;
}

function factEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan
): Prisma.Sql {
  if (!snapshot.activeGenerationId) throw new Error("memory_retrieval_snapshot_invalid");
  return Prisma.sql`
    SELECT
      entry."id" AS "entryId",
      version."id" AS "itemId",
      'FACT_VERSION'::"MemorySearchItemType" AS "itemType",
      fact."id" AS "factId",
      ('fact:' || fact."id")::text AS "dedupeKey",
      fact."canonicalKey",
      fact."category",
      version."languageCode",
      version."modality"::text AS "modality",
      version."sourceMode"::text AS "sourceMode",
      version."directness"::text AS "directness",
      version."sensitivityClass"::text AS "sensitivityClass",
      NULL::text AS "historySafetyClass",
      scope."scopeType"::text AS "scopeType",
      scope."folderId" AS "sourceFolderId",
      scope."assistantId" AS "sourceAssistantId",
      NULL::text AS "sourceChatId",
      fact."pinned",
      fact."temperatureClass"::text AS "temperatureClass",
      version."confidence"::double precision AS "confidence",
      version."importance"::double precision AS "importance",
      CASE scope."scopeType"
        WHEN 'CHAT'::"MemoryScopeType" THEN 1.0
        WHEN 'ASSISTANT'::"MemoryScopeType" THEN 0.9
        WHEN 'FOLDER'::"MemoryScopeType" THEN 0.8
        ELSE 0.7
      END::double precision AS "scopeAffinity",
      TRUE AS "current",
      FALSE AS "historical",
      FALSE AS "conflict",
      version."validFrom",
      version."validTo",
      version."systemFrom",
      NULL::timestamp AS "occurredFrom",
      NULL::timestamp AS "occurredTo",
      entry."safeSearchTextYoNormalized",
      entry."searchVectorSimple",
      entry."searchVectorRussian",
      entry."searchVectorEnglish"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = entry."userId"
      AND version."id" = entry."factVersionId"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."currentVersionId" = version."id"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND ${factScopePredicate(snapshot)}
      AND ${automaticFactEvidencePredicate(snapshot.userId)}
      AND ${activeSuppressionPredicate(snapshot.userId)}
      AND (
        version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
        OR (
          version."sensitivityClass" = 'SENSITIVE'::"MemorySensitivityClass"
          AND entry."safeSearchTextYoNormalized" = ${plan.normalizedYoQuery}
        )
      )
  `;
}

function candidateColumns(rawScore: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    eligible."entryId", eligible."itemId", eligible."itemType",
    eligible."factId", eligible."dedupeKey", eligible."canonicalKey", eligible."category",
    eligible."languageCode", eligible."modality", eligible."sourceMode", eligible."directness",
    eligible."sensitivityClass", eligible."historySafetyClass", eligible."scopeType",
    eligible."sourceFolderId", eligible."sourceAssistantId", eligible."sourceChatId",
    eligible."pinned", eligible."temperatureClass", eligible."confidence", eligible."importance",
    eligible."scopeAffinity", eligible."current", eligible."historical", eligible."conflict",
    eligible."validFrom", eligible."validTo", eligible."systemFrom",
    eligible."occurredFrom", eligible."occurredTo",
    ${rawScore}::double precision AS "rawScore"
  `;
}

function ftsConfiguration(lane: MemoryRetrievalLane): Readonly<{
  query: "english" | "russian" | "simple";
  vector: "searchVectorEnglish" | "searchVectorRussian" | "searchVectorSimple";
}> {
  if (lane.endsWith("FTS_RUSSIAN")) {
    return { query: "russian", vector: "searchVectorRussian" };
  }
  if (lane.endsWith("FTS_ENGLISH")) {
    return { query: "english", vector: "searchVectorEnglish" };
  }
  if (lane.endsWith("FTS_SIMPLE")) {
    return { query: "simple", vector: "searchVectorSimple" };
  }
  throw new Error("memory_retrieval_lane_invalid");
}

function ftsQuerySql(configuration: ReturnType<typeof ftsConfiguration>, plan: MemoryRetrievalPlan): Prisma.Sql {
  const query = configuration.query === "english" ? plan.normalizedQuery : plan.normalizedYoQuery;
  if (configuration.query === "russian") return Prisma.sql`websearch_to_tsquery('russian', ${query})`;
  if (configuration.query === "english") return Prisma.sql`websearch_to_tsquery('english', ${query})`;
  return Prisma.sql`websearch_to_tsquery('simple', ${query})`;
}

function ftsVectorSql(configuration: ReturnType<typeof ftsConfiguration>): Prisma.Sql {
  if (configuration.vector === "searchVectorRussian") return Prisma.sql`eligible."searchVectorRussian"`;
  if (configuration.vector === "searchVectorEnglish") return Prisma.sql`eligible."searchVectorEnglish"`;
  return Prisma.sql`eligible."searchVectorSimple"`;
}

function factLaneSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  lane: MemoryRetrievalLane,
  limit: number
): Prisma.Sql {
  if (lane === "FACT_EXACT") {
    return Prisma.sql`
      WITH eligible AS MATERIALIZED (${factEligibleSelect(snapshot, plan)})
      SELECT ${candidateColumns(Prisma.sql`1.0`)}
      FROM eligible
      WHERE eligible."safeSearchTextYoNormalized" = ${plan.normalizedYoQuery}
      ORDER BY eligible."pinned" DESC, eligible."importance" DESC, eligible."itemId"
      LIMIT ${limit}
    `;
  }
  if (lane === "FACT_CANONICAL") {
    if (plan.canonicalKeyHints.length === 0) throw new Error("memory_retrieval_lane_invalid");
    return Prisma.sql`
      WITH eligible AS MATERIALIZED (${factEligibleSelect(snapshot, plan)})
      SELECT ${candidateColumns(Prisma.sql`1.0`)}
      FROM eligible
      WHERE eligible."canonicalKey" IN (${valuesSql(plan.canonicalKeyHints)})
      ORDER BY eligible."pinned" DESC, eligible."importance" DESC, eligible."itemId"
      LIMIT ${limit}
    `;
  }
  const configuration = ftsConfiguration(lane);
  const query = ftsQuerySql(configuration, plan);
  const vector = ftsVectorSql(configuration);
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${factEligibleSelect(snapshot, plan)}),
    query_terms AS (SELECT ${query} AS query)
    SELECT ${candidateColumns(Prisma.sql`ts_rank_cd(${vector}, query_terms.query)`) }
    FROM eligible
    CROSS JOIN query_terms
    WHERE ${vector} @@ query_terms.query
    ORDER BY ts_rank_cd(${vector}, query_terms.query) DESC,
      eligible."pinned" DESC, eligible."importance" DESC, eligible."itemId"
    LIMIT ${limit}
  `;
}

function chunkSourceSafetyPredicate(): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1
      FROM "MemorySuppression" AS history_suppression
      WHERE history_suppression."userId" = chunk."userId"
        AND (
          history_suppression."expiresAt" IS NULL
          OR history_suppression."expiresAt" > CURRENT_TIMESTAMP
        )
        AND (
          history_suppression."scope" = 'ALL'::"MemorySuppressionScope"
          OR (
            history_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND history_suppression."sourceChatId" = chunk."chatId"
            AND (
              history_suppression."sourceBranchGeneration" IS NULL
              OR history_suppression."sourceBranchGeneration" = chunk."branchGeneration"
            )
            AND EXISTS (
              SELECT 1
              FROM "MemoryRecallChunkMessage" AS suppressed_chunk_message
              WHERE suppressed_chunk_message."userId" = chunk."userId"
                AND suppressed_chunk_message."chunkId" = chunk."id"
                AND suppressed_chunk_message."messageId" = history_suppression."sourceMessageId"
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "MemorySourceBarrier" AS history_barrier
      WHERE history_barrier."userId" = chunk."userId"
        AND history_barrier."kind" IN (
          'HISTORY_INDEX'::"MemorySourceBarrierKind",
          'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        AND (
          chunk."createdAt" <= history_barrier."createdAt"
          OR EXISTS (
            SELECT 1
            FROM "MemoryRecallChunkMessage" AS barrier_chunk_message
            INNER JOIN "Message" AS barrier_message
              ON barrier_message."chatId" = barrier_chunk_message."chatId"
              AND barrier_message."id" = barrier_chunk_message."messageId"
            WHERE barrier_chunk_message."userId" = chunk."userId"
              AND barrier_chunk_message."chunkId" = chunk."id"
              AND barrier_message."createdAt" <= history_barrier."sourceCreatedAtCutoff"
          )
        )
    )
  `;
}

function episodeSourceSafetyPredicate(): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1
      FROM "MemorySuppression" AS history_suppression
      WHERE history_suppression."userId" = episode."userId"
        AND (
          history_suppression."expiresAt" IS NULL
          OR history_suppression."expiresAt" > CURRENT_TIMESTAMP
        )
        AND (
          history_suppression."scope" = 'ALL'::"MemorySuppressionScope"
          OR (
            history_suppression."scope" = 'SOURCE_EPISODE'::"MemorySuppressionScope"
            AND history_suppression."sourceEpisodeId" = episode."id"
          )
          OR (
            history_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND history_suppression."sourceChatId" = episode."chatId"
            AND (
              history_suppression."sourceBranchGeneration" IS NULL
              OR history_suppression."sourceBranchGeneration" = episode."branchGeneration"
            )
            AND EXISTS (
              SELECT 1
              FROM "MemoryEpisodeMessage" AS suppressed_episode_message
              WHERE suppressed_episode_message."userId" = episode."userId"
                AND suppressed_episode_message."episodeId" = episode."id"
                AND suppressed_episode_message."messageId" = history_suppression."sourceMessageId"
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "MemorySourceBarrier" AS history_barrier
      WHERE history_barrier."userId" = episode."userId"
        AND history_barrier."kind" IN (
          'HISTORY_INDEX'::"MemorySourceBarrierKind",
          'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        AND (
          episode."createdAt" <= history_barrier."createdAt"
          OR EXISTS (
            SELECT 1
            FROM "MemoryEpisodeMessage" AS barrier_episode_message
            INNER JOIN "Message" AS barrier_message
              ON barrier_message."chatId" = barrier_episode_message."chatId"
              AND barrier_message."id" = barrier_episode_message."messageId"
            WHERE barrier_episode_message."userId" = episode."userId"
              AND barrier_episode_message."episodeId" = episode."id"
              AND barrier_message."createdAt" <= history_barrier."sourceCreatedAtCutoff"
          )
        )
    )
  `;
}

function historyEligibleSelect(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "EPISODE" | "RECALL_CHUNK"
): Prisma.Sql {
  if (!snapshot.activeGenerationId || !snapshot.historySuppressionIdentitySnapshot) {
    throw new Error("memory_retrieval_snapshot_invalid");
  }
  if (itemType === "RECALL_CHUNK") {
    return Prisma.sql`
      SELECT
        entry."id" AS "entryId",
        chunk."id" AS "itemId",
        'RECALL_CHUNK'::"MemorySearchItemType" AS "itemType",
        NULL::text AS "factId",
        ('history:' || entry."safeContentHash")::text AS "dedupeKey",
        NULL::text AS "canonicalKey",
        NULL::text AS "category",
        chunk."languageCode",
        NULL::text AS "modality",
        NULL::text AS "sourceMode",
        NULL::text AS "directness",
        NULL::text AS "sensitivityClass",
        chunk."safetyClass"::text AS "historySafetyClass",
        NULL::text AS "scopeType",
        chunk."sourceFolderId",
        chunk."sourceAssistantId",
        chunk."chatId" AS "sourceChatId",
        FALSE AS "pinned",
        NULL::text AS "temperatureClass",
        1.0::double precision AS "confidence",
        0.5::double precision AS "importance",
        CASE
          WHEN chunk."chatId" = ${snapshot.chatId} THEN 1.0
          WHEN chunk."sourceAssistantId" = ${snapshot.assistantId}
            AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
          WHEN chunk."sourceFolderId" = ${snapshot.folderId}
            AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8
          ELSE 0.5
        END::double precision AS "scopeAffinity",
        TRUE AS "current",
        FALSE AS "historical",
        FALSE AS "conflict",
        NULL::timestamp AS "validFrom",
        NULL::timestamp AS "validTo",
        NULL::timestamp AS "systemFrom",
        chunk."occurredFrom",
        chunk."occurredTo",
        entry."safeSearchTextYoNormalized",
        entry."searchVectorSimple",
        entry."searchVectorRussian",
        entry."searchVectorEnglish",
        lower(source_chat."title") AS "sourceTitleNormalized"
      FROM "MemorySearchEntry" AS entry
      INNER JOIN "UserMemorySettings" AS settings
        ON settings."userId" = entry."userId"
        AND settings."referenceChatHistory" = TRUE
        AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
      INNER JOIN "MemoryIndexGeneration" AS generation
        ON generation."userId" = settings."userId"
        AND generation."id" = settings."activeIndexGenerationId"
        AND generation."id" = entry."indexGenerationId"
        AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      INNER JOIN "MemoryRecallChunk" AS chunk
        ON chunk."userId" = entry."userId"
        AND chunk."id" = entry."recallChunkId"
      INNER JOIN "Chat" AS source_chat
        ON source_chat."userId" = chunk."userId"
        AND source_chat."id" = chunk."chatId"
      INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
        ON checkpoint."userId" = chunk."userId"
        AND checkpoint."chatId" = chunk."chatId"
      WHERE entry."userId" = ${snapshot.userId}
        AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
        AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
        AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
        AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND source_chat."memoryBranchGeneration" = chunk."branchGeneration"
        AND source_chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"
        AND checkpoint."branchGeneration" = chunk."branchGeneration"
        AND checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
        AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
        AND checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"
        AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
        AND ${chunkSourceSafetyPredicate()}
        AND (
          chunk."safetyClass" = 'NORMAL'::"MemoryDerivedSafetyClass"
          OR (
            chunk."safetyClass" = 'SENSITIVE'::"MemoryDerivedSafetyClass"
            AND entry."safeSearchTextYoNormalized" = ${plan.normalizedYoQuery}
          )
        )
    `;
  }
  return Prisma.sql`
    SELECT
      entry."id" AS "entryId",
      episode."id" AS "itemId",
      'EPISODE'::"MemorySearchItemType" AS "itemType",
      NULL::text AS "factId",
      ('history:' || entry."safeContentHash")::text AS "dedupeKey",
      NULL::text AS "canonicalKey",
      NULL::text AS "category",
      episode."languageCode",
      NULL::text AS "modality",
      NULL::text AS "sourceMode",
      NULL::text AS "directness",
      NULL::text AS "sensitivityClass",
      episode."safetyClass"::text AS "historySafetyClass",
      NULL::text AS "scopeType",
      episode."sourceFolderId",
      episode."sourceAssistantId",
      episode."chatId" AS "sourceChatId",
      FALSE AS "pinned",
      NULL::text AS "temperatureClass",
      1.0::double precision AS "confidence",
      0.5::double precision AS "importance",
      CASE
        WHEN episode."chatId" = ${snapshot.chatId} THEN 1.0
        WHEN episode."sourceAssistantId" = ${snapshot.assistantId}
          AND CAST(${snapshot.assistantId} AS text) IS NOT NULL THEN 0.9
        WHEN episode."sourceFolderId" = ${snapshot.folderId}
          AND CAST(${snapshot.folderId} AS text) IS NOT NULL THEN 0.8
        ELSE 0.5
      END::double precision AS "scopeAffinity",
      TRUE AS "current",
      FALSE AS "historical",
      FALSE AS "conflict",
      NULL::timestamp AS "validFrom",
      NULL::timestamp AS "validTo",
      NULL::timestamp AS "systemFrom",
      COALESCE(episode."occurredFrom", episode."createdAt") AS "occurredFrom",
      COALESCE(episode."occurredTo", episode."occurredFrom", episode."createdAt") AS "occurredTo",
      entry."safeSearchTextYoNormalized",
      entry."searchVectorSimple",
      entry."searchVectorRussian",
      entry."searchVectorEnglish",
      lower(source_chat."title") AS "sourceTitleNormalized"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    INNER JOIN "MemoryEpisode" AS episode
      ON episode."userId" = entry."userId"
      AND episode."id" = entry."episodeId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = episode."userId"
      AND source_chat."id" = episode."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = episode."userId"
      AND checkpoint."chatId" = episode."chatId"
    WHERE entry."userId" = ${snapshot.userId}
      AND entry."itemType" = 'EPISODE'::"MemorySearchItemType"
      AND episode."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND episode."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."memoryBranchGeneration" = episode."branchGeneration"
      AND source_chat."memorySourceRevision" = episode."sourceRevisionAtCreation"
      AND checkpoint."branchGeneration" = episode."branchGeneration"
      AND checkpoint."sourceRevision" = episode."sourceRevisionAtCreation"
      AND checkpoint."sourceContentHash" = episode."sourceHash"
      AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."lastDreamedMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND ${episodeSourceSafetyPredicate()}
      AND (
        episode."safetyClass" = 'NORMAL'::"MemoryDerivedSafetyClass"
        OR (
          episode."safetyClass" = 'SENSITIVE'::"MemoryDerivedSafetyClass"
          AND entry."safeSearchTextYoNormalized" = ${plan.normalizedYoQuery}
        )
      )
  `;
}

function historyFtsLaneSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  lane: MemoryRetrievalLane,
  itemType: "EPISODE" | "RECALL_CHUNK",
  limit: number
): Prisma.Sql {
  const configuration = ftsConfiguration(lane);
  const query = ftsQuerySql(configuration, plan);
  const vector = ftsVectorSql(configuration);
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${historyEligibleSelect(snapshot, plan, itemType)}),
    query_terms AS (SELECT ${query} AS query)
    SELECT ${candidateColumns(Prisma.sql`ts_rank_cd(${vector}, query_terms.query)`) }
    FROM eligible
    CROSS JOIN query_terms
    WHERE ${vector} @@ query_terms.query
    ORDER BY ts_rank_cd(${vector}, query_terms.query) DESC,
      eligible."occurredTo" DESC, eligible."itemId"
    LIMIT ${limit}
  `;
}

function historyEntityTimeSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  limit: number
): Prisma.Sql {
  const entityPredicate = plan.entityHints.length > 0
    ? Prisma.sql`(${Prisma.join(plan.entityHints.map((entity) => Prisma.sql`
        strpos(eligible."safeSearchTextYoNormalized", ${entity.replace(/ё/gu, "е")}) > 0
        OR strpos(eligible."sourceTitleNormalized", ${entity}) > 0
      `), " OR ")})`
    : Prisma.sql`FALSE`;
  const rangePredicate = plan.temporal.mode === "RANGE" && plan.temporal.from && plan.temporal.to
    ? Prisma.sql`eligible."occurredTo" >= ${plan.temporal.from}
        AND eligible."occurredFrom" < ${plan.temporal.to}`
    : Prisma.sql`TRUE`;
  const relevancePredicate = plan.entityHints.length > 0
    ? entityPredicate
    : plan.temporal.mode === "RANGE" ? Prisma.sql`TRUE` : Prisma.sql`FALSE`;
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (
      ${historyEligibleSelect(snapshot, plan, "RECALL_CHUNK")}
      UNION ALL
      ${historyEligibleSelect(snapshot, plan, "EPISODE")}
    )
    SELECT ${candidateColumns(Prisma.sql`CASE WHEN ${entityPredicate} THEN 1.0 ELSE 0.5 END`)}
    FROM eligible
    WHERE (${relevancePredicate})
      AND (${rangePredicate})
    ORDER BY "rawScore" DESC, eligible."occurredTo" DESC, eligible."itemId"
    LIMIT ${limit}
  `;
}

function temporalFactLaneSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  limit: number
): Prisma.Sql {
  const timePredicate = plan.temporal.mode === "RANGE" && plan.temporal.from && plan.temporal.to
    ? Prisma.sql`(
        (version."validFrom" IS NOT NULL OR version."validTo" IS NOT NULL)
        AND COALESCE(version."validTo", 'infinity'::timestamp) > ${plan.temporal.from}
        AND COALESCE(version."validFrom", '-infinity'::timestamp) < ${plan.temporal.to}
      )`
    : Prisma.sql`TRUE`;
  const canonicalPredicate = plan.canonicalKeyHints.length > 0
    ? Prisma.sql`fact."canonicalKey" IN (${valuesSql(plan.canonicalKeyHints)})`
    : Prisma.sql`FALSE`;
  return Prisma.sql`
    WITH query_terms AS (
      SELECT
        websearch_to_tsquery('russian', ${plan.normalizedYoQuery}) AS query_ru,
        websearch_to_tsquery('english', ${plan.normalizedQuery}) AS query_en,
        websearch_to_tsquery('simple', ${plan.normalizedYoQuery}) AS query_simple
    ),
    eligible AS MATERIALIZED (
      SELECT
        NULL::text AS "entryId",
        version."id" AS "itemId",
        'FACT_VERSION'::"MemorySearchItemType" AS "itemType",
        fact."id" AS "factId",
        ('fact:' || fact."id")::text AS "dedupeKey",
        fact."canonicalKey",
        fact."category",
        version."languageCode",
        version."modality"::text AS "modality",
        version."sourceMode"::text AS "sourceMode",
        version."directness"::text AS "directness",
        version."sensitivityClass"::text AS "sensitivityClass",
        NULL::text AS "historySafetyClass",
        scope."scopeType"::text AS "scopeType",
        scope."folderId" AS "sourceFolderId",
        scope."assistantId" AS "sourceAssistantId",
        NULL::text AS "sourceChatId",
        fact."pinned",
        fact."temperatureClass"::text AS "temperatureClass",
        version."confidence"::double precision AS "confidence",
        version."importance"::double precision AS "importance",
        CASE scope."scopeType"
          WHEN 'CHAT'::"MemoryScopeType" THEN 1.0
          WHEN 'ASSISTANT'::"MemoryScopeType" THEN 0.9
          WHEN 'FOLDER'::"MemoryScopeType" THEN 0.8
          ELSE 0.7
        END::double precision AS "scopeAffinity",
        FALSE AS "current",
        TRUE AS "historical",
        (
          fact."state" = 'CONFLICTED'::"MemoryFactState"
          OR version."state" = 'CONFLICTING'::"MemoryFactVersionState"
        ) AS "conflict",
        version."validFrom",
        version."validTo",
        version."systemFrom",
        NULL::timestamp AS "occurredFrom",
        NULL::timestamp AS "occurredTo",
        version."normalizedSearchText",
        ${canonicalPredicate} AS "canonicalMatch"
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId"
        AND fact."id" = version."factId"
      INNER JOIN "MemoryScope" AS scope
        ON scope."userId" = fact."userId"
        AND scope."id" = fact."scopeId"
        AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      INNER JOIN "UserMemorySettings" AS settings
        ON settings."userId" = version."userId"
        AND settings."useMemoryFacts" = TRUE
        AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
      INNER JOIN "MemoryIndexGeneration" AS generation
        ON generation."userId" = settings."userId"
        AND generation."id" = settings."activeIndexGenerationId"
        AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      WHERE version."userId" = ${snapshot.userId}
        AND version."state" IN (
          'SUPERSEDED'::"MemoryFactVersionState",
          'EXPIRED'::"MemoryFactVersionState",
          'CONFLICTING'::"MemoryFactVersionState"
        )
        AND version."contentPurgedAt" IS NULL
        AND version."displayText" IS NOT NULL
        AND version."normalizedSearchText" IS NOT NULL
        AND fact."state" IN (
          'ACTIVE'::"MemoryFactState",
          'CONFLICTED'::"MemoryFactState",
          'EXPIRED'::"MemoryFactState"
        )
        AND (fact."currentVersionId" IS NULL OR fact."currentVersionId" <> version."id")
        AND ${factScopePredicate(snapshot)}
        AND ${automaticFactEvidencePredicate(snapshot.userId)}
        AND ${activeSuppressionPredicate(snapshot.userId)}
        AND ${timePredicate}
        AND (
          version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
          OR (
            version."sensitivityClass" = 'SENSITIVE'::"MemorySensitivityClass"
            AND version."normalizedSearchText" = ${plan.normalizedQuery}
          )
        )
    ),
    scored AS (
      SELECT eligible.*,
        GREATEST(
          ts_rank_cd(
            to_tsvector('russian', replace(eligible."normalizedSearchText", 'ё', 'е')),
            query_terms.query_ru
          ),
          ts_rank_cd(to_tsvector('english', eligible."normalizedSearchText"), query_terms.query_en),
          ts_rank_cd(
            to_tsvector('simple', replace(eligible."normalizedSearchText", 'ё', 'е')),
            query_terms.query_simple
          )
        )::double precision AS "lexicalScore"
      FROM eligible
      CROSS JOIN query_terms
    )
    SELECT
      scored."entryId", scored."itemId", scored."itemType",
      scored."factId", scored."dedupeKey", scored."canonicalKey", scored."category",
      scored."languageCode", scored."modality", scored."sourceMode", scored."directness",
      scored."sensitivityClass", scored."historySafetyClass", scored."scopeType",
      scored."sourceFolderId", scored."sourceAssistantId", scored."sourceChatId",
      scored."pinned", scored."temperatureClass", scored."confidence", scored."importance",
      scored."scopeAffinity", scored."current", scored."historical", scored."conflict",
      scored."validFrom", scored."validTo", scored."systemFrom",
      scored."occurredFrom", scored."occurredTo",
      GREATEST(scored."lexicalScore", CASE WHEN scored."canonicalMatch" THEN 1.0 ELSE 0.0 END)
        ::double precision AS "rawScore"
    FROM scored
    WHERE scored."lexicalScore" > 0 OR scored."canonicalMatch"
    ORDER BY "rawScore" DESC, scored."systemFrom" DESC, scored."itemId"
    LIMIT ${limit}
  `;
}

function vectorScoreSql(
  hits: readonly Readonly<{ entryId: string; score: number }>[]
): Prisma.Sql {
  return Prisma.sql`CASE eligible."entryId"
    ${Prisma.join(hits.map((hit) => Prisma.sql`WHEN ${hit.entryId} THEN ${hit.score}`), " ")}
    ELSE 0.0::double precision
  END`;
}

function vectorMetadataSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  itemType: "EPISODE" | "FACT_VERSION" | "RECALL_CHUNK",
  hits: readonly Readonly<{ entryId: string; score: number }>[],
  limit: number
): Prisma.Sql {
  if (hits.length === 0) throw new Error("memory_retrieval_lane_invalid");
  const eligible = itemType === "FACT_VERSION"
    ? factEligibleSelect(snapshot, plan)
    : historyEligibleSelect(snapshot, plan, itemType);
  const score = vectorScoreSql(hits);
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${eligible})
    SELECT ${candidateColumns(score)}
    FROM eligible
    WHERE eligible."entryId" IN (${valuesSql(hits.map((hit) => hit.entryId))})
    ORDER BY ${score} DESC, eligible."itemId"
    LIMIT ${limit}
  `;
}

function lexicalLanesForPlan(plan: MemoryRetrievalPlan): readonly ("ENGLISH" | "RUSSIAN" | "SIMPLE")[] {
  if (plan.language === "RU") return ["RUSSIAN", "SIMPLE"];
  if (plan.language === "EN") return ["ENGLISH", "SIMPLE"];
  if (plan.language === "MIXED") return ["RUSSIAN", "ENGLISH", "SIMPLE"];
  return ["SIMPLE"];
}

function factFtsLane(language: "ENGLISH" | "RUSSIAN" | "SIMPLE"): MemoryRetrievalLane {
  return `FACT_FTS_${language}`;
}

function historyFtsLane(
  itemType: "EPISODE" | "RECALL_CHUNK",
  language: "ENGLISH" | "RUSSIAN" | "SIMPLE"
): MemoryRetrievalLane {
  return itemType === "EPISODE"
    ? `HISTORY_EPISODE_FTS_${language}`
    : `HISTORY_RECALL_FTS_${language}`;
}

async function queryLane(
  client: PrismaClient,
  lane: MemoryRetrievalLane,
  limit: number,
  sql: Prisma.Sql
): Promise<MemoryLaneResult> {
  let rows: CandidateRow[];
  try {
    rows = await client.$queryRaw<CandidateRow[]>(sql);
  } catch (error) {
    throw new Error(`memory_retrieval_lane_failed:${lane}`, { cause: error });
  }
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
  const lanes: MemoryRetrievalLane[] = [];
  const languages = lexicalLanesForPlan(plan);
  if (snapshot.useMemoryFacts) {
    lanes.push("FACT_EXACT");
    if (plan.canonicalKeyHints.length > 0) lanes.push("FACT_CANONICAL");
    lanes.push(...languages.map(factFtsLane));
    if (
      plan.intent === "TEMPORAL" &&
      (plan.temporal.mode === "RANGE" || plan.temporal.mode === "HISTORICAL")
    ) lanes.push("FACT_TEMPORAL");
  }
  if (snapshot.referenceChatHistory) {
    if (plan.entityHints.length > 0 || plan.temporal.mode === "RANGE") {
      lanes.push("HISTORY_ENTITY_TIME");
    }
    for (const itemType of ["EPISODE", "RECALL_CHUNK"] as const) {
      lanes.push(...languages.map((language) => historyFtsLane(itemType, language)));
    }
  }
  return lanes;
}

function allocatedLimit(
  allocation: MemoryRetrievalLaneLimitAllocation,
  lane: MemoryRetrievalLane
): number {
  const limit = allocation[lane];
  if (
    !Number.isSafeInteger(limit) || !limit || limit < 1 ||
    limit > MEMORY_RETRIEVAL_LANE_LIMITS[lane]
  ) throw new Error("memory_retrieval_lane_contract_invalid");
  return limit;
}

function pushLexicalTasks(
  tasks: Array<Parameters<typeof executeMemoryRetrievalLaneTasks>[0][number]>,
  client: PrismaClient,
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  allocation: MemoryRetrievalLaneLimitAllocation
): void {
  for (const lane of localLexicalLanes(snapshot, plan)) {
    const limit = allocatedLimit(allocation, lane);
    let sql: Prisma.Sql;
    if (lane === "FACT_EXACT" || lane === "FACT_CANONICAL" || lane.startsWith("FACT_FTS_")) {
      sql = factLaneSql(snapshot, plan, lane, limit);
    } else if (lane === "FACT_TEMPORAL") {
      sql = temporalFactLaneSql(snapshot, plan, limit);
    } else if (lane === "HISTORY_ENTITY_TIME") {
      sql = historyEntityTimeSql(snapshot, plan, limit);
    } else if (lane.startsWith("HISTORY_EPISODE_FTS_")) {
      sql = historyFtsLaneSql(snapshot, plan, lane, "EPISODE", limit);
    } else if (lane.startsWith("HISTORY_RECALL_FTS_")) {
      sql = historyFtsLaneSql(snapshot, plan, lane, "RECALL_CHUNK", limit);
    } else {
      throw new Error("memory_retrieval_lane_contract_invalid");
    }
    tasks.push({ execute: () => queryLane(client, lane, limit, sql), lane });
  }
}

function vectorItemLane(itemType: MemorySearchItemType): MemoryRetrievalLane {
  if (itemType === "FACT_VERSION") return "FACT_VECTOR";
  if (itemType === "EPISODE") return "HISTORY_EPISODE_VECTOR";
  return "HISTORY_RECALL_VECTOR";
}

function localVectorLanes(
  snapshot: MemoryLocalRetrievalSnapshot,
  input: MemoryLocalRetrievalInput
): readonly MemoryRetrievalLane[] {
  if (!input.vector || snapshot.indexMode !== "HYBRID") return [];
  const lanes: MemoryRetrievalLane[] = [];
  if (snapshot.useMemoryFacts) lanes.push("FACT_VECTOR");
  if (snapshot.referenceChatHistory) {
    lanes.push("HISTORY_EPISODE_VECTOR", "HISTORY_RECALL_VECTOR");
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
  const vectorLanes = localVectorLanes(snapshot, input);
  const itemTypes = vectorLanes.map((lane): MemorySearchItemType => {
    if (lane === "FACT_VECTOR") return "FACT_VERSION";
    if (lane === "HISTORY_EPISODE_VECTOR") return "EPISODE";
    return "RECALL_CHUNK";
  });
  if (itemTypes.length === 0) return { state: () => "DISABLED" };
  const vectorLimit = Math.max(...vectorLanes.map((lane) => allocatedLimit(allocation, lane)));
  let vectorState: MemoryLocalRetrievalResult["vectorState"] = "READY";
  const repository = createPrismaMemoryVectorRepository(client);
  const resultPromise = repository.search({
    eligibility: {
      allowedFactSensitivity: ["NORMAL"],
      allowedHistorySafety: ["NORMAL"],
      assistantId: snapshot.assistantId,
      chatId: snapshot.chatId,
      folderId: snapshot.folderId,
      occurredFrom: input.plan.temporal.mode === "RANGE" ? input.plan.temporal.from : null,
      occurredTo: input.plan.temporal.mode === "RANGE" ? input.plan.temporal.to : null,
      sourceAssistantId: null,
      sourceChatIds: null,
      sourceFolderId: null
    },
    itemTypes,
    limit: vectorLimit,
    minimumScore: input.vector.minimumScore,
    profile: input.vector.profile,
    userId: snapshot.userId,
    vector: input.vector.vector
  }).then((result) => {
    if (result.status === "DEGRADED") {
      vectorState = "DEGRADED";
      return result;
    }
    evidence.push(...result.lanes);
    return result;
  }).catch(() => {
    vectorState = "DEGRADED";
    return {
      hits: [],
      lanes: [],
      reason: "memory_vector_unavailable" as const,
      status: "DEGRADED" as const
    };
  });
  for (const itemType of itemTypes) {
    const lane = vectorItemLane(itemType);
    const limit = allocatedLimit(allocation, lane);
    tasks.push({
      async execute() {
        const result = await resultPromise;
        if (result.status !== "READY") return { candidates: [], lane };
        const hits = result.hits.filter((hit) => hit.itemType === itemType);
        if (hits.length === 0) return { candidates: [], lane };
        return queryLane(client, lane, limit, vectorMetadataSql(
          snapshot,
          input.plan,
          itemType,
          hits,
          limit
        ));
      },
      lane
    });
  }
  return { state: () => vectorState };
}

function currentFactExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${factEligibleSelect(snapshot, plan)})
    SELECT
      eligible."itemId",
      eligible."itemType",
      version."displayText" AS "safeText",
      'FACT_DISPLAY_TEXT'::text AS "projectionKind",
      NULL::text AS "sourceChatId",
      NULL::text AS "supportingItemId",
      NULL::timestamp AS "occurredFrom",
      NULL::timestamp AS "occurredTo"
    FROM eligible
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = ${snapshot.userId}
      AND version."id" = eligible."itemId"
    WHERE eligible."itemId" IN (${valuesSql(ids)})
    ORDER BY eligible."itemId"
  `;
}

function historicalFactExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  const timePredicate = plan.temporal.mode === "RANGE" && plan.temporal.from && plan.temporal.to
    ? Prisma.sql`(
        (version."validFrom" IS NOT NULL OR version."validTo" IS NOT NULL)
        AND COALESCE(version."validTo", 'infinity'::timestamp) > ${plan.temporal.from}
        AND COALESCE(version."validFrom", '-infinity'::timestamp) < ${plan.temporal.to}
      )`
    : Prisma.sql`TRUE`;
  return Prisma.sql`
    SELECT
      version."id" AS "itemId",
      'FACT_VERSION'::"MemorySearchItemType" AS "itemType",
      version."displayText" AS "safeText",
      'FACT_DISPLAY_TEXT'::text AS "projectionKind",
      NULL::text AS "sourceChatId",
      NULL::text AS "supportingItemId",
      NULL::timestamp AS "occurredFrom",
      NULL::timestamp AS "occurredTo"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."activeIndexGenerationId" = ${snapshot.activeGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    WHERE version."userId" = ${snapshot.userId}
      AND version."id" IN (${valuesSql(ids)})
      AND version."state" IN (
        'SUPERSEDED'::"MemoryFactVersionState",
        'EXPIRED'::"MemoryFactVersionState",
        'CONFLICTING'::"MemoryFactVersionState"
      )
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND fact."state" IN (
        'ACTIVE'::"MemoryFactState",
        'CONFLICTED'::"MemoryFactState",
        'EXPIRED'::"MemoryFactState"
      )
      AND (fact."currentVersionId" IS NULL OR fact."currentVersionId" <> version."id")
      AND ${factScopePredicate(snapshot)}
      AND ${automaticFactEvidencePredicate(snapshot.userId)}
      AND ${activeSuppressionPredicate(snapshot.userId)}
      AND ${timePredicate}
      AND (
        version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
        OR (
          version."sensitivityClass" = 'SENSITIVE'::"MemorySensitivityClass"
          AND version."normalizedSearchText" = ${plan.normalizedQuery}
        )
      )
    ORDER BY version."id"
  `;
}

function chunkExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible AS MATERIALIZED (${historyEligibleSelect(snapshot, plan, "RECALL_CHUNK")})
    SELECT
      eligible."itemId",
      eligible."itemType",
      chunk."safeProjectedText" AS "safeText",
      'RECALL_CHUNK_SAFE_PROJECTED_TEXT'::text AS "projectionKind",
      chunk."chatId" AS "sourceChatId",
      NULL::text AS "supportingItemId",
      chunk."occurredFrom",
      chunk."occurredTo"
    FROM eligible
    INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = ${snapshot.userId}
      AND chunk."id" = eligible."itemId"
    WHERE eligible."itemId" IN (${valuesSql(ids)})
    ORDER BY eligible."itemId"
  `;
}

function episodeExpansionSql(
  snapshot: MemoryLocalRetrievalSnapshot,
  plan: MemoryRetrievalPlan,
  ids: readonly string[]
): Prisma.Sql {
  return Prisma.sql`
    WITH eligible_episodes AS MATERIALIZED (${historyEligibleSelect(snapshot, plan, "EPISODE")}),
    eligible_chunks AS MATERIALIZED (${historyEligibleSelect(snapshot, plan, "RECALL_CHUNK")})
    SELECT
      eligible_episodes."itemId",
      eligible_episodes."itemType",
      COALESCE(support."safeProjectedText", episode."safeSummary") AS "safeText",
      CASE WHEN support."id" IS NULL
        THEN 'EPISODE_SAFE_SUMMARY'
        ELSE 'RECALL_CHUNK_SAFE_PROJECTED_TEXT'
      END::text AS "projectionKind",
      episode."chatId" AS "sourceChatId",
      support."id" AS "supportingItemId",
      COALESCE(episode."occurredFrom", episode."createdAt") AS "occurredFrom",
      COALESCE(episode."occurredTo", episode."occurredFrom", episode."createdAt") AS "occurredTo"
    FROM eligible_episodes
    INNER JOIN "MemoryEpisode" AS episode
      ON episode."userId" = ${snapshot.userId}
      AND episode."id" = eligible_episodes."itemId"
    LEFT JOIN LATERAL (
      SELECT chunk."id", chunk."safeProjectedText"
      FROM eligible_chunks
      INNER JOIN "MemoryRecallChunk" AS chunk
        ON chunk."userId" = ${snapshot.userId}
        AND chunk."id" = eligible_chunks."itemId"
        AND chunk."chatId" = episode."chatId"
        AND chunk."branchGeneration" = episode."branchGeneration"
        AND chunk."sourceRevisionAtCreation" = episode."sourceRevisionAtCreation"
      WHERE EXISTS (
        SELECT 1
        FROM "MemoryEpisodeMessage" AS episode_message
        INNER JOIN "MemoryRecallChunkMessage" AS chunk_message
          ON chunk_message."userId" = episode_message."userId"
          AND chunk_message."chatId" = episode_message."chatId"
          AND chunk_message."messageId" = episode_message."messageId"
          AND chunk_message."chunkId" = chunk."id"
        WHERE episode_message."userId" = episode."userId"
          AND episode_message."episodeId" = episode."id"
      )
      ORDER BY chunk."occurredTo" DESC, chunk."id"
      LIMIT 1
    ) AS support ON TRUE
    WHERE eligible_episodes."itemId" IN (${valuesSql(ids)})
    ORDER BY eligible_episodes."itemId"
  `;
}

function validPlanForQuery(plan: MemoryRetrievalPlan): boolean {
  return plan.normalizedQuery.length > 0 && plan.normalizedQuery.length <= 2_000 &&
    plan.normalizedYoQuery.length > 0 && plan.normalizedYoQuery.length <= 2_000 &&
    plan.queryTerms.length > 0 && plan.queryTerms.length <= 24 &&
    plan.entityHints.length <= 12 && plan.canonicalKeyHints.length <= 16 &&
    plan.queryTerms.every((term) => term.length > 0 && term.length <= 64) &&
    plan.entityHints.every((entity) => entity.length > 0 && entity.length <= 80) &&
    plan.canonicalKeyHints.every((key) => /^[a-z][a-z0-9_.:-]{0,255}$/u.test(key));
}

function emptyResult(
  snapshot: MemoryLocalRetrievalSnapshot,
  vectorState: MemoryLocalRetrievalResult["vectorState"] = "DISABLED"
): MemoryLocalRetrievalResult {
  return { laneResults: [], snapshot, vectorEvidence: [], vectorState };
}

export function createPrismaLocalMemoryRetrievalRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async expand(
      snapshot: MemoryLocalRetrievalSnapshot,
      plan: MemoryRetrievalPlan,
      candidates: readonly MemoryRankedCandidate[]
    ): Promise<readonly MemoryExpandedCandidate[]> {
      if (
        snapshot.status !== "READY" || !snapshot.activeGenerationId ||
        candidates.length > MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES ||
        new Set(candidates.map((candidate) => `${candidate.itemType}:${candidate.itemId}`)).size !==
          candidates.length ||
        candidates.some((candidate) => !validToken(candidate.itemId))
      ) throw new Error("memory_expansion_contract_invalid");
      const currentFactIds = candidates
        .filter((candidate) => candidate.itemType === "FACT_VERSION" && candidate.metadata.current)
        .map((candidate) => candidate.itemId);
      const historicalFactIds = candidates
        .filter((candidate) => candidate.itemType === "FACT_VERSION" && candidate.metadata.historical)
        .map((candidate) => candidate.itemId);
      const chunkIds = candidates
        .filter((candidate) => candidate.itemType === "RECALL_CHUNK")
        .map((candidate) => candidate.itemId);
      const episodeIds = candidates
        .filter((candidate) => candidate.itemType === "EPISODE")
        .map((candidate) => candidate.itemId);
      const queries: Promise<ExpandedRow[]>[] = [];
      if (currentFactIds.length > 0) {
        queries.push(client.$queryRaw<ExpandedRow[]>(
          currentFactExpansionSql(snapshot, plan, currentFactIds)
        ));
      }
      if (historicalFactIds.length > 0) {
        queries.push(client.$queryRaw<ExpandedRow[]>(
          historicalFactExpansionSql(snapshot, plan, historicalFactIds)
        ));
      }
      if (chunkIds.length > 0) {
        queries.push(client.$queryRaw<ExpandedRow[]>(chunkExpansionSql(snapshot, plan, chunkIds)));
      }
      if (episodeIds.length > 0) {
        queries.push(client.$queryRaw<ExpandedRow[]>(episodeExpansionSql(snapshot, plan, episodeIds)));
      }
      const rows = (await Promise.all(queries)).flat();
      const decoded = rows.map(decodeExpanded);
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
      const snapshot = await loadSnapshot(client, input);
      if (snapshot.status !== "READY") return emptyResult(snapshot);
      if (!input.plan.retrievalAllowed || input.plan.intent === "NONE") {
        return emptyResult(snapshot, input.vector ? "DISABLED" : "NOT_CONFIGURED");
      }
      if (!validPlanForQuery(input.plan)) throw new Error("memory_retrieval_plan_invalid");
      if (memoryExplicitStatementContainsSecret(input.plan.normalizedQuery)) {
        return emptyResult(snapshot);
      }
      const tasks: Array<Parameters<typeof executeMemoryRetrievalLaneTasks>[0][number]> = [];
      const enabledLanes = [
        ...localLexicalLanes(snapshot, input.plan),
        ...localVectorLanes(snapshot, input)
      ];
      const allocation = allocateMemoryRetrievalLaneLimits(enabledLanes);
      pushLexicalTasks(tasks, client, snapshot, input.plan, allocation);
      const vectorEvidence: MemoryVectorLaneEvidence[] = [];
      const vector = pushVectorTasks(
        tasks,
        client,
        snapshot,
        input,
        vectorEvidence,
        allocation
      );
      const laneResults = await executeMemoryRetrievalLaneTasks(tasks);
      return {
        laneResults,
        snapshot,
        vectorEvidence: vectorEvidence.sort((left, right) =>
          left.itemType.localeCompare(right.itemType)),
        vectorState: vector.state()
      };
    }
  });
}

export type PrismaLocalMemoryRetrievalRepository = ReturnType<
  typeof createPrismaLocalMemoryRetrievalRepository
>;
