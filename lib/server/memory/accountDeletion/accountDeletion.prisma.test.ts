import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaAdminRepository } from "../../auth/adminRepository";
import { prisma } from "../../prisma";
import { MemoryCoordinator } from "../coordinator/coordinator";
import { createPrismaMemoryCoordinatorRepository } from
  "../coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from "../coordinator/registry";
import type { MemoryDeletionClaim } from "../coordinator/types";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { createPrismaMemoryFeedbackRepository } from "../review/feedbackRepository";
import { purgeMemoryFeedbackAccount } from "../review/purge";
import { ACCOUNT_MEMORY_DELETION_TARGET_TYPE } from "./contract";
import { createPrismaAccountMemoryDeletionHandler } from "./handler";
import { createAccountMemoryDeletionHook } from "./integration";
import { countAccountMemoryOwnedData } from "./inventory";
import { AccountMemoryDeletionRegistry } from "./registry";

type ProviderFixture = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  modelId: string;
}>;

const providerConfiguration = {
  allowPrivateNetwork: false,
  apiRoot: "https://account-memory-provider.example.test/v1",
  responseTimeoutMs: 30_000
};

const embeddingConfiguration = {
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
  upstreamModelId: "account-memory-embedding"
};

async function createProviderFixture(now: Date): Promise<ProviderFixture> {
  const suffix = randomUUID();
  const fixture = {
    connectionId: `account-memory-connection-${suffix}`,
    credentialId: `account-memory-credential-${suffix}`,
    credentialVersionId: `account-memory-version-${suffix}`,
    modelId: `account-memory-model-${suffix}`
  };
  await prisma.providerConnection.create({
    data: {
      activeConfig: providerConfiguration,
      activeVersion: 1,
      activatedAt: now,
      displayName: "Account Memory provider",
      draftConfig: providerConfiguration,
      draftVersion: 1,
      enabled: true,
      family: "openai_compatible",
      id: fixture.connectionId,
      unassignedPolicy: "use_default"
    }
  });
  await prisma.providerCredential.create({
    data: {
      activatedAt: now,
      connectionId: fixture.connectionId,
      draftVersion: 1,
      enabled: true,
      id: fixture.credentialId,
      label: "Account Memory credential",
      testedAt: now
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId: fixture.credentialId,
      id: fixture.credentialVersionId,
      secretEnvelope: "account-memory-test-only-envelope",
      testedAt: now,
      testEvidence: { authenticationMode: "bearer" },
      version: 1
    }
  });
  await prisma.providerCredential.update({
    data: { activeVersionId: fixture.credentialVersionId },
    where: { id: fixture.credentialId }
  });
  await prisma.providerConnection.update({
    data: { defaultCredentialId: fixture.credentialId },
    where: { id: fixture.connectionId }
  });
  await prisma.providerModel.create({
    data: {
      activeConfig: embeddingConfiguration,
      activeVersion: 1,
      activatedAt: now,
      capabilities: embeddingConfiguration.capabilities,
      connectionId: fixture.connectionId,
      contextWindow: 32_768,
      defaultParams: {},
      displayName: "Account Memory embedding",
      draftConfig: embeddingConfiguration,
      draftVersion: 1,
      enabled: true,
      id: fixture.modelId,
      modelClass: "embedding",
      modelId: embeddingConfiguration.upstreamModelId,
      provider: "openai_compatible"
    }
  });
  return fixture;
}

async function cleanupProvider(fixture: ProviderFixture): Promise<void> {
  await prisma.providerConnection.updateMany({
    data: { defaultCredentialId: null },
    where: { id: fixture.connectionId }
  });
  await prisma.providerCredential.updateMany({
    data: { activeVersionId: null },
    where: { id: fixture.credentialId }
  });
  await prisma.providerModel.deleteMany({ where: { id: fixture.modelId } });
  await prisma.providerCredentialVersion.deleteMany({
    where: { credentialId: fixture.credentialId }
  });
  await prisma.providerCredential.deleteMany({ where: { id: fixture.credentialId } });
  await prisma.providerConnection.deleteMany({ where: { id: fixture.connectionId } });
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await purgeMemoryFeedbackAccount(tx, userId);
    await tx.memoryProfileProjectionFact.deleteMany({ where: { userId } });
    await tx.memoryProfileProjection.deleteMany({ where: { userId } });
    await tx.usageEvent.deleteMany({ where: { userId } });
    await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });
  });
}

