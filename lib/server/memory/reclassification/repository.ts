import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import type {
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../coordinator/types";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  requireActiveMemoryIndex,
  type LockedMemorySettings
} from "../persistence/transaction";
import { enqueueMemoryEmbeddingBatchItem } from "../embedding/enqueue";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import { loadMemoryReusableFactSourceSnapshots } from
  "../synthesis/authoritySnapshots";
import { removeUnsupportedMemoryEntityLinks } from "../learning/entities/lifecycle";
import {
  memoryReclassificationAcceptedOutputHash,
  memoryReclassificationInputHash,
  type MemoryReclassificationResult,
  type MemoryReclassificationSensitivity
} from "./classifier";

export const MEMORY_RECLASSIFICATION_BATCH_SIZE = 8;

export type MemoryReclassificationCandidate = Readonly<{
  id: string;
  factId: string;
  userId: string;
  displayText: string;
  coreEligible: boolean;
  coreSalience: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  modality: "CONSIDERATION" | "CONSTRAINT" | "EVENT" | "HABIT" |
    "INTENTION" | "PATTERN" | "PLAN" | "PREFERENCE" | "STATE" | "WORKFLOW";
  semanticState: "ACTIVE" | "PENDING_RELATION";
  sourceMode: "EXPLICIT" | "AUTOMATIC";
  systemFrom: Date;
}>;

export type MemoryReclassificationPlan = Readonly<{
  candidate: MemoryReclassificationCandidate;
  result: MemoryReclassificationResult;
}>;

export type MemoryReclassificationRepository = Readonly<{
  preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision>;
  pending(userId: string, limit?: number): Promise<readonly MemoryReclassificationCandidate[]>;
  apply(
    tx: Prisma.TransactionClient,
    userId: string,
    plans: readonly MemoryReclassificationPlan[],
    now: Date
  ): Promise<void>;
}>;

const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,255}$/u;

function validNow(now: Date): boolean {
  return now instanceof Date && Number.isFinite(now.getTime());
}

function classifiedState(
  sensitivity: MemoryReclassificationSensitivity,
  storageDecision: MemoryReclassificationResult["decision"]["storageDecision"],
  subjectScope: MemoryReclassificationResult["decision"]["subjectScope"],
  sourceMode: MemoryReclassificationCandidate["sourceMode"]
): "CLASSIFIED" | "UNCERTAIN" | "SECRET_FENCED" | "REJECTED_FENCED" {
  if (sensitivity === "SECRET") return "SECRET_FENCED";
  if (sensitivity === "UNCERTAIN" || subjectScope === "UNCERTAIN") {
    return sourceMode === "AUTOMATIC" ? "REJECTED_FENCED" : "UNCERTAIN";
  }
  if (sourceMode === "AUTOMATIC" && sensitivity === "SENSITIVE") {
    return "REJECTED_FENCED";
  }
  // Automatic learning never has authority to retain relationship or
  // third-party facts, even when a legacy row predates the v1 extractor.
  if (sourceMode === "AUTOMATIC" && subjectScope !== "USER") {
    return "REJECTED_FENCED";
  }
  if (storageDecision !== "ALLOW") return "REJECTED_FENCED";
  return "CLASSIFIED";
}

function canonicalStorableSensitivity(
  sensitivity: MemoryReclassificationSensitivity
): Exclude<MemoryReclassificationSensitivity, "SENSITIVE"> {
  return sensitivity === "SENSITIVE" ? "NORMAL" : sensitivity;
}

function canonicalStorableCategory(category: string): string {
  return category === "sensitive" ? "about_you" : category;
}

