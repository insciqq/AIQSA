import { Prisma } from "@prisma/client";
import type { MemoryPurgeTarget } from "../purge/contract";
import type { MemoryDeletionContributor } from "../purge/registry";
import { memoryPurgeVersionCondition } from "../purge/selection";
import type { MemoryTransaction } from "../persistence/transaction";

function countFrom(rows: readonly Readonly<{ count: number }>[]): number {
  const count = rows[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_profile_purge_count_invalid");
  }
  return count;
}

export async function countInvalidMemoryProfileProjections(
  tx: MemoryTransaction,
  userId: string
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(DISTINCT profile."id")::integer AS "count"
    FROM "MemoryProfileProjection" AS profile
    INNER JOIN "MemoryProfileProjectionFact" AS contributor
      ON contributor."userId" = profile."userId"
      AND contributor."projectionId" = profile."id"
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = contributor."userId"
      AND fact."id" = contributor."factId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = contributor."userId"
      AND version."factId" = contributor."factId"
      AND version."id" = contributor."factVersionId"
    LEFT JOIN "UserMemorySettings" AS settings
      ON settings."userId" = profile."userId"
    LEFT JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    LEFT JOIN "MemorySearchEntry" AS search
      ON search."userId" = contributor."userId"
      AND search."indexGenerationId" = settings."activeIndexGenerationId"
      AND search."factVersionId" = contributor."factVersionId"
    WHERE profile."userId" = ${userId}
      AND profile."plaintextPurgedAt" IS NULL
      AND (
        settings."userId" IS NULL
        OR NOT settings."useMemoryFacts"
        OR fact."scopeId" IS DISTINCT FROM profile."scopeId"
        OR fact."state" <> 'ACTIVE'::"MemoryFactState"
        OR fact."currentVersionId" IS DISTINCT FROM contributor."factVersionId"
        OR scope."state" <> 'ACTIVE'::"MemoryScopeState"
        OR version."state" <> 'ACTIVE'::"MemoryFactVersionState"
        OR version."systemTo" IS NOT NULL
        OR version."contentPurgedAt" IS NOT NULL
        OR version."displayText" IS NULL
        OR version."sensitivityClass" <> 'NORMAL'::"MemorySensitivityClass"
        OR search."id" IS NULL
        OR search."safeContentHash" IS DISTINCT FROM
          contributor."factVersionContentHash"
        OR search."sourceIdentitySnapshot" IS DISTINCT FROM
          contributor."sourceIdentitySnapshot"
        OR search."safetyIdentitySnapshot" IS DISTINCT FROM
          contributor."safetyIdentitySnapshot"
        OR search."suppressionIdentitySnapshot" IS DISTINCT FROM
          contributor."suppressionIdentitySnapshot"
      )
  `);
  return countFrom(rows);
}

export async function purgeInvalidMemoryProfileProjections(
  tx: MemoryTransaction,
  userId: string,
  reason = "source_invalidated"
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    WITH affected AS MATERIALIZED (
      SELECT DISTINCT profile."id"
      FROM "MemoryProfileProjection" AS profile
      INNER JOIN "MemoryProfileProjectionFact" AS contributor
        ON contributor."userId" = profile."userId"
        AND contributor."projectionId" = profile."id"
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = contributor."userId"
        AND fact."id" = contributor."factId"
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = contributor."userId"
        AND version."factId" = contributor."factId"
        AND version."id" = contributor."factVersionId"
      LEFT JOIN "UserMemorySettings" AS settings
        ON settings."userId" = profile."userId"
      LEFT JOIN "MemoryScope" AS scope
        ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      LEFT JOIN "MemorySearchEntry" AS search
        ON search."userId" = contributor."userId"
        AND search."indexGenerationId" = settings."activeIndexGenerationId"
        AND search."factVersionId" = contributor."factVersionId"
      WHERE profile."userId" = ${userId}
        AND profile."plaintextPurgedAt" IS NULL
        AND (
          settings."userId" IS NULL
          OR NOT settings."useMemoryFacts"
          OR fact."scopeId" IS DISTINCT FROM profile."scopeId"
          OR fact."state" <> 'ACTIVE'::"MemoryFactState"
          OR fact."currentVersionId" IS DISTINCT FROM contributor."factVersionId"
          OR scope."state" <> 'ACTIVE'::"MemoryScopeState"
          OR version."state" <> 'ACTIVE'::"MemoryFactVersionState"
          OR version."systemTo" IS NOT NULL
          OR version."contentPurgedAt" IS NOT NULL
          OR version."displayText" IS NULL
          OR version."sensitivityClass" <> 'NORMAL'::"MemorySensitivityClass"
          OR search."id" IS NULL
          OR search."safeContentHash" IS DISTINCT FROM
            contributor."factVersionContentHash"
          OR search."sourceIdentitySnapshot" IS DISTINCT FROM
            contributor."sourceIdentitySnapshot"
          OR search."safetyIdentitySnapshot" IS DISTINCT FROM
            contributor."safetyIdentitySnapshot"
          OR search."suppressionIdentitySnapshot" IS DISTINCT FROM
            contributor."suppressionIdentitySnapshot"
        )
    ), deleted AS (
      DELETE FROM "MemoryProfileProjectionFact" AS contributor
      USING affected
      WHERE contributor."userId" = ${userId}
        AND contributor."projectionId" = affected."id"
      RETURNING contributor."projectionId"
    )
    UPDATE "MemoryProfileProjection" AS profile
    SET
      "state" = 'INVALIDATED'::"MemoryProfileProjectionState",
      "summary" = NULL,
      "safeContentHash" = NULL,
      "redactionState" = 'EXCLUDED'::"MemoryRedactionState",
      "plaintextPurgedAt" = GREATEST(profile."updatedAt", CURRENT_TIMESTAMP),
      "purgeReason" = ${reason},
      "updatedAt" = GREATEST(profile."updatedAt", CURRENT_TIMESTAMP)
    FROM affected
    WHERE profile."userId" = ${userId}
      AND profile."id" = affected."id"
      AND profile."plaintextPurgedAt" IS NULL
  `);
}

