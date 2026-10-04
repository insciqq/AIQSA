import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../../contracts/memory";
import { createAutomaticMaintenanceFact, createMaintenanceMessage } from "@/tests/support/memoryMaintenance";
import {
  createTestProviderExecutionAuthority,
  deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority
} from "@/tests/support/providerExecutionAuthority";
import { prisma } from "../../../prisma";
import { createMemoryUtilityModelRoleResolver } from "../../../providerRuntime/memoryUtilityModelRole";
import { forcedToolCallVerificationEvidence } from "../../../providers/forcedToolCallEvidence";
import { structuredOutputVerificationEvidence } from "../../../providers/structuredOutputEvidence";
import { createPrismaMemoryCoordinatorRepository } from "../../coordinator/prismaRepository";
import type { MemoryDeletionClaim, MemoryJobClaim, MemoryJobExecutionResult } from "../../coordinator/types";
import type { MemoryStructuredOutputProvider } from "../../execution";
import { createPrismaExplicitMemoryRepository } from "../../explicit/repository";
import { createExplicitMemoryService } from "../../explicit/service";
import { createPrismaMemoryLifecycleRepository } from "../../lifecycle/repository";
import { createMemoryLifecycleService } from "../../lifecycle/service";
import { createPrismaMemoryMutationAuthorizationRepository } from "../../persistence/authorizations";
import { resolveMemoryExplicitEquivalentTarget } from "../../persistence/explicitEquivalence";
import { ensureClassifiedSearchEntry } from "../../persistence/factSearchEntry";
import { createPrismaMemoryFactRepository } from "../../persistence/facts";
import { enqueueMemoryAutomaticExplicitEquivalence } from "../../persistence/jobs";
import { memorySha256 } from "../../persistence/lexical";
import { loadMemoryReusableFactVersionIds } from "../../persistence/reusableFactAuthority";
import { createPrismaMemoryScopeRepository } from "../../persistence/scopes";
import { ensureActiveLexicalGeneration, withLockedMemoryTransaction } from "../../persistence/transaction";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "../../purge/contract";
import { registerMemoryDeletionContributors } from "../../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../../purge/registry";
import { defaultMemorySourceMutationHooks } from "../../sourceHooks";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../../sourceState";
import { MemorySuppressionKeyring } from "../../suppressionKeyring";
import { createPrismaMemoryExplicitRelationHandler } from "./explicitHandler";
import {
  MEMORY_AUTOMATIC_EXPLICIT_EQUIVALENCE_REASON,
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION,
  MEMORY_EXPLICIT_RELATION_V1_POLICY_VERSION,
  memoryEquivalenceTextKey,
  memoryExplicitRelationJobFingerprint
} from "./explicitPolicy";
import { createPrismaMemoryExplicitRelationRepository } from "./explicitRepository";
import {
  MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_VERSION,
  sweepMemoryExplicitEquivalenceOwner
} from "./explicitSweep";

// Synthetic owners and statements only. Automatic facts carry exact current
// direct-user message evidence; explicit saves go through the owner service.
const keyring = MemorySuppressionKeyring.parse(
  `current=test,test=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64")}`
);
const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
const owners = new Set<string>();
let providerAuthority: TestProviderExecutionAuthority;
let priorPolicy: { assignmentSource: import("@prisma/client").MemoryUtilityAssignmentSource;
  providerModelId: string | null;
  reasoningEffort: string | null;
  updatedAt: Date;
  version: number;
} | null;