async function createOwner(status: "active" | "disabled" = "active"): Promise<string> {
  const userId = `account-memory-owner-${randomUUID()}`;
  await prisma.user.create({
    data: {
      displayName: "Account Memory owner",
      email: `${userId}@example.test`,
      id: userId,
      status
    }
  });
  return userId;
}

async function populateReusableMemory(
  userId: string,
  provider: ProviderFixture,
  input: Readonly<{ executionState?: "OUTCOME_UNKNOWN" | "SUCCEEDED"; now: Date }>
) {
  const scopeId = randomUUID();
  const sourceGenerationId = randomUUID();
  const generationId = randomUUID();
  const eventId = randomUUID();
  const factId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  const bindingId = randomUUID();
  const executionInputHash = "1".repeat(64);
  const executionOutputHash = "2".repeat(64);
  const statement = "Пользователь предпочитает краткие технические ответы.";
  const startedAt = new Date(input.now.getTime() - 60 * 60 * 1_000);
  const recoverableUntil = input.executionState === "OUTCOME_UNKNOWN"
    ? new Date(input.now.getTime() + 24 * 60 * 60 * 1_000)
    : new Date(input.now.getTime() - 1);
  const state = input.executionState ?? "SUCCEEDED";

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryScope.create({
      data: { id: scopeId, scopeType: "GLOBAL_USER", userId }
    });
    await tx.memoryIndexGeneration.createMany({
      data: [{
        activatedAt: startedAt,
        chunkingVersion: "account-memory-test-v1",
        createdAt: startedAt,
        generation: 0,
        id: sourceGenerationId,
        indexMode: "LEXICAL_ONLY",
        indexedThroughMemoryRevision: 0,
        languageProfile: "RU_EN_MULTILINGUAL_V1",
        normalizationVersion: "account-memory-test-v1",
        readyAt: startedAt,
        retrievalPipelineVersion: "account-memory-test-v1",
        state: "SUPERSEDED",
        supersededAt: input.now,
        targetMemoryRevision: 0,
        userId
      }, {
        activatedAt: input.now,
        chunkingVersion: "account-memory-test-v1",
        generation: 1,
        id: generationId,
        indexMode: "LEXICAL_ONLY",
        indexedThroughMemoryRevision: 0,
        languageProfile: "RU_EN_MULTILINGUAL_V1",
        normalizationVersion: "account-memory-test-v1",
        readyAt: input.now,
        retrievalPipelineVersion: "account-memory-test-v1",
        sourceIndexGenerationId: sourceGenerationId,
        state: "ACTIVE",
        targetMemoryRevision: 0,
        userId
      }]
    });
    await tx.userMemorySettings.update({
      data: {
        activeIndexGenerationId: generationId,
        embeddingProviderModelId: provider.modelId
      },
      where: { userId }
    });
    await tx.memoryFact.create({
      data: {
        canonicalKey: "preference.answer_length",
        category: "preference",
        currentVersionId: versionId,
        id: factId,
        scopeId,
        state: "ACTIVE",
        userId
      }
    });
    await tx.memoryEvent.create({
      data: {
        actorType: "USER",
        actorUserId: userId,
        factId,
        factVersionId: versionId,
        id: eventId,
        metadata: { schemaVersion: "account-memory-test-v1" },
        operation: "EXPLICIT_SAVE",
        userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "preference",
        confidence: 1,
        createdByEventId: eventId,
        directness: "DIRECT",
        displayText: statement,
        factId,
        id: versionId,
        importance: 0.8,
        languageCode: "ru",
        modality: "PREFERENCE",
        normalizedSearchText: normalizeMemorySearchText(statement),
        pipelineVersion: "account-memory-test-v1",
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        state: "ACTIVE",
        structuredValue: { statement },
        userId
      }
    });
    await tx.memoryEvidence.create({
      data: {
        factVersionId: versionId,
        memoryEventId: eventId,
        observedAt: input.now,
        safeExcerpt: statement,
        safeSourceHash: memorySha256(statement),
        safetyClass: "NORMAL",
        sourceProjectionVersion: "account-memory-test-v1",
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS",
        userId
      }
    });
    await tx.memorySearchEntry.create({
      data: {
        embeddingState: "NOT_APPLICABLE",
        factVersionId: versionId,
        indexGenerationId: generationId,
        itemType: "FACT_VERSION",
        languageCode: "ru",
        safeContentHash: memorySha256(statement),
        safeSearchText: statement,
        safeSearchTextYoNormalized: statement,
        safetyIdentitySnapshot: "a".repeat(64),
        sourceIdentitySnapshot: "b".repeat(64),
        suppressionIdentitySnapshot: "c".repeat(64),
        userId
      }
    });
    await tx.memorySuppression.create({
      data: {
        deletionGeneration: 0,
        fingerprintKeyVersion: "account-memory-test-v1",
        normalizationVersion: "account-memory-test-v1",
        scope: "ALL",
        userId
      }
    });
    await tx.memorySourceBarrier.create({
      data: {
        kind: "ALL_REUSABLE",
        memoryGeneration: 0,
        sourceCreatedAtCutoff: input.now,
        userId
      }
    });
    await tx.memoryJob.create({
      data: {
        acceptedResultHash: state === "SUCCEEDED" ? "d".repeat(64) : null,
        completedAt: input.now,
        id: jobId,
        idempotencyFingerprint: memorySha256({ jobId, userId }),
        kind: "RECALCULATE_WORKING_SET",
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        pipelineVersion: "account-memory-test-v1",
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: state === "SUCCEEDED" ? executionOutputHash : null,
        completedAt: input.now,
        connectionId: provider.connectionId,
        createdAt: startedAt,
        credentialId: provider.credentialId,
        credentialVersionId: provider.credentialVersionId,
        destinationFingerprint: "e".repeat(64),
        errorCode: state === "OUTCOME_UNKNOWN" ? "provider_outcome_unknown" : null,
        id: bindingId,
        inputHash: executionInputHash,
        logicalRole: "MEMORY_PROFILE",
        memoryJobId: jobId,
        ordinal: 0,
        ownerType: "JOB",
        pipelineVersion: "account-memory-test-v1",
        policyVersion: "account-memory-test-v1",
        promptVersion: "account-memory-test-v1",
        providerId: "openai_compatible",
        providerModelId: provider.modelId,
        providerResponseId: `account-memory-response-${randomUUID()}`,
        recoverableUntil,
        schemaVersion: "account-memory-test-v1",
        secretFreeExecutionSnapshot: { schemaVersion: "account-memory-test-v1" },
        startedAt,
        state,
        userId
      }
    });
    await tx.usageEvent.create({
      data: {
        memoryExecutionBindingId: bindingId,
        modelId: embeddingConfiguration.upstreamModelId,
        provider: "openai_compatible",
        providerModelId: provider.modelId,
        userId
      }
    });
    if (state === "SUCCEEDED") {
      const profile = await tx.memoryProfileProjection.create({
        data: {
          asOf: startedAt,
          createdAt: input.now,
          createdByExecutionId: bindingId,
          inputHash: executionInputHash,
          languageCode: "ru",
          memoryGeneration: 0,
          memoryRevision: 0,
          outputHash: executionOutputHash,
          projectionVersion: "account-memory-test-v1",
          redactionState: "NOT_NEEDED",
          safeContentHash: "3".repeat(64),
          safetyClass: "NORMAL",
          safetyIdentitySnapshot: "4".repeat(64),
          scopeId,
          sourceIdentitySnapshot: "5".repeat(64),
          state: "ACTIVE",
          summary: statement,
          suppressionIdentitySnapshot: "6".repeat(64),
          updatedAt: input.now,
          userId
        }
      });
      await tx.memoryProfileProjectionFact.create({
        data: {
          factId,
          factVersionContentHash: memorySha256(statement),
          factVersionId: versionId,
          ordinal: 0,
          projectionId: profile.id,
          safetyIdentitySnapshot: "a".repeat(64),
          sourceIdentitySnapshot: "b".repeat(64),
          suppressionIdentitySnapshot: "c".repeat(64),
          userId
        }
      });
    }
  });

  const feedback = createPrismaMemoryFeedbackRepository(prisma);
  const original = await feedback.record(userId, factId, {
    comment: "Неактуально",
    expectedVersionId: versionId,
    feedbackType: "OUTDATED",
    requestId: randomUUID()
  });
  await feedback.record(userId, factId, {
    expectedVersionId: versionId,
    feedbackType: "RETRACT",
    requestId: randomUUID(),
    retractsFeedbackId: original.feedbackId
  });
  return { bindingId, factId, jobId, versionId };
}

