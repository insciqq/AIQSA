import { Prisma, type PrismaClient } from "@prisma/client";
import {
  memoryExactVNextDirectAuthorityPredicate,
  memoryPersonalEvidenceRowPredicate,
  memoryPersonalFactEvidencePredicate
} from "../persistence/eligibility";
import {
  MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION
} from "./policy";

export type MemoryReusableFactAuthorityClassification =
  | "CLASSIFIED"
  | "PENDING"
  | "SECRET_FENCED"
  | "UNCERTAIN";
export type MemoryReusableFactAuthorityLifecycle =
  | "CURRENT"
  | "CURRENT_OR_HISTORICAL"
  | "RECLASSIFICATION";

type AuthorityAliases = Readonly<{
  fact?: Prisma.Sql;
  scope?: Prisma.Sql;
  settings?: Prisma.Sql;
  version?: Prisma.Sql;
}>;

export type MemoryReusableFactAuthorityInput = AuthorityAliases & Readonly<{
  allowLegacySafetyReprojection?: boolean;
  classification?: MemoryReusableFactAuthorityClassification;
  includePatterns?: boolean;
  lifecycle?: MemoryReusableFactAuthorityLifecycle;
}>;

function canonicalScopePredicate(scope: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    ${scope}."state" = 'ACTIVE'::"MemoryScopeState"
    AND ${scope}."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
    AND ${scope}."targetIdSnapshot" IS NULL
    AND ${scope}."targetDisplaySnapshot" IS NULL
    AND ${scope}."folderId" IS NULL
    AND ${scope}."assistantId" IS NULL
    AND ${scope}."chatId" IS NULL
  `;
}

function currentLifecyclePredicate(
  version: Prisma.Sql,
  fact: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    ${version}."state" = 'ACTIVE'::"MemoryFactVersionState"
    AND ${version}."systemTo" IS NULL
    AND ${fact}."state" = 'ACTIVE'::"MemoryFactState"
    AND ${fact}."currentVersionId" = ${version}."id"
  `;
}

function lifecyclePredicate(
  version: Prisma.Sql,
  fact: Prisma.Sql,
  lifecycle: MemoryReusableFactAuthorityLifecycle
): Prisma.Sql {
  if (lifecycle === "CURRENT") return currentLifecyclePredicate(version, fact);
  if (lifecycle === "RECLASSIFICATION") {
    return Prisma.sql`(
      (${currentLifecyclePredicate(version, fact)})
      OR (
        ${version}."state" = 'PENDING_RELATION'::"MemoryFactVersionState"
        AND (
          (
            ${fact}."state" = 'ACTIVE'::"MemoryFactState"
            AND ${fact}."currentVersionId" IS NOT NULL
            AND ${fact}."currentVersionId" <> ${version}."id"
          )
          OR (
            ${fact}."state" = 'CONFLICTED'::"MemoryFactState"
            AND ${fact}."currentVersionId" IS NULL
          )
        )
      )
    )`;
  }
  return Prisma.sql`(
    (${currentLifecyclePredicate(version, fact)})
    OR (
      ${version}."state" = 'SUPERSEDED'::"MemoryFactVersionState"
      AND ${version}."systemTo" IS NOT NULL
      AND (
        ${fact}."state" = 'ACTIVE'::"MemoryFactState"
        OR (
          ${fact}."state" = 'RETRACTED'::"MemoryFactState"
          AND ${fact}."movedToFactId" IS NOT NULL
        )
      )
    )
  )`;
}

