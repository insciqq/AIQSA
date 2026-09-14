import { Prisma } from "@prisma/client";
import {
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  MEMORY_EXPLICIT_RELATION_POLICY_VERSION
} from "../learning/relations/explicitPolicy";

export type MemoryFactVersionTarget = Readonly<{ factId: string; factVersionId: string }>;
export type MemoryEquivalentTargetResolver = (
  userId: string, target: MemoryFactVersionTarget, now: Date
) => Promise<MemoryFactVersionTarget | null>;

/** Deletion includes historical equivalent versions, including aliases whose
 * current fact was later explicitly restored. Callers still fence/purge only
 * the selected lifecycle state; a later active version is not old content.
 * UNION bounds traversal to distinct owned facts even if a chain is broken. */
export function memoryExplicitEquivalentFactIdsSql(userId: string, factIds: readonly string[]): Prisma.Sql {
  if (factIds.length === 0) return Prisma.sql`SELECT NULL::text WHERE FALSE`;
  return Prisma.sql`
    WITH RECURSIVE equivalence_lineage("id") AS (
      SELECT fact."id" FROM "MemoryFact" AS fact
      WHERE fact."userId" = ${userId} AND fact."id" IN (${Prisma.join([...factIds])})
      UNION
      SELECT source_version."factId"
      FROM equivalence_lineage AS parent
      INNER JOIN "MemoryFactVersion" AS target_version
        ON target_version."userId" = ${userId} AND target_version."factId" = parent."id"
      INNER JOIN "MemoryFactVersionRelation" AS relation
        ON relation."userId" = target_version."userId" AND relation."targetVersionId" = target_version."id"
        AND relation."kind" = 'MERGED_INTO'::"MemoryFactVersionRelationKind"
        AND relation."pipelineVersion" = ${MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION}
        AND relation."reasonCode" = 'explicit_semantic_equivalence'
      INNER JOIN "MemoryFactVersion" AS source_version
        ON source_version."userId" = relation."userId" AND source_version."id" = relation."sourceVersionId"
        AND source_version."mergedIntoVersionId" = target_version."id"
      WHERE source_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND source_version."state" IN ('MERGED'::"MemoryFactVersionState", 'FORGOTTEN'::"MemoryFactVersionState")
        AND source_version."relationResolutionVersion" = ${MEMORY_EXPLICIT_RELATION_POLICY_VERSION}
        AND source_version."relationResolvedAt" IS NOT NULL
        AND source_version."relationSnapshotHash" IS NOT NULL
    )
    SELECT "id" FROM equivalence_lineage
  `;
}

/** Follow only accepted full-equivalence edges to their exact current version.
 * A later edit never extends that authority to the edited version. Null means
 * no usable alias; callers retain their ordinary exact-target validation.
 * The durable relation survives execution-ledger retention. */
export async function resolveMemoryExplicitEquivalentTarget(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  target: MemoryFactVersionTarget,
  now = new Date()
): Promise<MemoryFactVersionTarget | null> {
  const rows = await db.$queryRaw<MemoryFactVersionTarget[]>(Prisma.sql`
    WITH RECURSIVE equivalent AS (
      SELECT version."id", version."factId", fact."scopeId", ARRAY[version."id"] AS path
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId" AND fact."id" = version."factId"
      INNER JOIN "User" AS owner ON owner."id" = fact."userId" AND owner."status" = 'active'
      INNER JOIN "MemoryScope" AS scope
        ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        AND scope."state" = 'ACTIVE'::"MemoryScopeState"
        AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      WHERE version."userId" = ${userId} AND version."id" = ${target.factVersionId}
        AND version."factId" = ${target.factId}
        AND version."state" = 'MERGED'::"MemoryFactVersionState"
      UNION ALL
      SELECT next_version."id", next_version."factId", next_fact."scopeId", prior.path || next_version."id"
      FROM equivalent AS prior
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = ${userId} AND version."id" = prior."id"
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId" AND fact."id" = version."factId"
      INNER JOIN "MemoryFactVersionRelation" AS relation
        ON relation."userId" = version."userId" AND relation."sourceVersionId" = version."id"
        AND relation."targetVersionId" = version."mergedIntoVersionId"
        AND relation."kind" = 'MERGED_INTO'::"MemoryFactVersionRelationKind"
        AND relation."pipelineVersion" = ${MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION}
        AND relation."reasonCode" = 'explicit_semantic_equivalence'
      INNER JOIN "MemoryFactVersion" AS next_version
        ON next_version."userId" = version."userId" AND next_version."id" = relation."targetVersionId"
        AND next_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      INNER JOIN "MemoryFact" AS next_fact
        ON next_fact."userId" = next_version."userId" AND next_fact."id" = next_version."factId"
        AND next_fact."id" = fact."movedToFactId" AND next_fact."scopeId" = prior."scopeId"
      WHERE cardinality(prior.path) < 64 AND NOT next_version."id" = ANY(prior.path)
        AND fact."state" = 'RETRACTED'::"MemoryFactState" AND fact."currentVersionId" IS NULL
        AND version."state" = 'MERGED'::"MemoryFactVersionState"
        AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
        AND version."contentPurgedAt" IS NULL AND version."displayText" IS NOT NULL
        AND version."relationResolutionVersion" = ${MEMORY_EXPLICIT_RELATION_POLICY_VERSION}
        AND version."relationResolvedAt" IS NOT NULL AND version."relationSnapshotHash" IS NOT NULL
        AND version."systemTo" IS NOT NULL
        AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
    )
    SELECT version."factId", version."id" AS "factVersionId"
    FROM equivalent AS resolved
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = ${userId} AND version."id" = resolved."id"
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    WHERE cardinality(resolved.path) > 1
      AND fact."state" = 'ACTIVE'::"MemoryFactState" AND fact."currentVersionId" = version."id"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState" AND version."systemTo" IS NULL
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL AND version."displayText" IS NOT NULL
      AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
    LIMIT 2
  `);
  return rows.length === 1 ? rows[0] : null;
}
