import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemoryJobClaim, MemoryJobDescriptor } from "../coordinator/types";
import { enqueueMemoryDeletion } from "../persistence/deletion";
import { advanceMemoryMutation, lockMemorySettings, type MemoryTransaction } from "../persistence/transaction";
import { memoryPurgeTargetType } from "../purge/contract";
import { decodeMemoryMaintenanceOutput, decodeMemoryMaintenanceVerification, type MemoryMaintenanceOutput } from "./contract";
import { MEMORY_MAINTENANCE_POLICY_VERSION, memoryMaintenancePlanHash, type MemoryMaintenanceBlockedReason,
  type MemoryMaintenancePlan, type MemoryMaintenanceSource, type MemoryMaintenanceSourceIdentity } from "./policy";
import { memoryMaintenanceInputHash, memoryMaintenanceOutputHash, type MemoryMaintenanceResult,
  type MemoryMaintenanceReviewResult, type MemoryMaintenanceVerificationResult } from "./provider";
import { loadMemoryMaintenanceSources } from "./source";

export type MemoryMaintenanceSnapshotSource = MemoryMaintenanceSourceIdentity & Readonly<{
  reviewId: string;
  /** Current content while it still matches the reviewed hash. */
  current: MemoryMaintenanceSource | null;
  /** Why a changed source can no longer be decided. */
  blockedReason: MemoryMaintenanceBlockedReason | null;
}>;
/** The job's reviewed sources with a per-source match. `plan` is present
 * only while every source still matches, so a provider may receive it. */
export type MemoryMaintenanceSnapshot = Readonly<{
  sourceSnapshotHash: string;
  sources: readonly MemoryMaintenanceSnapshotSource[];
  plan: MemoryMaintenancePlan | null;
}>;

/** Reads only. Refs follow the planner's database order of version ids. */
async function snapshot(client: Pick<PrismaClient, "memoryMaintenanceReview" | "$queryRaw">,
  job: MemoryJobDescriptor): Promise<MemoryMaintenanceSnapshot | null> {
  const reviews = await client.memoryMaintenanceReview.findMany({ where: { userId: job.userId, memoryJobId: job.id,
    policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION, disposition: "PENDING" },
  orderBy: { factVersionId: "asc" }, select: { id: true, factVersionId: true, sourceSnapshotHash: true } });
  if (reviews.length === 0) return null;
  const current = await loadMemoryMaintenanceSources(client, job.userId,
    { now: new Date(), versionIds: reviews.map(({ factVersionId }) => factVersionId) });
  const sources = reviews.map((review, index): MemoryMaintenanceSnapshotSource => {
    const ref = `S${index + 1}`;
    const source = current.sources.get(review.factVersionId);
    const blocker = current.blockers.get(review.factVersionId)?.reasonCode;
    const matches = source?.sourceSnapshotHash === review.sourceSnapshotHash;
    return { ref, versionId: review.factVersionId, sourceSnapshotHash: review.sourceSnapshotHash, reviewId: review.id,
      current: matches && source ? { ...source, ref } : null,
      blockedReason: matches ? null : blocker === "pending_relation" || blocker === "evidence_without_offsets" ? blocker : "source_changed" };
  });
  const sourceSnapshotHash = memoryMaintenancePlanHash(sources);
  const complete = sources.flatMap(({ current: content }) => content ? [content] : []);
  return { sourceSnapshotHash, sources,
    plan: complete.length === sources.length ? Object.freeze({ sources: complete, sourceSnapshotHash }) : null };
}