function coordinatorFor(
  registry: MemoryCoordinatorRegistry,
  now: () => Date
): MemoryCoordinator {
  return new MemoryCoordinator({
    now,
    policy: {
      blockedDeletionRetryMs: 1_000,
      deletionFastRetryDelaysMs: [100],
      heartbeatMs: 5_000,
      intervalMs: 60_000,
      leaseMs: 30_000,
      maxDeletionFastAttempts: 2,
      maxDeletionParallel: 1,
      maxJobAttempts: 1,
      maxJobParallel: 1,
      reconciliationBatchSize: 10
    },
    registry,
    repository: createPrismaMemoryCoordinatorRepository(prisma)
  });
}

async function claimFor(deletionId: string): Promise<MemoryDeletionClaim> {
  const row = await prisma.memoryDeletionOutbox.findUniqueOrThrow({
    where: { id: deletionId }
  });
  return {
    admissionAuthorizationId: row.admissionAuthorizationId,
    admittedActiveLeafMessageId: row.admittedActiveLeafMessageId,
    admittedChatSourceRevision: row.admittedChatSourceRevision,
    alsoForgetOriginMemories: row.alsoForgetOriginMemories,
    attemptCount: row.attemptCount,
    claimToken: "idempotency-audit",
    id: row.id,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    memoryGeneration: row.memoryGeneration,
    operation: row.operation,
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: row.targetId,
    targetType: row.targetType,
    userId: row.userId
  };
}

