import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import type { MemoryJobClaim } from "../coordinator/types";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction, type MemoryTransaction } from "../persistence/transaction";
import { memorySafetyLiteFactClassification } from "../safetyLite";
import type { MemoryMaintenanceDecision } from "./contract";
import { memoryMaintenanceInputHash, memoryMaintenanceOutputHash, type MemoryMaintenanceReviewResult,
  type MemoryMaintenanceVerificationResult } from "./provider";
import { createPrismaMemoryMaintenanceRepository } from "./repository";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";
import { isMemoryMaintenanceEvidenceSuppressed } from "./suppression";
import { loadMemoryMaintenanceContext } from "./context";
import { createMemorySuppressionInTransaction } from "../persistence/suppressions";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { MEMORY_MAINTENANCE_POLICY_VERSION } from "./policy";
import { loadMemoryMaintenanceSources } from "./source";

const old = new Date(Date.now() - 2 * 60 * 60_000);
async function owner() {
  const userId = `memory-maintenance-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: "Maintenance test", status: "active" } });
  await prisma.memoryScope.create({ data: { userId, scopeType: "GLOBAL_USER" } });
  return userId;
}
async function cleanup(userId: string) {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}
async function fact(userId: string, text: string, options: { pinned?: boolean; manual?: boolean; peerOf?: string; dated?: boolean } = {}) {
  const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
  const scope = await prisma.memoryScope.findFirstOrThrow({ where: { userId, scopeType: "GLOBAL_USER" } });
  const previous = options.peerOf ? await prisma.memoryEvidence.findFirstOrThrow({ where: { userId, factVersionId: options.peerOf } }) : null;
  const chat = previous ? { id: previous.chatId! } : await prisma.chat.create({ data: { userId, title: "Synthetic episode" } });
  const message = previous ? { id: previous.messageId! } : await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent(text), role: "user", status: "complete", createdAt: old, updatedAt: old
  } });
  if (!previous) await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: message.id, memorySourceRevision: 1 } });
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, category: "other",
      canonicalKey: `prop:v2:${memorySha256({ factId })}`, state: "ORPHANED", pinned: options.pinned ?? false, identityKind: "PROPOSITION", identityVersion: "proposition-v2" } });
    await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId, operation: "AUTO_PROPOSE", actorType: "JOB" } });
    await tx.memoryFactVersion.create({ data: { id: versionId, factId, userId, createdByEventId: eventId, category: "other",
      displayText: text, normalizedSearchText: text, structuredValue: { kind: "statement", value: text }, languageCode: "en",
      modality: "STATE", sourceMode: "AUTOMATIC", confidence: .6, importance: .4, directness: "DIRECT", sensitivityClass: "NORMAL",
      ...memorySafetyLiteFactClassification(old), pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      ingestionFingerprint: memorySha256({ factId }), observedAt: old, createdAt: old,
      ...(options.dated ? { occurredAt: old, rawTemporalExpression: "this morning", sourceTimezone: "UTC",
        temporalResolverVersion: "memory-temporal-test-v1", temporalResolutionEvidence: { grounded: true } } : {}) } });
    await tx.memoryEvidence.create({ data: { userId, factVersionId: versionId, chatId: chat.id, messageId: message.id,
      stance: "SUPPORTS", sourceType: "MESSAGE", sourceRole: "user", branchGeneration: 0,
      observedAt: old, createdAt: old, safeExcerpt: previous?.safeExcerpt ?? text, safeSourceHash: memorySha256(previous?.safeExcerpt ?? text),
      sourceMessageContentHash: memorySha256(previous?.safeExcerpt ?? text), sourceStartOffset: 0,
      sourceEndOffset: (previous?.safeExcerpt ?? text).length, sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      safetyClass: "NORMAL", evidenceFingerprint: memorySha256({ versionId, messageId: message.id }) } });
    await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId: versionId } });
    if (options.manual) await tx.memoryEvent.create({ data: { userId, factId, factVersionId: versionId, operation: "PIN", actorType: "USER", actorUserId: userId } });
  });
  return { factId, versionId, messageId: message.id };
}
/** Plans the owner's batch and stages synthetic governed decisions for it. */
async function planned(userId: string, keep: ReadonlySet<string> = new Set()) {
  expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
  const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, pipelineVersion: "memory-maintenance-v1", state: "QUEUED" } });
  const claimToken = randomUUID();
  await prisma.memoryJob.update({ where: { id: job.id }, data: { state: "CLAIMED", leaseToken: claimToken,
    leaseExpiresAt: new Date(Date.now() + 60_000) } });
  const claim = { ...job, claimToken, recoveredLease: false, leaseExpiresAt: new Date(Date.now() + 60_000) } as MemoryJobClaim;
  const repository = createPrismaMemoryMaintenanceRepository(prisma);
  const snapshot = (await repository.snapshot(claim))!;
  expect(snapshot.plan).not.toBeNull();
  const plan = snapshot.plan!;
  const inputHash = memoryMaintenanceInputHash(snapshot);
  const output = { decisions: plan.sources.map(({ ref, factId }): MemoryMaintenanceDecision => keep.has(factId)
    ? { sourceRef: ref, action: "KEEP", scopeBasis: "general_personal", usefulness: "DURABLE", reason: "useful_personal_context" }
    : { sourceRef: ref, action: "REMOVE_TRANSIENT", scopeBasis: "single_episode", usefulness: null, reason: "episode" }) };
  const review: MemoryMaintenanceReviewResult = { inputHash, output, acceptedOutputHash: memoryMaintenanceOutputHash(inputHash, output),
    executionId: "synthetic-reviewed", providerId: "synthetic", modelId: "synthetic", policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION };
  const verification: MemoryMaintenanceVerificationResult = { ...review,
    output: { decisions: output.decisions.filter(({ action }) => action === "REMOVE_TRANSIENT").map(({ sourceRef }) => ({ sourceRef, approve: true })) } };
  return { claim, repository, snapshot, plan, review, verification };
}
function apply(work: Awaited<ReturnType<typeof planned>>, wrap: (tx: MemoryTransaction) => MemoryTransaction = (tx) => tx) {
  return withLockedMemoryTransaction(prisma, work.claim.userId, (tx) => work.repository.apply(wrap(tx), work.claim,
    work.snapshot, work.review, work.verification, new Date()));
}
afterAll(async () => { await prisma.$disconnect(); });

describe("maintenance transactional lifecycle", () => {
  it("reviews remaining v2-kept facts once under v3 without changing or reusing the old receipt", async () => {
    const userId = await owner();
    try {
      const target = await fact(userId, "Please make this invitation square.");
      const source = (await loadMemoryMaintenanceSources(prisma, userId, { now: new Date(), versionIds: [target.versionId] }))
        .sources.get(target.versionId)!;
      const completedAt = new Date();
      const oldJob = await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES", pipelineVersion: "memory-maintenance-v1",
        idempotencyFingerprint: randomUUID(), state: "SUCCEEDED", completedAt, memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0 } });
      const oldReview = await prisma.memoryMaintenanceReview.create({ data: { userId, memoryJobId: oldJob.id,
        factVersionId: target.versionId, policyVersion: "memory-maintenance-policy-v2", sourceSnapshotHash: source.sourceSnapshotHash,
        evidenceThrough: source.evidenceThrough, disposition: "KEEP", usefulness: "EPISODIC", reviewedAt: completedAt } });
      expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
      const review = await prisma.memoryMaintenanceReview.findFirstOrThrow({ where: { userId, policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION } });
      expect(review).toMatchObject({ factVersionId: target.versionId, disposition: "PENDING", reasonCode: null });
      expect(review.memoryJobId).not.toBe(oldJob.id);
      expect(await prisma.memoryMaintenanceReview.findUnique({ where: { id: oldReview.id } })).toEqual(oldReview);
      await prisma.memoryMaintenanceReview.update({ where: { id: review.id }, data: { disposition: "KEEP", usefulness: null, reviewedAt: new Date() } });
      await prisma.memoryJob.update({ where: { id: review.memoryJobId! }, data: { state: "SUCCEEDED", completedAt: new Date() } });
      expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(0);
      expect(await prisma.memoryJob.count({ where: { userId } })).toBe(2);
      expect(await prisma.memoryFact.findUnique({ where: { id: target.factId } })).toMatchObject({ state: "ACTIVE", currentVersionId: target.versionId });
    } finally { await cleanup(userId); }
  });
  it.each(["PAUSED", "FORGOTTEN", "RESET"] as const)("does not disclose or traverse a %s contextual parent", async (fence) => {
    const userId = await owner();
    try {
      const chat = await prisma.chat.create({ data: { userId, title: "Private context boundary" } });
      const parentAt = new Date(old.getTime() - 60_000);
      const grandparent = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
        createdAt: new Date(parentAt.getTime() - 60_000), updatedAt: new Date(parentAt.getTime() - 60_000),
        content: textMessageContent("Earlier personal context.") } });
      const parent = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
        parentMessageId: grandparent.id, createdAt: parentAt, updatedAt: parentAt,
        content: textMessageContent("Private material outside future Memory admission.") } });
      const current = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
        parentMessageId: parent.id, createdAt: old, updatedAt: old, content: textMessageContent("I prefer short answers.") } });
      await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: current.id, memorySourceRevision: 1 } });
      const spans = [{ messageId: current.id, startOffset: 0, endOffset: "I prefer short answers.".length }];
      expect(await loadMemoryMaintenanceContext(prisma, userId, "unused-version", spans)).toHaveLength(3);
      if (fence === "PAUSED") await prisma.memoryPauseInterval.create({ data: { userId, scope: "MASTER", memoryGeneration: 0,
        pausedAt: new Date(parentAt.getTime() - 1), resumedAt: new Date(parentAt.getTime() + 1) } });
      if (fence === "RESET") await prisma.memorySourceBarrier.create({ data: { userId, kind: "ALL_REUSABLE",
        memoryGeneration: 0, sourceCreatedAtCutoff: new Date(parentAt.getTime() + 1), explicitOverrideAllowed: false } });
      if (fence === "FORGOTTEN") {
        const keyring = MemorySuppressionKeyring.parse(`current=test-v1,test-v1=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 71)).toString("base64")}`);
        await withLockedMemoryTransaction(prisma, userId, (tx, settings) => createMemorySuppressionInTransaction(tx, settings, keyring, {
          suppressionId: randomUUID(), scope: "SOURCE_MESSAGE", chatId: chat.id, messageId: parent.id,
          branchGeneration: 0, explicitOverrideAllowed: false
        }));
      }
      expect(await loadMemoryMaintenanceContext(prisma, userId, "unused-version", spans)).toBeNull();
    } finally { await cleanup(userId); }
  });
  it("removes only the automatic transient fact, preserves the chat, and prevents source replay", async () => {
    const userId = await owner();
    try {
      const transient = await fact(userId, "The reading is back to normal now.", { dated: true });
      const pinned = await fact(userId, "I avoid peanuts.", { pinned: true });
      const manual = await fact(userId, "I prefer concise answers.", { manual: true });
      const work = await planned(userId);
      expect(work.plan.sources.map(({ factId }) => factId)).toEqual([transient.factId]);
      await apply(work);
      expect(await prisma.memoryFactVersion.findUnique({ where: { id: transient.versionId } })).toMatchObject({ state: "FORGOTTEN", displayText: null, structuredValue: null });
      expect(await prisma.memoryFactVersion.findUnique({ where: { id: transient.versionId } })).toMatchObject({
        occurredAt: null, sourceTimezone: null, temporalResolverVersion: null, rawTemporalExpression: null, temporalResolutionEvidence: null
      });
      expect(await prisma.message.count({ where: { id: transient.messageId } })).toBe(1);
      expect(await prisma.memoryFact.count({ where: { id: { in: [pinned.factId, manual.factId] }, state: "ACTIVE" } })).toBe(2);
      expect(await prisma.memoryDeletionOutbox.count({ where: { userId, operation: "FORGET_PURGE" } })).toBe(1);
      await prisma.memoryMaintenanceReview.deleteMany({ where: { userId } });
      expect(await withLockedMemoryTransaction(prisma, userId, (tx) => isMemoryMaintenanceEvidenceSuppressed(tx, { userId,
        evidence: [{ messageId: transient.messageId, sourceTextHash: memorySha256("The reading is back to normal now."), startOffset: 0, endOffset: 34 }] }))).toBe(true);
      expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(0);
    } finally { await cleanup(userId); }
  });
  it("blocks only a source pinned after its prepared review and applies the rest of the batch", async () => {
    const userId = await owner();
    try {
      const target = await fact(userId, "The reading is lower now.");
      const other = await fact(userId, "The parcel arrives at noon today.");
      const work = await planned(userId);
      expect(work.plan.sources).toHaveLength(2);
      const reviewed = await prisma.memoryMaintenanceReview.findFirstOrThrow({ where: { userId, factVersionId: target.versionId } });
      await prisma.memoryFact.update({ where: { id: target.factId }, data: { pinned: true } });
      await expect(apply(work)).resolves.toMatchObject({ reviewed: 2, removed: 1, blocked: 1 });
      expect(await prisma.memoryFact.findUnique({ where: { id: target.factId } })).toMatchObject({ state: "ACTIVE", pinned: true });
      expect(await prisma.memoryMaintenanceReview.findUnique({ where: { id: reviewed.id } })).toMatchObject({
        disposition: "BLOCKED", reasonCode: "source_changed", sourceSnapshotHash: reviewed.sourceSnapshotHash, memoryJobId: reviewed.memoryJobId
      });
      expect(await prisma.memoryFact.findUnique({ where: { id: other.factId } })).toMatchObject({ state: "FORGOTTEN" });
      expect(await prisma.memoryMaintenanceSuppression.findMany({ where: { userId }, select: { sourceMessageId: true } }))
        .toEqual([{ sourceMessageId: other.messageId }]);
      // A blocker found in apply is a failed attempt: once eligible again, one new job reviews it.
      await prisma.memoryJob.update({ where: { id: work.claim.id }, data: { state: "SUCCEEDED", completedAt: new Date(),
        leaseToken: null, leaseExpiresAt: null } });
      await prisma.memoryFact.update({ where: { id: target.factId }, data: { pinned: false } });
      await prisma.userMemorySettings.update({ where: { userId }, data: { maintenanceCursor: null } });
      expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
      const retry = await prisma.memoryMaintenanceReview.findFirstOrThrow({ where: { userId, factVersionId: target.versionId, disposition: "PENDING" } });
      expect(retry.memoryJobId).not.toBe(work.claim.id);
      expect(retry.sourceSnapshotHash).not.toBe(reviewed.sourceSnapshotHash);
    } finally { await cleanup(userId); }
  });
  it("removes a fact whose evidence span is shared with an independent fact, leaving that fact intact", async () => {
    const userId = await owner();
    try {
      const target = await fact(userId, "The measurement is lower; I avoid peanuts.");
      const peer = await fact(userId, "I avoid peanuts.", { pinned: true, peerOf: target.versionId });
      const work = await planned(userId);
      await apply(work);
      expect(await prisma.memoryFact.findUnique({ where: { id: target.factId } })).toMatchObject({ state: "FORGOTTEN" });
      expect(await prisma.memoryFact.findUnique({ where: { id: peer.factId } })).toMatchObject({ state: "ACTIVE", currentVersionId: peer.versionId });
      expect(await prisma.memoryEvidence.count({ where: { userId, factVersionId: peer.versionId } })).toBe(1);
      expect(await prisma.memoryMaintenanceSuppression.count({ where: { userId } })).toBe(1);
      expect(await prisma.memoryMaintenanceReview.findFirst({ where: { userId } })).toMatchObject({ disposition: "REMOVED" });
    } finally { await cleanup(userId); }
  });
  it("rolls the whole batch back on an unexpected database error", async () => {
    const userId = await owner();
    try {
      const first = await fact(userId, "The parcel is at the door.");
      const second = await fact(userId, "The kettle is boiling now.");
      const work = await planned(userId);
      const failingEvents = (tx: MemoryTransaction) => new Proxy(tx, { get(target, property) {
        if (property === "memoryEvent") return { create: async () => { throw new Error("synthetic_database_failure"); } };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await expect(apply(work, failingEvents)).rejects.toThrow("synthetic_database_failure");
      expect(await prisma.memoryFact.count({ where: { id: { in: [first.factId, second.factId] }, state: "ACTIVE" } })).toBe(2);
      expect(await prisma.memoryMaintenanceReview.count({ where: { userId, disposition: "PENDING" } })).toBe(2);
      expect(await prisma.memoryMaintenanceSuppression.count({ where: { userId } })).toBe(0);
      expect(await prisma.memoryDeletionOutbox.count({ where: { userId } })).toBe(0);
    } finally { await cleanup(userId); }
  });
});
