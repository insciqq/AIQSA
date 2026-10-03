// Cross-fact contradictions in policy-v4 maintenance: settlement precedence
// against real fact state, the widened reason constraint, the related-memory
// loader over the owner's own embeddings and revalidation before disclosure.
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createMaintenanceMessage, createMaintenanceOwner, deleteMaintenanceOwner, type MaintenanceFixtureMessage
} from "@/tests/support/memoryMaintenance";
import { prisma } from "../../prisma";
import type { MemoryJobClaim } from "../coordinator/types";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import { memorySafetyLiteFactClassification } from "../safetyLite";
import type { MemoryMaintenanceDecision } from "./contract";
import { MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION } from "./policy";
import { createPrismaMemoryMaintenanceProvider, memoryMaintenanceInputHash, memoryMaintenanceOutputHash,
  type MemoryMaintenanceReviewResult, type MemoryMaintenanceVerificationResult } from "./provider";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";
import { loadMemoryMaintenanceRelatedMemories } from "./related";
import { createPrismaMemoryMaintenanceRepository } from "./repository";

const owners: string[] = [];
async function owner(): Promise<string> {
  const userId = await createMaintenanceOwner("memory-contradiction");
  owners.push(userId);
  return userId;
}
afterEach(async () => {
  for (const userId of owners.splice(0)) await deleteMaintenanceOwner(userId);
});
afterAll(async () => { await prisma.$disconnect(); });

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);
type Fact = Readonly<{ factId: string; versionId: string }>;
/** A user turn and, optionally, the exact span a fact rests on. */
type Said = Readonly<{ message: MaintenanceFixtureMessage; at: Date; start?: number; end?: number }>;
async function said(userId: string, text: string, at: Date): Promise<Said> {
  return { message: await createMaintenanceMessage(userId, text, { at }), at };
}
function span(turn: Said, quote: string): Said {
  const start = turn.message.text.indexOf(quote);
  if (start < 0) throw new Error("contradiction_fixture_span_missing");
  return { ...turn, start, end: start + quote.length };
}
async function scopeOf(userId: string): Promise<string> {
  return (await prisma.memoryScope.findFirstOrThrow({ where: { userId, scopeType: "GLOBAL_USER" } })).id;
}
/** An automatic current fact whose exact evidence was written at its turns' times. */
async function automaticFact(userId: string, statement: string, turns: readonly Said[], options: Readonly<{ pinned?: boolean }> = {}): Promise<Fact> {
  const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
  const observedAt = turns[0]!.at;
  const scopeId = await scopeOf(userId);
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: { id: factId, userId, scopeId, category: "other", canonicalKey: `prop:v2:${memorySha256({ factId })}`,
      state: "ORPHANED", pinned: options.pinned ?? false, identityKind: "PROPOSITION", identityVersion: "proposition-v2" } });
    await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId, operation: "AUTO_PROPOSE", actorType: "JOB" } });
    await tx.memoryFactVersion.create({ data: { id: versionId, factId, userId, createdByEventId: eventId, category: "other",
      displayText: statement, normalizedSearchText: normalizeMemorySearchText(statement),
      structuredValue: { kind: "statement", value: statement }, languageCode: "en", modality: "STATE", sourceMode: "AUTOMATIC",
      confidence: 0.6, importance: 0.4, directness: "DIRECT", sensitivityClass: "NORMAL", ...memorySafetyLiteFactClassification(observedAt),
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, ingestionFingerprint: memorySha256({ factId, versionId }),
      observedAt, createdAt: observedAt, systemFrom: observedAt, state: "ACTIVE" } });
    for (const turn of turns) {
      const start = turn.start ?? 0;
      const end = turn.end ?? turn.message.text.length;
      await tx.memoryEvidence.create({ data: { userId, factVersionId: versionId, chatId: turn.message.chatId,
        messageId: turn.message.messageId, stance: "SUPPORTS", sourceType: "MESSAGE", sourceRole: "user", branchGeneration: 0,
        observedAt: turn.at, createdAt: turn.at, safeExcerpt: turn.message.text.slice(start, end), safetyClass: "NORMAL",
        safeSourceHash: memorySha256(turn.message.text), sourceMessageContentHash: memorySha256(turn.message.text),
        sourceStartOffset: start, sourceEndOffset: end, sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
        evidenceFingerprint: memorySha256({ versionId, messageId: turn.message.messageId, start, end }) } });
    }
    await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId: versionId } });
  });
  return { factId, versionId };
}
/** An explicitly saved current fact: no message testimony, owner authority. */
async function explicitFact(userId: string, statement: string, at: Date): Promise<Fact> {
  const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
  const scopeId = await scopeOf(userId);
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: { id: factId, userId, scopeId, category: "other", canonicalKey: `prop:v2:${memorySha256({ factId })}`,
      state: "ORPHANED", identityKind: "PROPOSITION", identityVersion: "proposition-v2" } });
    await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId, operation: "EXPLICIT_SAVE",
      actorType: "USER", actorUserId: userId } });
    await tx.memoryFactVersion.create({ data: { id: versionId, factId, userId, createdByEventId: eventId, category: "other",
      displayText: statement, normalizedSearchText: normalizeMemorySearchText(statement),
      structuredValue: { kind: "statement", value: statement }, languageCode: "en", modality: "STATE", sourceMode: "EXPLICIT",
      confidence: 1, importance: 0.5, directness: "DIRECT", sensitivityClass: "NORMAL", ...memorySafetyLiteFactClassification(at),
      pipelineVersion: "memory-explicit-api-v1", observedAt: at, createdAt: at, systemFrom: at, state: "ACTIVE" } });
    await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId: versionId } });
  });
  return { factId, versionId };
}
/** As a forget does before purging: no current version is left. */
async function forget(fact: Fact): Promise<void> {
  const now = new Date();
  await prisma.memoryFactVersion.updateMany({ where: { factId: fact.factId }, data: { state: "FORGOTTEN", systemTo: now } });
  await prisma.memoryFact.update({ where: { id: fact.factId }, data: { state: "FORGOTTEN", currentVersionId: null, forgottenAt: now } });
}
/** An owner edit: a new explicit current version replaces the shown one. */
async function edit(userId: string, fact: Fact, statement: string): Promise<string> {
  const versionId = randomUUID(), eventId = randomUUID(), now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.memoryFactVersion.update({ where: { id: fact.versionId }, data: { state: "SUPERSEDED", systemTo: now } });
    await tx.memoryEvent.create({ data: { id: eventId, userId, factId: fact.factId, factVersionId: versionId, operation: "EDIT",
      actorType: "USER", actorUserId: userId } });
    await tx.memoryFactVersion.create({ data: { id: versionId, factId: fact.factId, userId, createdByEventId: eventId, category: "other",
      displayText: statement, normalizedSearchText: normalizeMemorySearchText(statement),
      structuredValue: { kind: "statement", value: statement }, languageCode: "en", modality: "STATE", sourceMode: "EXPLICIT",
      confidence: 1, importance: 0.5, directness: "DIRECT", sensitivityClass: "NORMAL", ...memorySafetyLiteFactClassification(now),
      pipelineVersion: "memory-explicit-api-v1", observedAt: now, createdAt: now, systemFrom: new Date(now.getTime() + 1), state: "ACTIVE" } });
    await tx.memoryFact.update({ where: { id: fact.factId }, data: { currentVersionId: versionId } });
  });
  return versionId;
}

