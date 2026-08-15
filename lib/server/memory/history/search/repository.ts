import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  MemoryHistoryDegradationCode,
  MemoryHistorySearchInput,
  MemoryHistorySearchResponse,
  MemoryItemIndexingState
} from "../../../../contracts/memory";
import { prisma } from "../../../prisma";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../../persistence/lexical";

const HISTORY_SEARCH_OFFSET_MAX = 1_000;
const HISTORY_VECTOR_HIT_MAX = 50;

type SearchStore = Pick<PrismaClient, "$queryRaw"> | Prisma.TransactionClient;

type SnapshotRow = Readonly<{
  activeIndexGenerationId: string | null;
  generationId: string | null;
  generationState: string | null;
  indexMode: "HYBRID" | "LEXICAL_ONLY" | null;
  memoryRevision: number | null;
  ownerStatus: string;
  referenceChatHistory: boolean | null;
}>;

type SearchRow = Readonly<{
  embeddingState: "FAILED" | "NOT_APPLICABLE" | "PENDING" | "READY";
  entryId: string;
  itemType: "RECALL_CHUNK";
  occurredAt: Date;
  safeSnippet: string;
  sourceChatId: string;
  sourceChatTitle: string;
  sourceFolderId: string | null;
  sourceFolderName: string | null;
  sourceMessageIds: string[];
  sourceState: "ARCHIVED" | "AVAILABLE";
}>;

export type MemoryHistorySearchSnapshot = Readonly<{
  activeGenerationId: string | null;
  indexMode: "HYBRID" | "LEXICAL_ONLY" | null;
  lexicalState: MemoryHistorySearchResponse["indexing"]["lexicalState"];
  memoryRevision: number;
  referenceChatHistory: boolean;
}>;

export type PreparedMemoryHistorySearch = Readonly<{
  chatIds: readonly string[];
  filterHash: string;
  folderId: string | null;
  from: Date | null;
  input: MemoryHistorySearchInput;
  normalizedQuery: string;
  offset: number;
  snapshot: MemoryHistorySearchSnapshot;
  to: Date | null;
  userId: string;
}>;

export type MemoryHistoryVectorHit = Readonly<{
  entryId: string;
  score: number;
}>;

export type MemoryHistoryVectorOutcome =
  | Readonly<{
      hits: readonly MemoryHistoryVectorHit[];
      status: "READY";
    }>
  | Readonly<{
      hits: readonly [];
      reason: Exclude<MemoryHistoryDegradationCode, "memory_index_unavailable">;
      status: "DEGRADED";
    }>;

type HistoryCursor = Readonly<{
  filterHash: string;
  kind: "memory-history-search";
  offset: number;
  version: 1;
}>;

export type MemoryHistorySearchRepositoryErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_source_stale";

export class MemoryHistorySearchRepositoryError extends Error {
  constructor(readonly code: MemoryHistorySearchRepositoryErrorCode) {
    super(code);
    this.name = "MemoryHistorySearchRepositoryError";
  }
}

function fail(code: MemoryHistorySearchRepositoryErrorCode): never {
  throw new MemoryHistorySearchRepositoryError(code);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function cursorObject(value: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      return fail("memory_contract_invalid");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return fail("memory_contract_invalid");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MemoryHistorySearchRepositoryError) throw error;
    return fail("memory_contract_invalid");
  }
}

function decodeCursor(value: string, filterHash: string): HistoryCursor {
  const parsed = cursorObject(value);
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "filterHash" || keys[1] !== "kind" ||
    keys[2] !== "offset" || keys[3] !== "version" ||
    parsed.filterHash !== filterHash ||
    parsed.kind !== "memory-history-search" ||
    parsed.version !== 1 ||
    typeof parsed.offset !== "number" ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0 || parsed.offset > HISTORY_SEARCH_OFFSET_MAX
  ) return fail("memory_contract_invalid");
  return parsed as HistoryCursor;
}