beforeAll(async () => {
  providerAuthority = await createTestProviderExecutionAuthority(prisma, "automatic-equivalence");
  const model = await prisma.providerModel.findUniqueOrThrow({ where: { id: providerAuthority.providerModelId } });
  const config = model.activeConfig as Prisma.JsonObject;
  const capabilities = { ...(config.capabilities as Prisma.JsonObject), toolCalling: true };
  const adapterKind = "openai_responses_compatible";
  const updatedConfig = { ...config, adapterKind, capabilities } as Prisma.InputJsonObject;
  await prisma.providerModel.update({
    data: { activeConfig: updatedConfig, capabilities, draftConfig: updatedConfig }, where: { id: model.id }
  });
  await prisma.providerModelCredentialCheck.create({
    data: {
      checkedAt: new Date(), connectionId: providerAuthority.connectionId, connectionVersion: 1,
      credentialId: providerAuthority.credentialId, credentialVersionId: providerAuthority.credentialVersionId,
      evidence: {
        forcedToolCall: forcedToolCallVerificationEvidence(adapterKind, model.modelId),
        structuredOutput: structuredOutputVerificationEvidence(adapterKind, model.modelId)
      },
      modelVersion: 1, providerModelId: model.id, status: "available"
    }
  });
  priorPolicy = await prisma.memoryUtilityModelPolicy.findUnique({
    select: { assignmentSource: true, providerModelId: true, reasoningEffort: true, updatedAt: true, version: true },
    where: { id: "installation" }
  });
  await prisma.memoryUtilityModelPolicy.upsert({
    create: { id: "installation", providerModelId: model.id, assignmentSource: "OPERATOR" },
    update: { providerModelId: model.id, reasoningEffort: null, assignmentSource: "OPERATOR", version: { increment: 1 } },
    where: { id: "installation" }
  });
  await expect(createMemoryUtilityModelRoleResolver(prisma).resolve()).resolves.toMatchObject({ ok: true });
});

afterEach(async () => {
  for (const userId of owners) await prisma.$transaction(async (tx) => {
    await tx.memoryAuxiliarySemanticCall.deleteMany({ where: { userId } });
    await tx.memoryFactVersionRelation.deleteMany({ where: { userId } });
    await tx.memoryFactVersion.updateMany({
      data: { mergedIntoVersionId: null, state: "ORPHANED" }, where: { state: "MERGED", userId }
    });
    await tx.memoryFactVersion.updateMany({ data: { mergedIntoVersionId: null }, where: { userId, mergedIntoVersionId: { not: null } } });
    await tx.memoryFactVersion.updateMany({
      data: { movedFromVersionId: null, supersedesVersionId: null }, where: { userId }
    });
    await tx.memoryFact.updateMany({ data: { movedToFactId: null }, where: { userId } });
    await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });
  });
  owners.clear();
});

afterAll(async () => {
  if (priorPolicy) await prisma.memoryUtilityModelPolicy.update({ data: priorPolicy, where: { id: "installation" } });
  else if (providerAuthority) await prisma.memoryUtilityModelPolicy.deleteMany({
    where: { id: "installation", providerModelId: providerAuthority.providerModelId }
  });
  if (providerAuthority) {
    await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId: providerAuthority.connectionId } });
    await deleteTestProviderExecutionAuthority(prisma, providerAuthority);
  }
  await prisma.$disconnect();
});

function services() {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE", requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  const authorizationRepository = createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  return {
    registry,
    explicit: createExplicitMemoryService({
      authorizationRepository, factRepository: createPrismaMemoryFactRepository(keyring, prisma), readRepository,
      resolveEquivalentTarget: (userId, target, now) => resolveMemoryExplicitEquivalentTarget(prisma, userId, target, now),
      scopeRepository: createPrismaMemoryScopeRepository(prisma)
    }),
    lifecycle: createMemoryLifecycleService({
      authorizationRepository, mutationRepository: createPrismaMemoryLifecycleRepository(keyring, registry, prisma),
      readRepository
    })
  };
}

type Services = ReturnType<typeof services>;
type Target = Readonly<{ factId: string; versionId: string }>;

async function ownerFixture(settings: Readonly<{ learnAutomatically?: boolean }> = {}) {
  const userId = randomUUID();
  await prisma.user.create({ data: { displayName: "Equivalence fixture", email: `${userId}@example.test`, id: userId, status: "active" } });
  owners.add(userId);
  await prisma.userMemorySettings.update({
    data: { learnAutomatically: settings.learnAutomatically ?? true, referenceChatHistory: false, useMemoryFacts: true },
    where: { userId }
  });
  await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  await withLockedMemoryTransaction(prisma, userId, (tx, locked) =>
    ensureActiveLexicalGeneration(tx, locked, locked.memoryRevision));
  return { s: services(), userId };
}

