import { Prisma } from "@prisma/client";
import type { MemoryTransaction } from "../../persistence/transaction";

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
