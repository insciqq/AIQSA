import { Prisma } from "@prisma/client";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryTransaction } from "../persistence/transaction";
import type { MemoryPurgeTarget } from "./contract";
import type { MemoryDeletionContributor } from "./registry";
import { memoryPurgeVersionCondition } from "./selection";

type AllReusableBarrier = Readonly<{
  createdAt: Date;
  memoryGeneration: number;
}>;

function countFrom(rows: readonly Readonly<{ count: number }>[]): number {
  const count = rows[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new MemoryCoordinatorError("memory_purge_audit_invalid", true);
  }
  return count;
}

async function barrierFor(
  tx: MemoryTransaction,
  target: MemoryPurgeTarget
): Promise<AllReusableBarrier> {
  const barrier = await tx.memorySourceBarrier.findFirst({
    select: { createdAt: true, memoryGeneration: true },
    where: { id: target.targetId, kind: "ALL_REUSABLE", userId: target.userId }
  });
  if (!barrier) {
    throw new MemoryCoordinatorError("memory_deletion_target_invalid", true);
  }
  return barrier;
}

function oldJobCondition(target: MemoryPurgeTarget): Prisma.Sql {
  return Prisma.sql`
    job."userId" = ${target.userId}
    AND (
      job."createdAt" <= (
        SELECT barrier."createdAt"
        FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = ${target.userId}
          AND barrier."id" = ${target.targetId}
          AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
      )
      OR job."memoryGenerationSnapshot" < (
        SELECT barrier."memoryGeneration"
        FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = ${target.userId}
          AND barrier."id" = ${target.targetId}
          AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
      )
    )
  `;
}

