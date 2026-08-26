import {
  Prisma,
  type MemoryDerivedSafetyClass,
  type MemorySearchItemType,
  type MemorySensitivityClass,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";
import { memoryHistoryChunkSourceAuthorityPredicate } from "../persistence/pauseIntervals";

export const MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION =
  "memory-personal-retrieval-v5-vector";
export const MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT =
  "memory-vector-pg16.14-pgvector0.8.5-filtered-hnsw-v7-bounded-strategy-corpus";
export const MEMORY_VECTOR_MINIMUM_SIMILARITY = Object.freeze({
  1024: 0.55,
  1536: 0.55
} as const);
export const MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS = 5_000;
export const MEMORY_HNSW_EF_SEARCH = 100;
export const MEMORY_HNSW_MAX_SCAN_TUPLES = 20_000;
export const MEMORY_HNSW_OVERFETCH_MULTIPLIER = 8;
export const MEMORY_HNSW_MAX_CANDIDATES_PER_LANE = 200;
export const MEMORY_VECTOR_MAX_RESULT_LIMIT = 50;

export type MemoryVectorDimension = 1_024 | 1_536;
export type MemoryVectorStrategy = "EXACT" | "HNSW";
export type CurrentMemorySearchItemType = Extract<
  MemorySearchItemType,
  "FACT_VERSION" | "RECALL_CHUNK"
>;

export type MemoryVectorProfile = Readonly<{
  configurationFingerprint: string;
  connectionId: string;
  dimension: MemoryVectorDimension;
  generationId: string;
  minimumSimilarity: number;
  providerModelId: string;
  retrievalConfigFingerprint: string;
  vectorSpaceFingerprint: string;
}>;

export type MemoryVectorProfileResolution =
  | Readonly<{ profile: MemoryVectorProfile; status: "READY" }>
  | Readonly<{
      reason:
        | "memory_vector_generation_stale"
        | "memory_vector_profile_unsupported"
        | "memory_vector_unavailable";
      status: "DEGRADED";
    }>;

export type MemoryVectorDegradationReason = Extract<
  MemoryVectorProfileResolution,
  { status: "DEGRADED" }
>["reason"];

export type MemoryVectorEligibility = Readonly<{
  allowedFactSensitivity: readonly Extract<
    MemorySensitivityClass,
    "NORMAL" | "SENSITIVE"
  >[];
  allowedHistorySafety: readonly Extract<
    MemoryDerivedSafetyClass,
    "NORMAL" | "SENSITIVE"
  >[];
  assistantId: string | null;
  chatId: string | null;
  factMode: "CURRENT" | "HISTORICAL";
  factTemporalAsOf: Date | null;
  folderId: string | null;
  includePatterns: boolean;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  sourceAssistantId: string | null;
  sourceChatIds: readonly string[] | null;
  sourceFolderId: string | null;
}>;

export type MemoryVectorSearchInput = Readonly<{
  eligibility: MemoryVectorEligibility;
  itemTypes: readonly CurrentMemorySearchItemType[];
  limit: number;
  minimumScore: number;
  profile: MemoryVectorProfile;
  userId: string;
  vector: readonly number[];
}>;

export type MemoryVectorHit = Readonly<{
  distance: number;
  entryId: string;
  itemId: string;
  itemType: CurrentMemorySearchItemType;
  score: number;
}>;

export type MemoryVectorLaneEvidence = Readonly<{
  candidateCount: number;
  /**
   * Bounded indexed-corpus upper bound used only to select exact versus HNSW;
   * threshold + 1 means "more". Candidate scan and rejoin enforce the full
   * current source/safety/lifecycle authority.
   */
  eligibleCount: number;
  exactFallbackUsed: boolean;
  itemType: CurrentMemorySearchItemType;
  resultCount: number;
  strategy: MemoryVectorStrategy;
}>;

export type MemoryVectorSearchResult =
  | Readonly<{
      hits: readonly MemoryVectorHit[];
      lanes: readonly MemoryVectorLaneEvidence[];
      profile: MemoryVectorProfile;
      status: "READY";
    }>
  | Readonly<{
      hits: readonly [];
      lanes: readonly [];
      reason: MemoryVectorDegradationReason;
      status: "DEGRADED";
    }>;

type MemoryVectorCandidate = Readonly<{
  entryId: string;
}>;

export type MemoryVectorLaneExecutor = Readonly<{
  candidateScan(
    input: MemoryVectorSearchInput,
    itemType: CurrentMemorySearchItemType,
    strategy: MemoryVectorStrategy,
    limit: number
  ): Promise<readonly MemoryVectorCandidate[]>;
  /** Returns the bounded indexed-corpus upper bound used for strategy choice. */
  eligibleCount(
    input: MemoryVectorSearchInput,
    itemType: CurrentMemorySearchItemType
  ): Promise<number>;
  rejoin(
    input: MemoryVectorSearchInput,
    itemType: CurrentMemorySearchItemType,
    candidateIds: readonly string[]
  ): Promise<readonly MemoryVectorHit[]>;
  resolveActiveProfile(userId: string): Promise<MemoryVectorProfileResolution>;
}>;

type ProfileRow = Readonly<{
  activeIndexGenerationId: string | null;
  embeddingConfigurationFingerprint: string | null;
  embeddingConnectionId: string | null;
  embeddingDimension: number | null;
  embeddingProviderModelId: string | null;
  generationId: string | null;
  generationState: string | null;
  indexMode: string | null;
  ownerStatus: string;
  useMemoryFacts: boolean | null;
  retrievalPipelineVersion: string | null;
  selectedEmbeddingProviderModelId: string | null;
  vectorSpaceFingerprint: string | null;
}>;

type CandidateRow = Readonly<{ entryId: string }>;
type CountRow = Readonly<{ count: number }>;
type HitRow = Readonly<{
  distance: number;
  entryId: string;
  itemId: string;
  itemType: CurrentMemorySearchItemType;
}>;

export type MemoryVectorSqlInput = Readonly<{
  candidateIds?: readonly string[];
  input: MemoryVectorSearchInput;
  itemType: CurrentMemorySearchItemType;
  limit?: number;
}>;

type EligibilitySql = Readonly<{
  itemId: Prisma.Sql;
  joins: Prisma.Sql;
  predicates: readonly Prisma.Sql[];
}>;

type VectorTransaction = Prisma.TransactionClient;

function boundedToken(value: string | null, maxLength = 256): boolean {
  return value === null || (typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function supportedDimension(value: number | null): value is MemoryVectorDimension {
  return value === 1_024 || value === 1_536;
}

function validFingerprint(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/u.test(value));
}

function sameProfile(left: MemoryVectorProfile, right: MemoryVectorProfile): boolean {
  return left.configurationFingerprint === right.configurationFingerprint &&
    left.connectionId === right.connectionId &&
    left.dimension === right.dimension &&
    left.generationId === right.generationId &&
    left.minimumSimilarity === right.minimumSimilarity &&
    left.providerModelId === right.providerModelId &&
    left.retrievalConfigFingerprint === right.retrievalConfigFingerprint &&
    left.vectorSpaceFingerprint === right.vectorSpaceFingerprint;
}

function validDate(value: Date | null): boolean {
  return value === null || (
    value instanceof Date && Number.isFinite(value.getTime())
  );
}

function uniqueClosedValues<T extends string>(
  values: readonly T[],
  allowed: ReadonlySet<string>
): boolean {
  return values.length > 0 &&
    values.length <= allowed.size &&
    new Set(values).size === values.length &&
    values.every((value) => allowed.has(value));
}

function validateSearchInput(input: MemoryVectorSearchInput): void {
  const factSafety = new Set(["NORMAL", "SENSITIVE"]);
  const historySafety = new Set(["NORMAL", "SENSITIVE"]);
  const itemTypes = new Set<CurrentMemorySearchItemType>([
    "FACT_VERSION",
    "RECALL_CHUNK"
  ]);
  const sourceChatIds = input.eligibility.sourceChatIds;
  const squaredNorm = input.vector.reduce((total, value) => total + value * value, 0);
  if (
    !boundedToken(input.userId) ||
    !boundedToken(input.profile.connectionId) ||
    !boundedToken(input.profile.generationId) ||
    !boundedToken(input.profile.providerModelId) ||
    !validFingerprint(input.profile.configurationFingerprint) ||
    !validFingerprint(input.profile.vectorSpaceFingerprint) ||
    input.profile.retrievalConfigFingerprint !==
      MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT ||
    !Number.isFinite(input.profile.minimumSimilarity) ||
    input.profile.minimumSimilarity <= 0 || input.profile.minimumSimilarity > 1 ||
    !supportedDimension(input.profile.dimension) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 || input.limit > MEMORY_VECTOR_MAX_RESULT_LIMIT ||
    !Number.isFinite(input.minimumScore) ||
    input.minimumScore < -1 || input.minimumScore > 1 ||
    input.vector.length !== input.profile.dimension ||
    input.vector.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(squaredNorm) || squaredNorm <= 0 ||
    input.itemTypes.length < 1 || input.itemTypes.length > itemTypes.size ||
    new Set(input.itemTypes).size !== input.itemTypes.length ||
    input.itemTypes.some((value) => !itemTypes.has(value)) ||
    !uniqueClosedValues(input.eligibility.allowedFactSensitivity, factSafety) ||
    !uniqueClosedValues(input.eligibility.allowedHistorySafety, historySafety) ||
    !boundedToken(input.eligibility.assistantId) ||
    !boundedToken(input.eligibility.chatId) ||
    !boundedToken(input.eligibility.folderId) ||
    !boundedToken(input.eligibility.sourceAssistantId) ||
    !boundedToken(input.eligibility.sourceFolderId) ||
    !validDate(input.eligibility.occurredFrom) ||
    !validDate(input.eligibility.occurredTo) ||
    !validDate(input.eligibility.factTemporalAsOf) ||
    !["CURRENT", "HISTORICAL"].includes(input.eligibility.factMode) ||
    typeof input.eligibility.includePatterns !== "boolean" ||
    input.eligibility.includePatterns && input.eligibility.factMode !== "CURRENT" ||
    Boolean(input.eligibility.factTemporalAsOf &&
      (input.eligibility.occurredFrom || input.eligibility.occurredTo)) ||
    Boolean(
      input.eligibility.occurredFrom && input.eligibility.occurredTo &&
      input.eligibility.occurredFrom > input.eligibility.occurredTo
    ) ||
    Boolean(sourceChatIds && (
      sourceChatIds.length < 1 || sourceChatIds.length > 50 ||
      new Set(sourceChatIds).size !== sourceChatIds.length ||
      sourceChatIds.some((value) => !boundedToken(value))
    ))
  ) throw new Error("memory_vector_query_invalid");
}

function vectorSql(
  vector: readonly number[],
  dimension: MemoryVectorDimension
): Prisma.Sql {
  const serialized = `[${vector.join(",")}]`;
  return dimension === 1_024
    ? Prisma.sql`${serialized}::vector(1024)`
    : Prisma.sql`${serialized}::vector(1536)`;
}

function distanceSql(
  vector: readonly number[],
  dimension: MemoryVectorDimension
): Prisma.Sql {
  const query = vectorSql(vector, dimension);
  return dimension === 1_024
    ? Prisma.sql`(entry."embedding"::vector(1024) <=> ${query})`
    : Prisma.sql`(entry."embedding"::vector(1536) <=> ${query})`;
}

function commonPredicates(input: MemoryVectorSearchInput): Prisma.Sql[] {
  const predicates = [
    Prisma.sql`entry."userId" = ${input.userId}`,
    Prisma.sql`entry."indexGenerationId" = ${input.profile.generationId}`,
    Prisma.sql`entry."embeddingState" = 'READY'::"MemoryEmbeddingState"`,
    Prisma.sql`entry."embedding" IS NOT NULL`,
    Prisma.sql`entry."embeddingDimension" = ${input.profile.dimension}`,
    Prisma.sql`EXISTS (
      SELECT 1
      FROM "UserMemorySettings" AS settings
      INNER JOIN "MemoryIndexGeneration" AS generation
        ON generation."userId" = settings."userId"
        AND generation."id" = settings."activeIndexGenerationId"
      WHERE settings."userId" = entry."userId"
        AND settings."activeIndexGenerationId" = entry."indexGenerationId"
        AND settings."embeddingProviderModelId" = ${input.profile.providerModelId}
        AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
        AND generation."indexMode" = 'HYBRID'::"MemoryIndexMode"
        AND generation."embeddingDimension" = entry."embeddingDimension"
        AND generation."vectorSpaceFingerprint" = ${input.profile.vectorSpaceFingerprint}
        AND generation."embeddingConfigurationFingerprint" = ${input.profile.configurationFingerprint}
        AND generation."embeddingConnectionId" = ${input.profile.connectionId}
        AND generation."embeddingProviderModelId" = ${input.profile.providerModelId}
    )`
  ];
  if (input.eligibility.chatId) {
    predicates.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "Chat" AS current_chat
      WHERE current_chat."userId" = ${input.userId}
        AND current_chat."id" = ${input.eligibility.chatId}
        AND current_chat."projectId" IS NULL
        AND current_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND current_chat."permanentDeletionAt" IS NULL
    )`);
  }
  return predicates;
}

function commonJoins(): Prisma.Sql {
  return Prisma.empty;
}

function valuesSql(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

function optionalHistoryPredicates(input: MemoryVectorSearchInput): Prisma.Sql[] {
  const eligibility = input.eligibility;
  const prefix = {
    assistant: Prisma.sql`chunk."sourceAssistantId"`,
    chat: Prisma.sql`chunk."chatId"`,
    folder: Prisma.sql`chunk."sourceFolderId"`,
    from: Prisma.sql`chunk."occurredFrom"`,
    to: Prisma.sql`chunk."occurredTo"`
  };
  const predicates: Prisma.Sql[] = [];
  if (eligibility.sourceChatIds) {
    predicates.push(Prisma.sql`${prefix.chat} IN (${valuesSql(eligibility.sourceChatIds)})`);
  }
  if (eligibility.sourceFolderId) {
    predicates.push(Prisma.sql`${prefix.folder} = ${eligibility.sourceFolderId}`);
  }
  if (eligibility.sourceAssistantId) {
    predicates.push(Prisma.sql`${prefix.assistant} = ${eligibility.sourceAssistantId}`);
  }
  if (eligibility.occurredFrom) {
    predicates.push(Prisma.sql`${prefix.to} >= ${eligibility.occurredFrom}`);
  }
  if (eligibility.occurredTo) {
    predicates.push(Prisma.sql`${prefix.from} <= ${eligibility.occurredTo}`);
  }
  return predicates;
}

function factConversationFeedbackPredicate(input: MemoryVectorSearchInput): Prisma.Sql {
  if (!input.eligibility.chatId) return Prisma.sql`TRUE`;
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemoryFeedback" AS negative_feedback
    INNER JOIN "ModelRun" AS negative_run
      ON negative_run."userId" = negative_feedback."userId"
      AND negative_run."id" = negative_feedback."modelRunId"
    WHERE negative_feedback."userId" = entry."userId"
      AND negative_feedback."feedbackType" = 'NOT_USEFUL'::"MemoryFeedbackType"
      AND negative_feedback."memoryFactVersionId" = version."id"
      AND negative_feedback."contentPurgedAt" IS NULL
      AND negative_run."chatId" = ${input.eligibility.chatId}
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

function chunkConversationFeedbackPredicate(input: MemoryVectorSearchInput): Prisma.Sql {
  if (!input.eligibility.chatId) return Prisma.sql`TRUE`;
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemoryFeedback" AS negative_feedback
    INNER JOIN "ModelRun" AS negative_run
      ON negative_run."userId" = negative_feedback."userId"
      AND negative_run."id" = negative_feedback."modelRunId"
    WHERE negative_feedback."userId" = entry."userId"
      AND negative_feedback."feedbackType" = 'NOT_USEFUL'::"MemoryFeedbackType"
      AND negative_feedback."recallChunkId" = chunk."id"
      AND negative_feedback."contentPurgedAt" IS NULL
      AND negative_run."chatId" = ${input.eligibility.chatId}
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

function factEligibility(input: MemoryVectorSearchInput): EligibilitySql {
  const allowed = valuesSql(input.eligibility.allowedFactSensitivity);
  const temporalStart = Prisma.sql`COALESCE(
    version."occurredAt", version."validFrom", version."observedAt", version."systemFrom"
  )`;
  const temporalEnd = Prisma.sql`COALESCE(version."validTo", version."systemTo")`;
  const lifecycle = input.eligibility.factMode === "HISTORICAL"
    ? Prisma.sql`(
        (version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."systemTo" IS NULL
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" = version."id")
        OR
        (version."state" = 'SUPERSEDED'::"MemoryFactVersionState"
          AND version."systemTo" IS NOT NULL
          AND (fact."state" = 'ACTIVE'::"MemoryFactState"
            OR (fact."state" = 'RETRACTED'::"MemoryFactState"
              AND fact."movedToFactId" IS NOT NULL)))
      )`
    : Prisma.sql`version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND fact."currentVersionId" = version."id"`;
  const from = input.eligibility.occurredFrom
    ? Prisma.sql`COALESCE(${temporalEnd}, ${temporalStart}) >=
        ${input.eligibility.occurredFrom}`
    : Prisma.sql`TRUE`;
  const to = input.eligibility.occurredTo
    ? Prisma.sql`${temporalStart} < ${input.eligibility.occurredTo}`
    : Prisma.sql`TRUE`;
  const asOf = input.eligibility.factTemporalAsOf
    ? Prisma.sql`${temporalStart} <= ${input.eligibility.factTemporalAsOf}
        AND (${temporalEnd} IS NULL OR ${temporalEnd} > ${input.eligibility.factTemporalAsOf})`
    : Prisma.sql`TRUE`;
  return {
    itemId: Prisma.sql`entry."factVersionId"`,
    joins: commonJoins(),
    predicates: [
      ...commonPredicates(input),
      Prisma.sql`entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"`,
      Prisma.sql`EXISTS (
        SELECT 1
        FROM "UserMemorySettings" AS fact_settings
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = fact_settings."userId"
          AND version."id" = entry."factVersionId"
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId"
          AND fact."id" = version."factId"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId"
          AND scope."id" = fact."scopeId"
        WHERE fact_settings."userId" = entry."userId"
          AND fact_settings."useMemoryFacts" = TRUE
          AND ${lifecycle}
          AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
          AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
          AND version."contentPurgedAt" IS NULL
          AND version."sensitivityClass"::text IN (${allowed})
          AND scope."state" = 'ACTIVE'::"MemoryScopeState"
          AND ${from} AND ${to} AND ${asOf}
          AND ${factConversationFeedbackPredicate(input)}
          AND NOT EXISTS (
            SELECT 1
            FROM "MemorySuppression" AS fact_suppression
            WHERE fact_suppression."userId" = fact."userId"
              AND fact_suppression."scope" = 'ALL'::"MemorySuppressionScope"
              AND (
                fact_suppression."expiresAt" IS NULL
                OR fact_suppression."expiresAt" > CURRENT_TIMESTAMP
              )
          )
          AND ${memoryReusableFactAuthorityPredicate(
            Prisma.sql`entry."userId"`,
            {
              includePatterns: input.eligibility.includePatterns,
              lifecycle: input.eligibility.factMode === "HISTORICAL"
                ? "CURRENT_OR_HISTORICAL"
                : "CURRENT",
              settings: Prisma.sql`fact_settings`
            }
          )}
          AND ${memoryCanonicalGlobalScopePredicate()}
      )`
    ]
  };
}

function chunkEligibilityPredicates(
  input: MemoryVectorSearchInput
): readonly Prisma.Sql[] {
  const allowed = valuesSql(input.eligibility.allowedHistorySafety);
  const historyPredicates = optionalHistoryPredicates(input);
  return [
    Prisma.sql`history_settings."useMemoryFacts" = TRUE`,
    Prisma.sql`history_settings."referenceChatHistory" = TRUE`,
    Prisma.sql`chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"`,
    Prisma.sql`chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}`,
    Prisma.sql`chunk."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}`,
    Prisma.sql`chunk."safetyClass"::text IN (${allowed})`,
    Prisma.sql`chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"`,
    Prisma.sql`source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"`,
    Prisma.sql`source_chat."projectId" IS NULL`,
    Prisma.sql`checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"`,
    Prisma.sql`checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}`,
    memoryHistoryChunkSourceAuthorityPredicate({
      chat: "source_chat",
      checkpoint: "checkpoint"
    }),
    chunkConversationFeedbackPredicate(input),
    Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "MemorySuppression" AS suppression
      LEFT JOIN "MemoryRecallChunkMessage" AS chunk_message
        ON chunk_message."userId" = chunk."userId"
        AND chunk_message."chunkId" = chunk."id"
        AND suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
        AND suppression."sourceChatId" = chunk_message."chatId"
        AND suppression."sourceMessageId" = chunk_message."messageId"
      WHERE suppression."userId" = chunk."userId"
        AND (
          suppression."expiresAt" IS NULL
          OR suppression."expiresAt" > CURRENT_TIMESTAMP
        )
        AND (
          suppression."scope" = 'ALL'::"MemorySuppressionScope"
          OR (
            chunk_message."messageId" IS NOT NULL
            AND (
              suppression."sourceBranchGeneration" IS NULL
              OR suppression."sourceBranchGeneration" = chunk."branchGeneration"
            )
          )
        )
    )`,
    Prisma.sql`NOT EXISTS (
      SELECT 1
      FROM "MemorySourceBarrier" AS barrier
      WHERE barrier."userId" = chunk."userId"
        AND barrier."kind" IN (
          'HISTORY_INDEX'::"MemorySourceBarrierKind",
          'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        AND barrier."explicitOverrideAllowed" = FALSE
        AND (
          chunk."createdAt" <= barrier."createdAt"
          OR EXISTS (
            SELECT 1
            FROM "MemoryRecallChunkMessage" AS barrier_source
            INNER JOIN "Message" AS barrier_message
              ON barrier_message."chatId" = barrier_source."chatId"
              AND barrier_message."id" = barrier_source."messageId"
            WHERE barrier_source."userId" = chunk."userId"
              AND barrier_source."chunkId" = chunk."id"
              AND barrier_message."createdAt" <= barrier."sourceCreatedAtCutoff"
          )
        )
    )`,
    ...historyPredicates
  ];
}

function chunkEligibility(input: MemoryVectorSearchInput): EligibilitySql {
  const chunkPredicates = chunkEligibilityPredicates(input);
  return {
    itemId: Prisma.sql`entry."recallChunkId"`,
    joins: commonJoins(),
    predicates: [
      ...commonPredicates(input),
      Prisma.sql`entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"`,
      Prisma.sql`EXISTS (
        SELECT 1
        FROM "UserMemorySettings" AS history_settings
        INNER JOIN "MemoryRecallChunk" AS chunk
          ON chunk."userId" = history_settings."userId"
          AND chunk."id" = entry."recallChunkId"
        INNER JOIN "Chat" AS source_chat
          ON source_chat."userId" = chunk."userId"
          AND source_chat."id" = chunk."chatId"
        INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
          ON checkpoint."userId" = chunk."userId"
          AND checkpoint."chatId" = chunk."chatId"
        WHERE history_settings."userId" = entry."userId"
          AND ${Prisma.join(chunkPredicates, " AND ")}
      )`
    ]
  };
}

