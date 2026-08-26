import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MEMORY_COORDINATOR_ORPHANED_JOB_KINDS } from
  "../coordinator/registry";
import { memoryAdmissibleEntityAliasPredicate } from
  "../learning/entities/authority";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { memoryReusableFactAuthorityPredicate } from
  "../synthesis/eligibility";
import { MEMORY_SYNTHESIS_PIPELINE_VERSION } from "../synthesis/policy";

export const MEMORY_SEMANTIC_CUTOVER_INVENTORY_VERSION =
  "memory-semantic-cutover-inventory-v1";

export type MemorySemanticCutoverInventory = Readonly<{
  activeCurrentMissingExactAuthority: number;
  aliasesWithoutAdmissibleSupport: number;
  automaticEvidenceMissingExactProvenance: number;
  automaticMissingIngestionFingerprint: number;
  contextVersionsWithInvalidDependencies: number;
  duplicateCurrentSemanticIdentities: number;
  legacyCandidates: number;
  legacyDecisions: number;
  legacyNonterminalJobs: number;
  total: number;
  unsupportedAutomaticPipelineVersions: number;
  version: typeof MEMORY_SEMANTIC_CUTOVER_INVENTORY_VERSION;
}>;

export type MemorySemanticCutoverDisposition =
  | "PREPRODUCTION_PURGE_RESET"
  | "REPROCESS_REQUIRED"
  | "RETAINED_DORMANT_EXCLUDED"
  | "RETAINED_OPERATOR_REVIEW"
  | "ZERO_NOOP";

export type MemorySemanticCutoverDecision = Readonly<{
  blockingCount: number;
  disposition: MemorySemanticCutoverDisposition | null;
  reason:
    | "explicit_disposition_required"
    | "nonzero_inventory_requires_completed_action"
    | "nonzero_inventory_requires_review"
    | "retained_inventory_not_dormant"
    | "retained_legacy_is_dormant"
    | "zero_inventory_noop";
  status: "BLOCKED" | "READY";
}>;

type InventoryRow = Readonly<Record<string, string>>;

function safeCount(value: string | undefined): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("memory_semantic_cutover_count_invalid");
  }
  const parsed = BigInt(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(parsed);
}

function orphanedJobKinds(): Prisma.Sql {
  return Prisma.join(MEMORY_COORDINATOR_ORPHANED_JOB_KINDS.map((kind) =>
    Prisma.sql`${kind}::"MemoryJobKind"`));
}

