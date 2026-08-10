import { Prisma } from "@prisma/client";
import type { MemorySafeProjectionKind } from "../../domain/memory/retrieval";
import {
  memoryActiveSuppressionPredicate,
  memoryAutomaticFactEvidencePredicate,
  memoryChunkSourceSafetyPredicate,
  memoryEpisodeSourceSafetyPredicate,
  memoryFactScopePredicate
} from "../memory/retrieval/localRepository";
import { normalizeMemorySearchTextYo } from "../memory/persistence/lexical";
import {
  MemoryPreparingRunConflictError,
  memoryPreparingHash,
  memoryPreparingItemTarget,
  memoryPreparingTextHash,
  type MemoryPreparingItemInput
} from "./preparingRun";

type PreparingItemTransaction = Prisma.TransactionClient;

export type PreparingMemoryItemAuthority = Readonly<{
  assistantId: string | null;
  chatId: string;
  folderId: string | null;
  indexGenerationId: string | null;
  userId: string;
}>;

export type ResolvedPreparingMemoryItem = Readonly<{
  episodeId: string | null;
  exactItemId: string;
  exactSafeText: string;
  factVersionId: string | null;
  featureSnapshot: Readonly<Record<string, unknown>>;
  finalScore: number;
  itemStateAtAdmission: string;
  itemType: "EPISODE" | "FACT_VERSION" | "RECALL_CHUNK";
  laneRanks: Readonly<Record<string, unknown>>;
  projectionKind: MemorySafeProjectionKind;
  recallChunkId: string | null;
  selectionReason: string;
  sourceBranchGenerationSnapshot: number | null;
  sourceChatIdSnapshot: string | null;
  sourceContentHashSnapshot: string | null;
  sourceMessageIdsSnapshot: readonly string[];
  sourceRevisionSnapshot: number | null;
  sourceSnapshot: Readonly<Record<string, unknown>>;
  textHash: string;
  versionSnapshot: Readonly<Record<string, unknown>>;
}>;

type FactAuthorityRow = Readonly<{
  createdByEventId: string;
  currentVersionId: string | null;
  displayText: string;
  factCanonicalKey: string;
  factCategory: string;
  factId: string;
  factState: string;
  languageCode: string;
  scopeAssistantId: string | null;
  scopeChatId: string | null;
  scopeFolderId: string | null;
  scopeId: string;
  scopeState: string;
  scopeTargetIdSnapshot: string | null;
  scopeType: string;
  sensitivityClass: string;
  sourceMode: string;
  systemFrom: Date;
  systemTo: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  versionState: string;
}>;

type HistoryAuthorityRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  contentHash: string;
  languageCode: string;
  redactionState: string;
  safeText: string;
  safetyClass: string;
  sourceAssistantId: string | null;
  sourceFolderId: string | null;
  sourceRevision: number;
  state: string;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function compactProjection(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function exactTextContainsProjection(exactSafeText: string, projection: string): boolean {
  const compact = compactProjection(projection);
  return compact.length > 0 && (
    exactSafeText === compact || exactSafeText.endsWith(compact)
  );
}

function itemProjection(input: MemoryPreparingItemInput): Readonly<{
  kind: MemorySafeProjectionKind;
  supportingItemId: string | null;
}> {
  const feature = record(input.featureSnapshot);
  const inferredKind: MemorySafeProjectionKind = input.itemType === "EPISODE"
    ? "EPISODE_SAFE_SUMMARY"
    : input.itemType === "RECALL_CHUNK"
      ? "RECALL_CHUNK_SAFE_PROJECTED_TEXT"
      : "FACT_DISPLAY_TEXT";
  const kind = input.projectionKind ?? feature?.projectionKind ?? inferredKind;
  const supportingItemId = input.supportingItemId !== undefined
    ? input.supportingItemId
    : feature?.supportingItemId;
  if (
    kind !== "FACT_DISPLAY_TEXT" &&
    kind !== "EPISODE_SAFE_SUMMARY" &&
    kind !== "RECALL_CHUNK_SAFE_PROJECTED_TEXT"
  ) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  if (supportingItemId !== null && supportingItemId !== undefined &&
    (typeof supportingItemId !== "string" || supportingItemId.length === 0 ||
      supportingItemId.length > 256)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  return { kind, supportingItemId: supportingItemId ?? null };
}

function commonResolved(
  input: MemoryPreparingItemInput,
  projectionKind: MemorySafeProjectionKind
): Pick<
  ResolvedPreparingMemoryItem,
  "exactSafeText" | "featureSnapshot" | "finalScore" | "laneRanks" |
  "projectionKind" | "selectionReason" | "textHash"
> {
  return {
    exactSafeText: input.exactSafeText,
    featureSnapshot: {
      ...(input.featureSnapshot ?? {}),
      finalScore: input.finalScore,
      projectionKind
    },
    finalScore: input.finalScore,
    laneRanks: input.laneRanks ?? {},
    projectionKind,
    selectionReason: input.selectionReason,
    textHash: memoryPreparingTextHash(input.exactSafeText)
  };
}

async function resolveFact(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  querySnapshot: string | null,
  input: MemoryPreparingItemInput & Readonly<{ factVersionId: string }>
): Promise<ResolvedPreparingMemoryItem> {
  if (!authority.indexGenerationId) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const projection = itemProjection(input);
  if (projection.kind !== "FACT_DISPLAY_TEXT" || projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  const normalizedQueryYo = querySnapshot ? normalizeMemorySearchTextYo(querySnapshot) : "";
  const [row] = await tx.$queryRaw<FactAuthorityRow[]>(Prisma.sql`
    SELECT
      version."createdByEventId",
      version."displayText",
      version."languageCode",
      version."sensitivityClass"::text AS "sensitivityClass",
      version."sourceMode"::text AS "sourceMode",
      version."state"::text AS "versionState",
      version."systemFrom", version."systemTo", version."validFrom", version."validTo",
      fact."canonicalKey" AS "factCanonicalKey",
      fact."category" AS "factCategory", fact."currentVersionId",
      fact."id" AS "factId", fact."state"::text AS "factState",
      scope."assistantId" AS "scopeAssistantId", scope."chatId" AS "scopeChatId",
      scope."folderId" AS "scopeFolderId", scope."id" AS "scopeId",
      scope."state"::text AS "scopeState",
      scope."targetIdSnapshot" AS "scopeTargetIdSnapshot",
      scope."scopeType"::text AS "scopeType"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."activeIndexGenerationId" = ${authority.indexGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    LEFT JOIN "MemorySearchEntry" AS entry
      ON entry."userId" = version."userId"
      AND entry."indexGenerationId" = generation."id"
      AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND entry."factVersionId" = version."id"
    WHERE version."userId" = ${authority.userId}
      AND version."id" = ${input.factVersionId}
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."sourceMode" IN (
        'EXPLICIT'::"MemoryFactSourceMode",
        'AUTOMATIC'::"MemoryFactSourceMode"
      )
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND ${memoryFactScopePredicate({
        assistantId: authority.assistantId,
        chatId: authority.chatId,
        folderId: authority.folderId,
        userId: authority.userId
      })}
      AND ${memoryAutomaticFactEvidencePredicate(authority.userId)}
      AND ${memoryActiveSuppressionPredicate(authority.userId)}
      AND (
        (
          version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."systemTo" IS NULL
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" = version."id"
          AND entry."id" IS NOT NULL
        )
        OR (
          version."state" IN (
            'SUPERSEDED'::"MemoryFactVersionState",
            'EXPIRED'::"MemoryFactVersionState",
            'CONFLICTING'::"MemoryFactVersionState"
          )
          AND fact."state" IN (
            'ACTIVE'::"MemoryFactState",
            'CONFLICTED'::"MemoryFactState",
            'EXPIRED'::"MemoryFactState"
          )
          AND (fact."currentVersionId" IS NULL OR fact."currentVersionId" <> version."id")
        )
      )
      AND (
        version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
        OR (
          version."sensitivityClass" = 'SENSITIVE'::"MemorySensitivityClass"
          AND ${normalizedQueryYo} <> ''
          AND replace(version."normalizedSearchText", 'ё', 'е') = ${normalizedQueryYo}
        )
      )
    FOR SHARE OF version, fact, scope, settings, generation
  `);
  if (!row || !exactTextContainsProjection(input.exactSafeText, row.displayText)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const sourceSnapshot = {
    createdByEventId: row.createdByEventId,
    projectedTextHash: memoryPreparingTextHash(compactProjection(row.displayText)),
    projectionKind: projection.kind,
    schemaVersion: 2,
    sourceMode: row.sourceMode
  };
  const versionSnapshot = {
    currentVersionId: row.currentVersionId,
    factCanonicalKey: row.factCanonicalKey,
    factCategory: row.factCategory,
    factId: row.factId,
    factState: row.factState,
    factVersionId: input.factVersionId,
    languageCode: row.languageCode,
    scopeAssistantId: row.scopeAssistantId,
    scopeChatId: row.scopeChatId,
    scopeFolderId: row.scopeFolderId,
    scopeId: row.scopeId,
    scopeState: row.scopeState,
    scopeTargetIdSnapshot: row.scopeTargetIdSnapshot,
    scopeType: row.scopeType,
    schemaVersion: 2,
    sensitivityClass: row.sensitivityClass,
    systemFrom: iso(row.systemFrom),
    systemTo: iso(row.systemTo),
    validFrom: iso(row.validFrom),
    validTo: iso(row.validTo),
    versionState: row.versionState
  };
  return {
    ...commonResolved(input, projection.kind),
    episodeId: null,
    exactItemId: input.factVersionId,
    factVersionId: input.factVersionId,
    itemStateAtAdmission: row.versionState,
    itemType: "FACT_VERSION",
    recallChunkId: null,
    sourceBranchGenerationSnapshot: null,
    sourceChatIdSnapshot: null,
    sourceContentHashSnapshot: null,
    sourceMessageIdsSnapshot: [],
    sourceRevisionSnapshot: null,
    sourceSnapshot,
    versionSnapshot
  };
}

async function resolveChunkRow(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  querySnapshot: string | null,
  chunkId: string
): Promise<HistoryAuthorityRow | null> {
  if (!authority.indexGenerationId) return null;
  const normalizedQueryYo = querySnapshot ? normalizeMemorySearchTextYo(querySnapshot) : "";
  const [row] = await tx.$queryRaw<HistoryAuthorityRow[]>(Prisma.sql`
    SELECT
      chunk."branchGeneration", chunk."chatId", chunk."contentHash",
      chunk."languageCode", chunk."redactionState"::text AS "redactionState",
      chunk."safeProjectedText" AS "safeText",
      chunk."safetyClass"::text AS "safetyClass",
      chunk."sourceAssistantId", chunk."sourceFolderId",
      chunk."sourceRevisionAtCreation" AS "sourceRevision",
      chunk."state"::text AS "state"
    FROM "MemoryRecallChunk" AS chunk
    INNER JOIN "MemorySearchEntry" AS entry
      ON entry."userId" = chunk."userId"
      AND entry."indexGenerationId" = ${authority.indexGenerationId}
      AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND entry."recallChunkId" = chunk."id"
      AND entry."safeContentHash" = chunk."contentHash"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = entry."indexGenerationId"
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = chunk."userId" AND source_chat."id" = chunk."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId" AND checkpoint."chatId" = chunk."chatId"
    WHERE chunk."userId" = ${authority.userId}
      AND chunk."id" = ${chunkId}
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
      AND ${memoryChunkSourceSafetyPredicate()}
      AND (
        chunk."safetyClass" = 'NORMAL'::"MemoryDerivedSafetyClass"
        OR (
          chunk."safetyClass" = 'SENSITIVE'::"MemoryDerivedSafetyClass"
          AND ${normalizedQueryYo} <> ''
          AND entry."safeSearchTextYoNormalized" = ${normalizedQueryYo}
        )
      )
    FOR SHARE OF chunk, entry, settings, generation, source_chat, checkpoint
  `);
  return row ?? null;
}

async function chunkMessageIds(
  tx: PreparingItemTransaction,
  userId: string,
  chunkId: string
): Promise<string[]> {
  const rows = await tx.memoryRecallChunkMessage.findMany({
    orderBy: { ordinal: "asc" },
    select: { messageId: true },
    take: 51,
    where: { chunkId, userId }
  });
  if (rows.length === 0 || rows.length > 50) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  return rows.map(({ messageId }) => messageId);
}

function historySnapshots(
  row: HistoryAuthorityRow,
  projectionKind: MemorySafeProjectionKind,
  sourceMessageIds: readonly string[],
  supportingItemId: string | null
): Readonly<{
  sourceSnapshot: Readonly<Record<string, unknown>>;
  versionSnapshot: Readonly<Record<string, unknown>>;
}> {
  return {
    sourceSnapshot: {
      projectedTextHash: memoryPreparingTextHash(compactProjection(row.safeText)),
      projectionKind,
      schemaVersion: 2,
      sourceAssistantId: row.sourceAssistantId,
      sourceFolderId: row.sourceFolderId,
      sourceMessageIds,
      sourceMode: "HISTORY",
      supportingItemId
    },
    versionSnapshot: {
      languageCode: row.languageCode,
      redactionState: row.redactionState,
      safetyClass: row.safetyClass,
      schemaVersion: 2,
      state: row.state
    }
  };
}

async function resolveChunk(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  querySnapshot: string | null,
  input: MemoryPreparingItemInput & Readonly<{ recallChunkId: string }>
): Promise<ResolvedPreparingMemoryItem> {
  const projection = itemProjection(input);
  if (projection.kind !== "RECALL_CHUNK_SAFE_PROJECTED_TEXT" ||
    projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  const row = await resolveChunkRow(tx, authority, querySnapshot, input.recallChunkId);
  if (!row || !exactTextContainsProjection(input.exactSafeText, row.safeText)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const sourceMessageIds = await chunkMessageIds(tx, authority.userId, input.recallChunkId);
  const snapshots = historySnapshots(row, projection.kind, sourceMessageIds, null);
  return {
    ...commonResolved(input, projection.kind),
    ...snapshots,
    episodeId: null,
    exactItemId: input.recallChunkId,
    factVersionId: null,
    itemStateAtAdmission: row.state,
    itemType: "RECALL_CHUNK",
    recallChunkId: input.recallChunkId,
    sourceBranchGenerationSnapshot: row.branchGeneration,
    sourceChatIdSnapshot: row.chatId,
    sourceContentHashSnapshot: row.contentHash,
    sourceMessageIdsSnapshot: sourceMessageIds,
    sourceRevisionSnapshot: row.sourceRevision
  };
}

async function episodeMessageIds(
  tx: PreparingItemTransaction,
  userId: string,
  episodeId: string
): Promise<string[]> {
  const rows = await tx.memoryEpisodeMessage.findMany({
    orderBy: { ordinal: "asc" },
    select: { messageId: true },
    take: 51,
    where: { episodeId, userId }
  });
  if (rows.length === 0 || rows.length > 50) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  return rows.map(({ messageId }) => messageId);
}

async function resolveEpisodeRow(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  querySnapshot: string | null,
  episodeId: string
): Promise<HistoryAuthorityRow | null> {
  if (!authority.indexGenerationId) return null;
  const normalizedQueryYo = querySnapshot ? normalizeMemorySearchTextYo(querySnapshot) : "";
  const [row] = await tx.$queryRaw<HistoryAuthorityRow[]>(Prisma.sql`
    SELECT
      episode."branchGeneration", episode."chatId", episode."sourceHash" AS "contentHash",
      episode."languageCode", episode."redactionState"::text AS "redactionState",
      episode."safeSummary" AS "safeText", episode."safetyClass"::text AS "safetyClass",
      episode."sourceAssistantId", episode."sourceFolderId",
      episode."sourceRevisionAtCreation" AS "sourceRevision",
      episode."state"::text AS "state"
    FROM "MemoryEpisode" AS episode
    INNER JOIN "MemorySearchEntry" AS entry
      ON entry."userId" = episode."userId"
      AND entry."indexGenerationId" = ${authority.indexGenerationId}
      AND entry."itemType" = 'EPISODE'::"MemorySearchItemType"
      AND entry."episodeId" = episode."id"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = entry."indexGenerationId"
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = episode."userId" AND source_chat."id" = episode."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = episode."userId" AND checkpoint."chatId" = episode."chatId"
    WHERE episode."userId" = ${authority.userId}
      AND episode."id" = ${episodeId}
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
      AND ${memoryEpisodeSourceSafetyPredicate()}
      AND (
        episode."safetyClass" = 'NORMAL'::"MemoryDerivedSafetyClass"
        OR (
          episode."safetyClass" = 'SENSITIVE'::"MemoryDerivedSafetyClass"
          AND ${normalizedQueryYo} <> ''
          AND entry."safeSearchTextYoNormalized" = ${normalizedQueryYo}
        )
      )
    FOR SHARE OF episode, entry, settings, generation, source_chat, checkpoint
  `);
  return row ?? null;
}

async function sourceMessagesOverlap(
  tx: PreparingItemTransaction,
  userId: string,
  episodeId: string,
  chunkId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ matched: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "MemoryEpisodeMessage" AS episode_message
      INNER JOIN "MemoryRecallChunkMessage" AS chunk_message
        ON chunk_message."userId" = episode_message."userId"
        AND chunk_message."chatId" = episode_message."chatId"
        AND chunk_message."messageId" = episode_message."messageId"
      WHERE episode_message."userId" = ${userId}
        AND episode_message."episodeId" = ${episodeId}
        AND chunk_message."chunkId" = ${chunkId}
    ) AS "matched"
  `);
  return rows[0]?.matched === true;
}

async function resolveEpisode(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  querySnapshot: string | null,
  input: MemoryPreparingItemInput & Readonly<{ episodeId: string }>
): Promise<ResolvedPreparingMemoryItem> {
  const projection = itemProjection(input);
  const episode = await resolveEpisodeRow(tx, authority, querySnapshot, input.episodeId);
  if (!episode) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  let projectionRow = episode;
  let sourceMessageIds = await episodeMessageIds(tx, authority.userId, input.episodeId);
  if (projection.kind === "RECALL_CHUNK_SAFE_PROJECTED_TEXT") {
    if (!projection.supportingItemId) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
    }
    const chunk = await resolveChunkRow(
      tx,
      authority,
      querySnapshot,
      projection.supportingItemId
    );
    if (
      !chunk || chunk.chatId !== episode.chatId ||
      chunk.branchGeneration !== episode.branchGeneration ||
      chunk.sourceRevision !== episode.sourceRevision ||
      !await sourceMessagesOverlap(
        tx,
        authority.userId,
        input.episodeId,
        projection.supportingItemId
      )
    ) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
    projectionRow = chunk;
    sourceMessageIds = await chunkMessageIds(
      tx,
      authority.userId,
      projection.supportingItemId
    );
  } else if (projection.kind !== "EPISODE_SAFE_SUMMARY" ||
    projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  if (!exactTextContainsProjection(input.exactSafeText, projectionRow.safeText)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const snapshots = historySnapshots(
    projectionRow,
    projection.kind,
    sourceMessageIds,
    projection.supportingItemId
  );
  return {
    ...commonResolved(input, projection.kind),
    ...snapshots,
    episodeId: input.episodeId,
    exactItemId: input.episodeId,
    factVersionId: null,
    itemStateAtAdmission: episode.state,
    itemType: "EPISODE",
    recallChunkId: null,
    sourceBranchGenerationSnapshot: episode.branchGeneration,
    sourceChatIdSnapshot: episode.chatId,
    sourceContentHashSnapshot: episode.contentHash,
    sourceMessageIdsSnapshot: sourceMessageIds,
    sourceRevisionSnapshot: episode.sourceRevision
  };
}

export async function resolvePreparingMemoryItem(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  querySnapshot: string | null,
  input: MemoryPreparingItemInput
): Promise<ResolvedPreparingMemoryItem> {
  const target = memoryPreparingItemTarget(input);
  if (!target) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  if (target.itemType === "FACT_VERSION" && target.factVersionId) {
    return resolveFact(tx, authority, querySnapshot, {
      ...input,
      factVersionId: target.factVersionId
    });
  }
  if (target.itemType === "EPISODE" && target.episodeId) {
    return resolveEpisode(tx, authority, querySnapshot, {
      ...input,
      episodeId: target.episodeId,
      exactItemId: target.exactItemId,
      itemType: "EPISODE"
    });
  }
  if (target.itemType === "RECALL_CHUNK" && target.recallChunkId) {
    return resolveChunk(tx, authority, querySnapshot, {
      ...input,
      exactItemId: target.exactItemId,
      itemType: "RECALL_CHUNK",
      recallChunkId: target.recallChunkId
    });
  }
  throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
}

export function samePreparingMemoryItemSnapshot(
  left: Readonly<{
    exactSafeText: string;
    featureSnapshot: unknown;
    laneRanks: unknown;
    selectionReason: string;
    sourceSnapshot: unknown;
    textHash: string;
    versionSnapshot: unknown;
  }>,
  right: ResolvedPreparingMemoryItem
): boolean {
  return left.exactSafeText === right.exactSafeText &&
    left.textHash === right.textHash &&
    left.selectionReason === right.selectionReason &&
    memoryPreparingHash(left.featureSnapshot) === memoryPreparingHash(right.featureSnapshot) &&
    memoryPreparingHash(left.laneRanks) === memoryPreparingHash(right.laneRanks) &&
    memoryPreparingHash(left.sourceSnapshot) === memoryPreparingHash(right.sourceSnapshot) &&
    memoryPreparingHash(left.versionSnapshot) === memoryPreparingHash(right.versionSnapshot);
}
