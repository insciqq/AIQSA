import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import type { MemoryJobClaim } from "../coordinator/types";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { memorySafetyLiteFactClassification } from "../safetyLite";
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
async function planned(userId: string) {
  expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
  const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, pipelineVersion: "memory-maintenance-v1" } });
  const claimToken = randomUUID();
  await prisma.memoryJob.update({ where: { id: job.id }, data: { state: "CLAIMED", leaseToken: claimToken,
    leaseExpiresAt: new Date(Date.now() + 60_000) } });
  const claim = { ...job, claimToken, recoveredLease: false, leaseExpiresAt: new Date(Date.now() + 60_000) } as MemoryJobClaim;
  const repository = createPrismaMemoryMaintenanceRepository(prisma);
  const plan = (await repository.snapshot(claim))!;
  expect(plan).not.toBeNull();
  const inputHash = memoryMaintenanceInputHash(plan);
  const output = { decisions: plan.sources.map(({ ref }) => ({ sourceRef: ref, action: "REMOVE_TRANSIENT" as const,
    scopeBasis: "transient_update" as const, usefulness: null, reason: "transient_episode_update" as const })) };
  const review: MemoryMaintenanceReviewResult = { inputHash, output, acceptedOutputHash: memoryMaintenanceOutputHash(inputHash, output),
    executionId: "synthetic-reviewed", providerId: "synthetic", modelId: "synthetic", policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION };
  const verification: MemoryMaintenanceVerificationResult = { ...review,
    output: { decisions: plan.sources.map(({ ref }) => ({ sourceRef: ref, approve: true })) } };
  return { claim, repository, plan, review, verification };
}
afterAll(async () => { await prisma.$disconnect(); });

describe("maintenance transactional lifecycle", () => {
  it("reviews remaining v1-kept facts once under v2 without changing or reusing the old receipt", async () => {
    const userId = await owner();
    try {
      const target = await fact(userId, "Please make this invitation square.");
      const source = (await loadMemoryMaintenanceSources(prisma, userId, { now: new Date() }))!.sources[0]!;
      const completedAt = new Date();
      const oldJob = await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES", pipelineVersion: "memory-maintenance-v1",
        idempotencyFingerprint: randomUUID(), state: "SUCCEEDED", completedAt, memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0 } });
      const oldReview = await prisma.memoryMaintenanceReview.create({ data: { userId, memoryJobId: oldJob.id,
        factVersionId: target.versionId, policyVersion: "memory-maintenance-policy-v1", sourceSnapshotHash: source.sourceSnapshotHash,
        evidenceThrough: source.evidenceThrough, disposition: "KEEP", usefulness: "DURABLE", reviewedAt: completedAt } });
      expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
      const review = await prisma.memoryMaintenanceReview.findFirstOrThrow({ where: { userId, policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION } });
      expect(review.memoryJobId).not.toBe(oldJob.id);
      expect(review.factVersionId).toBe(target.versionId);
      expect(await prisma.memoryMaintenanceReview.findUnique({ where: { id: oldReview.id } })).toEqual(oldReview);
      await prisma.memoryMaintenanceReview.update({ where: { id: review.id }, data: { disposition: "KEEP", usefulness: null, reviewedAt: new Date() } });
      await prisma.memoryJob.update({ where: { id: review.memoryJobId }, data: { state: "SUCCEEDED", completedAt: new Date() } });
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
      expect(await loadMemoryMaintenanceContext(prisma, userId, "unused-version", [current.id])).toHaveLength(3);
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
      expect(await loadMemoryMaintenanceContext(prisma, userId, "unused-version", [current.id])).toBeNull();
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
      await withLockedMemoryTransaction(prisma, userId, (tx) => work.repository.apply(tx, work.claim, work.plan, work.review, work.verification, new Date()));
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
  it("owner pin wins over an already prepared destructive review", async () => {
    const userId = await owner();
    try {
      const target = await fact(userId, "The reading is lower now.");
      const work = await planned(userId);
      await prisma.memoryFact.update({ where: { id: target.factId }, data: { pinned: true } });
      await expect(withLockedMemoryTransaction(prisma, userId, (tx) => work.repository.apply(tx, work.claim, work.plan, work.review, work.verification, new Date())))
        .rejects.toThrow("memory_maintenance_source_stale");
      expect(await prisma.memoryFact.findUnique({ where: { id: target.factId } })).toMatchObject({ state: "ACTIVE", pinned: true });
      expect(await prisma.memoryMaintenanceSuppression.count({ where: { userId } })).toBe(0);
    } finally { await cleanup(userId); }
  });
  it("preserves independent useful evidence sharing the proposed suppression span", async () => {
    const userId = await owner();
    try {
      const target = await fact(userId, "The measurement is lower; I avoid peanuts.");
      await fact(userId, "I avoid peanuts.", { pinned: true, peerOf: target.versionId });
      const work = await planned(userId);
      await withLockedMemoryTransaction(prisma, userId, (tx) => work.repository.apply(tx, work.claim, work.plan, work.review, work.verification, new Date()));
      expect(await prisma.memoryFact.findUnique({ where: { id: target.factId } })).toMatchObject({ state: "ACTIVE" });
      expect(await prisma.memoryMaintenanceSuppression.count({ where: { userId } })).toBe(0);
      expect(await prisma.memoryMaintenanceReview.findFirst({ where: { userId } })).toMatchObject({ disposition: "REJECTED" });
    } finally { await cleanup(userId); }
  });
});