function eligibilitySql(
  input: MemoryVectorSearchInput,
  itemType: CurrentMemorySearchItemType
): EligibilitySql {
  switch (itemType) {
    case "FACT_VERSION": return factEligibility(input);
    case "RECALL_CHUNK": return chunkEligibility(input);
  }
}

export function memoryVectorEligibleCountSql(input: MemoryVectorSqlInput): Prisma.Sql {
  // Strategy selection needs a conservative upper bound, not a second full
  // authoritative scan. Counting the current generation's READY index rows
  // can only choose HNSW earlier when stale rows exist; candidate scan and the
  // authoritative rejoin still apply every source/safety/lifecycle fence. A
  // full eligible count here doubled the hot-path work for HNSW requests.
  return Prisma.sql`
    SELECT count(*)::integer AS "count"
    FROM (
      SELECT 1
      FROM "MemorySearchEntry" AS entry
      WHERE entry."userId" = ${input.input.userId}
        AND entry."indexGenerationId" = ${input.input.profile.generationId}
        AND entry."itemType" = ${input.itemType}::"MemorySearchItemType"
        AND entry."embeddingState" = 'READY'::"MemoryEmbeddingState"
        AND entry."embedding" IS NOT NULL
        AND entry."embeddingDimension" = ${input.input.profile.dimension}
      LIMIT ${MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS + 1}
    ) AS bounded_eligible
  `;
}