async function targetedProjectionCount(
  tx: MemoryTransaction,
  target: MemoryPurgeTarget
): Promise<number> {
  if (target.kind === "ALL_REUSABLE") {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::integer AS "count"
      FROM "MemoryProfileProjection" AS profile
      WHERE profile."userId" = ${target.userId}
        AND profile."createdAt" <= (
          SELECT barrier."createdAt"
          FROM "MemorySourceBarrier" AS barrier
          WHERE barrier."userId" = ${target.userId}
            AND barrier."id" = ${target.targetId}
            AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
    `);
    return countFrom(rows);
  }
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(DISTINCT profile."id")::integer AS "count"
    FROM "MemoryProfileProjection" AS profile
    INNER JOIN "MemoryProfileProjectionFact" AS contributor
      ON contributor."userId" = profile."userId"
      AND contributor."projectionId" = profile."id"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = contributor."userId"
      AND version."factId" = contributor."factId"
      AND version."id" = contributor."factVersionId"
    WHERE profile."userId" = ${target.userId}
      AND ${memoryPurgeVersionCondition(target)}
  `);
  return countFrom(rows);
}

export const memoryProfileDeletionContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    return targetedProjectionCount(tx, target);
  },
  id: "profile-projections",
  async purge(tx, target) {
    if (target.kind === "ALL_REUSABLE") {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "MemoryProfileProjection" AS profile
        WHERE profile."userId" = ${target.userId}
          AND profile."createdAt" <= (
            SELECT barrier."createdAt"
            FROM "MemorySourceBarrier" AS barrier
            WHERE barrier."userId" = ${target.userId}
              AND barrier."id" = ${target.targetId}
              AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
      `);
      return;
    }
    const reason = target.kind === "MEMORY_FACT"
      ? "fact_forgotten"
      : target.kind === "AUTOMATIC_SET"
        ? "learned_delete"
        : "explicit_delete";
    await tx.$executeRaw(Prisma.sql`
      WITH affected AS MATERIALIZED (
        SELECT DISTINCT profile."id"
        FROM "MemoryProfileProjection" AS profile
        INNER JOIN "MemoryProfileProjectionFact" AS contributor
          ON contributor."userId" = profile."userId"
          AND contributor."projectionId" = profile."id"
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = contributor."userId"
          AND version."factId" = contributor."factId"
          AND version."id" = contributor."factVersionId"
        WHERE profile."userId" = ${target.userId}
          AND ${memoryPurgeVersionCondition(target)}
      ), deleted AS (
        DELETE FROM "MemoryProfileProjectionFact" AS contributor
        USING affected
        WHERE contributor."userId" = ${target.userId}
          AND contributor."projectionId" = affected."id"
        RETURNING contributor."projectionId"
      )
      UPDATE "MemoryProfileProjection" AS profile
      SET
        "state" = 'INVALIDATED'::"MemoryProfileProjectionState",
        "summary" = NULL,
        "safeContentHash" = NULL,
        "redactionState" = 'EXCLUDED'::"MemoryRedactionState",
        "plaintextPurgedAt" = COALESCE(
          profile."plaintextPurgedAt",
          GREATEST(profile."updatedAt", CURRENT_TIMESTAMP)
        ),
        "purgeReason" = COALESCE(profile."purgeReason", ${reason}),
        "updatedAt" = GREATEST(profile."updatedAt", CURRENT_TIMESTAMP)
      FROM affected
      WHERE profile."userId" = ${target.userId}
        AND profile."id" = affected."id"
    `);
  },
  version: "v1"
});
