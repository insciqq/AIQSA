import { randomUUID } from "node:crypto";
import {
  Prisma,
  type MemoryEmbeddingState,
  type MemoryIndexMode,
  type MemoryJobState,
  type MemorySearchItemType,
  type PrismaClient
} from "@prisma/client";
import type {
  MemoryRebuildOperation,
  MemoryRebuildStatus
} from "../../../contracts/memory";
import { prisma } from "../../prisma";
import type { MemoryJobClaim } from "../coordinator/types";
import { MemoryCoordinatorError } from "../coordinator/errors";
import {
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryItemEmbeddingJobFingerprint,
  type MemoryItemEmbeddingPin
} from "../embedding/contract";
import {
  MEMORY_EPISODE_REDREAM_JOB_PREFIX,
  MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
  memoryEpisodeRedreamJobFingerprint
} from "../history/episode/contract";
import {
  advanceMemoryMutation,
  ensureActiveLexicalGeneration,
  lockMemorySettings,
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "../persistence/transaction";
import {
  consumeMemoryMutationAuthorization,
  type MemoryMutationAuthorizationUse
} from "../persistence/authorizations";
import { enqueueMemoryJob } from "../persistence/jobs";
import {
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../persistence/lexical";
import {
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "../retrieval/vector";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  memoryVectorSpaceFingerprint,
  resolveCurrentMemoryUtilityPolicy
} from "../execution/policy";
import {
  MEMORY_REDREAM_BATCH_PIPELINE_VERSION,
  MEMORY_SHADOW_REBUILD_PIPELINE_VERSION,
  memoryRedreamBatchJobFingerprint,
  memoryShadowRebuildJobFingerprint,
  memoryShadowRebuildJobPrefixes,
  parseMemoryRebuildJobFingerprint,
  type MemoryShadowRebuildOperation
} from "./contract";

type SearchIdentity = Readonly<{
  itemId: string;
  itemType: MemorySearchItemType;
  languageCode: string;
  safeContentHash: string;
  safeSearchText: string;
  safeSearchTextYoNormalized: string;
  safetyIdentitySnapshot: string;
  sourceIdentitySnapshot: string;
  suppressionIdentitySnapshot: string;
}>;

type ExistingEntry = SearchIdentity & Readonly<{
  embeddingState: MemoryEmbeddingState;
  id: string;
}>;

type FactRow = Readonly<{
  canonicalKey: string;
  category: string;
  displayText: string;
  factId: string;
  languageCode: string;
  sensitivityClass: string;
  sourceMode: string;
  structuredValue: Prisma.JsonValue;
  versionId: string;
}>;

type FactEvidenceRow = Readonly<{
  branchGeneration: number | null;
  factVersionId: string;
  safeSourceHash: string;
  sourceProjectionVersion: string;
  sourceType: string;
}>;

type ChunkRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  contentHash: string;
  id: string;
  languageCode: string;
  redactionReasonCodes: string[];
  redactionState: string;
  safeProjectedText: string;
  safetyClass: string;
  sourceContentHash: string;
  sourceProjectionVersion: string;
  sourceRevisionAtCreation: number;
}>;

type EpisodeRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  id: string;
  languageCode: string;
  redactionReasonCodes: string[];
  redactionState: string;
  safeSummary: string;
  safetyClass: string;
  sourceHash: string;
  sourceProjectionVersion: string;
  sourceRevisionAtCreation: number;
}>;

type MessageJoinRow = Readonly<{
  endOffset: number | null;
  itemId: string;
  messageId: string;
  ordinal: number;
  role: string | null;
  startOffset: number | null;
}>;

type GenerationConfiguration = Readonly<{
  chunkingVersion: string;
  embeddingConfigurationFingerprint: string | null;
  embeddingConnectionId: string | null;
  embeddingDimension: number | null;
  embeddingProviderModelId: string | null;
  id: string;
  indexMode: MemoryIndexMode;
  languageProfile: string;
  normalizationVersion: string;
  retrievalPipelineVersion: string;
  state: string;
  targetMemoryRevision: number;
  vectorSpaceFingerprint: string | null;
}>;

export type MemoryRebuildAdmissionInput = Readonly<{
  authorization?: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>;
  embeddingDeploymentId?: string | null;
  expectedMemoryRevision: number;
  expectedSettingsRevision: number;
  operation: MemoryRebuildOperation;
  pin?: MemoryItemEmbeddingPin | null;
  requestIdentity: unknown;
}>;

export type MemoryRebuildAdmissionResult =
  | Readonly<{ jobId: string; kind: "ok" }>
  | Readonly<{
      kind:
        | "embedding_unavailable"
        | "in_progress"
        | "memory_revision_conflict"
        | "settings_revision_conflict";
    }>;

const nonterminalJobStates: readonly MemoryJobState[] = [
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
];

function itemKey(itemType: MemorySearchItemType, itemId: string): string {
  return `${itemType}:${itemId}`;
}

function exactItemId(entry: Readonly<{
  episodeId: string | null;
  factVersionId: string | null;
  itemType: MemorySearchItemType;
  recallChunkId: string | null;
}>): string | null {
  switch (entry.itemType) {
    case "FACT_VERSION": return entry.factVersionId;
    case "EPISODE": return entry.episodeId;
    case "RECALL_CHUNK": return entry.recallChunkId;
  }
}

function sameIdentity(left: ExistingEntry, right: SearchIdentity): boolean {
  return left.itemId === right.itemId &&
    left.itemType === right.itemType &&
    left.languageCode === right.languageCode &&
    left.safeContentHash === right.safeContentHash &&
    left.safeSearchText === right.safeSearchText &&
    left.safeSearchTextYoNormalized === right.safeSearchTextYoNormalized &&
    left.safetyIdentitySnapshot === right.safetyIdentitySnapshot &&
    left.sourceIdentitySnapshot === right.sourceIdentitySnapshot &&
    left.suppressionIdentitySnapshot === right.suppressionIdentitySnapshot;
}

