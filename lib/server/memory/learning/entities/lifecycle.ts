import { Prisma } from "@prisma/client";
import type { MemoryTransaction } from "../../persistence/transaction";
import { memoryAdmissibleEntityAliasPredicate } from "./authority";

/** Synchronously retires automatic-only roots after their final authoritative
 * alias support is fenced. Historical merged children remain redirects and
 * can never promote themselves. */
export async function retractUnsupportedAutomaticMemoryEntities(
  tx: MemoryTransaction,
  userId: string,
  entityIds: readonly string[] = []
): Promise<number> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  return tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryEntity" AS entity
    SET
      "state" = 'RETRACTED'::"MemoryEntityState",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE entity."userId" = ${userId}
      AND entity."state" = 'ACTIVE'::"MemoryEntityState"
      AND entity."mergedIntoId" IS NULL
      AND entity."automaticOnly" = TRUE
      AND ${ids.length === 0
        ? Prisma.sql`TRUE`
        : Prisma.sql`entity."id" IN (${Prisma.join(ids)})`}
      AND (
        EXISTS (
          SELECT 1
          FROM "MemoryEntityAlias" AS historical_alias
          WHERE historical_alias."userId" = entity."userId"
            AND aiqsa_memory_entity_root_id(
              historical_alias."userId", historical_alias."entityId"
            ) = entity."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryFactVersionEntity" AS historical_link
          WHERE historical_link."userId" = entity."userId"
            AND aiqsa_memory_entity_root_id(
              historical_link."userId", historical_link."entityId"
            ) = entity."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryFact" AS historical_fact
          WHERE historical_fact."userId" = entity."userId"
            AND aiqsa_memory_entity_root_id(
              historical_fact."userId", historical_fact."subjectEntityId"
            ) = entity."id"
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryEntityAlias" AS alias
        WHERE alias."userId" = entity."userId"
          AND aiqsa_memory_entity_root_id(
            alias."userId", alias."entityId"
          ) = entity."id"
          AND ${memoryAdmissibleEntityAliasPredicate(
            userId,
            Prisma.sql`alias."id"`,
            { includePendingClassification: true }
          )}
      )
  `);
}

/**
 * Removes automatic entity links once their semantic version has no direct
 * evidence left. Alias supports are evidence-owned and disappear through the
 * database cascade; the zero-support trigger then removes the alias itself.
 */
export async function removeUnsupportedMemoryEntityLinks(
  tx: MemoryTransaction,
  userId: string,
  factVersionIds: readonly string[]
): Promise<void> {
  if (factVersionIds.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MemoryFactVersionEntity" AS link
    USING "MemoryFactVersion" AS version
    WHERE link."userId" = ${userId}
      AND link."factVersionId" IN (${Prisma.join(factVersionIds)})
      AND version."userId" = link."userId"
      AND version."id" = link."factVersionId"
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryEvidence" AS evidence
        WHERE evidence."userId" = link."userId"
          AND evidence."factVersionId" = link."factVersionId"
          AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      )
  `);
  await pruneUnreferencedMemoryEntities(tx, userId);
}

/**
 * Deletes only entity rows with no semantic or alias reference. Iteration is
 * required because merged roots are protected until every unreferenced child
 * has been removed.
 */
export async function pruneUnreferencedMemoryEntities(
  tx: MemoryTransaction,
  userId: string
): Promise<void> {
  while (true) {
    const deleted = await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemoryEntity" AS entity
      WHERE entity."userId" = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM "MemoryFactVersionEntity" AS link
          WHERE link."userId" = entity."userId"
            AND link."entityId" = entity."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "MemoryEntityAlias" AS alias
          WHERE alias."userId" = entity."userId"
            AND alias."entityId" = entity."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "MemoryEntity" AS child
          WHERE child."userId" = entity."userId"
            AND child."mergedIntoId" = entity."id"
        )
    `);
    if (deleted === 0) return;
  }
}