describe("Prisma account Memory deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps the stale-user path zero-mutation before composition", async () => {
    const userId = await createOwner("disabled");
    const registry = new AccountMemoryDeletionRegistry();
    try {
      await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId }
      });
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(createPrismaAdminRepository(prisma, {
        accountMemoryDeletionRegistry: registry
      }).deleteStaleUser({
        actingAdminUserId: `admin-${randomUUID()}`,
        userId
      })).resolves.toBe("user_has_owned_data");
      expect(await prisma.userMemorySettings.findUnique({ where: { userId } }))
        .toEqual(before);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryScope.count({ where: { userId } })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("keeps a composed but rolled-back account gate zero-mutation", async () => {
    const userId = await createOwner("disabled");
    const registry = new AccountMemoryDeletionRegistry();
    const kick = vi.fn();
    registry.register(createAccountMemoryDeletionHook({
      admissionEnabled: () => false,
      kick
    }));
    try {
      await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId }
      });
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(createPrismaAdminRepository(prisma, {
        accountMemoryDeletionRegistry: registry
      }).deleteStaleUser({
        actingAdminUserId: `admin-${randomUUID()}`,
        userId
      })).resolves.toBe("user_has_owned_data");
      expect(kick).not.toHaveBeenCalled();
      expect(await prisma.userMemorySettings.findUnique({ where: { userId } }))
        .toEqual(before);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("does not admit Memory cleanup through an unrelated global owned-data blocker", async () => {
    const userId = await createOwner("disabled");
    const registry = new AccountMemoryDeletionRegistry();
    const advance = vi.fn(async () => ({
      admitted: true,
      readyForUserDeletion: false
    }));
    registry.register({ advance, kick: vi.fn() });
    try {
      await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId }
      });
      await prisma.chat.create({ data: { title: "Global blocker", userId } });
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(createPrismaAdminRepository(prisma, {
        accountMemoryDeletionRegistry: registry
      }).deleteStaleUser({
        actingAdminUserId: `admin-${randomUUID()}`,
        userId
      })).resolves.toBe("user_has_owned_data");
      expect(advance).not.toHaveBeenCalled();
      expect(await prisma.userMemorySettings.findUnique({ where: { userId } }))
        .toEqual(before);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("fences, detaches provider evidence, purges derivatives, audits idempotently, and finalizes globally", async () => {
    let clock = new Date(Date.now() - 60_000);
    const provider = await createProviderFixture(clock);
    const userId = await createOwner();
    const accountRegistry = new AccountMemoryDeletionRegistry();
    const coordinatorRegistry = new MemoryCoordinatorRegistry();
    const handler = createPrismaAccountMemoryDeletionHandler();
    coordinatorRegistry.registerDeletion(handler);
    const coordinator = coordinatorFor(coordinatorRegistry, () => new Date(clock));
    const kick = vi.fn();
    let admissionEnabled = true;
    accountRegistry.register(createAccountMemoryDeletionHook({
      admissionEnabled: () => admissionEnabled,
      kick
    }));
    const admin = createPrismaAdminRepository(prisma, {
      accountMemoryDeletionRegistry: accountRegistry
    });
    try {
      const fixture = await populateReusableMemory(userId, provider, { now: clock });
      await prisma.user.update({ data: { status: "disabled" }, where: { id: userId } });
      expect(await countAccountMemoryOwnedData(prisma, userId)).toBeGreaterThan(0);

      const cleanupStartedAt = performance.now();
      await expect(admin.deleteStaleUser({
        actingAdminUserId: `admin-${randomUUID()}`,
        userId
      })).resolves.toBe("user_has_owned_data");
      expect(kick).toHaveBeenCalledOnce();
      const admitted = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "ACCOUNT_MEMORY_DELETE", userId }
      });
      expect(admitted).toMatchObject({
        state: "PENDING",
        targetId: userId,
        targetType: ACCOUNT_MEMORY_DELETION_TARGET_TYPE
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({
          activeIndexGenerationId: null,
          embeddingProviderModelId: null,
          learnAutomatically: false,
          referenceChatHistory: false,
          useMemoryFacts: false
        });

      admissionEnabled = false;
      await coordinator.reconcileNow();
      const succeeded = await prisma.memoryDeletionOutbox.findUniqueOrThrow({
        where: { id: admitted.id }
      });
      expect(succeeded.state).toBe("SUCCEEDED");
      expect(await prisma.memoryFact.count({ where: { userId } })).toBe(0);
      expect(await prisma.memoryFeedback.count({ where: { userId } })).toBe(0);
      expect(await prisma.memoryProfileProjection.count({ where: { userId } })).toBe(0);
      expect(await prisma.memorySearchEntry.count({ where: { userId } })).toBe(0);
      expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({
        where: { id: fixture.bindingId }
      })).toMatchObject({
        connectionId: null,
        credentialId: null,
        credentialVersionId: null,
        providerModelId: null,
        providerResponseId: null,
        relationsDetachedAt: clock
      });
      const evidence = Object.freeze({
        cleanupLatencyMs: Number((performance.now() - cleanupStartedAt).toFixed(2)),
        evidenceVersion: "memory-phase8-account-cleanup-v1",
        maximumCleanupLatencyMs: 15 * 60_000,
        providerEvidenceDetached: true,
        sanitizedAggregatesOnly: true
      });
      expect(evidence.cleanupLatencyMs).toBeLessThan(evidence.maximumCleanupLatencyMs);
      expect(JSON.stringify(evidence)).not.toContain(userId);
      expect(JSON.stringify(evidence)).not.toContain(provider.connectionId);
      console.info("memory_phase8_account_cleanup", evidence);

      const replayClaim = await claimFor(admitted.id);
      const replay = await handler.execute(replayClaim, {
        now: () => new Date(clock),
        signal: new AbortController().signal
      });
      await expect(prisma.$transaction((tx) => replay.apply!(tx, replayClaim)))
        .resolves.toBeUndefined();

      await expect(admin.deleteStaleUser({
        actingAdminUserId: `admin-${randomUUID()}`,
        userId
      })).resolves.toBe("deleted");
      await expect(prisma.user.findUnique({ where: { id: userId } })).resolves.toBeNull();
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryExecutionBinding.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.usageEvent.count({ where: { userId } })).resolves.toBe(0);
    } finally {
      coordinator.stop();
      await cleanupOwner(userId);
      await cleanupProvider(provider);
    }
  });

  it("keeps uncertain provider calls attached and leaves the purge retryable until honest recovery", async () => {
    let clock = new Date(Date.now() - 60_000);
    const provider = await createProviderFixture(clock);
    const userId = await createOwner();
    const accountRegistry = new AccountMemoryDeletionRegistry();
    const coordinatorRegistry = new MemoryCoordinatorRegistry();
    coordinatorRegistry.registerDeletion(createPrismaAccountMemoryDeletionHandler());
    const coordinator = coordinatorFor(coordinatorRegistry, () => new Date(clock));
    accountRegistry.register(createAccountMemoryDeletionHook({ kick: () => undefined }));
    const admin = createPrismaAdminRepository(prisma, {
      accountMemoryDeletionRegistry: accountRegistry
    });
    try {
      const fixture = await populateReusableMemory(userId, provider, {
        executionState: "OUTCOME_UNKNOWN",
        now: clock
      });
      await prisma.user.update({ data: { status: "disabled" }, where: { id: userId } });
      await admin.deleteStaleUser({
        actingAdminUserId: `admin-${randomUUID()}`,
        userId
      });
      await coordinator.reconcileNow();
      const blocked = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "ACCOUNT_MEMORY_DELETE", userId }
      });
      expect(blocked).toMatchObject({
        errorCode: "memory_account_execution_recovery_pending",
        state: "RETRY_WAIT"
      });
      expect(await prisma.memoryFact.count({ where: { id: fixture.factId, userId } })).toBe(1);
      expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({
        where: { id: fixture.bindingId }
      })).toMatchObject({
        connectionId: provider.connectionId,
        providerModelId: provider.modelId,
        relationsDetachedAt: null,
        state: "OUTCOME_UNKNOWN"
      });

      clock = new Date(clock.getTime() + 2 * 24 * 60 * 60 * 1_000);
      await prisma.memoryExecutionBinding.update({
        data: {
          errorCode: "provider_recovered_failed",
          recoverableUntil: new Date(clock.getTime() - 1),
          state: "FAILED"
        },
        where: { id: fixture.bindingId }
      });
      await coordinator.reconcileNow();
      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({
        where: { id: blocked.id }
      })).resolves.toMatchObject({ errorCode: null, state: "SUCCEEDED" });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({
        where: { id: fixture.bindingId }
      })).resolves.toMatchObject({
        connectionId: null,
        relationsDetachedAt: clock,
        state: "FAILED"
      });
    } finally {
      coordinator.stop();
      await cleanupOwner(userId);
      await cleanupProvider(provider);
    }
  });
});
