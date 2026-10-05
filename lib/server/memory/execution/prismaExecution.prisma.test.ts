import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createFakeEmbeddingAdapter } from "@/tests/support/embeddings";
import { createPrismaMemoryJobRepository } from "@/tests/support/memoryPersistence";
import { createPrismaAdminProviderRepository } from "../../admin/providers/prismaRepository";
import { createPrismaMemoryEmbeddingBatchRepository } from "../embedding/batchRepository";
import { createPrismaMemoryItemEmbeddingRepository } from "../embedding/repository";
import { createPrismaMemoryExecutionService } from ".";
import { MemoryExecutionError } from "./errors";
import { MEMORY_EXECUTION_RECOVERY_HORIZON_MS } from "./lifecycle";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  resolveCurrentMemoryUtilityPolicy
} from "./policy";

const INITIAL_NOW = new Date("2026-08-10T12:00:00.000Z");
const VERSIONS = {
  pipelineVersion: "memory-execution-test-v1",
  policyVersion: "memory-policy-test-v1",
  promptVersion: "memory-embed-prompt-v1",
  retrievalConfigFingerprint: "memory-retrieval-test-v1",
  schemaVersion: "memory-embed-schema-v1"
} as const;

const embeddingConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 1_536,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_536
  },
  modelClass: "embedding",
  upstreamModelId: "memory-test-embedding"
} as const;

const embeddingCredentialEvidence = {
  embedding: {
    dimensions: embeddingConfiguration.embedding.targetDimension,
    document: true,
    probeVersion: 1,
    query: true
  },
  method: "tiny_generation",
  selectedProviders: [],
  upstreamModelId: embeddingConfiguration.upstreamModelId
};

function completeUsage(inputTokens: number): {
  cachedInputTokens: number;
  completeness: "COMPLETE";
  estimatedCostMicros: null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
} {
  return {
    cachedInputTokens: 0,
    completeness: "COMPLETE",
    estimatedCostMicros: null,
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens
  };
}

const unavailableUsage = {
  cachedInputTokens: null,
  completeness: "UNAVAILABLE" as const,
  estimatedCostMicros: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null
};