function encodeCursor(filterHash: string, offset: number): string {
  const value: HistoryCursor = {
    filterHash,
    kind: "memory-history-search",
    offset,
    version: 1
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function loadSnapshot(
  store: SearchStore,
  userId: string
): Promise<MemoryHistorySearchSnapshot> {
  const rows = await store.$queryRaw<SnapshotRow[]>(Prisma.sql`
    SELECT
      owner."status"::text AS "ownerStatus",
      settings."referenceChatHistory",
      settings."memoryRevision",
      settings."activeIndexGenerationId",
      generation."id" AS "generationId",
      generation."state"::text AS "generationState",
      generation."indexMode"::text AS "indexMode"
    FROM "User" AS owner
    LEFT JOIN "UserMemorySettings" AS settings
      ON settings."userId" = owner."id"
    LEFT JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
    WHERE owner."id" = ${userId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row || row.ownerStatus !== "active") return fail("memory_action_failed");
  const referenceChatHistory = row.referenceChatHistory === true;
  const generationReady = referenceChatHistory &&
    Boolean(row.activeIndexGenerationId) &&
    row.generationId === row.activeIndexGenerationId &&
    row.generationState === "ACTIVE" &&
    (row.indexMode === "LEXICAL_ONLY" || row.indexMode === "HYBRID");
  return {
    activeGenerationId: generationReady ? row.generationId : null,
    indexMode: generationReady ? row.indexMode : null,
    lexicalState: !referenceChatHistory
      ? "DISABLED"
      : generationReady ? "READY" : "UNAVAILABLE",
    memoryRevision: Number.isSafeInteger(row.memoryRevision) && Number(row.memoryRevision) >= 0
      ? Number(row.memoryRevision)
      : 0,
    referenceChatHistory
  };
}

function sameSnapshot(
  left: MemoryHistorySearchSnapshot,
  right: MemoryHistorySearchSnapshot
): boolean {
  return left.activeGenerationId === right.activeGenerationId &&
    left.indexMode === right.indexMode &&
    left.lexicalState === right.lexicalState &&
    left.memoryRevision === right.memoryRevision &&
    left.referenceChatHistory === right.referenceChatHistory;
}

function valuesSql(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

function sourceFilters(
  prepared: PreparedMemoryHistorySearch,
  fields: Readonly<{
    chatId: Prisma.Sql;
    folderId: Prisma.Sql;
    occurredFrom: Prisma.Sql;
    occurredTo: Prisma.Sql;
  }>
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (prepared.chatIds.length > 0) {
    conditions.push(Prisma.sql`${fields.chatId} IN (${valuesSql(prepared.chatIds)})`);
  }
  if (prepared.folderId) {
    conditions.push(Prisma.sql`${fields.folderId} = ${prepared.folderId}`);
  }
  if (prepared.from) {
    conditions.push(Prisma.sql`${fields.occurredTo} >= ${prepared.from}`);
  }
  if (prepared.to) {
    conditions.push(Prisma.sql`${fields.occurredFrom} < ${prepared.to}`);
  }
  return conditions;
}

function vectorHits(outcome: MemoryHistoryVectorOutcome | null): readonly MemoryHistoryVectorHit[] {
  if (!outcome || outcome.status !== "READY") return [];
  if (
    outcome.hits.length > HISTORY_VECTOR_HIT_MAX ||
    new Set(outcome.hits.map((hit) => hit.entryId)).size !== outcome.hits.length ||
    outcome.hits.some((hit) =>
      !validOpaqueId(hit.entryId) || !Number.isFinite(hit.score) ||
      hit.score < -1 || hit.score > 1
    )
  ) return fail("memory_action_failed");
  return outcome.hits;
}

function vectorScoreSql(hits: readonly MemoryHistoryVectorHit[]): Prisma.Sql {
  if (hits.length === 0) return Prisma.sql`NULL::double precision`;
  return Prisma.sql`CASE eligible."entryId"
    ${Prisma.join(hits.map((hit) => Prisma.sql`WHEN ${hit.entryId} THEN ${hit.score}`), " ")}
    ELSE NULL::double precision
  END`;
}

function indexing(
  snapshot: MemoryHistorySearchSnapshot,
  vector: MemoryHistoryVectorOutcome | null
): MemoryHistorySearchResponse["indexing"] {
  if (snapshot.lexicalState === "DISABLED") {
    return { degradationCode: null, lexicalState: "DISABLED", vectorState: "DISABLED" };
  }
  if (snapshot.lexicalState === "UNAVAILABLE") {
    return {
      degradationCode: "memory_index_unavailable",
      lexicalState: "UNAVAILABLE",
      vectorState: "DISABLED"
    };
  }
  if (snapshot.indexMode === "LEXICAL_ONLY") {
    return { degradationCode: null, lexicalState: "READY", vectorState: "NOT_CONFIGURED" };
  }
  if (vector?.status === "READY") {
    return { degradationCode: null, lexicalState: "READY", vectorState: "READY" };
  }
  return {
    degradationCode: vector?.status === "DEGRADED"
      ? vector.reason
      : "memory_vector_unavailable",
    lexicalState: "READY",
    vectorState: "DEGRADED"
  };
}

function itemIndexingState(
  mode: MemoryHistorySearchSnapshot["indexMode"],
  embeddingState: SearchRow["embeddingState"]
): MemoryItemIndexingState {
  if (mode === "LEXICAL_ONLY") return "LEXICAL_READY";
  if (embeddingState === "READY") return "HYBRID_READY";
  if (embeddingState === "PENDING") return "VECTOR_PENDING";
  return "DEGRADED";
}

function resultFromRow(
  row: SearchRow,
  snapshot: MemoryHistorySearchSnapshot
): MemoryHistorySearchResponse["results"][number] {
  if (
    !validOpaqueId(row.entryId) || !validOpaqueId(row.sourceChatId) ||
    typeof row.sourceChatTitle !== "string" || row.sourceChatTitle.trim().length === 0 ||
    row.sourceChatTitle.length > 200 ||
    typeof row.safeSnippet !== "string" || row.safeSnippet.trim().length === 0 ||
    row.safeSnippet.length > 1_000 ||
    !(row.occurredAt instanceof Date) || !Number.isFinite(row.occurredAt.getTime()) ||
    !Array.isArray(row.sourceMessageIds) || row.sourceMessageIds.length < 1 ||
    row.sourceMessageIds.length > 50 ||
    row.sourceMessageIds.some((id) => !validOpaqueId(id)) ||
    new Set(row.sourceMessageIds).size !== row.sourceMessageIds.length ||
    ((row.sourceFolderId === null) !== (row.sourceFolderName === null)) ||
    (row.sourceFolderId !== null && !validOpaqueId(row.sourceFolderId)) ||
    (row.sourceFolderName !== null && (
      row.sourceFolderName.trim().length === 0 || row.sourceFolderName.length > 200
    )) ||
    row.itemType !== "RECALL_CHUNK" ||
    !["AVAILABLE", "ARCHIVED"].includes(row.sourceState)
  ) return fail("memory_action_failed");
  return {
    indexingState: itemIndexingState(snapshot.indexMode, row.embeddingState),
    itemType: row.itemType,
    occurredAt: row.occurredAt.toISOString(),
    sourceChatId: row.sourceChatId,
    sourceChatTitle: row.sourceChatTitle,
    sourceFolderId: row.sourceFolderId,
    sourceFolderName: row.sourceFolderName,
    sourceMessageIds: row.sourceMessageIds,
    sourceState: row.sourceState,
    snippet: row.safeSnippet
  };
}

function searchSql(
  prepared: PreparedMemoryHistorySearch,
  hits: readonly MemoryHistoryVectorHit[]
): Prisma.Sql {
  if (!prepared.snapshot.activeGenerationId) return fail("memory_source_stale");
  const chunkFilters = sourceFilters(prepared, {
    chatId: Prisma.sql`chunk."chatId"`,
    folderId: Prisma.sql`source_folder."id"`,
    occurredFrom: Prisma.sql`chunk."occurredFrom"`,
    occurredTo: Prisma.sql`chunk."occurredTo"`
  });
  const vectorScore = vectorScoreSql(hits);
  const vectorPredicate = hits.length > 0
    ? Prisma.sql`eligible."entryId" IN (${valuesSql(hits.map((hit) => hit.entryId))})`
    : Prisma.sql`FALSE`;
  const pageLimit = prepared.input.pageSize + 1;
  return Prisma.sql`
    WITH eligible AS (
      SELECT
        entry."id" AS "entryId",
        entry."normalizedSearchText",
        entry."searchVectorSimple",
        entry."embeddingState"::text AS "embeddingState",
        'RECALL_CHUNK'::text AS "itemType",
        LEFT(chunk."safeProjectedText", 1000) AS "safeSnippet",
        chunk."occurredTo" AS "occurredAt",
        source_chat."id" AS "sourceChatId",
        LEFT(source_chat."title", 200) AS "sourceChatTitle",
        source_folder."id" AS "sourceFolderId",
        LEFT(source_folder."name", 200) AS "sourceFolderName",
        source_messages."messageIds" AS "sourceMessageIds",
        CASE WHEN source_chat."archived" THEN 'ARCHIVED' ELSE 'AVAILABLE' END AS "sourceState"
      FROM "MemorySearchEntry" AS entry
      INNER JOIN "MemoryIndexGeneration" AS generation
        ON generation."userId" = entry."userId"
        AND generation."id" = entry."indexGenerationId"
        AND generation."id" = ${prepared.snapshot.activeGenerationId}
        AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      INNER JOIN "UserMemorySettings" AS settings
        ON settings."userId" = entry."userId"
        AND settings."referenceChatHistory" = TRUE
        AND settings."activeIndexGenerationId" = generation."id"
      INNER JOIN "MemoryRecallChunk" AS chunk
        ON chunk."userId" = entry."userId"
        AND chunk."id" = entry."recallChunkId"
      INNER JOIN "Chat" AS source_chat
        ON source_chat."userId" = chunk."userId"
        AND source_chat."id" = chunk."chatId"
      LEFT JOIN "Folder" AS source_folder
        ON source_folder."userId" = chunk."userId"
        AND source_folder."id" = chunk."sourceFolderId"
      INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
        ON checkpoint."userId" = chunk."userId"
        AND checkpoint."chatId" = chunk."chatId"
      INNER JOIN LATERAL (
        SELECT array_agg(source_message."messageId" ORDER BY source_message."ordinal")::text[] AS "messageIds"
        FROM "MemoryRecallChunkMessage" AS source_message
        INNER JOIN "Message" AS message
          ON message."chatId" = source_message."chatId"
          AND message."id" = source_message."messageId"
        WHERE source_message."userId" = chunk."userId"
          AND source_message."chatId" = chunk."chatId"
          AND source_message."chunkId" = chunk."id"
        HAVING count(*) BETWEEN 1 AND 50
      ) AS source_messages ON TRUE
      WHERE entry."userId" = ${prepared.userId}
        AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
        AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
        AND chunk."safetyClass" IN (
          'NORMAL'::"MemoryDerivedSafetyClass",
          'SENSITIVE'::"MemoryDerivedSafetyClass"
        )
        AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
        AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND source_chat."memoryBranchGeneration" = chunk."branchGeneration"
        AND source_chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"
        AND checkpoint."branchGeneration" = chunk."branchGeneration"
        AND checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
        AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
        AND checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"
        AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
        AND NOT EXISTS (
          SELECT 1
          FROM "MemorySuppression" AS suppression
          WHERE suppression."userId" = chunk."userId"
            AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
            AND (
              suppression."scope" = 'ALL'::"MemorySuppressionScope"
              OR (
                suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
                AND suppression."sourceChatId" = chunk."chatId"
                AND (
                  suppression."sourceBranchGeneration" IS NULL
                  OR suppression."sourceBranchGeneration" = chunk."branchGeneration"
                )
                AND EXISTS (
                  SELECT 1
                  FROM "MemoryRecallChunkMessage" AS suppressed_message
                  WHERE suppressed_message."userId" = chunk."userId"
                    AND suppressed_message."chunkId" = chunk."id"
                    AND suppressed_message."messageId" = suppression."sourceMessageId"
                )
              )
            )
        )
        AND NOT EXISTS (
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
        )
        AND ${Prisma.join(chunkFilters.length > 0 ? chunkFilters : [Prisma.sql`TRUE`], " AND ")}
    )
    SELECT
      eligible."entryId",
      eligible."embeddingState",
      eligible."itemType",
      eligible."occurredAt",
      eligible."safeSnippet",
      eligible."sourceChatId",
      eligible."sourceChatTitle",
      eligible."sourceFolderId",
      eligible."sourceFolderName",
      eligible."sourceMessageIds",
      eligible."sourceState"
    FROM eligible
    WHERE (
      eligible."normalizedSearchText" = ${prepared.normalizedQuery}
      OR eligible."searchVectorSimple" @@ plainto_tsquery('simple', ${prepared.normalizedQuery})
      OR ${vectorPredicate}
    )
    ORDER BY
      (eligible."normalizedSearchText" = ${prepared.normalizedQuery}) DESC,
      (
        ts_rank_cd(eligible."searchVectorSimple", plainto_tsquery('simple', ${prepared.normalizedQuery}))
          + COALESCE(${vectorScore}, 0)
      ) DESC,
      eligible."occurredAt" DESC,
      eligible."entryId"
    OFFSET ${prepared.offset}
    LIMIT ${pageLimit}
  `;
}

export function createPrismaMemoryHistorySearchRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async prepare(
      userId: string,
      input: MemoryHistorySearchInput
    ): Promise<PreparedMemoryHistorySearch> {
      if (!validOpaqueId(userId)) return fail("memory_contract_invalid");
      const normalizedQuery = normalizeMemorySearchText(input.query);
      if (!normalizedQuery) return fail("memory_contract_invalid");
      const snapshot = await loadSnapshot(client, userId);
      const chatIds = [...input.chatIds].sort();
      const filterHash = memorySha256({
        activeGenerationId: snapshot.activeGenerationId,
        chatIds,
        folderId: input.folderId,
        from: input.from,
        indexMode: snapshot.indexMode,
        lexicalState: snapshot.lexicalState,
        memoryRevision: snapshot.memoryRevision,
        pageSize: input.pageSize,
        query: normalizedQuery,
        referenceChatHistory: snapshot.referenceChatHistory,
        to: input.to,
        userId
      });
      if (input.cursor && snapshot.lexicalState !== "READY") {
        return fail("memory_contract_invalid");
      }
      const cursor = input.cursor ? decodeCursor(input.cursor, filterHash) : null;
      return {
        chatIds,
        filterHash,
        folderId: input.folderId,
        from: input.from ? new Date(input.from) : null,
        input,
        normalizedQuery,
        offset: cursor?.offset ?? 0,
        snapshot,
        to: input.to ? new Date(input.to) : null,
        userId
      };
    },

    async search(
      prepared: PreparedMemoryHistorySearch,
      vector: MemoryHistoryVectorOutcome | null
    ): Promise<MemoryHistorySearchResponse> {
      const indexState = indexing(prepared.snapshot, vector);
      if (prepared.snapshot.lexicalState !== "READY") {
        return { indexing: indexState, nextCursor: null, results: [] };
      }
      const hits = vectorHits(vector);
      return client.$transaction(async (tx) => {
        const current = await loadSnapshot(tx, prepared.userId);
        if (!sameSnapshot(current, prepared.snapshot)) return fail("memory_source_stale");
        const rows = await tx.$queryRaw<SearchRow[]>(searchSql(prepared, hits));
        const page = rows.slice(0, prepared.input.pageSize);
        const nextOffset = prepared.offset + page.length;
        return {
          indexing: indexState,
          nextCursor: rows.length > prepared.input.pageSize &&
            nextOffset <= HISTORY_SEARCH_OFFSET_MAX
            ? encodeCursor(prepared.filterHash, nextOffset)
            : null,
          results: page.map((row) => resultFromRow(row, prepared.snapshot))
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
  });
}

export type MemoryHistorySearchRepository = ReturnType<
  typeof createPrismaMemoryHistorySearchRepository
>;
