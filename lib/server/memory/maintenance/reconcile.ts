import { Prisma, type PrismaClient } from "@prisma/client";
import { enqueueMemoryJob } from "../persistence/jobs";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_MAINTENANCE_MAX_OWNERS, MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION } from "./policy";
import { scanMemoryMaintenanceSources } from "./source";

export async function scheduleOwnerMemoryMaintenance(client: PrismaClient, userId: string, now: Date): Promise<number> {
  return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
    if (!settings.useMemoryFacts || !settings.learnAutomatically || !settings.synthesisEnabled) return 0;
    if (await tx.memoryJob.count({ where: { userId, kind: "SYNTHESIZE_MEMORIES", state: { in: ["QUEUED", "CLAIMED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION"] } } })) return 0;
    const cursor = await tx.userMemorySettings.findUniqueOrThrow({ where: { userId }, select: { maintenanceCursor: true } });
    const scan = await scanMemoryMaintenanceSources(tx, userId, now, cursor.maintenanceCursor);
    await tx.userMemorySettings.update({ where: { userId }, data: { maintenanceCursor: scan.cursor, maintenanceScannedAt: now } });
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
  });
}

export async function reconcileMemoryMaintenanceWork(client: PrismaClient, now: Date,
  authorityAvailable: (userId: string) => Promise<boolean>): Promise<Readonly<{ scheduled: number }>> {
  // Settle content-free checkpoints for terminal jobs without retrying their
  // possibly dispatched calls. New independent evidence or a future versioned
  // policy can admit a new pass; unchanged failed inputs cannot loop forever.
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
  const owners = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT settings."userId" FROM "UserMemorySettings" settings
    JOIN "User" owner_user ON owner_user.id = settings."userId" AND owner_user.status = 'active'::"UserStatus"
    WHERE settings."useMemoryFacts" AND settings."learnAutomatically" AND settings."synthesisEnabled"
      AND EXISTS (SELECT 1 FROM "MemoryFactVersion" version JOIN "MemoryFact" fact ON fact."userId" = version."userId" AND fact.id = version."factId"
        WHERE version."userId" = settings."userId" AND version.state = 'ACTIVE'::"MemoryFactVersionState"
          AND fact."currentVersionId" = version.id AND fact.state = 'ACTIVE'::"MemoryFactState" AND NOT fact.pinned
          AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode" AND version.modality <> 'PATTERN'::"MemoryFactModality"
          AND NOT EXISTS (SELECT 1 FROM "MemoryMaintenanceReview" review WHERE review."userId" = version."userId"
            AND review."factVersionId" = version.id AND review."policyVersion" = ${MEMORY_MAINTENANCE_POLICY_VERSION}
            AND review."evidenceThrough" >= (SELECT MAX(e."createdAt") FROM "MemoryEvidence" e WHERE e."userId" = version."userId" AND e."factVersionId" = version.id)))
    ORDER BY settings."maintenanceScannedAt" ASC NULLS FIRST, settings."userId" LIMIT ${MEMORY_MAINTENANCE_MAX_OWNERS}
  `);
  let scheduled = 0;
  for (const owner of owners) {
    await client.$executeRaw(Prisma.sql`UPDATE "UserMemorySettings" SET "maintenanceScannedAt" = ${now} WHERE "userId" = ${owner.userId}`);
    if (!await authorityAvailable(owner.userId).catch(() => false)) continue;
    scheduled += await scheduleOwnerMemoryMaintenance(client, owner.userId, now);
  }
  return { scheduled };
}
