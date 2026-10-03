import { Prisma, type PrismaClient } from "@prisma/client";
import { isMemoryCoordinatorErrorCode } from "../coordinator/errors";
import type { MemoryJobClaim, MemoryJobDescriptor } from "../coordinator/types";
import { MEMORY_STRUCTURED_OUTPUT_DISPATCH_FENCED_CODE } from "../execution/structuredClassifier";
import { enqueueMemoryDeletion } from "../persistence/deletion";
import { advanceMemoryMutation, lockMemorySettings, type MemoryTransaction } from "../persistence/transaction";
import { memoryPurgeTargetType } from "../purge/contract";
import { decodeMemoryMaintenanceVerification, decodeStagedMemoryMaintenanceOutput, memoryMaintenanceDecisionReasonCode,
  memoryMaintenanceKeepUsefulness, type MemoryMaintenanceDecision, type MemoryMaintenanceDecisionReasonCode,
  type MemoryMaintenanceOutput } from "./contract";
import { MEMORY_MAINTENANCE_POLICY_VERSION, memoryMaintenanceOrdinal, memoryMaintenanceOrdinals, memoryMaintenancePlanHash,
  type MemoryMaintenanceBlockedReason, type MemoryMaintenanceCall, type MemoryMaintenancePlan, type MemoryMaintenanceSource,
  type MemoryMaintenanceSourceIdentity } from "./policy";
import { memoryMaintenanceContradictionPrecedence, settleMemoryMaintenanceContradictions,
  type MemoryMaintenanceContradictionOutcome } from "./precedence";
import { memoryMaintenanceInputHash, memoryMaintenanceOutputHash, type MemoryMaintenanceResult,
  type MemoryMaintenanceReviewResult, type MemoryMaintenanceVerificationResult } from "./provider";
import { loadMemoryMaintenanceContradictionStates, loadMemoryMaintenanceRelatedStatements } from "./related";
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

/** Every settled review keeps a closed, content-free reason where one exists:
 * removed facts are purged with their text and evidence, so it is their only
 * audit trail. */
type Outcome = Readonly<{ source: MemoryMaintenanceSnapshotSource } & (
  | { disposition: "KEEP"; usefulness: "DURABLE" | "ONGOING" | null; reasonCode: MemoryMaintenanceDecisionReasonCode | null }
  | { disposition: "REMOVED" | "REJECTED"; reasonCode: MemoryMaintenanceDecisionReasonCode | null }
  | { disposition: "BLOCKED"; reasonCode: MemoryMaintenanceBlockedReason })>;

/** Verified contradictions of unchanged sources, settled by the precedence
 * rule against the memories they name as those are now, inside the
 * settlement transaction: never by the model's judgment of which one stays. */
async function settleContradictions(tx: MemoryTransaction, userId: string, decisions: readonly MemoryMaintenanceDecision[],
  byRef: ReadonlyMap<string, MemoryMaintenanceSnapshotSource>, verdicts: ReadonlyMap<string, boolean>
): Promise<ReadonlyMap<string, MemoryMaintenanceContradictionOutcome>> {
  /** The unchanged source of a removal the verifier approved. */
  const approved = (decision: MemoryMaintenanceDecision) => decision.action === "REMOVE_TRANSIENT" &&
    verdicts.get(decision.sourceRef) === true ? byRef.get(decision.sourceRef)?.current ?? null : null;
  const verified = decisions.flatMap((decision) => {
    const source = approved(decision);
    return source && decision.contradictedBy ? [{ decision, source, named: decision.contradictedBy }] : [];
  });
  if (verified.length === 0) return new Map();
  const states = await loadMemoryMaintenanceContradictionStates(tx, userId, {
    sourceVersionIds: verified.map(({ source }) => source.versionId), targetVersionIds: verified.map(({ named }) => named.versionId) });
  const removedFactIds = new Set(decisions.flatMap((decision) => {
    const source = approved(decision);
    return source && !decision.contradictedBy ? [source.factId] : [];
  }));
  return settleMemoryMaintenanceContradictions(verified.map(({ decision, source, named }) => {
    const target = states.targets.get(named.versionId);
    return { sourceRef: decision.sourceRef, sourceFactId: source.factId, targetFactId: named.factId,
      precedence: target && target.factId === named.factId && target.factId !== source.factId
        ? memoryMaintenanceContradictionPrecedence({ source: states.testimony.get(source.versionId) ?? [],
          target: { protected: target.protected, testimony: states.testimony.get(target.versionId) ?? [] } })
        : null };
  }), removedFactIds);
}

/** What the earlier attempts of one call left. Attempts that all settled
 * FAILED or CANCELLED with their usage, or were fenced before dispatch, are a
 * known, consumed outcome with the last one's cause; anything else is neither
 * reused nor replayed. */
export type MemoryMaintenanceCallState =
  | Readonly<{ status: "UNUSED" }>
  | Readonly<{ status: "SUCCEEDED" }>
  | Readonly<{ status: "CONSUMED"; errorCode: string }>
  | Readonly<{ status: "UNKNOWN"; ambiguous: boolean }>;