export const allReusableLedgerContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    if (target.kind !== "ALL_REUSABLE") return 0;
    const barrier = await barrierFor(tx, target);
    const [authorizationRows, eventRows, factRows, receiptRows, scopeRows, suppressionRows] =
      await Promise.all([
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemoryMutationAuthorization" AS auth
          WHERE auth."userId" = ${target.userId}
            AND auth."action" <> 'BULK_DELETE'::"MemoryMutationAction"
            AND (
              auth."createdAt" <= ${barrier.createdAt}
              OR EXISTS (
                SELECT 1
                FROM "MemoryFactVersion" AS version
                WHERE version."userId" = auth."userId"
                  AND version."factId" = auth."targetFactId"
                  AND version."id" = auth."expectedTargetVersionId"
                  AND ${memoryPurgeVersionCondition(target)}
              )
            )
        `),
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemoryEvent" AS event
          WHERE event."userId" = ${target.userId}
            AND event."createdAt" <= ${barrier.createdAt}
            AND (
              event."sourceChatId" IS NOT NULL
              OR event."sourceGeneration" IS NOT NULL
              OR event."metadata" <> '{"schemaVersion":"memory-event-purged-v1"}'::jsonb
            )
        `),
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemoryFact" AS fact
          WHERE fact."userId" = ${target.userId}
            AND fact."createdAt" <= ${barrier.createdAt}
            AND NOT EXISTS (
              SELECT 1
              FROM "MemoryFactVersion" AS future_version
              WHERE future_version."userId" = fact."userId"
                AND future_version."factId" = fact."id"
                AND future_version."createdAt" > ${barrier.createdAt}
            )
        `),
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemoryOperationReceipt" AS receipt
          INNER JOIN "MemoryFactVersion" AS version
            ON version."userId" = receipt."userId"
            AND version."factId" = receipt."targetFactId"
            AND version."id" = receipt."targetVersionId"
          WHERE ${memoryPurgeVersionCondition(target)}
        `),
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemoryScope" AS scope
          WHERE scope."userId" = ${target.userId}
            AND scope."createdAt" <= ${barrier.createdAt}
            AND NOT EXISTS (
              SELECT 1 FROM "MemoryFact" AS fact
              WHERE fact."userId" = scope."userId" AND fact."scopeId" = scope."id"
            )
        `),
        tx.memorySuppression.count({
          where: { createdAt: { lte: barrier.createdAt }, userId: target.userId }
        })
      ]);
    return countFrom(authorizationRows) + countFrom(eventRows) + countFrom(factRows) +
      countFrom(receiptRows) + countFrom(scopeRows) + suppressionRows;
  },
  id: "all-reusable-ledger",
  async purge(tx, target) {
    if (target.kind !== "ALL_REUSABLE") return;
    const barrier = await barrierFor(tx, target);

    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemoryMutationAuthorization" AS auth
      WHERE auth."userId" = ${target.userId}
        AND auth."action" <> 'BULK_DELETE'::"MemoryMutationAction"
        AND (
          auth."createdAt" <= ${barrier.createdAt}
          OR EXISTS (
            SELECT 1
            FROM "MemoryFactVersion" AS version
            WHERE version."userId" = auth."userId"
              AND version."factId" = auth."targetFactId"
              AND version."id" = auth."expectedTargetVersionId"
              AND ${memoryPurgeVersionCondition(target)}
          )
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "MemoryOperationReceipt" AS receipt
      SET "targetFactId" = NULL, "targetVersionId" = NULL
      FROM "MemoryFactVersion" AS version
      WHERE version."userId" = receipt."userId"
        AND version."factId" = receipt."targetFactId"
        AND version."id" = receipt."targetVersionId"
        AND ${memoryPurgeVersionCondition(target)}
    `);
    await tx.memorySuppression.deleteMany({
      where: { createdAt: { lte: barrier.createdAt }, userId: target.userId }
    });

    await tx.$executeRaw(Prisma.sql`
      WITH deletable_facts AS MATERIALIZED (
        SELECT fact."id"
        FROM "MemoryFact" AS fact
        WHERE fact."userId" = ${target.userId}
          AND fact."createdAt" <= ${barrier.createdAt}
          AND NOT EXISTS (
            SELECT 1
            FROM "MemoryFactVersion" AS future_version
            WHERE future_version."userId" = fact."userId"
              AND future_version."factId" = fact."id"
              AND future_version."createdAt" > ${barrier.createdAt}
          )
      )
      UPDATE "MemoryFact" AS fact
      SET "movedToFactId" = NULL
      WHERE fact."userId" = ${target.userId}
        AND (
          fact."id" IN (SELECT "id" FROM deletable_facts)
          OR fact."movedToFactId" IN (SELECT "id" FROM deletable_facts)
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      WITH deletable_versions AS MATERIALIZED (
        SELECT version."id"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId" AND fact."id" = version."factId"
        WHERE fact."userId" = ${target.userId}
          AND fact."createdAt" <= ${barrier.createdAt}
          AND NOT EXISTS (
            SELECT 1
            FROM "MemoryFactVersion" AS future_version
            WHERE future_version."userId" = fact."userId"
              AND future_version."factId" = fact."id"
              AND future_version."createdAt" > ${barrier.createdAt}
          )
      )
      UPDATE "MemoryFactVersion" AS version
      SET
        "state" = CASE
          WHEN version."mergedIntoVersionId" IS NOT NULL
            AND (
              version."id" IN (SELECT "id" FROM deletable_versions)
              OR version."mergedIntoVersionId" IN (
                SELECT "id" FROM deletable_versions
              )
            )
          THEN 'ORPHANED'::"MemoryFactVersionState"
          ELSE version."state"
        END,
        "mergedIntoVersionId" = CASE
          WHEN version."id" IN (SELECT "id" FROM deletable_versions)
            OR version."mergedIntoVersionId" IN (
              SELECT "id" FROM deletable_versions
            )
          THEN NULL
          ELSE version."mergedIntoVersionId"
        END,
        "movedFromVersionId" = NULL,
        "supersedesVersionId" = NULL
      WHERE version."userId" = ${target.userId}
        AND (
          version."id" IN (SELECT "id" FROM deletable_versions)
          OR version."mergedIntoVersionId" IN (
            SELECT "id" FROM deletable_versions
          )
          OR version."movedFromVersionId" IN (SELECT "id" FROM deletable_versions)
          OR version."supersedesVersionId" IN (SELECT "id" FROM deletable_versions)
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      WITH deletable_facts AS MATERIALIZED (
        SELECT fact."id"
        FROM "MemoryFact" AS fact
        WHERE fact."userId" = ${target.userId}
          AND fact."createdAt" <= ${barrier.createdAt}
          AND NOT EXISTS (
            SELECT 1
            FROM "MemoryFactVersion" AS future_version
            WHERE future_version."userId" = fact."userId"
              AND future_version."factId" = fact."id"
              AND future_version."createdAt" > ${barrier.createdAt}
          )
      )
      UPDATE "MemoryEvent" AS event
      SET
        "factId" = NULL,
        "factVersionId" = NULL,
        "metadata" = '{"schemaVersion":"memory-event-purged-v1"}'::jsonb,
        "sourceChatId" = NULL,
        "sourceGeneration" = NULL
      WHERE event."userId" = ${target.userId}
        AND event."factId" IN (SELECT "id" FROM deletable_facts)
    `);
    // A retained version must not become independently admissible merely
    // because physical purge removes its required antecedent edge. Fence the
    // retained target first, then release the source-version RESTRICT edge.
    await tx.$executeRaw(Prisma.sql`
      WITH deletable_versions AS MATERIALIZED (
        SELECT version."id"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId" AND fact."id" = version."factId"
        WHERE fact."userId" = ${target.userId}
          AND fact."createdAt" <= ${barrier.createdAt}
          AND NOT EXISTS (
            SELECT 1
            FROM "MemoryFactVersion" AS future_version
            WHERE future_version."userId" = fact."userId"
              AND future_version."factId" = fact."id"
              AND future_version."createdAt" > ${barrier.createdAt}
          )
      ), dependent_targets AS MATERIALIZED (
        SELECT DISTINCT dependency."targetFactVersionId"
        FROM "MemoryFactVersionSourceDependency" AS dependency
        WHERE dependency."userId" = ${target.userId}
          AND dependency."sourceFactVersionId" IN (
            SELECT "id" FROM deletable_versions
          )
          AND dependency."targetFactVersionId" NOT IN (
            SELECT "id" FROM deletable_versions
          )
      )
      UPDATE "MemoryFact" AS fact
      SET
        "currentVersionId" = NULL,
        "state" = 'ORPHANED'::"MemoryFactState",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE fact."userId" = ${target.userId}
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND fact."currentVersionId" IN (
          SELECT "targetFactVersionId" FROM dependent_targets
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      WITH deletable_versions AS MATERIALIZED (
        SELECT version."id"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId" AND fact."id" = version."factId"
        WHERE fact."userId" = ${target.userId}
          AND fact."createdAt" <= ${barrier.createdAt}
          AND NOT EXISTS (
            SELECT 1
            FROM "MemoryFactVersion" AS future_version
            WHERE future_version."userId" = fact."userId"
              AND future_version."factId" = fact."id"
              AND future_version."createdAt" > ${barrier.createdAt}
          )
      ), dependent_targets AS MATERIALIZED (
        SELECT DISTINCT dependency."targetFactVersionId"
        FROM "MemoryFactVersionSourceDependency" AS dependency
        WHERE dependency."userId" = ${target.userId}
          AND dependency."sourceFactVersionId" IN (
            SELECT "id" FROM deletable_versions
          )
          AND dependency."targetFactVersionId" NOT IN (
            SELECT "id" FROM deletable_versions
          )
      )
      UPDATE "MemoryFactVersion" AS version
      SET
        "state" = 'ORPHANED'::"MemoryFactVersionState",
        "systemTo" = COALESCE(
          version."systemTo",
          GREATEST(version."systemFrom" + INTERVAL '1 millisecond', CURRENT_TIMESTAMP)
        )
      WHERE version."userId" = ${target.userId}
        AND version."id" IN (
          SELECT "targetFactVersionId" FROM dependent_targets
        )
        AND version."state" IN (
          'ACTIVE'::"MemoryFactVersionState",
          'PENDING_RELATION'::"MemoryFactVersionState",
          'CONFLICTING'::"MemoryFactVersionState"
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      WITH deletable_versions AS MATERIALIZED (
        SELECT version."id"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId" AND fact."id" = version."factId"
        WHERE fact."userId" = ${target.userId}
          AND fact."createdAt" <= ${barrier.createdAt}
          AND NOT EXISTS (
            SELECT 1
            FROM "MemoryFactVersion" AS future_version
            WHERE future_version."userId" = fact."userId"
              AND future_version."factId" = fact."id"
              AND future_version."createdAt" > ${barrier.createdAt}
          )
      )
      DELETE FROM "MemoryFactVersionSourceDependency" AS dependency
      WHERE dependency."userId" = ${target.userId}
        AND dependency."sourceFactVersionId" IN (
          SELECT "id" FROM deletable_versions
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemoryFact" AS fact
      WHERE fact."userId" = ${target.userId}
        AND fact."createdAt" <= ${barrier.createdAt}
        AND NOT EXISTS (
          SELECT 1
          FROM "MemoryFactVersion" AS future_version
          WHERE future_version."userId" = fact."userId"
            AND future_version."factId" = fact."id"
            AND future_version."createdAt" > ${barrier.createdAt}
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemoryEvent" AS event
      WHERE event."userId" = ${target.userId}
        AND event."createdAt" <= ${barrier.createdAt}
        AND NOT EXISTS (
          SELECT 1
          FROM "MemoryFactVersion" AS version
          WHERE version."userId" = event."userId"
            AND version."createdByEventId" = event."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "MemoryEvidence" AS evidence
          WHERE evidence."userId" = event."userId"
            AND evidence."memoryEventId" = event."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "MemoryFeedback" AS feedback
          WHERE feedback."userId" = event."userId"
            AND feedback."memoryEventId" = event."id"
        )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemoryScope" AS scope
      WHERE scope."userId" = ${target.userId}
        AND scope."createdAt" <= ${barrier.createdAt}
        AND NOT EXISTS (
          SELECT 1 FROM "MemoryFact" AS fact
          WHERE fact."userId" = scope."userId" AND fact."scopeId" = scope."id"
        )
    `);
  },
  version: "v1"
});

