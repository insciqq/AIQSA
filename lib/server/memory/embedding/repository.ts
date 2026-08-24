import {
  Prisma,
  type MemoryEmbeddingState,
  type MemoryExecutionState,
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
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";
import { memoryHistoryChunkSourceAuthorityPredicate } from "../persistence/pauseIntervals";
import { memoryPersonalFactEvidencePredicate } from "../persistence/eligibility";
import { wakeMemoryShadowRebuildInTransaction } from "../rebuild/wake";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
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
  factVersionId: string | null;
  generationId: string;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  itemType: "FACT_VERSION" | "RECALL_CHUNK";
  recallChunkId: string | null;
  referenceChatHistory: boolean;
  safeContentHash: string;
  normalizedSearchText: string;
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
      entry."recallChunkId",
      entry."normalizedSearchText",
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
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = entry."userId"
      AND generation."id" = entry."indexGenerationId"
      AND generation."state" IN (
        'ACTIVE'::"MemoryIndexGenerationState",
        'BUILDING'::"MemoryIndexGenerationState",
        'CATCHING_UP'::"MemoryIndexGenerationState",
        'READY'::"MemoryIndexGenerationState"
      )
      AND generation."indexMode" = 'HYBRID'::"MemoryIndexMode"
    WHERE entry."userId" = ${userId}
      AND entry."id" = ${entryId}
      AND entry."itemType" IN (
        'FACT_VERSION'::"MemorySearchItemType",
        'RECALL_CHUNK'::"MemorySearchItemType"
      )
      AND (
        (
          generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
          AND settings."activeIndexGenerationId" = generation."id"
        )
        OR (
          generation."state" IN (
            'BUILDING'::"MemoryIndexGenerationState",
            'CATCHING_UP'::"MemoryIndexGenerationState",
            'READY'::"MemoryIndexGenerationState"
          )
          AND generation."sourceIndexGenerationId" = settings."activeIndexGenerationId"
        )
      )
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
  if (!row.factVersionId || row.recallChunkId) return null;
  const rows = await store.$queryRaw<FactTargetRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId",
      version."displayText" AS "versionDisplayText",
      version."structuredValue"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    WHERE version."userId" = ${row.userId}
      AND version."id" = ${row.factVersionId}
      AND (
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
      )
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND ${memoryPersonalFactEvidencePredicate(row.userId, { exactVNext: true })}
    LIMIT 1
  `);
  const current = rows[0];
  if (!current) return null;
  const normalizedSearchText = normalizeMemorySearchText(current.versionDisplayText);
  const safeContentHash = memorySha256({
    displayText: current.versionDisplayText,
    structuredValue: current.structuredValue
  });
  if (
    normalizedSearchText !== row.normalizedSearchText ||
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
    normalizedSearchText,
    selectedEmbeddingProviderModelId: row.selectedEmbeddingProviderModelId,
    userId: row.userId
  };
}

async function loadRecallChunkTarget(
  store: TargetQueryStore,
  row: BaseTargetRow
): Promise<MemoryItemEmbeddingTarget | null> {
  if (!row.referenceChatHistory || !row.recallChunkId || row.factVersionId) {
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
      AND chat."projectId" IS NULL
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND chat."memoryBranchGeneration" = chunk."branchGeneration"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId"
      AND checkpoint."chatId" = chunk."chatId"
      AND checkpoint."branchGeneration" = chunk."branchGeneration"
      AND checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
    WHERE chunk."userId" = ${row.userId}
      AND chunk."id" = ${row.recallChunkId}
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND chunk."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND chunk."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass",
        'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND ${memoryHistoryChunkSourceAuthorityPredicate({
        chat: "chat",
        checkpoint: "checkpoint"
      })}
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
    LIMIT 1
  `);
  const current = rows[0];
  if (!current) return null;
  const normalizedSearchText = normalizeMemorySearchText(current.safeText);
  if (
    normalizedSearchText !== row.normalizedSearchText ||
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
    normalizedSearchText,
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
    left.normalizedSearchText === right.normalizedSearchText &&
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
    case "RECALL_CHUNK":
      return Prisma.sql`
        "itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
        AND "recallChunkId" = ${target.recallChunkId}
      `;
  }
}

async function settleEmbeddingMutation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  generationId: string,
  outcome: "FAILED" | "READY"
): Promise<void> {
  const generation = await tx.memoryIndexGeneration.findFirst({
    select: { state: true },
    where: { id: generationId, userId: settings.userId }
  });
  if (generation?.state === "ACTIVE") {
    await advanceMemoryMutation(tx, settings, "ACTIVE_VECTOR_SETTLEMENT");
    return;
  }
  if (
    generation && ["BUILDING", "CATCHING_UP", "READY"].includes(generation.state)
  ) {
    if (outcome === "FAILED") {
      await tx.memoryIndexGeneration.updateMany({
        data: { state: "FAILED" },
        where: {
          id: generationId,
          state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
          userId: settings.userId
        }
      });
      await tx.memorySearchEntry.deleteMany({
        where: { indexGenerationId: generationId, userId: settings.userId }
      });
      return;
    }
    await wakeMemoryShadowRebuildInTransaction(
      tx,
      settings.userId,
      generationId
    );
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
        await settleEmbeddingMutation(tx, settings, target.generation.id, "FAILED");
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
      await settleEmbeddingMutation(tx, settings, target.generation.id, "READY");
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

export type MemoryItemEmbeddingRepository = ReturnType<
  typeof createPrismaMemoryItemEmbeddingRepository
>;
