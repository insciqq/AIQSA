import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../coordinator/types";
import {
  loadMemoryExecutionBinding,
  parseMemoryExecutionSnapshot,
  reauthorizeStoredMemoryExecution,
  type MemoryExecutionAuthorityDependencies
} from "../execution";
import { enqueueMemoryJob } from "../persistence/jobs";
import { memorySha256 } from "../persistence/lexical";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "../persistence/transaction";
import {
  MEMORY_PROFILE_MAX_FACT_TEXT_LENGTH,
  MEMORY_PROFILE_MAX_INPUT_FACTS,
  MEMORY_PROFILE_PIPELINE_VERSION,
  MEMORY_PROFILE_PROJECTION_VERSION,
  MEMORY_PROFILE_VERSIONS,
  memoryProfileInputHash,
  memoryProfileJobInputHash,
  memoryProfileJobFingerprint,
  type MemoryProfileCandidate,
  type MemoryProfileInput,
  type MemoryProfileLanguage,
  type MemoryProfilePlan
} from "./contract";
import {
  memoryTemperatureClassSql,
  memoryTemperatureScoreSql
} from "./temperature";

export type MemoryProfileExecutionBinding = Readonly<{
  acceptedOutputHash: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  state: "CANCELLED" | "FAILED" | "OUTCOME_UNKNOWN" | "PENDING" | "RUNNING" | "SUCCEEDED";
}>;

export type MemoryProfilePrepared =
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{ input: MemoryProfileInput }>;

export type MemoryProfileRepository = Readonly<{
  applyProfile(
    tx: MemoryTransaction,
    claim: MemoryJobClaim,
    expectedInput: MemoryProfileInput,
    plan: MemoryProfilePlan,
    executionId: string,
    now: Date
  ): Promise<void>;
  applySweep(
    tx: MemoryTransaction,
    claim: MemoryJobClaim,
    asOf: Date,
    now: Date
  ): Promise<void>;
  bindings(userId: string, jobId: string): Promise<readonly MemoryProfileExecutionBinding[]>;
  preflightProfile(job: MemoryJobDescriptor, asOf: Date): Promise<MemoryJobGateDecision>;
  preflightSweep(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision>;
  prepareProfile(job: MemoryJobDescriptor, asOf: Date): Promise<MemoryProfilePrepared>;
}>;

type CandidateRow = Readonly<{
  factId: string;
  factVersionContentHash: string;
  factVersionId: string;
  languageCode: MemoryProfileLanguage;
  safetyIdentitySnapshot: string;
  sourceIdentitySnapshot: string;
  suppressionIdentitySnapshot: string;
  temperatureClass: "COLD" | "HOT" | "WARM";
  temperatureScore: number;
  text: string;
}>;

function profileLanguage(
  settings: Pick<LockedMemorySettings, "memoryUiLocale" | "preferredProfileLanguage">,
  rows: readonly CandidateRow[]
): MemoryProfileLanguage | null {
  const preferred = settings.preferredProfileLanguage.toLowerCase();
  if (preferred !== "auto") {
    const root = preferred.split("-", 1)[0];
    return root === "ru" || root === "en" ? root : null;
  }
  const counts = rows.reduce((value, row) => {
    value[row.languageCode] += 1;
    return value;
  }, { en: 0, ru: 0 });
  if (counts.en === 0 && counts.ru === 0) return null;
  if (counts.en === counts.ru) return settings.memoryUiLocale.toLowerCase() as MemoryProfileLanguage;
  return counts.ru > counts.en ? "ru" : "en";
}

async function globalScopeId(
  tx: MemoryTransaction,
  userId: string
): Promise<string | null> {
  const scope = await tx.memoryScope.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
    where: { scopeType: "GLOBAL_USER", state: "ACTIVE", userId }
  });
  return scope?.id ?? null;
}

