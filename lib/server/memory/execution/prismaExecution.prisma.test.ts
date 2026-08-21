import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createAdminMemoryEgressService } from "../../admin/memory/egressService";
import { prisma } from "../../prisma";
import { createFakeEmbeddingAdapter } from "@/tests/support/embeddings";
import { createPrismaMemoryJobRepository } from "@/tests/support/memoryPersistence";
import { createPrismaMemoryExecutionService } from ".";
import { MemoryExecutionError } from "./errors";
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
      evidence: { detail: "ok" },
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
        egressConsentMode: "PER_USER",
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
      await expect(service.admission.bind(fixture.userId, {
        inputHash: "1".repeat(64),
        ordinal: 0,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      })).resolves.toMatchObject({ id: first.id, replayed: true, state: "PENDING" });

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
        usage: completeUsage(11)
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
          evidence: { detail: "ok" },
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
        completedAt: INITIAL_NOW,
        logicalRole: "MEMORY_DOCUMENT_EMBED",
        startedAt: INITIAL_NOW,
        userId: fixture.userId
      });
      expect(events.find(({ memoryExecutionBindingId }) =>
        memoryExecutionBindingId === unknown.id)).toMatchObject({
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
        egressConsentMode: "PER_USER",
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
          evidence: { detail: "ok" },
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

  it("parks ADMIN work on destination drift and resumes after exact administrator acknowledgment", async () => {
    const fixture = await createEmbeddingFixture();
    let coordinatorKicks = 0;
    const adminPolicy = createAdminMemoryEgressService(prisma, {
      consentMode: "ADMIN",
      onAcknowledged: () => {
        coordinatorKicks += 1;
      }
    });

    const accept = async () => {
      const observed = await adminPolicy.get();
      expect(observed.reviewRequired).toBe(true);
      const accepted = await adminPolicy.acknowledge(fixture.userId, {
        currentFingerprint: observed.currentFingerprint,
        expectedVersion: observed.version
      });
      expect(accepted.reviewRequired).toBe(false);
    };
    const currentTarget = async () => prisma.$transaction(async (tx) => {
      const settings = await tx.userMemorySettings.findUniqueOrThrow({
        where: { userId: fixture.userId }
      });
      const policy = await resolveCurrentMemoryUtilityPolicy(tx, fixture.userId, settings);
      return policy.targets.get("MEMORY_DOCUMENT_EMBED")!;
    });

    try {
      await prisma.memoryEgressAdminPolicy.update({
        data: {
          acceptedAt: null,
          acceptedByUserId: null,
          acceptedDestinations: [],
          acceptedFingerprint: null,
          acceptedPolicyVersion: null,
          version: { increment: 1 }
        },
        where: { id: "installation" }
      });
      const initialTarget = await currentTarget();
      const service = createPrismaMemoryExecutionService({
        egressConsentMode: "ADMIN",
        now: () => INITIAL_NOW
      }, prisma);
      const job = await createPrismaMemoryJobRepository(prisma).enqueue(fixture.userId, {
        idempotencyFingerprint: `memory-admin-consent-job-${randomUUID()}`,
        kind: "EMBED_ITEMS",
        pipelineVersion: VERSIONS.pipelineVersion
      });
      const bind = (ordinal: number) => service.admission.bind(fixture.userId, {
        inputHash: String(ordinal + 1).repeat(64),
        ordinal,
        owner: { memoryJobId: job.id, type: "JOB" },
        role: "MEMORY_DOCUMENT_EMBED",
        versions: VERSIONS
      });

      await expect(bind(0)).rejects.toMatchObject({
        code: "memory_execution_egress_consent_required"
      });
      await accept();
      await expect(bind(0)).resolves.toMatchObject({ state: "PENDING" });

      const changedConfiguration = {
        allowPrivateNetwork: false,
        apiRoot: "https://memory-provider-rotated.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      };
      await prisma.providerConnection.update({
        data: {
          activeConfig: changedConfiguration,
          activeVersion: 2
        },
        where: { id: fixture.connectionId }
      });
      await prisma.providerModelCredentialCheck.create({
        data: {
          checkedAt: INITIAL_NOW,
          connectionId: fixture.connectionId,
          connectionVersion: 2,
          credentialId: fixture.credentialId,
          credentialVersionId: fixture.credentialVersionId,
          evidence: { detail: "ok" },
          modelVersion: 1,
          providerModelId: fixture.modelId,
          status: "available"
        }
      });
      const driftedTarget = await currentTarget();
      expect(driftedTarget.destinationFingerprint).not.toBe(initialTarget.destinationFingerprint);

      await expect(bind(1)).rejects.toMatchObject({
        code: "memory_execution_egress_consent_required"
      });
      await accept();
      await expect(bind(1)).resolves.toMatchObject({ state: "PENDING" });
      expect(coordinatorKicks).toBe(2);
    } finally {
      await prisma.memoryEgressAdminPolicy.updateMany({
        data: {
          acceptedAt: null,
          acceptedByUserId: null,
          acceptedDestinations: [],
          acceptedFingerprint: null,
          acceptedPolicyVersion: null,
          version: { increment: 1 }
        },
        where: { id: "installation" }
      });
      await fixture.cleanup();
    }
  });
});
