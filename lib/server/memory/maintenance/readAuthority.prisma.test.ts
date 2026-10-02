import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createAutomaticMaintenanceFact, createMaintenanceMessage, createMaintenanceOwner, deleteMaintenanceOwner,
  drainMaintenanceForgetPurges, relearnMaintenanceFact, settleMaintenanceJob, type MaintenanceFixtureMessage
} from "@/tests/support/memoryMaintenance";
import { textMessageContent } from "../../../domain/content";
import { fuseMemoryRetrievalCandidates, planMemoryRetrieval } from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import { MemoryPreparingRunConflictError } from "../../runs/preparingRun";
import { resolvePreparingMemoryItem } from "../../runs/preparingMemoryItems";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import type { MemoryFactCandidateDependency } from "../learning/extraction/contract";
import { memoryFactDependenciesAreValid, persistMemoryFactDependencies } from "../learning/dependencies/repository";
import {
  MEMORY_LEXICAL_ANALYSIS_PROFILE, MEMORY_LEXICAL_CHUNKING_VERSION, MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "../persistence/lexical";
import { createMemorySuppressionInTransaction } from "../persistence/suppressions";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { createPrismaLocalMemoryRetrievalRepository } from "../retrieval/localRepository";
import { createMemoryNativeFactSearchPlan } from "../retrieval/nativeFactSearch";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION } from "./policy";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";

type Owner = Readonly<{ userId: string; chatId: string }>;
type FactRef = Readonly<{ factId: string; currentVersionId: string }>;

const owners: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const userId of owners.splice(0)) await deleteMaintenanceOwner(userId);
});
afterAll(async () => { await prisma.$disconnect(); });

/** An owner whose lexical generation is ready, with a current chat. */
async function reader(): Promise<Owner> {
  const userId = await createMaintenanceOwner("memory-read-authority");
  owners.push(userId);
  const now = new Date();
  const generation = await prisma.memoryIndexGeneration.create({ data: {
    chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION, generation: 0, indexMode: "LEXICAL_ONLY", indexedThroughMemoryRevision: 0,
    languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE, normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION, readyAt: now,
    retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION, state: "READY", targetMemoryRevision: 0, userId
  } });
  await prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({ where: { userId }, data: { activeIndexGenerationId: generation.id, useMemoryFacts: true } });
    await tx.memoryIndexGeneration.update({ where: { id: generation.id }, data: { activatedAt: now, state: "ACTIVE" } });
  });
  const current = await createMaintenanceMessage(userId, "What should I cook tonight?", { at: new Date() });
  return { userId, chatId: current.chatId };
}
function dependsOn(sourceVersionId: string): MemoryFactCandidateDependency {
  return { dependencyKind: "COREFERENCE_ANTECEDENT", ref: "F1", source: { contentHash: null, factVersionId: sourceVersionId,
    messageId: null, messageUpdatedAt: null, projectionVersion: null } };
}
async function depend(userId: string, target: FactRef, sourceVersionId: string): Promise<void> {
  await prisma.$transaction((tx) => persistMemoryFactDependencies(tx, userId, target.currentVersionId, [dependsOn(sourceVersionId)]));
}
/** An automatic fact learned from its own message in its own chat. */
async function automatic(userId: string, statement: string, usefulness: "DURABLE" | "EPISODIC" | null = "DURABLE") {
  const source = await createMaintenanceMessage(userId, statement);
  return { ...await createAutomaticMaintenanceFact(userId, [{ statement, source, usefulness: usefulness ?? undefined }]), statement, source };
}
/** One maintenance pass that removes only `removed`, then its purges. */
async function removeByMaintenance(userId: string, ...removed: readonly Readonly<{ factId: string }>[]): Promise<void> {
  expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
  await settleMaintenanceJob(userId, (factId) => removed.some((fact) => fact.factId === factId) ? "REMOVE" : "KEEP");
  expect(await drainMaintenanceForgetPurges(userId)).toBe(removed.length);
}
/** Every read surface a dependent fact reaches through its authority. */
async function readable(owner: Owner, fact: FactRef & Readonly<{ statement: string }>) {
  const now = new Date();
  const saved = (await createPrismaExplicitMemoryRepository(prisma).list(owner.userId, { state: "ACTIVE" })).memories
    .some(({ id }) => id === fact.factId);
  const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
  const plan = createMemoryNativeFactSearchPlan(fact.statement, now);
  const result = await repository.retrieve({ assistantId: null, chatId: null, now, plan, userId: owner.userId });
  const search = fuseMemoryRetrievalCandidates(plan, result.laneResults, now).some(({ itemId }) => itemId === fact.currentVersionId);
  const preparing = await prisma.$transaction((tx) => resolvePreparingMemoryItem(tx,
    { assistantId: null, chatId: owner.chatId, folderId: null, indexGenerationId: null, userId: owner.userId }, null,
    { exactSafeText: fact.statement, factVersionId: fact.currentVersionId, finalScore: 0.9, selectionReason: "fact_exact",
      featureSnapshot: { directFactAuthority: true, historical: false, retrievalMode: "TARGETED_CURRENT" } }))
    .then(() => true, (error: unknown) => {
      if (error instanceof MemoryPreparingRunConflictError && error.code === "memory_attempt_item_stale") return false;
      throw error;
    });
  const snapshot = await repository.snapshot({ assistantId: null, chatId: owner.chatId, now,
    plan: planMemoryRetrieval({ currentUserText: "An unrelated question.", now }), userId: owner.userId });
  const standing = (await repository.loadStandingFacts(snapshot)).some(({ candidate }) => candidate.itemId === fact.currentVersionId);
  return { saved, search, preparing, standing };
}
const visible = { saved: true, search: true, preparing: true, standing: true };
const hidden = { saved: false, search: false, preparing: false, standing: false };
async function ownerForget(userId: string, fact: FactRef) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.memoryEvent.create({ data: { userId, factId: fact.factId, factVersionId: fact.currentVersionId,
      operation: "FORGET", actorType: "USER", actorUserId: userId } });
    await tx.memoryFactVersion.updateMany({ where: { userId, factId: fact.factId }, data: { state: "FORGOTTEN", systemTo: now,
      displayText: null, normalizedSearchText: null, structuredValue: Prisma.DbNull, contentPurgedAt: now } });
    await tx.memoryFact.update({ where: { id: fact.factId }, data: { state: "FORGOTTEN", currentVersionId: null, forgottenAt: now } });
  });
}