/** What the review decided for a source, by fact. */
type Decided = "KEEP" | "KEEP_UNRESOLVED" | "TRANSIENT" | Readonly<{ contradictedBy: Fact }>;
/** Plans the owner's batch, claims it and returns its snapshot and settlement. */
async function planned(userId: string) {
  expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
  const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION, state: "QUEUED" } });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  await prisma.memoryJob.update({ where: { id: job.id }, data: { state: "CLAIMED", leaseToken: claimToken, leaseExpiresAt } });
  const claim = { ...job, claimToken, recoveredLease: false, leaseExpiresAt } as MemoryJobClaim;
  const repository = createPrismaMemoryMaintenanceRepository(prisma);
  const snapshot = (await repository.snapshot(claim))!;
  const plan = snapshot.plan!;
  const refOf = (fact: Fact) => plan.sources.find(({ factId }) => factId === fact.factId)!.ref;
  /** Settles synthetic governed decisions; `verdicts` holds the verifier's answers by fact, and an
   * absent proposal was never disclosed to it. */
  async function settle(decide: (factId: string) => Decided, verdicts: ReadonlyMap<string, boolean> = new Map(),
    disclosed: (factId: string) => boolean = () => true) {
    const inputHash = memoryMaintenanceInputHash(snapshot);
    const output = { decisions: plan.sources.map(({ ref, factId }): MemoryMaintenanceDecision => {
      const decided = decide(factId);
      if (decided === "KEEP") return { sourceRef: ref, scopeBasis: "general_personal", action: "KEEP", usefulness: "DURABLE",
        reason: "useful_personal_context" };
      if (decided === "KEEP_UNRESOLVED") return { sourceRef: ref, scopeBasis: "unresolved_scope", action: "KEEP", usefulness: null,
        reason: "useful_personal_context" };
      if (decided === "TRANSIENT") return { sourceRef: ref, scopeBasis: "single_episode", action: "REMOVE_TRANSIENT", usefulness: null,
        reason: "episode" };
      return { sourceRef: ref, scopeBasis: "general_personal", action: "REMOVE_TRANSIENT", usefulness: null, reason: "contradicted",
        contradictedBy: { ref: `${ref}M1`, factId: decided.contradictedBy.factId, versionId: decided.contradictedBy.versionId } };
    }) };
    const review: MemoryMaintenanceReviewResult = { inputHash, output, acceptedOutputHash: memoryMaintenanceOutputHash(inputHash, output),
      executionId: "synthetic-review", providerId: "synthetic", modelId: "synthetic", policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION };
    const verification: MemoryMaintenanceVerificationResult = { ...review, output: { decisions: plan.sources
      .filter(({ ref, factId }) => output.decisions.find(({ sourceRef }) => sourceRef === ref)!.action === "REMOVE_TRANSIENT" && disclosed(factId))
      .map(({ ref, factId }) => ({ sourceRef: ref, approve: verdicts.get(factId) ?? true })) } };
    return withLockedMemoryTransaction(prisma, userId, (tx) => repository.apply(tx, claim, snapshot, review, verification, new Date()));
  }
  return { claim, plan, snapshot, refOf, settle };
}
function settled(userId: string, fact: Fact) {
  return prisma.memoryMaintenanceReview.findFirstOrThrow({ where: { userId, factVersionId: fact.versionId,
    policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION }, select: { disposition: true, usefulness: true, reasonCode: true } });
}
function state(fact: Fact) {
  return prisma.memoryFact.findUniqueOrThrow({ where: { id: fact.factId }, select: { state: true, currentVersionId: true, pinned: true } });
}
const removed = { disposition: "REMOVED", usefulness: null, reasonCode: "contradicted" };
const conflict = { disposition: "KEEP", usefulness: "DURABLE", reasonCode: "conflict_unresolved" };
const kept = { disposition: "KEEP", usefulness: "DURABLE", reasonCode: null };

