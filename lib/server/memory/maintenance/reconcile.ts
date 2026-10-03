import { Prisma, type PrismaClient } from "@prisma/client";
import { enqueueMemoryJob } from "../persistence/jobs";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_MAINTENANCE_MAX_OWNERS, MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION,
  MEMORY_MAINTENANCE_QUIET_MS, MEMORY_MAINTENANCE_SCHEDULE_TRANSACTION_BOUNDS } from "./policy";
import { memoryMaintenanceSourcePredicate, memoryMaintenanceUncoveredPredicate, scanMemoryMaintenanceSources } from "./source";

export async function scheduleOwnerMemoryMaintenance(client: PrismaClient, userId: string, now: Date): Promise<number> {
  return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
    if (!settings.useMemoryFacts || !settings.learnAutomatically) return 0;
    if (await tx.memoryJob.count({ where: { userId, kind: "SYNTHESIZE_MEMORIES", state: { in: ["QUEUED", "CLAIMED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION"] } } })) return 0;
    const cursor = await tx.userMemorySettings.findUniqueOrThrow({ where: { userId }, select: { maintenanceCursor: true } });
    const scan = await scanMemoryMaintenanceSources(tx, userId, now, cursor.maintenanceCursor);
    await tx.userMemorySettings.update({ where: { userId }, data: { maintenanceCursor: scan.cursor, maintenanceScannedAt: now },
      select: { userId: true } });
    // A blocked or unreviewable source is settled here, before any provider
    // call and without a job; its row covers it until the weekly recheck.
    if (scan.blockers.length) {
      await tx.memoryMaintenanceReview.createMany({ data: scan.blockers.map((blocker) => ({
        userId, factVersionId: blocker.versionId, memoryJobId: null, policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
        sourceSnapshotHash: blocker.sourceSnapshotHash, evidenceThrough: blocker.evidenceThrough,
        disposition: blocker.disposition, reasonCode: blocker.reasonCode, reviewedAt: now
      })) });
    }
    const plan = scan.plan;
    if (!plan) return 0;
    const idempotencyFingerprint = memorySha256({ domain: "memory-maintenance-job", userId,
      memoryGeneration: settings.memoryGeneration, sourceSnapshotHash: plan.sourceSnapshotHash });
    const prior = await tx.memoryJob.findFirst({ where: { userId, idempotencyFingerprint,
      state: { in: ["STALE", "CANCELLED"] } }, select: { id: true } });
    let revived = false;
    if (prior && !await tx.memoryExecutionBinding.count({ where: { userId, memoryJobId: prior.id } })) {
      await tx.memoryMaintenanceReview.deleteMany({ where: { userId, memoryJobId: prior.id, disposition: "PENDING" } });
      await tx.memoryJob.update({ where: { id: prior.id }, data: { state: "QUEUED", completedAt: null, errorCode: null,
        errorMessage: null, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null, stage: null,
        memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision } });
      revived = true;
    }
    const queued = await enqueueMemoryJob(tx, settings, { kind: "SYNTHESIZE_MEMORIES",
      pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
      idempotencyFingerprint });
    if (!queued.created && !revived) return 0;
    await tx.memoryMaintenanceReview.createMany({ data: plan.sources.map((source) => ({
      userId, factVersionId: source.versionId, memoryJobId: queued.id,
      policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION, sourceSnapshotHash: source.sourceSnapshotHash,
      evidenceThrough: source.evidenceThrough
    })) });
    return 1;
  }, { interactiveBounds: MEMORY_MAINTENANCE_SCHEDULE_TRANSACTION_BOUNDS });
}

