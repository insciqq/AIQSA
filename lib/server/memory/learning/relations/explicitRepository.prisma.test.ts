import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../../contracts/memory";
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
import {
  createPrismaMemoryExecutionService,
  type MemoryStructuredOutputProvider
} from "../../execution";
import { createPrismaMemoryFactRepository, type MemoryFactSaveInput, type MemoryFactValueInput } from "../../persistence/facts";
import { resolveMemoryExplicitEquivalentTarget } from "../../persistence/explicitEquivalence";
import { createPrismaMemoryMutationAuthorizationRepository } from "../../persistence/authorizations";
import { createPrismaExplicitMemoryRepository } from "../../explicit/repository";
import { createExplicitMemoryService } from "../../explicit/service";
import { createPrismaMemoryLifecycleRepository } from "../../lifecycle/repository";
import { createMemoryLifecycleService } from "../../lifecycle/service";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "../../purge/contract";
import { registerMemoryDeletionContributors } from "../../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../../purge/registry";
import { enqueueMemoryJob } from "../../persistence/jobs";
import { memorySha256 } from "../../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../../persistence/scopes";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import { MemorySuppressionKeyring } from "../../suppressionKeyring";
import { createPrismaMemoryExplicitRelationAuxiliaryStore } from "./explicitAuxiliary";
import { createPrismaMemoryExplicitRelationHandler } from "./explicitHandler";
import { MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, memoryExplicitRelationJobFingerprint } from "./explicitPolicy";
import { createPrismaMemoryExplicitRelationRepository } from "./explicitRepository";
import { MEMORY_EXPLICIT_RELATION_VERSIONS, memoryExplicitRelationInputHash } from "./explicitResolver";
import { loadMemoryExplicitRelationSnapshot } from "./explicitSnapshot";

const keyring = MemorySuppressionKeyring.parse(
  `current=test,test=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64")}`
);
// Only fixture creation substitutes the already-tested user confirmation
// boundary. Relation dispatch, settlement, owner fences and commit are native.
const facts = createPrismaMemoryFactRepository(keyring, prisma, {
  consumeExplicitAuthorization: async () => undefined
});
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
  providerAuthority = await createTestProviderExecutionAuthority(prisma, "explicit-relation");
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

function value(statement: string): MemoryFactValueInput {
  return {
    canonicalKey: `custom.${memorySha256(statement)}`, category: "profile", confidence: 1, directness: "DIRECT",
    displayText: statement, importance: 0.8, languageCode: "und", modality: "STATE",
    pipelineVersion: "memory-explicit-native-fixture-v1", secretTaintedSourceWindow: false,
    sensitivityClass: "NORMAL", sourceMode: "EXPLICIT", structuredValue: { value: statement }
  };
}

function evidence(statement: string) {
  return {
    kind: "EXPLICIT_ACTION" as const, observedAt: new Date(), safeExcerpt: statement,
    safeSourceHash: memorySha256(statement), safetyClass: "NORMAL" as const,
    sourceProjectionVersion: "memory-explicit-native-fixture-v1"
  };
}

function queueExplicitRelation(userId: string, targetFactVersionId: string) {
  return withLockedMemoryTransaction(prisma, userId, (tx, settings) => enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryExplicitRelationJobFingerprint(targetFactVersionId), kind: "RESOLVE_FACT_RELATIONS",
    pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, targetFactVersionId
  }));
}

async function ownerFixture() {
  const userId = randomUUID();
  await prisma.user.create({ data: { displayName: "Explicit relation fixture", email: `${userId}@example.test`, id: userId, status: "active" } });
  owners.add(userId);
  await prisma.userMemorySettings.update({
    data: { learnAutomatically: false, useMemoryFacts: true, referenceChatHistory: false }, where: { userId }
  });
  const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  const inputs: MemoryFactSaveInput[] = [];
  async function save(statement: string) {
    const id = randomUUID();
    const input: MemoryFactSaveInput = {
      authorization: { action: "SAVE", authorizationId: id, authorizedPayloadHash: memorySha256(id) },
      evidence: evidence(statement), explicitSuppressionOverride: false, idempotencyFingerprint: id,
      requestId: id, scopeId: scope.id, value: value(statement)
    };
    inputs.push(input);
    return facts.save(userId, input);
  }
  return { inputs, save, scopeId: scope.id, userId };
}