/** Direct ordered scan. No materialized CTE may precede this statement. */
export function memoryVectorCandidateSql(input: MemoryVectorSqlInput): Prisma.Sql {
  if (!input.limit) throw new Error("memory_vector_query_invalid");
  const eligible = eligibilitySql(input.input, input.itemType);
  const distance = distanceSql(input.input.vector, input.input.profile.dimension);
  return Prisma.sql`
    SELECT entry."id" AS "entryId"
    FROM "MemorySearchEntry" AS entry
    ${eligible.joins}
    WHERE ${Prisma.join(eligible.predicates, " AND ")}
    ORDER BY ${distance}
    LIMIT ${input.limit}
  `;
}

export function memoryVectorAuthoritativeRejoinSql(
  input: MemoryVectorSqlInput
): Prisma.Sql {
  const candidateIds = input.candidateIds;
  if (
    !candidateIds || candidateIds.length === 0 ||
    candidateIds.length > MEMORY_HNSW_MAX_CANDIDATES_PER_LANE
  ) {
    throw new Error("memory_vector_query_invalid");
  }
  const eligible = eligibilitySql(input.input, input.itemType);
  const distance = distanceSql(input.input.vector, input.input.profile.dimension);
  const predicates = [
    ...eligible.predicates,
    Prisma.sql`entry."id" IN (${valuesSql(candidateIds)})`
  ];
  return Prisma.sql`
    WITH eligible_candidates AS MATERIALIZED (
      SELECT
        entry."id" AS "entryId",
        entry."itemType"::text AS "itemType",
        ${eligible.itemId} AS "itemId",
        ${distance}::double precision AS "distance"
      FROM "MemorySearchEntry" AS entry
      ${eligible.joins}
      WHERE ${Prisma.join(predicates, " AND ")}
    )
    SELECT "entryId", "itemType", "itemId", "distance"
    FROM eligible_candidates
    WHERE (1 - "distance") >= ${input.input.minimumScore}
    ORDER BY "distance", "entryId"
    LIMIT ${input.input.limit}
  `;
}

