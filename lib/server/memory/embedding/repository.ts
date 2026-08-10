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
import {
  memoryExplicitEmbeddingGenerationMatchesPin,
  type MemoryExplicitEmbeddingPin,
  type MemoryExplicitEmbeddingTarget
} from "./contract";

type TargetQueryStore = Pick<PrismaClient, "$queryRaw">;

type TargetRow = Readonly<{
  embeddingConfigurationFingerprint: string | null;
  embeddingConnectionId: string | null;
  embeddingDimension: number | null;
  embeddingProviderModelId: string | null;
  embeddingState: MemoryEmbeddingState;
  entryId: string;
  factId: string;
  factVersionId: string;
  generationId: string;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  safeContentHash: string;
  safeSearchText: string;
  selectedEmbeddingProviderModelId: string | null;
  structuredValue: Prisma.JsonValue;
  userId: string;
  vectorSpaceFingerprint: string | null;
  versionDisplayText: string;
}>;

export type MemoryExplicitEmbeddingBinding = Readonly<{
  acceptedOutputHash: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  secretFreeExecutionSnapshot: Prisma.JsonValue;
  state: MemoryExecutionState;
}>;

export type MemoryExplicitEmbeddingSettlement =
  | "APPLIED"
  | "READY"
  | "STALE"
  | "UNCHANGED";

function validGeneration(row: TargetRow): boolean {
  return row.indexMode === "HYBRID" &&
    Boolean(row.embeddingConnectionId) &&
    Boolean(row.embeddingProviderModelId) &&
    Boolean(row.embeddingConfigurationFingerprint) &&
    Number.isSafeInteger(row.embeddingDimension) &&
    Number(row.embeddingDimension) > 0 &&
    Boolean(row.vectorSpaceFingerprint) &&
    row.embeddingProviderModelId === row.selectedEmbeddingProviderModelId;
}

function targetFromRow(row: TargetRow): MemoryExplicitEmbeddingTarget | null {
  if (!validGeneration(row)) return null;
  const safeSearchText = normalizeMemorySearchText(row.versionDisplayText);
  const safeContentHash = memorySha256({
    displayText: row.versionDisplayText,
    structuredValue: row.structuredValue
  });
  if (
    safeSearchText !== row.safeSearchText ||
    safeContentHash !== row.safeContentHash
  ) {
    return null;
  }
  return {
    embeddingState: row.embeddingState,
    entryId: row.entryId,
    factId: row.factId,
    factVersionId: row.factVersionId,
    generation: {
      embeddingConfigurationFingerprint:
        row.embeddingConfigurationFingerprint,
      embeddingConnectionId: row.embeddingConnectionId,
      embeddingDimension: row.embeddingDimension,
      embeddingProviderModelId: row.embeddingProviderModelId,
      id: row.generationId,
      indexMode: row.indexMode,
      vectorSpaceFingerprint: row.vectorSpaceFingerprint
    },
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
): Promise<MemoryExplicitEmbeddingTarget | null> {
  const rows = await store.$queryRaw<TargetRow[]>(Prisma.sql`
    SELECT
      entry."id" AS "entryId",
      entry."userId",
      entry."factVersionId",
      entry."safeSearchText",
      entry."safeContentHash",
      entry."embeddingState"::text AS "embeddingState",
      fact."id" AS "factId",
      version."displayText" AS "versionDisplayText",
      version."structuredValue",
      generation."id" AS "generationId",
      generation."indexMode"::text AS "indexMode",
      generation."embeddingConnectionId",
      generation."embeddingProviderModelId",
      generation."embeddingConfigurationFingerprint",
      generation."embeddingDimension",
      generation."vectorSpaceFingerprint",
      settings."embeddingProviderModelId" AS "selectedEmbeddingProviderModelId"
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
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = entry."userId"
      AND version."id" = entry."factVersionId"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND version."systemTo" IS NULL
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
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
    WHERE entry."userId" = ${userId}
      AND entry."id" = ${entryId}
      AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
    LIMIT 1
  `);
  return rows[0] ? targetFromRow(rows[0]) : null;
}

function sameTarget(
  left: MemoryExplicitEmbeddingTarget,
  right: MemoryExplicitEmbeddingTarget
): boolean {
  return left.userId === right.userId &&
    left.entryId === right.entryId &&
    left.factId === right.factId &&
    left.factVersionId === right.factVersionId &&
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

export function createPrismaMemoryExplicitEmbeddingRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async applyFailed(
      target: MemoryExplicitEmbeddingTarget,
      now: Date
    ): Promise<MemoryExplicitEmbeddingSettlement> {
      return withLockedMemoryTransaction(client, target.userId, async (tx, settings) => {
        const current = await loadCurrentTarget(tx, target.userId, target.entryId);
        if (!current || !sameTarget(current, target)) return "STALE";
        if (current.embeddingState === "READY") return "READY";
        if (current.embeddingState === "FAILED") return "UNCHANGED";
        if (current.embeddingState !== "PENDING") return "STALE";
        const updated = await tx.memorySearchEntry.updateMany({
          data: {
            embeddingDimension: null,
            embeddingState: "FAILED",
            updatedAt: now
          },
          where: {
            embeddingState: "PENDING",
            id: target.entryId,
            indexGenerationId: target.generation.id,
            safeContentHash: target.safeContentHash,
            userId: target.userId
          }
        });
        if (updated.count !== 1) return "STALE";
        await advanceMemoryMutation(tx, settings, "ACTIVE_VECTOR_SETTLEMENT");
        return "APPLIED";
      });
    },

    async applyReady(
      tx: MemoryTransaction,
      settings: LockedMemorySettings,
      target: MemoryExplicitEmbeddingTarget,
      pin: MemoryExplicitEmbeddingPin,
      vector: readonly number[],
      now: Date
    ): Promise<MemoryExplicitEmbeddingSettlement> {
      const current = await loadCurrentTarget(tx, target.userId, target.entryId);
      if (
        settings.userId !== target.userId ||
        !current ||
        !sameTarget(current, target) ||
        !memoryExplicitEmbeddingGenerationMatchesPin(current.generation, pin)
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
          AND "factVersionId" = ${target.factVersionId}
          AND "safeContentHash" = ${target.safeContentHash}
          AND "embeddingState" IN (
            'PENDING'::"MemoryEmbeddingState",
            'FAILED'::"MemoryEmbeddingState"
          )
      `);
      if (updated !== 1) return "STALE";
      await advanceMemoryMutation(tx, settings, "ACTIVE_VECTOR_SETTLEMENT");
      return "APPLIED";
    },

    async bindings(
      userId: string,
      memoryJobId: string
    ): Promise<readonly MemoryExplicitEmbeddingBinding[]> {
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

export type MemoryExplicitEmbeddingRepository = ReturnType<
  typeof createPrismaMemoryExplicitEmbeddingRepository
>;