async function fixture() {
  const { inputs, save, scopeId, userId } = await ownerFixture();
  const first = await save("私は陶芸を教えています。");
  await prisma.memoryFact.update({ data: { createdAt: new Date(Date.now() - 60_000) }, where: { id: first.factId } });
  const second = await save("Doy clases de cerámica.");
  const queued = await queueExplicitRelation(userId, second.versionId);
  const lease = randomUUID();
  const row = await prisma.memoryJob.update({
    data: { attemptCount: 1, leaseExpiresAt: new Date(Date.now() + 120_000), leaseToken: lease, state: "CLAIMED" },
    where: { id: queued.id }
  });
  const job: MemoryJobClaim = {
    ...row, claimToken: lease, kind: "RESOLVE_FACT_RELATIONS", leaseExpiresAt: row.leaseExpiresAt!, recoveredLease: false
  };
  return { first, inputs, job, save, scopeId, second, userId };
}

function handler(relation = "EQUIVALENT", confidence = "HIGH") {
  const run = vi.fn<MemoryStructuredOutputProvider["run"]>().mockImplementation(async (_snapshot, request) => {
    const input = JSON.parse(request.userPrompt) as { candidates: Array<{ ref: string }> };
    return {
      output: { decisions: input.candidates.map(({ ref }) => ({
        confidence_band: confidence, relation, target_ref: ref
      })) },
      providerResponseId: null, usage: null
    };
  });
  return {
    context: { now: () => new Date(), setStage: async () => undefined, signal: new AbortController().signal },
    instance: createPrismaMemoryExplicitRelationHandler(prisma, { authority: {}, structuredProvider: { run } }), run
  };
}

function commit(job: MemoryJobClaim, result: MemoryJobExecutionResult) {
  return coordinator.commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash, apply: result.apply, claim: job,
    now: new Date(), stage: result.stage ?? null
  });
}

function lifecycleServices() {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE", requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  const authorizationRepository = createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  return {
    registry,
    explicit: createExplicitMemoryService({
      authorizationRepository, factRepository: createPrismaMemoryFactRepository(keyring, prisma),
      readRepository, scopeRepository: createPrismaMemoryScopeRepository(prisma)
    }),
    lifecycle: createMemoryLifecycleService({
      authorizationRepository, mutationRepository: createPrismaMemoryLifecycleRepository(keyring, registry, prisma),
      readRepository
    })
  };
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
  const claim: MemoryDeletionClaim = { ...row, claimToken, leaseExpiresAt, recoveredLease: false, resumedFromBlocked: false };
  const execution = await registry.handler().execute(claim, { now: () => now, signal: new AbortController().signal });
  expect(await coordinator.commitDeletionSuccess({ apply: execution.apply, claim, now })).toBe(true);
}

