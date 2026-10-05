import { Prisma } from "@prisma/client";
import { memoryEntityRootIsActivePredicate } from "../learning/entities/authority";
import { memoryPersistenceFailure } from "../persistence/errors";
import {
  advanceMemoryMutation,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../persistence/transaction";
import { memoryMaintenanceProtectedFactPredicate } from "./source";

/** A current automatic fact, outside protected lineages, whose subject entity
 * no longer reaches an ACTIVE root: an earlier release retracted the root
 * while the fact kept its source. A retracted root is terminal, so the
 * entity-root fence keeps the fact out of standing context, search and review
 * for good. Callers expose `fact` and its current `version`. */
export function memoryRetractedSubjectFactPredicate(userId: string | Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(fact."state" = 'ACTIVE'::"MemoryFactState"
    AND fact."subjectEntityId" IS NOT NULL
    AND NOT ${memoryEntityRootIsActivePredicate(userId, Prisma.sql`fact."subjectEntityId"`)}
    AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
    AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
    AND NOT ${memoryMaintenanceProtectedFactPredicate()})`;
}

type RetractedSubjectFact = Readonly<{
  factId: string;
  systemFrom: Date;
  versionId: string;
}>;

/** Retires the owner's facts of memoryRetractedSubjectFactPredicate in the
 * governed shape of a lost source support: a SYSTEM SOURCE_INVALIDATE event,
 * RETRACTED version and fact, removed search entries and an advanced Memory
 * revision, without a model call. Retracted facts and roots are never
 * reactivated; a later observation learns under a fresh entity. The caller
 * holds the owner's locked settings, which precede fact row locks. */
export async function retireMemoryFactsWithRetractedSubjects(
  tx: MemoryTransaction,
  settings: LockedMemorySettings
): Promise<number> {
  const userId = settings.userId;
  const facts = await tx.$queryRaw<RetractedSubjectFact[]>(Prisma.sql`
    SELECT fact."id" AS "factId", version."id" AS "versionId", version."systemFrom"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."id" = fact."currentVersionId"
    WHERE fact."userId" = ${userId}
      AND ${memoryRetractedSubjectFactPredicate(userId)}
    ORDER BY fact."id"
    FOR UPDATE OF fact
  `);
  if (facts.length === 0) return 0;
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  const now = Date.now();
  for (const fact of facts) {
    await tx.memoryEvent.create({
      data: {
        actorType: "SYSTEM",
        factId: fact.factId,
        factVersionId: fact.versionId,
        metadata: {
          outcome: "FACT_RETRACTED",
          reason: "subject_entity_retracted",
          schemaVersion: "memory-fact-subject-retraction-v1"
        },
        operation: "SOURCE_INVALIDATE",
        userId
      }
    });
    const version = await tx.memoryFactVersion.updateMany({
      data: {
        state: "RETRACTED",
        systemTo: new Date(Math.max(now, fact.systemFrom.getTime() + 1))
      },
      where: {
        factId: fact.factId,
        id: fact.versionId,
        state: "ACTIVE",
        systemTo: null,
        userId
      }
    });
    const logical = await tx.memoryFact.updateMany({
      data: { currentVersionId: null, state: "RETRACTED" },
      where: {
        currentVersionId: fact.versionId,
        id: fact.factId,
        state: "ACTIVE",
        userId
      }
    });
    if (version.count !== 1 || logical.count !== 1) {
      memoryPersistenceFailure("memory_fact_version_stale");
    }
  }
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MemorySearchEntry" AS search
    USING "MemoryFactVersion" AS version
    WHERE search."userId" = ${userId}
      AND version."userId" = search."userId"
      AND version."id" = search."factVersionId"
      AND version."factId" IN (${Prisma.join(facts.map(({ factId }) => factId))})
  `);
  return facts.length;
}
