import { Prisma, type PrismaClient } from "@prisma/client";
import { enqueueMemoryJob } from "../persistence/jobs";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  memorySynthesisPatternInvalidationPredicate,
  memorySynthesisSourceAuthorityPredicate
} from "./eligibility";
import {
  loadMemorySynthesisSnapshot,
  reconcileInvalidMemorySynthesisPatterns
} from "./repository";
import {
  decideMemorySynthesisSchedule,
  memorySynthesisJobFingerprint,
  MEMORY_SYNTHESIS_COOLDOWN_MS,
  MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS,
  MEMORY_SYNTHESIS_MAX_SCHEDULED_OWNERS,
  MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES,
  MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER,
  MEMORY_SYNTHESIS_NEW_FACT_TRIGGER,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION,
  MEMORY_SYNTHESIS_QUIET_PERIOD_MS,
  type MemorySynthesisActivity,
  type MemorySynthesisScheduleDecision
} from "./policy";

type OwnerRow = Readonly<{ userId: string }>;
type ActivityRow = Readonly<{
  changedFactCount: bigint;
  eligibleSourceCount: bigint;
  firstChangedAt: Date | null;
  lastChangedAt: Date | null;
  newEvidenceChatCount: bigint;
}>;

type SynthesisActivityClient = Pick<PrismaClient, "$queryRaw">;

export type MemorySynthesisScheduleStatus = Readonly<{
  activity: MemorySynthesisActivity | null;
  decision: MemorySynthesisScheduleDecision;
}>;

export type MemorySynthesisReconciliationResult = Readonly<{
  invalidated: number;
  scheduled: number;
}>;

export type MemorySynthesisAuthorityProbe = (userId: string) => Promise<boolean>;

function safeCount(value: bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_synthesis_activity_count_invalid");
  }
  return count;
}

async function loadActivity(
  client: SynthesisActivityClient,
  userId: string,
  boundary: Date,
  lastSynthesisAt: Date | null
): Promise<MemorySynthesisActivity> {
  const rows = await client.$queryRaw<ActivityRow[]>(Prisma.sql`
    SELECT
      COUNT(DISTINCT source_fact."id")::bigint AS "eligibleSourceCount",
      COUNT(DISTINCT source_fact."id") FILTER (
        WHERE source_version."createdAt" > ${boundary}
          OR new_evidence."id" IS NOT NULL
      )::bigint AS "changedFactCount",
      COUNT(DISTINCT new_evidence."chatId") FILTER (
        WHERE new_evidence."chatId" IS NOT NULL
      )::bigint AS "newEvidenceChatCount",
      LEAST(
        MIN(source_version."createdAt") FILTER (
          WHERE source_version."createdAt" > ${boundary}
        ),
        MIN(new_evidence."createdAt")
      ) AS "firstChangedAt",
      GREATEST(
        MAX(source_version."createdAt") FILTER (
          WHERE source_version."createdAt" > ${boundary}
        ),
        MAX(new_evidence."createdAt")
      ) AS "lastChangedAt"
    FROM "MemoryFactVersion" AS source_version
    INNER JOIN "MemoryFact" AS source_fact
      ON source_fact."userId" = source_version."userId"
     AND source_fact."id" = source_version."factId"
    INNER JOIN "MemoryScope" AS source_scope
      ON source_scope."userId" = source_fact."userId"
     AND source_scope."id" = source_fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = source_version."userId"
    LEFT JOIN "MemoryEvidence" AS new_evidence
      ON new_evidence."userId" = source_version."userId"
     AND new_evidence."factVersionId" = source_version."id"
     AND new_evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
     AND new_evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
     AND new_evidence."sourceRole" = 'user'
     AND new_evidence."createdAt" > ${boundary}
    WHERE source_version."userId" = ${userId}
      AND ${memorySynthesisSourceAuthorityPredicate(userId)}
  `);
  const row = rows[0];
  if (!row) throw new Error("memory_synthesis_activity_unavailable");
  return Object.freeze({
    changedFactCount: safeCount(row.changedFactCount),
    eligibleSourceCount: safeCount(row.eligibleSourceCount),
    firstChangedAt: row.firstChangedAt,
    lastChangedAt: row.lastChangedAt,
    lastSynthesisAt,
    newEvidenceChatCount: safeCount(row.newEvidenceChatCount)
  });
}