const keyring = MemorySuppressionKeyring.parse(
  `current=test-v1,test-v1=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 71)).toString("base64")}`);

/** Owner actions on the removed source's own chat or message; each alone hides the dependent fact. */
const sourceFences: Readonly<Record<string, (owner: Owner, source: MaintenanceFixtureMessage) => Promise<unknown>>> = {
  "deletes the source chat": async ({ userId }, { chatId }) => {
    const deletion = await prisma.memoryDeletionOutbox.create({ data: { userId, operation: "SOURCE_PURGE",
      targetType: "CHAT@memory-chat-delete-v1", targetId: chatId, memoryGeneration: 0, admissionAuthorizationId: randomUUID(),
      admittedChatSourceRevision: 1, alsoForgetOriginMemories: false } });
    cleanups.push(() => prisma.chat.deleteMany({ where: { id: chatId } }));
    await prisma.chat.update({ where: { id: chatId }, data: { archived: true, memoryMode: "EXCLUDED",
      permanentDeletionAt: new Date(), permanentDeletionOperationId: deletion.id } });
  },
  "purges the source chat": (_, { chatId }) => prisma.chat.delete({ where: { id: chatId } }),
  "excludes the source chat": (_, { chatId }) => prisma.chat.update({ where: { id: chatId }, data: { memoryMode: "EXCLUDED" } }),
  "moves the source chat into a Project": async ({ userId }, { chatId }) => {
    const project = await prisma.project.create({ data: { name: "Synthetic Project", createdByUserId: userId,
      createdByDisplayName: "Maintenance fixture", grants: { create: { userId, role: "OWNER" } } } });
    cleanups.push(() => prisma.project.deleteMany({ where: { id: project.id } }));
    await prisma.chat.update({ where: { id: chatId }, data: { userId: null, projectId: project.id, memoryMode: "EXCLUDED",
      createdByUserId: userId, createdByDisplayName: "Maintenance fixture" } });
  },
  "forgets the source message": ({ userId }, { chatId, messageId }) => withLockedMemoryTransaction(prisma, userId,
    (tx, settings) => createMemorySuppressionInTransaction(tx, settings, keyring, { suppressionId: randomUUID(),
      scope: "SOURCE_MESSAGE", chatId, messageId, branchGeneration: 0, explicitOverrideAllowed: false })),
  "edits the source message onto another branch": async (_, { chatId }) => {
    const edited = await prisma.message.create({ data: { chatId, content: textMessageContent("Someone visited me yesterday."),
      role: "user", status: "complete" } });
    await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: edited.id, memorySourceRevision: { increment: 1 } } });
  }
};