async function save(s: Services, userId: string, statement: string): Promise<Target> {
  const authorization = await s.explicit.mintAuthorization(userId, {
    action: "SAVE", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement), requestNonce: randomUUID()
  });
  const created = await s.explicit.create(userId, {
    category: "about_you", mutationAuthorizationId: authorization.mutationAuthorizationId,
    scope: { type: "GLOBAL_USER" }, statement
  });
  return { factId: created.memory.id, versionId: created.memory.currentVersionId! };
}

/** A learned fact as current extraction writes it: exact evidence of one
 * direct user message and its lexical search entry. */
async function learned(userId: string, statement: string, message: string, options: Readonly<{
  dated?: boolean; pinned?: boolean;
}> = {}) {
  const source = await createMaintenanceMessage(userId, message);
  const fact = await createAutomaticMaintenanceFact(userId, [{
    ...(options.dated ? { dated: true } : {}), source, statement
  }], options.pinned ? { pinned: true } : {});
  await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    ensureClassifiedSearchEntry(tx, settings, fact.currentVersionId, `fixture-${fact.currentVersionId}`, new Date()));
  return { factId: fact.factId, source, versionId: fact.currentVersionId };
}

type Verdict = readonly ["EQUIVALENT" | "DISTINCT" | "UNCERTAIN", "HIGH" | "MEDIUM" | "LOW"];
/** A fake adjudicator: only an equal meaning, here an equal text key, is equivalent. */
const equalText = (source: string, candidate: string): Verdict =>
  memoryEquivalenceTextKey(source) === memoryEquivalenceTextKey(candidate) ? ["EQUIVALENT", "HIGH"] : ["DISTINCT", "HIGH"];

function handler(decide: (source: string, candidate: string) => Verdict = equalText) {
  const seen: string[] = [];
  const run = vi.fn<MemoryStructuredOutputProvider["run"]>().mockImplementation(async (_snapshot, request) => {
    const input = JSON.parse(request.userPrompt) as {
      candidates: Array<{ ref: string; statement: string }>; source: { statement: string };
    };
    seen.push(...input.candidates.map(({ statement }) => statement));
    return {
      output: { decisions: input.candidates.map(({ ref, statement }) => {
        const [relation, confidence] = decide(input.source.statement, statement);
        return { confidence_band: confidence, relation, target_ref: ref };
      }) },
      providerResponseId: null, usage: null
    };
  });
  return {
    context: { now: () => new Date(), setStage: async () => undefined, signal: new AbortController().signal },
    instance: createPrismaMemoryExplicitRelationHandler(prisma, { authority: {}, structuredProvider: { run } }),
    run, seen
  };
}

async function claim(userId: string, targetFactVersionId: string): Promise<MemoryJobClaim> {
  const queued = await prisma.memoryJob.findFirstOrThrow({ where: {
    kind: "RESOLVE_FACT_RELATIONS", state: "QUEUED", targetFactVersionId, userId
  } });
  const leaseToken = randomUUID();
  const row = await prisma.memoryJob.update({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt: new Date(Date.now() + 120_000), leaseToken, state: "CLAIMED" },
    where: { id: queued.id }
  });
  return { ...row, claimToken: leaseToken, kind: "RESOLVE_FACT_RELATIONS", leaseExpiresAt: row.leaseExpiresAt!, recoveredLease: false };
}

function commit(job: MemoryJobClaim, result: MemoryJobExecutionResult) {
  return coordinator.commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash, apply: result.apply, claim: job,
    now: new Date(), stage: result.stage ?? null
  });
}

async function settle(h: ReturnType<typeof handler>, userId: string, targetFactVersionId: string) {
  const job = await claim(userId, targetFactVersionId);
  await expect(h.instance.preflight(job)).resolves.toEqual({ status: "READY" });
  await expect(commit(job, await h.instance.execute(job, h.context))).resolves.toBe(true);
  return job;
}

async function relationJobs(userId: string) {
  return prisma.memoryJob.findMany({
    orderBy: { createdAt: "asc" },
    where: { kind: "RESOLVE_FACT_RELATIONS", pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, userId }
  });
}

async function activeFactIds(userId: string): Promise<string[]> {
  return (await prisma.memoryFact.findMany({ select: { id: true }, where: { state: "ACTIVE", userId } }))
    .map(({ id }) => id).sort();
}