describe("maintenance contradiction settlement", () => {
  it("removes only an automatic source that an explicit, pinned or newer automatic memory outranks", async () => {
    const userId = await owner();
    const explicit = await explicitFact(userId, "I always want complete code with every fix applied.", daysAgo(20));
    const snippets = await automaticFact(userId, "I prefer short code snippets.", [await said(userId, "I prefer short code snippets.", daysAgo(5))]);
    const pinned = await automaticFact(userId, "I live in Berlin.", [await said(userId, "I live in Berlin.", daysAgo(20))], { pinned: true });
    const moscow = await automaticFact(userId, "I live in Moscow.", [await said(userId, "I live in Moscow.", daysAgo(5))]);
    const vegetarian = await automaticFact(userId, "I switched to a vegetarian diet.",
      [await said(userId, "I switched to a vegetarian diet.", daysAgo(5))]);
    const steak = await automaticFact(userId, "I eat beef steak every week.", [await said(userId, "I eat beef steak every week.", daysAgo(15))]);
    const both = await said(userId, "I am a morning person. I usually sleep until noon.", daysAgo(10));
    const morning = await automaticFact(userId, "I am a morning person.", [span(both, "I am a morning person.")]);
    const noon = await automaticFact(userId, "I usually sleep until noon.", [span(both, "I usually sleep until noon.")]);
    const bank = await automaticFact(userId, "I work at a bank.", [await said(userId, "I work at a bank.", daysAgo(20))]);
    const teacher = await automaticFact(userId, "I left my bank job and work as a teacher now.",
      [await said(userId, "I left my bank job and work as a teacher now.", daysAgo(5))]);
    const tea = await automaticFact(userId, "I prefer tea.", [await said(userId, "I prefer tea.", daysAgo(15))]);
    const work = await planned(userId);
    // Explicit and pinned memories are never reviewed, only shown.
    expect(work.plan.sources.map(({ factId }) => factId).sort()).toEqual([snippets, moscow, vegetarian, steak, morning, noon, bank, teacher, tea]
      .map(({ factId }) => factId).sort());
    const decided = new Map<string, Decided>([[snippets.factId, { contradictedBy: explicit }], [moscow.factId, { contradictedBy: pinned }],
      [steak.factId, { contradictedBy: vegetarian }], [morning.factId, { contradictedBy: noon }], [noon.factId, { contradictedBy: morning }],
      [teacher.factId, { contradictedBy: bank }], [tea.factId, { contradictedBy: explicit }]]);
    await expect(work.settle((factId) => decided.get(factId) ?? "KEEP", new Map([[tea.factId, false]])))
      .resolves.toMatchObject({ reviewed: 9, removed: 3, blocked: 0 });
    // Explicit and pinned memories outrank whatever their age; a newer automatic one outranks from another message.
    for (const source of [snippets, moscow, steak]) {
      expect(await settled(userId, source)).toEqual(removed);
      expect(await state(source)).toMatchObject({ state: "FORGOTTEN", currentVersionId: null });
    }
    // The same message, or an older contradicting memory, gives no order: both stay and the conflict is recorded.
    for (const source of [morning, noon, teacher]) expect(await settled(userId, source)).toEqual(conflict);
    for (const target of [vegetarian, bank]) expect(await settled(userId, target)).toEqual(kept);
    // The verifier's rejection keeps the source under the removal's own reason.
    expect(await settled(userId, tea)).toEqual({ disposition: "REJECTED", usefulness: null, reasonCode: "contradicted" });
    for (const fact of [explicit, pinned, morning, noon, bank, teacher, tea, vegetarian]) {
      expect(await state(fact)).toMatchObject({ state: "ACTIVE", currentVersionId: fact.versionId });
    }
    expect(await state(pinned)).toMatchObject({ pinned: true });
    expect(await prisma.memoryMaintenanceReview.count({ where: { userId, factVersionId: { in: [explicit.versionId, pinned.versionId] } } })).toBe(0);
  });
  it("keeps a source whose contradicting memory changed, went or was never verified before settlement", async () => {
    const userId = await owner();
    const forgottenTarget = await explicitFact(userId, "I am allergic to cats.", daysAgo(20));
    const editedTarget = await explicitFact(userId, "I prefer window seats.", daysAgo(20));
    const undisclosedTarget = await explicitFact(userId, "I never drink coffee.", daysAgo(20));
    const cats = await automaticFact(userId, "I have three cats at home.", [await said(userId, "I have three cats at home.", daysAgo(5))]);
    const aisle = await automaticFact(userId, "I always book aisle seats.", [await said(userId, "I always book aisle seats.", daysAgo(5))]);
    const coffee = await automaticFact(userId, "I drink two coffees every morning.",
      [await said(userId, "I drink two coffees every morning.", daysAgo(5))]);
    const transientTarget = await automaticFact(userId, "Today I ran ten kilometres.", [await said(userId, "Today I ran ten kilometres.", daysAgo(3))]);
    const running = await automaticFact(userId, "I never run.", [await said(userId, "I never run.", daysAgo(15))]);
    const work = await planned(userId);
    await forget(forgottenTarget);
    await edit(userId, editedTarget, "I prefer aisle seats now.");
    const decided = new Map<string, Decided>([[cats.factId, { contradictedBy: forgottenTarget }], [aisle.factId, { contradictedBy: editedTarget }],
      [coffee.factId, { contradictedBy: undisclosedTarget }], [running.factId, { contradictedBy: transientTarget }],
      [transientTarget.factId, "TRANSIENT"]]);
    await expect(work.settle((factId) => decided.get(factId) ?? "KEEP", new Map(), (factId) => factId !== coffee.factId))
      .resolves.toMatchObject({ reviewed: 5, removed: 1, blocked: 0 });
    // No conflict remains with a memory that is gone, changed, or removed in this very settlement.
    for (const source of [cats, aisle, coffee, running]) {
      expect(await settled(userId, source)).toEqual(kept);
      expect(await state(source)).toMatchObject({ state: "ACTIVE", currentVersionId: source.versionId });
    }
    expect(await settled(userId, transientTarget)).toEqual({ disposition: "REMOVED", usefulness: null, reasonCode: "episode" });
    expect(await state(undisclosedTarget)).toMatchObject({ state: "ACTIVE", currentVersionId: undisclosedTarget.versionId });
  });
  it("lets a newer automatic memory outrank only once maintenance confirmed it lasting", async () => {
    const userId = await owner();
    const prior = await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES", pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
      idempotencyFingerprint: randomUUID(), state: "SUCCEEDED", completedAt: new Date(), memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0 } });
    /** A settled current-policy decision that covers `fact` until its re-review, so it is not in the batch. */
    const decided = (fact: Fact, evidenceThrough: Date, data: Readonly<{ disposition: "KEEP" | "REJECTED"; usefulness: "DURABLE" | null }>) =>
      prisma.memoryMaintenanceReview.create({ data: { userId, factVersionId: fact.versionId, memoryJobId: prior.id,
        policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION, sourceSnapshotHash: memorySha256({ decided: fact.versionId }), evidenceThrough,
        reviewedAt: new Date(), ...data } });
    const older = async (text: string) => automaticFact(userId, text, [await said(userId, text, daysAgo(15))]);
    const newer = async (text: string, at = daysAgo(5)) => {
      const turn = await said(userId, text, at);
      return { fact: await automaticFact(userId, text, [turn]), at: turn.at };
    };
    const lisbon = await older("I live in Lisbon.");
    const porto = await newer("I moved to Porto and live there now.");
    await decided(porto.fact, porto.at, { disposition: "KEEP", usefulness: "DURABLE" });
    const desk = await older("I work at a standing desk.");
    const sitting = await newer("I only work sitting down.");
    await decided(sitting.fact, sitting.at, { disposition: "REJECTED", usefulness: null });
    const tea = await older("I drink only green tea.");
    // Still within the quiet period: never reviewed, so never confirmed lasting.
    const coffee = await newer("I switched to black coffee.", new Date(Date.now() - 5 * 60_000));
    const cat = await older("I have no pets.");
    const dog = await newer("I adopted a dog.");
    const vim = await older("I edit code in Vim.");
    const vscode = await newer("I moved from Vim to VS Code for all editing.");
    const work = await planned(userId);
    expect(work.plan.sources.map(({ factId }) => factId).sort()).toEqual([lisbon, desk, tea, cat, dog.fact, vim, vscode.fact]
      .map(({ factId }) => factId).sort());
    const decisions = new Map<string, Decided>([[lisbon.factId, { contradictedBy: porto.fact }], [desk.factId, { contradictedBy: sitting.fact }],
      [tea.factId, { contradictedBy: coffee.fact }], [cat.factId, { contradictedBy: dog.fact }], [dog.fact.factId, "KEEP_UNRESOLVED"],
      // Both directions named: the newer memory's own lasting basis confirms it.
      [vim.factId, { contradictedBy: vscode.fact }], [vscode.fact.factId, { contradictedBy: vim }]]);
    await expect(work.settle((factId) => decisions.get(factId) ?? "KEEP")).resolves.toMatchObject({ reviewed: 7, removed: 2, blocked: 0 });
    // Confirmed lasting by a settled keep, or by this review's own basis: the older memory goes.
    for (const source of [lisbon, vim]) expect(await settled(userId, source)).toEqual(removed);
    // Disputed, unreviewed or kept with unresolved scope: no order, both stay.
    for (const source of [desk, tea, cat]) {
      expect(await settled(userId, source)).toEqual(conflict);
      expect(await state(source)).toMatchObject({ state: "ACTIVE", currentVersionId: source.versionId });
    }
    // The superseding memory stays without a conflict once the older one is gone.
    expect(await settled(userId, vscode.fact)).toEqual(kept);
    expect(await settled(userId, dog.fact)).toEqual({ disposition: "KEEP", usefulness: null, reasonCode: null });
    for (const fact of [porto.fact, sitting.fact, coffee.fact, dog.fact, vscode.fact]) {
      expect(await state(fact)).toMatchObject({ state: "ACTIVE", currentVersionId: fact.versionId });
    }
  });
});