describe("native explicit relation persistence", () => {
  it("schedules normal explicit writes once per new version without synchronous execution", async () => {
    const f = await ownerFixture();
    const s = lifecycleServices();
    async function save(statement: string) {
      const authorization = await s.explicit.mintAuthorization(f.userId, {
        action: "SAVE", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactStatementHash: memorySha256(statement), requestNonce: randomUUID()
      });
      const input = { mutationAuthorizationId: authorization.mutationAuthorizationId, scope: { type: "GLOBAL_USER" as const }, statement };
      return { input, result: await s.explicit.create(f.userId, input) };
    }
    await save("私は陶芸を教えています。");
    expect(await prisma.memoryJob.count({ where: { userId: f.userId } })).toBe(0);
    const second = await save("Doy clases de cerámica.");
    const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId } });
    expect(job).toMatchObject({
      activeLeafMessageId: null, branchGeneration: null, chatId: null, kind: "RESOLVE_FACT_RELATIONS",
      pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, sourceHash: null, sourceMessageId: null,
      sourceRevision: null, state: "QUEUED", targetFactVersionId: second.result.memory.currentVersionId
    });
    await s.explicit.create(f.userId, second.input);
    await save(second.input.statement);
    expect(await prisma.memoryJob.findMany({ where: { userId: f.userId } })).toEqual([job]);
    const authorization = await s.explicit.mintAuthorization(f.userId, {
      action: "EDIT", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedTargetVersionId: second.result.memory.currentVersionId!, requestNonce: randomUUID(), targetFactId: second.result.memory.id
    });
    const changed = await s.explicit.update(f.userId, second.result.memory.id, {
      expectedVersionId: second.result.memory.currentVersionId!, mutationAuthorizationId: authorization.mutationAuthorizationId,
      statement: "Je fabrique des bols en céramique."
    });
    expect(await prisma.memoryJob.count({ where: { userId: f.userId } })).toBe(2);
    expect(await prisma.memoryJob.count({ where: { targetFactVersionId: changed.memory.currentVersionId!, userId: f.userId } })).toBe(1);
    expect(await prisma.memoryExecutionBinding.count({ where: { userId: f.userId } })).toBe(0);
  });

  it("consolidates normal API saves through the queued background comparison", async () => {
    const f = await ownerFixture();
    const s = lifecycleServices();
    for (const statement of ["私は陶芸を教えています。", "Doy clases de cerámica."]) {
      const authorization = await s.explicit.mintAuthorization(f.userId, {
        action: "SAVE", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactStatementHash: memorySha256(statement), requestNonce: randomUUID()
      });
      await s.explicit.create(f.userId, {
        mutationAuthorizationId: authorization.mutationAuthorizationId, scope: { type: "GLOBAL_USER" }, statement
      });
    }
    const now = new Date();
    const claimed = await coordinator.claimJob({
      claimToken: randomUUID(), kinds: ["RESOLVE_FACT_RELATIONS"], leaseExpiresAt: new Date(now.getTime() + 120_000), now
    });
    expect(claimed?.userId).toBe(f.userId);
    const h = handler();
    await expect(h.instance.preflight(claimed!)).resolves.toEqual({ status: "READY" });
    await expect(commit(claimed!, await h.instance.execute(claimed!, h.context))).resolves.toBe(true);
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(1);
    expect(h.run).toHaveBeenCalledOnce();
    expect(await prisma.memoryJob.count({ where: { state: "SUCCEEDED", userId: f.userId } })).toBe(1);
  });

  it("keeps explicit saves available while paused without scheduling semantic work", async () => {
    const f = await ownerFixture();
    await prisma.userMemorySettings.update({ data: { useMemoryFacts: false }, where: { userId: f.userId } });
    const s = lifecycleServices();
    for (const statement of ["私は陶芸を教えています。", "Doy clases de cerámica."]) {
      const authorization = await s.explicit.mintAuthorization(f.userId, {
        action: "SAVE", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactStatementHash: memorySha256(statement), requestNonce: randomUUID()
      });
      await s.explicit.create(f.userId, {
        mutationAuthorizationId: authorization.mutationAuthorizationId, scope: { type: "GLOBAL_USER" }, statement
      });
    }
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(2);
    expect(await prisma.memoryJob.count({ where: { userId: f.userId } })).toBe(0);
    expect(await prisma.memoryExecutionBinding.count({ where: { userId: f.userId } })).toBe(0);
  });

  it("restores one canonical memory on Undo and purges its aliases on a later Forget", async () => {
    const f = await fixture();
    const h = handler();
    await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
    const s = lifecycleServices();
    async function forget(versionId: string) {
      const authorization = await s.explicit.mintAuthorization(f.userId, {
        action: "FORGET", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId, requestNonce: randomUUID(), targetFactId: f.first.factId
      });
      return s.lifecycle.forget(f.userId, f.first.factId, {
        expectedVersionId: versionId, mutationAuthorizationId: authorization.mutationAuthorizationId
      });
    }
    const forgotten = await forget(f.first.versionId);
    const authorization = await s.explicit.mintAuthorization(f.userId, {
      action: "SAVE", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      exactStatementHash: memorySha256(f.inputs[0].value.displayText), requestNonce: randomUUID()
    });
    const restored = await s.explicit.undoForget(f.userId, f.first.factId, {
      deletionId: forgotten.undo.deletionId, mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    expect(restored.memory).toMatchObject({
      displayText: f.inputs[0].value.displayText, factState: "ACTIVE", id: f.first.factId
    });
    expect(restored.memory.currentVersionId).not.toBe(f.first.versionId);
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(1);
    await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: forgotten.undo.deletionId } })).resolves.toMatchObject({
      errorCode: "memory_purge_cancelled_by_undo", state: "CANCELLED"
    });
    // Ordinary Undo creates a new version; old operation-bound refs stay stale.
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, f.userId, {
      factId: f.second.factId, factVersionId: f.second.versionId
    })).resolves.toBeNull();
    const later = await forget(restored.memory.currentVersionId!);
    await purge(s.registry, f.userId, later.undo.deletionId, new Date(Date.parse(later.undo.expiresAt) + 1_000));
    expect(await prisma.memoryFactVersion.count({ where: { displayText: { not: null }, userId: f.userId } })).toBe(0);
    expect(await prisma.memoryEvidence.count({ where: { userId: f.userId } })).toBe(0);
  });

  it("resolves and forgets a multi-hop accepted equivalence chain", async () => {
    const f = await fixture();
    const h = handler();
    const firstResult = await h.instance.execute(f.job, h.context);
    const oldest = await f.save("J’enseigne la poterie.");
    const first = await prisma.memoryFact.findUniqueOrThrow({ where: { id: f.first.factId } });
    // An older fact enters candidate visibility after the first comparison.
    await prisma.memoryFact.update({ data: { createdAt: new Date(first.createdAt.getTime() - 1_000) }, where: { id: oldest.factId } });
    await expect(commit(f.job, firstResult)).resolves.toBe(true);
    const queued = await queueExplicitRelation(f.userId, oldest.versionId);
    const now = new Date();
    const claimed = await coordinator.claimJob({
      claimToken: randomUUID(), kinds: ["RESOLVE_FACT_RELATIONS"], leaseExpiresAt: new Date(now.getTime() + 120_000), now
    });
    expect(claimed?.id).toBe(queued.id);
    await expect(commit(claimed!, await h.instance.execute(claimed!, h.context))).resolves.toBe(true);
    for (const source of [f.first, f.second]) {
      await expect(resolveMemoryExplicitEquivalentTarget(prisma, f.userId, {
        factId: source.factId, factVersionId: source.versionId
      })).resolves.toEqual({ factId: oldest.factId, factVersionId: oldest.versionId });
    }
    expect(await prisma.memoryEvidence.count({ where: { factVersionId: oldest.versionId, userId: f.userId } })).toBe(3);
    const s = lifecycleServices();
    const authorization = await s.explicit.mintAuthorization(f.userId, {
      action: "FORGET", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedTargetVersionId: oldest.versionId, requestNonce: randomUUID(), targetFactId: oldest.factId
    });
    const forgotten = await s.lifecycle.forget(f.userId, oldest.factId, {
      expectedVersionId: oldest.versionId, mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    expect(await prisma.memoryFact.count({ where: { state: "FORGOTTEN", userId: f.userId } })).toBe(3);
    await purge(s.registry, f.userId, forgotten.undo.deletionId, new Date(Date.parse(forgotten.undo.expiresAt) + 1_000));
    expect(await prisma.memoryFactVersion.count({ where: { displayText: { not: null }, userId: f.userId } })).toBe(0);
    expect(await prisma.memoryEvidence.count({ where: { userId: f.userId } })).toBe(0);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("serializes explicit comparisons while concurrent saves preserve every independent support", async () => {
    const f = await fixture();
    const h = handler();
    const firstResult = await h.instance.execute(f.job, h.context);
    const saved = await Promise.all([f.save("J’enseigne la poterie."), f.save("أدرّس صناعة الفخار.")]);
    const queued = await Promise.all(saved.map(({ versionId }) => queueExplicitRelation(f.userId, versionId)));
    const claim = () => {
      const now = new Date();
      return coordinator.claimJob({
        claimToken: randomUUID(), kinds: ["RESOLVE_FACT_RELATIONS"], leaseExpiresAt: new Date(now.getTime() + 120_000), now
      });
    };
    await expect(Promise.all([claim(), claim()])).resolves.toEqual([null, null]);
    await expect(commit(f.job, firstResult)).resolves.toBe(true);
    const attempts = await Promise.all([claim(), claim()]);
    const claimed = attempts.filter((item): item is MemoryJobClaim => item !== null);
    expect(claimed).toHaveLength(1);
    expect(queued.map(({ id }) => id)).toContain(claimed[0].id);
    await expect(commit(claimed[0], await h.instance.execute(claimed[0], h.context))).resolves.toBe(true);
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(1);
    expect(await prisma.memoryEvidence.count({ where: { factVersionId: f.first.versionId, userId: f.userId } })).toBe(4);
    expect(h.run).toHaveBeenCalledTimes(2);
    const redundant = await claim();
    expect(redundant).not.toBeNull();
    await expect(h.instance.preflight(redundant!)).resolves.toMatchObject({ status: "CANCELLED" });
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("keeps other owners and job kinds independent and recovers an expired comparison lease", async () => {
    const busy = await fixture();
    const expired = await fixture();
    const now = new Date();
    await prisma.memoryJob.update({
      data: { leaseExpiresAt: new Date(now.getTime() - 1) }, where: { id: expired.job.id }
    });
    const claim = await coordinator.claimJob({
      claimToken: randomUUID(), kinds: ["RESOLVE_FACT_RELATIONS"], leaseExpiresAt: new Date(now.getTime() + 120_000), now
    });
    expect(claim).toMatchObject({ id: expired.job.id, recoveredLease: true, userId: expired.userId });
    const other = await withLockedMemoryTransaction(prisma, busy.userId, (tx, settings) => enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memorySha256(randomUUID()), kind: "RECLASSIFY_FACTS", pipelineVersion: "memory-coordinator-preflight-v1"
    }));
    await expect(coordinator.claimJob({
      claimToken: randomUUID(), kinds: ["RECLASSIFY_FACTS"], leaseExpiresAt: new Date(now.getTime() + 120_000), now
    })).resolves.toMatchObject({ id: other.id, userId: busy.userId });
    await expect(coordinator.claimJob({
      claimToken: randomUUID(), kinds: ["RESOLVE_FACT_RELATIONS"], leaseExpiresAt: new Date(now.getTime() + 120_000), now
    })).resolves.toBeNull();
  });

  it("forgets the complete explicit equivalence lineage", async () => {
    const f = await fixture();
    const h = handler();
    await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
    const s = lifecycleServices();
    const authorization = await s.explicit.mintAuthorization(f.userId, {
      action: "FORGET", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedTargetVersionId: f.first.versionId, requestNonce: randomUUID(), targetFactId: f.first.factId
    });
    const forgotten = await s.lifecycle.forget(f.userId, f.first.factId, {
      expectedVersionId: f.first.versionId, mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    expect.soft(await prisma.memoryFact.count({ where: { state: "FORGOTTEN", userId: f.userId } })).toBe(2);
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, f.userId, {
      factId: f.second.factId, factVersionId: f.second.versionId
    })).resolves.toBeNull();
    await purge(s.registry, f.userId, forgotten.undo.deletionId, new Date(Date.parse(forgotten.undo.expiresAt) + 1_000));
    expect.soft(await prisma.memoryFactVersion.count({ where: { displayText: { not: null }, userId: f.userId } })).toBe(0);
    expect.soft(await prisma.memoryEvidence.count({ where: { userId: f.userId } })).toBe(0);
  });

  it("resets accepted explicit recovery without deleting post-barrier memory", async () => {
    const f = await fixture();
    const h = handler();
    await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
    const s = lifecycleServices();
    const before = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: f.userId } });
    const authorization = await s.explicit.mintAuthorization(f.userId, {
      action: "BULK_DELETE", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      expectedMemoryRevision: before.memoryRevision, expectedSettingsRevision: before.settingsRevision,
      operation: "DELETE_ALL_REUSABLE", requestNonce: randomUUID()
    });
    const deletion = await s.lifecycle.deleteExplicit(f.userId, {
      expectedMemoryRevision: before.memoryRevision, expectedSettingsRevision: before.settingsRevision,
      mutationAuthorizationId: authorization.mutationAuthorizationId, operation: "DELETE_ALL_REUSABLE"
    });
    const statement = "أتعلم العزف على العود.";
    const freshAuthorization = await s.explicit.mintAuthorization(f.userId, {
      action: "SAVE", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      exactStatementHash: memorySha256(statement), requestNonce: randomUUID()
    });
    const fresh = await s.explicit.create(f.userId, {
      mutationAuthorizationId: freshAuthorization.mutationAuthorizationId, scope: { type: "GLOBAL_USER" }, statement
    });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId } });
    expect(usage).toHaveLength(1);
    await purge(s.registry, f.userId, deletion.deletionId, new Date(Date.now() + 1_000));
    expect(await prisma.memoryAuxiliarySemanticCall.count({ where: { userId: f.userId } })).toBe(0);
    expect(await prisma.memoryFact.count({ where: { id: { in: [f.first.factId, f.second.factId] }, userId: f.userId } })).toBe(0);
    await expect(prisma.memoryFactVersion.findUnique({ where: { id: fresh.memory.currentVersionId! } })).resolves.toMatchObject({
      displayText: statement, state: "ACTIVE"
    });
    await expect(prisma.usageEvent.findMany({ where: { userId: f.userId } })).resolves.toEqual([
      { ...usage[0], memoryExecutionBindingId: null, providerModelId: null }
    ]);
  });

  it("keeps old references and exact repeats on the accepted canonical version with immutable replay", async () => {
    const f = await fixture();
    const originalReceipt = await prisma.memoryOperationReceipt.findUniqueOrThrow({ where: {
      userId_idempotencyFingerprint: { userId: f.userId, idempotencyFingerprint: f.inputs[1].idempotencyFingerprint }
    } });
    const h = handler();
    await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
    const alias = { factId: f.second.factId, factVersionId: f.second.versionId };
    const canonical = { factId: f.first.factId, factVersionId: f.first.versionId };
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, f.userId, alias)).resolves.toEqual(canonical);
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, randomUUID(), alias)).resolves.toBeNull();
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, f.userId, { ...alias, factVersionId: f.first.versionId })).resolves.toBeNull();
    await expect(f.save(f.inputs[1].value.displayText)).resolves.toMatchObject({
      factId: f.first.factId, versionId: f.first.versionId, outcome: "REINFORCED", replayed: false
    });
    await expect(facts.save(f.userId, f.inputs[1])).resolves.toEqual({ ...f.second, replayed: true });
    expect(await prisma.memoryOperationReceipt.findUniqueOrThrow({ where: { id: originalReceipt.id } })).toEqual(originalReceipt);
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(1);
    expect(await prisma.memoryEvidence.count({ where: { factVersionId: f.first.versionId, userId: f.userId } })).toBe(3);
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("invalidates an old equivalent reference when the canonical meaning changes", async () => {
    const f = await fixture();
    const h = handler();
    await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
    const alias = { factId: f.second.factId, factVersionId: f.second.versionId };
    const id = randomUUID();
    const statement = "Je donne des cours de gravure.";
    await facts.edit(f.userId, {
      authorization: { action: "EDIT", authorizationId: id, authorizedPayloadHash: memorySha256(id),
        expectedTargetVersionId: f.first.versionId, targetFactId: f.first.factId },
      evidence: evidence(statement), expectedVersionId: f.first.versionId, explicitSuppressionOverride: false,
      factId: f.first.factId, idempotencyFingerprint: id, requestId: id, scopeId: f.scopeId,
      value: { ...value(statement), canonicalKey: f.inputs[0].value.canonicalKey }
    });
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, f.userId, alias)).resolves.toBeNull();
    await expect(f.save(f.inputs[1].value.displayText)).rejects.toMatchObject({ code: "memory_fact_identity_conflict" });
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(1);
  });

  it("does not treat a move pointer without its accepted equivalence relation as authority", async () => {
    const f = await fixture();
    const h = handler();
    await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
    await prisma.memoryFactVersionRelation.deleteMany({ where: { userId: f.userId } });
    await expect(resolveMemoryExplicitEquivalentTarget(prisma, f.userId, {
      factId: f.second.factId, factVersionId: f.second.versionId
    })).resolves.toBeNull();
    await expect(f.save(f.inputs[1].value.displayText)).rejects.toMatchObject({ code: "memory_fact_identity_conflict" });
  });

  it("recovers the accepted decision once, preserving independent sources and pins on the oldest fact", async () => {
    const f = await fixture();
    await prisma.memoryFact.update({ data: { pinned: true }, where: { id: f.second.factId } });
    const h = handler();
    await expect(h.instance.preflight(f.job)).resolves.toEqual({ status: "READY" });
    const firstResult = await h.instance.execute(f.job, h.context);
    expect(firstResult.apply).toBeTypeOf("function");
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(2);
    const recovered = await h.instance.execute(f.job, h.context);
    expect(h.run).toHaveBeenCalledOnce();
    await expect(commit(f.job, recovered)).resolves.toBe(true);
    await expect(prisma.memoryFact.findUnique({ where: { id: f.first.factId } })).resolves.toMatchObject({
      currentVersionId: f.first.versionId, pinned: true, state: "ACTIVE"
    });
    await expect(prisma.memoryFact.findUnique({ where: { id: f.second.factId } })).resolves.toMatchObject({
      currentVersionId: null, movedToFactId: f.first.factId, state: "RETRACTED"
    });
    await expect(prisma.memoryFactVersion.findUnique({ where: { id: f.second.versionId } })).resolves.toMatchObject({
      mergedIntoVersionId: f.first.versionId, state: "MERGED"
    });
    const support = await prisma.memoryEvidence.findMany({ where: { factVersionId: f.first.versionId, userId: f.userId } });
    expect(new Set(support.map(({ memoryEventId }) => memoryEventId)).size).toBe(2);
    expect(await prisma.memoryEvidence.count({ where: { factVersionId: f.second.versionId, userId: f.userId } })).toBe(1);
    expect(await prisma.memorySearchEntry.count({ where: { factVersionId: f.second.versionId, userId: f.userId } })).toBe(0);
    expect(await prisma.memoryExecutionBinding.count({ where: { state: "SUCCEEDED", userId: f.userId } })).toBe(1);
    expect(await prisma.chat.count({ where: { userId: f.userId } })).toBe(0);
  });

  it("finds recently saved explicit facts while their search entries are unavailable", async () => {
    const f = await fixture();
    await prisma.memorySearchEntry.deleteMany({ where: { userId: f.userId } });
    const h = handler();
    const result = await h.instance.execute(f.job, h.context);
    expect(h.run).toHaveBeenCalledOnce();
    await expect(commit(f.job, result)).resolves.toBe(true);
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(1);
  });

  it.each([["DISTINCT", "HIGH"], ["UNCERTAIN", "LOW"], ["EQUIVALENT", "MEDIUM"]])(
    "retains both facts for %s with %s confidence", async (relation, confidence) => {
      const f = await fixture();
      const h = handler(relation, confidence);
      await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
      expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(2);
      expect(await prisma.memoryFactVersionRelation.count({ where: { userId: f.userId } })).toBe(0);
    }
  );

  it("rolls back a failed commit and reapplies its durable result without another provider call", async () => {
    const f = await fixture();
    const h = handler();
    const result = await h.instance.execute(f.job, h.context);
    await expect(commit(f.job, { ...result, apply: async (tx, claim) => {
      await result.apply!(tx, claim);
      throw new Error("fixture_commit_abort");
    } })).rejects.toThrow();
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(2);
    expect(await prisma.memoryFactVersionRelation.count({ where: { userId: f.userId } })).toBe(0);
    expect(await prisma.memoryAuxiliarySemanticCall.count({ where: { completedAt: { not: null }, userId: f.userId } })).toBe(1);
    await expect(commit(f.job, await h.instance.execute(f.job, h.context))).resolves.toBe(true);
    expect(h.run).toHaveBeenCalledOnce();
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(1);
  });

  it("rejects a merge when one candidate was edited after the comparison", async () => {
    const f = await fixture();
    const h = handler();
    const result = await h.instance.execute(f.job, h.context);
    const statement = "Je donne des cours de gravure.";
    const id = randomUUID();
    const current = await prisma.memoryFact.findUniqueOrThrow({
      select: { canonicalKey: true }, where: { id: f.first.factId }
    });
    await facts.edit(f.userId, {
      authorization: {
        action: "EDIT", authorizationId: id, authorizedPayloadHash: memorySha256(id),
        expectedTargetVersionId: f.first.versionId, targetFactId: f.first.factId
      },
      evidence: evidence(statement), expectedVersionId: f.first.versionId, explicitSuppressionOverride: false,
      factId: f.first.factId, idempotencyFingerprint: id, requestId: id, scopeId: f.scopeId,
      value: { ...value(statement), canonicalKey: current.canonicalKey }
    });
    await expect(commit(f.job, result)).rejects.toThrow();
    expect(await prisma.memoryFact.count({ where: { state: "ACTIVE", userId: f.userId } })).toBe(2);
    expect(await prisma.memoryFactVersionRelation.count({ where: { userId: f.userId } })).toBe(0);
    expect(h.run).toHaveBeenCalledOnce();
  });

  it.each(["pause", "reset", "evidence"])("fences %s after comparison without losing the accepted receipt", async (change) => {
    const f = await fixture();
    const h = handler();
    await h.instance.execute(f.job, h.context);
    if (change === "evidence") {
      await prisma.memoryEvidence.updateMany({
        data: { safeSourceHash: "f".repeat(64) }, where: { factVersionId: f.first.versionId, userId: f.userId }
      });
    } else await prisma.userMemorySettings.update({
      data: change === "pause" ? { useMemoryFacts: false } : { memoryGeneration: { increment: 1 } },
      where: { userId: f.userId }
    });
    const repository = createPrismaMemoryExplicitRelationRepository(prisma, {});
    const retained = await repository.loadResult(f.job);
    expect(retained).not.toBeNull();
    await expect(prisma.$transaction((tx) => repository.apply(tx, f.job, retained!, new Date()))).rejects.toThrow();
    expect(await prisma.memoryFactVersionRelation.count({ where: { userId: f.userId } })).toBe(0);
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("requires current explicit receipt authority and an owner-matched target before dispatch", async () => {
    const f = await fixture();
    const foreign = await fixture();
    expect(await loadMemoryExplicitRelationSnapshot(prisma, { ...f.job, targetFactVersionId: foreign.second.versionId }, [])).toBeNull();
    await prisma.memoryOperationReceipt.deleteMany({ where: { targetVersionId: f.second.versionId, userId: f.userId } });
    const h = handler();
    await expect(h.instance.preflight(f.job)).resolves.toMatchObject({ status: "CANCELLED" });
    expect(h.run).not.toHaveBeenCalled();
    await expect(prisma.memoryAuxiliarySemanticCall.create({ data: {
      id: randomUUID(), ownerJobId: f.job.id, purpose: "EXPLICIT_FACT_EQUIVALENCE",
      targetFactVersionId: foreign.second.versionId, userId: f.userId
    } })).rejects.toThrow();
  });

  it("rejects a succeeded execution without its atomic durable packet", async () => {
    const f = await fixture();
    const current = await loadMemoryExplicitRelationSnapshot(prisma, f.job, [f.first.versionId]);
    expect(current).not.toBeNull();
    const inputHash = memoryExplicitRelationInputHash(current!.snapshot);
    const store = createPrismaMemoryExplicitRelationAuxiliaryStore(prisma);
    await expect(store.reserve(f.job, inputHash, new Date())).resolves.toEqual({ status: "ACQUIRED" });
    const execution = createPrismaMemoryExecutionService({}, prisma);
    const binding = await execution.admission.bind(f.userId, {
      inputHash, ordinal: 0, owner: { memoryJobId: f.job.id, type: "JOB" },
      role: "MEMORY_CONSOLIDATE", versions: MEMORY_EXPLICIT_RELATION_VERSIONS
    });
    await execution.admission.start(f.userId, binding.id);
    await expect(execution.lifecycle.settle(f.userId, binding.id, {
      acceptedOutputHash: "d".repeat(64), errorCode: null, providerResponseId: null, state: "SUCCEEDED",
      usage: { cachedInputTokens: null, completeness: "UNAVAILABLE", estimatedCostMicros: null,
        inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }
    })).rejects.toThrow();
    await expect(prisma.memoryExecutionBinding.findUnique({ where: { id: binding.id } })).resolves.toMatchObject({ state: "RUNNING" });
    await expect(store.load(f.job)).resolves.toBeNull();
  });
});