/** A removal as policies v1 and v2 committed it: review, exact fences, job FORGET and content removal. */
async function removeAsEarlierPolicy(userId: string, policyVersion: string, fact: FactRef): Promise<void> {
  const now = new Date();
  const spans = await prisma.memoryEvidence.findMany({ where: { userId, factVersionId: fact.currentVersionId } });
  const job = await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES",
    pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION, idempotencyFingerprint: randomUUID(), memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 0, state: "SUCCEEDED", completedAt: now } });
  await prisma.$transaction(async (tx) => {
    const review = await tx.memoryMaintenanceReview.create({ data: { userId, factVersionId: fact.currentVersionId, policyVersion,
      evidenceThrough: spans[0]!.createdAt, sourceSnapshotHash: "0".repeat(64), memoryJobId: job.id, disposition: "PENDING" } });
    for (const span of spans) {
      await tx.memoryMaintenanceSuppression.create({ data: { userId, memoryReviewId: review.id, sourceMessageId: span.messageId!,
        sourceMessageContentHash: span.sourceMessageContentHash!, sourceStartOffset: span.sourceStartOffset!,
        sourceEndOffset: span.sourceEndOffset! } });
    }
    await tx.memoryEvent.create({ data: { userId, operation: "FORGET", actorType: "JOB", factId: fact.factId,
      factVersionId: fact.currentVersionId, metadata: { policyVersion, reasonCode: "automatic_transient_cleanup", reviewId: review.id } } });
    await tx.memoryFactVersion.updateMany({ where: { userId, factId: fact.factId }, data: { state: "FORGOTTEN", systemTo: now,
      displayText: null, normalizedSearchText: null, structuredValue: Prisma.DbNull, contentPurgedAt: now } });
    await tx.memoryFact.update({ where: { id: fact.factId }, data: { state: "FORGOTTEN", currentVersionId: null, forgottenAt: now } });
    await tx.memoryMaintenanceReview.update({ where: { id: review.id }, data: { disposition: "REMOVED", reviewedAt: now } });
  });
}