export async function loadMemorySynthesisScheduleStatus(
  client: PrismaClient,
  userId: string,
  now: Date
): Promise<MemorySynthesisScheduleStatus> {
  const settings = await client.userMemorySettings.findUnique({
    select: {
      lastSynthesisAt: true,
      synthesisEnabled: true,
      synthesisEnabledAt: true,
      synthesisPolicyVersion: true,
      useMemoryFacts: true
    },
    where: { userId }
  });
  if (
    !settings?.useMemoryFacts || !settings.synthesisEnabled ||
    !settings.synthesisEnabledAt ||
    settings.synthesisPolicyVersion !== MEMORY_SYNTHESIS_POLICY_VERSION
  ) {
    return Object.freeze({
      activity: null,
      decision: Object.freeze({ due: false, reason: "NO_NEW_ACTIVITY" })
    });
  }
  const boundary = settings.lastSynthesisAt ?? settings.synthesisEnabledAt;
  const activity = await loadActivity(
    client,
    userId,
    boundary,
    settings.lastSynthesisAt
  );
  return Object.freeze({
    activity,
    decision: decideMemorySynthesisSchedule(activity, now)
  });
}

async function invalidPatternOwners(
  client: PrismaClient
): Promise<readonly OwnerRow[]> {
  return client.$queryRaw<OwnerRow[]>(Prisma.sql`
    SELECT version."userId"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
     AND fact."id" = version."factId"
     AND fact."state" = 'ACTIVE'::"MemoryFactState"
     AND fact."currentVersionId" = version."id"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
     AND scope."id" = fact."scopeId"
     AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    INNER JOIN "User" AS owner_user
      ON owner_user."id" = version."userId"
     AND owner_user."status" = 'active'::"UserStatus"
    WHERE version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."modality" = 'PATTERN'::"MemoryFactModality"
      AND ${memorySynthesisPatternInvalidationPredicate(
        Prisma.sql`version."userId"`
      )}
    GROUP BY version."userId"
    ORDER BY MIN(version."createdAt"), version."userId"
    LIMIT ${MEMORY_SYNTHESIS_MAX_SCHEDULED_OWNERS}
  `);
}

async function schedulableOwners(
  client: PrismaClient,
  now: Date
): Promise<readonly OwnerRow[]> {
  const cooldownBefore = new Date(now.getTime() - MEMORY_SYNTHESIS_COOLDOWN_MS);
  const quietBefore = new Date(now.getTime() - MEMORY_SYNTHESIS_QUIET_PERIOD_MS);
  const fallbackBefore = new Date(
    now.getTime() - MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS
  );
  return client.$queryRaw<OwnerRow[]>(Prisma.sql`
    WITH eligible_source AS (
      SELECT
        source_version."userId",
        source_version."id" AS "versionId",
        source_version."createdAt" AS "sourceCreatedAt",
        source_fact."id" AS "factId",
        settings."lastSynthesisAt",
        settings."synthesisEnabledAt",
        COALESCE(
          settings."lastSynthesisAt",
          settings."synthesisEnabledAt"
        ) AS "activityBoundary"
      FROM "MemoryFactVersion" AS source_version
      INNER JOIN "MemoryFact" AS source_fact
        ON source_fact."userId" = source_version."userId"
       AND source_fact."id" = source_version."factId"
      INNER JOIN "MemoryScope" AS source_scope
        ON source_scope."userId" = source_fact."userId"
       AND source_scope."id" = source_fact."scopeId"
      INNER JOIN "UserMemorySettings" AS settings
        ON settings."userId" = source_version."userId"
      INNER JOIN "User" AS owner_user
        ON owner_user."id" = source_version."userId"
       AND owner_user."status" = 'active'::"UserStatus"
      WHERE settings."useMemoryFacts" = TRUE
        AND settings."synthesisEnabled" = TRUE
        AND settings."synthesisPolicyVersion" =
          ${MEMORY_SYNTHESIS_POLICY_VERSION}
        AND settings."synthesisEnabledAt" IS NOT NULL
        AND ${memorySynthesisSourceAuthorityPredicate(
          Prisma.sql`source_version."userId"`
        )}
    ), owner_activity AS (
      SELECT
        eligible_source."userId",
        eligible_source."lastSynthesisAt",
        COUNT(DISTINCT eligible_source."factId")::bigint AS
          "eligibleSourceCount",
        COUNT(DISTINCT eligible_source."factId") FILTER (
          WHERE eligible_source."sourceCreatedAt" >
              eligible_source."activityBoundary"
            OR new_evidence."id" IS NOT NULL
        )::bigint AS "changedFactCount",
        COUNT(DISTINCT new_evidence."chatId") FILTER (
          WHERE new_evidence."chatId" IS NOT NULL
        )::bigint AS "newEvidenceChatCount",
        LEAST(
          MIN(eligible_source."sourceCreatedAt") FILTER (
            WHERE eligible_source."sourceCreatedAt" >
              eligible_source."activityBoundary"
          ),
          MIN(new_evidence."createdAt")
        ) AS "firstChangedAt",
        GREATEST(
          MAX(eligible_source."sourceCreatedAt") FILTER (
            WHERE eligible_source."sourceCreatedAt" >
              eligible_source."activityBoundary"
          ),
          MAX(new_evidence."createdAt")
        ) AS "lastChangedAt"
      FROM eligible_source
      LEFT JOIN "MemoryEvidence" AS new_evidence
        ON new_evidence."userId" = eligible_source."userId"
       AND new_evidence."factVersionId" = eligible_source."versionId"
       AND new_evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
       AND new_evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
       AND new_evidence."sourceRole" = 'user'
       AND new_evidence."createdAt" > eligible_source."activityBoundary"
      GROUP BY eligible_source."userId", eligible_source."lastSynthesisAt"
    )
    SELECT owner_activity."userId"
    FROM owner_activity
    WHERE owner_activity."eligibleSourceCount" >=
        ${MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES}
      AND owner_activity."changedFactCount" > 0
      AND (
        owner_activity."lastSynthesisAt" IS NULL
        OR owner_activity."lastSynthesisAt" <= ${cooldownBefore}
      )
      AND owner_activity."lastChangedAt" <= ${quietBefore}
      AND (
        owner_activity."newEvidenceChatCount" >=
          ${MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER}
        OR owner_activity."changedFactCount" >=
          ${MEMORY_SYNTHESIS_NEW_FACT_TRIGGER}
        OR owner_activity."firstChangedAt" <= ${fallbackBefore}
      )
    ORDER BY owner_activity."lastSynthesisAt" NULLS FIRST,
      owner_activity."firstChangedAt", owner_activity."userId"
    LIMIT ${MEMORY_SYNTHESIS_MAX_SCHEDULED_OWNERS}
  `);
}