describe("maintenance contradiction reasons", () => {
  it("settles contradicted and conflict_unresolved only on their own dispositions, keeping previous-release writes valid", async () => {
    const userId = await owner();
    const source = await createMaintenanceMessage(userId, "I prefer short code snippets.");
    const fact = await automaticFact(userId, source.text, [{ message: source, at: daysAgo(1) }]);
    const job = await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES", pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
      idempotencyFingerprint: randomUUID(), memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0 } });
    let ordinal = 0;
    const settle = async (data: Readonly<{ disposition: string; reasonCode: string | null; usefulness?: string | null }>) => {
      const pending = await prisma.memoryMaintenanceReview.create({ data: { userId, factVersionId: fact.versionId, memoryJobId: job.id,
        policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION, evidenceThrough: daysAgo(1), sourceSnapshotHash: (++ordinal).toString(16).padStart(64, "0") } });
      return prisma.memoryMaintenanceReview.update({ where: { id: pending.id }, data: { ...data, reviewedAt: new Date() } });
    };
    for (const accepted of [
      { disposition: "REMOVED", reasonCode: "contradicted" }, { disposition: "REJECTED", reasonCode: "contradicted" },
      { disposition: "KEEP", reasonCode: "conflict_unresolved", usefulness: "DURABLE" },
      { disposition: "KEEP", reasonCode: "conflict_unresolved", usefulness: "ONGOING" },
      { disposition: "KEEP", reasonCode: "conflict_unresolved", usefulness: null },
      // The earlier closed reasons and previous-release reasonless settlements stay valid.
      { disposition: "KEEP", reasonCode: "unresolved_scope", usefulness: null }, { disposition: "REMOVED", reasonCode: "episode" },
      { disposition: "REMOVED", reasonCode: null }, { disposition: "KEEP", reasonCode: null, usefulness: "DURABLE" }
    ]) await expect(settle(accepted)).resolves.toMatchObject(accepted);
    for (const rejected of [
      { disposition: "KEEP", reasonCode: "contradicted", usefulness: null },
      { disposition: "REMOVED", reasonCode: "conflict_unresolved" }, { disposition: "REJECTED", reasonCode: "conflict_unresolved" },
      { disposition: "KEEP", reasonCode: "conflict_unresolved", usefulness: "EPISODIC" },
      { disposition: "KEEP", reasonCode: "unresolved_scope", usefulness: "DURABLE" },
      { disposition: "BLOCKED", reasonCode: "contradicted" }, { disposition: "UNKNOWN", reasonCode: "conflict_unresolved" }
    ]) await expect(settle(rejected)).rejects.toThrow();
    // A settled reason stays final.
    const final = await settle({ disposition: "REMOVED", reasonCode: "contradicted" });
    await expect(prisma.memoryMaintenanceReview.update({ where: { id: final.id }, data: { reasonCode: "episode" } })).rejects.toThrow();
  });
});