/** Reads only aggregate counts and never selects Memory text or identifiers. */
export async function loadMemorySemanticCutoverInventory(
  client: Pick<PrismaClient, "$queryRaw"> = prisma
): Promise<MemorySemanticCutoverInventory> {
  const rows = await client.$queryRaw<InventoryRow[]>(Prisma.sql`
    WITH authorized_current AS (
      SELECT
        fact."id",
        fact."userId",
        fact."scopeId",
        fact."identityKind"::text AS "identityKind",
        fact."identityVersion",
        CASE
          WHEN fact."identityKind" = 'SLOT'::"MemoryFactIdentityKind" THEN
            COALESCE(
              aiqsa_memory_entity_root_id(fact."userId", fact."subjectEntityId"),
              fact."subjectKey",
              ''
            )
          ELSE fact."canonicalKey"
        END AS subject,
        CASE WHEN fact."identityKind" = 'SLOT'::"MemoryFactIdentityKind"
          THEN COALESCE(fact."predicateKey", '') ELSE '' END AS predicate,
        CASE WHEN fact."identityKind" = 'SLOT'::"MemoryFactIdentityKind"
          THEN COALESCE(fact."dimensionKey", '') ELSE '' END AS dimension
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId" AND fact."id" = version."factId"
      INNER JOIN "MemoryScope" AS scope
        ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      INNER JOIN "UserMemorySettings" AS settings
        ON settings."userId" = version."userId"
      WHERE ${memoryReusableFactAuthorityPredicate(
        Prisma.sql`version."userId"`,
        { includePatterns: true }
      )}
    ), duplicate_identities AS (
      SELECT COUNT(*) - 1 AS duplicates
      FROM authorized_current
      GROUP BY "userId", "scopeId", "identityKind", "identityVersion",
        subject, predicate, dimension
      HAVING COUNT(*) > 1
    )
    SELECT
      (SELECT COUNT(*) FROM "MemoryFactVersion"
        WHERE "sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
          AND COALESCE("ingestionFingerprint", '') !~ '^[a-f0-9]{64}$'
      )::text AS "automaticMissingIngestionFingerprint",
      (SELECT COUNT(*) FROM "MemoryEvidence" evidence
        INNER JOIN "MemoryFactVersion" version
          ON version."userId" = evidence."userId"
          AND version."id" = evidence."factVersionId"
        WHERE version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
          AND evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
          AND (
            COALESCE(evidence."evidenceFingerprint", '') !~ '^[a-f0-9]{64}$'
            OR COALESCE(evidence."sourceMessageContentHash", '') !~
              '^[a-f0-9]{64}$'
            OR evidence."safeSourceHash" IS DISTINCT FROM
              evidence."sourceMessageContentHash"
            OR evidence."sourceProjectionVersion" <>
              ${MEMORY_FACT_SOURCE_PROJECTION_VERSION}
            OR evidence."sourceStartOffset" IS NULL
            OR evidence."sourceEndOffset" IS NULL
            OR evidence."sourceStartOffset" < 0
            OR evidence."sourceEndOffset" <= evidence."sourceStartOffset"
          )
      )::text AS "automaticEvidenceMissingExactProvenance",
      (SELECT COUNT(*) FROM "MemoryFactVersion"
        WHERE "sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
          AND (
            ("modality" = 'PATTERN'::"MemoryFactModality"
              AND "pipelineVersion" <> ${MEMORY_SYNTHESIS_PIPELINE_VERSION})
            OR ("modality" <> 'PATTERN'::"MemoryFactModality"
              AND "pipelineVersion" <> ${MEMORY_FACT_EXTRACTION_PIPELINE_VERSION})
          )
      )::text AS "unsupportedAutomaticPipelineVersions",
      (SELECT COUNT(*) FROM "MemoryFactVersion" version
        INNER JOIN "MemoryFact" fact
          ON fact."userId" = version."userId" AND fact."id" = version."factId"
        INNER JOIN "MemoryScope" scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        INNER JOIN "UserMemorySettings" settings
          ON settings."userId" = version."userId"
        WHERE settings."useMemoryFacts" = TRUE
          AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."systemTo" IS NULL
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" = version."id"
          AND NOT (${memoryReusableFactAuthorityPredicate(
            Prisma.sql`version."userId"`,
            { includePatterns: true }
          )})
      )::text AS "activeCurrentMissingExactAuthority",
      (SELECT COUNT(*) FROM "MemoryCandidate")::text AS "legacyCandidates",
      (SELECT COUNT(*) FROM "MemoryCandidateDecision")::text AS "legacyDecisions",
      (SELECT COUNT(*) FROM "MemoryJob"
        WHERE "kind" IN (${orphanedJobKinds()})
          AND "state" IN (
            'CLAIMED'::"MemoryJobState",
            'QUEUED'::"MemoryJobState",
            'RETRYABLE_FAILED'::"MemoryJobState",
            'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
          )
      )::text AS "legacyNonterminalJobs",
      (SELECT COUNT(*) FROM "MemoryEntityAlias" alias
        WHERE NOT (${memoryAdmissibleEntityAliasPredicate(
          Prisma.sql`alias."userId"`
        )})
      )::text AS "aliasesWithoutAdmissibleSupport",
      (SELECT COUNT(DISTINCT version."id")
        FROM "MemoryFactVersion" version
        WHERE EXISTS (
          SELECT 1 FROM "MemoryFactVersionSourceDependency" dependency
          WHERE dependency."userId" = version."userId"
            AND dependency."targetFactVersionId" = version."id"
        )
          AND NOT aiqsa_memory_fact_dependencies_valid(
            version."userId", version."id"
          )
      )::text AS "contextVersionsWithInvalidDependencies",
      COALESCE((SELECT SUM(duplicates) FROM duplicate_identities), 0)::text AS
        "duplicateCurrentSemanticIdentities"
  `);
  const row = rows[0];
  if (!row) throw new Error("memory_semantic_cutover_inventory_unavailable");
  const counts = {
    activeCurrentMissingExactAuthority:
      safeCount(row.activeCurrentMissingExactAuthority),
    aliasesWithoutAdmissibleSupport:
      safeCount(row.aliasesWithoutAdmissibleSupport),
    automaticEvidenceMissingExactProvenance:
      safeCount(row.automaticEvidenceMissingExactProvenance),
    automaticMissingIngestionFingerprint:
      safeCount(row.automaticMissingIngestionFingerprint),
    contextVersionsWithInvalidDependencies:
      safeCount(row.contextVersionsWithInvalidDependencies),
    duplicateCurrentSemanticIdentities:
      safeCount(row.duplicateCurrentSemanticIdentities),
    legacyCandidates: safeCount(row.legacyCandidates),
    legacyDecisions: safeCount(row.legacyDecisions),
    legacyNonterminalJobs: safeCount(row.legacyNonterminalJobs),
    unsupportedAutomaticPipelineVersions:
      safeCount(row.unsupportedAutomaticPipelineVersions)
  };
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error("memory_semantic_cutover_count_invalid");
  }
  return Object.freeze({
    ...counts,
    total,
    version: MEMORY_SEMANTIC_CUTOVER_INVENTORY_VERSION
  });
}

export function decideMemorySemanticCutover(
  inventory: MemorySemanticCutoverInventory,
  disposition: MemorySemanticCutoverDisposition | null
): MemorySemanticCutoverDecision {
  if (disposition === null) {
    return Object.freeze({
      blockingCount: inventory.total,
      disposition,
      reason: "explicit_disposition_required",
      status: "BLOCKED"
    });
  }
  if (inventory.total === 0 && disposition === "ZERO_NOOP") {
    return Object.freeze({
      blockingCount: 0,
      disposition,
      reason: "zero_inventory_noop",
      status: "READY"
    });
  }
  if (inventory.total === 0) {
    return Object.freeze({
      blockingCount: 0,
      disposition,
      reason: "explicit_disposition_required",
      status: "BLOCKED"
    });
  }
  if (disposition === "RETAINED_DORMANT_EXCLUDED") {
    const blockingCount = inventory.duplicateCurrentSemanticIdentities +
      inventory.legacyNonterminalJobs;
    return Object.freeze({
      blockingCount,
      disposition,
      reason: blockingCount === 0
        ? "retained_legacy_is_dormant"
        : "retained_inventory_not_dormant",
      status: blockingCount === 0 ? "READY" : "BLOCKED"
    });
  }
  if (disposition === "RETAINED_OPERATOR_REVIEW") {
    return Object.freeze({
      blockingCount: inventory.total,
      disposition,
      reason: "nonzero_inventory_requires_review",
      status: "BLOCKED"
    });
  }
  return Object.freeze({
    blockingCount: inventory.total,
    disposition,
    reason: "nonzero_inventory_requires_completed_action",
    status: "BLOCKED"
  });
}
