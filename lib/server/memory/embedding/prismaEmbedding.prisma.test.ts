import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION
} from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
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
import { memoryExecutionSha256 } from "../execution/canonical";
import { createPrismaMemoryLifecycleRepository } from "../lifecycle/repository";
import { createMemoryLifecycleService } from "../lifecycle/service";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import {
  MEMORY_HISTORY_SOURCE_PROJECTION_VERSION
} from "../history/sourceProjection";
import { createPrismaMemoryMutationAuthorizationRepository } from
  "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  memoryStatementClassificationDecision,
  memoryStatementClassificationInputHash,
  type MemoryStatementClassifier
} from "../explicit/statementClassifier";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "../purge/contract";
import { registerMemoryDeletionContributors } from "../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryItemEmbeddingJobFingerprint
} from "./contract";
import { createPrismaMemoryItemEmbeddingHandler } from "./handler";
import { createPrismaMemoryEmbeddingHandler } from "./compositeHandler";
import { createPrismaMemoryEmbeddingBatchRepository } from "./batchRepository";
import { enqueueMemoryEmbeddingBatchItems } from "./enqueue";
import { createPrismaMemoryItemEmbeddingRepository } from "./repository";
import { createPrismaMemoryJobRepository } from "@/tests/support/memoryPersistence";

const INITIAL_NOW = new Date("2026-08-10T12:00:00.000Z");
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

const statementClassifierConfiguration = {
  adapterKind: "openai_responses_compatible",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    structuredOutput: true,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "memory-statement-classifier-v1"
} as const;

function purgeRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return registry;
}

function createFixtureStatementClassifier(authority: Readonly<{
  connectionId: string;
  credentialId: string;
  modelId: string;
}>): MemoryStatementClassifier {
  return Object.freeze({
    async classify(statement, options) {
      const execution = options?.execution;
      if (!execution) throw new Error("memory_embedding_classifier_execution_missing");
      const executionId = randomUUID();
      const inputHash = memoryStatementClassificationInputHash(statement);
      const decision = {
        category: "preferences" as const,
        normalizedStatement: statement,
        reasonCode: "response_preference" as const,
        responsePreference: true,
        sensitivity: "NORMAL" as const,
        storageDecision: "ALLOW" as const
      };
      const acceptedOutputHash = memoryExecutionSha256({
        inputHash,
        output: memoryStatementClassificationDecision(decision),
        role: "MEMORY_STATEMENT_CLASSIFY",
        version: 1
      });
      const startedAt = new Date();
      const completedAt = new Date(startedAt.getTime() + 1);
      const credential = await prisma.providerCredential.findUniqueOrThrow({
        select: { activeVersionId: true },
        where: { id: authority.credentialId }
      });
      if (!credential.activeVersionId) {
        throw new Error("memory_embedding_classifier_credential_missing");
      }
      await prisma.$transaction(async (tx) => {
        await tx.memoryExecutionBinding.create({
          data: {
            acceptedOutputHash,
            cachedInputTokens: 0,
            completedAt,
            createdAt: startedAt,
            destinationFingerprint: memorySha256({
              modelId: authority.modelId,
              role: "MEMORY_STATEMENT_CLASSIFY"
            }),
            id: executionId,
            inputHash,
            inputTokens: 0,
            logicalRole: "MEMORY_STATEMENT_CLASSIFY",
            mutationAuthorizationId: execution.mutationAuthorizationId,
            ordinal: 0,
            outputTokens: 0,
            ownerType: "MUTATION_AUTHORIZATION",
            pipelineVersion: "memory-statement-classification-v1",
            policyVersion: "memory-statement-safety-policy-v1",
            promptVersion: "memory-statement-safety-prompt-v1",
            providerId: "openai_compatible",
            providerModelId: authority.modelId,
            providerResponseId: `memory-embedding-classifier-${randomUUID()}`,
            reasoningTokens: 0,
            recoverableUntil: new Date(completedAt.getTime() + 86_400_000),
            connectionId: authority.connectionId,
            credentialId: authority.credentialId,
            credentialVersionId: credential.activeVersionId,
            schemaVersion: "memory-statement-safety-schema-v1",
            secretFreeExecutionSnapshot: {
              providerExecutionSnapshot: {
                providerFamily: "openai_compatible",
                providerModelId: authority.modelId
              },
              version: 1
            },
            startedAt,
            state: "SUCCEEDED",
            totalTokens: 0,
            usageCompleteness: "COMPLETE",
            userId: execution.userId
          }
        });
        await tx.usageEvent.create({
          data: {
            cachedInputTokens: 0,
            inputTokens: 0,
            memoryExecutionBindingId: executionId,
            modelId: authority.modelId,
            outputTokens: 0,
            provider: "openai_compatible",
            providerModelId: authority.modelId,
            reasoningTokens: 0,
            totalTokens: 0,
            userId: execution.userId
          }
        });
      });
      return {
        acceptedOutputHash,
        classifiedAt: completedAt,
        ...decision,
        executionId,
        inputHash,
        modelId: authority.modelId,
        policyVersion: "memory-statement-safety-policy-v1",
        providerId: "openai_compatible"
      };
    }
  });
}