async function createEmbeddingFixture() {
  const suffix = randomUUID();
  const userId = `memory-execution-user-${suffix}`;
  const connectionId = `memory-execution-connection-${suffix}`;
  const credentialId = `memory-execution-credential-${suffix}`;
  const credentialVersionId = `memory-execution-version-${suffix}`;
  const modelId = `memory-execution-model-${suffix}`;
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://memory-provider.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 30_000
  };

  await prisma.user.create({
    data: {
      displayName: "Memory execution owner",
      email: `memory-execution-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.providerConnection.create({
    data: {
      activeConfig: connectionConfiguration,
      activeVersion: 1,
      activatedAt: INITIAL_NOW,
      displayName: "Memory execution provider",
      draftConfig: connectionConfiguration,
      draftVersion: 1,
      enabled: true,
      family: "openai_compatible",
      id: connectionId,
      unassignedPolicy: "use_default"
    }
  });
  await prisma.providerCredential.create({
    data: {
      activatedAt: INITIAL_NOW,
      connectionId,
      draftVersion: 1,
      enabled: true,
      id: credentialId,
      label: "Memory execution account",
      testedAt: INITIAL_NOW
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: INITIAL_NOW,
      credentialId,
      id: credentialVersionId,
      secretEnvelope: "test-only-envelope",
      testedAt: INITIAL_NOW,
      testEvidence: { authenticationMode: "bearer" },
      version: 1
    }
  });
  await prisma.providerCredential.update({
    data: { activeVersionId: credentialVersionId },
    where: { id: credentialId }
  });
  await prisma.providerConnection.update({
    data: { defaultCredentialId: credentialId },
    where: { id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      activeConfig: embeddingConfiguration,
      activeVersion: 1,
      activatedAt: INITIAL_NOW,
      capabilities: embeddingConfiguration.capabilities,
      connectionId,
      defaultParams: {},
      displayName: "Memory test embedding",
      draftConfig: embeddingConfiguration,
      draftVersion: 1,
      enabled: true,
      id: modelId,
      modelClass: "embedding",
      modelId: embeddingConfiguration.upstreamModelId,
      provider: "openai_compatible"
    }
  });
  await prisma.providerModelCredentialCheck.create({
    data: {
      checkedAt: INITIAL_NOW,
      connectionId,
      connectionVersion: 1,
      credentialId,
      credentialVersionId,
      evidence: embeddingCredentialEvidence,
      modelVersion: 1,
      providerModelId: modelId,
      status: "available"
    }
  });
  await prisma.accessGrant.create({
    data: { enabled: true, providerModelId: modelId, userId }
  });
  await prisma.userMemorySettings.update({
    data: { embeddingProviderModelId: modelId },
    where: { userId }
  });

  return {
    connectionId,
    credentialId,
    credentialVersionId,
    modelId,
    userId,
    async cleanup() {
      await prisma.usageEvent.deleteMany({ where: { userId } });
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
      await prisma.providerConnection.updateMany({
        data: { defaultCredentialId: null },
        where: { id: connectionId }
      });
      await prisma.providerCredential.updateMany({
        data: { activeVersionId: null },
        where: { id: credentialId }
      });
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
  };
}

function expectExecutionCode(
  result: PromiseSettledResult<unknown>,
  code: MemoryExecutionError["code"]
): void {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  expect(result.reason).toBeInstanceOf(MemoryExecutionError);
  expect((result.reason as MemoryExecutionError).code).toBe(code);
}

describe("Prisma Memory execution", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("binds before start, fences drift, accounts once, recovers without replay, and detaches", async () => {
    const fixture = await createEmbeddingFixture();
    let clock = new Date(INITIAL_NOW);
    try {
      const initialPolicy = await prisma.$transaction(async (tx) => {
        const settings = await tx.userMemorySettings.findUniqueOrThrow({
          where: { userId: fixture.userId }
        });
        return resolveCurrentMemoryUtilityPolicy(tx, fixture.userId, settings);
      });
      const target = initialPolicy.targets.get("MEMORY_DOCUMENT_EMBED");
      expect(target).toBeDefined();
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: INITIAL_NOW,
          acceptedUtilityEgressFingerprint: initialPolicy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      const service = createPrismaMemoryExecutionService({
        now: () => new Date(clock)
      }, prisma);
      const job = await createPrismaMemoryJobRepository(prisma).enqueue(fixture.userId, {
        idempotencyFingerprint: `memory-execution-job-${randomUUID()}`,
        kind: "EMBED_ITEMS",
        pipelineVersion: VERSIONS.pipelineVersion
      });

      const first = await service.admission.bind(fixture.userId, {
        inputHash: "1".repeat(64),
        ordinal: 0,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      expect(first).toMatchObject({ replayed: false, state: "PENDING" });
      const accepted = await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: first.id } });
      expect(accepted.secretFreeExecutionSnapshot).toMatchObject({ version: 4 });
      // A restart after upgrading must reuse an admitted v2 binding unchanged.
      const legacySnapshot = { ...(accepted.secretFreeExecutionSnapshot as Prisma.JsonObject), version: 2 };
      await prisma.memoryExecutionBinding.update({
        where: { id: first.id }, data: { secretFreeExecutionSnapshot: legacySnapshot }
      });
      await expect(service.admission.bind(fixture.userId, {
        inputHash: "1".repeat(64),
        ordinal: 0,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      })).resolves.toMatchObject({ id: first.id, replayed: true, state: "PENDING" });
      expect((await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: first.id } }))
        .secretFreeExecutionSnapshot).toEqual(legacySnapshot);

      // Simulate a small backwards wall-clock adjustment between binding and
      // start. Execution timestamps must remain monotonic relative to their
      // durable predecessor even when the process clock does not.
      const monotonicFloor = new Date(INITIAL_NOW.getTime() + 100);
      await prisma.memoryExecutionBinding.update({
        data: { createdAt: monotonicFloor },
        where: { id: first.id }
      });

      const starters = await Promise.allSettled([
        service.admission.start(fixture.userId, first.id),
        service.admission.start(fixture.userId, first.id)
      ]);
      expect(starters.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejectedStarter = starters.find(({ status }) => status === "rejected");
      expectExecutionCode(rejectedStarter!, "memory_execution_state_conflict");

      const privateInputCanary = "PRIVATE_MEMORY_INPUT_MUST_NOT_PERSIST";
      const fakeResult = await createFakeEmbeddingAdapter({
        configuration: embeddingConfiguration.embedding,
        seed: "memory-execution-binding-test"
      }).embed({ mode: "document", texts: [privateInputCanary] });
      const acceptedOutputHash = createHash("sha256")
        .update(JSON.stringify(fakeResult.vectors), "utf8")
        .digest("hex");

      const firstSettlement = {
        acceptedOutputHash,
        errorCode: null,
        providerResponseId: "memory-response-1",
        state: "SUCCEEDED" as const,
        usage: {
          cachedInputTokens: null,
          completeness: "PARTIAL" as const,
          estimatedCostMicros: null,
          inputTokens: fakeResult.usage.inputTokens ?? null,
          outputTokens: null,
          reasoningTokens: null,
          totalTokens: fakeResult.usage.totalTokens ?? null
        }
      };
      await expect(service.lifecycle.settle(fixture.userId, first.id, firstSettlement))
        .resolves.toMatchObject({ replayed: false, state: "SUCCEEDED" });
      await expect(service.lifecycle.settle(fixture.userId, first.id, firstSettlement))
        .resolves.toMatchObject({ replayed: true, state: "SUCCEEDED" });
      await expect(service.lifecycle.withAuthorizedResultCommit(
        fixture.userId,
        { acceptedOutputHash, bindingId: first.id },
        async (_tx, evidence) => evidence.owner.type
      )).resolves.toBe("JOB");

      const unknown = await service.admission.bind(fixture.userId, {
        inputHash: "3".repeat(64),
        ordinal: 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      await service.admission.start(fixture.userId, unknown.id);
      await service.lifecycle.settle(fixture.userId, unknown.id, {
        acceptedOutputHash: null,
        errorCode: "provider_outcome_unknown",
        providerResponseId: "memory-response-unknown",
        state: "OUTCOME_UNKNOWN",
        usage: unavailableUsage
      });
      await expect(service.admission.start(fixture.userId, unknown.id)).rejects.toMatchObject({
        code: "memory_execution_state_conflict"
      });
      await expect(service.lifecycle.recoverOutcome(fixture.userId, unknown.id, {
        acceptedOutputHash: "4".repeat(64),
        errorCode: null,
        state: "SUCCEEDED",
        usage: { ...completeUsage(11), cachedInputTokens: null, reasoningTokens: null, cacheWriteInputTokens: 2 }
      })).resolves.toMatchObject({ replayed: false, state: "SUCCEEDED" });

      const sentBeforeDrift = await service.admission.bind(fixture.userId, {
        inputHash: "5".repeat(64),
        ordinal: 2,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      await service.admission.start(fixture.userId, sentBeforeDrift.id);
      const stale = await service.admission.bind(fixture.userId, {
        inputHash: "6".repeat(64),
        ordinal: 3,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      const replacementVersionId = `memory-execution-version-2-${randomUUID()}`;
      await prisma.providerCredentialVersion.create({
        data: {
          activatedAt: clock,
          credentialId: fixture.credentialId,
          id: replacementVersionId,
          secretEnvelope: "test-only-replacement-envelope",
          testedAt: clock,
          testEvidence: { authenticationMode: "bearer" },
          version: 2
        }
      });
      await prisma.providerCredential.update({
        data: { activeVersionId: replacementVersionId },
        where: { id: fixture.credentialId }
      });
      await prisma.providerModelCredentialCheck.create({
        data: {
          checkedAt: clock,
          connectionId: fixture.connectionId,
          connectionVersion: 1,
          credentialId: fixture.credentialId,
          credentialVersionId: replacementVersionId,
          evidence: embeddingCredentialEvidence,
          modelVersion: 1,
          providerModelId: fixture.modelId,
          status: "available"
        }
      });
      await service.lifecycle.settle(fixture.userId, sentBeforeDrift.id, {
        acceptedOutputHash: "7".repeat(64),
        errorCode: null,
        providerResponseId: "memory-response-before-drift",
        state: "SUCCEEDED",
        usage: completeUsage(7)
      });
      await expect(service.lifecycle.withAuthorizedResultCommit(
        fixture.userId,
        { acceptedOutputHash: "7".repeat(64), bindingId: sentBeforeDrift.id },
        async () => "must-not-apply"
      )).rejects.toMatchObject({ code: "memory_execution_policy_drift" });
      await expect(service.admission.start(fixture.userId, stale.id)).rejects.toMatchObject({
        code: "memory_execution_policy_drift"
      });
      await service.lifecycle.settle(fixture.userId, stale.id, {
        acceptedOutputHash: null,
        errorCode: "credential_changed_before_call",
        providerResponseId: null,
        state: "FAILED",
        usage: unavailableUsage
      });
      await expect(service.lifecycle.detachExpiredForUser(fixture.userId)).resolves.toBe(1);

      const events = await prisma.usageEvent.findMany({
        orderBy: { createdAt: "asc" },
        where: {
          memoryExecutionBindingId: {
            in: [first.id, unknown.id, sentBeforeDrift.id, stale.id]
          }
        }
      });
      const firstBinding = await prisma.memoryExecutionBinding.findUniqueOrThrow({
        where: { id: first.id }
      });
      expect(events).toHaveLength(4);
      expect(events.find(({ memoryExecutionBindingId }) =>
        memoryExecutionBindingId === first.id)).toMatchObject({
        cachedInputTokens: null,
        createdAt: expect.any(Date),
        estimatedCostMicros: null,
        inputTokens: fakeResult.usage.inputTokens,
        memoryExecutionBindingId: first.id,
        modelId: embeddingConfiguration.upstreamModelId,
        modelRunId: null,
        outputTokens: null,
        provider: "openai_compatible",
        providerModelId: fixture.modelId,
        reasoningTokens: null,
        totalTokens: fakeResult.usage.totalTokens
      });
      expect(firstBinding).toMatchObject({
        completedAt: monotonicFloor,
        logicalRole: "MEMORY_DOCUMENT_EMBED",
        startedAt: monotonicFloor,
        userId: fixture.userId
      });
      expect(events.find(({ memoryExecutionBindingId }) =>
        memoryExecutionBindingId === unknown.id)).toMatchObject({
        cachedInputTokens: null,
        cacheWriteInputTokens: 2,
        reasoningTokens: null,
        usageCompleteness: "COMPLETE",
        estimatedCostMicros: null,
        inputTokens: 11,
        totalTokens: 11
      });

      clock = new Date(INITIAL_NOW.getTime() + 2 * 24 * 60 * 60 * 1_000);
      await expect(service.lifecycle.detachExpiredForUser(fixture.userId)).resolves.toBe(3);
      const detached = await prisma.memoryExecutionBinding.findMany({
        orderBy: { ordinal: "asc" },
        where: { id: { in: [first.id, unknown.id, sentBeforeDrift.id, stale.id] } }
      });
      expect(detached).toHaveLength(4);
      expect(detached.every((binding) =>
        binding.connectionId === null &&
        binding.providerModelId === null &&
        binding.credentialId === null &&
        binding.credentialVersionId === null &&
        binding.providerResponseId === null &&
        binding.relationsDetachedAt !== null
      )).toBe(true);
      expect(JSON.stringify(detached)).not.toContain("test-only-envelope");
      expect(JSON.stringify(detached)).not.toContain(privateInputCanary);
    } finally {
      await fixture.cleanup();
    }
  });

  it("releases an unknown outcome's provider references after its recovery window without replay", async () => {
    const fixture = await createEmbeddingFixture();
    let clock = new Date(INITIAL_NOW);
    try {
      const service = createPrismaMemoryExecutionService({ now: () => new Date(clock) }, prisma);
      const job = await createPrismaMemoryJobRepository(prisma).enqueue(fixture.userId, {
        idempotencyFingerprint: `memory-unknown-detach-job-${randomUUID()}`,
        kind: "EMBED_ITEMS",
        pipelineVersion: VERSIONS.pipelineVersion
      });
      const request = (ordinal: number) => ({
        inputHash: String(ordinal + 1).repeat(64), ordinal,
        owner: { memoryJobId: job.id, type: "JOB" as const },
        role: "MEMORY_DOCUMENT_EMBED" as const, versions: VERSIONS
      });
      const dispatched = async (ordinal: number) => {
        const binding = await service.admission.bind(fixture.userId, request(ordinal));
        await service.admission.start(fixture.userId, binding.id);
        return binding.id;
      };
      const unknownSettlement = {
        acceptedOutputHash: null, errorCode: "provider_outcome_unknown",
        providerResponseId: null, state: "OUTCOME_UNKNOWN" as const, usage: unavailableUsage
      };
      const unknown = await dispatched(0);
      await service.lifecycle.settle(fixture.userId, unknown, unknownSettlement);
      // A call possibly still in flight, and an unknown outcome without its receipt.
      const running = await dispatched(1);
      const unaccounted = await dispatched(2);
      await prisma.memoryExecutionBinding.update({
        data: {
          completedAt: clock, errorCode: "memory_temporary_retention_expired",
          recoverableUntil: clock, state: "OUTCOME_UNKNOWN"
        },
        where: { id: unaccounted }
      });
      const failed = await dispatched(3);
      await service.lifecycle.settle(fixture.userId, failed, {
        ...unknownSettlement, errorCode: "provider_failed", state: "FAILED"
      });
      const before = await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: unknown } });
      const receipt = await prisma.usageEvent.findFirstOrThrow({
        where: { memoryExecutionBindingId: unknown }
      });
      const recoverableUntil = new Date(INITIAL_NOW.getTime() + MEMORY_EXECUTION_RECOVERY_HORIZON_MS);
      expect(before).toMatchObject({ completedAt: INITIAL_NOW, recoverableUntil, relationsDetachedAt: null });

      // Recovery may still resolve the outcome inside its window.
      clock = new Date(recoverableUntil.getTime() - 1);
      await expect(service.lifecycle.detachExpiredForUser(fixture.userId)).resolves.toBe(0);
      clock = new Date(recoverableUntil);
      await expect(service.lifecycle.detachExpiredForUser(fixture.userId)).resolves.toBe(2);

      expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: unknown } })).toEqual({
        ...before,
        connectionId: null,
        credentialId: null,
        credentialVersionId: null,
        providerModelId: null,
        providerResponseId: null,
        relationsDetachedAt: clock
      });
      expect(await prisma.usageEvent.findFirstOrThrow({
        where: { memoryExecutionBindingId: unknown }
      })).toEqual(receipt);
      for (const id of [running, unaccounted]) {
        expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id } })).toMatchObject({
          connectionId: fixture.connectionId,
          credentialId: fixture.credentialId,
          credentialVersionId: fixture.credentialVersionId,
          providerModelId: fixture.modelId,
          relationsDetachedAt: null
        });
      }

      // The outcome stays final: a repeated settlement replays it, recovery is
      // refused, and neither a rebind nor a restart can dispatch it again.
      await expect(service.lifecycle.settle(fixture.userId, unknown, unknownSettlement))
        .resolves.toMatchObject({ replayed: true, state: "OUTCOME_UNKNOWN" });
      await expect(service.lifecycle.recoverOutcome(fixture.userId, unknown, {
        acceptedOutputHash: "a".repeat(64), errorCode: null, state: "SUCCEEDED", usage: completeUsage(3)
      })).rejects.toMatchObject({ code: "memory_execution_recovery_expired" });
      await expect(service.admission.bind(fixture.userId, request(0)))
        .resolves.toMatchObject({ id: unknown, replayed: true, state: "OUTCOME_UNKNOWN" });
      await expect(service.admission.start(fixture.userId, unknown))
        .rejects.toMatchObject({ code: "memory_execution_state_conflict" });
      await expect(prisma.memoryExecutionBinding.count({ where: { memoryJobId: job.id } }))
        .resolves.toBe(4);
      // The embedding handlers that own the job still see the ambiguous call;
      // detached settled evidence leaves their view.
      const view = (bindings: readonly Readonly<{ id: string; state: string }>[]) =>
        bindings.map(({ id, state }) => ({ id, state }));
      const handlerView = [
        { id: unknown, state: "OUTCOME_UNKNOWN" },
        { id: running, state: "RUNNING" },
        { id: unaccounted, state: "OUTCOME_UNKNOWN" }
      ];
      expect(view(await createPrismaMemoryItemEmbeddingRepository(prisma).bindings(fixture.userId, job.id)))
        .toEqual(handlerView);
      expect(view(await createPrismaMemoryEmbeddingBatchRepository(prisma).bindings(fixture.userId, job.id)))
        .toEqual(handlerView);
      // PostgreSQL still refuses to detach a call that may be in flight.
      await expect(prisma.$executeRaw`UPDATE "MemoryExecutionBinding" SET "connectionId" = NULL,
        "providerModelId" = NULL, "credentialId" = NULL, "credentialVersionId" = NULL,
        "recoverableUntil" = ${clock}, "relationsDetachedAt" = ${clock} WHERE id = ${running}`)
        .rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["model", "credential", "connection"] as const)(
    "lets an administrator delete the %s once only expired unknown Memory calls reference it",
    async (target) => {
      const fixture = await createEmbeddingFixture();
      try {
        // Settled long ago: the recovery window has passed in real time.
        const service = createPrismaMemoryExecutionService({ now: () => INITIAL_NOW }, prisma);
        const job = await createPrismaMemoryJobRepository(prisma).enqueue(fixture.userId, {
          idempotencyFingerprint: `memory-provider-deletion-job-${randomUUID()}`,
          kind: "EMBED_ITEMS",
          pipelineVersion: VERSIONS.pipelineVersion
        });
        const dispatched = async (ordinal: number) => {
          const binding = await service.admission.bind(fixture.userId, {
            inputHash: String(ordinal + 1).repeat(64), ordinal,
            owner: { memoryJobId: job.id, type: "JOB" },
            role: "MEMORY_DOCUMENT_EMBED", versions: VERSIONS
          });
          await service.admission.start(fixture.userId, binding.id);
          return binding.id;
        };
        const settleUnknown = (id: string) => service.lifecycle.settle(fixture.userId, id, {
          acceptedOutputHash: null, errorCode: "provider_outcome_unknown",
          providerResponseId: null, state: "OUTCOME_UNKNOWN", usage: unavailableUsage
        });
        const expired = await dispatched(0);
        await settleUnknown(expired);
        const live = await dispatched(1);
        // Every other reference is already gone, as an administrator would leave it.
        await prisma.userMemorySettings.update({
          data: { embeddingProviderModelId: null }, where: { userId: fixture.userId }
        });
        await prisma.accessGrant.deleteMany({ where: { providerModelId: fixture.modelId } });
        await prisma.providerModel.update({ data: { enabled: false }, where: { id: fixture.modelId } });
        await prisma.providerCredential.update({ data: { enabled: false }, where: { id: fixture.credentialId } });
        await prisma.providerConnection.update({
          data: { defaultCredentialId: null, enabled: false }, where: { id: fixture.connectionId }
        });
        const providers = createPrismaAdminProviderRepository(prisma);
        const remove = () => target === "model"
          ? providers.deleteModel(fixture.modelId)
          : target === "credential"
            ? providers.deleteCredential(fixture.credentialId)
            : providers.deleteConnection(fixture.connectionId);
        const evidence = () => Promise.all([
          prisma.memoryExecutionBinding.findMany({ orderBy: { ordinal: "asc" }, where: { userId: fixture.userId } }),
          prisma.usageEvent.findMany({ orderBy: { id: "asc" }, where: { userId: fixture.userId } })
        ]);

        // A call that may still be in flight keeps the target; the expired
        // unknown outcome releases it.
        await expect(remove()).resolves.toEqual({
          blockers: [{ count: 1, kind: "memory_bindings" }], status: "conflict"
        });
        const [blocked] = await evidence();
        expect(blocked.map(({ id, relationsDetachedAt, state }) =>
          ({ detached: relationsDetachedAt !== null, id, state }))).toEqual([
          { detached: true, id: expired, state: "OUTCOME_UNKNOWN" },
          { detached: false, id: live, state: "RUNNING" }
        ]);

        // Once that call also ends as unknown and its window passes, the
        // deletion completes without touching outcomes, receipts or dispatch.
        await settleUnknown(live);
        const [bindings, receipts] = await evidence();
        await expect(remove()).resolves.toEqual({ status: "deleted" });
        const [after, afterReceipts] = await evidence();
        expect(after).toEqual(bindings.map((binding) => ({
          ...binding,
          connectionId: null,
          credentialId: null,
          credentialVersionId: null,
          providerModelId: null,
          providerResponseId: null,
          relationsDetachedAt: binding.relationsDetachedAt ?? expect.any(Date)
        })));
        expect(after.map(({ errorCode, state }) => ({ errorCode, state }))).toEqual([
          { errorCode: "provider_outcome_unknown", state: "OUTCOME_UNKNOWN" },
          { errorCode: "provider_outcome_unknown", state: "OUTCOME_UNKNOWN" }
        ]);
        expect(afterReceipts).toEqual(receipts);
        expect(afterReceipts).toHaveLength(2);
        expect(afterReceipts.every((receipt) => receipt.providerModelId === fixture.modelId &&
          receipt.usageCompleteness === "UNAVAILABLE")).toBe(true);
        const remaining = target === "model"
          ? await prisma.providerModel.count({ where: { id: fixture.modelId } })
          : target === "credential"
            ? await prisma.providerCredential.count({ where: { id: fixture.credentialId } })
            : await prisma.providerConnection.count({ where: { id: fixture.connectionId } });
        expect(remaining).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    }
  );

  it("governs a content-free inbound MCP request without a synthetic run owner", async () => {
    const fixture = await createEmbeddingFixture();
    try {
      const policy = await prisma.$transaction(async (tx) => {
        const settings = await tx.userMemorySettings.findUniqueOrThrow({
          where: { userId: fixture.userId }
        });
        return resolveCurrentMemoryUtilityPolicy(tx, fixture.userId, settings);
      });
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: INITIAL_NOW,
          acceptedUtilityEgressFingerprint: policy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      const service = createPrismaMemoryExecutionService({
        now: () => INITIAL_NOW
      }, prisma);
      const requestId = `inbound-mcp-${randomUUID()}`;
      const binding = await service.admission.bind(fixture.userId, {
        inputHash: "9".repeat(64),
        ordinal: 1,
        owner: { inboundMcpRequestId: requestId, type: "INBOUND_MCP_REQUEST" },
        role: "MEMORY_QUERY_EMBED",
        versions: VERSIONS
      });

      expect(binding).toMatchObject({
        owner: { inboundMcpRequestId: requestId, type: "INBOUND_MCP_REQUEST" },
        replayed: false,
        state: "PENDING"
      });
      await expect(service.admission.bind(fixture.userId, {
        inputHash: "8".repeat(64),
        ordinal: 1,
        owner: { inboundMcpRequestId: requestId, type: "INBOUND_MCP_REQUEST" },
        role: "MEMORY_QUERY_EMBED",
        versions: VERSIONS
      })).rejects.toMatchObject({ code: "memory_execution_binding_conflict" });
      await expect(service.admission.start(fixture.userId, binding.id))
        .resolves.toMatchObject({
          owner: { inboundMcpRequestId: requestId, type: "INBOUND_MCP_REQUEST" }
        });
      await service.lifecycle.settle(fixture.userId, binding.id, {
        acceptedOutputHash: "7".repeat(64),
        errorCode: null,
        providerResponseId: "inbound-memory-response",
        state: "SUCCEEDED",
        usage: completeUsage(4)
      });

      await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: {
          inboundMcpRequestId: true,
          logicalRole: true,
          memoryJobId: true,
          modelRunId: true,
          modelRunToolCallId: true,
          mutationAuthorizationId: true,
          ownerType: true,
          retrievalAttemptId: true,
          state: true
        },
        where: { id: binding.id }
      })).resolves.toEqual({
        inboundMcpRequestId: requestId,
        logicalRole: "MEMORY_QUERY_EMBED",
        memoryJobId: null,
        modelRunId: null,
        modelRunToolCallId: null,
        mutationAuthorizationId: null,
        ownerType: "INBOUND_MCP_REQUEST",
        retrievalAttemptId: null,
        state: "SUCCEEDED"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("persists a closed decode reason only on a settled rejected answer", async () => {
    const fixture = await createEmbeddingFixture();
    try {
      const policy = await prisma.$transaction(async (tx) => {
        const settings = await tx.userMemorySettings.findUniqueOrThrow({
          where: { userId: fixture.userId }
        });
        return resolveCurrentMemoryUtilityPolicy(tx, fixture.userId, settings);
      });
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: INITIAL_NOW,
          acceptedUtilityEgressFingerprint: policy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      const service = createPrismaMemoryExecutionService({ now: () => INITIAL_NOW }, prisma);
      const owner = { inboundMcpRequestId: `decode-reason-${randomUUID()}`, type: "INBOUND_MCP_REQUEST" } as const;
      const started = async (ordinal: number) => {
        const binding = await service.admission.bind(fixture.userId, {
          inputHash: "6".repeat(64), ordinal, owner, role: "MEMORY_QUERY_EMBED", versions: VERSIONS
        });
        await service.admission.start(fixture.userId, binding.id);
        return binding.id;
      };
      const rejected = await started(0);
      const settlement = {
        acceptedOutputHash: null,
        decodeReason: "invalid_json" as const,
        errorCode: "memory_classifier_output_invalid",
        providerResponseId: "rejected-response",
        state: "FAILED" as const,
        usage: completeUsage(3)
      };
      await expect(service.lifecycle.settle(fixture.userId, rejected, settlement))
        .resolves.toMatchObject({ replayed: false, state: "FAILED" });
      await expect(service.lifecycle.settle(fixture.userId, rejected, settlement))
        .resolves.toMatchObject({ replayed: true, state: "FAILED" });
      await expect(service.lifecycle.settle(fixture.userId, rejected, {
        ...settlement, decodeReason: "non_object"
      })).rejects.toMatchObject({ code: "memory_execution_state_conflict" });
      expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: { decodeReason: true, errorCode: true, state: true }, where: { id: rejected }
      })).toEqual({ decodeReason: "invalid_json", errorCode: "memory_classifier_output_invalid", state: "FAILED" });
      expect(await prisma.usageEvent.count({ where: { memoryExecutionBindingId: rejected } })).toBe(1);

      const accepted = await started(1);
      for (const invalid of [
        { ...settlement, acceptedOutputHash: "5".repeat(64), errorCode: null, state: "SUCCEEDED" as const },
        { ...settlement, decodeReason: "Private rejected text" as never }
      ]) {
        await expect(service.lifecycle.settle(fixture.userId, accepted, invalid))
          .rejects.toMatchObject({ code: "memory_execution_output_invalid" });
      }
      await service.lifecycle.settle(fixture.userId, accepted, {
        acceptedOutputHash: "5".repeat(64), errorCode: null, providerResponseId: null,
        state: "SUCCEEDED", usage: completeUsage(2)
      });
      // PostgreSQL keeps every value a bounded code on a FAILED settlement,
      // whatever the writer.
      for (const [id, value] of [
        [rejected, "Invalid JSON"], [rejected, "1_leading_digit"], [accepted, "invalid_json"]
      ] as const) {
        await expect(prisma.$executeRaw`UPDATE "MemoryExecutionBinding" SET "decodeReason" = ${value} WHERE id = ${id}`)
          .rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
      }
      expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: { decodeReason: true }, where: { id: accepted }
      })).toEqual({ decodeReason: null });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects linked result use and rebound dispatch after target drift", async () => {
    const fixture = await createEmbeddingFixture();
    try {
      const initialPolicy = await prisma.$transaction(async (tx) => {
        const settings = await tx.userMemorySettings.findUniqueOrThrow({
          where: { userId: fixture.userId }
        });
        return resolveCurrentMemoryUtilityPolicy(tx, fixture.userId, settings);
      });
      const initialTarget = initialPolicy.targets.get("MEMORY_DOCUMENT_EMBED");
      expect(initialTarget).toBeDefined();
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: INITIAL_NOW,
          acceptedUtilityEgressFingerprint: initialPolicy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      const service = createPrismaMemoryExecutionService({
        now: () => INITIAL_NOW
      }, prisma);
      const job = await createPrismaMemoryJobRepository(prisma).enqueue(fixture.userId, {
        idempotencyFingerprint: `memory-linked-execution-job-${randomUUID()}`,
        kind: "EMBED_ITEMS",
        pipelineVersion: VERSIONS.pipelineVersion
      });
      const source = await service.admission.bind(fixture.userId, {
        inputHash: "a".repeat(64),
        ordinal: 0,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      await service.admission.start(fixture.userId, source.id);
      await service.lifecycle.settle(fixture.userId, source.id, {
        acceptedOutputHash: "b".repeat(64),
        errorCode: null,
        providerResponseId: "memory-linked-source-response",
        state: "SUCCEEDED",
        usage: completeUsage(3)
      });

      const selectedJob = await createPrismaMemoryJobRepository(prisma).enqueue(
        fixture.userId,
        {
          idempotencyFingerprint: `memory-linked-result-job-${randomUUID()}`,
          kind: "EMBED_ITEMS",
          pipelineVersion: VERSIONS.pipelineVersion
        }
      );
      const selectedSource = await service.admission.bind(fixture.userId, {
        inputHash: "d".repeat(64),
        ordinal: 0,
        owner: { memoryJobId: selectedJob.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      await service.admission.start(fixture.userId, selectedSource.id);
      await service.lifecycle.settle(fixture.userId, selectedSource.id, {
        acceptedOutputHash: "e".repeat(64),
        errorCode: null,
        providerResponseId: "memory-linked-control-response",
        state: "SUCCEEDED",
        usage: completeUsage(4)
      });
      // Earlier global route inventories may differ for unrelated roles. The
      // selected source and its linked call still have the same exact target.
      const acceptedSource = await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: selectedSource.id } });
      await prisma.memoryExecutionBinding.update({ where: { id: selectedSource.id }, data: {
        secretFreeExecutionSnapshot: { ...(acceptedSource.secretFreeExecutionSnapshot as Prisma.JsonObject),
          acceptedUtilityEgressFingerprint: "f".repeat(64) }
      } });
      const selected = await service.admission.bind(fixture.userId, {
        inputHash: "f".repeat(64),
        ordinal: 1,
        owner: { memoryJobId: selectedJob.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      await service.admission.start(fixture.userId, selected.id, {
        sourceBindingId: selectedSource.id
      });
      await service.lifecycle.settle(fixture.userId, selected.id, {
        acceptedOutputHash: "0".repeat(64),
        errorCode: null,
        providerResponseId: "memory-linked-selector-response",
        state: "SUCCEEDED",
        usage: completeUsage(5)
      });

      const replacementVersionId = `memory-linked-version-2-${randomUUID()}`;
      await prisma.providerCredentialVersion.create({
        data: {
          activatedAt: INITIAL_NOW,
          credentialId: fixture.credentialId,
          id: replacementVersionId,
          secretEnvelope: "test-only-linked-replacement-envelope",
          testedAt: INITIAL_NOW,
          testEvidence: { authenticationMode: "bearer" },
          version: 2
        }
      });
      await prisma.providerCredential.update({
        data: { activeVersionId: replacementVersionId },
        where: { id: fixture.credentialId }
      });
      await prisma.providerModelCredentialCheck.create({
        data: {
          checkedAt: INITIAL_NOW,
          connectionId: fixture.connectionId,
          connectionVersion: 1,
          credentialId: fixture.credentialId,
          credentialVersionId: replacementVersionId,
          evidence: embeddingCredentialEvidence,
          modelVersion: 1,
          providerModelId: fixture.modelId,
          status: "available"
        }
      });
      const changedPolicy = await prisma.$transaction(async (tx) => {
        const settings = await tx.userMemorySettings.findUniqueOrThrow({
          where: { userId: fixture.userId }
        });
        return resolveCurrentMemoryUtilityPolicy(tx, fixture.userId, settings);
      });
      const changedTarget = changedPolicy.targets.get("MEMORY_DOCUMENT_EMBED");
      expect(changedTarget?.executionTargetFingerprint)
        .not.toBe(initialTarget?.executionTargetFingerprint);

      await expect(service.lifecycle.assertResultAuthorized(fixture.userId, {
        bindingId: source.id
      })).rejects.toMatchObject({ code: "memory_execution_policy_drift" });
      await expect(service.lifecycle.assertLinkedResultAuthorized(fixture.userId, {
        acceptedOutputHash: "0".repeat(64),
        bindingId: selected.id,
        sourceBindingId: selectedSource.id
      })).rejects.toMatchObject({ code: "memory_execution_policy_drift" });

      const rebound = await service.admission.bind(fixture.userId, {
        inputHash: "c".repeat(64),
        ordinal: 1,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });
      await expect(service.admission.start(fixture.userId, rebound.id, {
        sourceBindingId: source.id
      })).rejects.toMatchObject({ code: "memory_execution_policy_drift" });
      await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: { startedAt: true, state: true },
        where: { id: rebound.id }
      })).resolves.toEqual({ startedAt: null, state: "PENDING" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("admits configured destinations without legacy acceptance and never retargets accepted work", async () => {
    const fixture = await createEmbeddingFixture();
    try {
      const service = createPrismaMemoryExecutionService({ now: () => INITIAL_NOW }, prisma);
      const job = await createPrismaMemoryJobRepository(prisma).enqueue(fixture.userId, {
        idempotencyFingerprint: `memory-automatic-job-${randomUUID()}`,
        kind: "EMBED_ITEMS",
        pipelineVersion: VERSIONS.pipelineVersion
      });
      const bind = (ordinal: number) => service.admission.bind(fixture.userId, {
        inputHash: String(ordinal + 1).repeat(64), ordinal,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED", versions: VERSIONS
      });
      const initial = await bind(0);
      expect(initial).toMatchObject({ state: "PENDING", replayed: false });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: fixture.userId } }))
        .resolves.toMatchObject({ acceptedUtilityEgressAt: null, acceptedUtilityEgressFingerprint: null,
          acceptedUtilityPolicyVersion: null, memoryConsentRevision: 0 });
      // Rotation invalidates this exact binding. Its old credential receipt
      // cannot authorize the new connection version.
      await prisma.providerConnection.update({
        data: { activeConfig: { allowPrivateNetwork: false,
          apiRoot: "https://memory-provider-rotated.example.test/v1",
          authenticationMode: "bearer", responseTimeoutMs: 30_000 }, activeVersion: 2 },
        where: { id: fixture.connectionId }
      });
      await expect(bind(1)).rejects.toMatchObject({ code: "memory_execution_target_unavailable" });
      await prisma.providerModelCredentialCheck.create({ data: {
        checkedAt: INITIAL_NOW, connectionId: fixture.connectionId, connectionVersion: 2,
        credentialId: fixture.credentialId, credentialVersionId: fixture.credentialVersionId,
        evidence: embeddingCredentialEvidence, modelVersion: 1,
        providerModelId: fixture.modelId, status: "available"
      } });
      await expect(service.admission.start(fixture.userId, initial.id))
        .rejects.toMatchObject({ code: "memory_execution_policy_drift" });
      await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: initial.id } }))
        .resolves.toMatchObject({ state: "PENDING", startedAt: null });
      // A fresh operation may use the current verified target even if a
      // retired writer left an obsolete acceptance record behind.
      await prisma.userMemorySettings.update({ where: { userId: fixture.userId }, data: {
        acceptedUtilityEgressAt: INITIAL_NOW, acceptedUtilityEgressFingerprint: "f".repeat(64),
        acceptedUtilityPolicyVersion: "retired-policy", memoryConsentRevision: 1
      } });
      const current = await bind(1);
      expect(current).toMatchObject({ state: "PENDING", replayed: false });
      await expect(service.admission.start(fixture.userId, current.id)).resolves.toMatchObject({ bindingId: current.id });
      await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: current.id } }))
        .resolves.toMatchObject({ state: "RUNNING" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("records the catalog cost frozen at admission on the binding and its usage event", async () => {
    const fixture = await createEmbeddingFixture();
    const setPrices = (input: number | null, output: number | null) => prisma.providerModel.update({
      data: { inputTokenPriceUsdPerMillion: input, outputTokenPriceUsdPerMillion: output },
      where: { id: fixture.modelId }
    });
    try {
      const service = createPrismaMemoryExecutionService({ now: () => INITIAL_NOW }, prisma);
      const job = await createPrismaMemoryJobRepository(prisma).enqueue(fixture.userId, {
        idempotencyFingerprint: `memory-priced-job-${randomUUID()}`,
        kind: "EMBED_ITEMS",
        pipelineVersion: VERSIONS.pipelineVersion
      });
      const bind = (ordinal: number) => service.admission.bind(fixture.userId, {
        inputHash: String(ordinal + 1).repeat(64), ordinal,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED", versions: VERSIONS
      });
      await setPrices(2.5, 10);
      const priced = await bind(0);
      const reported = await bind(1);
      const recovered = await bind(2);
      expect((await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: priced.id } }))
        .secretFreeExecutionSnapshot).toMatchObject({ catalogTokenPricing: {
        cachedInputTokenPriceUsdPerMillion: null, cacheWriteInputTokenPriceUsdPerMillion: null,
        inputTokenPriceUsdPerMillion: 2.5, outputTokenPriceUsdPerMillion: 10
      } });
      // A later catalog edit neither conflicts with a bind replay nor reprices it.
      await setPrices(40, 80);
      await expect(bind(0)).resolves.toMatchObject({ id: priced.id, replayed: true });
      await setPrices(null, null);
      const unpriced = await bind(3);
      for (const { id } of [priced, reported, recovered, unpriced]) {
        await service.admission.start(fixture.userId, id);
      }

      const succeeded = (hash: string, estimatedCostMicros: number | null = null) => ({
        acceptedOutputHash: hash, errorCode: null, providerResponseId: `priced-response-${hash[0]}`,
        state: "SUCCEEDED" as const, usage: { ...completeUsage(1_000), estimatedCostMicros }
      });
      // 1,000 input tokens at the admitted $2.50 per million: 2,500 micros,
      // although the catalog has been edited and is now unpriced.
      await expect(service.lifecycle.settle(fixture.userId, priced.id, succeeded("1".repeat(64))))
        .resolves.toMatchObject({ replayed: false, state: "SUCCEEDED" });
      await expect(service.lifecycle.settle(fixture.userId, priced.id, succeeded("1".repeat(64))))
        .resolves.toMatchObject({ replayed: true, state: "SUCCEEDED" });
      await expect(service.lifecycle.withAuthorizedResultCommit(fixture.userId,
        { acceptedOutputHash: "1".repeat(64), bindingId: priced.id }, async () => "applied"))
        .resolves.toBe("applied");
      // A provider-reported cost wins over the catalog estimate.
      await service.lifecycle.settle(fixture.userId, reported.id, succeeded("2".repeat(64), 7));
      await service.lifecycle.settle(fixture.userId, unpriced.id, succeeded("4".repeat(64)));

      // Recovery prices the recovered usage from the same frozen price.
      await service.lifecycle.settle(fixture.userId, recovered.id, {
        acceptedOutputHash: null, errorCode: "provider_outcome_unknown", providerResponseId: null,
        state: "OUTCOME_UNKNOWN", usage: unavailableUsage
      });
      const recovery = {
        acceptedOutputHash: "3".repeat(64), errorCode: null, state: "SUCCEEDED" as const,
        usage: completeUsage(400)
      };
      await expect(service.lifecycle.recoverOutcome(fixture.userId, recovered.id, recovery))
        .resolves.toMatchObject({ replayed: false, state: "SUCCEEDED" });
      await expect(service.lifecycle.recoverOutcome(fixture.userId, recovered.id, recovery))
        .resolves.toMatchObject({ replayed: true, state: "SUCCEEDED" });
      await expect(service.lifecycle.assertResultAuthorized(fixture.userId, { bindingId: recovered.id }))
        .resolves.toBeUndefined();

      const ids = [priced.id, reported.id, recovered.id, unpriced.id];
      const expected = {
        [priced.id]: 2_500, [recovered.id]: 1_000, [reported.id]: 7, [unpriced.id]: null
      };
      const bindings = await prisma.memoryExecutionBinding.findMany({
        select: { estimatedCostMicros: true, id: true }, where: { id: { in: ids } }
      });
      const events = await prisma.usageEvent.findMany({
        select: { estimatedCostMicros: true, memoryExecutionBindingId: true },
        where: { memoryExecutionBindingId: { in: ids } }
      });
      expect(Object.fromEntries(bindings.map(({ estimatedCostMicros, id }) =>
        [id, estimatedCostMicros]))).toEqual(expected);
      expect(Object.fromEntries(events.map(({ estimatedCostMicros, memoryExecutionBindingId }) =>
        [memoryExecutionBindingId, estimatedCostMicros]))).toEqual(expected);
    } finally {
      await fixture.cleanup();
    }
  });
});
