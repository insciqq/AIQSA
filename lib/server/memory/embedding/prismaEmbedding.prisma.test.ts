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
import { detachExpiredMemoryExecutionBindings } from "../execution/lifecycle";
import { createPrismaMemoryLifecycleRepository } from "../lifecycle/repository";
import { createMemoryLifecycleService } from "../lifecycle/service";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { MEMORY_TOOL_EVENT_PROJECTION_VERSION } from "../history/toolEvents";
import {
  MEMORY_HISTORY_SOURCE_PROJECTION_VERSION
} from "../history/sourceProjection";
import { createPrismaMemoryMutationAuthorizationRepository } from
  "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
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
import {
  enqueueMemoryEmbeddingBatchItem,
  enqueueMemoryEmbeddingBatchItems
} from "./enqueue";
import { createPrismaMemoryItemEmbeddingRepository } from "./repository";
import {
  MEMORY_EMBEDDING_SWEEP_FAILURE_DELAY_MS,
  MEMORY_EMBEDDING_SWEEP_GRACE_MS,
  sweepStrandedMemoryEmbeddings
} from "./sweep";
import { ACCOUNT_MEMORY_DELETION_TARGET_TYPE } from "../accountDeletion/contract";
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
      evidence: embeddingCredentialEvidence,
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
      languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
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

function batchVectors(request: { texts: readonly string[] }) {
  const vector = Array.from({ length: DIMENSION }, (_, index) => index === 0 ? 1 : 0);
  return {
    model: embeddingConfiguration.upstreamModelId,
    requestId: `embedding-sweep-request-${randomUUID()}`,
    usage: {
      inputTokens: request.texts.length * 7,
      totalTokens: request.texts.length * 7
    },
    vectors: request.texts.map(() => vector)
  };
}

function batchCoordinator(
  clock: () => Date,
  embed: (request: { texts: readonly string[] }) => Promise<ReturnType<typeof batchVectors>>,
  policy: Readonly<{ maxJobAttempts?: number }> = {}
) {
  const runtime = {
    resolve: vi.fn(async () => ({ adapter: { embed } }))
  } as never;
  const registry = new MemoryCoordinatorRegistry();
  registry.registerJob(createPrismaMemoryEmbeddingHandler(
    { now: clock },
    prisma,
    { batch: { runtime }, legacy: { runtime } }
  ));
  return new MemoryCoordinator({
    now: clock,
    policy: {
      heartbeatMs: 1_000,
      jobRetryDelaysMs: [1],
      leaseMs: 5_000,
      maxJobParallel: 1,
      ...policy
    },
    registry,
    repository: createPrismaMemoryCoordinatorRepository(prisma)
  });
}

async function activeFactEntry(
  generationId: string,
  saved: Awaited<ReturnType<typeof saveExplicit>>
) {
  return prisma.memorySearchEntry.findFirstOrThrow({
    where: { factVersionId: saved.memory.currentVersionId!, indexGenerationId: generationId }
  });
}

/** The production shape of a target retired while it was briefly not current:
 * a STALE child under a settled batch, and no successor. */
async function strandEmbeddingChild(userId: string, searchEntryId: string, at: Date) {
  const child = await prisma.memoryEmbeddingBatchItem.findFirstOrThrow({
    where: { searchEntryId, userId }
  });
  await prisma.memoryEmbeddingBatchItem.update({
    data: {
      completedAt: at,
      errorCode: "memory_embedding_batch_target_stale",
      state: "STALE"
    },
    where: { id: child.id }
  });
  await prisma.memoryJob.update({
    data: {
      acceptedResultHash: "e".repeat(64),
      completedAt: at,
      stage: "local_terminal",
      state: "SUCCEEDED"
    },
    where: { id: child.memoryJobId }
  });
}

