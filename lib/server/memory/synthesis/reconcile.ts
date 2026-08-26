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
  memorySynthesisJobFingerprint,
  MEMORY_SYNTHESIS_COOLDOWN_MS,
  MEMORY_SYNTHESIS_MAX_SCHEDULED_OWNERS,
  MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION
} from "./policy";

type OwnerRow = Readonly<{ userId: string }>;

export type MemorySynthesisReconciliationResult = Readonly<{
  invalidated: number;
  scheduled: number;
}>;

export type MemorySynthesisAuthorityProbe = (userId: string) => Promise<boolean>;

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
  return client.$queryRaw<OwnerRow[]>(Prisma.sql`
    SELECT source_version."userId"
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
      AND settings."synthesisPolicyVersion" = ${MEMORY_SYNTHESIS_POLICY_VERSION}
      AND settings."synthesisEnabledAt" IS NOT NULL
      AND (
        settings."lastSynthesisAt" IS NULL
        OR settings."lastSynthesisAt" <= ${cooldownBefore}
      )
      AND ${memorySynthesisSourceAuthorityPredicate(
        Prisma.sql`source_version."userId"`
      )}
    GROUP BY source_version."userId", settings."lastSynthesisAt"
    HAVING COUNT(DISTINCT source_fact."id") >=
      ${MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES}
    ORDER BY settings."lastSynthesisAt" NULLS FIRST, source_version."userId"
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

  const cooldownBefore = new Date(now.getTime() - MEMORY_SYNTHESIS_COOLDOWN_MS);
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
          settings.synthesisPolicyVersion !== MEMORY_SYNTHESIS_POLICY_VERSION ||
          (settings.lastSynthesisAt !== null &&
            settings.lastSynthesisAt > cooldownBefore)
        ) return 0;
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