async function removeAutomaticFact(tx: MemoryTransaction, job: MemoryJobClaim,
  source: MemoryMaintenanceSource, reviewId: string, now: Date): Promise<void> {
  // Exact supports of every version are fenced before any plaintext is
  // removed. Never suppress an entire message or another fact's evidence.
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

type Outcome = Readonly<{ source: MemoryMaintenanceSnapshotSource } & (
  | { disposition: "KEEP"; usefulness: "DURABLE" | "ONGOING" | null }
  | { disposition: "REMOVED" | "REJECTED" }
  | { disposition: "BLOCKED"; reasonCode: MemoryMaintenanceBlockedReason })>;

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
    stagedReview(job: MemoryJobDescriptor, reviewed: MemoryMaintenanceSnapshot, inputHash: string) {
      return staged(job, 0, inputHash, (value) => {
        const saved = value as MemoryMaintenanceOutput;
        return decodeMemoryMaintenanceOutput({ decisions: saved?.decisions?.map((decision) => ({
          source_ref: decision.sourceRef, scope_basis: decision.scopeBasis, action: decision.action, usefulness: decision.usefulness, reason: decision.reason
        })) }, reviewed);
      });
    },
    /** The verified removals are those the settled verifier output names; its
     * input hash proves it was produced for exactly that disclosed subset. */
    async stagedVerification(job: MemoryJobDescriptor, reviewed: Readonly<{ sourceSnapshotHash: string }>, review: MemoryMaintenanceOutput) {
      const stored = await client.memoryMaintenanceExecution.findFirst({ where: { userId: job.userId,
        memoryJobId: job.id, ordinal: 1, appliedAt: null }, select: { acceptedOutput: true } });
      const saved = stored?.acceptedOutput as { decisions?: unknown } | null | undefined;
      if (!saved || !Array.isArray(saved.decisions)) return null;
      const refs = new Set(saved.decisions.map((decision) => (decision as { sourceRef?: unknown } | null)?.sourceRef));
      const proposal: MemoryMaintenanceOutput = { decisions: review.decisions.filter(({ action, sourceRef }) =>
        action === "REMOVE_TRANSIENT" && refs.has(sourceRef)) };
      if (proposal.decisions.length === 0) return null;
      return staged(job, 1, memoryMaintenanceInputHash(reviewed, proposal), (value) => {
        const output = value as { decisions?: Array<{ sourceRef: string; approve: boolean }> };
        return decodeMemoryMaintenanceVerification({ decisions: output?.decisions?.map((decision) => ({
          source_ref: decision.sourceRef, approve: decision.approve
        })) }, proposal);
      });
    },
    /** Lease and settings fence the batch. Each source is checked before the
     * first write; a changed one is BLOCKED alone under its reviewed hash.
     * An unexpected database error still rolls the whole batch back. */
    async apply(tx: MemoryTransaction, job: MemoryJobClaim, expected: Readonly<{ sourceSnapshotHash: string }>,
      review: MemoryMaintenanceReviewResult, verification: MemoryMaintenanceVerificationResult | null, now: Date) {
      const settings = await lockMemorySettings(tx, job.userId, true);
      const lease = await tx.memoryJob.findFirst({ where: { id: job.id, userId: job.userId, state: "CLAIMED",
        leaseToken: job.claimToken, leaseExpiresAt: { gt: now } }, select: { id: true } });
      if (!lease || !settings.useMemoryFacts || !settings.learnAutomatically ||
        settings.memoryGeneration !== job.memoryGenerationSnapshot) throw new Error("memory_maintenance_source_stale");
      const current = await snapshot(tx, job);
      if (!current || current.sourceSnapshotHash !== expected.sourceSnapshotHash) throw new Error("memory_maintenance_source_stale");
      const byRef = new Map(current.sources.map((source) => [source.ref, source]));
      if (review.output.decisions.length !== current.sources.length ||
        review.output.decisions.some(({ sourceRef }) => !byRef.has(sourceRef))) throw new Error("memory_maintenance_output_invalid");
      const approvals = new Set(verification?.output.decisions.filter(({ approve }) => approve).map(({ sourceRef }) => sourceRef) ?? []);
      const outcomes = review.output.decisions.map((decision): Outcome => {
        const source = byRef.get(decision.sourceRef)!;
        if (!source.current) return { source, disposition: "BLOCKED", reasonCode: source.blockedReason ?? "source_changed" };
        if (decision.action === "KEEP") return { source, disposition: "KEEP", usefulness: decision.usefulness };
        return { source, disposition: approvals.has(decision.sourceRef) ? "REMOVED" : "REJECTED" };
      });
      let removed = 0;
      for (const outcome of outcomes) {
        if (outcome.disposition === "REMOVED") {
          await removeAutomaticFact(tx, job, outcome.source.current!, outcome.source.reviewId, now);
          removed += 1;
        }
        const updated = await tx.memoryMaintenanceReview.updateMany({ where: { id: outcome.source.reviewId,
          userId: job.userId, disposition: "PENDING" }, data: {
          disposition: outcome.disposition, reviewedAt: now,
          usefulness: outcome.disposition === "KEEP" ? outcome.usefulness : null,
          reasonCode: outcome.disposition === "BLOCKED" ? outcome.reasonCode : null
        } });
        if (updated.count !== 1) throw new Error("memory_maintenance_source_stale");
      }
      await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
      await tx.memoryMaintenanceExecution.updateMany({ where: { userId: job.userId, memoryJobId: job.id, appliedAt: null },
        data: { acceptedOutput: Prisma.DbNull, appliedAt: now } });
      return { reviewed: outcomes.length, removed,
        blocked: outcomes.filter(({ disposition }) => disposition === "BLOCKED").length };
    }
  });
}
export type MemoryMaintenanceRepository = ReturnType<typeof createPrismaMemoryMaintenanceRepository>;