async function embeddingChildren(userId: string, searchEntryId: string) {
  return prisma.memoryEmbeddingBatchItem.count({ where: { searchEntryId, userId } });
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
      await expect(prisma.memorySearchEntry.findFirst({
        where: { factVersionId: saved.versionId }
      })).resolves.toBeNull();
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

  // A detached unknown call (its provider references released after its
  // recovery window) still holds its ordinal and input for the batch.
  it.each([false, true])("retries an outcome-unknown batch with a fresh durable binding (detached: %s)", async (detached) => {
    const fixture = await createFixture();
    const { explicit } = memoryServices(fixture.classifierAuthority);
    let clock = new Date(INITIAL_NOW);
    let providerCalls = 0;
    const embed = vi.fn(async (request: { texts: readonly string[] }) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw new EmbeddingAdapterError("embedding_request_timed_out");
      }
      const vector = Array.from(
        { length: DIMENSION },
        (_, index) => index === 0 ? 1 : 0
      );
      return {
        model: embeddingConfiguration.upstreamModelId,
        requestId: `embedding-uncertain-request-${randomUUID()}`,
        usage: {
          inputTokens: request.texts.length * 7,
          totalTokens: request.texts.length * 7
        },
        vectors: request.texts.map(() => vector)
      };
    });
    const authority = {
      now: () => new Date(clock)
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
      const first = await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer bounded retries for pure embedding batches.",
        "embedding-outcome-unknown-alpha"
      );
      await saveExplicit(
        explicit,
        fixture.userId,
        "I prefer immutable inputs during provider recovery.",
        "embedding-outcome-unknown-beta"
      );
      const entry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: first.memory.currentVersionId! }
      });
      const parent = await embeddingJobForEntry(fixture.userId, entry.id);

      await coordinator.reconcileNow();

      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: parent.id }
      })).resolves.toMatchObject({ state: "RETRYABLE_FAILED" });
      await expect(prisma.memoryEmbeddingBatchItem.count({
        where: { memoryJobId: parent.id, state: "PENDING" }
      })).resolves.toBe(2);
      const firstBinding = await prisma.memoryExecutionBinding.findFirstOrThrow({
        where: { memoryJobId: parent.id }
      });
      expect(firstBinding).toMatchObject({ ordinal: 0, state: "OUTCOME_UNKNOWN" });
      if (detached) {
        await expect(prisma.$transaction((tx) => detachExpiredMemoryExecutionBindings(
          tx, { bindingId: firstBinding.id }, firstBinding.recoverableUntil!
        ))).resolves.toBe(1);
      }

      clock = new Date(clock.getTime() + 10);
      await coordinator.reconcileNow();

      const [settledJob, bindings, settledChildren] = await Promise.all([
        prisma.memoryJob.findUniqueOrThrow({ where: { id: parent.id } }),
        prisma.memoryExecutionBinding.findMany({
          orderBy: { ordinal: "asc" },
          where: { memoryJobId: parent.id }
        }),
        prisma.memoryEmbeddingBatchItem.count({
          where: { memoryJobId: parent.id, state: "SETTLED" }
        })
      ]);
      expect(embed).toHaveBeenCalledTimes(2);
      expect(settledChildren).toBe(2);
      expect(settledJob).toMatchObject({
        operationalCounters: expect.objectContaining({
          embeddingProviderRequests: 2,
          embeddingSettledItems: 2
        }),
        state: "SUCCEEDED"
      });
      expect(bindings.map(({ ordinal, relationsDetachedAt, state }) =>
        ({ detached: relationsDetachedAt !== null, ordinal, state }))).toEqual([
        { detached, ordinal: 0, state: "OUTCOME_UNKNOWN" },
        { detached: false, ordinal: 1, state: "SUCCEEDED" }
      ]);
      expect(new Set(bindings.map(({ inputHash }) => inputHash)).size).toBe(1);
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

  it("starts without acceptance and keeps lexical recall across outage, rotation, and Forget races", async () => {
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
        "embedding-default-save"
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
        .resolves.toMatchObject({ state: "SUCCEEDED" });
      expect(embed).toHaveBeenCalledTimes(1);
      await expect(prisma.memoryExecutionBinding.count({
        where: { memoryJobId: firstJob.id }
      })).resolves.toBe(1);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: fixture.userId }
      })).resolves.toMatchObject({
        acceptedUtilityEgressAt: null,
        acceptedUtilityEgressFingerprint: null,
        acceptedUtilityPolicyVersion: null
      });
      await coordinator.reconcileNow();
      expect(embed).toHaveBeenCalledTimes(1);
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
          evidence: embeddingCredentialEvidence,
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

  it("embeds a current chunk and aliased tool event while degrading another chunk outage", async () => {
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
      const toolChat = await prisma.chat.create({
        data: { memorySourceRevision: 1, title: "Memory tool embedding", userId: fixture.userId }
      });
      const toolUser = await prisma.message.create({ data: {
        chatId: toolChat.id, content: textMessageContent("Create the sample report."),
        role: "user", status: "complete"
      } });
      const toolAssistant = await prisma.message.create({ data: {
        chatId: toolChat.id, content: textMessageContent("The report is ready."),
        parentMessageId: toolUser.id, role: "assistant", status: "complete"
      } });
      await prisma.chat.update({
        data: { activeLeafMessageId: toolAssistant.id }, where: { id: toolChat.id }
      });
      const run = await prisma.modelRun.create({ data: {
        assistantMessageId: toolAssistant.id, chatId: toolChat.id,
        modelId: "memory-tool-embedding-model", provider: "memory-tool-embedding-provider",
        normalizedRequest: {},
        status: "complete", userId: fixture.userId, userMessageId: toolUser.id
      } });
      const occurredAt = new Date("2026-08-10T12:00:02.000Z");
      const call = await prisma.modelRunToolCall.create({ data: {
        arguments: {}, completedAt: occurredAt, modelRunId: run.id,
        ordinal: 0, providerCallId: "embedding-tool-call", result: { task: "QX-418" },
        roundIndex: 0, state: "complete", toolName: "filesystem.write"
      } });
      await prisma.chatMemoryCheckpoint.create({ data: {
        activeLeafMessageId: toolAssistant.id, branchGeneration: 0,
        chatId: toolChat.id, lastIndexedMessageId: toolAssistant.id,
        lastSucceededAt: INITIAL_NOW, pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
        sourceContentHash: sourceHash, sourceRevision: 1, status: "READY",
        userId: fixture.userId
      } });
      await prisma.chatMemoryCheckpointMessage.create({ data: {
        chatId: toolChat.id, messageId: toolAssistant.id, ordinal: 0,
        sourceMessageCreatedAt: toolAssistant.createdAt,
        sourceMessageUpdatedAt: toolAssistant.updatedAt, userId: fixture.userId
      } });
      const toolText = "Created the sample report.";
      const toolAliasText = "qx 418 created the sample report";
      const toolEvent = await prisma.memoryToolEvent.create({ data: {
        assistantMessageId: toolAssistant.id, branchGeneration: 0,
        chatId: toolChat.id, contentHash: memorySha256(toolText),
        evidenceRootHash: memorySha256({ callId: call.id }), id: randomUUID(),
        languageCode: "en", modelRunId: run.id, modelRunToolCallId: call.id,
        normalizedSafeSearchText: toolAliasText, occurredAt, operation: "write",
        outcome: "SUCCESS", projectionVersion: MEMORY_TOOL_EVENT_PROJECTION_VERSION,
        redactionState: "NOT_NEEDED", safeProjectedText: toolText,
        safetyClass: "NORMAL", sourceCallUpdatedAtAtCreation: call.updatedAt,
        sourcePayloadHash: memorySha256({ task: "QX-418" }),
        sourceRevisionAtCreation: 1, structuredIdentifiers: { task: "QX-418" },
        toolName: "filesystem.write", userId: fixture.userId
      } });
      const toolEntry = await prisma.memorySearchEntry.create({ data: {
        embeddingState: "PENDING", indexGenerationId: fixture.generationId,
        itemType: "TOOL_EVENT", languageCode: "en", normalizedSearchText: toolAliasText,
        safeContentHash: toolEvent.contentHash, safetyIdentitySnapshot: "4".repeat(64),
        sourceIdentitySnapshot: "3".repeat(64), suppressionIdentitySnapshot: "2".repeat(64),
        toolEventId: toolEvent.id, userId: fixture.userId
      } });
      const itemRepository = createPrismaMemoryItemEmbeddingRepository(prisma);
      await expect(itemRepository.loadTarget(fixture.userId, chunkEntryId))
        .resolves.toMatchObject({ itemId: chunkId, itemType: "RECALL_CHUNK" });
      await expect(itemRepository.loadTarget(fixture.userId, failingChunkEntryId))
        .resolves.toMatchObject({ itemId: failingChunkId, itemType: "RECALL_CHUNK" });
      await expect(itemRepository.loadTarget(fixture.userId, toolEntry.id))
        .resolves.toMatchObject({ itemId: toolEvent.id, itemType: "TOOL_EVENT",
          normalizedSearchText: toolAliasText });
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
      const toolJob = await jobs.enqueue(fixture.userId, {
        idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(toolEntry.id, toolEvent.id),
        kind: "EMBED_ITEMS", pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
      });

      await coordinator.reconcileNow();
      await coordinator.reconcileNow();
      await coordinator.reconcileNow();

      const bindings = await prisma.memoryExecutionBinding.findMany({
        select: { errorCode: true, memoryJobId: true, state: true },
        where: { memoryJobId: { in: [chunkJob.id, failingChunkJob.id, toolJob.id] } }
      });
      expect(bindings).toEqual(expect.arrayContaining([
        { errorCode: null, memoryJobId: chunkJob.id, state: "SUCCEEDED" },
        { errorCode: null, memoryJobId: toolJob.id, state: "SUCCEEDED" },
        {
          errorCode: "embedding_provider_http_error",
          memoryJobId: failingChunkJob.id,
          state: "FAILED"
        }
      ]));
      expect(bindings).toHaveLength(3);
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
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({
        where: { id: toolEntry.id }
      })).resolves.toMatchObject({
        embeddingDimension: DIMENSION,
        embeddingState: "READY",
        normalizedSearchText: toolAliasText
      });
      const bindingIds = await prisma.memoryExecutionBinding.findMany({
        select: { id: true },
        where: {
          memoryJobId: { in: [chunkJob.id, failingChunkJob.id, toolJob.id] },
          userId: fixture.userId
        }
      });
      await expect(prisma.usageEvent.count({
        where: {
          memoryExecutionBindingId: { in: bindingIds.map(({ id }) => id) },
          userId: fixture.userId
        }
      })).resolves.toBe(3);
      expect(embed).toHaveBeenCalledTimes(3);
    } finally {
      coordinator.stop();
      if (chatId) {
        await prisma.memorySearchEntry.deleteMany({ where: { userId: fixture.userId } });
        await prisma.memoryRecallChunk.deleteMany({ where: { userId: fixture.userId } });
      }
      await fixture.cleanup();
    }
  }, 30_000);

  it("re-embeds a chunk once after a chat turn retired its batch child", async () => {
    const fixture = await createFixture();
    const start = new Date();
    let clock = new Date(start);
    const embed = vi.fn(async (request: { texts: readonly string[] }) =>
      batchVectors(request));
    const coordinator = batchCoordinator(() => new Date(clock), embed);
    const chunkText = "The deployment rehearsal runs every Thursday morning.";
    const chunkId = memorySha256({ domain: "memory-sweep-chunk", userId: fixture.userId });
    const entryId = randomUUID();
    try {
      await prisma.userMemorySettings.update({
        data: { referenceChatHistory: true },
        where: { userId: fixture.userId }
      });
      const chat = await prisma.chat.create({
        data: { memorySourceRevision: 1, title: "Memory embedding sweep", userId: fixture.userId }
      });
      const first = await prisma.message.create({ data: {
        chatId: chat.id, content: textMessageContent("Record the deployment rehearsal."),
        role: "user"
      } });
      await prisma.chat.update({
        data: { activeLeafMessageId: first.id }, where: { id: chat.id }
      });
      await prisma.$transaction(async (tx) => {
        await tx.chatMemoryCheckpoint.create({ data: {
          activeLeafMessageId: first.id, branchGeneration: 0, chatId: chat.id,
          lastIndexedMessageId: first.id, lastSucceededAt: start,
          pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
          sourceContentHash: "8".repeat(64), sourceRevision: 1, status: "READY",
          userId: fixture.userId
        } });
        await tx.chatMemoryCheckpointMessage.create({ data: {
          chatId: chat.id, messageId: first.id, ordinal: 0,
          sourceMessageCreatedAt: first.createdAt,
          sourceMessageUpdatedAt: first.updatedAt, userId: fixture.userId
        } });
        await tx.memoryRecallChunk.create({ data: {
          branchGeneration: 0, chatId: chat.id, chunkOrdinal: 0,
          chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
          contentHash: memorySha256(chunkText), id: chunkId, languageCode: "en",
          normalizedSafeSearchText: normalizeMemorySearchText(chunkText),
          occurredFrom: start, occurredTo: start, redactionState: "NOT_NEEDED",
          safeProjectedText: chunkText, safetyClass: "NORMAL",
          sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
          sourceRevisionAtCreation: 1, userId: fixture.userId
        } });
        await tx.memoryRecallChunkMessage.create({ data: {
          chatId: chat.id, chunkId, messageId: first.id, ordinal: 0, role: "user",
          safeTextHash: memorySha256(chunkText),
          sourceMessageContentHash: memorySha256(first.content),
          sourceMessageUpdatedAt: first.updatedAt, userId: fixture.userId
        } });
        await tx.memorySearchEntry.create({ data: {
          embeddingState: "PENDING", id: entryId, indexGenerationId: fixture.generationId,
          itemType: "RECALL_CHUNK", languageCode: "en", recallChunkId: chunkId,
          normalizedSearchText: normalizeMemorySearchText(chunkText),
          safeContentHash: memorySha256(chunkText),
          safetyIdentitySnapshot: "4".repeat(64), sourceIdentitySnapshot: "3".repeat(64),
          suppressionIdentitySnapshot: "2".repeat(64), userId: fixture.userId
        } });
      });
      await withLockedMemoryTransaction(prisma, fixture.userId, (tx, settings) =>
        enqueueMemoryEmbeddingBatchItem(tx, settings, {
          entryId,
          triggerIdentity: "memory-sweep-history-index"
        }));
      const indexed = await embeddingJobForEntry(fixture.userId, entryId);

      // The next turn moves the chat ahead of its checkpoint, which stays
      // PENDING until history reindexes it: the queued batch cannot rejoin
      // the chunk and retires its child with no successor.
      const second = await prisma.message.create({ data: {
        chatId: chat.id, content: textMessageContent("Add the rollback drill too."),
        parentMessageId: first.id, role: "user"
      } });
      await prisma.$transaction([
        prisma.chat.update({
          data: { activeLeafMessageId: second.id, memorySourceRevision: 2 },
          where: { id: chat.id }
        }),
        prisma.chatMemoryCheckpoint.update({
          data: { activeLeafMessageId: second.id, sourceRevision: 2, status: "PENDING" },
          where: { userId_chatId: { chatId: chat.id, userId: fixture.userId } }
        })
      ]);
      await coordinator.reconcileNow();
      expect(embed).not.toHaveBeenCalled();
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: indexed.id } }))
        .resolves.toMatchObject({ state: "SUCCEEDED" });
      await expect(prisma.memoryEmbeddingBatchItem.findFirstOrThrow({
        where: { memoryJobId: indexed.id }
      })).resolves.toMatchObject({
        errorCode: "memory_embedding_batch_target_stale",
        state: "STALE"
      });
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({ where: { id: entryId } }))
        .resolves.toMatchObject({ embeddingState: "PENDING" });

      const sweepAt = new Date(start.getTime() + MEMORY_EMBEDDING_SWEEP_GRACE_MS + 5 * 60_000);
      // While its chat is ahead of the checkpoint the chunk is not current.
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: sweepAt }))
        .resolves.toEqual({ admitted: 0, failedOwners: 0 });

      // History reindexes the turn; the retained chunk is current again.
      await prisma.$transaction([
        prisma.chatMemoryCheckpoint.update({
          data: { lastIndexedMessageId: second.id, lastSucceededAt: new Date(), status: "READY" },
          where: { userId_chatId: { chatId: chat.id, userId: fixture.userId } }
        }),
        prisma.chatMemoryCheckpointMessage.create({ data: {
          chatId: chat.id, messageId: second.id, ordinal: 1,
          sourceMessageCreatedAt: second.createdAt,
          sourceMessageUpdatedAt: second.updatedAt, userId: fixture.userId
        } })
      ]);
      // Within the grace, live writers and batches still own the entry.
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: new Date() }))
        .resolves.toEqual({ admitted: 0, failedOwners: 0 });
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: sweepAt }))
        .resolves.toEqual({ admitted: 1, failedOwners: 0 });
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: sweepAt }))
        .resolves.toEqual({ admitted: 0, failedOwners: 0 });
      await expect(embeddingChildren(fixture.userId, entryId)).resolves.toBe(2);

      clock = new Date(sweepAt);
      await coordinator.reconcileNow();
      expect(embed).toHaveBeenCalledOnce();
      expect(embed.mock.calls[0]![0].texts).toHaveLength(1);
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({ where: { id: entryId } }))
        .resolves.toMatchObject({ embeddingDimension: DIMENSION, embeddingState: "READY" });
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: sweepAt }))
        .resolves.toEqual({ admitted: 0, failedOwners: 0 });
      await expect(embeddingChildren(fixture.userId, entryId)).resolves.toBe(2);
    } finally {
      coordinator.stop();
      await prisma.memorySearchEntry.deleteMany({ where: { userId: fixture.userId } });
      await prisma.memoryRecallChunk.deleteMany({ where: { userId: fixture.userId } });
      await fixture.cleanup();
    }
  }, 60_000);

  it("keeps live, superseded, paused and deleted work out of the sweep and backs off failures", async () => {
    const owner = await createFixture();
    const paused = await createFixture();
    const deleted = await createFixture();
    const start = new Date();
    let clock = new Date(start);
    let failing = true;
    const embed = vi.fn(async (request: { texts: readonly string[] }) => {
      if (failing) throw new EmbeddingAdapterError("embedding_provider_http_error");
      return batchVectors(request);
    });
    const coordinator = batchCoordinator(() => new Date(clock), embed, { maxJobAttempts: 1 });
    try {
      const { explicit } = memoryServices(owner.classifierAuthority);
      // A provider outage fails two batches terminally: one long ago, one now.
      const earlier = await saveExplicit(
        explicit, owner.userId, "I prefer window seats on night trains.", "sweep-earlier-outage"
      );
      await coordinator.reconcileNow();
      const earlierEntry = await activeFactEntry(owner.generationId, earlier);
      const earlierJob = await embeddingJobForEntry(owner.userId, earlierEntry.id);
      expect(earlierJob.state).toBe("TERMINAL_FAILED");
      await prisma.memoryJob.update({
        data: { completedAt: new Date(start.getTime() - MEMORY_EMBEDDING_SWEEP_FAILURE_DELAY_MS) },
        where: { id: earlierJob.id }
      });
      const recent = await saveExplicit(
        explicit, owner.userId, "I prefer quiet carriages on long trips.", "sweep-recent-outage"
      );
      await coordinator.reconcileNow();
      const recentEntry = await activeFactEntry(owner.generationId, recent);
      await expect(embeddingJobForEntry(owner.userId, recentEntry.id))
        .resolves.toMatchObject({ state: "TERMINAL_FAILED" });
      expect(embed).toHaveBeenCalledTimes(2);

      // Live work: a batch that no worker has claimed yet.
      const live = await saveExplicit(
        explicit, owner.userId, "I prefer printed tickets as a backup.", "sweep-live-batch"
      );
      const liveEntry = await activeFactEntry(owner.generationId, live);

      // A superseded generation no longer serves; its vector work is dead.
      const active = await prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: owner.generationId }
      });
      const superseded = await prisma.memoryIndexGeneration.create({ data: {
        activatedAt: start, chunkingVersion: active.chunkingVersion,
        embeddingConfigurationFingerprint: active.embeddingConfigurationFingerprint,
        embeddingConnectionId: active.embeddingConnectionId,
        embeddingDimension: active.embeddingDimension,
        embeddingProviderModelId: active.embeddingProviderModelId,
        generation: active.generation + 1, indexMode: "HYBRID",
        indexedThroughMemoryRevision: 0, languageProfile: active.languageProfile,
        normalizationVersion: active.normalizationVersion, readyAt: start,
        retrievalPipelineVersion: active.retrievalPipelineVersion, state: "SUPERSEDED",
        supersededAt: start, targetMemoryRevision: 0, userId: owner.userId,
        vectorSpaceFingerprint: active.vectorSpaceFingerprint
      } });
      const supersededEntry = await prisma.memorySearchEntry.create({ data: {
        embeddingState: "PENDING", factVersionId: liveEntry.factVersionId,
        indexGenerationId: superseded.id, itemType: "FACT_VERSION",
        languageCode: liveEntry.languageCode,
        normalizedSearchText: liveEntry.normalizedSearchText,
        safeContentHash: liveEntry.safeContentHash,
        safetyIdentitySnapshot: liveEntry.safetyIdentitySnapshot,
        sourceIdentitySnapshot: liveEntry.sourceIdentitySnapshot,
        suppressionIdentitySnapshot: liveEntry.suppressionIdentitySnapshot,
        userId: owner.userId
      } });

      // A paused owner and a deleted owner each hold a stranded entry.
      const fenced: Array<Readonly<{ entryId: string; userId: string }>> = [];
      for (const [fixture, label] of [[paused, "paused"], [deleted, "deleted"]] as const) {
        const saved = await saveExplicit(
          memoryServices(fixture.classifierAuthority).explicit,
          fixture.userId,
          `I prefer ${label} owners to keep their own pace.`,
          `sweep-${label}-owner`
        );
        const entry = await activeFactEntry(fixture.generationId, saved);
        await strandEmbeddingChild(fixture.userId, entry.id, start);
        fenced.push({ entryId: entry.id, userId: fixture.userId });
      }
      await prisma.userMemorySettings.update({
        data: { useMemoryFacts: false }, where: { userId: paused.userId }
      });
      await prisma.user.update({ data: { status: "disabled" }, where: { id: deleted.userId } });
      await prisma.memoryDeletionOutbox.create({ data: {
        memoryGeneration: 0, operation: "ACCOUNT_MEMORY_DELETE", targetId: deleted.userId,
        targetType: ACCOUNT_MEMORY_DELETION_TARGET_TYPE, userId: deleted.userId
      } });

      const children = () => Promise.all([
        embeddingChildren(owner.userId, earlierEntry.id),
        embeddingChildren(owner.userId, recentEntry.id),
        embeddingChildren(owner.userId, liveEntry.id),
        embeddingChildren(owner.userId, supersededEntry.id),
        ...fenced.map(({ entryId, userId }) => embeddingChildren(userId, entryId))
      ]);
      await expect(children()).resolves.toEqual([1, 1, 1, 0, 1, 1]);

      // Only the failure past its backoff is admitted; a repeat is a no-op.
      const sweepAt = new Date(start.getTime() + MEMORY_EMBEDDING_SWEEP_GRACE_MS + 5 * 60_000);
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: sweepAt }))
        .resolves.toEqual({ admitted: 1, failedOwners: 0 });
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: sweepAt }))
        .resolves.toEqual({ admitted: 0, failedOwners: 0 });
      await expect(children()).resolves.toEqual([2, 1, 1, 0, 1, 1]);

      // Rotating the failed call's credential releases the recent failure early.
      const rotatedVersionId = `memory-explicit-embedding-version-2-${randomUUID()}`;
      await prisma.providerCredentialVersion.create({ data: {
        activatedAt: start, credentialId: owner.credentialId, id: rotatedVersionId,
        secretEnvelope: "test-only-rotated-envelope", testedAt: start,
        testEvidence: { authenticationMode: "bearer" }, version: 2
      } });
      await prisma.providerCredential.update({
        data: { activeVersionId: rotatedVersionId }, where: { id: owner.credentialId }
      });
      await prisma.providerModelCredentialCheck.create({ data: {
        checkedAt: start, connectionId: owner.connectionId, connectionVersion: 1,
        credentialId: owner.credentialId, credentialVersionId: rotatedVersionId,
        evidence: embeddingCredentialEvidence, modelVersion: 1,
        providerModelId: owner.modelId, status: "available"
      } });
      await expect(sweepStrandedMemoryEmbeddings(prisma, { now: sweepAt }))
        .resolves.toEqual({ admitted: 1, failedOwners: 0 });
      await expect(children()).resolves.toEqual([2, 2, 1, 0, 1, 1]);
      // The sweep only queues work; it never calls a provider itself.
      expect(embed).toHaveBeenCalledTimes(2);

      failing = false;
      clock = new Date(sweepAt);
      await coordinator.reconcileNow();
      for (const entry of [earlierEntry, recentEntry, liveEntry]) {
        await expect(prisma.memorySearchEntry.findUniqueOrThrow({ where: { id: entry.id } }))
          .resolves.toMatchObject({ embeddingState: "READY" });
      }
      for (const entryId of [supersededEntry.id, ...fenced.map(({ entryId: id }) => id)]) {
        await expect(prisma.memorySearchEntry.findUniqueOrThrow({ where: { id: entryId } }))
          .resolves.toMatchObject({ embeddingState: "PENDING" });
      }
      await expect(children()).resolves.toEqual([2, 2, 1, 0, 1, 1]);
    } finally {
      coordinator.stop();
      await owner.cleanup();
      await paused.cleanup();
      await deleted.cleanup();
    }
  }, 90_000);

  it("packs a new child only into an unclaimed batch that does not hold its entry", async () => {
    const fixture = await createFixture();
    const { explicit } = memoryServices(fixture.classifierAuthority);
    let clock = new Date();
    let failing = true;
    const embed = vi.fn(async (request: { texts: readonly string[] }) => {
      if (failing) throw new EmbeddingAdapterError("embedding_provider_http_error");
      return batchVectors(request);
    });
    const coordinator = batchCoordinator(() => new Date(clock), embed);
    try {
      const first = await saveExplicit(
        explicit, fixture.userId, "I prefer morning standups.", "packing-first"
      );
      const firstEntry = await activeFactEntry(fixture.generationId, first);
      const attempted = await embeddingJobForEntry(fixture.userId, firstEntry.id);
      await coordinator.reconcileNow();
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: attempted.id } }))
        .resolves.toMatchObject({ attemptCount: 1, state: "RETRYABLE_FAILED" });
      // Requeued for its retry, the batch already fixed its input in a binding.
      await prisma.memoryJob.update({
        data: { nextAttemptAt: null, state: "QUEUED" }, where: { id: attempted.id }
      });
      const second = await saveExplicit(
        explicit, fixture.userId, "I prefer written agendas.", "packing-second"
      );
      const secondEntry = await activeFactEntry(fixture.generationId, second);
      const fresh = await embeddingJobForEntry(fixture.userId, secondEntry.id);
      expect(fresh.id).not.toBe(attempted.id);
      // Another trigger for an entry its open batch already holds opens a new
      // batch instead of colliding with the held child.
      const repeated = await withLockedMemoryTransaction(prisma, fixture.userId, (tx, settings) =>
        enqueueMemoryEmbeddingBatchItem(tx, settings, {
          entryId: secondEntry.id,
          triggerIdentity: "packing-second-trigger"
        }));
      expect(repeated).toMatchObject({ childCreated: true, created: true });
      expect([attempted.id, fresh.id]).not.toContain(repeated.id);

      failing = false;
      clock = new Date(clock.getTime() + 10);
      await coordinator.reconcileNow();
      expect(embed).toHaveBeenCalledTimes(3);
      await expect(prisma.memorySearchEntry.count({
        where: { embeddingState: "READY", userId: fixture.userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryEmbeddingBatchItem.count({
        where: { state: "FAILED", userId: fixture.userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: { errorCode: "memory_embedding_batch_binding_stale", userId: fixture.userId }
      })).resolves.toBe(0);
    } finally {
      coordinator.stop();
      await fixture.cleanup();
    }
  }, 60_000);
});
