import { Prisma } from "@prisma/client";
import {
  memoryExactVNextDirectAuthorityPredicate,
  memoryPersonalEvidenceRowPredicate
} from "../../persistence/eligibility";
import type { MemoryTransaction } from "../../persistence/transaction";

export type AdmissibleMemoryEntityAlias = Readonly<{
  displayAlias: string;
  entityId: string;
  id: string;
  normalizedAlias: string;
}>;

/** Canonical entity-root fence. A merged child is reusable only while its
 * entire bounded chain reaches an ACTIVE root. RETRACTED roots never cause a
 * historical child to promote itself. */
export function memoryEntityRootIsActivePredicate(
  userId: string | Prisma.Sql,
  entityId: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`aiqsa_memory_entity_root_is_active(${userId}, ${entityId})`;
}

export function memoryEntityRootIdSql(
  userId: string | Prisma.Sql,
  entityId: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`aiqsa_memory_entity_root_id(${userId}, ${entityId})`;
}

function globalSuppressionFence(userId: string | Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemorySuppression" AS alias_global_suppression
    WHERE alias_global_suppression."userId" = ${userId}
      AND alias_global_suppression."scope" = 'ALL'::"MemorySuppressionScope"
      AND (
        alias_global_suppression."expiresAt" IS NULL
        OR alias_global_suppression."expiresAt" > CURRENT_TIMESTAMP
      )
  )`;
}

/**
 * The single admissible-support owner for every alias consumer.
 *
 * Callers normally expose `alias`; a different alias-id expression can be
 * supplied for nested queries. SUPERSEDED and MERGED semantic versions remain
 * valid support when their exact source, dependencies, safety and retention
 * authority still hold. Pending/conflicting and terminal versions do not.
 */
export function memoryAdmissibleEntityAliasPredicate(
  userId: string | Prisma.Sql,
  aliasId: Prisma.Sql = Prisma.sql`alias."id"`,
  options: Readonly<{ includePendingClassification?: boolean }> = {}
): Prisma.Sql {
  const reusableVersionStates = options.includePendingClassification
    ? Prisma.sql`(
        'ACTIVE'::"MemoryFactVersionState",
        'PENDING_RELATION'::"MemoryFactVersionState",
        'SUPERSEDED'::"MemoryFactVersionState",
        'MERGED'::"MemoryFactVersionState"
      )`
    : Prisma.sql`(
        'ACTIVE'::"MemoryFactVersionState",
        'SUPERSEDED'::"MemoryFactVersionState",
        'MERGED'::"MemoryFactVersionState"
      )`;
  const reusableSafetyStates = options.includePendingClassification
    ? Prisma.sql`(
        'PENDING'::"MemorySafetyClassificationState",
        'CLASSIFIED'::"MemorySafetyClassificationState",
        'UNCERTAIN'::"MemorySafetyClassificationState"
      )`
    : Prisma.sql`('CLASSIFIED'::"MemorySafetyClassificationState")`;
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "MemoryEntityAlias" AS authority_alias
    WHERE authority_alias."userId" = ${userId}
      AND authority_alias."id" = ${aliasId}
      AND ${memoryEntityRootIsActivePredicate(
        userId,
        Prisma.sql`authority_alias."entityId"`
      )}
      AND ${globalSuppressionFence(userId)}
      AND EXISTS (
        SELECT 1
        FROM "MemoryEntityAliasSupport" AS alias_support
        WHERE alias_support."userId" = authority_alias."userId"
          AND alias_support."aliasId" = authority_alias."id"
          AND (
            (
              alias_support."supportKind" =
                'EVIDENCE'::"MemoryEntityAliasSupportKind"
              AND EXISTS (
                SELECT 1
                FROM "MemoryEvidence" AS support
                INNER JOIN "Chat" AS evidence_chat
                  ON evidence_chat."userId" = support."userId"
                  AND evidence_chat."id" = support."chatId"
                  AND evidence_chat."projectId" IS NULL
                  AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
                  AND evidence_chat."permanentDeletionAt" IS NULL
                INNER JOIN "Message" AS evidence_message
                  ON evidence_message."chatId" = support."chatId"
                  AND evidence_message."id" = support."messageId"
                  AND evidence_message."role" = 'user'
                INNER JOIN "MemoryFactVersion" AS version
                  ON version."userId" = support."userId"
                  AND version."id" = support."factVersionId"
                INNER JOIN "MemoryFact" AS fact
                  ON fact."userId" = version."userId"
                  AND fact."id" = version."factId"
                INNER JOIN "MemoryScope" AS scope
                  ON scope."userId" = fact."userId"
                  AND scope."id" = fact."scopeId"
                WHERE support."userId" = ${userId}
                  AND support."id" = alias_support."evidenceId"
                  AND version."state" IN ${reusableVersionStates}
                  AND (
                    fact."state" = 'ACTIVE'::"MemoryFactState"
                    OR (
                      fact."state" = 'RETRACTED'::"MemoryFactState"
                      AND fact."movedToFactId" IS NOT NULL
                    )
                  )
                  AND scope."state" = 'ACTIVE'::"MemoryScopeState"
                  AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
                  AND scope."targetIdSnapshot" IS NULL
                  AND scope."targetDisplaySnapshot" IS NULL
                  AND scope."folderId" IS NULL
                  AND scope."assistantId" IS NULL
                  AND scope."chatId" IS NULL
                  AND version."contentPurgedAt" IS NULL
                  AND version."displayText" IS NOT NULL
                  AND version."directness" IN (
                    'DIRECT'::"MemoryDirectness",
                    'PARAPHRASED'::"MemoryDirectness"
                  )
                  AND version."safetyClassificationState" IN
                    ${reusableSafetyStates}
                  AND version."sensitivityClass" IN (
                    'NORMAL'::"MemorySensitivityClass",
                    'SENSITIVE'::"MemorySensitivityClass"
                  )
                  AND support."safetyClass" IN (
                    'NORMAL'::"MemorySensitivityClass",
                    'SENSITIVE'::"MemorySensitivityClass"
                  )
                  AND (
                    version."expiresAt" IS NULL
                    OR version."expiresAt" > CURRENT_TIMESTAMP
                  )
                  AND ${memoryExactVNextDirectAuthorityPredicate(userId, {
                    factVersionId: Prisma.sql`version."id"`,
                    sourceMode: Prisma.sql`version."sourceMode"`,
                    version: Prisma.sql`version`
                  })}
                  AND support."branchGeneration" =
                    evidence_chat."memoryBranchGeneration"
                  AND ${memoryPersonalEvidenceRowPredicate(
                    userId,
                    Prisma.sql`version."id"`,
                    { exactVNext: true }
                  )}
                  AND aiqsa_memory_fact_dependencies_valid(
                    ${userId},
                    version."id"
                  )
              )
            )
            OR (
              alias_support."supportKind" =
                'FACT_VERSION'::"MemoryEntityAliasSupportKind"
              AND EXISTS (
                SELECT 1
                FROM "MemoryFactVersion" AS version
                INNER JOIN "MemoryFact" AS fact
                  ON fact."userId" = version."userId"
                  AND fact."id" = version."factId"
                INNER JOIN "MemoryScope" AS scope
                  ON scope."userId" = fact."userId"
                  AND scope."id" = fact."scopeId"
                WHERE version."userId" = ${userId}
                  AND version."id" = alias_support."factVersionId"
                  AND version."state" IN ${reusableVersionStates}
                  AND (
                    fact."state" = 'ACTIVE'::"MemoryFactState"
                    OR (
                      fact."state" = 'RETRACTED'::"MemoryFactState"
                      AND fact."movedToFactId" IS NOT NULL
                    )
                  )
                  AND scope."state" = 'ACTIVE'::"MemoryScopeState"
                  AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
                  AND scope."targetIdSnapshot" IS NULL
                  AND scope."targetDisplaySnapshot" IS NULL
                  AND scope."folderId" IS NULL
                  AND scope."assistantId" IS NULL
                  AND scope."chatId" IS NULL
                  AND version."contentPurgedAt" IS NULL
                  AND version."displayText" IS NOT NULL
                  AND version."directness" IN (
                    'DIRECT'::"MemoryDirectness",
                    'PARAPHRASED'::"MemoryDirectness"
                  )
                  AND version."safetyClassificationState" IN
                    ${reusableSafetyStates}
                  AND version."sensitivityClass" IN (
                    'NORMAL'::"MemorySensitivityClass",
                    'SENSITIVE'::"MemorySensitivityClass"
                  )
                  AND (
                    version."expiresAt" IS NULL
                    OR version."expiresAt" > CURRENT_TIMESTAMP
                  )
                  AND ${memoryExactVNextDirectAuthorityPredicate(userId, {
                    factVersionId: Prisma.sql`version."id"`,
                    sourceMode: Prisma.sql`version."sourceMode"`,
                    version: Prisma.sql`version`
                  })}
              )
            )
          )
      )
  )`;
}

export async function loadAdmissibleMemoryEntityAliases(
  tx: MemoryTransaction,
  userId: string,
  entityIds: readonly string[],
  limit = 64
): Promise<readonly AdmissibleMemoryEntityAlias[]> {
  const ids = [...new Set(entityIds.filter(Boolean))].slice(0, 64);
  if (ids.length === 0 || !Number.isSafeInteger(limit) || limit <= 0) return [];
  return tx.$queryRaw<AdmissibleMemoryEntityAlias[]>(Prisma.sql`
    SELECT alias."id", alias."entityId", alias."normalizedAlias",
      alias."displayAlias"
    FROM "MemoryEntityAlias" AS alias
    WHERE alias."userId" = ${userId}
      AND alias."entityId" IN (${Prisma.join(ids)})
      AND ${memoryAdmissibleEntityAliasPredicate(userId)}
    ORDER BY alias."normalizedAlias", alias."id"
    LIMIT ${Math.min(limit, 256)}
  `);
}