async function candidateRows(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  scopeId: string,
  asOf: Date
): Promise<readonly CandidateRow[]> {
  if (!settings.activeIndexGenerationId) return [];
  return tx.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId",
      version."id" AS "factVersionId",
      version."displayText" AS "text",
      lower(split_part(version."languageCode", '-', 1)) AS "languageCode",
      fact."temperatureClass"::text AS "temperatureClass",
      fact."temperatureScore",
      search."safeContentHash" AS "factVersionContentHash",
      search."sourceIdentitySnapshot",
      search."safetyIdentitySnapshot",
      search."suppressionIdentitySnapshot"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."factId" = fact."id"
      AND version."id" = fact."currentVersionId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemorySearchEntry" AS search
      ON search."userId" = fact."userId"
      AND search."indexGenerationId" = ${settings.activeIndexGenerationId}
      AND search."factVersionId" = version."id"
    WHERE fact."userId" = ${settings.userId}
      AND fact."scopeId" = ${scopeId}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND char_length(version."displayText") <= ${MEMORY_PROFILE_MAX_FACT_TEXT_LENGTH}
      AND lower(split_part(version."languageCode", '-', 1)) IN ('ru', 'en')
      AND version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
      AND (version."validFrom" IS NULL OR version."validFrom" <= ${asOf})
      AND (version."validTo" IS NULL OR version."validTo" > ${asOf})
      AND EXISTS (
        SELECT 1
        FROM "MemoryEvidence" AS evidence
        WHERE evidence."userId" = version."userId"
          AND evidence."factVersionId" = version."id"
          AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
          AND evidence."safetyClass" = 'NORMAL'::"MemorySensitivityClass"
          AND (
            (
              version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
              AND evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
              AND evidence."sourceRole" = 'user'
            ) OR (
              version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
              AND evidence."sourceType" = 'EXPLICIT_ACTION'::"MemoryEvidenceSourceType"
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryEvidence" AS unsafe_evidence
        WHERE unsafe_evidence."userId" = version."userId"
          AND unsafe_evidence."factVersionId" = version."id"
          AND unsafe_evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
          AND unsafe_evidence."safetyClass" <> 'NORMAL'::"MemorySensitivityClass"
      )
    ORDER BY
      fact."pinned" DESC,
      fact."temperatureScore" DESC,
      version."importance" DESC,
      fact."lastConfirmedAt" DESC NULLS LAST,
      fact."lastUsedAt" DESC NULLS LAST,
      fact."id" ASC
    LIMIT ${MEMORY_PROFILE_MAX_INPUT_FACTS * 2}
  `);
}

async function hasExcludedSafety(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  scopeId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ excluded: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "MemoryFact" AS fact
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = fact."userId"
        AND version."factId" = fact."id"
        AND version."id" = fact."currentVersionId"
      WHERE fact."userId" = ${settings.userId}
        AND fact."scopeId" = ${scopeId}
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
        AND version."contentPurgedAt" IS NULL
        AND (
          version."sensitivityClass" <> 'NORMAL'::"MemorySensitivityClass"
          OR EXISTS (
            SELECT 1 FROM "MemoryEvidence" AS evidence
            WHERE evidence."userId" = version."userId"
              AND evidence."factVersionId" = version."id"
              AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
              AND evidence."safetyClass" <> 'NORMAL'::"MemorySensitivityClass"
          )
        )
    ) AS "excluded"
  `);
  return rows[0]?.excluded === true;
}

export async function prepareGlobalMemoryProfileInput(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  asOf: Date
): Promise<MemoryProfileInput | null> {
  if (!settings.useMemoryFacts || !Number.isFinite(asOf.getTime())) return null;
  const scopeId = await globalScopeId(tx, settings.userId);
  if (!scopeId) return null;
  const rows = await candidateRows(tx, settings, scopeId, asOf);
  const languageCode = profileLanguage(settings, rows);
  if (!languageCode) return null;
  const selected = rows.filter((row) => row.languageCode === languageCode)
    .slice(0, MEMORY_PROFILE_MAX_INPUT_FACTS);
  if (selected.length === 0) return null;
  const candidates: readonly MemoryProfileCandidate[] = selected.map((row) => ({ ...row }));
  const sourceIdentitySnapshot = memorySha256({
    candidates: candidates.map(({ factVersionId, sourceIdentitySnapshot }) => ({
      factVersionId,
      sourceIdentitySnapshot
    })),
    version: 1
  });
  const safetyIdentitySnapshot = memorySha256({
    candidates: candidates.map(({ factVersionId, safetyIdentitySnapshot }) => ({
      factVersionId,
      safetyIdentitySnapshot
    })),
    version: 1
  });
  const suppressionIdentitySnapshot = memorySha256({
    candidates: candidates.map(({ factVersionId, suppressionIdentitySnapshot }) => ({
      factVersionId,
      suppressionIdentitySnapshot
    })),
    version: 1
  });
  const withoutHash: Omit<MemoryProfileInput, "inputHash"> = {
    asOf: asOf.toISOString(),
    candidates,
    languageCode,
    memoryGeneration: settings.memoryGeneration,
    memoryRevision: settings.memoryRevision,
    redactionState: await hasExcludedSafety(tx, settings, scopeId)
      ? "REDACTED"
      : "NOT_NEEDED",
    safetyIdentitySnapshot,
    scopeId,
    sourceIdentitySnapshot,
    suppressionIdentitySnapshot
  };
  return { ...withoutHash, inputHash: memoryProfileInputHash(withoutHash) };
}

async function updateTemperatures(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  asOf: Date
): Promise<number> {
  const score = memoryTemperatureScoreSql(asOf);
  const temperatureClass = memoryTemperatureClassSql(Prisma.sql`scored."score"`);
  const rows = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    WITH scored AS MATERIALIZED (
      SELECT fact."id", ${score} AS "score"
      FROM "MemoryFact" AS fact
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = fact."userId"
        AND version."factId" = fact."id"
        AND version."id" = fact."currentVersionId"
      WHERE fact."userId" = ${settings.userId}
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
        AND version."contentPurgedAt" IS NULL
    ), updated AS (
      UPDATE "MemoryFact" AS fact
      SET
        "temperatureScore" = scored."score",
        "temperatureClass" = ${temperatureClass}
      FROM scored
      WHERE fact."userId" = ${settings.userId}
        AND fact."id" = scored."id"
        AND (
          fact."temperatureScore" IS DISTINCT FROM scored."score"
          OR fact."temperatureClass" IS DISTINCT FROM ${temperatureClass}
        )
      RETURNING fact."id"
    )
    SELECT count(*)::bigint AS "count" FROM updated
  `);
  const count = Number(rows[0]?.count ?? 0n);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_working_set_update_invalid");
  }
  return count;
}

async function invalidateGlobalProfiles(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  now: Date,
  languageCode: MemoryProfileLanguage | null = null
): Promise<number> {
  const scopeId = await globalScopeId(tx, settings.userId);
  if (!scopeId) return 0;
  return tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryProfileProjection" AS profile
    SET
      "state" = 'INVALIDATED'::"MemoryProfileProjectionState",
      "updatedAt" = GREATEST(profile."updatedAt", ${now})
    WHERE profile."userId" = ${settings.userId}
      AND profile."scopeId" = ${scopeId}
      AND profile."state" = 'ACTIVE'::"MemoryProfileProjectionState"
      AND (${languageCode}::text IS NULL OR profile."languageCode" = ${languageCode})
  `);
}