function globalSuppressionPredicate(
  userId: string | Prisma.Sql,
  version: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemorySuppression" AS reusable_global_suppression
    WHERE reusable_global_suppression."userId" = ${userId}
      AND reusable_global_suppression."scope" = 'ALL'::"MemorySuppressionScope"
      AND (
        reusable_global_suppression."expiresAt" IS NULL
        OR reusable_global_suppression."expiresAt" > CURRENT_TIMESTAMP
      )
      AND reusable_global_suppression."userId" = ${version}."userId"
  )`;
}

function commonAuthorityPredicate(
  userId: string | Prisma.Sql,
  aliases: Required<AuthorityAliases>,
  input: Readonly<{
    allowLegacySafetyReprojection?: boolean;
    classification: MemoryReusableFactAuthorityClassification;
    lifecycle: MemoryReusableFactAuthorityLifecycle;
  }>
): Prisma.Sql {
  const { fact, scope, settings, version } = aliases;
  return Prisma.sql`
    ${version}."userId" = ${userId}
    AND ${fact}."userId" = ${version}."userId"
    AND ${fact}."id" = ${version}."factId"
    AND ${scope}."userId" = ${fact}."userId"
    AND ${scope}."id" = ${fact}."scopeId"
    AND ${settings}."userId" = ${version}."userId"
    AND ${settings}."useMemoryFacts" = TRUE
    AND ${lifecyclePredicate(version, fact, input.lifecycle)}
    AND ${version}."safetyClassificationState" =
      ${input.classification}::"MemorySafetyClassificationState"
    AND ${version}."contentPurgedAt" IS NULL
    AND ${version}."displayText" IS NOT NULL
    AND ${version}."structuredValue" IS NOT NULL
    AND (${version}."expiresAt" IS NULL OR ${version}."expiresAt" > CURRENT_TIMESTAMP)
    AND ${version}."sourceMode" IN (
      'EXPLICIT'::"MemoryFactSourceMode", 'AUTOMATIC'::"MemoryFactSourceMode"
    )
    AND ${input.allowLegacySafetyReprojection === true
      ? Prisma.sql`${version}."sensitivityClass" IN (
          'NORMAL'::"MemorySensitivityClass",
          'SENSITIVE'::"MemorySensitivityClass",
          'HIGHLY_SENSITIVE'::"MemorySensitivityClass",
          'SECRET'::"MemorySensitivityClass"
        )`
      : Prisma.sql`${version}."sensitivityClass" IN (
          'NORMAL'::"MemorySensitivityClass", 'SENSITIVE'::"MemorySensitivityClass"
        )`}
    AND (
      ${fact}."subjectEntityId" IS NULL
      OR aiqsa_memory_entity_root_is_active(${userId}, ${fact}."subjectEntityId")
    )
    AND ${canonicalScopePredicate(scope)}
    AND ${globalSuppressionPredicate(userId, version)}
  `;
}

function directAuthorityPredicate(
  userId: string | Prisma.Sql,
  version: Prisma.Sql,
  allowLegacySafetyReprojection = false
): Prisma.Sql {
  return Prisma.sql`
    ${version}."modality" <> 'PATTERN'::"MemoryFactModality"
    AND ${version}."directness" IN (
      'DIRECT'::"MemoryDirectness", 'PARAPHRASED'::"MemoryDirectness"
    )
    AND ${version}."synthesisDepth" = 0
    AND ${version}."synthesisGeneration" IS NULL
    AND ${version}."synthesisSourceSetFingerprint" IS NULL
    AND ${allowLegacySafetyReprojection
      ? memoryPersonalFactEvidencePredicate(userId, {
          factVersionId: Prisma.sql`${version}."id"`,
          sourceMode: Prisma.sql`${version}."sourceMode"`
        })
      : memoryExactVNextDirectAuthorityPredicate(userId, {
          factVersionId: Prisma.sql`${version}."id"`,
          sourceMode: Prisma.sql`${version}."sourceMode"`,
          version
        })}
  `;
}

function explicitReceiptAuthorityPredicate(
  version: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`(
    ${version}."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
    OR EXISTS (
      SELECT 1
      FROM "MemoryEvent" AS synthesis_explicit_event
      WHERE synthesis_explicit_event."userId" = ${version}."userId"
        AND synthesis_explicit_event."id" = ${version}."createdByEventId"
        AND synthesis_explicit_event."factVersionId" = ${version}."id"
        AND synthesis_explicit_event."operation" IN (
          'EXPLICIT_SAVE'::"MemoryEventOperation",
          'EDIT'::"MemoryEventOperation",
          'SCOPE_CHANGE'::"MemoryEventOperation"
        )
        AND EXISTS (
          SELECT 1
          FROM "MemoryOperationReceipt" AS synthesis_explicit_receipt
          WHERE synthesis_explicit_receipt."userId" = ${version}."userId"
            AND synthesis_explicit_receipt."targetFactId" = ${version}."factId"
            AND synthesis_explicit_receipt."targetVersionId" = ${version}."id"
            AND synthesis_explicit_receipt."outcome" =
              'APPLIED'::"MemoryOperationOutcome"
            AND synthesis_explicit_receipt."operation" =
              CASE synthesis_explicit_event."operation"
                WHEN 'EXPLICIT_SAVE'::"MemoryEventOperation"
                  THEN 'SAVE'::"MemoryMutationAction"
                WHEN 'SCOPE_CHANGE'::"MemoryEventOperation"
                  THEN 'MOVE_SCOPE'::"MemoryMutationAction"
                ELSE 'EDIT'::"MemoryMutationAction"
              END
        )
    )
  )`;
}

function sourceAuthorityPredicate(
  userId: string | Prisma.Sql,
  version: Prisma.Sql,
  fact: Prisma.Sql,
  scope: Prisma.Sql,
  settings: Prisma.Sql
): Prisma.Sql {
  const aliases = { fact, scope, settings, version };
  return Prisma.sql`
    ${commonAuthorityPredicate(userId, aliases, {
      classification: "CLASSIFIED",
      lifecycle: "CURRENT"
    })}
    AND ${directAuthorityPredicate(userId, version)}
    AND ${version}."confidence" = 1.0
    AND ${version}."observedAt" IS NOT NULL
    AND ${settings}."synthesisEnabledAt" IS NOT NULL
    AND ${settings}."synthesisPolicyVersion" = ${MEMORY_SYNTHESIS_POLICY_VERSION}
    AND ${version}."observedAt" >= ${settings}."synthesisEnabledAt"
    AND (
      ${version}."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      OR ${settings}."learnAutomatically" = TRUE
    )
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
    AND ${explicitReceiptAuthorityPredicate(version)}
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

