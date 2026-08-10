import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION
} from "../../../contracts/memory";
import type {
  MemoryCapabilityQualification,
  MemoryQualificationRequirement
} from "../../../evaluation/memory/qualification";
import { canonicalMemoryQualificationPayload } from
  "../../../evaluation/memory/qualification";
import { prisma } from "../../prisma";
import { EmbeddingAdapterError } from "../../providers/embeddings";
import { MemoryCoordinator } from "../coordinator/coordinator";
import { createPrismaMemoryCoordinatorRepository } from
  "../coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from "../coordinator/registry";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { createExplicitMemoryService } from "../explicit/service";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  memoryVectorSpaceFingerprint,
  resolveCurrentMemoryUtilityPolicy
} from "../execution/policy";
import { createPrismaMemoryLifecycleRepository } from "../lifecycle/repository";
import { createMemoryLifecycleService } from "../lifecycle/service";
import { createPrismaMemoryMutationAuthorizationRepository } from
  "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256
} from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS } from "../purge/contract";
import { registerPhase2MemoryDeletionContributors } from "../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  MEMORY_EXPLICIT_EMBEDDING_VERSIONS,
  createPrismaMemoryExplicitEmbeddingHandler
} from ".";

const INITIAL_NOW = new Date("2026-08-10T12:00:00.000Z");
const HMAC_KEY = Buffer.from("memory-explicit-embedding-test-key", "utf8");
const CORPUS_HASH = "c".repeat(64);
const DIMENSION = 1_024;
const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 41));
const keyring = MemorySuppressionKeyring.parse(
  `current=embedding-v1,embedding-v1=${keyBytes.toString("base64")}`
);

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
    nativeDimension: DIMENSION,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: DIMENSION
  },
  modelClass: "embedding",
  upstreamModelId: "memory-explicit-embedding-v1"
} as const;

function signQualification(
  requirement: MemoryQualificationRequirement
): MemoryCapabilityQualification {
  const unsigned: MemoryCapabilityQualification = {
    approval: {
      approvalId: "memory-explicit-embedding-approval-v1",
      approved: true,
      approvedAt: "2026-08-10T00:00:00.000Z",
      approvedBy: "memory-test-operator",
      expiresAt: "2026-09-10T00:00:00.000Z",
      signature: "pending"
    },
    evidenceDigest: "e".repeat(64),
    key: requirement,
    qualificationId: "memory-explicit-embedding-qualification-v1"
  };
  return {
    ...unsigned,
    approval: {
      ...unsigned.approval,
      signature: createHmac("sha256", HMAC_KEY)
        .update(canonicalMemoryQualificationPayload(unsigned), "utf8")
        .digest("hex")
    }
  };
}

function phase2Registry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerPhase2MemoryDeletionContributors(registry);
  return registry;
}

function memoryServices() {
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const explicit = createExplicitMemoryService({
    authorizationRepository,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository,
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
  });
  const lifecycle = createMemoryLifecycleService({
    authorizationRepository,
    mutationRepository: createPrismaMemoryLifecycleRepository(
      keyring,
      phase2Registry(),
      prisma
    ),
    readRepository
  });
  return { explicit, lifecycle, readRepository };
}

async function saveExplicit(
  explicit: ReturnType<typeof memoryServices>["explicit"],
  userId: string,
  statement: string,
  nonce: string
) {
  const authorization = await explicit.mintAuthorization(userId, {
    action: "SAVE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement),
    requestNonce: nonce
  });
  return explicit.create(userId, {
    mutationAuthorizationId: authorization.mutationAuthorizationId,
    scope: { type: "GLOBAL_USER" },
    statement
  });
}

