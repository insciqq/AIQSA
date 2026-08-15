import {
  Prisma,
  type MemoryDerivedSafetyClass,
  type MemorySearchItemType,
  type MemorySensitivityClass,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";

export const MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION =
  "memory-vector-retrieval-v1";
export const MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT =
  "memory-vector-pg16.14-pgvector0.8.5-filtered-hnsw-v2";
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
  allowedFactSensitivity: readonly MemorySensitivityClass[];
  allowedHistorySafety: readonly MemoryDerivedSafetyClass[];
  assistantId: string | null;
  chatId: string | null;
  folderId: string | null;
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
  const factSafety = new Set(["NORMAL", "SENSITIVE", "HIGHLY_SENSITIVE", "SECRET"]);
  const historySafety = new Set([
    "NORMAL",
    "SENSITIVE",
    "HIGHLY_SENSITIVE",
    "SECRET_TAINTED"
  ]);
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
        AND current_chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
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

function factEligibility(input: MemoryVectorSearchInput): EligibilitySql {
  const allowed = valuesSql(input.eligibility.allowedFactSensitivity);
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
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."systemTo" IS NULL
          AND version."contentPurgedAt" IS NULL
          AND version."sensitivityClass"::text IN (${allowed})
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" = version."id"
          AND scope."state" = 'ACTIVE'::"MemoryScopeState"
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
          AND (
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
              WHERE support."userId" = version."userId"
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
          )
          AND (
            (
              scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
              AND scope."targetIdSnapshot" IS NULL
              AND scope."folderId" IS NULL
              AND scope."assistantId" IS NULL
              AND scope."chatId" IS NULL
            )
            OR (
              scope."scopeType" = 'FOLDER'::"MemoryScopeType"
              AND scope."folderId" = ${input.eligibility.folderId}
              AND scope."targetIdSnapshot" = scope."folderId"
              AND scope."assistantId" IS NULL
              AND scope."chatId" IS NULL
              AND EXISTS (
                SELECT 1
                FROM "Folder" AS scope_folder
                WHERE scope_folder."userId" = fact."userId"
                  AND scope_folder."id" = scope."folderId"
              )
            )
            OR (
              scope."scopeType" = 'ASSISTANT'::"MemoryScopeType"
              AND scope."assistantId" = ${input.eligibility.assistantId}
              AND scope."targetIdSnapshot" = scope."assistantId"
              AND scope."folderId" IS NULL
              AND scope."chatId" IS NULL
              AND EXISTS (
                SELECT 1
                FROM "AssistantDefinition" AS scope_assistant
                WHERE scope_assistant."ownerUserId" = fact."userId"
                  AND scope_assistant."id" = scope."assistantId"
                  AND scope_assistant."archivedAt" IS NULL
              )
            )
            OR (
              scope."scopeType" = 'CHAT'::"MemoryScopeType"
              AND scope."chatId" = ${input.eligibility.chatId}
              AND scope."targetIdSnapshot" = scope."chatId"
              AND scope."folderId" IS NULL
              AND scope."assistantId" IS NULL
              AND EXISTS (
                SELECT 1
                FROM "Chat" AS scope_chat
                WHERE scope_chat."userId" = fact."userId"
                  AND scope_chat."id" = scope."chatId"
                  AND scope_chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
              )
            )
          )
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
    Prisma.sql`history_settings."referenceChatHistory" = TRUE`,
    Prisma.sql`chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"`,
    Prisma.sql`chunk."safetyClass"::text IN (${allowed})`,
    Prisma.sql`chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"`,
    Prisma.sql`source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"`,
    Prisma.sql`source_chat."memoryBranchGeneration" = chunk."branchGeneration"`,
    Prisma.sql`source_chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"`,
    Prisma.sql`checkpoint."branchGeneration" = chunk."branchGeneration"`,
    Prisma.sql`checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"`,
    Prisma.sql`checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"`,
    Prisma.sql`checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"`,
    Prisma.sql`checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"`,
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

function chunkCountEligibility(input: MemoryVectorSearchInput): EligibilitySql {
  return {
    itemId: Prisma.sql`entry."recallChunkId"`,
    joins: Prisma.sql`
      INNER JOIN "UserMemorySettings" AS history_settings
        ON history_settings."userId" = entry."userId"
      INNER JOIN "MemoryRecallChunk" AS chunk
        ON chunk."userId" = entry."userId"
        AND chunk."id" = entry."recallChunkId"
      INNER JOIN "Chat" AS source_chat
        ON source_chat."userId" = chunk."userId"
        AND source_chat."id" = chunk."chatId"
      INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
        ON checkpoint."userId" = chunk."userId"
        AND checkpoint."chatId" = chunk."chatId"
    `,
    predicates: [
      ...commonPredicates(input),
      Prisma.sql`entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"`,
      ...chunkEligibilityPredicates(input)
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
  const eligible = input.itemType === "RECALL_CHUNK"
    ? chunkCountEligibility(input.input)
    : eligibilitySql(input.input, input.itemType);
  return Prisma.sql`
    SELECT count(*)::integer AS "count"
    FROM "MemorySearchEntry" AS entry
    ${eligible.joins}
    WHERE ${Prisma.join(eligible.predicates, " AND ")}
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
  if (!row || row.ownerStatus !== "active" || !row.activeIndexGenerationId) {
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
