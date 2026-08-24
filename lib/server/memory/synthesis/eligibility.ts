import { Prisma } from "@prisma/client";
import { memoryPersonalFactEvidencePredicate } from "../persistence/eligibility";

function sourceAuthorityPredicate(
  userId: string | Prisma.Sql,
  version: Prisma.Sql,
  fact: Prisma.Sql,
  scope: Prisma.Sql,
  settings: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    ${version}."userId" = ${userId}
    AND ${version}."state" = 'ACTIVE'::"MemoryFactVersionState"
    AND ${version}."systemTo" IS NULL
    AND (${version}."expiresAt" IS NULL OR ${version}."expiresAt" > CURRENT_TIMESTAMP)
    AND ${version}."contentPurgedAt" IS NULL
    AND ${version}."displayText" IS NOT NULL
    AND ${version}."structuredValue" IS NOT NULL
    AND ${version}."safetyClassificationState" =
      'CLASSIFIED'::"MemorySafetyClassificationState"
    AND ${version}."sensitivityClass" IN (
      'NORMAL'::"MemorySensitivityClass", 'SENSITIVE'::"MemorySensitivityClass"
    )
    AND ${version}."modality" <> 'PATTERN'::"MemoryFactModality"
    AND ${version}."directness" IN (
      'DIRECT'::"MemoryDirectness", 'PARAPHRASED'::"MemoryDirectness"
    )
    AND ${version}."synthesisDepth" = 0
    AND ${version}."observedAt" IS NOT NULL
    AND ${settings}."synthesisEnabledAt" IS NOT NULL
    AND ${version}."observedAt" >= ${settings}."synthesisEnabledAt"
    AND (
      ${version}."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      OR ${settings}."learnAutomatically" = TRUE
    )
    AND ${fact}."userId" = ${version}."userId"
    AND ${fact}."id" = ${version}."factId"
    AND ${fact}."state" = 'ACTIVE'::"MemoryFactState"
    AND ${fact}."currentVersionId" = ${version}."id"
    AND ${scope}."userId" = ${fact}."userId"
    AND ${scope}."id" = ${fact}."scopeId"
    AND ${scope}."state" = 'ACTIVE'::"MemoryScopeState"
    AND ${scope}."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
    AND ${scope}."targetIdSnapshot" IS NULL
    AND ${scope}."targetDisplaySnapshot" IS NULL
    AND ${scope}."folderId" IS NULL
    AND ${scope}."assistantId" IS NULL
    AND ${scope}."chatId" IS NULL
    AND ${memoryPersonalFactEvidencePredicate(userId, {
      exactVNext: true,
      factVersionId: Prisma.sql`${version}."id"`,
      sourceMode: Prisma.sql`${version}."sourceMode"`
    })}
    AND NOT EXISTS (
      SELECT 1
      FROM "MemoryPauseInterval" AS synthesis_pause
      WHERE synthesis_pause."userId" = ${version}."userId"
        AND synthesis_pause."scope" = 'MASTER'::"MemoryPauseScope"
        AND ${version}."observedAt" >= synthesis_pause."pausedAt"
        AND (
          synthesis_pause."resumedAt" IS NULL
          OR ${version}."observedAt" < synthesis_pause."resumedAt"
        )
    )
    AND (
      (
        ${version}."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND EXISTS (
          SELECT 1 FROM "MemoryEvent" AS explicit_event
          WHERE explicit_event."userId" = ${version}."userId"
            AND explicit_event."id" = ${version}."createdByEventId"
            AND explicit_event."factVersionId" = ${version}."id"
            AND explicit_event."operation" IN (
              'EXPLICIT_SAVE'::"MemoryEventOperation",
              'EDIT'::"MemoryEventOperation",
              'SCOPE_CHANGE'::"MemoryEventOperation"
            )
            AND EXISTS (
              SELECT 1 FROM "MemoryOperationReceipt" AS explicit_receipt
              WHERE explicit_receipt."userId" = ${version}."userId"
                AND explicit_receipt."targetFactId" = ${version}."factId"
                AND explicit_receipt."targetVersionId" = ${version}."id"
                AND explicit_receipt."outcome" =
                  'APPLIED'::"MemoryOperationOutcome"
                AND explicit_receipt."operation" = CASE explicit_event."operation"
                  WHEN 'EXPLICIT_SAVE'::"MemoryEventOperation"
                    THEN 'SAVE'::"MemoryMutationAction"
                  WHEN 'SCOPE_CHANGE'::"MemoryEventOperation"
                    THEN 'MOVE_SCOPE'::"MemoryMutationAction"
                  ELSE 'EDIT'::"MemoryMutationAction"
                END
            )
        )
      )
      OR ${version}."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
    )
  `;
}

/** Fixed aliases make this fragment usable inside source-selection CTEs. */
export function memorySynthesisSourceAuthorityPredicate(
  userId: string | Prisma.Sql
): Prisma.Sql {
  return sourceAuthorityPredicate(
    userId,
    Prisma.sql`source_version`,
    Prisma.sql`source_fact`,
    Prisma.sql`source_scope`,
    Prisma.sql`settings`
  );
}

/** Authoritative depth-one rejoin for an already-created PATTERN. Every exact
 * relation must still point at an eligible direct source, and any owner
 * generation change invalidates the old source-set snapshot immediately. */
export function memorySynthesisPatternAuthorityPredicate(
  userId: string | Prisma.Sql,
  input: Readonly<{
    fact?: Prisma.Sql;
    patternVersionId?: Prisma.Sql;
    scope?: Prisma.Sql;
    settings?: Prisma.Sql;
    version?: Prisma.Sql;
  }> = {}
): Prisma.Sql {
  const version = input.version ?? Prisma.sql`version`;
  const settings = input.settings ?? Prisma.sql`settings`;
  const patternVersionId = input.patternVersionId ?? Prisma.sql`${version}."id"`;
  return Prisma.sql`(
    ${version}."modality" = 'PATTERN'::"MemoryFactModality"
    AND ${version}."directness" = 'INFERRED'::"MemoryDirectness"
    AND ${version}."synthesisDepth" = 1
    AND ${version}."synthesisGeneration" = ${settings}."memoryGeneration"
    AND ${version}."synthesisSourceSetFingerprint" IS NOT NULL
    AND (
      SELECT COUNT(DISTINCT relation."targetVersionId")
      FROM "MemoryFactVersionRelation" AS relation
      WHERE relation."userId" = ${userId}
        AND relation."sourceVersionId" = ${patternVersionId}
        AND relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
    ) >= 3
    AND NOT EXISTS (
      SELECT 1
      FROM "MemoryFactVersionRelation" AS relation
      LEFT JOIN "MemoryFactVersion" AS source_version
        ON source_version."userId" = relation."userId"
       AND source_version."id" = relation."targetVersionId"
      LEFT JOIN "MemoryFact" AS source_fact
        ON source_fact."userId" = source_version."userId"
       AND source_fact."id" = source_version."factId"
      LEFT JOIN "MemoryScope" AS source_scope
        ON source_scope."userId" = source_fact."userId"
       AND source_scope."id" = source_fact."scopeId"
      WHERE relation."userId" = ${userId}
        AND relation."sourceVersionId" = ${patternVersionId}
        AND relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
        AND NOT (${sourceAuthorityPredicate(
          userId,
          Prisma.sql`source_version`,
          Prisma.sql`source_fact`,
          Prisma.sql`source_scope`,
          settings
        )})
    )
  )`;
}

export function memoryReusableFactAuthorityPredicate(
  userId: string | Prisma.Sql,
  input: Readonly<{
    fact?: Prisma.Sql;
    scope?: Prisma.Sql;
    settings?: Prisma.Sql;
    version?: Prisma.Sql;
  }> = {}
): Prisma.Sql {
  const version = input.version ?? Prisma.sql`version`;
  return Prisma.sql`(
    (
      ${version}."modality" = 'PATTERN'::"MemoryFactModality"
      AND ${memorySynthesisPatternAuthorityPredicate(userId, input)}
    )
    OR (
      ${version}."modality" <> 'PATTERN'::"MemoryFactModality"
      AND ${version}."synthesisDepth" = 0
      AND ${memoryPersonalFactEvidencePredicate(userId, {
        exactVNext: true,
        factVersionId: Prisma.sql`${version}."id"`,
        sourceMode: Prisma.sql`${version}."sourceMode"`
      })}
    )
  )`;
}