export function createPrismaMemoryMaintenanceRepository(client: PrismaClient) {
  /** The newest unapplied receipt of the call; one attempt succeeds at most. */
  function receipt(job: MemoryJobDescriptor, call: MemoryMaintenanceCall) {
    return client.memoryMaintenanceExecution.findFirst({ where: { userId: job.userId, memoryJobId: job.id,
      ordinal: { in: [...memoryMaintenanceOrdinals(call)] }, appliedAt: null }, orderBy: { ordinal: "desc" } });
  }
  async function staged<T>(job: MemoryJobDescriptor, call: MemoryMaintenanceCall, inputHash: string,
    decode: (value: unknown) => T): Promise<MemoryMaintenanceResult<T> | null> {
    const stored = await receipt(job, call);
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
    /** Related memories by exact version, while still current and shown whole. */
    relatedStatements: (job: MemoryJobDescriptor, versionIds: readonly string[]) =>
      loadMemoryMaintenanceRelatedStatements(client, job.userId, versionIds),
    /** Every binding of the job whose ordinal parity belongs to the call,
     * including any outside the receipt range, so none is overlooked. */
    async callState(job: MemoryJobDescriptor, call: MemoryMaintenanceCall): Promise<MemoryMaintenanceCallState> {
      const parity = memoryMaintenanceOrdinal(call, 0);
      const attempts = (await client.memoryExecutionBinding.findMany({ where: { userId: job.userId, memoryJobId: job.id,
        logicalRole: "MEMORY_SYNTHESIZE" }, orderBy: { ordinal: "asc" },
      select: { id: true, ordinal: true, state: true, errorCode: true } })).filter(({ ordinal }) => ordinal % 2 === parity);
      if (attempts.length === 0) return { status: "UNUSED" };
      if (attempts.some(({ state }) => state === "SUCCEEDED")) return { status: "SUCCEEDED" };
      const usage = new Set((await client.usageEvent.findMany({ where: { userId: job.userId,
        memoryExecutionBindingId: { in: attempts.map(({ id }) => id) } }, select: { memoryExecutionBindingId: true } }))
        .map(({ memoryExecutionBindingId }) => memoryExecutionBindingId));
      // A call fenced before dispatch sent nothing, so it needs no accounting.
      const settled = (attempt: (typeof attempts)[number]) => (attempt.state === "FAILED" || attempt.state === "CANCELLED") &&
        (usage.has(attempt.id) || (attempt.state === "CANCELLED" && attempt.errorCode === MEMORY_STRUCTURED_OUTPUT_DISPATCH_FENCED_CODE));
      const last = attempts.at(-1)!;
      if (attempts.every(settled) && last.errorCode !== null && isMemoryCoordinatorErrorCode(last.errorCode)) {
        return { status: "CONSUMED", errorCode: last.errorCode };
      }
      // A never-started binding was not dispatched; anything else unsettled may have been.
      return { status: "UNKNOWN", ambiguous: attempts.some((attempt) => attempt.state !== "PENDING" && !settled(attempt)) };
    },
    stagedReview(job: MemoryJobDescriptor, reviewed: MemoryMaintenanceSnapshot, inputHash: string) {
      return staged(job, "review", inputHash, (value) => decodeStagedMemoryMaintenanceOutput(value, reviewed));
    },
    /** The verified removals are those the settled verifier output names; its
     * input hash proves it was produced for exactly that disclosed subset. */
    async stagedVerification(job: MemoryJobDescriptor, reviewed: Readonly<{ sourceSnapshotHash: string }>, review: MemoryMaintenanceOutput) {
      const stored = await receipt(job, "verify");
      const saved = stored?.acceptedOutput as { decisions?: unknown } | null | undefined;
      if (!saved || !Array.isArray(saved.decisions)) return null;
      const refs = new Set(saved.decisions.map((decision) => (decision as { sourceRef?: unknown } | null)?.sourceRef));
      const proposal: MemoryMaintenanceOutput = { decisions: review.decisions.filter(({ action, sourceRef }) =>
        action === "REMOVE_TRANSIENT" && refs.has(sourceRef)) };
      if (proposal.decisions.length === 0) return null;
      return staged(job, "verify", memoryMaintenanceInputHash(reviewed, proposal), (value) => {
        const output = value as { decisions?: Array<{ sourceRef: string; approve: boolean }> };
        return decodeMemoryMaintenanceVerification({ decisions: output?.decisions?.map((decision) => ({
          source_ref: decision.sourceRef, approve: decision.approve
        })) }, proposal);
      });
    },
    /** Lease and settings fence the batch. Each source is checked before the
     * first write; a changed one is BLOCKED alone under its reviewed hash.
     * A verified contradiction removes its source only when the memory it
     * names is still current and outranks it; otherwise the source is kept
     * with its basis's usefulness, recording conflict_unresolved while both
     * memories stay. An unexpected database error still rolls the whole batch
     * back. */
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
      const verdicts = new Map(verification?.output.decisions.map(({ sourceRef, approve }) => [sourceRef, approve]) ?? []);
      const contradictions = await settleContradictions(tx, job.userId, review.output.decisions, byRef, verdicts);
      const outcomes = review.output.decisions.map((decision): Outcome => {
        const source = byRef.get(decision.sourceRef)!;
        if (!source.current) return { source, disposition: "BLOCKED", reasonCode: source.blockedReason ?? "source_changed" };
        const reasonCode = memoryMaintenanceDecisionReasonCode(decision);
        if (decision.action === "KEEP") return { source, disposition: "KEEP", usefulness: decision.usefulness, reasonCode };
        const verdict = verdicts.get(decision.sourceRef);
        if (!decision.contradictedBy || verdict === false) return { source, disposition: verdict === true ? "REMOVED" : "REJECTED", reasonCode };
        // A contradiction never disclosed to the verifier, because the memory it
        // names changed first, settles like one whose memory is gone.
        const settled = contradictions.get(decision.sourceRef);
        if (settled === "REMOVE") return { source, disposition: "REMOVED", reasonCode };
        return { source, disposition: "KEEP", usefulness: memoryMaintenanceKeepUsefulness(decision.scopeBasis),
          reasonCode: settled === "CONFLICT" ? "conflict_unresolved" : null };
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
          reasonCode: outcome.reasonCode
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