function safeClassificationResult(
  candidate: MemoryReclassificationCandidate,
  result: MemoryReclassificationResult
): boolean {
  const expectedInputHash = memoryReclassificationInputHash(
    candidate.displayText,
    candidate.sourceMode
  );
  const governed = typeof result.executionId === "string" &&
    safeToken.test(result.executionId) &&
    result.inputHash === expectedInputHash &&
    result.acceptedOutputHash === memoryReclassificationAcceptedOutputHash(
      expectedInputHash,
      result.decision
    );
  const localSecret = result.executionId === null &&
    result.inputHash === undefined && result.acceptedOutputHash === undefined &&
    result.providerId === "aiqsa-local-policy" &&
    result.modelId === "format-aware-secret-parser-v1" &&
    result.policyVersion === "memory-local-secret-parser-v1" &&
    result.decision.reasonCode === "secret_material" &&
    result.decision.sensitivity === "SECRET" &&
    result.decision.storageDecision === "REJECT_SECRET";
  return (governed || localSecret) && safeToken.test(result.providerId) &&
    safeToken.test(result.modelId) &&
    safeToken.test(result.policyVersion) &&
    (result.classifiedAt === undefined || validNow(result.classifiedAt)) &&
    (result.decision.reasonCode === "ordinary_personal" ||
      result.decision.reasonCode === "private_personal" ||
      result.decision.reasonCode === "secret_material" ||
      result.decision.reasonCode === "uncertain" ||
      result.decision.reasonCode === "third_party_rejected" ||
      result.decision.reasonCode === "allegation_rejected" ||
      result.decision.reasonCode === "temporary_or_unsuitable") &&
    (result.decision.storageDecision === "ALLOW" ||
      result.decision.storageDecision === "REJECT_SECRET" ||
      result.decision.storageDecision === "REJECT_THIRD_PARTY" ||
      result.decision.storageDecision === "REJECT_ALLEGATION" ||
      result.decision.storageDecision === "REJECT_UNSUITABLE") &&
    (result.decision.subjectScope === "USER" ||
      result.decision.subjectScope === "USER_RELATIONSHIP_CONTEXT" ||
      result.decision.subjectScope === "THIRD_PARTY" ||
      result.decision.subjectScope === "UNCERTAIN") &&
    (result.decision.sensitivity === "NORMAL" ||
      result.decision.sensitivity === "SENSITIVE" ||
      result.decision.sensitivity === "SECRET" ||
      result.decision.sensitivity === "UNCERTAIN");
}

type IndexableClassifiedFact = Readonly<{
  canonicalKey: string;
  category: string;
  displayText: string;
  factId: string;
  languageCode: string;
  modality: string;
  sensitivityClass: string;
  sourceMode: string;
  structuredValue: Prisma.JsonValue;
  versionId: string;
}>;