function evidenceOf(userId: string, factVersionId: string) {
  return prisma.memoryEvidence.findMany({ orderBy: { id: "asc" }, where: { factVersionId, userId } });
}

async function expectMerged(userId: string, automatic: Target, canonical: Target) {
  await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: automatic.factId } })).resolves.toMatchObject({
    currentVersionId: null, movedToFactId: canonical.factId, pinned: false, state: "RETRACTED"
  });
  await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: automatic.versionId } })).resolves.toMatchObject({
    mergedIntoVersionId: canonical.versionId, sourceMode: "AUTOMATIC", state: "MERGED", systemTo: expect.any(Date)
  });
  await expect(prisma.memoryFactVersionRelation.findMany({
    select: { kind: true, pipelineVersion: true, reasonCode: true, targetVersionId: true },
    where: { sourceVersionId: automatic.versionId, userId }
  })).resolves.toEqual([{
    kind: "MERGED_INTO", pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
    reasonCode: MEMORY_AUTOMATIC_EXPLICIT_EQUIVALENCE_REASON, targetVersionId: canonical.versionId
  }]);
  await expect(prisma.memoryEvent.count({
    where: { actorType: "JOB", factId: automatic.factId, operation: "MERGE", userId }
  })).resolves.toBe(1);
  await expect(prisma.memorySearchEntry.count({ where: { factVersionId: automatic.versionId, userId } })).resolves.toBe(0);
  await expect(resolveMemoryExplicitEquivalentTarget(prisma, userId, {
    factId: automatic.factId, factVersionId: automatic.versionId
  })).resolves.toEqual({ factId: canonical.factId, factVersionId: canonical.versionId });
  expect(await loadMemoryReusableFactVersionIds(prisma, userId, [automatic.versionId, canonical.versionId]))
    .toEqual(new Set([canonical.versionId]));
}

async function forget(s: Services, userId: string, target: Target) {
  const authorization = await s.explicit.mintAuthorization(userId, {
    action: "FORGET", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    expectedTargetVersionId: target.versionId, requestNonce: randomUUID(), targetFactId: target.factId
  });
  return s.lifecycle.forget(userId, target.factId, {
    expectedVersionId: target.versionId, mutationAuthorizationId: authorization.mutationAuthorizationId
  });
}

async function purge(registry: MemoryDeletionContributorRegistry, userId: string, deletionId: string, now: Date) {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const changed = await prisma.memoryDeletionOutbox.updateMany({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken, nextAttemptAt: null, state: "RUNNING" },
    where: { id: deletionId, state: "PENDING", userId }
  });
  expect(changed.count).toBe(1);
  const row = await prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: deletionId } });
  const deletion: MemoryDeletionClaim = { ...row, claimToken, leaseExpiresAt, recoveredLease: false, resumedFromBlocked: false };
  const execution = await registry.handler().execute(deletion, { now: () => now, signal: new AbortController().signal });
  expect(await coordinator.commitDeletionSuccess({ apply: execution.apply, claim: deletion, now })).toBe(true);
}

/** The chat permanent deletion admission's own source mutation. */
async function deleteSourceChat(userId: string, chatId: string) {
  await prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("fixture_chat_missing");
    await applyMemorySourceMutations(tx, {
      chat, hooks: defaultMemorySourceMutationHooks, mutations: ["SOURCE_HARD_DELETE"],
      patch: { archived: true, memoryMode: "EXCLUDED" },
      sourceRequiresBranchGeneration: chat.activeLeafMessageId !== null
    });
  });
}