async function profileGate(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor,
  asOf: Date
): Promise<MemoryProfilePrepared> {
  if (!settings.useMemoryFacts) {
    return { decision: { errorCode: "memory_profile_disabled", status: "CANCELLED" } };
  }
  if (settings.memoryGeneration !== job.memoryGenerationSnapshot) {
    return { decision: { errorCode: "memory_profile_generation_stale", status: "STALE" } };
  }
  const input = await prepareGlobalMemoryProfileInput(tx, settings, asOf);
  if (!input) {
    return { decision: { errorCode: "memory_profile_empty", status: "CANCELLED" } };
  }
  if (memoryProfileJobInputHash(job.idempotencyFingerprint) !== input.inputHash) {
    return { decision: { errorCode: "memory_profile_input_stale", status: "STALE" } };
  }
  return { input };
}

async function requireAuthorizedProfileBinding(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  authority: MemoryExecutionAuthorityDependencies,
  input: Readonly<{
    bindingId: string;
    inputHash: string;
    jobId: string;
    now: Date;
    outputHash: string;
  }>
): Promise<void> {
  const binding = await loadMemoryExecutionBinding(tx, settings.userId, input.bindingId);
  if (
    binding.acceptedOutputHash !== input.outputHash ||
    binding.inputHash !== input.inputHash ||
    binding.logicalRole !== "MEMORY_PROFILE" ||
    binding.memoryJobId !== input.jobId || binding.ownerType !== "JOB" ||
    binding.state !== "SUCCEEDED" || binding.relationsDetachedAt !== null
  ) throw new Error("memory_profile_binding_stale");
  await reauthorizeStoredMemoryExecution(tx, settings, {
    dependencies: authority,
    now: input.now,
    snapshot: parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot),
    userId: settings.userId
  });
}

