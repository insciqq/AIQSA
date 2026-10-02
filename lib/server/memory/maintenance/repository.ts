import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemoryJobClaim, MemoryJobDescriptor } from "../coordinator/types";
import { enqueueMemoryDeletion } from "../persistence/deletion";
import { advanceMemoryMutation, lockMemorySettings, type MemoryTransaction } from "../persistence/transaction";
import { memoryPurgeTargetType } from "../purge/contract";
import { decodeMemoryMaintenanceOutput, decodeMemoryMaintenanceVerification, type MemoryMaintenanceOutput } from "./contract";
import { MEMORY_MAINTENANCE_POLICY_VERSION, type MemoryMaintenancePlan, type MemoryMaintenanceSource } from "./policy";
import { memoryMaintenanceOutputHash, type MemoryMaintenanceResult, type MemoryMaintenanceReviewResult,
  type MemoryMaintenanceVerificationResult } from "./provider";
import { loadMemoryMaintenanceSources } from "./source";

async function snapshot(client: Pick<PrismaClient, "memoryMaintenanceReview" | "$queryRaw">, job: MemoryJobDescriptor): Promise<MemoryMaintenancePlan | null> {
  const reviews = await client.memoryMaintenanceReview.findMany({ where: { userId: job.userId, memoryJobId: job.id,
    policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION, disposition: "PENDING" },
  select: { factVersionId: true, sourceSnapshotHash: true } });
  if (reviews.length === 0) return null;
  const plan = await loadMemoryMaintenanceSources(client, job.userId, { now: new Date(), versionIds: reviews.map(({ factVersionId }) => factVersionId) });
  if (!plan || plan.sources.length !== reviews.length || plan.sources.some((source) =>
    !reviews.some((review) => review.factVersionId === source.versionId && review.sourceSnapshotHash === source.sourceSnapshotHash))) return null;
  return plan;
}

async function overlapsIndependentFact(tx: MemoryTransaction, userId: string, source: MemoryMaintenanceSource): Promise<boolean> {
  const dependents = await tx.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "MemoryFactVersionSourceDependency" dep
      JOIN "MemoryFactVersion" target ON target."userId" = dep."userId" AND target.id = dep."targetFactVersionId"
      WHERE dep."userId" = ${userId} AND dep."sourceFactVersionId" = ${source.versionId} AND target."contentPurgedAt" IS NULL
      UNION ALL
      SELECT 1 FROM "MemoryFactVersionRelation" relation
      JOIN "MemoryFactVersion" target ON target."userId" = relation."userId" AND target.id = relation."sourceVersionId"
      WHERE relation."userId" = ${userId} AND relation."targetVersionId" = ${source.versionId}
        AND relation.kind = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind" AND target.state = 'ACTIVE'::"MemoryFactVersionState"
    ) AS exists
  `);
  if (dependents[0]?.exists) return true;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT peer."id" FROM "MemoryEvidence" peer
    JOIN "MemoryFactVersion" peer_version ON peer_version."userId" = peer."userId" AND peer_version.id = peer."factVersionId"
    JOIN "MemoryFact" peer_fact ON peer_fact."userId" = peer_version."userId" AND peer_fact.id = peer_version."factId"
    WHERE peer."userId" = ${userId} AND peer_version."factId" <> ${source.factId}
      AND peer_version."contentPurgedAt" IS NULL AND peer_fact.state <> 'FORGOTTEN'::"MemoryFactState"
      AND (${Prisma.join(source.evidence.map((evidence) => Prisma.sql`(
        peer."messageId" = ${evidence.messageId} AND peer."sourceMessageContentHash" = ${evidence.sourceTextHash}
        AND peer."sourceStartOffset" < ${evidence.endOffset} AND peer."sourceEndOffset" > ${evidence.startOffset}
      )`), " OR ")}) LIMIT 1
  `);
  return rows.length > 0;
}

