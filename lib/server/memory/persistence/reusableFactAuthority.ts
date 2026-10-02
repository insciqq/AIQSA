import { Prisma, type PrismaClient } from "@prisma/client";
import {
  memoryExactVNextDirectAuthorityPredicate,
  memoryPersonalFactEvidencePredicate
} from "./eligibility";

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

export function memoryExplicitFactReceiptAuthorityPredicate(
  version: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`(
    ${version}."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
    OR EXISTS (
      SELECT 1
      FROM "MemoryEvent" AS reusable_explicit_event
      WHERE reusable_explicit_event."userId" = ${version}."userId"
        AND reusable_explicit_event."id" = ${version}."createdByEventId"
        AND reusable_explicit_event."factVersionId" = ${version}."id"
        AND reusable_explicit_event."operation" IN (
          'EXPLICIT_SAVE'::"MemoryEventOperation",
          'EDIT'::"MemoryEventOperation",
          'SCOPE_CHANGE'::"MemoryEventOperation"
        )
        AND EXISTS (
          SELECT 1
          FROM "MemoryOperationReceipt" AS reusable_explicit_receipt
          WHERE reusable_explicit_receipt."userId" = ${version}."userId"
            AND reusable_explicit_receipt."targetFactId" = ${version}."factId"
            AND reusable_explicit_receipt."targetVersionId" = ${version}."id"
            AND reusable_explicit_receipt."outcome" =
              'APPLIED'::"MemoryOperationOutcome"
            AND reusable_explicit_receipt."operation" =
              CASE reusable_explicit_event."operation"
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

/** The sole reusable-fact authority owner. Consumers may narrow the lifecycle
 * or classification phase, but must not restate the direct/evidence branch.
 * Retired synthesized PATTERN rows are never reusable. */
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
  const common = commonAuthorityPredicate(
    userId,
    { fact, scope, settings, version },
    {
      allowLegacySafetyReprojection: input.allowLegacySafetyReprojection,
      classification,
      lifecycle
    }
  );
  return Prisma.sql`(
    ${common}
    AND ${directAuthorityPredicate(
      userId,
      version,
      input.allowLegacySafetyReprojection === true
    )}
  )`;
}

/** Resolves the exact currently reusable subset for read-side projections and
 * action revalidation, beside the canonical predicate it applies. */
export async function loadMemoryReusableFactVersionIds(
  client: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  factVersionIds: readonly string[]
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
      AND ${memoryReusableFactAuthorityPredicate(userId)}
  `);
  return new Set(rows.map(({ id }) => id));
}
