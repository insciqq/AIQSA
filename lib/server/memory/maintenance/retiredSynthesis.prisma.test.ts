import { randomUUID } from "node:crypto";
import type { MemoryJobState } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryDeletionClaim, MemoryJobClaim } from "../coordinator/types";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { loadMemorySemanticCutoverInventory } from "../operational/cutover";
import { ensureClassifiedSearchEntry } from "../persistence/factSearchEntry";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { ensureActiveLexicalGeneration, withLockedMemoryTransaction } from "../persistence/transaction";
import { defaultMemoryDeletionContributorRegistry } from "../purge/defaultPurge";
import { memorySafetyLiteFactClassification } from "../safetyLite";
import { loadMemoryReusableFactVersionIds } from "../persistence/reusableFactAuthority";
import { createPrismaMemoryMaintenanceHandler } from "./handler";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";
import { createMemorySynthesizeJobDispatcher, reconcileRetiredMemorySynthesis } from "./retiredSynthesis";

const RETIRED_PIPELINE = "memory-synthesis-v2";
const old = new Date(Date.now() - 2 * 60 * 60_000);
const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
const dispatcher = createMemorySynthesizeJobDispatcher(createPrismaMemoryMaintenanceHandler(prisma));

type Ref = Readonly<{ factId: string; versionId: string }>;