function decodedCount(rows: readonly CountRow[]): number {
  const count = rows[0]?.count;
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw new Error("memory_vector_result_invalid");
  }
  return Number(count);
}

function decodedCandidates(rows: readonly CandidateRow[]): readonly MemoryVectorCandidate[] {
  if (rows.some((row) => !boundedToken(row.entryId))) {
    throw new Error("memory_vector_result_invalid");
  }
  const ids = rows.map((row) => row.entryId);
  if (new Set(ids).size !== ids.length) throw new Error("memory_vector_result_invalid");
  return rows;
}

function decodedHits(
  rows: readonly HitRow[],
  expectedType: CurrentMemorySearchItemType
): readonly MemoryVectorHit[] {
  const hits = rows.map((row): MemoryVectorHit => {
    if (
      row.itemType !== expectedType ||
      !boundedToken(row.entryId) || !boundedToken(row.itemId) ||
      !Number.isFinite(row.distance) || row.distance < -1e-9 || row.distance > 2.000000001
    ) throw new Error("memory_vector_result_invalid");
    const distance = Math.max(0, Math.min(2, row.distance));
    return {
      distance,
      entryId: row.entryId,
      itemId: row.itemId,
      itemType: row.itemType,
      score: 1 - distance
    };
  });
  if (new Set(hits.map((hit) => hit.entryId)).size !== hits.length) {
    throw new Error("memory_vector_result_invalid");
  }
  return hits;
}

