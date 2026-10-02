import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createAutomaticMaintenanceFact, createMaintenanceMessage, createMaintenanceOwner, deleteMaintenanceOwner,
  drainMaintenanceForgetPurges, settleMaintenanceJob
} from "@/tests/support/memoryMaintenance";
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
import { createPrismaLocalMemoryRetrievalRepository } from "../retrieval/localRepository";
import { createMemoryNativeFactSearchPlan } from "../retrieval/nativeFactSearch";
import { MEMORY_MAINTENANCE_POLICY_VERSION } from "./policy";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";

const owners: string[] = [];
afterEach(async () => {
  for (const userId of owners.splice(0)) await deleteMaintenanceOwner(userId);
});
afterAll(async () => { await prisma.$disconnect(); });

/** An owner whose lexical generation is ready, with a current chat. */
async function reader(): Promise<Readonly<{ userId: string; chatId: string }>> {
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
async function automatic(userId: string, statement: string, usefulness: "DURABLE" | "EPISODIC" | null = "DURABLE") {
  const source = await createMaintenanceMessage(userId, statement);
  return { ...await createAutomaticMaintenanceFact(userId, [{ statement, source, usefulness: usefulness ?? undefined }]), statement };
}
/** Every read surface a dependent fact reaches through its authority. */
async function readable(owner: Readonly<{ userId: string; chatId: string }>, fact: Readonly<{ factId: string; currentVersionId: string; statement: string }>) {
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
async function ownerForget(userId: string, fact: Readonly<{ factId: string; currentVersionId: string }>) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.memoryEvent.create({ data: { userId, factId: fact.factId, factVersionId: fact.currentVersionId,
      operation: "FORGET", actorType: "USER", actorUserId: userId } });
    await tx.memoryFactVersion.updateMany({ where: { userId, factId: fact.factId }, data: { state: "FORGOTTEN", systemTo: now,
      displayText: null, normalizedSearchText: null, structuredValue: Prisma.DbNull, contentPurgedAt: now } });
    await tx.memoryFact.update({ where: { id: fact.factId }, data: { state: "FORGOTTEN", currentVersionId: null, forgottenAt: now } });
  });
}

describe("dependent fact authority after automatic cleanup", () => {
  it("keeps a long-term fact readable after maintenance cleans its source, refuses new writes on that source and stops the chain there", async () => {
    const owner = await reader();
    const root = await automatic(owner.userId, "My sister Anna lives in Lisbon.");
    const source = await automatic(owner.userId, "Anna visited me yesterday.", "EPISODIC");
    const dependent = await automatic(owner.userId, "Anna is my only sister.");
    await prisma.$transaction((tx) => persistMemoryFactDependencies(tx, owner.userId, source.currentVersionId, [dependsOn(root.currentVersionId)]));
    await prisma.$transaction((tx) => persistMemoryFactDependencies(tx, owner.userId, dependent.currentVersionId, [dependsOn(source.currentVersionId)]));
    expect(await readable(owner, dependent)).toEqual(visible);
    expect(await scheduleOwnerMemoryMaintenance(prisma, owner.userId, new Date())).toBe(1);
    await settleMaintenanceJob(owner.userId, (factId) => factId === source.factId ? "REMOVE" : "KEEP");
    expect(await prisma.memoryFact.findUnique({ where: { id: source.factId } })).toMatchObject({ state: "FORGOTTEN" });
    expect(await readable(owner, source)).toEqual(hidden);
    expect(await readable(owner, dependent)).toEqual(visible);
    // The purge removes the source's evidence; the cleanup event keeps the hint valid.
    expect(await drainMaintenanceForgetPurges(owner.userId)).toBe(1);
    expect(await prisma.memoryEvidence.count({ where: { userId: owner.userId, factVersionId: source.currentVersionId } })).toBe(0);
    expect(await readable(owner, dependent)).toEqual(visible);
    // The cleaned source's own dependency is no longer evaluated.
    await ownerForget(owner.userId, root);
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
  });

  it("lets a new fact rely on a fact whose own source was cleaned by maintenance", async () => {
    const owner = await reader();
    const source = await automatic(owner.userId, "Lena called me this morning.", "EPISODIC");
    const dependent = await automatic(owner.userId, "Lena is my business partner.");
    await prisma.$transaction((tx) => persistMemoryFactDependencies(tx, owner.userId, dependent.currentVersionId, [dependsOn(source.currentVersionId)]));
    expect(await scheduleOwnerMemoryMaintenance(prisma, owner.userId, new Date())).toBe(1);
    await settleMaintenanceJob(owner.userId, (factId) => factId === source.factId ? "REMOVE" : "KEEP");
    const later = await automatic(owner.userId, "Lena and I run a bakery together.");
    await expect(prisma.$transaction((tx) => persistMemoryFactDependencies(tx, owner.userId, later.currentVersionId,
      [dependsOn(dependent.currentVersionId)]))).resolves.toBeUndefined();
    expect(await readable(owner, later)).toEqual(visible);
  });

  it("hides the dependent fact once the owner forgets its source", async () => {
    const owner = await reader();
    const source = await automatic(owner.userId, "Marco moved into my building.");
    const dependent = await automatic(owner.userId, "Marco is my neighbour.");
    await prisma.$transaction((tx) => persistMemoryFactDependencies(tx, owner.userId, dependent.currentVersionId, [dependsOn(source.currentVersionId)]));
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
      pipelineVersion: "memory-maintenance-v1", idempotencyFingerprint: randomUUID(), memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0,
      state: "SUCCEEDED", completedAt: new Date() } });
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
