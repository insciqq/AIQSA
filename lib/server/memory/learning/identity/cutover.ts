import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../../prisma";
import { enqueueMemoryJob } from "../../persistence/jobs";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  memoryFactExtractionJobFingerprint
} from "../extraction/contract";

export type MemoryIdentityCutoverInventory = Readonly<{
  collidingLegacyEntityKeys: number;
  collidingLegacyFactKeys: number;
  legacyEntityCount: number;
  legacyFactCount: number;
  mappedLegacyEntityCount: number;
  mappedLegacyFactCount: number;
  pendingRebuildJobs: number;
  readyForUnicodeWrites: boolean;
  unicodeEntityCount: number;
  unicodeFactCount: number;
  unmappedLegacyEntityCount: number;
  unmappedLegacyFactCount: number;
}>;

type InventoryRow = Readonly<{
  collidingLegacyEntityKeys: bigint;
  collidingLegacyFactKeys: bigint;
  legacyEntityCount: bigint;
  legacyFactCount: bigint;
  mappedLegacyEntityCount: bigint;
  mappedLegacyFactCount: bigint;
  pendingRebuildJobs: bigint;
  unicodeEntityCount: bigint;
  unicodeFactCount: bigint;
  unmappedLegacyEntityCount: bigint;
  unmappedLegacyFactCount: bigint;
}>;

type RebuildSource = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  sourceHash: string;
  sourceMessageId: string;
  sourceRevision: number;
}>;

function boundedLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000;
}

function asNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("memory_identity_inventory_overflow");
  }
  return number;
}