export async function reconcileMemoryMaintenanceWork(client: PrismaClient, now: Date,
  authorityAvailable: (userId: string) => Promise<boolean>): Promise<Readonly<{ scheduled: number }>> {
  // Settle content-free checkpoints for terminal jobs without retrying their
  // possibly dispatched calls. A failed attempt admits new jobs only within the
  // budgets of memoryMaintenanceUncoveredPredicate, each under a new source
  // hash; new independent evidence or a future policy admits another pass.
  await client.$executeRaw(Prisma.sql`
    DELETE FROM "MemoryMaintenanceReview" review USING "MemoryJob" job
    WHERE job."userId" = review."userId" AND job.id = review."memoryJobId" AND review.disposition = 'PENDING'
      AND job.state IN ('CANCELLED', 'STALE')
      AND NOT EXISTS (SELECT 1 FROM "MemoryExecutionBinding" execution WHERE execution."userId" = job."userId" AND execution."memoryJobId" = job.id)
  `);
  await client.$executeRaw(Prisma.sql`
    UPDATE "MemoryMaintenanceReview" review SET disposition = CASE WHEN job.state = 'STALE'::"MemoryJobState" THEN 'STALE' ELSE 'UNKNOWN' END,
      "reviewedAt" = ${now}
    FROM "MemoryJob" job WHERE job."userId" = review."userId" AND job.id = review."memoryJobId"
      AND review.disposition = 'PENDING' AND job.state IN ('TERMINAL_FAILED', 'CANCELLED', 'STALE', 'SUCCEEDED')
  `);
  await client.$executeRaw(Prisma.sql`
    UPDATE "MemoryMaintenanceExecution" execution SET "acceptedOutput" = NULL, "appliedAt" = GREATEST(execution."createdAt", ${now})
    FROM "MemoryJob" job WHERE job."userId" = execution."userId" AND job.id = execution."memoryJobId"
      AND execution."appliedAt" IS NULL AND job.state IN ('TERMINAL_FAILED', 'CANCELLED', 'STALE', 'SUCCEEDED')
  `);
  // Cheap ownership, gating and coverage filters first; the full authority
  // predicate then runs only on those rows. An owner whose remaining facts are
  // all covered, quiet or ineligible is not selected again.
  const owners = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    WITH candidate AS MATERIALIZED (
      SELECT version."userId", version."id" AS "versionId"
      FROM "UserMemorySettings" AS settings
      JOIN "User" AS owner_user ON owner_user."id" = settings."userId" AND owner_user."status" = 'active'::"UserStatus"
      JOIN "MemoryFact" AS fact ON fact."userId" = settings."userId" AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND fact."pinned" = FALSE AND fact."movedToFactId" IS NULL
      JOIN "MemoryFactVersion" AS version ON version."userId" = fact."userId" AND version."id" = fact."currentVersionId"
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState" AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
        AND version."modality" <> 'PATTERN'::"MemoryFactModality" AND version."observedAt" IS NOT NULL
      CROSS JOIN LATERAL (SELECT MAX(evidence."createdAt") AS "evidenceThrough" FROM "MemoryEvidence" AS evidence
        WHERE evidence."userId" = version."userId" AND evidence."factVersionId" = version."id"
          AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance") AS latest
      WHERE settings."useMemoryFacts" AND settings."learnAutomatically"
        AND latest."evidenceThrough" <= ${new Date(now.getTime() - MEMORY_MAINTENANCE_QUIET_MS)}
        AND ${memoryMaintenanceUncoveredPredicate(Prisma.sql`latest."evidenceThrough"`, now)}
    )
    SELECT owner_settings."userId" FROM "UserMemorySettings" AS owner_settings
    WHERE EXISTS (SELECT 1 FROM candidate
      JOIN "MemoryFactVersion" AS version ON version."userId" = candidate."userId" AND version."id" = candidate."versionId"
      JOIN "MemoryFact" AS fact ON fact."userId" = version."userId" AND fact."id" = version."factId"
      JOIN "MemoryScope" AS scope ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      JOIN "UserMemorySettings" AS settings ON settings."userId" = fact."userId"
      WHERE candidate."userId" = owner_settings."userId"
        AND ${memoryMaintenanceSourcePredicate(Prisma.sql`candidate."userId"`)})
    ORDER BY owner_settings."maintenanceScannedAt" ASC NULLS FIRST, owner_settings."userId" LIMIT ${MEMORY_MAINTENANCE_MAX_OWNERS}
  `);
  let scheduled = 0;
  for (const owner of owners) {
    await client.$executeRaw(Prisma.sql`UPDATE "UserMemorySettings" SET "maintenanceScannedAt" = ${now} WHERE "userId" = ${owner.userId}`);
    if (!await authorityAvailable(owner.userId).catch(() => false)) continue;
    scheduled += await scheduleOwnerMemoryMaintenance(client, owner.userId, now);
  }
  return { scheduled };
}