describe("dependent fact authority after automatic cleanup", () => {
  it("keeps a long-term fact readable after maintenance removes its source, keeps writes strict and still applies the source's own dependencies", async () => {
    const owner = await reader();
    const root = await automatic(owner.userId, "My sister Anna lives in Lisbon.");
    const source = await automatic(owner.userId, "Anna visited me yesterday.", "EPISODIC");
    const dependent = await automatic(owner.userId, "Anna is my only sister.");
    await depend(owner.userId, source, root.currentVersionId);
    await depend(owner.userId, dependent, source.currentVersionId);
    expect(await readable(owner, dependent)).toEqual(visible);
    expect(await scheduleOwnerMemoryMaintenance(prisma, owner.userId, new Date())).toBe(1);
    await settleMaintenanceJob(owner.userId, (factId) => factId === source.factId ? "REMOVE" : "KEEP");
    expect(await prisma.memoryFact.findUnique({ where: { id: source.factId } })).toMatchObject({ state: "FORGOTTEN" });
    expect(await readable(owner, source)).toEqual(hidden);
    expect(await readable(owner, dependent)).toEqual(visible);
    // The purge removes the source's evidence; its cleanup fences keep the hint valid.
    expect(await drainMaintenanceForgetPurges(owner.userId)).toBe(1);
    expect(await prisma.memoryEvidence.count({ where: { userId: owner.userId, factVersionId: source.currentVersionId } })).toBe(0);
    expect(await readable(owner, dependent)).toEqual(visible);
    // Writes stay strict for the direct source.
    const later = await automatic(owner.userId, "Anna and I share a flat.");
    await expect(prisma.$transaction((tx) => persistMemoryFactDependencies(tx, owner.userId, later.currentVersionId,
      [dependsOn(source.currentVersionId)]))).rejects.toThrow("memory_dependency_source_stale");
    expect(await prisma.$transaction((tx) => memoryFactDependenciesAreValid(tx, owner.userId, later.currentVersionId,
      [dependsOn(source.currentVersionId)]))).toBe(false);
    await expect(prisma.memoryFactVersionSourceDependency.create({ data: { id: randomUUID(), userId: owner.userId,
      targetFactVersionId: later.currentVersionId, sourceFactVersionId: source.currentVersionId,
      dependencyKind: "COREFERENCE_ANTECEDENT" } })).rejects.toThrow(/not admissible/u);
    // The walk continues through the removed source: forgetting its own source hides the dependent.
    await ownerForget(owner.userId, root);
    expect(await readable(owner, dependent)).toEqual(hidden);
  });

  it.each(Object.keys(sourceFences))("hides the dependent fact when the owner %s after cleanup", async (fence) => {
    const owner = await reader();
    const source = await automatic(owner.userId, "Anna visited me yesterday.", "EPISODIC");
    const dependent = await automatic(owner.userId, "Anna is my only sister.");
    await depend(owner.userId, dependent, source.currentVersionId);
    await removeByMaintenance(owner.userId, source);
    expect(await readable(owner, dependent)).toEqual(visible);
    await sourceFences[fence]!(owner, source.source);
    expect(await readable(owner, dependent)).toEqual(hidden);
  });

  it("keys the exception to the removed version: relearning keeps the dependent readable until the owner acts on the fact", async () => {
    const owner = await reader();
    const source = await automatic(owner.userId, "Anna visited me yesterday.", "EPISODIC");
    const dependent = await automatic(owner.userId, "Anna is my only sister.");
    await depend(owner.userId, dependent, source.currentVersionId);
    await removeByMaintenance(owner.userId, source);
    const message = await createMaintenanceMessage(owner.userId, source.statement, { at: new Date() });
    const relearned = await relearnMaintenanceFact(owner.userId, source.factId, { statement: source.statement, source: message });
    expect(await prisma.memoryFact.findUnique({ where: { id: source.factId } }))
      .toMatchObject({ state: "ACTIVE", currentVersionId: relearned });
    expect(await readable(owner, dependent)).toEqual(visible);
    await ownerForget(owner.userId, { factId: source.factId, currentVersionId: relearned });
    expect(await readable(owner, dependent)).toEqual(hidden);
  });

  it("hides the dependent fact once its relearned source fact is retracted", async () => {
    const owner = await reader();
    const source = await automatic(owner.userId, "Anna visited me yesterday.", "EPISODIC");
    const dependent = await automatic(owner.userId, "Anna is my only sister.");
    await depend(owner.userId, dependent, source.currentVersionId);
    await removeByMaintenance(owner.userId, source);
    const message = await createMaintenanceMessage(owner.userId, source.statement, { at: new Date() });
    const relearned = await relearnMaintenanceFact(owner.userId, source.factId, { statement: source.statement, source: message });
    expect(await readable(owner, dependent)).toEqual(visible);
    await prisma.$transaction(async (tx) => {
      await tx.memoryFactVersion.update({ where: { id: relearned }, data: { state: "RETRACTED", systemTo: new Date() } });
      await tx.memoryFact.update({ where: { id: source.factId }, data: { state: "RETRACTED", currentVersionId: null } });
    });
    expect(await readable(owner, dependent)).toEqual(hidden);
  });

  it("gives no exception to an older version forgotten together with the removed one", async () => {
    const owner = await reader();
    const monday = await createMaintenanceMessage(owner.userId, "Anna visited me on Monday.");
    const friday = await createMaintenanceMessage(owner.userId, "Anna visited me again on Friday.");
    const source = await createAutomaticMaintenanceFact(owner.userId, [
      { statement: monday.text, source: monday, usefulness: "EPISODIC" },
      { statement: friday.text, source: friday, usefulness: "EPISODIC" }]);
    const dependent = await automatic(owner.userId, "Anna is my only sister.");
    await depend(owner.userId, dependent, source.versionIds[0]!);
    expect(await readable(owner, dependent)).toEqual(visible);
    await removeByMaintenance(owner.userId, source);
    expect(await readable(owner, dependent)).toEqual(hidden);
  });

  it.each(["memory-maintenance-policy-v1", "memory-maintenance-policy-v2"])(
    "applies the same rule to a source removed under %s", async (policyVersion) => {
      const owner = await reader();
      const source = await automatic(owner.userId, "Anna visited me yesterday.", "EPISODIC");
      const dependent = await automatic(owner.userId, "Anna is my only sister.");
      await depend(owner.userId, dependent, source.currentVersionId);
      await removeAsEarlierPolicy(owner.userId, policyVersion, source);
      expect(await readable(owner, dependent)).toEqual(visible);
      await prisma.chat.update({ where: { id: source.source.chatId }, data: { memoryMode: "EXCLUDED" } });
      expect(await readable(owner, dependent)).toEqual(hidden);
    });

  it("lets a new fact rely on a fact whose own source was removed by maintenance", async () => {
    const owner = await reader();
    const source = await automatic(owner.userId, "Lena called me this morning.", "EPISODIC");
    const dependent = await automatic(owner.userId, "Lena is my business partner.");
    await depend(owner.userId, dependent, source.currentVersionId);
    await removeByMaintenance(owner.userId, source);
    const later = await automatic(owner.userId, "Lena and I run a bakery together.");
    await expect(depend(owner.userId, later, dependent.currentVersionId)).resolves.toBeUndefined();
    expect(await readable(owner, later)).toEqual(visible);
  });

  it("hides the dependent fact once the owner forgets its source", async () => {
    const owner = await reader();
    const source = await automatic(owner.userId, "Marco moved into my building.");
    const dependent = await automatic(owner.userId, "Marco is my neighbour.");
    await depend(owner.userId, dependent, source.currentVersionId);
    expect(await readable(owner, dependent)).toEqual(visible);
    await ownerForget(owner.userId, source);
    expect(await readable(owner, dependent)).toEqual(hidden);
  });
});