async function resolveActiveProfileWith(
  store: Pick<PrismaClient, "$queryRaw">,
  userId: string
): Promise<MemoryVectorProfileResolution> {
  if (!boundedToken(userId)) throw new Error("memory_vector_query_invalid");
  const rows = await store.$queryRaw<ProfileRow[]>(Prisma.sql`
    SELECT
      owner."status"::text AS "ownerStatus",
      settings."useMemoryFacts",
      settings."activeIndexGenerationId",
      settings."embeddingProviderModelId" AS "selectedEmbeddingProviderModelId",
      generation."id" AS "generationId",
      generation."state"::text AS "generationState",
      generation."indexMode"::text AS "indexMode",
      generation."embeddingConnectionId",
      generation."embeddingProviderModelId",
      generation."embeddingConfigurationFingerprint",
      generation."embeddingDimension",
      generation."retrievalPipelineVersion",
      generation."vectorSpaceFingerprint"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "User" AS owner ON owner."id" = settings."userId"
    LEFT JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
    WHERE settings."userId" = ${userId}
    LIMIT 1
  `);
  const row = rows[0];
  if (
    !row ||
    row.ownerStatus !== "active" ||
    row.useMemoryFacts !== true ||
    !row.activeIndexGenerationId
  ) {
    return { reason: "memory_vector_unavailable", status: "DEGRADED" };
  }
  if (row.indexMode === "LEXICAL_ONLY") {
    return { reason: "memory_vector_unavailable", status: "DEGRADED" };
  }
  if (
    row.generationId !== row.activeIndexGenerationId ||
    row.generationState !== "ACTIVE" ||
    row.indexMode !== "HYBRID" ||
    row.retrievalPipelineVersion !== MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION ||
    row.embeddingProviderModelId !== row.selectedEmbeddingProviderModelId ||
    !row.embeddingConnectionId || !row.embeddingProviderModelId ||
    !validFingerprint(row.embeddingConfigurationFingerprint) ||
    !validFingerprint(row.vectorSpaceFingerprint)
  ) {
    return { reason: "memory_vector_generation_stale", status: "DEGRADED" };
  }
  if (!supportedDimension(row.embeddingDimension)) {
    return { reason: "memory_vector_profile_unsupported", status: "DEGRADED" };
  }
  return {
    profile: {
      configurationFingerprint: row.embeddingConfigurationFingerprint,
      connectionId: row.embeddingConnectionId,
      dimension: row.embeddingDimension,
      generationId: row.generationId,
      minimumSimilarity: MEMORY_VECTOR_MINIMUM_SIMILARITY[row.embeddingDimension],
      providerModelId: row.embeddingProviderModelId,
      retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
      vectorSpaceFingerprint: row.vectorSpaceFingerprint
    },
    status: "READY"
  };
}

