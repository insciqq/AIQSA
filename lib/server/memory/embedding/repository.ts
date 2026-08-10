import {
  Prisma,
  type MemoryEmbeddingState,
  type MemoryExecutionState,
  type MemorySearchItemType,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";
import {
  advanceMemoryMutation,
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "../persistence/transaction";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import {
  memoryItemEmbeddingGenerationMatchesPin,
  type MemoryItemEmbeddingPin,
  type MemoryItemEmbeddingTarget
} from "./contract";

type TargetQueryStore = Pick<PrismaClient, "$queryRaw">;

type BaseTargetRow = Readonly<{
  embeddingConfigurationFingerprint: string | null;
  embeddingConnectionId: string | null;
  embeddingDimension: number | null;
  embeddingProviderModelId: string | null;
  embeddingState: MemoryEmbeddingState;
  entryId: string;
  episodeId: string | null;
  factVersionId: string | null;
  generationId: string;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  itemType: MemorySearchItemType;
  recallChunkId: string | null;
  referenceChatHistory: boolean;
  safeContentHash: string;
  safeSearchText: string;
  selectedEmbeddingProviderModelId: string | null;
  userId: string;
  vectorSpaceFingerprint: string | null;
}>;

type FactTargetRow = Readonly<{
  factId: string;
  structuredValue: Prisma.JsonValue;
  versionDisplayText: string;
}>;

type HistoryTargetRow = Readonly<{
  itemId: string;
  safeText: string;
  sourceContentHash: string;
}>;

export type MemoryItemEmbeddingBinding = Readonly<{
  acceptedOutputHash: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  secretFreeExecutionSnapshot: Prisma.JsonValue;
  state: MemoryExecutionState;
}>;

export type MemoryItemEmbeddingSettlement =
  | "APPLIED"
  | "READY"
  | "STALE"
  | "UNCHANGED";

/** Compatibility aliases retained for the shipped explicit Memory API. */
export type MemoryExplicitEmbeddingBinding = MemoryItemEmbeddingBinding;
export type MemoryExplicitEmbeddingSettlement = MemoryItemEmbeddingSettlement;

const sha256 = /^[a-f0-9]{64}$/u;

function validGeneration(row: BaseTargetRow): boolean {
  return row.indexMode === "HYBRID" &&
    Boolean(row.embeddingConnectionId) &&
    Boolean(row.embeddingProviderModelId) &&
    Boolean(
      row.embeddingConfigurationFingerprint &&
      sha256.test(row.embeddingConfigurationFingerprint)
    ) &&
    (row.embeddingDimension === 1_024 || row.embeddingDimension === 1_536) &&
    Boolean(
      row.vectorSpaceFingerprint && sha256.test(row.vectorSpaceFingerprint)
    ) &&
    row.embeddingProviderModelId === row.selectedEmbeddingProviderModelId;
}

function generationFrom(row: BaseTargetRow) {
  return {
    embeddingConfigurationFingerprint: row.embeddingConfigurationFingerprint,
    embeddingConnectionId: row.embeddingConnectionId,
    embeddingDimension: row.embeddingDimension,
    embeddingProviderModelId: row.embeddingProviderModelId,
    id: row.generationId,
    indexMode: row.indexMode,
    vectorSpaceFingerprint: row.vectorSpaceFingerprint
  } as const;
}

async function loadBaseTarget(
  store: TargetQueryStore,
  userId: string,
  entryId: string
): Promise<BaseTargetRow | null> {
  const rows = await store.$queryRaw<BaseTargetRow[]>(Prisma.sql`
    SELECT
      entry."id" AS "entryId",
      entry."userId",
      entry."itemType"::text AS "itemType",
      entry."factVersionId",
      entry."episodeId",
      entry."recallChunkId",
      entry."safeSearchText",
      entry."safeContentHash",
      entry."embeddingState"::text AS "embeddingState",
      generation."id" AS "generationId",
      generation."indexMode"::text AS "indexMode",
      generation."embeddingConnectionId",
      generation."embeddingProviderModelId",
      generation."embeddingConfigurationFingerprint",
      generation."embeddingDimension",
      generation."vectorSpaceFingerprint",
      settings."embeddingProviderModelId" AS "selectedEmbeddingProviderModelId",
      settings."referenceChatHistory"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "User" AS owner
      ON owner."id" = entry."userId"
      AND owner."status" = 'active'::"UserStatus"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."activeIndexGenerationId" = entry."indexGenerationId"
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = entry."userId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND generation."indexMode" = 'HYBRID'::"MemoryIndexMode"
    WHERE entry."userId" = ${userId}
      AND entry."id" = ${entryId}
      AND entry."embeddingState" IN (
        'PENDING'::"MemoryEmbeddingState",
        'READY'::"MemoryEmbeddingState",
        'FAILED'::"MemoryEmbeddingState"
      )
    LIMIT 1
  `);
  const row = rows[0];
  return row && validGeneration(row) ? row : null;
}

async function loadFactTarget(
  store: TargetQueryStore,
  row: BaseTargetRow
): Promise<MemoryItemEmbeddingTarget | null> {
  if (!row.factVersionId || row.episodeId || row.recallChunkId) return null;
  const rows = await store.$queryRaw<FactTargetRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId",
      version."displayText" AS "versionDisplayText",
      version."structuredValue"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
      AND fact."currentVersionId" = version."id"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    WHERE version."userId" = ${row.userId}
      AND version."id" = ${row.factVersionId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND version."systemTo" IS NULL
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
    LIMIT 1
  `);
  const current = rows[0];
  if (!current) return null;
  const safeSearchText = normalizeMemorySearchText(current.versionDisplayText);
  const safeContentHash = memorySha256({
    displayText: current.versionDisplayText,
    structuredValue: current.structuredValue
  });
  if (
    safeSearchText !== row.safeSearchText ||
    safeContentHash !== row.safeContentHash
  ) return null;
  return {
    embeddingState: row.embeddingState,
    entryId: row.entryId,
    factId: current.factId,
    factVersionId: row.factVersionId,
    generation: generationFrom(row),
    itemId: row.factVersionId,
    itemType: "FACT_VERSION",
    safeContentHash,
    safeSearchText,
    selectedEmbeddingProviderModelId: row.selectedEmbeddingProviderModelId,
    userId: row.userId
  };
}

async function loadRecallChunkTarget(
  store: TargetQueryStore,
  row: BaseTargetRow
): Promise<MemoryItemEmbeddingTarget | null> {
  if (!row.referenceChatHistory || !row.recallChunkId || row.factVersionId || row.episodeId) {
    return null;
  }
  const rows = await store.$queryRaw<HistoryTargetRow[]>(Prisma.sql`
    SELECT
      chunk."id" AS "itemId",
      chunk."safeProjectedText" AS "safeText",
      chunk."contentHash" AS "sourceContentHash"
    FROM "MemoryRecallChunk" AS chunk
    INNER JOIN "Chat" AS chat
      ON chat."userId" = chunk."userId"
      AND chat."id" = chunk."chatId"
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."memoryBranchGeneration" = chunk."branchGeneration"
      AND chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId"
      AND checkpoint."chatId" = chunk."chatId"
      AND checkpoint."branchGeneration" = chunk."branchGeneration"
      AND checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
      AND checkpoint."activeLeafMessageId" = chat."activeLeafMessageId"
      AND checkpoint."lastIndexedMessageId" = chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
    WHERE chunk."userId" = ${row.userId}
      AND chunk."id" = ${row.recallChunkId}
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass",
        'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
    LIMIT 1
  `);
  const current = rows[0];
  if (!current) return null;
  const safeSearchText = normalizeMemorySearchText(current.safeText);
  if (
    safeSearchText !== row.safeSearchText ||
    current.sourceContentHash !== row.safeContentHash
  ) return null;
  return {
    embeddingState: row.embeddingState,
    entryId: row.entryId,
    generation: generationFrom(row),
    itemId: current.itemId,
    itemType: "RECALL_CHUNK",
    recallChunkId: current.itemId,
    safeContentHash: current.sourceContentHash,
    safeSearchText,
    selectedEmbeddingProviderModelId: row.selectedEmbeddingProviderModelId,
    userId: row.userId
  };
}

async function loadEpisodeTarget(
  store: TargetQueryStore,
  row: BaseTargetRow
): Promise<MemoryItemEmbeddingTarget | null> {
  if (!row.referenceChatHistory || !row.episodeId || row.factVersionId || row.recallChunkId) {
    return null;
  }
  const rows = await store.$queryRaw<HistoryTargetRow[]>(Prisma.sql`
    SELECT
      episode."id" AS "itemId",
      episode."safeSummary" AS "safeText",
      episode."sourceHash" AS "sourceContentHash"
    FROM "MemoryEpisode" AS episode
    INNER JOIN "Chat" AS chat
      ON chat."userId" = episode."userId"
      AND chat."id" = episode."chatId"
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."memoryBranchGeneration" = episode."branchGeneration"
      AND chat."memorySourceRevision" = episode."sourceRevisionAtCreation"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = episode."userId"
      AND checkpoint."chatId" = episode."chatId"
      AND checkpoint."branchGeneration" = episode."branchGeneration"
      AND checkpoint."sourceRevision" = episode."sourceRevisionAtCreation"
      AND checkpoint."sourceContentHash" = episode."sourceHash"
      AND checkpoint."activeLeafMessageId" = chat."activeLeafMessageId"
      AND checkpoint."lastDreamedMessageId" = chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
    WHERE episode."userId" = ${row.userId}
      AND episode."id" = ${row.episodeId}
      AND episode."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND episode."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass",
        'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND episode."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
    LIMIT 1
  `);
  const current = rows[0];
  if (!current) return null;
  const safeSearchText = normalizeMemorySearchText(current.safeText);
  const safeContentHash = memorySha256(current.safeText);
  if (
    safeSearchText !== row.safeSearchText ||
    safeContentHash !== row.safeContentHash
  ) return null;
  return {
    embeddingState: row.embeddingState,
    entryId: row.entryId,
    episodeId: current.itemId,
    generation: generationFrom(row),
    itemId: current.itemId,
    itemType: "EPISODE",
    safeContentHash,
    safeSearchText,
    selectedEmbeddingProviderModelId: row.selectedEmbeddingProviderModelId,
    userId: row.userId
  };
}

async function loadCurrentTarget(
  store: TargetQueryStore,
  userId: string,
  entryId: string
): Promise<MemoryItemEmbeddingTarget | null> {
  const row = await loadBaseTarget(store, userId, entryId);
  if (!row) return null;
  switch (row.itemType) {
    case "FACT_VERSION": return loadFactTarget(store, row);
    case "EPISODE": return loadEpisodeTarget(store, row);
    case "RECALL_CHUNK": return loadRecallChunkTarget(store, row);
  }
}

function sameTarget(
  left: MemoryItemEmbeddingTarget,
  right: MemoryItemEmbeddingTarget
): boolean {
  return left.userId === right.userId &&
    left.entryId === right.entryId &&
    left.itemId === right.itemId &&
    left.itemType === right.itemType &&
    left.safeContentHash === right.safeContentHash &&
    left.safeSearchText === right.safeSearchText &&
    left.generation.id === right.generation.id &&
    left.generation.indexMode === right.generation.indexMode &&
    left.generation.embeddingConnectionId ===
      right.generation.embeddingConnectionId &&
    left.generation.embeddingProviderModelId ===
      right.generation.embeddingProviderModelId &&
    left.generation.embeddingConfigurationFingerprint ===
      right.generation.embeddingConfigurationFingerprint &&
    left.generation.embeddingDimension === right.generation.embeddingDimension &&
    left.generation.vectorSpaceFingerprint ===
      right.generation.vectorSpaceFingerprint;
}

function validVector(vector: readonly number[], dimension: number): boolean {
  if (!Array.isArray(vector) || vector.length !== dimension) return false;
  let squaredNorm = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    squaredNorm += value * value;
  }
  return Number.isFinite(squaredNorm) && squaredNorm > 0;
}

function exactTargetPredicate(target: MemoryItemEmbeddingTarget): Prisma.Sql {
  switch (target.itemType) {
    case "FACT_VERSION":
      return Prisma.sql`
        "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
        AND "factVersionId" = ${target.factVersionId}
      `;
    case "EPISODE":
      return Prisma.sql`
        "itemType" = 'EPISODE'::"MemorySearchItemType"
        AND "episodeId" = ${target.episodeId}
      `;
    case "RECALL_CHUNK":
      return Prisma.sql`
        "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
        AND "recallChunkId" = ${target.recallChunkId}
      `;
  }
}

export function createPrismaMemoryItemEmbeddingRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async applyFailed(
      target: MemoryItemEmbeddingTarget,
      now: Date
    ): Promise<MemoryItemEmbeddingSettlement> {
      return withLockedMemoryTransaction(client, target.userId, async (tx, settings) => {
        const current = await loadCurrentTarget(tx, target.userId, target.entryId);
        if (!current || !sameTarget(current, target)) return "STALE";
        if (current.embeddingState === "READY") return "READY";
        if (current.embeddingState === "FAILED") return "UNCHANGED";
        if (current.embeddingState !== "PENDING") return "STALE";
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "MemorySearchEntry"
          SET
            "embedding" = NULL,
            "embeddingDimension" = NULL,
            "embeddingState" = 'FAILED'::"MemoryEmbeddingState",
            "updatedAt" = ${now}
          WHERE "id" = ${target.entryId}
            AND "userId" = ${target.userId}
            AND "indexGenerationId" = ${target.generation.id}
            AND "safeContentHash" = ${target.safeContentHash}
            AND "embeddingState" = 'PENDING'::"MemoryEmbeddingState"
            AND ${exactTargetPredicate(target)}
        `);
        if (updated !== 1) return "STALE";
        await advanceMemoryMutation(tx, settings, "ACTIVE_VECTOR_SETTLEMENT");
        return "APPLIED";
      });
    },

    async applyReady(
      tx: MemoryTransaction,
      settings: LockedMemorySettings,
      target: MemoryItemEmbeddingTarget,
      pin: MemoryItemEmbeddingPin,
      vector: readonly number[],
      now: Date
    ): Promise<MemoryItemEmbeddingSettlement> {
      const current = await loadCurrentTarget(tx, target.userId, target.entryId);
      if (
        settings.userId !== target.userId ||
        !current ||
        !sameTarget(current, target) ||
        !memoryItemEmbeddingGenerationMatchesPin(current.generation, pin)
      ) {
        return "STALE";
      }
      if (current.embeddingState === "READY") return "READY";
      const dimension = current.generation.embeddingDimension;
      if (!dimension || !validVector(vector, dimension)) return "STALE";
      const serialized = JSON.stringify(vector);
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "MemorySearchEntry"
        SET
          "embedding" = ${serialized}::vector,
          "embeddingDimension" = ${dimension},
          "embeddingState" = 'READY'::"MemoryEmbeddingState",
          "updatedAt" = ${now}
        WHERE "id" = ${target.entryId}
          AND "userId" = ${target.userId}
          AND "indexGenerationId" = ${target.generation.id}
          AND "safeContentHash" = ${target.safeContentHash}
          AND "embeddingState" IN (
            'PENDING'::"MemoryEmbeddingState",
            'FAILED'::"MemoryEmbeddingState"
          )
          AND ${exactTargetPredicate(target)}
      `);
      if (updated !== 1) return "STALE";
      await advanceMemoryMutation(tx, settings, "ACTIVE_VECTOR_SETTLEMENT");
      return "APPLIED";
    },

    async bindings(
      userId: string,
      memoryJobId: string
    ): Promise<readonly MemoryItemEmbeddingBinding[]> {
      return client.memoryExecutionBinding.findMany({
        orderBy: [{ ordinal: "asc" }, { id: "asc" }],
        select: {
          acceptedOutputHash: true,
          id: true,
          inputHash: true,
          ordinal: true,
          secretFreeExecutionSnapshot: true,
          state: true
        },
        where: {
          logicalRole: "MEMORY_DOCUMENT_EMBED",
          memoryJobId,
          ownerType: "JOB",
          relationsDetachedAt: null,
          userId
        }
      });
    },

    loadTarget(userId: string, entryId: string) {
      return loadCurrentTarget(client, userId, entryId);
    }
  });
}

export const createPrismaMemoryExplicitEmbeddingRepository =
  createPrismaMemoryItemEmbeddingRepository;

export type MemoryItemEmbeddingRepository = ReturnType<
  typeof createPrismaMemoryItemEmbeddingRepository
>;
export type MemoryExplicitEmbeddingRepository = MemoryItemEmbeddingRepository;