async function currentSuppressionIdentity(
  tx: MemoryTransaction,
  userId: string,
  now: Date
): Promise<string> {
  const [barriers, suppressions] = await Promise.all([
    tx.memorySourceBarrier.findMany({
      orderBy: [{ sourceCreatedAtCutoff: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        memoryGeneration: true,
        sourceCreatedAtCutoff: true
      },
      where: { userId }
    }),
    tx.memorySuppression.findMany({
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

async function eligibleFacts(
  tx: MemoryTransaction,
  settings: LockedMemorySettings
): Promise<readonly SearchIdentity[]> {
  if (!settings.useMemoryFacts) return [];
  const rows = await tx.$queryRaw<FactRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId", fact."canonicalKey", fact."category",
      version."id" AS "versionId", version."displayText",
      version."structuredValue", version."languageCode",
      version."sensitivityClass"::text AS "sensitivityClass",
      version."sourceMode"::text AS "sourceMode"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."factId" = fact."id"
      AND version."id" = fact."currentVersionId"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
    WHERE fact."userId" = ${settings.userId}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
    ORDER BY version."id"
  `);
  if (rows.length === 0) return [];
  const evidence = await tx.memoryEvidence.findMany({
    orderBy: [{ factVersionId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      branchGeneration: true,
      factVersionId: true,
      safeSourceHash: true,
      sourceProjectionVersion: true,
      sourceType: true
    },
    where: { factVersionId: { in: rows.map(({ versionId }) => versionId) }, userId: settings.userId }
  }) as readonly FactEvidenceRow[];
  return rows.flatMap((row) => {
    const safeSearchText = normalizeMemorySearchText(row.displayText);
    if (!safeSearchText) return [];
    const sources = evidence
      .filter(({ factVersionId }) => factVersionId === row.versionId)
      .map((item) => ({
        branchGeneration: item.branchGeneration,
        safeSourceHash: item.safeSourceHash,
        sourceProjectionVersion: item.sourceProjectionVersion,
        sourceType: item.sourceType
      }));
    return [{
      itemId: row.versionId,
      itemType: "FACT_VERSION" as const,
      languageCode: row.languageCode,
      safeContentHash: memorySha256({
        displayText: row.displayText,
        structuredValue: row.structuredValue
      }),
      safeSearchText,
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(row.displayText),
      safetyIdentitySnapshot: memorySha256({
        sensitivityClass: row.sensitivityClass,
        sources
      }),
      sourceIdentitySnapshot: memorySha256({
        factId: row.factId,
        sourceMode: row.sourceMode,
        sources,
        versionId: row.versionId
      }),
      suppressionIdentitySnapshot: memorySha256({
        canonicalKey: row.canonicalKey,
        category: row.category,
        normalizedValue: safeSearchText
      })
    }];
  });
}

async function eligibleChunks(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  suppressionIdentitySnapshot: string
): Promise<readonly SearchIdentity[]> {
  if (!settings.referenceChatHistory) return [];
  const rows = await tx.$queryRaw<ChunkRow[]>(Prisma.sql`
    SELECT
      chunk."id", chunk."chatId", chunk."branchGeneration",
      chunk."sourceRevisionAtCreation", chunk."contentHash",
      chunk."safeProjectedText", chunk."languageCode", chunk."safetyClass"::text AS "safetyClass",
      chunk."redactionState"::text AS "redactionState", chunk."redactionReasonCodes",
      chunk."sourceProjectionVersion", checkpoint."sourceContentHash"
    FROM "MemoryRecallChunk" AS chunk
    INNER JOIN "Chat" AS chat
      ON chat."userId" = chunk."userId" AND chat."id" = chunk."chatId"
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."memoryBranchGeneration" = chunk."branchGeneration"
      AND chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId" AND checkpoint."chatId" = chunk."chatId"
      AND checkpoint."branchGeneration" = chunk."branchGeneration"
      AND checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
      AND checkpoint."activeLeafMessageId" = chat."activeLeafMessageId"
      AND checkpoint."lastIndexedMessageId" = chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
    WHERE chunk."userId" = ${settings.userId}
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySuppression" AS suppression
        LEFT JOIN "MemoryRecallChunkMessage" AS source_message
          ON source_message."userId" = chunk."userId"
          AND source_message."chunkId" = chunk."id"
          AND suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
          AND suppression."sourceChatId" = source_message."chatId"
          AND suppression."sourceMessageId" = source_message."messageId"
        WHERE suppression."userId" = chunk."userId"
          AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
          AND (
            suppression."scope" = 'ALL'::"MemorySuppressionScope"
            OR (
              source_message."messageId" IS NOT NULL
              AND (
                suppression."sourceBranchGeneration" IS NULL
                OR suppression."sourceBranchGeneration" = chunk."branchGeneration"
              )
            )
          )
      )
    ORDER BY chunk."id"
  `);
  if (rows.length === 0) return [];
  const joins = await tx.$queryRaw<MessageJoinRow[]>(Prisma.sql`
    SELECT
      join_row."chunkId" AS "itemId", join_row."messageId", join_row."ordinal",
      join_row."role", join_row."startOffset", join_row."endOffset"
    FROM "MemoryRecallChunkMessage" AS join_row
    WHERE join_row."userId" = ${settings.userId}
      AND join_row."chunkId" IN (${Prisma.join(rows.map(({ id }) => id))})
    ORDER BY join_row."chunkId", join_row."ordinal"
  `);
  return rows.map((row) => {
    const messageJoins = joins.filter(({ itemId }) => itemId === row.id).map((join) => ({
      endOffset: join.endOffset,
      messageId: join.messageId,
      ordinal: join.ordinal,
      role: join.role,
      startOffset: join.startOffset
    }));
    return {
      itemId: row.id,
      itemType: "RECALL_CHUNK" as const,
      languageCode: row.languageCode,
      safeContentHash: row.contentHash,
      safeSearchText: normalizeMemorySearchText(row.safeProjectedText),
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(row.safeProjectedText),
      safetyIdentitySnapshot: memorySha256({
        policyVersion: row.sourceProjectionVersion,
        redactionReasonCodes: row.redactionReasonCodes,
        redactionState: row.redactionState,
        safetyClass: row.safetyClass
      }),
      sourceIdentitySnapshot: memorySha256({
        branchGeneration: row.branchGeneration,
        chatId: row.chatId,
        contentHash: row.contentHash,
        messageJoins,
        sourceHash: row.sourceContentHash,
        sourceRevision: row.sourceRevisionAtCreation,
        userId: settings.userId
      }),
      suppressionIdentitySnapshot
    };
  }).filter(({ safeSearchText }) => safeSearchText.length > 0);
}

async function eligibleEpisodes(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  suppressionIdentitySnapshot: string
): Promise<readonly SearchIdentity[]> {
  if (!settings.referenceChatHistory) return [];
  const rows = await tx.$queryRaw<EpisodeRow[]>(Prisma.sql`
    SELECT
      episode."id", episode."chatId", episode."branchGeneration",
      episode."sourceRevisionAtCreation", episode."safeSummary", episode."languageCode",
      episode."safetyClass"::text AS "safetyClass",
      episode."redactionState"::text AS "redactionState", episode."redactionReasonCodes",
      episode."sourceHash", episode."sourceProjectionVersion"
    FROM "MemoryEpisode" AS episode
    INNER JOIN "Chat" AS chat
      ON chat."userId" = episode."userId" AND chat."id" = episode."chatId"
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."memoryBranchGeneration" = episode."branchGeneration"
      AND chat."memorySourceRevision" = episode."sourceRevisionAtCreation"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = episode."userId" AND checkpoint."chatId" = episode."chatId"
      AND checkpoint."branchGeneration" = episode."branchGeneration"
      AND checkpoint."sourceRevision" = episode."sourceRevisionAtCreation"
      AND checkpoint."sourceContentHash" = episode."sourceHash"
      AND checkpoint."activeLeafMessageId" = chat."activeLeafMessageId"
      AND checkpoint."lastDreamedMessageId" = chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
    WHERE episode."userId" = ${settings.userId}
      AND episode."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND episode."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND episode."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySuppression" AS suppression
        LEFT JOIN "MemoryEpisodeMessage" AS source_message
          ON source_message."userId" = episode."userId"
          AND source_message."episodeId" = episode."id"
          AND suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
          AND suppression."sourceChatId" = source_message."chatId"
          AND suppression."sourceMessageId" = source_message."messageId"
        WHERE suppression."userId" = episode."userId"
          AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
          AND (
            suppression."scope" = 'ALL'::"MemorySuppressionScope"
            OR (
              suppression."scope" = 'SOURCE_EPISODE'::"MemorySuppressionScope"
              AND suppression."sourceEpisodeId" = episode."id"
            )
            OR (
              source_message."messageId" IS NOT NULL
              AND (
                suppression."sourceBranchGeneration" IS NULL
                OR suppression."sourceBranchGeneration" = episode."branchGeneration"
              )
            )
          )
      )
    ORDER BY episode."id"
  `);
  if (rows.length === 0) return [];
  const joins = await tx.$queryRaw<MessageJoinRow[]>(Prisma.sql`
    SELECT
      join_row."episodeId" AS "itemId", join_row."messageId", join_row."ordinal",
      NULL::varchar AS "role", NULL::integer AS "startOffset", NULL::integer AS "endOffset"
    FROM "MemoryEpisodeMessage" AS join_row
    WHERE join_row."userId" = ${settings.userId}
      AND join_row."episodeId" IN (${Prisma.join(rows.map(({ id }) => id))})
    ORDER BY join_row."episodeId", join_row."ordinal"
  `);
  return rows.map((row) => {
    const messageIds = joins
      .filter(({ itemId }) => itemId === row.id)
      .map(({ messageId }) => messageId);
    return {
      itemId: row.id,
      itemType: "EPISODE" as const,
      languageCode: row.languageCode,
      safeContentHash: memorySha256(row.safeSummary),
      safeSearchText: normalizeMemorySearchText(row.safeSummary),
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(row.safeSummary),
      safetyIdentitySnapshot: memorySha256({
        redactionReasonCodes: row.redactionReasonCodes,
        redactionState: row.redactionState,
        safetyClass: row.safetyClass,
        sourceProjectionVersion: row.sourceProjectionVersion
      }),
      sourceIdentitySnapshot: memorySha256({
        branchGeneration: row.branchGeneration,
        chatId: row.chatId,
        messageIds,
        sourceHash: row.sourceHash,
        sourceRevision: row.sourceRevisionAtCreation,
        userId: settings.userId
      }),
      suppressionIdentitySnapshot
    };
  }).filter(({ safeSearchText }) => safeSearchText.length > 0);
}

async function enumerateEligibleItems(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  now: Date
): Promise<readonly SearchIdentity[]> {
  const suppressionIdentity = await currentSuppressionIdentity(tx, settings.userId, now);
  const [facts, chunks, episodes] = await Promise.all([
    eligibleFacts(tx, settings),
    eligibleChunks(tx, settings, suppressionIdentity),
    eligibleEpisodes(tx, settings, suppressionIdentity)
  ]);
  return [...facts, ...chunks, ...episodes].sort((left, right) =>
    left.itemType.localeCompare(right.itemType) || left.itemId.localeCompare(right.itemId));
}

async function existingGenerationEntries(
  tx: MemoryTransaction,
  userId: string,
  generationId: string
): Promise<readonly ExistingEntry[]> {
  const rows = await tx.memorySearchEntry.findMany({
    orderBy: { id: "asc" },
    select: {
      embeddingState: true,
      episodeId: true,
      factVersionId: true,
      id: true,
      itemType: true,
      languageCode: true,
      recallChunkId: true,
      safeContentHash: true,
      safeSearchText: true,
      safeSearchTextYoNormalized: true,
      safetyIdentitySnapshot: true,
      sourceIdentitySnapshot: true,
      suppressionIdentitySnapshot: true
    },
    where: { indexGenerationId: generationId, userId }
  });
  return rows.flatMap((row) => {
    const itemId = exactItemId(row);
    return itemId ? [{ ...row, itemId }] : [];
  });
}

function targetData(item: SearchIdentity, userId: string, generationId: string) {
  return {
    ...(item.itemType === "FACT_VERSION" ? { factVersionId: item.itemId } : {}),
    ...(item.itemType === "EPISODE" ? { episodeId: item.itemId } : {}),
    ...(item.itemType === "RECALL_CHUNK" ? { recallChunkId: item.itemId } : {}),
    indexGenerationId: generationId,
    itemType: item.itemType,
    languageCode: item.languageCode,
    safeContentHash: item.safeContentHash,
    safeSearchText: item.safeSearchText,
    safeSearchTextYoNormalized: item.safeSearchTextYoNormalized,
    safetyIdentitySnapshot: item.safetyIdentitySnapshot,
    sourceIdentitySnapshot: item.sourceIdentitySnapshot,
    suppressionIdentitySnapshot: item.suppressionIdentitySnapshot,
    userId
  } as const;
}

async function applyFullSetDiff(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  generation: GenerationConfiguration,
  items: readonly SearchIdentity[],
  now: Date
): Promise<Readonly<{
  complete: boolean;
  failed: boolean;
  fullSetHash: string;
}>> {
  const existing = await existingGenerationEntries(tx, settings.userId, generation.id);
  const expectedByKey = new Map(items.map((item) => [itemKey(item.itemType, item.itemId), item]));
  const retainedKeys = new Set<string>();
  const deleteIds: string[] = [];
  for (const entry of existing) {
    const key = itemKey(entry.itemType, entry.itemId);
    const expected = expectedByKey.get(key);
    const compatible = expected !== undefined && sameIdentity(entry, expected) &&
      !(
        generation.indexMode === "LEXICAL_ONLY" &&
        entry.embeddingState !== "NOT_APPLICABLE"
      ) && !(
        generation.indexMode === "HYBRID" &&
        entry.embeddingState === "NOT_APPLICABLE"
      );
    if (!compatible || retainedKeys.has(key)) {
      deleteIds.push(entry.id);
      continue;
    }
    retainedKeys.add(key);
  }
  if (deleteIds.length > 0) {
    await tx.memorySearchEntry.deleteMany({
      where: { id: { in: deleteIds }, userId: settings.userId }
    });
  }
  for (const item of items) {
    if (retainedKeys.has(itemKey(item.itemType, item.itemId))) continue;
    await tx.memorySearchEntry.create({
      data: {
        ...targetData(item, settings.userId, generation.id),
        embeddingState: generation.indexMode === "LEXICAL_ONLY"
          ? "NOT_APPLICABLE"
          : "PENDING",
        id: randomUUID()
      }
    });
  }

  const fullSetHash = memorySha256(items.map((item) => ({
    itemId: item.itemId,
    itemType: item.itemType,
    safeContentHash: item.safeContentHash,
    safetyIdentitySnapshot: item.safetyIdentitySnapshot,
    sourceIdentitySnapshot: item.sourceIdentitySnapshot,
    suppressionIdentitySnapshot: item.suppressionIdentitySnapshot
  })));
  if (generation.indexMode === "LEXICAL_ONLY") {
    return { complete: true, failed: false, fullSetHash };
  }

  const pending = await tx.memorySearchEntry.findMany({
    orderBy: { id: "asc" },
    select: { embeddingState: true, id: true, safeContentHash: true },
    where: { indexGenerationId: generation.id, userId: settings.userId }
  });
  let failed = false;
  for (const entry of pending) {
    if (entry.embeddingState === "READY") continue;
    const queued = await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
        entry.id,
        memorySha256({
          generationId: generation.id,
          safeContentHash: entry.safeContentHash,
          version: "memory-shadow-entry-v1"
        })
      ),
      kind: "EMBED_ITEMS",
      pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
    });
    if (["CANCELLED", "STALE", "TERMINAL_FAILED"].includes(queued.state)) {
      failed = true;
    }
  }
  return {
    complete: pending.every(({ embeddingState }) => embeddingState === "READY"),
    failed,
    fullSetHash
  };
}

function generationConfigurationMatches(
  source: GenerationConfiguration,
  target: GenerationConfiguration,
  operation: MemoryShadowRebuildOperation,
  settings: LockedMemorySettings
): boolean {
  const common = source.id === target.id ? false :
    source.languageProfile === target.languageProfile &&
    source.normalizationVersion === target.normalizationVersion &&
    source.chunkingVersion === target.chunkingVersion;
  if (!common) return false;
  if (operation === "REEMBED") {
    return target.indexMode === "HYBRID" &&
      target.retrievalPipelineVersion === MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION &&
      target.embeddingProviderModelId === settings.embeddingProviderModelId;
  }
  return source.indexMode === target.indexMode &&
    source.embeddingConnectionId === target.embeddingConnectionId &&
    source.embeddingProviderModelId === target.embeddingProviderModelId &&
    source.embeddingConfigurationFingerprint === target.embeddingConfigurationFingerprint &&
    source.embeddingDimension === target.embeddingDimension &&
    source.vectorSpaceFingerprint === target.vectorSpaceFingerprint &&
    source.retrievalPipelineVersion === target.retrievalPipelineVersion;
}

async function targetEmbeddingConfigurationIsCurrent(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  target: GenerationConfiguration
): Promise<boolean> {
  if (target.indexMode === "LEXICAL_ONLY") {
    return target.embeddingConnectionId === null &&
      target.embeddingProviderModelId === null &&
      target.embeddingConfigurationFingerprint === null &&
      target.embeddingDimension === null &&
      target.vectorSpaceFingerprint === null;
  }
  const current = await currentEmbeddingPin(tx, settings);
  return current !== null &&
    target.embeddingConnectionId === current.connectionId &&
    target.embeddingProviderModelId === current.providerModelId &&
    target.embeddingConfigurationFingerprint === current.configurationFingerprint &&
    target.embeddingDimension === current.dimension &&
    target.vectorSpaceFingerprint === current.vectorSpaceFingerprint;
}

async function currentEmbeddingPin(
  tx: MemoryTransaction,
  settings: LockedMemorySettings
): Promise<MemoryItemEmbeddingPin | null> {
  const policy = await resolveCurrentMemoryUtilityPolicy(
    tx,
    settings.userId,
    settings
  );
  const current = policy.targets.get("MEMORY_DOCUMENT_EMBED");
  const model = current?.snapshot.model;
  if (
    !current ||
    !settings.acceptedUtilityEgressAt ||
    settings.acceptedUtilityPolicyVersion !== MEMORY_UTILITY_EGRESS_POLICY_VERSION ||
    settings.acceptedUtilityEgressFingerprint !== policy.fingerprint ||
    model?.adapterKind !== "openai_embeddings_compatible" ||
    model.modelClass !== "embedding" ||
    !model.embedding
  ) {
    return null;
  }
  const vectorSpaceFingerprint = memoryVectorSpaceFingerprint(current);
  return vectorSpaceFingerprint
    ? {
        configurationFingerprint:
          current.qualificationFingerprints.configFingerprint,
        connectionId: current.authority.connectionId,
        dimension: model.embedding.targetDimension,
        providerModelId: current.authority.providerModelId,
        vectorSpaceFingerprint
      }
    : null;
}

function sameEmbeddingPin(
  left: MemoryItemEmbeddingPin,
  right: MemoryItemEmbeddingPin
): boolean {
  return left.configurationFingerprint === right.configurationFingerprint &&
    left.connectionId === right.connectionId &&
    left.dimension === right.dimension &&
    left.providerModelId === right.providerModelId &&
    left.vectorSpaceFingerprint === right.vectorSpaceFingerprint;
}

async function purgeRetainedSupersededSearch(
  tx: MemoryTransaction,
  userId: string
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MemorySearchEntry" AS entry
    USING "MemoryIndexGeneration" AS generation
    WHERE entry."userId" = ${userId}
      AND generation."userId" = entry."userId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'SUPERSEDED'::"MemoryIndexGenerationState"
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryRetrievalAttempt" AS attempt
        WHERE attempt."userId" = generation."userId"
          AND attempt."indexGenerationIdSnapshot" = generation."id"
          AND attempt."state" IN (
            'PENDING'::"MemoryRetrievalAttemptState",
            'EXECUTING'::"MemoryRetrievalAttemptState",
            'READY'::"MemoryRetrievalAttemptState"
          )
      )
  `);
}

async function failShadowGeneration(
  tx: MemoryTransaction,
  userId: string,
  generationId: string
): Promise<void> {
  await tx.memoryIndexGeneration.updateMany({
    data: { state: "FAILED" },
    where: {
      id: generationId,
      state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
      userId
    }
  });
  await tx.memorySearchEntry.deleteMany({
    where: { indexGenerationId: generationId, userId }
  });
}

async function applyShadowCatchUp(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  now: Date
): Promise<void> {
  const identity = parseMemoryRebuildJobFingerprint(claim.idempotencyFingerprint);
  if (!identity || identity.type !== "SHADOW") {
    throw new Error("memory_rebuild_job_invalid");
  }
  const settings = await lockMemorySettings(tx, claim.userId, true);
  const target = await tx.memoryIndexGeneration.findFirst({
    where: { id: identity.generationId, userId: claim.userId }
  });
  if (!target) throw new Error("memory_rebuild_generation_missing");
  if (target.state === "ACTIVE" || target.state === "SUPERSEDED") return;
  if (["CANCELLED", "FAILED"].includes(target.state)) return;
  const sourceId = target.sourceIndexGenerationId;
  if (!sourceId || sourceId !== settings.activeIndexGenerationId) {
    await failShadowGeneration(tx, claim.userId, target.id);
    return;
  }
  const source = await tx.memoryIndexGeneration.findFirst({
    where: { id: sourceId, state: "ACTIVE", userId: claim.userId }
  });
  if (
    !source ||
    target.targetMemoryRevision !== claim.memoryRevisionSnapshot ||
    !generationConfigurationMatches(source, target, identity.operation, settings)
  ) {
    await failShadowGeneration(tx, claim.userId, target.id);
    return;
  }
  if (target.state === "BUILDING" || target.state === "READY") {
    await tx.memoryIndexGeneration.update({
      data: { readyAt: null, state: "CATCHING_UP" },
      where: { id: target.id }
    });
  }
  const revision = settings.memoryRevision;
  const items = await enumerateEligibleItems(tx, settings, now);
  const diff = await applyFullSetDiff(tx, settings, target, items, now);
  const reread = await tx.userMemorySettings.findUnique({
    select: { memoryRevision: true },
    where: { userId: claim.userId }
  });
  if (reread?.memoryRevision !== revision) {
    throw new Error("memory_rebuild_revision_proof_failed");
  }
  await tx.memoryIndexGeneration.update({
    data: {
      indexedThroughMemoryRevision: revision,
      state: "CATCHING_UP"
    },
    where: { id: target.id }
  });
  if (diff.failed) {
    await failShadowGeneration(tx, claim.userId, target.id);
    return;
  }
  if (!diff.complete) return;
  if (!(await targetEmbeddingConfigurationIsCurrent(tx, settings, target))) {
    await failShadowGeneration(tx, claim.userId, target.id);
    return;
  }

  await tx.memoryIndexGeneration.update({
    data: { readyAt: now, state: "READY" },
    where: { id: target.id }
  });
  await advanceMemoryMutation(tx, settings, "INDEX_GENERATION_ACTIVATION");
  const superseded = await tx.memoryIndexGeneration.updateMany({
    data: { state: "SUPERSEDED", supersededAt: now },
    where: { id: source.id, state: "ACTIVE", userId: claim.userId }
  });
  const activated = await tx.memoryIndexGeneration.updateMany({
    data: {
      activatedAt: now,
      indexedThroughMemoryRevision: settings.memoryRevision,
      state: "ACTIVE"
    },
    where: { id: target.id, state: "READY", userId: claim.userId }
  });
  const selected = await tx.userMemorySettings.updateMany({
    data: { activeIndexGenerationId: target.id },
    where: {
      activeIndexGenerationId: source.id,
      memoryGeneration: settings.memoryGeneration,
      memoryRevision: settings.memoryRevision,
      userId: claim.userId
    }
  });
  if (superseded.count !== 1 || activated.count !== 1 || selected.count !== 1) {
    throw new Error("memory_rebuild_activation_fence_failed");
  }
  settings.activeIndexGenerationId = target.id;
  await purgeRetainedSupersededSearch(tx, claim.userId);
}

async function applyRedreamBatch(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  now: Date
): Promise<void> {
  const identity = parseMemoryRebuildJobFingerprint(claim.idempotencyFingerprint);
  if (!identity || identity.type !== "REDREAM") {
    throw new Error("memory_redream_job_invalid");
  }
  const settings = await lockMemorySettings(tx, claim.userId, true);
  if (settings.memoryGeneration !== claim.memoryGenerationSnapshot) {
    throw new MemoryCoordinatorError("memory_source_stale", false);
  }
  if (!settings.referenceChatHistory) return;
  const sources = await tx.$queryRaw<Array<{
    activeLeafMessageId: string;
    branchGeneration: number;
    chatId: string;
    sourceHash: string;
    sourceRevision: number;
  }>>(Prisma.sql`
    SELECT
      checkpoint."activeLeafMessageId", checkpoint."branchGeneration",
      checkpoint."chatId", checkpoint."sourceContentHash" AS "sourceHash",
      checkpoint."sourceRevision"
    FROM "ChatMemoryCheckpoint" AS checkpoint
    INNER JOIN "Chat" AS chat
      ON chat."userId" = checkpoint."userId" AND chat."id" = checkpoint."chatId"
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."activeLeafMessageId" = checkpoint."activeLeafMessageId"
      AND chat."memoryBranchGeneration" = checkpoint."branchGeneration"
      AND chat."memorySourceRevision" = checkpoint."sourceRevision"
    WHERE checkpoint."userId" = ${claim.userId}
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."lastIndexedMessageId" = checkpoint."activeLeafMessageId"
      AND EXISTS (
        SELECT 1 FROM "MemoryRecallChunk" AS chunk
        WHERE chunk."userId" = checkpoint."userId"
          AND chunk."chatId" = checkpoint."chatId"
          AND chunk."branchGeneration" = checkpoint."branchGeneration"
          AND chunk."sourceRevisionAtCreation" = checkpoint."sourceRevision"
          AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "MemorySuppression" AS suppression
        WHERE suppression."userId" = checkpoint."userId"
          AND (
            suppression."expiresAt" IS NULL
            OR suppression."expiresAt" > CURRENT_TIMESTAMP
          )
          AND (
            suppression."scope" = 'ALL'::"MemorySuppressionScope"
            OR (
              suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
              AND suppression."sourceChatId" = checkpoint."chatId"
              AND (
                suppression."sourceBranchGeneration" IS NULL
                OR suppression."sourceBranchGeneration" = checkpoint."branchGeneration"
              )
              AND EXISTS (
                SELECT 1
                FROM "MemoryRecallChunk" AS chunk
                INNER JOIN "MemoryRecallChunkMessage" AS source_message
                  ON source_message."userId" = chunk."userId"
                  AND source_message."chunkId" = chunk."id"
                WHERE chunk."userId" = checkpoint."userId"
                  AND chunk."chatId" = checkpoint."chatId"
                  AND chunk."branchGeneration" = checkpoint."branchGeneration"
                  AND chunk."sourceRevisionAtCreation" = checkpoint."sourceRevision"
                  AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
                  AND source_message."messageId" = suppression."sourceMessageId"
              )
            )
            OR (
              suppression."scope" = 'SOURCE_EPISODE'::"MemorySuppressionScope"
              AND EXISTS (
                SELECT 1
                FROM "MemoryEpisode" AS episode
                WHERE episode."userId" = checkpoint."userId"
                  AND episode."id" = suppression."sourceEpisodeId"
                  AND episode."chatId" = checkpoint."chatId"
                  AND episode."branchGeneration" = checkpoint."branchGeneration"
                  AND episode."sourceRevisionAtCreation" = checkpoint."sourceRevision"
              )
            )
          )
      )
    ORDER BY checkpoint."chatId"
  `);
  for (const source of sources) {
    await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryEpisodeRedreamJobFingerprint(identity.batchId, {
        ...source,
        userId: claim.userId
      }),
      kind: "EXTRACT_EPISODE",
      pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
      source
    });
  }
  void now;
}

function configurationData(
  source: GenerationConfiguration,
  operation: MemoryShadowRebuildOperation,
  pin: MemoryItemEmbeddingPin | null
) {
  if (operation === "REBUILD_SEARCH_INDEX") {
    return {
      chunkingVersion: source.chunkingVersion,
      embeddingConfigurationFingerprint: source.embeddingConfigurationFingerprint,
      embeddingConnectionId: source.embeddingConnectionId,
      embeddingDimension: source.embeddingDimension,
      embeddingProviderModelId: source.embeddingProviderModelId,
      indexMode: source.indexMode,
      languageProfile: source.languageProfile,
      normalizationVersion: source.normalizationVersion,
      retrievalPipelineVersion: source.retrievalPipelineVersion,
      vectorSpaceFingerprint: source.vectorSpaceFingerprint
    } as const;
  }
  if (!pin) throw new Error("memory_rebuild_embedding_pin_missing");
  return {
    chunkingVersion: source.chunkingVersion,
    embeddingConfigurationFingerprint: pin.configurationFingerprint,
    embeddingConnectionId: pin.connectionId,
    embeddingDimension: pin.dimension,
    embeddingProviderModelId: pin.providerModelId,
    indexMode: "HYBRID" as const,
    languageProfile: source.languageProfile,
    normalizationVersion: source.normalizationVersion,
    retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
    vectorSpaceFingerprint: pin.vectorSpaceFingerprint
  };
}

function statusStateForJob(state: MemoryJobState): MemoryRebuildStatus["state"] {
  switch (state) {
    case "QUEUED":
    case "RETRYABLE_FAILED": return "QUEUED";
    case "CLAIMED": return "RUNNING";
    case "WAITING_FOR_EGRESS_CONSENT": return "WAITING_FOR_EGRESS_CONSENT";
    case "SUCCEEDED": return "SUCCEEDED";
    case "TERMINAL_FAILED": return "FAILED";
    case "STALE": return "STALE";
    case "CANCELLED": return "CANCELLED";
  }
}

function publicFailureCode(errorCode: string | null): MemoryRebuildStatus["errorCode"] {
  if (errorCode?.includes("embedding") || errorCode?.includes("egress")) {
    return "memory_embedding_unavailable";
  }
  if (errorCode?.includes("source")) return "memory_source_stale";
  return "memory_action_failed";
}

export function createPrismaMemoryRebuildRepository(
  client: PrismaClient = prisma
) {
  async function status(userId: string, jobId: string): Promise<MemoryRebuildStatus | null> {
    const job = await client.memoryJob.findFirst({
      where: { id: jobId, kind: "REBUILD_INDEX", userId }
    });
    if (!job) return null;
    const identity = parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint);
    if (!identity) return null;
    if (identity.type === "REDREAM") {
      const children = await client.memoryJob.findMany({
        select: { errorCode: true, state: true, updatedAt: true },
        where: {
          idempotencyFingerprint: { startsWith: `memory-episode-redream-v1:${identity.batchId}:` },
          kind: "EXTRACT_EPISODE",
          userId
        }
      });
      const failed = children.find(({ state }) => state === "TERMINAL_FAILED");
      const cancelled = children.some(({ state }) => state === "CANCELLED");
      const stale = children.some(({ state }) => state === "STALE");
      const waiting = children.some(({ state }) => state === "WAITING_FOR_EGRESS_CONSENT");
      const active = children.some(({ state }) => nonterminalJobStates.includes(state));
      const complete = children.filter(({ state }) => state === "SUCCEEDED").length;
      let state = statusStateForJob(job.state);
      let errorCode: MemoryRebuildStatus["errorCode"] = null;
      if (job.state === "SUCCEEDED") {
        if (active) {
          state = waiting ? "WAITING_FOR_EGRESS_CONSENT" : "RUNNING";
        } else if (failed) {
          state = "FAILED";
          errorCode = publicFailureCode(failed.errorCode);
        } else if (cancelled) state = "CANCELLED";
        else if (stale) state = "STALE";
        else if (complete === children.length) state = "SUCCEEDED";
        else state = "RUNNING";
      } else if (state === "FAILED") {
        errorCode = publicFailureCode(job.errorCode);
      }
      const updatedAt = children.reduce(
        (latest, child) => child.updatedAt > latest ? child.updatedAt : latest,
        job.updatedAt
      );
      return {
        completedUnits: complete,
        createdAt: job.createdAt.toISOString(),
        errorCode,
        jobId: job.id,
        operation: identity.operation,
        state,
        totalUnits: job.state === "SUCCEEDED" ? children.length : null,
        updatedAt: updatedAt.toISOString()
      };
    }

    const generation = await client.memoryIndexGeneration.findFirst({
      where: { id: identity.generationId, userId }
    });
    if (!generation) return null;
    const entries = await client.memorySearchEntry.findMany({
      select: { embeddingState: true },
      where: { indexGenerationId: generation.id, userId }
    });
    const childJobs = entries.length === 0
      ? []
      : await client.$queryRaw<Array<{
          errorCode: string | null;
          state: MemoryJobState;
        }>>(Prisma.sql`
          SELECT DISTINCT job."errorCode", job."id", job."state"::text AS "state"
          FROM "MemoryJob" AS job
          INNER JOIN "MemorySearchEntry" AS entry
            ON entry."userId" = job."userId"
            AND entry."indexGenerationId" = ${generation.id}
            AND job."idempotencyFingerprint" LIKE
              ('memory-item-embed-v1:' || entry."id" || ':%')
          WHERE job."userId" = ${userId}
            AND job."kind" = 'EMBED_ITEMS'::"MemoryJobKind"
        `);
    const childFailure = childJobs.find(({ state }) =>
      ["CANCELLED", "STALE", "TERMINAL_FAILED"].includes(state));
    const waiting = childJobs.some(({ state }) => state === "WAITING_FOR_EGRESS_CONSENT");
    const completedUnits = generation.indexMode === "LEXICAL_ONLY"
      ? entries.length
      : entries.filter(({ embeddingState }) => embeddingState === "READY").length;
    let state: MemoryRebuildStatus["state"];
    let errorCode: MemoryRebuildStatus["errorCode"] = null;
    if (job.state === "CANCELLED" || generation.state === "CANCELLED") {
      state = "CANCELLED";
    } else if (job.state === "STALE") {
      state = "STALE";
    } else if (job.state === "TERMINAL_FAILED" || generation.state === "FAILED" || childFailure) {
      state = "FAILED";
      errorCode = publicFailureCode(childFailure?.errorCode ?? job.errorCode);
    } else if (generation.state === "ACTIVE" || generation.state === "SUPERSEDED") {
      state = "SUCCEEDED";
    } else if (generation.state === "READY") {
      state = "READY";
    } else if (waiting) {
      state = "WAITING_FOR_EGRESS_CONSENT";
    } else if (generation.state === "CATCHING_UP") {
      state = "CATCHING_UP";
    } else {
      state = statusStateForJob(job.state);
    }
    return {
      completedUnits,
      createdAt: job.createdAt.toISOString(),
      errorCode,
      jobId: job.id,
      operation: identity.operation,
      state,
      totalUnits: generation.state === "BUILDING" ? null : entries.length,
      updatedAt: (generation.activatedAt ?? generation.readyAt ?? job.updatedAt).toISOString()
    };
  }

  return Object.freeze({
    async admit(
      userId: string,
      input: MemoryRebuildAdmissionInput
    ): Promise<MemoryRebuildAdmissionResult> {
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        let redreamFingerprint: string | null = null;
        if (input.operation === "REDREAM_EXISTING_CHATS") {
          if (!input.authorization || input.authorization.action !== "BULK_DELETE") {
            throw new Error("memory_redream_authorization_invalid");
          }
          redreamFingerprint = memoryRedreamBatchJobFingerprint({
            batchId: input.authorization.authorizationId,
            requestIdentity: input.requestIdentity
          });
          const replay = await tx.memoryJob.findUnique({
            select: { id: true },
            where: {
              userId_idempotencyFingerprint: {
                idempotencyFingerprint: redreamFingerprint,
                userId
              }
            }
          });
          if (replay) return { jobId: replay.id, kind: "ok" } as const;
        }
        if (settings.settingsRevision !== input.expectedSettingsRevision) {
          return { kind: "settings_revision_conflict" } as const;
        }
        if (settings.memoryRevision !== input.expectedMemoryRevision) {
          return { kind: "memory_revision_conflict" } as const;
        }
        const running = await tx.memoryJob.count({
          where: { kind: "REBUILD_INDEX", state: { in: [...nonterminalJobStates] }, userId }
        });
        const [shadow, redreamChildren] = await Promise.all([
          tx.memoryIndexGeneration.count({
            where: { state: { in: ["BUILDING", "CATCHING_UP", "READY"] }, userId }
          }),
          tx.memoryJob.count({
            where: {
              idempotencyFingerprint: {
                startsWith: MEMORY_EPISODE_REDREAM_JOB_PREFIX
              },
              kind: "EXTRACT_EPISODE",
              state: { in: [...nonterminalJobStates] },
              userId
            }
          })
        ]);
        if (running > 0 || shadow > 0 || redreamChildren > 0) {
          return { kind: "in_progress" } as const;
        }
        if (input.operation === "REDREAM_EXISTING_CHATS") {
          await consumeMemoryMutationAuthorization(
            tx,
            userId,
            input.authorization!
          );
          const queued = await enqueueMemoryJob(tx, settings, {
            idempotencyFingerprint: redreamFingerprint!,
            kind: "REBUILD_INDEX",
            pipelineVersion: MEMORY_REDREAM_BATCH_PIPELINE_VERSION
          });
          return { jobId: queued.id, kind: "ok" } as const;
        }

        const active = await ensureActiveLexicalGeneration(
          tx,
          settings,
          settings.memoryRevision
        );
        const source = await tx.memoryIndexGeneration.findFirst({
          where: { id: active.id, state: "ACTIVE", userId }
        });
        if (!source) throw new Error("memory_active_generation_invalid");
        const currentPin = input.operation === "REEMBED"
          ? await currentEmbeddingPin(tx, settings)
          : null;
        if (
          input.operation === "REEMBED" &&
          (!input.pin ||
            input.embeddingDeploymentId !== settings.embeddingProviderModelId ||
            input.pin.providerModelId !== input.embeddingDeploymentId ||
            !currentPin ||
            !sameEmbeddingPin(input.pin, currentPin))
        ) {
          return { kind: "embedding_unavailable" } as const;
        }
        const maximum = await tx.memoryIndexGeneration.aggregate({
          _max: { generation: true },
          where: { userId }
        });
        const generationId = randomUUID();
        await tx.memoryIndexGeneration.create({
          data: {
            ...configurationData(source, input.operation, input.pin ?? null),
            generation: (maximum._max.generation ?? -1) + 1,
            id: generationId,
            indexedThroughMemoryRevision: 0,
            sourceIndexGenerationId: source.id,
            state: "BUILDING",
            targetMemoryRevision: settings.memoryRevision,
            userId
          }
        });
        const queued = await enqueueMemoryJob(tx, settings, {
          idempotencyFingerprint: memoryShadowRebuildJobFingerprint({
            generationId,
            operation: input.operation,
            requestIdentity: input.requestIdentity
          }),
          kind: "REBUILD_INDEX",
          pipelineVersion: MEMORY_SHADOW_REBUILD_PIPELINE_VERSION
        });
        return { jobId: queued.id, kind: "ok" } as const;
      });
    },

    applyJob(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      now: Date
    ): Promise<void> {
      const identity = parseMemoryRebuildJobFingerprint(claim.idempotencyFingerprint);
      return identity?.type === "REDREAM"
        ? applyRedreamBatch(tx, claim, now)
        : applyShadowCatchUp(tx, claim, now);
    },

    async cancel(userId: string, jobId: string, now = new Date()): Promise<MemoryRebuildStatus | null> {
      await client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          id: string;
          idempotencyFingerprint: string;
          state: MemoryJobState;
        }>>(Prisma.sql`
          SELECT "id", "idempotencyFingerprint", "state"::text AS "state"
          FROM "MemoryJob"
          WHERE "id" = ${jobId} AND "userId" = ${userId}
            AND "kind" = 'REBUILD_INDEX'::"MemoryJobKind"
          FOR UPDATE
        `);
        const job = rows[0];
        if (!job) return;
        const identity = parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint);
        if (!identity) return;
        if (identity.type === "SHADOW") {
          const generation = await tx.memoryIndexGeneration.findFirst({
            select: { state: true },
            where: { id: identity.generationId, userId }
          });
          if (
            !generation ||
            !["BUILDING", "CATCHING_UP", "READY"].includes(generation.state)
          ) return;
          await tx.$executeRaw(Prisma.sql`
            UPDATE "MemoryJob" AS job
            SET
              "completedAt" = ${now},
              "errorCode" = 'memory_rebuild_cancelled',
              "leaseExpiresAt" = NULL,
              "leaseToken" = NULL,
              "nextAttemptAt" = NULL,
              "state" = 'CANCELLED'::"MemoryJobState",
              "updatedAt" = ${now}
            WHERE job."userId" = ${userId}
              AND job."kind" = 'EMBED_ITEMS'::"MemoryJobKind"
              AND job."state" IN (
                'CLAIMED'::"MemoryJobState",
                'QUEUED'::"MemoryJobState",
                'RETRYABLE_FAILED'::"MemoryJobState",
                'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
              )
              AND EXISTS (
                SELECT 1
                FROM "MemorySearchEntry" AS entry
                WHERE entry."userId" = job."userId"
                  AND entry."indexGenerationId" = ${identity.generationId}
                  AND job."idempotencyFingerprint" LIKE
                    ('memory-item-embed-v1:' || entry."id" || ':%')
              )
          `);
          await tx.memorySearchEntry.deleteMany({
            where: { indexGenerationId: identity.generationId, userId }
          });
          await tx.memoryIndexGeneration.updateMany({
            data: { state: "CANCELLED" },
            where: {
              id: identity.generationId,
              state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
              userId
            }
          });
        } else {
          const childCount = await tx.memoryJob.count({
            where: {
              idempotencyFingerprint: {
                startsWith: `memory-episode-redream-v1:${identity.batchId}:`
              },
              kind: "EXTRACT_EPISODE",
              state: { in: [...nonterminalJobStates] },
              userId
            }
          });
          if (
            !nonterminalJobStates.includes(job.state) &&
            !(job.state === "SUCCEEDED" && childCount > 0)
          ) return;
          await tx.memoryJob.updateMany({
            data: {
              completedAt: now,
              errorCode: "memory_rebuild_cancelled",
              leaseExpiresAt: null,
              leaseToken: null,
              nextAttemptAt: null,
              state: "CANCELLED",
              updatedAt: now
            },
            where: {
              idempotencyFingerprint: {
                startsWith: `memory-episode-redream-v1:${identity.batchId}:`
              },
              kind: "EXTRACT_EPISODE",
              state: { in: [...nonterminalJobStates] },
              userId
            }
          });
        }
        await tx.memoryJob.updateMany({
          data: {
            completedAt: now,
            errorCode: "memory_rebuild_cancelled",
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: null,
            state: "CANCELLED",
            updatedAt: now
          },
          where: { id: jobId, userId }
        });
      });
      return status(userId, jobId);
    },

    status,

    async wakeShadow(userId: string, generationId: string): Promise<number> {
      const prefixes = memoryShadowRebuildJobPrefixes(generationId);
      const updated = await client.memoryJob.updateMany({
        data: {
          acceptedResultHash: null,
          attemptCount: 0,
          completedAt: null,
          errorCode: null,
          nextAttemptAt: null,
          stage: null,
          state: "QUEUED"
        },
        where: {
          OR: prefixes.map((prefix) => ({ idempotencyFingerprint: { startsWith: prefix } })),
          kind: "REBUILD_INDEX",
          state: "SUCCEEDED",
          userId
        }
      });
      return updated.count;
    }
  });
}

export type MemoryRebuildRepository = ReturnType<
  typeof createPrismaMemoryRebuildRepository
>;