export async function ensureClassifiedSearchEntry(
  tx: Prisma.TransactionClient,
  settings: LockedMemorySettings,
  factVersionId: string,
  triggerIdentity: string,
  now: Date
): Promise<void> {
  const [row] = await tx.$queryRaw<IndexableClassifiedFact[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId", fact."canonicalKey", fact."category",
      version."id" AS "versionId", version."displayText",
      version."structuredValue", version."languageCode",
      version."modality"::text AS "modality",
      version."sensitivityClass"::text AS "sensitivityClass",
      version."sourceMode"::text AS "sourceMode"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
      AND fact."currentVersionId" = version."id"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    WHERE version."userId" = ${settings.userId}
      AND version."id" = ${factVersionId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND ${memoryReusableFactAuthorityPredicate(settings.userId, {
        includePatterns: true
      })}
  `);
  if (!row) return;
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const normalizedSearchText = normalizeMemorySearchText(row.displayText);
  if (!normalizedSearchText) return;
  const snapshots = await loadMemoryReusableFactSourceSnapshots(
    tx,
    settings.userId,
    [row]
  );
  const sources = snapshots.get(factVersionId) ?? [];
  let entry = await tx.memorySearchEntry.findFirst({
    select: { embeddingState: true, id: true },
    where: {
      factVersionId,
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  entry ??= await tx.memorySearchEntry.create({
    data: {
      embeddingState: index.indexMode === "HYBRID"
        ? "PENDING"
        : "NOT_APPLICABLE",
      factVersionId,
      indexGenerationId: index.id,
      itemType: "FACT_VERSION",
      languageCode: row.languageCode,
      normalizedSearchText,
      safeContentHash: memorySha256({
        displayText: row.displayText,
        structuredValue: row.structuredValue
      }),
      safetyIdentitySnapshot: memorySha256({
        sensitivityClass: row.sensitivityClass,
        sources
      }),
      sourceIdentitySnapshot: memorySha256({
        factId: row.factId,
        sourceMode: row.sourceMode,
        sources,
        versionId: row.versionId
      }),
      suppressionIdentitySnapshot: memorySha256({
        canonicalKey: row.canonicalKey,
        category: row.category,
        normalizedValue: normalizedSearchText
      }),
      userId: settings.userId
    },
    select: { embeddingState: true, id: true }
  });
  if (entry.embeddingState === "PENDING") {
    await enqueueMemoryEmbeddingBatchItem(tx, settings, {
      entryId: entry.id,
      triggerIdentity
    });
  }
}

export function createPrismaMemoryReclassificationRepository(
  client: PrismaClient = prisma
): MemoryReclassificationRepository {
  return Object.freeze({
    async preflight(job) {
      const settings = await client.userMemorySettings.findUnique({
        select: {
          memoryGeneration: true,
          memoryRevision: true,
          useMemoryFacts: true
        },
        where: { userId: job.userId }
      });
      if (!settings) {
        return {
          errorCode: "memory_owner_unavailable",
          status: "CANCELLED"
        };
      }
      if (!settings.useMemoryFacts) {
        return {
          errorCode: "memory_reclassification_disabled",
          status: "CANCELLED"
        };
      }
      if (
        settings.memoryGeneration !== job.memoryGenerationSnapshot ||
        settings.memoryRevision !== job.memoryRevisionSnapshot
      ) {
        return {
          errorCode: "memory_reclassification_snapshot_stale",
          status: "STALE"
        };
      }
      return { status: "READY" };
    },

    async pending(userId, limit = MEMORY_RECLASSIFICATION_BATCH_SIZE) {
      if (!safeToken.test(userId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
        return [];
      }
      return client.$queryRaw<MemoryReclassificationCandidate[]>(Prisma.sql`
        SELECT
          version."id", version."factId", version."userId", version."displayText",
          version."coreEligible", version."coreSalience"::text AS "coreSalience",
          version."modality"::text AS "modality",
          version."state"::text AS "semanticState",
          version."sourceMode"::text AS "sourceMode", version."systemFrom"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId" AND fact."id" = version."factId"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
          AND scope."state" = 'ACTIVE'::"MemoryScopeState"
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = version."userId"
        WHERE version."userId" = ${userId}
          AND (
            (
              version."state" = 'ACTIVE'::"MemoryFactVersionState"
              AND fact."currentVersionId" = version."id"
            )
            OR (
              version."state" = 'PENDING_RELATION'::"MemoryFactVersionState"
              AND (
                (
                  fact."state" = 'ACTIVE'::"MemoryFactState"
                  AND fact."currentVersionId" IS NOT NULL
                  AND fact."currentVersionId" <> version."id"
                )
                OR (
                  fact."state" = 'CONFLICTED'::"MemoryFactState"
                  AND fact."currentVersionId" IS NULL
                )
              )
            )
          )
          AND version."safetyClassificationState" =
            'PENDING'::"MemorySafetyClassificationState"
          AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
          AND version."displayText" IS NOT NULL
          AND ${memoryCanonicalGlobalScopePredicate()}
          AND ${memoryReusableFactAuthorityPredicate(userId, {
            classification: "PENDING",
            includePatterns: true,
            lifecycle: "RECLASSIFICATION"
          })}
        ORDER BY version."createdAt", version."id"
        LIMIT ${limit}
      `);
    },

    async apply(tx, userId, plans, now) {
      if (!safeToken.test(userId) || !validNow(now)) {
        throw new Error("memory_reclassification_input_invalid");
      }
      const settings = await lockMemorySettings(tx, userId, false);
      if (!settings.useMemoryFacts) {
        throw new Error("memory_reclassification_disabled");
      }
      let changed = false;
      const admittedActiveVersions: Array<{
        id: string;
        triggerIdentity: string;
      }> = [];
      for (const plan of plans) {
        const { candidate, result } = plan;
        if (candidate.userId !== userId || !safeToken.test(candidate.id) ||
          !safeToken.test(candidate.factId) ||
          (candidate.semanticState !== "ACTIVE" &&
            candidate.semanticState !== "PENDING_RELATION") ||
          !safeClassificationResult(candidate, result)) {
          throw new Error("memory_reclassification_input_invalid");
        }
        const [current] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT version."id"
          FROM "MemoryFactVersion" AS version
          INNER JOIN "MemoryFact" AS fact
            ON fact."userId" = version."userId" AND fact."id" = version."factId"
          INNER JOIN "MemoryScope" AS scope
            ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
            AND scope."state" = 'ACTIVE'::"MemoryScopeState"
          INNER JOIN "UserMemorySettings" AS settings
            ON settings."userId" = version."userId"
          WHERE version."userId" = ${userId}
            AND version."id" = ${candidate.id}
            AND version."factId" = ${candidate.factId}
            AND version."state" =
              ${candidate.semanticState}::"MemoryFactVersionState"
            AND (
              (
                version."state" = 'ACTIVE'::"MemoryFactVersionState"
                AND fact."currentVersionId" = version."id"
              )
              OR (
                version."state" = 'PENDING_RELATION'::"MemoryFactVersionState"
                AND (
                  (
                    fact."state" = 'ACTIVE'::"MemoryFactState"
                    AND fact."currentVersionId" IS NOT NULL
                    AND fact."currentVersionId" <> version."id"
                  )
                  OR (
                    fact."state" = 'CONFLICTED'::"MemoryFactState"
                    AND fact."currentVersionId" IS NULL
                  )
                )
              )
            )
            AND version."safetyClassificationState" =
              'PENDING'::"MemorySafetyClassificationState"
            AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
            AND ${memoryCanonicalGlobalScopePredicate()}
            AND ${memoryReusableFactAuthorityPredicate(userId, {
              classification: "PENDING",
              includePatterns: true,
              lifecycle: "RECLASSIFICATION"
            })}
          FOR UPDATE OF version, fact, scope
        `);
        if (!current) continue;
        const state = classifiedState(
          result.decision.sensitivity,
          result.decision.storageDecision,
          result.decision.subjectScope,
          candidate.sourceMode
        );
        const isFenced = state === "SECRET_FENCED" || state === "REJECTED_FENCED";
        const canonicalSensitivity = canonicalStorableSensitivity(
          result.decision.sensitivity
        );
        const canonicalCategory = canonicalStorableCategory(
          result.decision.category
        );
        const effectiveReasonCode = candidate.sourceMode === "AUTOMATIC" &&
          result.decision.subjectScope !== "USER"
          ? result.decision.subjectScope === "UNCERTAIN"
            ? "uncertain"
            : "third_party_rejected"
          : result.decision.reasonCode;
        if (isFenced) {
          const fenced = await tx.$executeRaw(Prisma.sql`
            UPDATE "MemoryFactVersion"
            SET
              "state" = 'RETRACTED'::"MemoryFactVersionState",
              "systemTo" = COALESCE(
                "systemTo",
                GREATEST("systemFrom" + INTERVAL '1 millisecond', ${now})
              ),
              "displayText" = NULL,
              "normalizedSearchText" = NULL,
              "structuredValue" = NULL,
              "occurredAt" = NULL,
              "expectedAt" = NULL,
              "expiresAt" = NULL,
              "validFrom" = NULL,
              "validTo" = NULL,
              "rawTemporalExpression" = NULL,
              "sourceTimezone" = NULL,
              "temporalResolverVersion" = NULL,
              "temporalResolutionEvidence" = NULL,
              "contentPurgedAt" = COALESCE("contentPurgedAt", ${now}),
              "sensitivityClass" = ${canonicalSensitivity === "SECRET"
                ? "SECRET"
                : canonicalSensitivity === "UNCERTAIN"
                  ? "HIGHLY_SENSITIVE"
                  : "NORMAL"}::"MemorySensitivityClass",
              "coreEligible" = FALSE,
              "coreSalience" = 'NONE'::"MemoryCoreSalience",
              "safetyClassificationState" = ${state}::"MemorySafetyClassificationState",
              "safetyClassifierExecutionId" = ${result.executionId ?? null},
              "safetyClassifierProviderId" = ${result.providerId},
              "safetyClassifierModelId" = ${result.modelId},
              "safetyClassifierPolicyVersion" = ${result.policyVersion},
              "safetyClassificationReasonCode" = ${effectiveReasonCode},
              "safetyClassifiedAt" = ${result.classifiedAt ?? now}
            WHERE "userId" = ${userId}
              AND "id" = ${candidate.id}
              AND "factId" = ${candidate.factId}
              AND "state" = ${candidate.semanticState}::"MemoryFactVersionState"
              AND "safetyClassificationState" = 'PENDING'::"MemorySafetyClassificationState"
          `);
          if (fenced !== 1) continue;
          // Delete derivatives only after the compare-and-set wins. A stale
          // provider plan must not purge evidence or index entries belonging
          // to a concurrently classified version.
          await tx.memorySearchEntry.deleteMany({
            where: { factVersionId: candidate.id, userId }
          });
          await tx.memoryEvidence.deleteMany({
            where: { factVersionId: candidate.id, userId }
          });
          await removeUnsupportedMemoryEntityLinks(tx, userId, [candidate.id]);
          await tx.$executeRaw(Prisma.sql`
            UPDATE "MemoryFact"
            SET
              "currentVersionId" = NULL,
              "forgottenAt" = NULL,
              "pinned" = FALSE,
              "state" = 'RETRACTED'::"MemoryFactState",
              "updatedAt" = ${now}
            WHERE "userId" = ${userId}
              AND "id" = ${candidate.factId}
              AND "currentVersionId" = ${candidate.id}
              AND "state" = 'ACTIVE'::"MemoryFactState"
          `);
          await tx.$executeRaw(Prisma.sql`
            UPDATE "MemoryFact"
            SET
              "forgottenAt" = NULL,
              "pinned" = FALSE,
              "state" = 'RETRACTED'::"MemoryFactState",
              "updatedAt" = ${now}
            WHERE "userId" = ${userId}
              AND "id" = ${candidate.factId}
              AND "currentVersionId" IS NULL
              AND "state" = 'CONFLICTED'::"MemoryFactState"
          `);
          changed = true;
          continue;
        }

        const pattern = candidate.modality === "PATTERN";
        const coreEligible = !pattern && canonicalSensitivity === "NORMAL" &&
          candidate.sourceMode === "EXPLICIT" &&
          result.decision.responsePreference;
        const coreSalience = coreEligible
          ? candidate.coreSalience === "NONE" && result.decision.responsePreference
            ? "HIGH"
            : candidate.coreSalience
          : "NONE";
        const classified = await tx.memoryFactVersion.updateMany({
          data: {
            category: pattern
              ? "patterns"
              : result.decision.responsePreference
              ? "preferences"
              : canonicalCategory,
            coreEligible,
            coreSalience,
            modality: pattern
              ? "PATTERN"
              : result.decision.responsePreference
              ? "PREFERENCE"
              : candidate.modality === "PREFERENCE" ? "STATE" : candidate.modality,
            safetyClassifiedAt: result.classifiedAt ?? now,
            safetyClassificationState: state,
            safetyClassifierExecutionId: result.executionId ?? null,
            safetyClassifierModelId: result.modelId,
            safetyClassifierPolicyVersion: result.policyVersion,
            safetyClassifierProviderId: result.providerId,
            safetyClassificationReasonCode: effectiveReasonCode,
            sensitivityClass: canonicalSensitivity === "UNCERTAIN"
              ? "HIGHLY_SENSITIVE"
              : "NORMAL"
          },
          where: {
            factId: candidate.factId,
            id: candidate.id,
            safetyClassificationState: "PENDING",
            state: candidate.semanticState,
            userId
          }
        });
        if (classified.count !== 1) continue;
        changed = true;
        if (candidate.semanticState === "ACTIVE" && state === "CLASSIFIED") {
          admittedActiveVersions.push({
            id: candidate.id,
            triggerIdentity: result.executionId ?? memorySha256({
              candidateId: candidate.id,
              domain: "aiqsa.memory.local-reclassification",
              policyVersion: result.policyVersion
            })
          });
        }
        if (pattern) {
          await tx.memoryFact.updateMany({
            data: { category: "patterns", updatedAt: now },
            where: {
              currentVersionId: candidate.id,
              id: candidate.factId,
              state: "ACTIVE",
              userId
            }
          });
        } else if (result.decision.responsePreference) {
          await tx.memoryFact.updateMany({
            data: { category: "preferences", updatedAt: now },
            where: {
              currentVersionId: candidate.id,
              id: candidate.factId,
              state: "ACTIVE",
              userId
            }
          });
        } else {
          await tx.memoryFact.updateMany({
            data: { category: canonicalCategory, updatedAt: now },
            where: {
              currentVersionId: candidate.id,
              id: candidate.factId,
              state: "ACTIVE",
              userId
            }
          });
        }
      }
      if (changed) {
        await advanceMemoryMutation(
          tx,
          settings,
          "FACT_SAFETY_RECLASSIFICATION"
        );
        for (const admitted of admittedActiveVersions) {
          await ensureClassifiedSearchEntry(
            tx,
            settings,
            admitted.id,
            admitted.triggerIdentity,
            now
          );
        }
      }
    }
  });
}