async function createFixture() {
  const suffix = randomUUID();
  const userId = `memory-explicit-embedding-user-${suffix}`;
  const connectionId = `memory-explicit-embedding-connection-${suffix}`;
  const credentialId = `memory-explicit-embedding-credential-${suffix}`;
  const credentialVersionId = `memory-explicit-embedding-version-${suffix}`;
  const modelId = `memory-explicit-embedding-model-${suffix}`;
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://memory-provider.example.test/v1",
    responseTimeoutMs: 30_000
  };

  await prisma.user.create({
    data: {
      displayName: "Memory explicit embedding owner",
      email: `memory-explicit-embedding-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.providerConnection.create({
    data: {
      activeConfig: connectionConfiguration,
      activeVersion: 1,
      activatedAt: INITIAL_NOW,
      displayName: "Memory explicit embedding provider",
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
      label: "Memory explicit embedding account",
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
      contextWindow: 32_768,
      defaultParams: {},
      displayName: "Memory explicit embedding model",
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
    data: { embeddingProviderModelId: modelId, useMemoryFacts: true },
    where: { userId }
  });

  const policy = await prisma.$transaction(async (tx) => {
    const settings = await tx.userMemorySettings.findUniqueOrThrow({
      where: { userId }
    });
    return resolveCurrentMemoryUtilityPolicy(tx, userId, settings);
  });
  const target = policy.targets.get("MEMORY_DOCUMENT_EMBED");
  if (!target) throw new Error("memory_embedding_test_target_unavailable");
  const vectorSpaceFingerprint = memoryVectorSpaceFingerprint(target);
  if (!vectorSpaceFingerprint) {
    throw new Error("memory_embedding_test_vector_space_unavailable");
  }
  const generation = await prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
      embeddingConfigurationFingerprint:
        target.qualificationFingerprints.configFingerprint,
      embeddingConnectionId: connectionId,
      embeddingDimension: DIMENSION,
      embeddingProviderModelId: modelId,
      generation: 0,
      indexMode: "HYBRID",
      indexedThroughMemoryRevision: 0,
      languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
      normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
      readyAt: INITIAL_NOW,
      retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
      state: "READY",
      targetMemoryRevision: 0,
      userId,
      vectorSpaceFingerprint
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({
      data: { activeIndexGenerationId: generation.id },
      where: { userId }
    });
    await tx.memoryIndexGeneration.update({
      data: { activatedAt: INITIAL_NOW, state: "ACTIVE" },
      where: { id: generation.id }
    });
  });
  const requirement: MemoryQualificationRequirement = {
    ...target.qualificationFingerprints,
    corpusHash: CORPUS_HASH,
    corpusVersion: "memory-explicit-embedding-corpus-v1",
    language: "RU",
    ...MEMORY_EXPLICIT_EMBEDDING_VERSIONS,
    role: "MEMORY_DOCUMENT_EMBED",
    scorerVersion: "memory-explicit-embedding-scorer-v1",
    suiteVersion: "memory-explicit-embedding-suite-v1",
    vectorSpaceFingerprint
  };
  return {
    connectionId,
    credentialId,
    credentialVersionId,
    generationId: generation.id,
    modelId,
    policy,
    qualification: signQualification(requirement),
    userId,
    async cleanup() {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
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

function vectorResult() {
  const vector = Array.from({ length: DIMENSION }, (_, index) => index === 0 ? 1 : 0);
  return {
    model: embeddingConfiguration.upstreamModelId,
    requestId: `embedding-request-${randomUUID()}`,
    usage: { inputTokens: 7, totalTokens: 7 },
    vectors: [vector]
  };
}

describe("Prisma explicit Memory vector enrichment", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps lexical recall available across consent, outage, rotation, and Forget races", async () => {
    const fixture = await createFixture();
    const { explicit, lifecycle, readRepository } = memoryServices();
    let clock = new Date(INITIAL_NOW);
    let behavior: "DEFER" | "HTTP_FAILURE" | "SUCCESS" = "SUCCESS";
    let releaseDeferred: () => void = () => {
      throw new Error("memory_embedding_test_release_unavailable");
    };
    let announceDeferred: (() => void) | null = null;
    const embed = vi.fn(async () => {
      if (behavior === "HTTP_FAILURE") {
        throw new EmbeddingAdapterError("embedding_provider_http_error");
      }
      if (behavior === "DEFER") {
        announceDeferred?.();
        await new Promise<void>((resolve) => {
          releaseDeferred = resolve;
        });
      }
      return vectorResult();
    });
    const authority = {
      now: () => new Date(clock),
      qualification: {
        corpusHash: CORPUS_HASH,
        corpusVersion: "memory-explicit-embedding-corpus-v1",
        registry: [fixture.qualification],
        scorerVersion: "memory-explicit-embedding-scorer-v1",
        suiteVersion: "memory-explicit-embedding-suite-v1",
        verifySignature: (payload: string, signature: string) =>
          createHmac("sha256", HMAC_KEY).update(payload, "utf8").digest("hex") ===
            signature
      }
    };
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(createPrismaMemoryExplicitEmbeddingHandler(
      authority,
      prisma,
      {
        runtime: {
          resolve: vi.fn(async () => ({ adapter: { embed } }))
        } as never
      }
    ));
    const coordinator = new MemoryCoordinator({
      now: () => new Date(clock),
      policy: {
        heartbeatMs: 1_000,
        jobRetryDelaysMs: [1],
        leaseMs: 5_000,
        maxJobParallel: 1
      },
      registry,
      repository: createPrismaMemoryCoordinatorRepository(prisma)
    });

    try {
      const firstStatement = "I prefer jasmine tea in the afternoon.";
      const first = await saveExplicit(
        explicit,
        fixture.userId,
        firstStatement,
        "embedding-consent-save"
      );
      const firstEntry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: first.memory.currentVersionId! }
      });
      const firstJob = await prisma.memoryJob.findFirstOrThrow({
        where: {
          idempotencyFingerprint: { startsWith: "memory-explicit-embed-v1:" },
          userId: fixture.userId
        }
      });
      expect(firstEntry.embeddingState).toBe("PENDING");
      await expect(readRepository.search(fixture.userId, {
        query: "jasmine tea"
      })).resolves.toMatchObject({
        memories: [expect.objectContaining({ id: first.memory.id })]
      });

      await coordinator.reconcileNow();
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: firstJob.id } }))
        .resolves.toMatchObject({ state: "WAITING_FOR_EGRESS_CONSENT" });
      expect(embed).not.toHaveBeenCalled();
      await expect(prisma.memoryExecutionBinding.count({
        where: { memoryJobId: firstJob.id }
      })).resolves.toBe(0);

      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: clock,
          acceptedUtilityEgressFingerprint: fixture.policy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      await coordinator.reconcileNow();
      const [firstReady, firstSettled, firstBindings, firstUsage, afterFirst] =
        await Promise.all([
          prisma.memorySearchEntry.findUniqueOrThrow({ where: { id: firstEntry.id } }),
          prisma.memoryJob.findUniqueOrThrow({ where: { id: firstJob.id } }),
          prisma.memoryExecutionBinding.findMany({ where: { memoryJobId: firstJob.id } }),
          prisma.usageEvent.findMany({
            where: { memoryExecutionBindingId: { not: null }, userId: fixture.userId }
          }),
          prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: fixture.userId } })
        ]);
      expect(firstReady).toMatchObject({
        embeddingDimension: DIMENSION,
        embeddingState: "READY"
      });
      expect(firstSettled.state).toBe("SUCCEEDED");
      expect(firstBindings).toHaveLength(1);
      expect(firstBindings[0]).toMatchObject({ state: "SUCCEEDED" });
      expect(firstUsage).toHaveLength(1);
      expect(afterFirst.memoryRevision).toBe(2);

      behavior = "HTTP_FAILURE";
      const outageStatement = "I prefer aisle seats on daytime trains.";
      const outage = await saveExplicit(
        explicit,
        fixture.userId,
        outageStatement,
        "embedding-outage-save"
      );
      const outageEntry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: outage.memory.currentVersionId! }
      });
      const outageJob = await prisma.memoryJob.findFirstOrThrow({
        where: {
          idempotencyFingerprint: {
            startsWith: `memory-explicit-embed-v1:${outageEntry.id}:`
          },
          userId: fixture.userId
        }
      });
      await coordinator.reconcileNow();
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({
        where: { id: outageEntry.id }
      })).resolves.toMatchObject({ embeddingState: "FAILED" });
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: outageJob.id } }))
        .resolves.toMatchObject({ state: "RETRYABLE_FAILED" });
      await expect(readRepository.search(fixture.userId, { query: "aisle seats" }))
        .resolves.toMatchObject({
          memories: [expect.objectContaining({ id: outage.memory.id })]
        });
      const afterFailure = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: fixture.userId }
      });
      expect(afterFailure.memoryRevision).toBe(4);

      const replacementCredentialVersionId =
        `memory-explicit-embedding-version-2-${randomUUID()}`;
      await prisma.providerCredentialVersion.create({
        data: {
          activatedAt: clock,
          credentialId: fixture.credentialId,
          id: replacementCredentialVersionId,
          secretEnvelope: "test-only-replacement-envelope",
          testedAt: clock,
          testEvidence: { authenticationMode: "bearer" },
          version: 2
        }
      });
      await prisma.providerCredential.update({
        data: { activeVersionId: replacementCredentialVersionId },
        where: { id: fixture.credentialId }
      });
      await prisma.providerModelCredentialCheck.create({
        data: {
          checkedAt: clock,
          connectionId: fixture.connectionId,
          connectionVersion: 1,
          credentialId: fixture.credentialId,
          credentialVersionId: replacementCredentialVersionId,
          evidence: { detail: "ok" },
          modelVersion: 1,
          providerModelId: fixture.modelId,
          status: "available"
        }
      });
      behavior = "SUCCESS";
      clock = new Date(clock.getTime() + 10);
      await coordinator.reconcileNow();
      const [outageReady, outageBindings, outageUsage, afterRetry] = await Promise.all([
        prisma.memorySearchEntry.findUniqueOrThrow({ where: { id: outageEntry.id } }),
        prisma.memoryExecutionBinding.findMany({
          orderBy: { ordinal: "asc" },
          where: { memoryJobId: outageJob.id }
        }),
        prisma.usageEvent.findMany({
          where: {
            memoryExecutionBindingId: { not: null },
            userId: fixture.userId
          }
        }),
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: fixture.userId } })
      ]);
      expect(outageReady).toMatchObject({
        embeddingDimension: DIMENSION,
        embeddingState: "READY"
      });
      expect(outageBindings).toHaveLength(2);
      expect(outageBindings.map(({ state }) => state)).toEqual(["FAILED", "SUCCEEDED"]);
      expect(outageBindings.map(({ credentialVersionId }) => credentialVersionId))
        .toEqual([fixture.credentialVersionId, replacementCredentialVersionId]);
      expect(outageUsage.filter(({ memoryExecutionBindingId }) =>
        outageBindings.some(({ id }) => id === memoryExecutionBindingId))).toHaveLength(2);
      expect(afterRetry.memoryRevision).toBe(5);
      expect(await prisma.memoryIndexGeneration.count({
        where: { userId: fixture.userId }
      })).toBe(1);

      behavior = "DEFER";
      const staleStatement = "I prefer rooms away from the elevator.";
      const stale = await saveExplicit(
        explicit,
        fixture.userId,
        staleStatement,
        "embedding-stale-save"
      );
      const staleEntry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: stale.memory.currentVersionId! }
      });
      const staleJob = await prisma.memoryJob.findFirstOrThrow({
        where: {
          idempotencyFingerprint: {
            startsWith: `memory-explicit-embed-v1:${staleEntry.id}:`
          },
          userId: fixture.userId
        }
      });
      let announce!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        announce = resolve;
      });
      announceDeferred = announce;
      const running = coordinator.reconcileNow();
      await providerStarted;

      const authorization = await explicit.mintAuthorization(fixture.userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: stale.memory.currentVersionId!,
        requestNonce: "embedding-stale-forget",
        targetFactId: stale.memory.id
      });
      await lifecycle.forget(fixture.userId, stale.memory.id, {
        expectedVersionId: stale.memory.currentVersionId!,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      });
      releaseDeferred();
      await running;
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: staleJob.id } }))
        .resolves.toMatchObject({ state: "STALE" });
      await expect(prisma.memorySearchEntry.count({ where: { id: staleEntry.id } }))
        .resolves.toBe(0);
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: stale.memory.id } }))
        .resolves.toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
      const staleBindings = await prisma.memoryExecutionBinding.findMany({
        where: { memoryJobId: staleJob.id }
      });
      expect(staleBindings).toHaveLength(1);
      expect(staleBindings[0]).toMatchObject({ state: "SUCCEEDED" });
      await expect(prisma.usageEvent.count({
        where: { memoryExecutionBindingId: staleBindings[0]!.id }
      })).resolves.toBe(1);
      const callCount = embed.mock.calls.length;
      await coordinator.reconcileNow();
      expect(embed).toHaveBeenCalledTimes(callCount);
    } finally {
      coordinator.stop();
      await fixture.cleanup();
    }
  });
});