function sourceEligibilityHashExpression(
  version: Prisma.Sql,
  fact: Prisma.Sql,
  settings: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`aiqsa_memory_synthesis_source_eligibility_hash(
    ${fact}."canonicalKey",
    ${version}."directness"::text,
    ${version}."factId",
    ${version}."ingestionFingerprint",
    ${settings}."memoryGeneration",
    ${version}."modality"::text,
    ${version}."observedAt",
    ${version}."pipelineVersion",
    ${version}."sourceMode"::text,
    ${version}."id"
  )`;
}

/** Authoritative depth-one rejoin for an already-created PATTERN. Every exact
 * relation must still point at an eligible direct source and retain the exact
 * eligibility hash captured when the provider call was admitted. */
export function memorySynthesisPatternAuthorityPredicate(
  userId: string | Prisma.Sql,
  input: AuthorityAliases & Readonly<{
    allowLegacySafetyReprojection?: boolean;
    classification?: MemoryReusableFactAuthorityClassification;
    patternVersionId?: Prisma.Sql;
  }> = {}
): Prisma.Sql {
  const version = input.version ?? Prisma.sql`version`;
  const fact = input.fact ?? Prisma.sql`fact`;
  const scope = input.scope ?? Prisma.sql`scope`;
  const settings = input.settings ?? Prisma.sql`settings`;
  const classification = input.classification ?? "CLASSIFIED";
  const patternVersionId = input.patternVersionId ?? Prisma.sql`${version}."id"`;
  return Prisma.sql`(
    ${commonAuthorityPredicate(userId, { fact, scope, settings, version }, {
      allowLegacySafetyReprojection: input.allowLegacySafetyReprojection,
      classification,
      lifecycle: "CURRENT"
    })}
    AND ${version}."modality" = 'PATTERN'::"MemoryFactModality"
    AND ${version}."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
    AND ${version}."directness" = 'INFERRED'::"MemoryDirectness"
    AND ${version}."synthesisDepth" = 1
    AND ${version}."pipelineVersion" = ${MEMORY_SYNTHESIS_PIPELINE_VERSION}
    AND ${version}."synthesisGeneration" = ${settings}."memoryGeneration"
    AND ${version}."synthesisSourceSetFingerprint" ~ '^[a-f0-9]{64}$'
    AND ${settings}."synthesisEnabledAt" IS NOT NULL
    AND ${settings}."synthesisPolicyVersion" = ${MEMORY_SYNTHESIS_POLICY_VERSION}
    AND ${version}."observedAt" IS NOT NULL
    AND ${version}."observedAt" >= ${settings}."synthesisEnabledAt"
    AND ${fact}."identityKind" = 'PROPOSITION'::"MemoryFactIdentityKind"
    AND ${fact}."identityVersion" = 'proposition-v1'
    AND ${fact}."subjectEntityId" IS NULL
    AND ${fact}."subjectKey" IS NULL
    AND ${fact}."predicateKey" IS NULL
    AND ${fact}."dimensionKey" IS NULL
    AND (
      SELECT COUNT(DISTINCT relation_source_fact."id")
      FROM "MemoryFactVersionRelation" AS relation
      INNER JOIN "MemoryFactVersion" AS relation_source_version
        ON relation_source_version."userId" = relation."userId"
       AND relation_source_version."id" = relation."targetVersionId"
      INNER JOIN "MemoryFact" AS relation_source_fact
        ON relation_source_fact."userId" = relation_source_version."userId"
       AND relation_source_fact."id" = relation_source_version."factId"
      WHERE relation."userId" = ${userId}
        AND relation."sourceVersionId" = ${patternVersionId}
        AND relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
    ) >= ${MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES}
    AND (
      SELECT COUNT(DISTINCT source_root."rootKey")
      FROM "MemoryFactVersionRelation" AS root_relation
      INNER JOIN "MemoryFactVersion" AS root_source_version
        ON root_source_version."userId" = root_relation."userId"
       AND root_source_version."id" = root_relation."targetVersionId"
      INNER JOIN LATERAL (
        SELECT ('explicit:' || root_source_version."id")::text AS "rootKey"
        WHERE root_source_version."sourceMode" =
          'EXPLICIT'::"MemoryFactSourceMode"

        UNION ALL

        SELECT ('message:' || support."messageId")::text AS "rootKey"
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
        WHERE root_source_version."sourceMode" =
            'AUTOMATIC'::"MemoryFactSourceMode"
          AND ${memoryPersonalEvidenceRowPredicate(
            userId,
            Prisma.sql`root_source_version."id"`,
            { exactVNext: true }
          )}
      ) AS source_root ON TRUE
      WHERE root_relation."userId" = ${userId}
        AND root_relation."sourceVersionId" = ${patternVersionId}
        AND root_relation."kind" =
          'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
    ) >= ${MEMORY_SYNTHESIS_MIN_PATTERN_SOURCES}
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
        AND NOT COALESCE((
          relation."pipelineVersion" = ${MEMORY_SYNTHESIS_PIPELINE_VERSION}
          AND relation."executionId" IS NOT NULL
          AND relation."sourceEligibilityHash" ~ '^[a-f0-9]{64}$'
          AND relation."sourceEligibilityHash" = ${sourceEligibilityHashExpression(
            Prisma.sql`source_version`,
            Prisma.sql`source_fact`,
            settings
          )}
          AND ${sourceAuthorityPredicate(
            userId,
            Prisma.sql`source_version`,
            Prisma.sql`source_fact`,
            Prisma.sql`source_scope`,
            settings
          )}
        ), FALSE)
    )
  )`;
}