function createPrismaLaneExecutor(tx: VectorTransaction): MemoryVectorLaneExecutor {
  return Object.freeze({
    async candidateScan(input, itemType, strategy, limit) {
      if (strategy === "HNSW") {
        await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`;
        await tx.$executeRaw`SET LOCAL enable_indexscan = on`;
        await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
        await tx.$executeRaw(Prisma.sql`
          SET LOCAL hnsw.ef_search = ${Prisma.raw(String(MEMORY_HNSW_EF_SEARCH))}
        `);
        await tx.$executeRaw(Prisma.sql`
          SET LOCAL hnsw.max_scan_tuples =
            ${Prisma.raw(String(MEMORY_HNSW_MAX_SCAN_TUPLES))}
        `);
      } else {
        await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
      }
      try {
        const rows = await tx.$queryRaw<CandidateRow[]>(memoryVectorCandidateSql({
          input,
          itemType,
          limit
        }));
        return decodedCandidates(rows);
      } finally {
        if (strategy === "EXACT") {
          await tx.$executeRaw`SET LOCAL enable_indexscan = on`;
        }
      }
    },
    async eligibleCount(input, itemType) {
      return decodedCount(await tx.$queryRaw<CountRow[]>(
        memoryVectorEligibleCountSql({ input, itemType })
      ));
    },
    async rejoin(input, itemType, candidateIds) {
      if (candidateIds.length === 0) return [];
      return decodedHits(await tx.$queryRaw<HitRow[]>(
        memoryVectorAuthoritativeRejoinSql({ candidateIds, input, itemType })
      ), itemType);
    },
    resolveActiveProfile(userId) {
      return resolveActiveProfileWith(tx, userId);
    }
  });
}

export async function searchMemoryVectorLanes(
  executor: MemoryVectorLaneExecutor,
  input: MemoryVectorSearchInput
): Promise<MemoryVectorSearchResult> {
  validateSearchInput(input);
  const resolved = await executor.resolveActiveProfile(input.userId);
  if (resolved.status !== "READY") {
    return { hits: [], lanes: [], reason: resolved.reason, status: "DEGRADED" };
  }
  if (!sameProfile(resolved.profile, input.profile)) {
    return {
      hits: [],
      lanes: [],
      reason: "memory_vector_generation_stale",
      status: "DEGRADED"
    };
  }

  const allHits: MemoryVectorHit[] = [];
  const lanes: MemoryVectorLaneEvidence[] = [];
  for (const itemType of input.itemTypes) {
    const eligibleCount = await executor.eligibleCount(input, itemType);
    if (eligibleCount === 0) {
      lanes.push({
        candidateCount: 0,
        eligibleCount: 0,
        exactFallbackUsed: false,
        itemType,
        resultCount: 0,
        strategy: "EXACT"
      });
      continue;
    }
    const strategy: MemoryVectorStrategy =
      eligibleCount <= MEMORY_EXACT_VECTOR_MAX_ELIGIBLE_ROWS ? "EXACT" : "HNSW";
    const candidateLimit = strategy === "HNSW"
      ? Math.min(
          input.limit * MEMORY_HNSW_OVERFETCH_MULTIPLIER,
          MEMORY_HNSW_MAX_CANDIDATES_PER_LANE
        )
      : input.limit;
    let candidates = await executor.candidateScan(
      input,
      itemType,
      strategy,
      candidateLimit
    );
    let hits = await executor.rejoin(
      input,
      itemType,
      candidates.map((candidate) => candidate.entryId)
    );
    let exactFallbackUsed = false;
    if (
      strategy === "HNSW" &&
      hits.length < Math.min(input.limit, eligibleCount)
    ) {
      exactFallbackUsed = true;
      candidates = await executor.candidateScan(input, itemType, "EXACT", input.limit);
      hits = await executor.rejoin(
        input,
        itemType,
        candidates.map((candidate) => candidate.entryId)
      );
    }
    allHits.push(...hits);
    lanes.push({
      candidateCount: candidates.length,
      eligibleCount,
      exactFallbackUsed,
      itemType,
      resultCount: hits.length,
      strategy
    });
  }
  const hits = allHits
    .sort((left, right) => right.score - left.score ||
      left.entryId.localeCompare(right.entryId))
    .slice(0, input.limit);
  return { hits, lanes, profile: resolved.profile, status: "READY" };
}

export function createPrismaMemoryVectorRepository(client: PrismaClient = prisma) {
  return Object.freeze({
    resolveActiveProfile(userId: string) {
      return resolveActiveProfileWith(client, userId);
    },
    async search(input: MemoryVectorSearchInput): Promise<MemoryVectorSearchResult> {
      return client.$transaction(
        (tx) => searchMemoryVectorLanes(createPrismaLaneExecutor(tx), input),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
    }
  });
}

export type MemoryVectorRepository = ReturnType<
  typeof createPrismaMemoryVectorRepository
>;