export const allReusableWorkContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    if (target.kind !== "ALL_REUSABLE") return 0;
    const barrier = await barrierFor(tx, target);
    const [checkpointRows, jobRows] = await Promise.all([
      tx.chatMemoryCheckpoint.count({
        where: { createdAt: { lte: barrier.createdAt }, userId: target.userId }
      }),
      tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS "count"
        FROM "MemoryJob" AS job
        WHERE ${oldJobCondition(target)}
      `)
    ]);
    return checkpointRows + countFrom(jobRows);
  },
  id: "all-reusable-work",
  async purge(tx, target) {
    if (target.kind !== "ALL_REUSABLE") return;
    const barrier = await barrierFor(tx, target);
    await tx.chatMemoryCheckpoint.deleteMany({
      where: { createdAt: { lte: barrier.createdAt }, userId: target.userId }
    });
    await tx.$executeRaw(Prisma.sql`
      UPDATE "UsageEvent" AS usage
      SET "memoryExecutionBindingId" = NULL
      FROM "MemoryExecutionBinding" AS binding
      INNER JOIN "MemoryJob" AS job
        ON job."userId" = binding."userId" AND job."id" = binding."memoryJobId"
      WHERE usage."userId" = binding."userId"
        AND usage."memoryExecutionBindingId" = binding."id"
        AND ${oldJobCondition(target)}
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemoryJob" AS job
      WHERE ${oldJobCondition(target)}
    `);
  },
  version: "v1"
});

function protectedGenerationCte(target: MemoryPurgeTarget): Prisma.Sql {
  return Prisma.sql`
    WITH RECURSIVE protected("id") AS (
      SELECT generation."id"
      FROM "MemoryIndexGeneration" AS generation
      WHERE generation."userId" = ${target.userId}
        AND (
          generation."createdAt" > (
            SELECT barrier."createdAt"
            FROM "MemorySourceBarrier" AS barrier
            WHERE barrier."userId" = ${target.userId}
              AND barrier."id" = ${target.targetId}
              AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
          OR EXISTS (
            SELECT 1 FROM "ModelRunMemoryBinding" AS binding
            WHERE binding."userId" = generation."userId"
              AND binding."indexGenerationId" = generation."id"
          )
          OR EXISTS (
            SELECT 1 FROM "MemoryRetrievalAttempt" AS attempt
            WHERE attempt."userId" = generation."userId"
              AND attempt."indexGenerationIdSnapshot" = generation."id"
              AND attempt."state" = 'CONSUMED'::"MemoryRetrievalAttemptState"
          )
        )
      UNION
      SELECT parent."id"
      FROM protected AS selected
      INNER JOIN "MemoryIndexGeneration" AS child ON child."id" = selected."id"
      INNER JOIN "MemoryIndexGeneration" AS parent
        ON parent."userId" = child."userId"
        AND parent."id" = child."sourceIndexGenerationId"
    )
  `;
}

export const allReusableIndexesContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    if (target.kind !== "ALL_REUSABLE") return 0;
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      ${protectedGenerationCte(target)}
      SELECT (
        SELECT COUNT(*)
        FROM "MemoryIndexGeneration" AS generation
        WHERE generation."userId" = ${target.userId}
          AND generation."createdAt" <= (
            SELECT barrier."createdAt"
            FROM "MemorySourceBarrier" AS barrier
            WHERE barrier."userId" = ${target.userId}
              AND barrier."id" = ${target.targetId}
              AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
          AND NOT EXISTS (SELECT 1 FROM protected WHERE protected."id" = generation."id")
      )::integer + (
        SELECT COUNT(*)
        FROM "MemorySearchEntry" AS search
        INNER JOIN "MemoryIndexGeneration" AS generation
          ON generation."userId" = search."userId"
          AND generation."id" = search."indexGenerationId"
        WHERE generation."userId" = ${target.userId}
          AND generation."createdAt" <= (
            SELECT barrier."createdAt"
            FROM "MemorySourceBarrier" AS barrier
            WHERE barrier."userId" = ${target.userId}
              AND barrier."id" = ${target.targetId}
              AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
      )::integer + (
        SELECT COUNT(*)
        FROM "MemoryIndexGeneration" AS generation
        WHERE generation."userId" = ${target.userId}
          AND generation."createdAt" <= (
            SELECT barrier."createdAt"
            FROM "MemorySourceBarrier" AS barrier
            WHERE barrier."userId" = ${target.userId}
              AND barrier."id" = ${target.targetId}
              AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
          AND generation."state" IN (
            'ACTIVE'::"MemoryIndexGenerationState",
            'BUILDING'::"MemoryIndexGenerationState",
            'CATCHING_UP'::"MemoryIndexGenerationState",
            'READY'::"MemoryIndexGenerationState"
          )
      )::integer AS "count"
    `);
    return countFrom(rows);
  },
  id: "all-reusable-indexes",
  async purge(tx, target) {
    if (target.kind !== "ALL_REUSABLE") return;
    const barrier = await barrierFor(tx, target);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemorySearchEntry" AS search
      USING "MemoryIndexGeneration" AS generation
      WHERE generation."userId" = search."userId"
        AND generation."id" = search."indexGenerationId"
        AND generation."userId" = ${target.userId}
        AND generation."createdAt" <= ${barrier.createdAt}
    `);
    await tx.memoryIndexGeneration.updateMany({
      data: { state: "SUPERSEDED", supersededAt: barrier.createdAt },
      where: {
        createdAt: { lte: barrier.createdAt },
        state: "ACTIVE",
        userId: target.userId
      }
    });
    await tx.memoryIndexGeneration.updateMany({
      data: { state: "CANCELLED" },
      where: {
        createdAt: { lte: barrier.createdAt },
        state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
        userId: target.userId
      }
    });

    while (true) {
      const leaves = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        ${protectedGenerationCte(target)}
        SELECT generation."id"
        FROM "MemoryIndexGeneration" AS generation
        WHERE generation."userId" = ${target.userId}
          AND generation."createdAt" <= ${barrier.createdAt}
          AND NOT EXISTS (SELECT 1 FROM protected WHERE protected."id" = generation."id")
          AND NOT EXISTS (
            SELECT 1
            FROM "MemoryIndexGeneration" AS child
            WHERE child."userId" = generation."userId"
              AND child."sourceIndexGenerationId" = generation."id"
          )
        ORDER BY generation."generation" DESC, generation."id" DESC
        LIMIT 100
      `);
      if (leaves.length === 0) break;
      await tx.memoryIndexGeneration.deleteMany({
        where: { id: { in: leaves.map(({ id }) => id) }, userId: target.userId }
      });
    }
  },
  version: "v1"
});