describe("standing admission under maintenance policy v3", () => {
  it("ignores non-final dispositions and takes a v3 decision's label, falling back to the version label", async () => {
    const owner = await reader();
    const fact = await automatic(owner.userId, "I am training for a marathon next spring.", null);
    const evidenceThrough = (await prisma.memoryEvidence.findFirstOrThrow({ where: { factVersionId: fact.currentVersionId } })).createdAt;
    const job = await prisma.memoryJob.create({ data: { userId: owner.userId, kind: "SYNTHESIZE_MEMORIES",
      pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION, idempotencyFingerprint: randomUUID(), memoryGenerationSnapshot: 0,
      memoryRevisionSnapshot: 0, state: "SUCCEEDED", completedAt: new Date() } });
    let clock = Date.now();
    let ordinal = 0;
    const review = (data: Readonly<{ disposition: string; usefulness?: string; reasonCode?: string; withJob?: boolean }>) =>
      prisma.memoryMaintenanceReview.create({ data: { userId: owner.userId, factVersionId: fact.currentVersionId,
        policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION, evidenceThrough, sourceSnapshotHash: (++ordinal).toString(16).padStart(64, "0"),
        memoryJobId: data.withJob === false ? null : job.id, disposition: data.disposition, usefulness: data.usefulness ?? null,
        reasonCode: data.reasonCode ?? null, reviewedAt: new Date(clock += 1_000) } });
    const standing = async () => (await readable(owner, fact)).standing;
    expect(await standing()).toBe(false);
    await review({ disposition: "KEEP", usefulness: "ONGOING" });
    expect(await standing()).toBe(true);
    await review({ disposition: "BLOCKED", reasonCode: "pending_relation", withJob: false });
    await review({ disposition: "UNREVIEWABLE", reasonCode: "statement_too_long", withJob: false });
    await review({ disposition: "BLOCKED", reasonCode: "source_changed" });
    await review({ disposition: "STALE" });
    await review({ disposition: "UNKNOWN" });
    expect(await standing()).toBe(true);
    await review({ disposition: "REJECTED" });
    expect(await standing()).toBe(false);
    await prisma.memoryFactVersion.update({ where: { id: fact.currentVersionId }, data: { usefulness: "DURABLE" } });
    expect(await standing()).toBe(true);
    await review({ disposition: "KEEP" });
    expect(await standing()).toBe(true);
    await prisma.memoryFactVersion.update({ where: { id: fact.currentVersionId }, data: { usefulness: "EPISODIC" } });
    expect(await standing()).toBe(false);
  });
});