export function createPrismaMemoryProfileRepository(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma
): MemoryProfileRepository {
  return Object.freeze({
    async applyProfile(tx, claim, expectedInput, plan, executionId, now) {
      const settings = await lockMemorySettings(tx, claim.userId, true);
      const prepared = await profileGate(tx, settings, claim, new Date(expectedInput.asOf));
      if ("decision" in prepared || prepared.input.inputHash !== expectedInput.inputHash) {
        await invalidateGlobalProfiles(tx, settings, now);
        return;
      }
      const selected = plan.segments.map((segment) => {
        const candidate = prepared.input.candidates.find(({ factVersionId }) =>
          factVersionId === segment.factVersionId);
        if (!candidate || candidate.text !== segment.text) {
          throw new Error("memory_profile_plan_stale");
        }
        return candidate;
      });
      await requireAuthorizedProfileBinding(tx, settings, authority, {
        bindingId: executionId,
        inputHash: expectedInput.inputHash,
        jobId: claim.id,
        now,
        outputHash: plan.outputHash
      });
      await advanceMemoryMutation(tx, settings, "PROFILE_REPLACEMENT");
      await invalidateGlobalProfiles(
        tx,
        settings,
        now,
        prepared.input.languageCode
      );
      const summary = plan.segments.map(({ text }) => text).join("\n");
      const projectionId = randomUUID();
      await tx.memoryProfileProjection.create({
        data: {
          asOf: new Date(prepared.input.asOf),
          createdAt: now,
          createdByExecutionId: executionId,
          id: projectionId,
          inputHash: prepared.input.inputHash,
          languageCode: prepared.input.languageCode,
          memoryGeneration: settings.memoryGeneration,
          memoryRevision: settings.memoryRevision,
          outputHash: plan.outputHash,
          projectionVersion: MEMORY_PROFILE_PROJECTION_VERSION,
          redactionState: prepared.input.redactionState,
          safeContentHash: memorySha256({
            factVersionIds: selected.map(({ factVersionId }) => factVersionId),
            languageCode: prepared.input.languageCode,
            summary,
            version: 1
          }),
          safetyClass: "NORMAL",
          safetyIdentitySnapshot: memorySha256({
            contributors: selected.map(({ factVersionId, safetyIdentitySnapshot }) => ({
              factVersionId,
              safetyIdentitySnapshot
            })),
            version: 1
          }),
          scopeId: prepared.input.scopeId,
          sourceIdentitySnapshot: memorySha256({
            contributors: selected.map(({ factVersionId, sourceIdentitySnapshot }) => ({
              factVersionId,
              sourceIdentitySnapshot
            })),
            version: 1
          }),
          state: "ACTIVE",
          summary,
          suppressionIdentitySnapshot: memorySha256({
            contributors: selected.map(({ factVersionId, suppressionIdentitySnapshot }) => ({
              factVersionId,
              suppressionIdentitySnapshot
            })),
            version: 1
          }),
          updatedAt: now,
          userId: settings.userId
        }
      });
      await tx.memoryProfileProjectionFact.createMany({
        data: selected.map((candidate, ordinal) => ({
          factId: candidate.factId,
          factVersionContentHash: candidate.factVersionContentHash,
          factVersionId: candidate.factVersionId,
          ordinal,
          projectionId,
          safetyIdentitySnapshot: candidate.safetyIdentitySnapshot,
          sourceIdentitySnapshot: candidate.sourceIdentitySnapshot,
          suppressionIdentitySnapshot: candidate.suppressionIdentitySnapshot,
          userId: settings.userId
        }))
      });
    },

    async applySweep(tx, claim, asOf, now) {
      const settings = await lockMemorySettings(tx, claim.userId, true);
      if (!settings.useMemoryFacts || settings.memoryGeneration !== claim.memoryGenerationSnapshot) {
        return;
      }
      const changed = await updateTemperatures(tx, settings, asOf);
      if (changed > 0) {
        await advanceMemoryMutation(tx, settings, "WORKING_SET_RECALCULATION");
      }
      const input = await prepareGlobalMemoryProfileInput(tx, settings, asOf);
      if (!input) {
        const invalidated = await invalidateGlobalProfiles(tx, settings, now);
        if (invalidated > 0 && changed === 0) {
          await advanceMemoryMutation(tx, settings, "PROFILE_REPLACEMENT");
        }
        return;
      }
      await enqueueMemoryJob(tx, settings, {
        idempotencyFingerprint: memoryProfileJobFingerprint(input.inputHash, claim.id),
        kind: "RECALCULATE_WORKING_SET",
        pipelineVersion: MEMORY_PROFILE_PIPELINE_VERSION
      });
    },

    async bindings(userId, jobId) {
      return client.memoryExecutionBinding.findMany({
        orderBy: [{ ordinal: "asc" }, { createdAt: "asc" }],
        select: {
          acceptedOutputHash: true,
          id: true,
          inputHash: true,
          ordinal: true,
          state: true
        },
        where: {
          logicalRole: "MEMORY_PROFILE",
          memoryJobId: jobId,
          ownerType: "JOB",
          userId
        }
      });
    },

    async preflightProfile(job, asOf) {
      return withLockedMemoryTransaction(client, job.userId, async (tx, settings) => {
        const prepared = await profileGate(tx, settings, job, asOf);
        return "decision" in prepared ? prepared.decision : { status: "READY" };
      });
    },

    async preflightSweep(job) {
      return withLockedMemoryTransaction(client, job.userId, async (_tx, settings) => {
        if (!settings.useMemoryFacts) {
          return { errorCode: "memory_working_set_disabled", status: "CANCELLED" };
        }
        if (settings.memoryGeneration !== job.memoryGenerationSnapshot) {
          return { errorCode: "memory_working_set_generation_stale", status: "STALE" };
        }
        return { status: "READY" };
      });
    },

    async prepareProfile(job, asOf) {
      return withLockedMemoryTransaction(client, job.userId, (tx, settings) =>
        profileGate(tx, settings, job, asOf));
    }
  });
}