async function owner(label: string): Promise<string> {
  const userId = `memory-retired-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: "Retired synthesis test", status: "active" } });
  await prisma.memoryScope.create({ data: { userId, scopeType: "GLOBAL_USER" } });
  await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    ensureActiveLexicalGeneration(tx, settings, settings.memoryRevision));
  return userId;
}

async function cleanup(...userIds: string[]): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

/** One automatic direct fact with exact message evidence. */
async function source(userId: string, text: string): Promise<Ref> {
  const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
  const scope = await prisma.memoryScope.findFirstOrThrow({ where: { userId, scopeType: "GLOBAL_USER" } });
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic source" } });
  const message = await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent(text), role: "user", status: "complete", createdAt: old, updatedAt: old
  } });
  await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: message.id, memorySourceRevision: 1 } });
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, category: "other",
      canonicalKey: `prop:v2:${memorySha256({ factId })}`, state: "ORPHANED", identityKind: "PROPOSITION", identityVersion: "proposition-v2" } });
    await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId, operation: "AUTO_PROPOSE", actorType: "JOB" } });
    await tx.memoryFactVersion.create({ data: { id: versionId, factId, userId, createdByEventId: eventId, category: "other",
      displayText: text, normalizedSearchText: text, structuredValue: { kind: "statement", value: text }, languageCode: "en",
      modality: "STATE", sourceMode: "AUTOMATIC", confidence: 1, importance: 0.4, directness: "DIRECT", sensitivityClass: "NORMAL",
      ...memorySafetyLiteFactClassification(old), pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      ingestionFingerprint: memorySha256({ factId }), observedAt: old, createdAt: old } });
    await tx.memoryEvidence.create({ data: { userId, factVersionId: versionId, chatId: chat.id, messageId: message.id,
      stance: "SUPPORTS", sourceType: "MESSAGE", sourceRole: "user", branchGeneration: 0, observedAt: old, createdAt: old,
      safeExcerpt: text, safeSourceHash: memorySha256(text), sourceMessageContentHash: memorySha256(text),
      sourceStartOffset: 0, sourceEndOffset: text.length, sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      safetyClass: "NORMAL", evidenceFingerprint: memorySha256({ versionId, messageId: message.id }) } });
    await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId: versionId } });
  });
  return { factId, versionId };
}

async function retiredJob(userId: string, state: MemoryJobState, pipelineVersion = RETIRED_PIPELINE) {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const leased = state === "CLAIMED";
  return prisma.memoryJob.create({ data: {
    userId, kind: "SYNTHESIZE_MEMORIES", pipelineVersion, state, idempotencyFingerprint: memorySha256({ job: randomUUID() }),
    memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
    attemptCount: leased ? 1 : 0, completedAt: state === "SUCCEEDED" ? new Date() : null,
    leaseToken: leased ? randomUUID() : null, leaseExpiresAt: leased ? new Date(Date.now() + 120_000) : null,
    nextAttemptAt: state === "RETRYABLE_FAILED" ? new Date(Date.now() + 60_000) : null
  } });
}

const hashes = Object.freeze({ input: "c".repeat(64), output: "b".repeat(64) });

/** A settled governed synthesis call, as the retired handler recorded it. */
async function succeededBinding(userId: string, jobId: string): Promise<string> {
  const id = `memory-retired-binding-${randomUUID()}`;
  const completedAt = new Date();
  const startedAt = new Date(completedAt.getTime() - 1_000);
  await prisma.memoryExecutionBinding.create({ data: {
    acceptedOutputHash: hashes.output, completedAt, createdAt: startedAt, destinationFingerprint: "d".repeat(64), id,
    inputHash: hashes.input, logicalRole: "MEMORY_SYNTHESIZE", memoryJobId: jobId, ordinal: 0, ownerType: "JOB",
    pipelineVersion: RETIRED_PIPELINE, policyVersion: "memory-synthesis-policy-v6", promptVersion: "memory-synthesis-prompt-v9",
    providerId: "openai_compatible", recoverableUntil: completedAt, relationsDetachedAt: completedAt,
    schemaVersion: "memory-synthesis-schema-v4", secretFreeExecutionSnapshot: {}, startedAt, state: "SUCCEEDED",
    usageCompleteness: "UNAVAILABLE", userId
  } });
  await prisma.usageEvent.create({ data: { memoryExecutionBindingId: id, modelId: "memory-retired-model",
    provider: "openai_compatible", providerModelId: "memory-retired-model", userId } });
  return id;
}

/** Staged provider output that was never applied still holds content. */
async function stagedExecution(userId: string, jobId: string) {
  const executionBindingId = await succeededBinding(userId, jobId);
  return prisma.memorySynthesisExecution.create({ data: {
    userId, memoryJobId: jobId, executionBindingId, inputHash: hashes.input, acceptedOutputHash: hashes.output,
    sourceSetFingerprint: "e".repeat(64), sourceSnapshotHash: "f".repeat(64),
    acceptedOutput: { patterns: [{ statement: "PRIVATE pending synthesized statement" }] },
    sourceBindings: [{ ref: "S1", statement: "PRIVATE pending source" }]
  } });
}

/** A synthesized PATTERN exactly as the retired repository wrote it: no
 * evidence rows, depth-one SYNTHESIZED_FROM relations to its sources. */
async function pattern(userId: string, input: Readonly<{
  bindingId: string;
  claims?: readonly Readonly<{ source: number; statement: string }>[];
  pinned?: boolean;
  reasonCode: string;
  retracted?: boolean;
  searchable?: boolean;
  sources: readonly Ref[];
  statement: string;
}>): Promise<Ref> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const scope = await prisma.memoryScope.findFirstOrThrow({ where: { userId, scopeType: "GLOBAL_USER" } });
  const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, category: "patterns",
      canonicalKey: `prop:v2:${memorySha256({ factId, pattern: true })}`, identityKind: "PROPOSITION",
      identityVersion: "proposition-v2", state: "ORPHANED", pinned: input.pinned ?? false } });
    await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId, operation: "SYNTHESIZE",
      actorType: "JOB", metadata: { reasonCode: input.reasonCode } } });
    await tx.memoryFactVersion.create({ data: { id: versionId, userId, factId, createdByEventId: eventId, category: "patterns",
      confidence: 0.8, coreEligible: false, coreSalience: "NONE", directness: "INFERRED", displayText: input.statement,
      normalizedSearchText: input.statement.toLowerCase(), importance: 0.35, ingestionFingerprint: memorySha256({ versionId }),
      languageCode: "en", modality: "PATTERN", observedAt: now, pipelineVersion: RETIRED_PIPELINE,
      ...memorySafetyLiteFactClassification(now), sensitivityClass: "NORMAL", sourceMode: "AUTOMATIC", state: "ACTIVE",
      structuredValue: { kind: "pattern", reasonCode: input.reasonCode, ...(input.claims ? { claims: input.claims.map((claim) => ({
        sourceVersionIds: [input.sources[claim.source]!.versionId], statement: claim.statement
      })) } : {}) },
      synthesisDepth: 1, synthesisGeneration: settings.memoryGeneration,
      synthesisSourceSetFingerprint: memorySha256({ versionId, sourceSet: true }) } });
    await tx.memoryFactVersionRelation.createMany({ data: input.sources.map((entry) => ({
      userId, kind: "SYNTHESIZED_FROM" as const, sourceVersionId: versionId, targetVersionId: entry.versionId,
      executionId: input.bindingId, confidence: 1, pipelineVersion: RETIRED_PIPELINE, reasonCode: input.reasonCode,
      sourceEligibilityHash: memorySha256({ eligible: entry.versionId })
    })) });
    await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId: versionId } });
    if (input.retracted) {
      // The retired invalidation retracted without touching content.
      await tx.$executeRaw`UPDATE "MemoryFactVersion" SET "state" = 'RETRACTED'::"MemoryFactVersionState",
        "systemTo" = "systemFrom" + INTERVAL '1 millisecond' WHERE "id" = ${versionId}`;
      await tx.memoryFact.update({ where: { id: factId }, data: { state: "RETRACTED", currentVersionId: null } });
      await tx.memoryEvent.create({ data: { userId, factId, factVersionId: versionId, operation: "SOURCE_INVALIDATE",
        actorType: "JOB", metadata: { reasonCode: "synthesis_source_set_replaced" } } });
    }
  });
  if (input.searchable) {
    const entity = await prisma.memoryEntity.create({ data: { userId, canonicalKey: `workflow:${randomUUID()}`,
      displayName: "Review workflow", entityType: "workflow", languageCode: "en" } });
    await prisma.memoryFactVersionEntity.create({ data: { userId, factVersionId: versionId, entityId: entity.id,
      role: "MENTION", confidence: 1 } });
    const generation = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
    await prisma.memorySearchEntry.create({ data: { userId, indexGenerationId: generation.activeIndexGenerationId!,
      itemType: "FACT_VERSION", factVersionId: versionId, normalizedSearchText: input.statement.toLowerCase(),
      safeContentHash: memorySha256(input.statement), languageCode: "en", safetyIdentitySnapshot: "1".repeat(64),
      sourceIdentitySnapshot: "2".repeat(64), suppressionIdentitySnapshot: "3".repeat(64) } });
  }
  return { factId, versionId };
}

function claimOf(job: Awaited<ReturnType<typeof retiredJob>>): MemoryJobClaim {
  return {
    activeLeafMessageId: job.activeLeafMessageId, attemptCount: job.attemptCount, branchGeneration: job.branchGeneration,
    chatId: job.chatId, claimToken: job.leaseToken!, id: job.id, idempotencyFingerprint: job.idempotencyFingerprint,
    kind: job.kind, leaseExpiresAt: job.leaseExpiresAt!, memoryGenerationSnapshot: job.memoryGenerationSnapshot,
    memoryRevisionSnapshot: job.memoryRevisionSnapshot, pipelineVersion: job.pipelineVersion, recoveredLease: false,
    sourceHash: job.sourceHash, sourceMessageId: job.sourceMessageId, sourceRevision: job.sourceRevision, stage: job.stage,
    targetFactVersionId: job.targetFactVersionId, userId: job.userId
  };
}

async function purge(deletionId: string): Promise<void> {
  const now = new Date();
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const changed = await prisma.memoryDeletionOutbox.updateMany({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken, nextAttemptAt: null, state: "RUNNING" },
    where: { id: deletionId, state: "PENDING" }
  });
  expect(changed.count).toBe(1);
  const row = await prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: deletionId } });
  const claim: MemoryDeletionClaim = { ...row, claimToken, leaseExpiresAt, recoveredLease: false, resumedFromBlocked: false };
  const execution = await defaultMemoryDeletionContributorRegistry.handler().execute(claim, {
    now: () => now, signal: new AbortController().signal
  });
  await expect(coordinator.commitDeletionSuccess({ apply: execution.apply, claim, now })).resolves.toBe(true);
}

async function factState(ref: Ref) {
  const [fact, version] = await Promise.all([
    prisma.memoryFact.findUniqueOrThrow({ where: { id: ref.factId } }),
    prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: ref.versionId } })
  ]);
  return { fact, version };
}

async function expectForgotten(ref: Ref): Promise<void> {
  const { fact, version } = await factState(ref);
  expect(fact).toMatchObject({ state: "FORGOTTEN", currentVersionId: null });
  expect(fact.forgottenAt).toBeInstanceOf(Date);
  expect(version).toMatchObject({ state: "FORGOTTEN", displayText: null, normalizedSearchText: null, structuredValue: null });
  expect(version.contentPurgedAt).toBeInstanceOf(Date);
  expect(version.systemTo).toBeInstanceOf(Date);
  await expect(prisma.memorySearchEntry.count({ where: { factVersionId: ref.versionId } })).resolves.toBe(0);
}

afterAll(async () => { await prisma.$disconnect(); });

describe("retired Dream synthesis", () => {
  it("forgets patterns and combinations from any state, closes retired jobs and scrubs staged output", async () => {
    const userId = await owner("all");
    try {
      const sources = await Promise.all([
        "I review the release checklist before each deploy.",
        "I run the test suite before each release.",
        "I write release notes on Fridays.",
        "My team ships on Tuesdays."
      ].map((text) => source(userId, text)));
      const appliedJob = await retiredJob(userId, "SUCCEEDED");
      const bindingId = await succeededBinding(userId, appliedJob.id);
      const [s1, s2, s3, s4] = sources as [Ref, Ref, Ref, Ref];
      const generalization = await pattern(userId, { bindingId, reasonCode: "repeated_habit_pattern", searchable: true,
        sources: [s1, s2, s3], statement: "The user prepares releases carefully." });
      const retracted = await pattern(userId, { bindingId, reasonCode: "repeated_habit_pattern", retracted: true,
        sources: [s2, s3, s4], statement: "The user follows a weekly release routine." });
      const overlap = await pattern(userId, { bindingId, reasonCode: "combined_overlapping_facts",
        sources: [s1, s4], statement: "The user ships on Tuesdays after the checklist review." });
      const episode = await pattern(userId, { bindingId, reasonCode: "combined_episode_facts",
        claims: [{ source: 0, statement: "Tests run before release." }, { source: 1, statement: "Notes are written on Fridays." }],
        sources: [s2, s3], statement: "Tests run before release. Notes are written on Fridays." });
      const pinned = await pattern(userId, { bindingId, pinned: true, reasonCode: "repeated_habit_pattern",
        sources: [s1, s2, s3], statement: "The user keeps a release routine." });
      const queued = await retiredJob(userId, "QUEUED");
      const retryable = await retiredJob(userId, "RETRYABLE_FAILED");
      const waiting = await retiredJob(userId, "WAITING_FOR_CONFIGURATION");
      const claimed = await retiredJob(userId, "CLAIMED");
      const maintenance = await retiredJob(userId, "QUEUED", "memory-maintenance-v1");
      const queuedExecution = await stagedExecution(userId, queued.id);
      const claimedExecution = await stagedExecution(userId, claimed.id);
      const before = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const sourceEvidence = await prisma.memoryEvidence.count({ where: { userId } });

      const now = new Date();
      await expect(reconcileRetiredMemorySynthesis(prisma, now)).resolves.toEqual({
        closedJobs: 3, forgottenFacts: 4, pinnedFacts: 1, scrubbedExecutions: 1
      });

      for (const ref of [generalization, retracted, overlap, episode]) await expectForgotten(ref);
      await expect(prisma.memoryEvent.findMany({ where: { userId, operation: "FORGET" }, select: { actorType: true, factId: true, metadata: true } }))
        .resolves.toEqual(expect.arrayContaining([generalization, retracted, overlap, episode].map(({ factId }) =>
          ({ actorType: "JOB", factId, metadata: { reasonCode: "synthesis_retired" } }))));
      await expect(prisma.memoryEvent.count({ where: { userId, operation: "FORGET" } })).resolves.toBe(4);
      const deletions = await prisma.memoryDeletionOutbox.findMany({ where: { userId, operation: "FORGET_PURGE" } });
      expect(deletions.map(({ targetId }) => targetId).sort())
        .toEqual([generalization, retracted, overlap, episode].map(({ factId }) => factId).sort());
      expect(new Set(deletions.map(({ targetType }) => targetType))).toEqual(new Set(["MEMORY_FACT@memory-purge-v1"]));
      // One owner transaction moved the visible state once.
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } })).resolves.toMatchObject({
        memoryGeneration: before.memoryGeneration, memoryRevision: before.memoryRevision + 1
      });

      // Pinned derivatives are never targeted; sources keep content and evidence.
      await expect(factState(pinned)).resolves.toMatchObject({
        fact: { state: "ACTIVE", pinned: true }, version: { state: "ACTIVE", displayText: "The user keeps a release routine." }
      });
      for (const ref of sources) {
        await expect(factState(ref)).resolves.toMatchObject({ fact: { state: "ACTIVE", currentVersionId: ref.versionId },
          version: { state: "ACTIVE", contentPurgedAt: null } });
      }
      await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(sourceEvidence);

      for (const job of [queued, retryable, waiting]) {
        await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
          errorCode: "memory_synthesis_retired", leaseToken: null, nextAttemptAt: null, state: "CANCELLED", completedAt: now
        });
      }
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: maintenance.id } }))
        .resolves.toMatchObject({ errorCode: null, state: "QUEUED" });
      const scrubbed = await prisma.memorySynthesisExecution.findUniqueOrThrow({ where: { id: queuedExecution.id } });
      expect(scrubbed).toMatchObject({ acceptedOutput: null, sourceBindings: null });
      expect(scrubbed.appliedAt!.getTime()).toBeGreaterThanOrEqual(scrubbed.createdAt.getTime());
      // The job the coordinator had already claimed keeps its staged output
      // until its lease settles; the dispatcher closes it content-free.
      await expect(prisma.memorySynthesisExecution.findUniqueOrThrow({ where: { id: claimedExecution.id } }))
        .resolves.toMatchObject({ appliedAt: null });
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: claimed.id } })).resolves.toMatchObject({ state: "CLAIMED" });
      const claim = claimOf(claimed);
      const decision = await dispatcher.preflight(claim);
      expect(decision).toEqual({ errorCode: "memory_synthesis_retired", status: "CANCELLED" });
      if (decision.status === "READY") throw new Error("retired_synthesis_job_admitted");
      await expect(coordinator.settleJobGate({ claim, decision, now: new Date() })).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: claimed.id } }))
        .resolves.toMatchObject({ errorCode: "memory_synthesis_retired", leaseToken: null, state: "CANCELLED" });

      // The next pass finishes the settled job's staged output and nothing else.
      await expect(reconcileRetiredMemorySynthesis(prisma, new Date())).resolves.toEqual({
        closedJobs: 0, forgottenFacts: 0, pinnedFacts: 0, scrubbedExecutions: 1
      });
      await expect(prisma.memorySynthesisExecution.findUniqueOrThrow({ where: { id: claimedExecution.id } }))
        .resolves.toMatchObject({ acceptedOutput: null, sourceBindings: null });
      const settled = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      await expect(reconcileRetiredMemorySynthesis(prisma, new Date())).resolves.toEqual({
        closedJobs: 0, forgottenFacts: 0, pinnedFacts: 0, scrubbedExecutions: 0
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ memoryRevision: settled.memoryRevision, settingsRevision: settled.settingsRevision });
      await expect(prisma.memoryEvent.count({ where: { userId, operation: "FORGET" } })).resolves.toBe(4);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId, operation: "FORGET_PURGE" } })).resolves.toBe(4);
      const jobCodes = await prisma.memoryJob.findMany({ where: { userId, kind: "SYNTHESIZE_MEMORIES", pipelineVersion: RETIRED_PIPELINE,
        state: "CANCELLED" }, select: { errorCode: true } });
      expect(jobCodes).toEqual(Array.from({ length: 4 }, () => ({ errorCode: "memory_synthesis_retired" })));

      // The ordinary FORGET_PURGE lifecycle finishes the derivatives.
      for (const deletion of deletions) await purge(deletion.id);
      await expect(prisma.memoryDeletionOutbox.findMany({ where: { userId, operation: "FORGET_PURGE" }, select: { state: true } }))
        .resolves.toEqual(Array.from({ length: 4 }, () => ({ state: "SUCCEEDED" })));
      await expect(prisma.memoryFactVersionEntity.count({ where: { factVersionId: generalization.versionId } })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({ where: { userId, modality: "PATTERN", contentPurgedAt: null, NOT: { factId: pinned.factId } } }))
        .resolves.toBe(0);

      // A previous-release worker may still write one during Compose replacement.
      const late = await pattern(userId, { bindingId, reasonCode: "repeated_habit_pattern", sources: [s2, s3, s4],
        statement: "The user writes things down." });
      await expect(reconcileRetiredMemorySynthesis(prisma, new Date())).resolves.toMatchObject({ forgottenFacts: 1, pinnedFacts: 1 });
      await expectForgotten(late);
    } finally {
      await cleanup(userId);
    }
  });

  it("keeps derivatives out of every read, shows their sources as ordinary memories and leaves cutover clean", async () => {
    const userId = await owner("reads");
    const explicit = createPrismaExplicitMemoryRepository(prisma);
    const project = (versionId: string) => withLockedMemoryTransaction(prisma, userId,
      (tx, settings) => ensureClassifiedSearchEntry(tx, settings, versionId, `trigger:${versionId}`, new Date()));
    const listed = async () => (await explicit.list(userId, { scope: { type: "GLOBAL_USER" }, state: "ACTIVE" }))
      .memories.map(({ id }) => id).sort();
    try {
      const sources = await Promise.all([
        "I review the release checklist before each deploy.",
        "I run the test suite before each release.",
        "I write release notes on Fridays."
      ].map((text) => source(userId, text)));
      for (const ref of sources) await project(ref.versionId);
      await expect(prisma.memorySearchEntry.count({ where: { userId, factVersionId: { in: sources.map(({ versionId }) => versionId) } } }))
        .resolves.toBe(3);
      const job = await retiredJob(userId, "SUCCEEDED");
      const bindingId = await succeededBinding(userId, job.id);
      const baseline = await loadMemorySemanticCutoverInventory(prisma);
      const [s1, s2, s3] = sources as [Ref, Ref, Ref];
      const combination = await pattern(userId, { bindingId, reasonCode: "combined_overlapping_facts", searchable: true,
        sources: [s1, s2], statement: "The user reviews the release checklist and runs the tests before each release." });
      const generalization = await pattern(userId, { bindingId, reasonCode: "repeated_habit_pattern",
        sources: [s1, s2, s3], statement: "The user prepares releases carefully." });

      // Live derivatives are not reusable, listed, searched or projected;
      // their sources are ordinary memories, never collapsed under them.
      const sourceFactIds = sources.map(({ factId }) => factId).sort();
      await expect(listed()).resolves.toEqual(sourceFactIds);
      const page = await explicit.list(userId, { scope: { type: "GLOBAL_USER" }, state: "ACTIVE" });
      expect(page.memories.every((memory) => memory.modality !== "PATTERN" && !("combinedSources" in memory))).toBe(true);
      const searched = await explicit.search(userId, { query: "release checklist" });
      expect(searched.memories.map(({ id }) => id)).toContain(s1.factId);
      expect(searched.memories.map(({ id }) => id)).not.toContain(combination.factId);
      await expect(explicit.get(userId, combination.factId)).resolves.toBeNull();
      await expect(loadMemoryReusableFactVersionIds(prisma, userId,
        [combination.versionId, generalization.versionId, s1.versionId])).resolves.toEqual(new Set([s1.versionId]));
      await expect(prisma.memorySearchEntry.count({ where: { factVersionId: combination.versionId } })).resolves.toBe(1);
      await project(combination.versionId);
      await expect(prisma.memorySearchEntry.count({ where: { factVersionId: combination.versionId } })).resolves.toBe(0);
      // Still-active derivatives await the retired-synthesis reconcile, not a
      // cutover disposition.
      const live = await loadMemorySemanticCutoverInventory(prisma);
      expect(live.unsupportedAutomaticPipelineVersions).toBe(baseline.unsupportedAutomaticPipelineVersions);
      expect(live.activeCurrentMissingExactAuthority).toBe(baseline.activeCurrentMissingExactAuthority);
      expect(live.total).toBe(baseline.total);

      await reconcileRetiredMemorySynthesis(prisma, new Date());
      for (const ref of [combination, generalization]) await expectForgotten(ref);
      await expect(listed()).resolves.toEqual(sourceFactIds);
      const retired = await loadMemorySemanticCutoverInventory(prisma);
      expect(retired.unsupportedAutomaticPipelineVersions).toBe(baseline.unsupportedAutomaticPipelineVersions);
      expect(retired.activeCurrentMissingExactAuthority).toBe(baseline.activeCurrentMissingExactAuthority);
      expect(retired.total).toBe(baseline.total);
    } finally {
      await cleanup(userId);
    }
  });

  it("skips inactive owners without looping and forgets their records once active, even while Memory is paused", async () => {
    const userId = await owner("inactive");
    try {
      const sources = await Promise.all(["I hike on Saturdays.", "I swim on Sundays.", "I cycle on Mondays."]
        .map((text) => source(userId, text)));
      const job = await retiredJob(userId, "SUCCEEDED");
      const bindingId = await succeededBinding(userId, job.id);
      const derived = await pattern(userId, { bindingId, reasonCode: "repeated_habit_pattern", sources,
        statement: "The user exercises most days." });
      const queued = await retiredJob(userId, "QUEUED");
      await prisma.user.update({ where: { id: userId }, data: { status: "disabled" } });

      for (let pass = 0; pass < 2; pass += 1) await reconcileRetiredMemorySynthesis(prisma, new Date());
      await expect(factState(derived)).resolves.toMatchObject({ fact: { state: "ACTIVE" }, version: { contentPurgedAt: null } });
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: queued.id } })).resolves.toMatchObject({ state: "QUEUED" });

      await prisma.user.update({ where: { id: userId }, data: { status: "active" } });
      const current = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: current.memoryRevision, expectedSettingsRevision: current.settingsRevision,
        learnAutomatically: false, useMemoryFacts: false
      });
      await reconcileRetiredMemorySynthesis(prisma, new Date());
      await expectForgotten(derived);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId, operation: "FORGET_PURGE", targetId: derived.factId } }))
        .resolves.toBe(1);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ learnAutomatically: false, useMemoryFacts: false });
      for (const ref of sources) await expect(factState(ref)).resolves.toMatchObject({ fact: { state: "ACTIVE" } });
    } finally {
      await cleanup(userId);
    }
  });

  it("runs maintenance for an owner whose Dream toggle was off and cancels it with automatic learning", async () => {
    const userId = await owner("maintenance");
    try {
      await source(userId, "Please make this invitation square.");
      await prisma.userMemorySettings.update({ where: { userId }, data: { synthesisEnabled: false } });
      expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
      const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, kind: "SYNTHESIZE_MEMORIES" } });
      expect(job).toMatchObject({ pipelineVersion: "memory-maintenance-v1", state: "QUEUED" });
      // Routed to maintenance past its settings gate; provider authority may wait.
      const decision = await dispatcher.preflight(claimOf({ ...job, leaseToken: "lease", leaseExpiresAt: new Date(Date.now() + 60_000) }));
      expect(decision.status).not.toBe("CANCELLED");

      const current = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: current.memoryRevision, expectedSettingsRevision: current.settingsRevision,
        learnAutomatically: false
      });
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ errorCode: "memory_automatic_learning_paused", state: "CANCELLED" });
      expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(0);
    } finally {
      await cleanup(userId);
    }
  });

  it("cannot hold an explicit PATTERN, so the automatic-only selector is exact", async () => {
    const userId = await owner("explicit");
    try {
      const scope = await prisma.memoryScope.findFirstOrThrow({ where: { userId, scopeType: "GLOBAL_USER" } });
      const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
      await expect(prisma.$transaction(async (tx) => {
        await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, category: "patterns",
          canonicalKey: `prop:v2:${memorySha256({ factId })}`, identityKind: "PROPOSITION", identityVersion: "proposition-v2",
          state: "ORPHANED" } });
        await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId, operation: "EXPLICIT_SAVE",
          actorType: "USER", actorUserId: userId } });
        await tx.memoryFactVersion.create({ data: { id: versionId, userId, factId, createdByEventId: eventId,
          category: "patterns", confidence: 1, directness: "INFERRED", displayText: "Explicit pattern",
          normalizedSearchText: "explicit pattern", structuredValue: { kind: "pattern" }, languageCode: "en",
          modality: "PATTERN", importance: 0.5, observedAt: new Date(), pipelineVersion: RETIRED_PIPELINE,
          ...memorySafetyLiteFactClassification(new Date()), sensitivityClass: "NORMAL", sourceMode: "EXPLICIT",
          synthesisDepth: 1, synthesisGeneration: 0, synthesisSourceSetFingerprint: "a".repeat(64) } });
      })).rejects.toThrow(/MemoryFactVersion_synthesis_shape_check/u);
    } finally {
      await cleanup(userId);
    }
  });
});