describe("automatic and explicit equivalence", () => {
  it("merges an earlier automatic fact into a later explicit save of the same fact", async () => {
    const { s, userId } = await ownerFixture();
    const automatic = await learned(userId, "My name is ada.", "hi my name is ada");
    const messageEvidence = await evidenceOf(userId, automatic.versionId);
    const saved = await save(s, userId, "My name is Ada.");
    const savedEvidence = await evidenceOf(userId, saved.versionId);
    expect((await relationJobs(userId)).map(({ targetFactVersionId }) => targetFactVersionId)).toEqual([saved.versionId]);
    const h = handler();
    await settle(h, userId, saved.versionId);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.seen).toEqual(["My name is ada."]);
    await expectMerged(userId, automatic, saved);
    expect(await activeFactIds(userId)).toEqual([saved.factId]);
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: saved.factId } })).resolves.toMatchObject({
      category: "about_you", currentVersionId: saved.versionId, pinned: false, state: "ACTIVE"
    });
    await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: saved.versionId } })).resolves.toMatchObject({
      displayText: "My name is Ada.", sourceMode: "EXPLICIT", state: "ACTIVE"
    });
    // Provenance is linked, never copied or relabelled.
    expect(await evidenceOf(userId, automatic.versionId)).toEqual(messageEvidence);
    expect(messageEvidence).toEqual([expect.objectContaining({
      chatId: automatic.source.chatId, messageId: automatic.source.messageId,
      sourceRole: "user", sourceType: "MESSAGE"
    })]);
    expect(await evidenceOf(userId, saved.versionId)).toEqual(savedEvidence);
    expect(savedEvidence.every(({ sourceType }) => sourceType === "EXPLICIT_ACTION")).toBe(true);
  });

  it("merges a later automatic fact into an earlier explicit save through its one equal-text check", async () => {
    const { s, userId } = await ownerFixture();
    const saved = await save(s, userId, "My name is Ada.");
    expect(await relationJobs(userId)).toEqual([]);
    const unrelated = await learned(userId, "I like green tea.", "i like green tea");
    const automatic = await learned(userId, "my name is ada", "my name is ada");
    const enqueue = (versionId: string) => withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
      enqueueMemoryAutomaticExplicitEquivalence(tx, settings, versionId));
    await expect(enqueue(unrelated.versionId)).resolves.toBe(false);
    await expect(enqueue(automatic.versionId)).resolves.toBe(true);
    await expect(enqueue(automatic.versionId)).resolves.toBe(false);
    expect((await relationJobs(userId)).map(({ targetFactVersionId }) => targetFactVersionId))
      .toEqual([automatic.versionId]);
    const h = handler();
    await settle(h, userId, automatic.versionId);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.seen).toContain("My name is Ada.");
    expect(h.seen).not.toContain("I like green tea.");
    await expectMerged(userId, automatic, saved);
    expect(await activeFactIds(userId)).toEqual([saved.factId, unrelated.factId].sort());
  });

  it("keeps a re-save on the survivor without another comparison", async () => {
    const { s, userId } = await ownerFixture();
    const automatic = await learned(userId, "My name is ada.", "hi my name is ada");
    const saved = await save(s, userId, "My name is Ada.");
    const h = handler();
    await settle(h, userId, saved.versionId);
    const before = (await evidenceOf(userId, saved.versionId)).length;
    await expect(save(s, userId, "My name is Ada.")).resolves.toEqual(saved);
    expect(await evidenceOf(userId, saved.versionId)).toHaveLength(before + 1);
    expect(await relationJobs(userId)).toHaveLength(1);
    expect(await activeFactIds(userId)).toEqual([saved.factId]);
    await expectMerged(userId, automatic, saved);
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("sweeps a pair that predates the triggers once and resumes a comparison an older worker cancelled", async () => {
    const { s, userId } = await ownerFixture();
    const saved = await save(s, userId, "My name is Ada.");
    const other = await save(s, userId, "I live in Riga.");
    const [cancelled] = await relationJobs(userId);
    expect(cancelled?.targetFactVersionId).toBe(other.versionId);
    await prisma.memoryJob.update({
      data: { completedAt: new Date(), errorCode: "memory_fact_relation_job_invalid", state: "CANCELLED" },
      where: { id: cancelled!.id }
    });
    // Written before this release: no check exists for either pair.
    const automatic = await learned(userId, "my name is ada", "hi my name is ada");
    const paraphrase = await learned(userId, "The user is called Ada.", "people call me ada");
    await expect(sweepMemoryExplicitEquivalenceOwner(prisma, userId)).resolves.toBe(2);
    await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: cancelled!.id } }))
      .resolves.toMatchObject({ errorCode: null, state: "QUEUED" });
    expect((await relationJobs(userId)).map(({ targetFactVersionId }) => targetFactVersionId).sort())
      .toEqual([other.versionId, automatic.versionId].sort());
    await expect(prisma.userMemorySettings.findUniqueOrThrow({
      select: { explicitEquivalenceSweepVersion: true }, where: { userId }
    })).resolves.toEqual({ explicitEquivalenceSweepVersion: MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_VERSION });
    await expect(sweepMemoryExplicitEquivalenceOwner(prisma, userId)).resolves.toBe(0);
    expect(await relationJobs(userId)).toHaveLength(2);
    const h = handler();
    await settle(h, userId, automatic.versionId);
    expect(h.run).toHaveBeenCalledOnce();
    await expectMerged(userId, automatic, saved);
    expect(await activeFactIds(userId)).toEqual([saved.factId, other.factId, paraphrase.factId].sort());
    await expect(sweepMemoryExplicitEquivalenceOwner(prisma, userId)).resolves.toBe(0);
  });

  it("does not sweep an owner with automatic learning off", async () => {
    const { s, userId } = await ownerFixture({ learnAutomatically: false });
    await save(s, userId, "My name is Ada.");
    await learned(userId, "my name is ada", "hi my name is ada");
    await expect(sweepMemoryExplicitEquivalenceOwner(prisma, userId)).resolves.toBe(0);
    expect(await relationJobs(userId)).toEqual([]);
    await expect(prisma.userMemorySettings.findUniqueOrThrow({
      select: { explicitEquivalenceSweepVersion: true }, where: { userId }
    })).resolves.toEqual({ explicitEquivalenceSweepVersion: null });
  });

  it("keeps different subjects, negation, other time and extra detail apart even when retrieved", async () => {
    const { s, userId } = await ownerFixture();
    const controls = [
      await learned(userId, "My sister's name is Ada.", "my sister's name is ada"),
      await learned(userId, "My name is not Ada.", "my name is not ada"),
      await learned(userId, "My name is Ada and I live in Riga.", "my name is ada and i live in riga"),
      // An equal statement grounded to another time: the verdict alone cannot merge it.
      await learned(userId, "My name is Ada.", "my name is ada", { dated: true })
    ];
    const saved = await save(s, userId, "My name is Ada.");
    const h = handler();
    await settle(h, userId, saved.versionId);
    expect(h.seen).toEqual(expect.arrayContaining([
      "My sister's name is Ada.", "My name is not Ada.", "My name is Ada and I live in Riga.", "My name is Ada."
    ]));
    expect(await activeFactIds(userId)).toEqual([saved.factId, ...controls.map(({ factId }) => factId)].sort());
    await expect(prisma.memoryFactVersionRelation.count({ where: { userId } })).resolves.toBe(0);
    await expect(prisma.memoryEvent.count({ where: { operation: "MERGE", userId } })).resolves.toBe(0);
  });

  it("never merges a pinned or owner-touched automatic fact", async () => {
    const { s, userId } = await ownerFixture();
    const pinned = await learned(userId, "My name is ada.", "hi my name is ada", { pinned: true });
    const pinnedSave = await save(s, userId, "My name is Ada.");
    // Only a protected automatic fact shares the scope: nothing is scheduled.
    expect(await relationJobs(userId)).toEqual([]);
    const touched = await learned(userId, "I work as a potter.", "i work as a potter");
    await prisma.memoryEvent.create({ data: {
      actorType: "USER", actorUserId: userId, factId: touched.factId, factVersionId: touched.versionId,
      operation: "USER_FEEDBACK", userId
    } });
    const touchedSave = await save(s, userId, "I work as a potter.");
    const h = handler();
    await settle(h, userId, touchedSave.versionId);
    expect(h.seen).toEqual(["My name is Ada."]);
    const enqueue = (versionId: string) => withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
      enqueueMemoryAutomaticExplicitEquivalence(tx, settings, versionId));
    await expect(enqueue(pinned.versionId)).resolves.toBe(false);
    await expect(enqueue(touched.versionId)).resolves.toBe(false);
    await expect(sweepMemoryExplicitEquivalenceOwner(prisma, userId)).resolves.toBe(0);
    expect(await activeFactIds(userId)).toEqual(
      [pinned.factId, pinnedSave.factId, touched.factId, touchedSave.factId].sort()
    );
    await expect(prisma.memoryFactVersionRelation.count({ where: { userId } })).resolves.toBe(0);
  });

  it("drops the deleted chat's support while the explicit survivor keeps its own authority", async () => {
    const { s, userId } = await ownerFixture();
    const automatic = await learned(userId, "My name is ada.", "hi my name is ada");
    const saved = await save(s, userId, "My name is Ada.");
    await settle(handler(), userId, saved.versionId);
    const savedEvidence = await evidenceOf(userId, saved.versionId);
    await deleteSourceChat(userId, automatic.source.chatId);
    await expect(evidenceOf(userId, automatic.versionId)).resolves.toEqual([]);
    await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: automatic.versionId } })).resolves.toMatchObject({
      mergedIntoVersionId: saved.versionId, state: "RETRACTED"
    });
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, userId, {
      factId: automatic.factId, factVersionId: automatic.versionId
    })).resolves.toBeNull();
    expect(await activeFactIds(userId)).toEqual([saved.factId]);
    expect(await evidenceOf(userId, saved.versionId)).toEqual(savedEvidence);
    expect(await loadMemoryReusableFactVersionIds(prisma, userId, [saved.versionId])).toEqual(new Set([saved.versionId]));
    // Forget still fences and purges the retracted merged lineage.
    const forgotten = await forget(s, userId, saved);
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: automatic.factId } }))
      .resolves.toMatchObject({ state: "FORGOTTEN" });
    await purge(s.registry, userId, forgotten.undo.deletionId, new Date(Date.parse(forgotten.undo.expiresAt) + 1_000));
    await expect(prisma.memoryFactVersion.count({ where: { displayText: { not: null }, userId } })).resolves.toBe(0);
  });

  it("forgets and purges the merged automatic lineage with the survivor and never revives it", async () => {
    const { s, userId } = await ownerFixture();
    const automatic = await learned(userId, "My name is ada.", "hi my name is ada");
    const saved = await save(s, userId, "My name is Ada.");
    await settle(handler(), userId, saved.versionId);
    const forgotten = await forget(s, userId, saved);
    for (const factId of [saved.factId, automatic.factId]) {
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
    }
    await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: automatic.versionId } }))
      .resolves.toMatchObject({ state: "FORGOTTEN" });
    await expect(prisma.memorySuppression.count({
      where: { scope: "SOURCE_MESSAGE", sourceMessageId: automatic.source.messageId, userId }
    })).resolves.toBe(1);
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, userId, {
      factId: automatic.factId, factVersionId: automatic.versionId
    })).resolves.toBeNull();
    await purge(s.registry, userId, forgotten.undo.deletionId, new Date(Date.parse(forgotten.undo.expiresAt) + 1_000));
    await expect(prisma.memoryFactVersion.count({ where: { displayText: { not: null }, userId } })).resolves.toBe(0);
    await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(0);
    // Background work finds nothing to bring back.
    await withLockedMemoryTransaction(prisma, userId, async (tx, settings) => {
      await expect(enqueueMemoryAutomaticExplicitEquivalence(tx, settings, automatic.versionId)).resolves.toBe(false);
      await ensureClassifiedSearchEntry(tx, settings, automatic.versionId, "fixture-replay", new Date());
    });
    await expect(sweepMemoryExplicitEquivalenceOwner(prisma, userId)).resolves.toBe(0);
    await expect(prisma.memorySearchEntry.count({ where: { userId } })).resolves.toBe(0);
    expect(await activeFactIds(userId)).toEqual([]);
  });

  it("does not extend the equivalence to a later edit of the survivor", async () => {
    const { s, userId } = await ownerFixture();
    const automatic = await learned(userId, "My name is ada.", "hi my name is ada");
    const saved = await save(s, userId, "My name is Ada.");
    await settle(handler(), userId, saved.versionId);
    const authorization = await s.explicit.mintAuthorization(userId, {
      action: "EDIT", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedTargetVersionId: saved.versionId, requestNonce: randomUUID(), targetFactId: saved.factId
    });
    const edited = await s.explicit.update(userId, saved.factId, {
      expectedVersionId: saved.versionId, mutationAuthorizationId: authorization.mutationAuthorizationId,
      statement: "My name is Ada Lovelace."
    });
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, userId, {
      factId: automatic.factId, factVersionId: automatic.versionId
    })).resolves.toBeNull();
    await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: automatic.versionId } }))
      .resolves.toMatchObject({ state: "MERGED" });
    expect(await activeFactIds(userId)).toEqual([saved.factId]);
    // The merged history still belongs to the edited fact's lineage.
    await forget(s, userId, { factId: saved.factId, versionId: edited.memory.currentVersionId! });
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: automatic.factId } }))
      .resolves.toMatchObject({ state: "FORGOTTEN" });
  });

  it("applies a retained decision once after a failed commit without another provider call", async () => {
    const { s, userId } = await ownerFixture();
    const automatic = await learned(userId, "My name is ada.", "hi my name is ada");
    const saved = await save(s, userId, "My name is Ada.");
    const h = handler();
    const job = await claim(userId, saved.versionId);
    const result = await h.instance.execute(job, h.context);
    await expect(commit(job, { ...result, apply: async (tx, claimed) => {
      await result.apply!(tx, claimed);
      throw new Error("fixture_commit_abort");
    } })).rejects.toThrow();
    expect(await activeFactIds(userId)).toEqual([saved.factId, automatic.factId].sort());
    await expect(prisma.memoryFactVersionRelation.count({ where: { userId } })).resolves.toBe(0);
    await expect(commit(job, await h.instance.execute(job, h.context))).resolves.toBe(true);
    expect(h.run).toHaveBeenCalledOnce();
    await expectMerged(userId, automatic, saved);
    const repository = createPrismaMemoryExplicitRelationRepository(prisma, {});
    const retained = await repository.loadResult(job);
    expect(retained).not.toBeNull();
    await expect(prisma.$transaction((tx) => repository.apply(tx, job, retained!, new Date()))).rejects.toThrow();
    await expect(prisma.memoryFactVersionRelation.count({ where: { userId } })).resolves.toBe(1);
  });

  it("still completes a queued explicit-only v1 comparison without automatic candidates", async () => {
    const { s, userId } = await ownerFixture();
    const first = await save(s, userId, "I teach pottery.");
    await prisma.memoryFact.update({ data: { createdAt: new Date(Date.now() - 60_000) }, where: { id: first.factId } });
    await learned(userId, "I teach pottery classes.", "i teach pottery classes");
    const second = await save(s, userId, "Doy clases de cerámica.");
    await prisma.memoryJob.deleteMany({ where: { kind: "RESOLVE_FACT_RELATIONS", userId } });
    await withLockedMemoryTransaction(prisma, userId, (tx, settings) => tx.memoryJob.create({ data: {
      idempotencyFingerprint: memoryExplicitRelationJobFingerprint(second.versionId, MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION),
      kind: "RESOLVE_FACT_RELATIONS", memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision, pipelineVersion: MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION,
      targetFactVersionId: second.versionId, userId
    } }));
    const h = handler(() => ["EQUIVALENT", "HIGH"]);
    await settle(h, userId, second.versionId);
    expect(h.seen).toEqual(["I teach pottery."]);
    await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: second.versionId } })).resolves.toMatchObject({
      mergedIntoVersionId: first.versionId, relationResolutionVersion: MEMORY_EXPLICIT_RELATION_V1_POLICY_VERSION,
      state: "MERGED"
    });
    await expect(prisma.memoryFactVersionRelation.findMany({
      select: { pipelineVersion: true, reasonCode: true }, where: { userId }
    })).resolves.toEqual([{ pipelineVersion: MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION, reasonCode: "explicit_semantic_equivalence" }]);
    await expect(prisma.memoryExecutionBinding.findMany({ select: { pipelineVersion: true }, where: { userId } }))
      .resolves.toEqual([{ pipelineVersion: MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION }]);
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, userId, {
      factId: second.factId, factVersionId: second.versionId
    })).resolves.toEqual({ factId: first.factId, factVersionId: first.versionId });
  });
});