export async function reconcileMemorySynthesisWork(
  client: PrismaClient,
  now: Date,
  authorityAvailable: MemorySynthesisAuthorityProbe
): Promise<MemorySynthesisReconciliationResult> {
  if (!Number.isFinite(now.getTime())) return { invalidated: 0, scheduled: 0 };
  let invalidated = 0;
  let scheduled = 0;
  const targetedOwners = new Set<string>();
  for (const owner of await invalidPatternOwners(client)) {
    const result = await withLockedMemoryTransaction(
      client,
      owner.userId,
      (tx, settings) => reconcileInvalidMemorySynthesisPatterns(
        tx,
        settings,
        now
      )
    );
    invalidated += result.invalidated;
    scheduled += result.scheduled;
    if (result.scheduled > 0) targetedOwners.add(owner.userId);
  }

  for (const owner of await schedulableOwners(client, now)) {
    if (targetedOwners.has(owner.userId)) continue;
    const admitted = await authorityAvailable(owner.userId).catch(() => false);
    if (!admitted) continue;
    scheduled += await withLockedMemoryTransaction(
      client,
      owner.userId,
      async (tx, settings) => {
        if (
          !settings.useMemoryFacts || !settings.synthesisEnabled ||
          !settings.synthesisEnabledAt ||
          settings.synthesisPolicyVersion !== MEMORY_SYNTHESIS_POLICY_VERSION
        ) return 0;
        const boundary = settings.lastSynthesisAt ?? settings.synthesisEnabledAt;
        const activity = await loadActivity(
          tx,
          owner.userId,
          boundary,
          settings.lastSynthesisAt
        );
        if (!decideMemorySynthesisSchedule(activity, now).due) return 0;
        const snapshot = await loadMemorySynthesisSnapshot(tx, owner.userId);
        const plan = snapshot?.plan;
        if (!plan) return 0;
        const idempotencyFingerprint = memorySynthesisJobFingerprint({
          sourceSetFingerprint: plan.sourceSetFingerprint,
          userId: owner.userId
        });
        const revived = await tx.memoryJob.updateMany({
          data: {
            acceptedResultHash: null,
            attemptCount: 0,
            completedAt: null,
            errorCode: null,
            errorMessage: null,
            leaseExpiresAt: null,
            leaseToken: null,
            memoryGenerationSnapshot: settings.memoryGeneration,
            memoryRevisionSnapshot: settings.memoryRevision,
            nextAttemptAt: null,
            stage: null,
            state: "QUEUED"
          },
          where: {
            idempotencyFingerprint,
            kind: "SYNTHESIZE_MEMORIES",
            state: { in: ["CANCELLED", "STALE"] },
            userId: owner.userId
          }
        });
        const result = await enqueueMemoryJob(tx, settings, {
          idempotencyFingerprint,
          kind: "SYNTHESIZE_MEMORIES",
          pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION
        });
        return result.created || revived.count > 0 ? 1 : 0;
      }
    );
  }
  return Object.freeze({ invalidated, scheduled });
}