export function createPrismaMemoryIdentityCutoverRepository(
  client: PrismaClient = prisma
) {
  async function inventoryFor(
    userId: string | null
  ): Promise<MemoryIdentityCutoverInventory> {
    const factOwner = userId === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`fact."userId" = ${userId}`;
    const entityOwner = userId === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`entity."userId" = ${userId}`;
    const jobOwner = userId === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`job."userId" = ${userId}`;
    const [row] = await client.$queryRaw<InventoryRow[]>(Prisma.sql`
      WITH fact_mappings AS (
        SELECT fact."id",
          COUNT(DISTINCT compatibility."unicodeKeyHash") AS mapping_count
        FROM "MemoryFact" AS fact
        LEFT JOIN "MemoryIdentityCompatibility" AS compatibility
          ON compatibility."userId" = fact."userId"
          AND compatibility."namespace" = 'FACT'
          AND compatibility."containerId" = fact."scopeId"
          AND compatibility."legacyKeyHash" =
            encode(digest(fact."canonicalKey", 'sha256'), 'hex')
        WHERE ${factOwner}
          AND fact."identityVersion" IN ('proposition-v1', 'slot-v2')
          AND fact."category" <> 'patterns'
        GROUP BY fact."id"
      ), entity_mappings AS (
        SELECT entity."id",
          COUNT(DISTINCT compatibility."unicodeKeyHash") AS mapping_count
        FROM "MemoryEntity" AS entity
        LEFT JOIN "MemoryIdentityCompatibility" AS compatibility
          ON compatibility."userId" = entity."userId"
          AND compatibility."namespace" = CASE
            WHEN entity."canonicalKey" LIKE 'entity:v3:%'
              THEN 'GROUNDED_ENTITY'
            ELSE 'LABEL_ENTITY'
          END
          AND compatibility."containerId" = 'ENTITY'
          AND compatibility."legacyKeyHash" =
            encode(digest(entity."canonicalKey", 'sha256'), 'hex')
        WHERE ${entityOwner}
          AND entity."canonicalKey" ~ '^entity:v[23]:'
        GROUP BY entity."id"
      )
      SELECT
        (SELECT COUNT(*) FROM fact_mappings
          WHERE mapping_count > 1) AS "collidingLegacyFactKeys",
        (SELECT COUNT(*) FROM entity_mappings
          WHERE mapping_count > 1) AS "collidingLegacyEntityKeys",
        (SELECT COUNT(*) FROM "MemoryFact" AS fact
          WHERE ${factOwner}
            AND fact."identityVersion" IN (
              'proposition-v1', 'slot-v2'
            )
            AND fact."category" <> 'patterns') AS "legacyFactCount",
        (SELECT COUNT(*) FROM "MemoryEntity" AS entity
          WHERE ${entityOwner}
            AND entity."canonicalKey" ~ '^entity:v[23]:') AS "legacyEntityCount",
        (SELECT COUNT(*) FROM fact_mappings
          WHERE mapping_count = 1) AS "mappedLegacyFactCount",
        (SELECT COUNT(*) FROM entity_mappings
          WHERE mapping_count = 1) AS "mappedLegacyEntityCount",
        (SELECT COUNT(*) FROM "MemoryJob" AS job
          WHERE ${jobOwner}
            AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
            AND job."pipelineVersion" = ${MEMORY_FACT_EXTRACTION_PIPELINE_VERSION}
            AND job."state" IN (
              'CLAIMED'::"MemoryJobState",
              'QUEUED'::"MemoryJobState",
              'RETRYABLE_FAILED'::"MemoryJobState",
              'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
            )) AS "pendingRebuildJobs",
        (SELECT COUNT(*) FROM "MemoryFact" AS fact
          WHERE ${factOwner}
            AND fact."identityVersion" IN (
              'proposition-v2', 'slot-v4'
            )
            AND fact."category" <> 'patterns') AS "unicodeFactCount",
        (SELECT COUNT(*) FROM "MemoryEntity" AS entity
          WHERE ${entityOwner}
            AND entity."canonicalKey" LIKE 'entity:v4:%') AS "unicodeEntityCount",
        (SELECT COUNT(*) FROM fact_mappings
          WHERE mapping_count = 0) AS "unmappedLegacyFactCount",
        (SELECT COUNT(*) FROM entity_mappings
          WHERE mapping_count = 0) AS "unmappedLegacyEntityCount"
    `);
    if (!row) throw new Error("memory_identity_inventory_unavailable");
    const result = {
      collidingLegacyEntityKeys: asNumber(row.collidingLegacyEntityKeys),
      collidingLegacyFactKeys: asNumber(row.collidingLegacyFactKeys),
      legacyEntityCount: asNumber(row.legacyEntityCount),
      legacyFactCount: asNumber(row.legacyFactCount),
      mappedLegacyEntityCount: asNumber(row.mappedLegacyEntityCount),
      mappedLegacyFactCount: asNumber(row.mappedLegacyFactCount),
      pendingRebuildJobs: asNumber(row.pendingRebuildJobs),
      unicodeEntityCount: asNumber(row.unicodeEntityCount),
      unicodeFactCount: asNumber(row.unicodeFactCount),
      unmappedLegacyEntityCount: asNumber(row.unmappedLegacyEntityCount),
      unmappedLegacyFactCount: asNumber(row.unmappedLegacyFactCount)
    };
    return Object.freeze({
      ...result,
      readyForUnicodeWrites:
        result.collidingLegacyEntityKeys === 0 &&
        result.collidingLegacyFactKeys === 0 &&
        result.pendingRebuildJobs === 0 &&
        result.unmappedLegacyEntityCount === 0 &&
        result.unmappedLegacyFactCount === 0
    });
  }

  async function reconcile(
    userId: string,
    limit = 100
  ): Promise<Readonly<{ existing: number; queued: number; sourceUnavailable: number }>> {
    if (!boundedLimit(limit)) throw new Error("memory_identity_rebuild_limit_invalid");
    return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
      const sources = await tx.$queryRaw<RebuildSource[]>(Prisma.sql`
        WITH rebuild_message AS (
          SELECT evidence."messageId"
          FROM "MemoryFact" AS fact
          INNER JOIN "MemoryFactVersion" AS version
            ON version."userId" = fact."userId"
            AND version."factId" = fact."id"
          INNER JOIN "MemoryEvidence" AS evidence
            ON evidence."userId" = version."userId"
            AND evidence."factVersionId" = version."id"
            AND evidence."messageId" IS NOT NULL
          LEFT JOIN "MemoryIdentityCompatibility" AS compatibility
            ON compatibility."userId" = fact."userId"
            AND compatibility."namespace" = 'FACT'
            AND compatibility."containerId" = fact."scopeId"
            AND compatibility."legacyKeyHash" =
              encode(digest(fact."canonicalKey", 'sha256'), 'hex')
          WHERE fact."userId" = ${userId}
            AND fact."identityVersion" IN ('proposition-v1', 'slot-v2')
            AND fact."category" <> 'patterns'
            AND compatibility."id" IS NULL
          UNION
          SELECT evidence."messageId"
          FROM "MemoryEntity" AS entity
          INNER JOIN "MemoryFactVersionEntity" AS entity_link
            ON entity_link."userId" = entity."userId"
            AND entity_link."entityId" = entity."id"
          INNER JOIN "MemoryFactVersion" AS version
            ON version."userId" = entity_link."userId"
            AND version."id" = entity_link."factVersionId"
          INNER JOIN "MemoryEvidence" AS evidence
            ON evidence."userId" = version."userId"
            AND evidence."factVersionId" = version."id"
            AND evidence."messageId" IS NOT NULL
          LEFT JOIN "MemoryIdentityCompatibility" AS compatibility
            ON compatibility."userId" = entity."userId"
            AND compatibility."namespace" = CASE
              WHEN entity."canonicalKey" LIKE 'entity:v3:%'
                THEN 'GROUNDED_ENTITY'
              ELSE 'LABEL_ENTITY'
            END
            AND compatibility."containerId" = 'ENTITY'
            AND compatibility."legacyKeyHash" =
              encode(digest(entity."canonicalKey", 'sha256'), 'hex')
          WHERE entity."userId" = ${userId}
            AND entity."canonicalKey" ~ '^entity:v[23]:'
            AND compatibility."id" IS NULL
        )
        SELECT DISTINCT ON (job."sourceMessageId")
          job."activeLeafMessageId", job."branchGeneration", job."chatId",
          job."sourceHash", job."sourceMessageId", job."sourceRevision"
        FROM rebuild_message
        INNER JOIN "MemoryJob" AS job
          ON job."userId" = ${userId}
          AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
          AND job."sourceMessageId" = rebuild_message."messageId"
          AND job."activeLeafMessageId" IS NOT NULL
          AND job."branchGeneration" IS NOT NULL
          AND job."chatId" IS NOT NULL
          AND job."sourceHash" IS NOT NULL
          AND job."sourceRevision" IS NOT NULL
        ORDER BY job."sourceMessageId", job."createdAt" DESC, job."id" DESC
        LIMIT ${limit}
      `);
      let existing = 0;
      let queued = 0;
      for (const source of sources) {
        const sourceIdentity = {
          ...source,
          memoryGenerationSnapshot: settings.memoryGeneration,
          userId
        };
        const result = await enqueueMemoryJob(tx, settings, {
          idempotencyFingerprint: memoryFactExtractionJobFingerprint(
            sourceIdentity,
            "UNICODE_V2"
          ),
          kind: "EXTRACT_FACTS",
          pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
          source
        });
        if (result.created) queued += 1;
        else existing += 1;
      }
      const [unavailable] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT (
          SELECT COUNT(*)
          FROM "MemoryFact" AS fact
          WHERE fact."userId" = ${userId}
            AND fact."identityVersion" IN ('proposition-v1', 'slot-v2')
            AND fact."category" <> 'patterns'
            AND NOT EXISTS (
              SELECT 1
              FROM "MemoryIdentityCompatibility" AS compatibility
              WHERE compatibility."userId" = fact."userId"
                AND compatibility."namespace" = 'FACT'
                AND compatibility."containerId" = fact."scopeId"
                AND compatibility."legacyKeyHash" =
                  encode(digest(fact."canonicalKey", 'sha256'), 'hex')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "MemoryFactVersion" AS version
              INNER JOIN "MemoryEvidence" AS evidence
                ON evidence."userId" = version."userId"
                AND evidence."factVersionId" = version."id"
                AND evidence."messageId" IS NOT NULL
              INNER JOIN "MemoryJob" AS job
                ON job."userId" = evidence."userId"
                AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
                AND job."sourceMessageId" = evidence."messageId"
                AND job."activeLeafMessageId" IS NOT NULL
                AND job."branchGeneration" IS NOT NULL
                AND job."chatId" IS NOT NULL
                AND job."sourceHash" IS NOT NULL
                AND job."sourceRevision" IS NOT NULL
              WHERE version."userId" = fact."userId"
                AND version."factId" = fact."id"
            )
        ) + (
          SELECT COUNT(*)
          FROM "MemoryEntity" AS entity
          WHERE entity."userId" = ${userId}
            AND entity."canonicalKey" ~ '^entity:v[23]:'
            AND NOT EXISTS (
              SELECT 1
              FROM "MemoryIdentityCompatibility" AS compatibility
              WHERE compatibility."userId" = entity."userId"
                AND compatibility."namespace" = CASE
                  WHEN entity."canonicalKey" LIKE 'entity:v3:%'
                    THEN 'GROUNDED_ENTITY'
                  ELSE 'LABEL_ENTITY'
                END
                AND compatibility."containerId" = 'ENTITY'
                AND compatibility."legacyKeyHash" =
                  encode(digest(entity."canonicalKey", 'sha256'), 'hex')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "MemoryFactVersionEntity" AS entity_link
              INNER JOIN "MemoryEvidence" AS evidence
                ON evidence."userId" = entity_link."userId"
                AND evidence."factVersionId" = entity_link."factVersionId"
                AND evidence."messageId" IS NOT NULL
              INNER JOIN "MemoryJob" AS job
                ON job."userId" = evidence."userId"
                AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
                AND job."sourceMessageId" = evidence."messageId"
                AND job."activeLeafMessageId" IS NOT NULL
                AND job."branchGeneration" IS NOT NULL
                AND job."chatId" IS NOT NULL
                AND job."sourceHash" IS NOT NULL
                AND job."sourceRevision" IS NOT NULL
              WHERE entity_link."userId" = entity."userId"
                AND entity_link."entityId" = entity."id"
            )
        ) AS count
      `);
      return Object.freeze({
        existing,
        queued,
        sourceUnavailable: asNumber(unavailable?.count ?? 0n)
      });
    });
  }

  return Object.freeze({
    async assertActivationReady(userId: string) {
      const current = await inventoryFor(userId);
      if (!current.readyForUnicodeWrites) {
        throw new Error("memory_identity_activation_not_ready");
      }
      return current;
    },
    inventory(userId: string) {
      return inventoryFor(userId);
    },
    inventoryAll() {
      return inventoryFor(null);
    },
    reconcile
  });
}