function memoryServices(classifierAuthority: Parameters<
  typeof createFixtureStatementClassifier
>[0]) {
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const explicit = createExplicitMemoryService({
    authorizationRepository,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository,
    scopeRepository: createPrismaMemoryScopeRepository(prisma),
    statementClassifier: createFixtureStatementClassifier(classifierAuthority)
  });
  const lifecycle = createMemoryLifecycleService({
    authorizationRepository,
    mutationRepository: createPrismaMemoryLifecycleRepository(
      keyring,
      purgeRegistry(),
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

async function saveLegacyExplicit(
  userId: string,
  scopeId: string,
  statement: string,
  nonce: string,
  classifierAuthority: Parameters<typeof createFixtureStatementClassifier>[0]
) {
  const authorizationId = `legacy-authorization-${nonce}`;
  const classification = await createFixtureStatementClassifier(
    classifierAuthority
  ).classify(statement, {
    execution: { mutationAuthorizationId: authorizationId, userId }
  });
  if (!classification.acceptedOutputHash || !classification.executionId ||
    !classification.inputHash || !classification.classifiedAt) {
    throw new Error("memory_embedding_legacy_classifier_provenance_missing");
  }
  const saved = await createPrismaMemoryFactRepository(keyring, prisma, {
    consumeExplicitAuthorization: async () => undefined
  }).save(userId, {
    authorization: {
      action: "SAVE",
      authorizationId,
      authorizedPayloadHash: memorySha256({ nonce, statement })
    },
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: new Date("2026-08-21T08:00:00.000Z"),
      safeExcerpt: statement,
      safeSourceHash: memorySha256(statement),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-embedding-legacy-test-v1"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint: `legacy-save-${nonce}`,
    requestId: `legacy-request-${nonce}`,
    scopeId,
    value: {
      canonicalKey: `legacy.embedding.${nonce}`,
      category: "preferences",
      confidence: 1,
      directness: "DIRECT",
      displayText: statement,
      importance: 0.8,
      languageCode: "en",
      modality: "PREFERENCE",
      pipelineVersion: "memory-embedding-legacy-test-v1",
      safetyClassification: {
        acceptedOutputHash: classification.acceptedOutputHash,
        decision: memoryStatementClassificationDecision(classification),
        displayProjection: "CLASSIFIER_NORMALIZED",
        executionId: classification.executionId,
        inputHash: classification.inputHash,
        inputStatement: statement,
        kind: "STATEMENT"
      },
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      structuredValue: { statement }
    }
  });
  await prisma.memoryExecutionBinding.update({
    data: {
      connectionId: null,
      credentialId: null,
      credentialVersionId: null,
      providerModelId: null,
      providerResponseId: null,
      recoverableUntil: classification.classifiedAt,
      relationsDetachedAt: classification.classifiedAt
    },
    where: { id: classification.executionId }
  });
  return saved;
}

async function createFixture(
  options: Readonly<{ retrievalPipelineVersion?: string }> = {}
) {
  const suffix = randomUUID();
  const userId = `memory-explicit-embedding-user-${suffix}`;
  const connectionId = `memory-explicit-embedding-connection-${suffix}`;
  const credentialId = `memory-explicit-embedding-credential-${suffix}`;
  const credentialVersionId = `memory-explicit-embedding-version-${suffix}`;
  const modelId = `memory-explicit-embedding-model-${suffix}`;
  const classifierModelId = `memory-explicit-classifier-model-${suffix}`;
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://memory-provider.example.test/v1",
    authenticationMode: "bearer",
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
  await prisma.providerModel.create({
    data: {
      activeConfig: statementClassifierConfiguration,
      activeVersion: 1,
      activatedAt: INITIAL_NOW,
      capabilities: statementClassifierConfiguration.capabilities,
      connectionId,
      defaultParams: {},
      displayName: "Memory explicit statement classifier",
      draftConfig: statementClassifierConfiguration,
      draftVersion: 1,
      enabled: true,
      id: classifierModelId,
      modelClass: "answer",
      modelId: statementClassifierConfiguration.upstreamModelId,
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
  await prisma.providerModelCredentialCheck.create({
    data: {
      checkedAt: INITIAL_NOW,
      connectionId,
      connectionVersion: 1,
      credentialId,
      credentialVersionId,
      evidence: { detail: "ok" },
      modelVersion: 1,
      providerModelId: classifierModelId,
      status: "available"
    }
  });
  await prisma.accessGrant.create({
    data: { enabled: true, providerModelId: modelId, userId }
  });
  await prisma.accessGrant.create({
    data: { enabled: true, providerModelId: classifierModelId, userId }
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
        target.compatibilityFingerprints.configFingerprint,
      embeddingConnectionId: connectionId,
      embeddingDimension: DIMENSION,
      embeddingProviderModelId: modelId,
      generation: 0,
      indexMode: "HYBRID",
      indexedThroughMemoryRevision: 0,
      languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
      normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
      readyAt: INITIAL_NOW,
      retrievalPipelineVersion: options.retrievalPipelineVersion ??
        MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
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
  return {
    classifierAuthority: {
      connectionId,
      credentialId,
      modelId: classifierModelId
    },
    connectionId,
    credentialId,
    credentialVersionId,
    generationId: generation.id,
    modelId,
    policy,
    userId,
    async cleanup() {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
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
      await prisma.providerModel.deleteMany({
        where: { id: { in: [classifierModelId, modelId] } }
      });
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

async function embeddingJobForEntry(userId: string, searchEntryId: string) {
  const child = await prisma.memoryEmbeddingBatchItem.findFirstOrThrow({
    select: { memoryJobId: true },
    where: { searchEntryId, userId }
  });
  return prisma.memoryJob.findUniqueOrThrow({
    where: { id: child.memoryJobId }
  });
}

describe("Prisma explicit Memory vector enrichment", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps a legacy-scoped fact dormant at the embedding target rejoin", async () => {
    const fixture = await createFixture();
    try {
      const folder = await prisma.folder.create({
        data: { name: "Legacy embedding scope", userId: fixture.userId }
      });
      const statement = "I prefer a legacy scoped embedding target.";
      const legacyScope = await createPrismaMemoryScopeRepository(prisma).ensure(
        fixture.userId,
        { targetId: folder.id, type: "FOLDER" }
      );
      const saved = await saveLegacyExplicit(
        fixture.userId,
        legacyScope.id,
        statement,
        `embedding-legacy-scope-${randomUUID()}`,
        fixture.classifierAuthority
      );
      const classified = await prisma.memoryFactVersion.findUniqueOrThrow({
        select: {
          safetyClassificationState: true,
          safetyClassifierExecutionId: true
        },
        where: { id: saved.versionId }
      });
      expect(classified.safetyClassificationState).toBe("CLASSIFIED");
      await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: { relationsDetachedAt: true, state: true },
        where: { id: classified.safetyClassifierExecutionId! }
      })).resolves.toMatchObject({
        relationsDetachedAt: expect.any(Date),
        state: "SUCCEEDED"
      });
      const entry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: saved.versionId }
      });

      await expect(createPrismaMemoryItemEmbeddingRepository(prisma)
        .loadTarget(fixture.userId, entry.id)).resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an elapsed fact at the embedding target rejoin", async () => {
    const fixture = await createFixture();
    const { explicit } = memoryServices(fixture.classifierAuthority);
    try {
      const saved = await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer an embedding target that expires immediately.",
        "embedding-expired-target"
      );
      const versionId = saved.memory.currentVersionId!;
      const entry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: versionId }
      });
      const expiresAt = new Date(Date.now() + 300);
      await prisma.$transaction(async (tx) => {
        await tx.memoryFactVersion.update({
          data: { expiresAt },
          where: { id: versionId }
        });
        const remaining = expiresAt.getTime() - Date.now();
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining + 50));
        }
      });

      await expect(prisma.memorySearchEntry.count({ where: { id: entry.id } }))
        .resolves.toBe(1);
      await expect(createPrismaMemoryItemEmbeddingRepository(prisma)
        .loadTarget(fixture.userId, entry.id)).resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps legacy projection jobs on a pre-profile active generation", async () => {
    const fixture = await createFixture({
      retrievalPipelineVersion: "memory-personal-retrieval-v7-vector"
    });
    const { explicit } = memoryServices(fixture.classifierAuthority);
    try {
      const saved = await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer a legacy-compatible vector until shadow cutover.",
        "embedding-pre-profile-generation"
      );
      const entry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: saved.memory.currentVersionId! }
      });
      await expect(prisma.memoryJob.findFirstOrThrow({
        where: {
          idempotencyFingerprint: {
            startsWith: `memory-item-embed-v1:${entry.id}:`
          },
          pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
          userId: fixture.userId
        }
      })).resolves.toMatchObject({ kind: "EMBED_ITEMS", state: "QUEUED" });
      await expect(prisma.memoryEmbeddingBatchItem.count({
        where: { userId: fixture.userId }
      })).resolves.toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("embeds thirty-two eligible items in two durable provider requests", async () => {
    const fixture = await createFixture();
    const { explicit } = memoryServices(fixture.classifierAuthority);
    const embed = vi.fn(async (request: { texts: readonly string[] }) => {
      const vector = Array.from(
        { length: DIMENSION },
        (_, index) => index === 0 ? 1 : 0
      );
      return {
        model: embeddingConfiguration.upstreamModelId,
        requestId: `embedding-batch-request-${randomUUID()}`,
        usage: {
          inputTokens: request.texts.length * 7,
          totalTokens: request.texts.length * 7
        },
        vectors: request.texts.map(() => vector)
      };
    });
    const authority = {
      egressConsentMode: "PER_USER" as const,
      now: () => new Date(INITIAL_NOW)
    };
    const runtime = {
      resolve: vi.fn(async () => ({ adapter: { embed } }))
    } as never;
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(createPrismaMemoryEmbeddingHandler(
      authority,
      prisma,
      { batch: { runtime }, legacy: { runtime } }
    ));
    const coordinator = new MemoryCoordinator({
      now: () => new Date(INITIAL_NOW),
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
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: INITIAL_NOW,
          acceptedUtilityEgressFingerprint: fixture.policy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      for (let index = 0; index < 32; index += 1) {
        await saveExplicit(
          explicit,
          fixture.userId,
          `I prefer benchmark-safe memory detail number ${index}.`,
          `embedding-batch-${index}`
        );
      }

      const entries = await prisma.memorySearchEntry.findMany({
        orderBy: { id: "asc" },
        select: { id: true, safeContentHash: true },
        where: { userId: fixture.userId }
      });
      expect(entries).toHaveLength(32);
      await prisma.memoryEmbeddingBatchItem.deleteMany({
        where: { userId: fixture.userId }
      });
      await prisma.memoryJob.deleteMany({
        where: { kind: "EMBED_ITEMS", userId: fixture.userId }
      });
      await expect(withLockedMemoryTransaction(
        prisma,
        fixture.userId,
        (tx, settings) => enqueueMemoryEmbeddingBatchItems(
          tx,
          settings,
          entries.map((entry) => ({
            entryId: entry.id,
            triggerIdentity: memorySha256({
              entryId: entry.id,
              safeContentHash: entry.safeContentHash,
              version: "embedding-bulk-regression-v1"
            })
          }))
        )
      )).resolves.toEqual({
        childrenCreated: 32,
        childrenReused: 0,
        failed: false,
        jobsCreated: 2
      });

      const parents = await prisma.memoryJob.findMany({
        orderBy: { createdAt: "asc" },
        where: {
          kind: "EMBED_ITEMS",
          pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
          userId: fixture.userId
        }
      });
      const children = await prisma.memoryEmbeddingBatchItem.groupBy({
        _count: { _all: true },
        by: ["memoryJobId"],
        orderBy: { memoryJobId: "asc" },
        where: { userId: fixture.userId }
      });
      expect(parents).toHaveLength(2);
      expect(children.map(({ _count }) => _count._all)).toEqual([16, 16]);

      await coordinator.reconcileNow();

      expect(embed).toHaveBeenCalledTimes(2);
      expect(embed.mock.calls.map(([request]) => request.texts.length))
        .toEqual([16, 16]);
      await expect(prisma.memorySearchEntry.count({
        where: { embeddingState: "READY", userId: fixture.userId }
      })).resolves.toBe(32);
      await expect(prisma.memoryExecutionBinding.count({
        where: {
          logicalRole: "MEMORY_DOCUMENT_EMBED",
          memoryJobId: { in: parents.map(({ id }) => id) },
          state: "SUCCEEDED",
          userId: fixture.userId
        }
      })).resolves.toBe(2);
      const settled = await prisma.memoryJob.findMany({
        select: { operationalCounters: true, state: true },
        where: { id: { in: parents.map(({ id }) => id) }
        }
      });
      expect(settled).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operationalCounters: expect.objectContaining({
            embeddingBatchItems: 16,
            embeddingProviderRequests: 1,
            embeddingSettledItems: 16
          }),
          state: "SUCCEEDED"
        })
      ]));
    } finally {
      coordinator.stop();
      await fixture.cleanup();
    }
  }, 60_000);

  it("queues a 471-entry rebuild set in bounded durable batches", async () => {
    const fixture = await createFixture();
    const { explicit } = memoryServices(fixture.classifierAuthority);
    try {
      await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer bounded rebuild queue transactions.",
        "embedding-bulk-471-seed"
      );
      await prisma.memoryEmbeddingBatchItem.deleteMany({
        where: { userId: fixture.userId }
      });
      await prisma.memoryJob.deleteMany({
        where: { kind: "EMBED_ITEMS", userId: fixture.userId }
      });
      const chat = await prisma.chat.create({
        data: { title: "Embedding bulk scale fixture", userId: fixture.userId }
      });
      const chunks = Array.from({ length: 470 }, (_, ordinal) => {
        const id = randomUUID();
        const text = `Bounded rebuild queue entry ${ordinal}.`;
        return {
          contentHash: memorySha256(text),
          id,
          normalizedSearchText: normalizeMemorySearchText(text),
          ordinal,
          text
        };
      });
      const occurredAt = new Date("2026-08-10T10:00:00.000Z");
      await prisma.memoryRecallChunk.createMany({
        data: chunks.map((chunk) => ({
          branchGeneration: 0,
          chatId: chat.id,
          chunkOrdinal: chunk.ordinal,
          chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
          contentHash: chunk.contentHash,
          invalidatedAt: occurredAt,
          languageCode: "en",
          normalizedSafeSearchText: chunk.normalizedSearchText,
          occurredFrom: occurredAt,
          occurredTo: occurredAt,
          redactionReasonCodes: [],
          redactionState: "NOT_NEEDED" as const,
          safeProjectedText: chunk.text,
          safetyClass: "NORMAL" as const,
          sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
          sourceRevisionAtCreation: 0,
          state: "INVALIDATED" as const,
          userId: fixture.userId,
          id: chunk.id
        }))
      });
      await prisma.memorySearchEntry.createMany({
        data: chunks.map((chunk) => ({
          embeddingState: "PENDING" as const,
          id: randomUUID(),
          indexGenerationId: fixture.generationId,
          itemType: "RECALL_CHUNK" as const,
          languageCode: "en",
          normalizedSearchText: chunk.normalizedSearchText,
          recallChunkId: chunk.id,
          safeContentHash: chunk.contentHash,
          safetyIdentitySnapshot: memorySha256({ safety: "NORMAL" }),
          sourceIdentitySnapshot: memorySha256({ chunkId: chunk.id }),
          suppressionIdentitySnapshot: memorySha256({ suppressions: [] }),
          userId: fixture.userId
        }))
      });
      const entries = await prisma.memorySearchEntry.findMany({
        orderBy: { id: "asc" },
        select: { id: true, safeContentHash: true },
        where: { userId: fixture.userId }
      });
      expect(entries).toHaveLength(471);
      const inputs = entries.map((entry) => ({
        entryId: entry.id,
        triggerIdentity: memorySha256({
          entryId: entry.id,
          safeContentHash: entry.safeContentHash,
          version: "embedding-bulk-scale-regression-v1"
        })
      }));
      await expect(withLockedMemoryTransaction(
        prisma,
        fixture.userId,
        (tx, settings) => enqueueMemoryEmbeddingBatchItems(
          tx,
          settings,
          inputs
        )
      )).resolves.toEqual({
        childrenCreated: 471,
        childrenReused: 0,
        failed: false,
        jobsCreated: 30
      });
      const groups = await prisma.memoryEmbeddingBatchItem.groupBy({
        _count: { _all: true },
        by: ["memoryJobId"],
        where: { userId: fixture.userId }
      });
      expect(groups).toHaveLength(30);
      expect(groups.reduce((total, group) => total + group._count._all, 0))
        .toBe(471);
      expect(Math.max(...groups.map((group) => group._count._all))).toBe(16);
      await expect(withLockedMemoryTransaction(
        prisma,
        fixture.userId,
        (tx, settings) => enqueueMemoryEmbeddingBatchItems(
          tx,
          settings,
          inputs
        )
      )).resolves.toEqual({
        childrenCreated: 0,
        childrenReused: 471,
        failed: false,
        jobsCreated: 0
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it("keeps a queued batch live after its seed child is forgotten", async () => {
    const fixture = await createFixture();
    const { explicit, lifecycle } = memoryServices(fixture.classifierAuthority);
    const embed = vi.fn(async (request: { texts: readonly string[] }) => {
      const vector = Array.from(
        { length: DIMENSION },
        (_, index) => index === 0 ? 1 : 0
      );
      return {
        model: embeddingConfiguration.upstreamModelId,
        requestId: `embedding-sparse-request-${randomUUID()}`,
        usage: {
          inputTokens: request.texts.length * 7,
          totalTokens: request.texts.length * 7
        },
        vectors: request.texts.map(() => vector)
      };
    });
    const authority = {
      egressConsentMode: "PER_USER" as const,
      now: () => new Date(INITIAL_NOW)
    };
    const runtime = {
      resolve: vi.fn(async () => ({ adapter: { embed } }))
    } as never;
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(createPrismaMemoryEmbeddingHandler(
      authority,
      prisma,
      { batch: { runtime }, legacy: { runtime } }
    ));
    const coordinator = new MemoryCoordinator({
      now: () => new Date(INITIAL_NOW),
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
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: INITIAL_NOW,
          acceptedUtilityEgressFingerprint: fixture.policy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      const seed = await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer the sparse batch seed detail.",
        "embedding-sparse-seed"
      );
      await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer the sparse batch retained detail alpha.",
        "embedding-sparse-alpha"
      );
      await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer the sparse batch retained detail beta.",
        "embedding-sparse-beta"
      );
      const seedEntry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: seed.memory.currentVersionId! }
      });
      const parent = await embeddingJobForEntry(fixture.userId, seedEntry.id);
      const authorization = await explicit.mintAuthorization(fixture.userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: seed.memory.currentVersionId!,
        requestNonce: "embedding-sparse-forget",
        targetFactId: seed.memory.id
      });
      await lifecycle.forget(fixture.userId, seed.memory.id, {
        expectedVersionId: seed.memory.currentVersionId!,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      });
      await expect(prisma.memoryEmbeddingBatchItem.findMany({
        orderBy: { ordinal: "asc" },
        select: { ordinal: true },
        where: { memoryJobId: parent.id }
      })).resolves.toEqual([{ ordinal: 1 }, { ordinal: 2 }]);

      await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer the sparse batch appended detail gamma.",
        "embedding-sparse-gamma"
      );
      await expect(prisma.memoryEmbeddingBatchItem.findMany({
        orderBy: { ordinal: "asc" },
        select: { ordinal: true },
        where: { memoryJobId: parent.id }
      })).resolves.toEqual([{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }]);
      await expect(prisma.memoryJob.count({
        where: {
          kind: "EMBED_ITEMS",
          pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
          userId: fixture.userId
        }
      })).resolves.toBe(1);

      await coordinator.reconcileNow();

      expect(embed).toHaveBeenCalledOnce();
      expect(embed.mock.calls[0]?.[0].texts).toHaveLength(3);
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: parent.id }
      })).resolves.toMatchObject({ state: "SUCCEEDED" });
      await expect(prisma.memoryEmbeddingBatchItem.count({
        where: { memoryJobId: parent.id, state: "SETTLED" }
      })).resolves.toBe(3);
      await expect(prisma.memorySearchEntry.count({
        where: { embeddingState: "READY", userId: fixture.userId }
      })).resolves.toBe(3);
      await expect(prisma.memorySearchEntry.count({
        where: { id: seedEntry.id }
      })).resolves.toBe(0);
    } finally {
      coordinator.stop();
      await fixture.cleanup();
    }
  }, 60_000);

  it("resumes partial child settlement without repeating the provider request", async () => {
    const fixture = await createFixture();
    const { explicit } = memoryServices(fixture.classifierAuthority);
    let clock = new Date(INITIAL_NOW);
    const embed = vi.fn(async (request: { texts: readonly string[] }) => {
      const vector = Array.from(
        { length: DIMENSION },
        (_, index) => index === 0 ? 1 : 0
      );
      return {
        model: embeddingConfiguration.upstreamModelId,
        requestId: `embedding-partial-request-${randomUUID()}`,
        usage: {
          inputTokens: request.texts.length * 7,
          totalTokens: request.texts.length * 7
        },
        vectors: request.texts.map(() => vector)
      };
    });
    const authority = {
      egressConsentMode: "PER_USER" as const,
      now: () => new Date(clock)
    };
    const baseRepository = createPrismaMemoryEmbeddingBatchRepository(prisma);
    let applyOrdinal = 0;
    let failOnce = true;
    const repository = {
      ...baseRepository,
      async applyResult(...args: Parameters<typeof baseRepository.applyResult>) {
        applyOrdinal += 1;
        if (failOnce && applyOrdinal === 2) {
          failOnce = false;
          throw new Error("test_partial_apply_crash");
        }
        return baseRepository.applyResult(...args);
      }
    };
    const runtime = {
      resolve: vi.fn(async () => ({ adapter: { embed } }))
    } as never;
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(createPrismaMemoryEmbeddingHandler(
      authority,
      prisma,
      { batch: { repository, runtime }, legacy: { runtime } }
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
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: clock,
          acceptedUtilityEgressFingerprint: fixture.policy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
        },
        where: { userId: fixture.userId }
      });
      await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer the partial recovery example alpha.",
        "embedding-partial-alpha"
      );
      await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer the partial recovery example beta.",
        "embedding-partial-beta"
      );
      const parent = await prisma.memoryJob.findFirstOrThrow({
        where: {
          kind: "EMBED_ITEMS",
          pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
          userId: fixture.userId
        }
      });

      await coordinator.reconcileNow();

      expect(embed).toHaveBeenCalledOnce();
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: parent.id }
      })).resolves.toMatchObject({ state: "RETRYABLE_FAILED" });
      const interrupted = await prisma.memoryEmbeddingBatchItem.findMany({
        orderBy: { ordinal: "asc" },
        select: { state: true },
        where: { memoryJobId: parent.id }
      });
      expect(interrupted.map(({ state }) => state)).toEqual([
        "SETTLED",
        "RESULT_READY"
      ]);

      clock = new Date(clock.getTime() + 10);
      await coordinator.reconcileNow();

      expect(embed).toHaveBeenCalledOnce();
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: parent.id }
      })).resolves.toMatchObject({ state: "SUCCEEDED" });
      await expect(prisma.memoryEmbeddingBatchItem.count({
        where: { memoryJobId: parent.id, state: "SETTLED" }
      })).resolves.toBe(2);
      await expect(prisma.memorySearchEntry.count({
        where: { embeddingState: "READY", userId: fixture.userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryExecutionBinding.count({
        where: { memoryJobId: parent.id, state: "SUCCEEDED" }
      })).resolves.toBe(1);
    } finally {
      coordinator.stop();
      await fixture.cleanup();
    }
  }, 60_000);

  it("keeps lexical recall available across consent, outage, rotation, and Forget races", async () => {
    const fixture = await createFixture();
    const { explicit, lifecycle, readRepository } = memoryServices(
      fixture.classifierAuthority
    );
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
      egressConsentMode: "PER_USER" as const,
      now: () => new Date(clock)
    };
    const registry = new MemoryCoordinatorRegistry();
    const runtime = {
      resolve: vi.fn(async () => ({ adapter: { embed } }))
    } as never;
    registry.registerJob(createPrismaMemoryEmbeddingHandler(
      authority,
      prisma,
      {
        batch: { runtime },
        legacy: { runtime }
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
      const firstJob = await embeddingJobForEntry(
        fixture.userId,
        firstEntry.id
      );
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
      expect(firstUsage.filter(({ memoryExecutionBindingId }) =>
        firstBindings.some(({ id }) => id === memoryExecutionBindingId))).toHaveLength(1);
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
      const outageJob = await embeddingJobForEntry(
        fixture.userId,
        outageEntry.id
      );
      await coordinator.reconcileNow();
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({
        where: { id: outageEntry.id }
      })).resolves.toMatchObject({ embeddingState: "PENDING" });
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: outageJob.id } }))
        .resolves.toMatchObject({ state: "RETRYABLE_FAILED" });
      await expect(readRepository.search(fixture.userId, { query: "aisle seats" }))
        .resolves.toMatchObject({
          memories: [expect.objectContaining({ id: outage.memory.id })]
        });
      const afterFailure = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: fixture.userId }
      });
      expect(afterFailure.memoryRevision).toBe(3);

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
      expect(afterRetry.memoryRevision).toBe(4);
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
      const staleJob = await embeddingJobForEntry(
        fixture.userId,
        staleEntry.id
      );
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

  it("embeds a current chunk and degrades another chunk outage without losing lexical rows", async () => {
    const fixture = await createFixture();
    const sourceHash = "9".repeat(64);
    const chunkText = "The release checklist uses a blue-green deployment.";
    const failingChunkText = "The deployment review records a bounded embedding outage.";
    const chunkId = memorySha256({ domain: "memory-test-chunk", userId: fixture.userId });
    const failingChunkId = memorySha256({ domain: "memory-test-failing-chunk", userId: fixture.userId });
    const chunkEntryId = randomUUID();
    const failingChunkEntryId = randomUUID();
    let chatId: string | null = null;
    const embed = vi.fn(async (request: { texts: readonly string[] }) => {
      if (request.texts[0]?.includes("embedding outage")) {
        throw new EmbeddingAdapterError("embedding_provider_http_error");
      }
      return vectorResult();
    });
    const authority = {
      egressConsentMode: "PER_USER" as const,
      now: () => new Date(INITIAL_NOW)
    };
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(createPrismaMemoryItemEmbeddingHandler(
      authority,
      prisma,
      {
        runtime: {
          resolve: vi.fn(async () => ({ adapter: { embed } }))
        } as never
      }
    ));
    const coordinator = new MemoryCoordinator({
      now: () => new Date(INITIAL_NOW),
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
      await prisma.userMemorySettings.update({
        data: {
          acceptedUtilityEgressAt: INITIAL_NOW,
          acceptedUtilityEgressFingerprint: fixture.policy.fingerprint,
          acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
          referenceChatHistory: true
        },
        where: { userId: fixture.userId }
      });
      const chat = await prisma.chat.create({
        data: {
          memorySourceRevision: 1,
          title: "Memory item embedding",
          userId: fixture.userId
        }
      });
      chatId = chat.id;
      const leaf = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Record the release workflow."),
          role: "user"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: leaf.id },
        where: { id: chat.id }
      });
      await prisma.$transaction(async (tx) => {
        await tx.chatMemoryCheckpoint.create({
          data: {
            activeLeafMessageId: leaf.id,
            branchGeneration: 0,
            chatId: chat.id,
            lastIndexedMessageId: leaf.id,
            lastSucceededAt: INITIAL_NOW,
            pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
            sourceContentHash: sourceHash,
            sourceRevision: 1,
            status: "READY",
            userId: fixture.userId
          }
        });
        await tx.chatMemoryCheckpointMessage.create({
          data: {
            chatId: chat.id,
            messageId: leaf.id,
            ordinal: 0,
            sourceMessageCreatedAt: leaf.createdAt,
            sourceMessageUpdatedAt: leaf.updatedAt,
            userId: fixture.userId
          }
        });
        await tx.memoryRecallChunk.create({
          data: {
            branchGeneration: 0,
            chatId: chat.id,
            chunkOrdinal: 0,
            chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
            contentHash: memorySha256(chunkText),
            id: chunkId,
            languageCode: "en",
            normalizedSafeSearchText: normalizeMemorySearchText(chunkText),
            occurredFrom: INITIAL_NOW,
            occurredTo: INITIAL_NOW,
            redactionState: "NOT_NEEDED",
            safeProjectedText: chunkText,
            safetyClass: "NORMAL",
            sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
            sourceRevisionAtCreation: 0,
            userId: fixture.userId
          }
        });
        await tx.memoryRecallChunk.create({
          data: {
            branchGeneration: 0,
            chatId: chat.id,
            chunkOrdinal: 1,
            chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
            contentHash: memorySha256(failingChunkText),
            id: failingChunkId,
            languageCode: "en",
            normalizedSafeSearchText: normalizeMemorySearchText(failingChunkText),
            occurredFrom: INITIAL_NOW,
            occurredTo: INITIAL_NOW,
            redactionState: "NOT_NEEDED",
            safeProjectedText: failingChunkText,
            safetyClass: "NORMAL",
            sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
            sourceRevisionAtCreation: 0,
            userId: fixture.userId
          }
        });
        await tx.memoryRecallChunkMessage.createMany({
          data: [
            {
              chatId: chat.id,
              chunkId,
              messageId: leaf.id,
              ordinal: 0,
              role: "user",
              safeTextHash: memorySha256(chunkText),
              sourceMessageContentHash: memorySha256(leaf.content),
              sourceMessageUpdatedAt: leaf.updatedAt,
              userId: fixture.userId
            },
            {
              chatId: chat.id,
              chunkId: failingChunkId,
              messageId: leaf.id,
              ordinal: 0,
              role: "user",
              safeTextHash: memorySha256(failingChunkText),
              sourceMessageContentHash: memorySha256(leaf.content),
              sourceMessageUpdatedAt: leaf.updatedAt,
              userId: fixture.userId
            }
          ]
        });
        await tx.memorySearchEntry.createMany({
          data: [
            {
              embeddingState: "PENDING",
              id: chunkEntryId,
              indexGenerationId: fixture.generationId,
              itemType: "RECALL_CHUNK",
              languageCode: "en",
              recallChunkId: chunkId,
              safeContentHash: memorySha256(chunkText),
              normalizedSearchText: normalizeMemorySearchText(chunkText),
              safetyIdentitySnapshot: "4".repeat(64),
              sourceIdentitySnapshot: "3".repeat(64),
              suppressionIdentitySnapshot: "2".repeat(64),
              userId: fixture.userId
            },
            {
              embeddingState: "PENDING",
              id: failingChunkEntryId,
              indexGenerationId: fixture.generationId,
              itemType: "RECALL_CHUNK",
              languageCode: "en",
              recallChunkId: failingChunkId,
              safeContentHash: memorySha256(failingChunkText),
              normalizedSearchText: normalizeMemorySearchText(failingChunkText),
              safetyIdentitySnapshot: "1".repeat(64),
              sourceIdentitySnapshot: "0".repeat(64),
              suppressionIdentitySnapshot: "a".repeat(64),
              userId: fixture.userId
            }
          ]
        });
      });
      const itemRepository = createPrismaMemoryItemEmbeddingRepository(prisma);
      await expect(itemRepository.loadTarget(fixture.userId, chunkEntryId))
        .resolves.toMatchObject({ itemId: chunkId, itemType: "RECALL_CHUNK" });
      await expect(itemRepository.loadTarget(fixture.userId, failingChunkEntryId))
        .resolves.toMatchObject({ itemId: failingChunkId, itemType: "RECALL_CHUNK" });
      const jobs = createPrismaMemoryJobRepository(prisma);
      const chunkJob = await jobs.enqueue(fixture.userId, {
        idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
          chunkEntryId,
          chunkId
        ),
        kind: "EMBED_ITEMS",
        pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
      });
      const failingChunkJob = await jobs.enqueue(fixture.userId, {
        idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
          failingChunkEntryId,
          failingChunkId
        ),
        kind: "EMBED_ITEMS",
        pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
      });

      await coordinator.reconcileNow();
      await coordinator.reconcileNow();

      const bindings = await prisma.memoryExecutionBinding.findMany({
        select: { errorCode: true, memoryJobId: true, state: true },
        where: { memoryJobId: { in: [chunkJob.id, failingChunkJob.id] } }
      });
      expect(bindings).toEqual(expect.arrayContaining([
        { errorCode: null, memoryJobId: chunkJob.id, state: "SUCCEEDED" },
        {
          errorCode: "embedding_provider_http_error",
          memoryJobId: failingChunkJob.id,
          state: "FAILED"
        }
      ]));
      expect(bindings).toHaveLength(2);
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: chunkJob.id }
      })).resolves.toMatchObject({ state: "SUCCEEDED" });
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: failingChunkJob.id }
      })).resolves.toMatchObject({ state: "RETRYABLE_FAILED" });
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({
        where: { id: chunkEntryId }
      })).resolves.toMatchObject({
        embeddingDimension: DIMENSION,
        embeddingState: "READY",
        normalizedSearchText: normalizeMemorySearchText(chunkText)
      });
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({
        where: { id: failingChunkEntryId }
      })).resolves.toMatchObject({
        embeddingDimension: null,
        embeddingState: "FAILED",
        normalizedSearchText: normalizeMemorySearchText(failingChunkText)
      });
      const bindingIds = await prisma.memoryExecutionBinding.findMany({
        select: { id: true },
        where: {
          memoryJobId: { in: [chunkJob.id, failingChunkJob.id] },
          userId: fixture.userId
        }
      });
      await expect(prisma.usageEvent.count({
        where: {
          memoryExecutionBindingId: { in: bindingIds.map(({ id }) => id) },
          userId: fixture.userId
        }
      })).resolves.toBe(2);
      expect(embed).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.stop();
      if (chatId) {
        await prisma.memorySearchEntry.deleteMany({ where: { userId: fixture.userId } });
        await prisma.memoryRecallChunk.deleteMany({ where: { userId: fixture.userId } });
      }
      await fixture.cleanup();
    }
  }, 30_000);
});