describe("maintenance related memories over the owner's embeddings", () => {
  const suffix = randomUUID();
  const connectionId = `memory-contradiction-connection-${suffix}`;
  const modelId = `memory-contradiction-model-${suffix}`;
  const configuration = {
    adapterKind: "openai_embeddings_compatible", answerSelectable: false,
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false }, defaultParams: {},
    embedding: { nativeDimension: 1_024, providerFamily: "openai_compatible", queryInstructionTemplate: null, supportsMrl: false,
      targetDimension: 1_024 },
    modelClass: "embedding", upstreamModelId: "memory-contradiction-fixture-v1"
  } as const;
  afterAll(async () => {
    await prisma.providerModel.deleteMany({ where: { id: modelId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
  });
  /** A synthetic active vector space for the owner; no embedding provider is called. */
  async function activeGeneration(userId: string): Promise<string> {
    if (!await prisma.providerConnection.count({ where: { id: connectionId } })) {
      const config = { allowPrivateNetwork: false, apiRoot: "https://memory-contradiction.example.test/v1", responseTimeoutMs: 30_000 };
      await prisma.providerConnection.create({ data: { id: connectionId, activeConfig: config, draftConfig: config, activeVersion: 1,
        draftVersion: 1, activatedAt: new Date(), displayName: "Contradiction fixture provider", enabled: true, family: "openai_compatible" } });
      await prisma.providerModel.create({ data: { id: modelId, connectionId, activeConfig: configuration, draftConfig: configuration,
        activeVersion: 1, draftVersion: 1, activatedAt: new Date(), capabilities: configuration.capabilities, defaultParams: {},
        displayName: "Contradiction fixture model", enabled: true, modelClass: "embedding", modelId: configuration.upstreamModelId,
        provider: "openai_compatible" } });
    }
    const now = new Date();
    const latest = await prisma.memoryIndexGeneration.aggregate({ _max: { generation: true }, where: { userId } });
    const generation = await prisma.memoryIndexGeneration.create({ data: { userId, generation: (latest._max.generation ?? -1) + 1,
      state: "READY", readyAt: now, indexMode: "HYBRID", chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
      embeddingConfigurationFingerprint: "d".repeat(64), embeddingConnectionId: connectionId, embeddingDimension: 1_024,
      embeddingProviderModelId: modelId, indexedThroughMemoryRevision: 0, languageProfile: "RU_EN_MULTILINGUAL_V1",
      normalizationVersion: "memory-search-normalization-v1", retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
      targetMemoryRevision: 0, vectorSpaceFingerprint: "e".repeat(64) } });
    await prisma.$transaction(async (tx) => {
      // A lexical generation bootstrapped earlier gives way to the vector one.
      await tx.memoryIndexGeneration.updateMany({ where: { userId, state: "ACTIVE" }, data: { state: "SUPERSEDED", supersededAt: now } });
      await tx.userMemorySettings.update({ where: { userId }, data: { activeIndexGenerationId: generation.id, embeddingProviderModelId: modelId } });
      await tx.memoryIndexGeneration.update({ where: { id: generation.id }, data: { state: "ACTIVE", activatedAt: now } });
    });
    return generation.id;
  }
  /** A ready entry whose cosine similarity to the first axis is `similarity`. */
  async function embed(userId: string, generationId: string, fact: Fact, text: string, similarity: number): Promise<void> {
    const vector = Array.from({ length: 1_024 }, (_, index) => index === 0 ? similarity : index === 1 ? Math.sqrt(1 - similarity ** 2) : 0);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "MemorySearchEntry" ("id", "userId", "indexGenerationId", "itemType", "factVersionId", "normalizedSearchText",
        "safeContentHash", "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot", "suppressionIdentitySnapshot",
        "embedding", "embeddingDimension", "embeddingState")
      VALUES (${randomUUID()}, ${userId}, ${generationId}, 'FACT_VERSION'::"MemorySearchItemType", ${fact.versionId},
        ${normalizeMemorySearchText(text)}, ${memorySha256(text)}, 'en', ${memorySha256({ safety: text })}, ${memorySha256({ source: text })},
        ${memorySha256({ suppression: text })}, ${`[${vector.join(",")}]`}::vector, 1024, 'READY'::"MemoryEmbeddingState")
    `);
  }

  it("shows the nearest current memories of the owner, explicit and pinned included, and none without embeddings", async () => {
    const userId = await owner();
    const statements = { source: "I prefer short code snippets.", explicit: "I always want complete code with every fix applied.",
      pinned: "I paste whole files into my editor.", automatic: "I review code on a large monitor.", far: "I keep two cats.",
      forgotten: "I like code golf." };
    const source = await automaticFact(userId, statements.source, [await said(userId, statements.source, daysAgo(5))]);
    const explicit = await explicitFact(userId, statements.explicit, daysAgo(20));
    const pinned = await automaticFact(userId, statements.pinned, [await said(userId, statements.pinned, daysAgo(20))], { pinned: true });
    const automatic = await automaticFact(userId, statements.automatic, [await said(userId, statements.automatic, daysAgo(10))]);
    const far = await automaticFact(userId, statements.far, [await said(userId, statements.far, daysAgo(10))]);
    const forgotten = await automaticFact(userId, statements.forgotten, [await said(userId, statements.forgotten, daysAgo(10))]);
    await forget(forgotten);
    const work = await planned(userId);
    // Without an active embedding profile the review simply has no related memories.
    expect(await loadMemoryMaintenanceRelatedMemories(prisma, userId, work.plan.sources, { jobId: work.claim.id })).toEqual(new Map());
    const generationId = await activeGeneration(userId);
    for (const [fact, text, similarity] of [[source, statements.source, 1], [explicit, statements.explicit, 0.9],
      [pinned, statements.pinned, 0.8], [automatic, statements.automatic, 0.7], [far, statements.far, 0.1],
      [forgotten, statements.forgotten, 0.95]] as const) await embed(userId, generationId, fact, text, similarity);
    const related = await loadMemoryMaintenanceRelatedMemories(prisma, userId, work.plan.sources, { jobId: work.claim.id });
    const ref = work.refOf(source);
    // The forgotten memory ranks first by vector but is no longer current; the source never relates to itself.
    expect(related.get(ref)?.map(({ ref: shown, factId, versionId, statement }) => ({ shown, factId, versionId, statement }))).toEqual([
      { shown: `${ref}M1`, ...explicit, statement: statements.explicit },
      { shown: `${ref}M2`, ...pinned, statement: statements.pinned },
      { shown: `${ref}M3`, ...automatic, statement: statements.automatic }
    ]);
  });
  it("never discloses a related memory forgotten after it was read", async () => {
    const userId = await owner();
    const source = await automaticFact(userId, "I prefer short code snippets.", [await said(userId, "I prefer short code snippets.", daysAgo(5))]);
    const explicit = await explicitFact(userId, "I always want complete code with every fix applied.", daysAgo(20));
    const work = await planned(userId);
    const shown = { ref: `${work.refOf(source)}M1`, ...explicit, statement: "I always want complete code with every fix applied.",
      observedAt: daysAgo(20) };
    await forget(explicit);
    const run = vi.fn();
    const provider = createPrismaMemoryMaintenanceProvider(prisma, { provider: { run },
      related: async () => new Map([[work.refOf(source), [shown]]]) });
    await expect(provider.review(work.plan, new AbortController().signal, { userId, jobId: work.claim.id }))
      .rejects.toThrow(expect.objectContaining({ name: "MemoryJobFencedError", code: "memory_maintenance_dispatch_stale" }));
    expect(run).not.toHaveBeenCalled();
    expect(await prisma.memoryExecutionBinding.count({ where: { userId } })).toBe(0);
  });
});