/** New patterns receive synchronous Safety Lite admission. Reconciliation also
 * preserves source-authorized legacy safety states until bounded local
 * reprojection can classify or purge them; ordinary retrieval still admits
 * only CLASSIFIED rows. */
export function memorySynthesisPatternInvalidationPredicate(
  userId: string | Prisma.Sql,
  input: AuthorityAliases & Readonly<{
    patternVersionId?: Prisma.Sql;
  }> = {}
): Prisma.Sql {
  const version = input.version ?? Prisma.sql`version`;
  const aliases = {
    fact: input.fact,
    patternVersionId: input.patternVersionId,
    scope: input.scope,
    settings: input.settings,
    version
  };
  return Prisma.sql`(
    (
      ${version}."safetyClassificationState" =
        'PENDING'::"MemorySafetyClassificationState"
      AND NOT (${memorySynthesisPatternAuthorityPredicate(userId, {
        ...aliases,
        classification: "PENDING"
      })})
    )
    OR (
      ${version}."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND NOT (${memorySynthesisPatternAuthorityPredicate(userId, {
        ...aliases,
        classification: "CLASSIFIED"
      })})
    )
    OR (
      ${version}."safetyClassificationState" =
        'UNCERTAIN'::"MemorySafetyClassificationState"
      AND NOT (${memorySynthesisPatternAuthorityPredicate(userId, {
        ...aliases,
        allowLegacySafetyReprojection: true,
        classification: "UNCERTAIN"
      })})
    )
    OR (
      ${version}."safetyClassificationState" =
        'SECRET_FENCED'::"MemorySafetyClassificationState"
      AND NOT (${memorySynthesisPatternAuthorityPredicate(userId, {
        ...aliases,
        allowLegacySafetyReprojection: true,
        classification: "SECRET_FENCED"
      })})
    )
    OR ${version}."safetyClassificationState" NOT IN (
      'PENDING'::"MemorySafetyClassificationState",
      'CLASSIFIED'::"MemorySafetyClassificationState",
      'UNCERTAIN'::"MemorySafetyClassificationState",
      'SECRET_FENCED'::"MemorySafetyClassificationState"
    )
  )`;
}