export const MEMORY_WORKING_SET_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const MEMORY_WORKING_SET_RECONCILE_OWNER_LIMIT = 25;

export async function reconcileMemoryWorkingSetJobs(
  client: PrismaClient = prisma,
  options: Readonly<{ limit?: number; now?: Date }> = {}
): Promise<Readonly<{ created: number; owners: number }>> {
  const limit = options.limit ?? MEMORY_WORKING_SET_RECONCILE_OWNER_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("memory_working_set_reconcile_limit_invalid");
  }
  const now = options.now ?? new Date();
  const bucket = Math.floor(now.getTime() / MEMORY_WORKING_SET_REFRESH_INTERVAL_MS);
  const owners = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT settings."userId"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "User" AS owner ON owner."id" = settings."userId"
    WHERE settings."useMemoryFacts" AND owner."status" = 'active'
    ORDER BY settings."userId"
    LIMIT ${limit}
  `);
  let created = 0;
  for (const owner of owners) {
    const result = await withLockedMemoryTransaction(client, owner.userId, (tx, settings) =>
      enqueueMemoryJob(tx, settings, {
        idempotencyFingerprint: `working-set-periodic:${memorySha256({
          bucket,
          intervalMs: MEMORY_WORKING_SET_REFRESH_INTERVAL_MS,
          userId: owner.userId,
          version: 1
        })}`,
        kind: "RECALCULATE_WORKING_SET",
        pipelineVersion: MEMORY_PROFILE_PIPELINE_VERSION
      }));
    if (result.created) created += 1;
  }
  return { created, owners: owners.length };
}