async function removeAutomaticFact(tx: MemoryTransaction, job: MemoryJobClaim,
  source: MemoryMaintenanceSource, reviewId: string, now: Date): Promise<void> {
  // Current and historical exact supports are fenced before any plaintext is
  // removed. Never suppress an entire message or its other independent facts.
  const evidence = await tx.memoryEvidence.findMany({ where: { userId: job.userId, stance: "SUPPORTS",
    sourceType: "MESSAGE", factVersionId: { in: (await tx.memoryFactVersion.findMany({
      where: { userId: job.userId, factId: source.factId }, select: { id: true } })).map(({ id }) => id) } },
  select: { messageId: true, sourceMessageContentHash: true, sourceStartOffset: true, sourceEndOffset: true } });
  for (const span of evidence) {
    if (span.messageId === null || span.sourceMessageContentHash === null || span.sourceStartOffset === null || span.sourceEndOffset === null) {
      throw new Error("memory_maintenance_source_stale");
    }
    await tx.memoryMaintenanceSuppression.createMany({ data: [{ userId: job.userId, memoryReviewId: reviewId,
      sourceMessageId: span.messageId, sourceMessageContentHash: span.sourceMessageContentHash,
      sourceStartOffset: span.sourceStartOffset, sourceEndOffset: span.sourceEndOffset }], skipDuplicates: true });
  }
  await tx.memoryEvent.create({ data: { userId: job.userId, operation: "FORGET", actorType: "JOB",
    factId: source.factId, factVersionId: source.versionId, sourceGeneration: job.memoryGenerationSnapshot,
    metadata: { policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION, reasonCode: "automatic_transient_cleanup", reviewId } } });
  await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryFactVersion" SET state = 'FORGOTTEN'::"MemoryFactVersionState",
      "systemTo" = COALESCE("systemTo", GREATEST(${now}, "systemFrom" + INTERVAL '1 millisecond'))
    WHERE "userId" = ${job.userId} AND "factId" = ${source.factId}
  `);
  const updated = await tx.memoryFact.updateMany({ where: { userId: job.userId, id: source.factId,
    currentVersionId: source.versionId, state: "ACTIVE", pinned: false },
  data: { currentVersionId: null, state: "FORGOTTEN", forgottenAt: now } });
  if (updated.count !== 1) throw new Error("memory_maintenance_source_stale");
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MemorySearchEntry" entry USING "MemoryFactVersion" version
    WHERE entry."userId" = ${job.userId} AND version."userId" = entry."userId"
      AND entry."factVersionId" = version.id AND version."factId" = ${source.factId}
  `);
  await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryFactVersion" SET "displayText" = NULL, "normalizedSearchText" = NULL, "structuredValue" = NULL,
      "semanticFrame" = NULL, "semanticAdjudication" = NULL, "rawTemporalExpression" = NULL,
      "temporalResolutionEvidence" = NULL, "occurredAt" = NULL, "expectedAt" = NULL, "expiresAt" = NULL,
      "validFrom" = NULL, "validTo" = NULL, "sourceTimezone" = NULL, "temporalResolverVersion" = NULL,
      "contentPurgedAt" = ${now}
    WHERE "userId" = ${job.userId} AND "factId" = ${source.factId}
  `);
  const settings = await lockMemorySettings(tx, job.userId, true);
  await enqueueMemoryDeletion(tx, settings, { operation: "FORGET_PURGE", targetId: source.factId,
    targetType: memoryPurgeTargetType("MEMORY_FACT") });
}

export function createPrismaMemoryMaintenanceRepository(client: PrismaClient) {
  async function staged<T>(job: MemoryJobDescriptor, ordinal: number, inputHash: string,
    decode: (value: unknown) => T): Promise<MemoryMaintenanceResult<T> | null> {
    const stored = await client.memoryMaintenanceExecution.findFirst({ where: { userId: job.userId,
      memoryJobId: job.id, ordinal, appliedAt: null } });
    if (!stored || stored.inputHash !== inputHash || stored.acceptedOutput === null) return null;
    const binding = await client.memoryExecutionBinding.findFirst({ where: { userId: job.userId,
      id: stored.executionBindingId, state: "SUCCEEDED", inputHash, acceptedOutputHash: stored.acceptedOutputHash,
      policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION },
    select: { providerModelId: true, providerId: true, policyVersion: true } });
    if (!binding?.providerModelId || !binding.providerId) return null;
    const output = decode(stored.acceptedOutput);
    if (memoryMaintenanceOutputHash(inputHash, output) !== stored.acceptedOutputHash) return null;
    return { inputHash, acceptedOutputHash: stored.acceptedOutputHash, executionId: stored.executionBindingId,
      modelId: binding.providerModelId, providerId: binding.providerId, policyVersion: binding.policyVersion, output };
  }
  return Object.freeze({
    snapshot: (job: MemoryJobDescriptor) => snapshot(client, job),
    async bindingExists(job: MemoryJobDescriptor, ordinal: number) {
      return (await client.memoryExecutionBinding.count({ where: { userId: job.userId, memoryJobId: job.id,
        logicalRole: "MEMORY_SYNTHESIZE", ordinal } })) > 0;
    },
    stagedReview(job: MemoryJobDescriptor, plan: MemoryMaintenancePlan, inputHash: string) {
      return staged(job, 0, inputHash, (value) => {
        const saved = value as MemoryMaintenanceOutput;
        return decodeMemoryMaintenanceOutput({ decisions: saved?.decisions?.map((decision) => ({
          source_ref: decision.sourceRef, scope_basis: decision.scopeBasis, action: decision.action, usefulness: decision.usefulness, reason: decision.reason
        })) }, plan);
      });
    },
    stagedVerification(job: MemoryJobDescriptor, review: MemoryMaintenanceOutput, inputHash: string) {
      return staged(job, 1, inputHash, (value) => {
        const saved = value as { decisions?: Array<{ sourceRef: string; approve: boolean }> };
        return decodeMemoryMaintenanceVerification({ decisions: saved?.decisions?.map((decision) => ({
          source_ref: decision.sourceRef, approve: decision.approve
        })) }, review);
      });
    },
    async apply(tx: MemoryTransaction, job: MemoryJobClaim, expectedPlan: MemoryMaintenancePlan,
      review: MemoryMaintenanceReviewResult, verification: MemoryMaintenanceVerificationResult | null, now: Date) {
      const settings = await lockMemorySettings(tx, job.userId, true);
      const lease = await tx.memoryJob.findFirst({ where: { id: job.id, userId: job.userId, state: "CLAIMED",
        leaseToken: job.claimToken, leaseExpiresAt: { gt: now } }, select: { id: true } });
      const current = await snapshot(tx, job);
      if (!lease || !settings.useMemoryFacts || !settings.learnAutomatically ||
        settings.memoryGeneration !== job.memoryGenerationSnapshot ||
        !current || current.sourceSnapshotHash !== expectedPlan.sourceSnapshotHash) throw new Error("memory_maintenance_source_stale");
      const sourceByRef = new Map(current.sources.map((source) => [source.ref, source]));
      const approvals = new Set(verification?.output.decisions.filter(({ approve }) => approve).map(({ sourceRef }) => sourceRef) ?? []);
      let removed = 0;
      for (const decision of review.output.decisions) {
        const source = sourceByRef.get(decision.sourceRef);
        if (!source) throw new Error("memory_maintenance_output_invalid");
        const receipt = await tx.memoryMaintenanceReview.findFirst({ where: { userId: job.userId, memoryJobId: job.id,
          factVersionId: source.versionId, sourceSnapshotHash: source.sourceSnapshotHash, disposition: "PENDING" }, select: { id: true } });
        if (!receipt) throw new Error("memory_maintenance_source_stale");
        const remove = decision.action === "REMOVE_TRANSIENT" && approvals.has(decision.sourceRef) &&
          await tx.memoryFactVersion.count({ where: { userId: job.userId, factId: source.factId } }) === 1 &&
          !await overlapsIndependentFact(tx, job.userId, source);
        if (remove) { await removeAutomaticFact(tx, job, source, receipt.id, now); removed += 1; }
        await tx.memoryMaintenanceReview.update({ where: { id: receipt.id }, data: {
          disposition: remove ? "REMOVED" : decision.action === "KEEP" ? "KEEP" : "REJECTED",
          usefulness: decision.action === "KEEP" ? decision.usefulness : null, reviewedAt: now
        } });
      }
      await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
      await tx.memoryMaintenanceExecution.updateMany({ where: { userId: job.userId, memoryJobId: job.id, appliedAt: null },
        data: { acceptedOutput: Prisma.DbNull, appliedAt: now } });
      return { reviewed: review.output.decisions.length, removed };
    }
  });
}
export type MemoryMaintenanceRepository = ReturnType<typeof createPrismaMemoryMaintenanceRepository>;