/** The sole reusable-fact authority owner. Consumers may narrow the lifecycle
 * or classification phase, but must not restate either the direct/evidence or
 * evidence-less PATTERN branches. PATTERN admission is closed unless the
 * caller explicitly opts in. */
export function memoryReusableFactAuthorityPredicate(
  userId: string | Prisma.Sql,
  input: MemoryReusableFactAuthorityInput = {}
): Prisma.Sql {
  const version = input.version ?? Prisma.sql`version`;
  const fact = input.fact ?? Prisma.sql`fact`;
  const scope = input.scope ?? Prisma.sql`scope`;
  const settings = input.settings ?? Prisma.sql`settings`;
  const classification = input.classification ?? "CLASSIFIED";
  const lifecycle = input.lifecycle ?? "CURRENT";
  const includePatterns = input.includePatterns === true
    ? Prisma.sql`TRUE`
    : Prisma.sql`FALSE`;
  const common = commonAuthorityPredicate(
    userId,
    { fact, scope, settings, version },
    {
      allowLegacySafetyReprojection: input.allowLegacySafetyReprojection,
      classification,
      lifecycle
    }
  );
  const pattern = memorySynthesisPatternAuthorityPredicate(userId, {
    allowLegacySafetyReprojection: input.allowLegacySafetyReprojection,
    classification,
    fact,
    scope,
    settings,
    version
  });
  return Prisma.sql`(
    (
      ${common}
      AND ${directAuthorityPredicate(
        userId,
        version,
        input.allowLegacySafetyReprojection === true
      )}
    )
    OR (
      ${includePatterns}
      AND ${pattern}
    )
  )`;
}

/** Resolves the exact currently reusable subset for read-side projections and
 * action revalidation. Keeping this loader beside the canonical predicate
 * prevents evidence-less PATTERN rows from being silently dropped by a
 * direct-evidence-only helper after they were already frozen into a run. */
export async function loadMemoryReusableFactVersionIds(
  client: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  factVersionIds: readonly string[],
  options: Readonly<{ includePatterns?: boolean }> = {}
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(factVersionIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT version."id"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    WHERE version."userId" = ${userId}
      AND version."id" IN (${Prisma.join(ids)})
      AND ${memoryReusableFactAuthorityPredicate(userId, {
        includePatterns: options.includePatterns === true
      })}
  `);
  return new Set(rows.map(({ id }) => id));
}
