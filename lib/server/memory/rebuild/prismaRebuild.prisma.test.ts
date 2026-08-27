import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type {
  MemoryDeletionClaim,
  MemoryJobClaim
} from "../coordinator/types";
import { createPrismaMemoryRetrievalCutoverRepository } from "../cutover/repository";
import { createPrismaMemoryItemEmbeddingRepository } from "../embedding/repository";
import {
  MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
  type MemoryItemEmbeddingPin
} from "../embedding/contract";
import {
  currentMemoryAdminDestinations,
  memoryAdminDestinationsFingerprint
} from "../execution/adminConsent";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  memoryVectorSpaceFingerprint,
  resolveCurrentMemoryUtilityPolicy
} from "../execution/policy";
import { memoryExecutionSha256 } from "../execution/canonical";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { createExplicitMemoryService } from "../explicit/service";
import {
  MEMORY_STATEMENT_CLASSIFICATION_PIPELINE_VERSION,
  MEMORY_STATEMENT_CLASSIFICATION_POLICY_VERSION,
  MEMORY_STATEMENT_CLASSIFICATION_PROMPT_VERSION,
  MEMORY_STATEMENT_CLASSIFICATION_SCHEMA_VERSION,
  memoryStatementClassificationInputHash,
  type MemoryStatementClassification,
  type MemoryStatementClassifier
} from "../explicit/statementClassifier";
import {
  memoryHistoryClearDeletionHandler,
  memoryHistorySourceDeletionHandler
} from "../history/purge";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import { applyMemoryHistorySourceMutation } from "../history/sourceLifecycle";
import { createPrismaMemoryLifecycleRepository } from "../lifecycle/repository";
import { createMemoryLifecycleService } from "../lifecycle/service";
import {
  createPrismaMemoryMutationAuthorizationRepository
} from "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_PURGE_REQUIRED_CONTRIBUTORS,
  memoryPurgeTargetType
} from "../purge/contract";
import { registerMemoryDeletionContributors } from "../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
import { memoryFeedbackIdempotencyFingerprint } from "../review/feedbackRepository";
import { MEMORY_RECLASSIFICATION_PIPELINE_VERSION } from
  "../reclassification/classifier";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../sourceState";
import { createMemoryRebuildHandler } from "./handler";
import { parseMemoryRebuildJobFingerprint } from "./contract";
import { createPrismaMemoryRebuildRepository } from "./repository";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 111));
const keyring = MemorySuppressionKeyring.parse(
  `current=rebuild-v1,rebuild-v1=${keyBytes.toString("base64")}`
);
const classifierProvider = {
  connectionId: `memory-rebuild-classifier-connection-${randomUUID()}`,
  credentialId: `memory-rebuild-classifier-credential-${randomUUID()}`,
  credentialVersionId: `memory-rebuild-classifier-version-${randomUUID()}`,
  modelId: `memory-rebuild-classifier-model-${randomUUID()}`
};
const classifierModelConfiguration = {
  adapterKind: "openai_responses_native",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: true,
    structuredOutput: true,
    vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "memory-rebuild-classifier-test-model"
} as const;
const EMBEDDING_DIMENSION = 1_024;
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
    nativeDimension: EMBEDDING_DIMENSION,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: EMBEDDING_DIMENSION
  },
  modelClass: "embedding",
  upstreamModelId: "memory-rebuild-embedding-v1"
} as const;

async function createClassifierProvider(): Promise<void> {
  const now = new Date();
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://memory-rebuild-classifier.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 30_000
  };
  await prisma.providerConnection.create({
    data: {
      activeConfig: connectionConfiguration,
      activeVersion: 1,
      activatedAt: now,
      displayName: "Memory rebuild classifier test provider",
      draftConfig: connectionConfiguration,
      draftVersion: 1,
      enabled: true,
      family: "openai",
      id: classifierProvider.connectionId,
      unassignedPolicy: "use_default"
    }
  });
  await prisma.providerCredential.create({
    data: {
      activatedAt: now,
      connectionId: classifierProvider.connectionId,
      draftVersion: 1,
      enabled: true,
      id: classifierProvider.credentialId,
      label: "Memory rebuild classifier credential",
      testedAt: now
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId: classifierProvider.credentialId,
      id: classifierProvider.credentialVersionId,
      secretEnvelope: "memory-rebuild-classifier-test-only-envelope",
      testedAt: now,
      testEvidence: { authenticationMode: "bearer" },
      version: 1
    }
  });
  await prisma.providerCredential.update({
    data: { activeVersionId: classifierProvider.credentialVersionId },
    where: { id: classifierProvider.credentialId }
  });
  await prisma.providerConnection.update({
    data: { defaultCredentialId: classifierProvider.credentialId },
    where: { id: classifierProvider.connectionId }
  });
  await prisma.providerModel.create({
    data: {
      activeConfig: classifierModelConfiguration,
      activeVersion: 1,
      activatedAt: now,
      capabilities: classifierModelConfiguration.capabilities,
      connectionId: classifierProvider.connectionId,
      defaultParams: {},
      displayName: "Memory rebuild classifier test model",
      draftConfig: classifierModelConfiguration,
      draftVersion: 1,
      enabled: true,
      id: classifierProvider.modelId,
      modelClass: "answer",
      modelId: classifierModelConfiguration.upstreamModelId,
      provider: "openai"
    }
  });
}

async function cleanupClassifierProvider(): Promise<void> {
  await prisma.providerConnection.updateMany({
    data: { defaultCredentialId: null },
    where: { id: classifierProvider.connectionId }
  });
  await prisma.providerCredential.updateMany({
    data: { activeVersionId: null },
    where: { id: classifierProvider.credentialId }
  });
  await prisma.providerModel.deleteMany({
    where: { id: classifierProvider.modelId }
  });
  await prisma.providerCredentialVersion.deleteMany({
    where: { id: classifierProvider.credentialVersionId }
  });
  await prisma.providerCredential.deleteMany({
    where: { id: classifierProvider.credentialId }
  });
  await prisma.providerConnection.deleteMany({
    where: { id: classifierProvider.connectionId }
  });
}

type GovernedStatementClassification = MemoryStatementClassification & Readonly<{
  acceptedOutputHash: string;
  classifiedAt: Date;
  executionId: string;
  inputHash: string;
  modelId: string;
  policyVersion: string;
  providerId: string;
}>;

async function createStatementClassificationReceipt(
  statement: string,
  execution: Readonly<{
    mutationAuthorizationId: string;
    userId: string;
  }>
): Promise<GovernedStatementClassification> {
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
    output: decision,
    role: "MEMORY_STATEMENT_CLASSIFY",
    version: 1
  });
  const startedAt = new Date();
  const completedAt = new Date(startedAt.getTime() + 1);
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash,
      cachedInputTokens: 0,
      completedAt,
      connectionId: classifierProvider.connectionId,
      createdAt: startedAt,
      credentialId: classifierProvider.credentialId,
      credentialVersionId: classifierProvider.credentialVersionId,
      destinationFingerprint: "c".repeat(64),
      id: executionId,
      inputHash,
      inputTokens: 5,
      logicalRole: "MEMORY_STATEMENT_CLASSIFY",
      mutationAuthorizationId: execution.mutationAuthorizationId,
      ordinal: 0,
      outputTokens: 2,
      ownerType: "MUTATION_AUTHORIZATION",
      pipelineVersion: MEMORY_STATEMENT_CLASSIFICATION_PIPELINE_VERSION,
      policyVersion: MEMORY_STATEMENT_CLASSIFICATION_POLICY_VERSION,
      promptVersion: MEMORY_STATEMENT_CLASSIFICATION_PROMPT_VERSION,
      providerId: "openai",
      providerModelId: classifierProvider.modelId,
      providerResponseId: `memory-rebuild-classifier-response-${randomUUID()}`,
      reasoningTokens: 0,
      recoverableUntil: new Date(completedAt.getTime() + 24 * 60 * 60 * 1_000),
      schemaVersion: MEMORY_STATEMENT_CLASSIFICATION_SCHEMA_VERSION,
      secretFreeExecutionSnapshot: {
        providerExecutionSnapshot: {
          providerFamily: "openai",
          providerModelId: classifierProvider.modelId
        },
        version: 1
      },
      startedAt,
      state: "SUCCEEDED",
      totalTokens: 7,
      usageCompleteness: "COMPLETE",
      userId: execution.userId
    }
  });
  await prisma.usageEvent.create({
    data: {
      cachedInputTokens: 0,
      inputTokens: 5,
      memoryExecutionBindingId: executionId,
      modelId: classifierProvider.modelId,
      outputTokens: 2,
      provider: "openai",
      providerModelId: classifierProvider.modelId,
      reasoningTokens: 0,
      totalTokens: 7,
      userId: execution.userId
    }
  });
  return {
    acceptedOutputHash,
    classifiedAt: completedAt,
    ...decision,
    executionId,
    inputHash,
    modelId: classifierProvider.modelId,
    policyVersion: MEMORY_STATEMENT_CLASSIFICATION_POLICY_VERSION,
    providerId: "openai"
  };
}

const statementClassifier: MemoryStatementClassifier = Object.freeze({
  async classify(statement, options) {
    const execution = options?.execution;
    if (!execution) throw new Error("memory_rebuild_classifier_execution_missing");
    return createStatementClassificationReceipt(statement, execution);
  }
});

function deletionRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return registry;
}

async function createOwner(label: string): Promise<string> {
  const suffix = randomUUID();
  const userId = `memory-rebuild-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: `Memory rebuild ${label}`,
      email: `memory-rebuild-${label}-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: { referenceChatHistory: true, useMemoryFacts: true },
    where: { userId }
  });
  return userId;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function configureEmbeddingProvider(
  userId: string,
  label: string
): Promise<Readonly<{
  cleanup(): Promise<void>;
  modelId: string;
  pin: MemoryItemEmbeddingPin;
}>> {
  const suffix = randomUUID();
  const connectionId = `memory-rebuild-${label}-connection-${suffix}`;
  const credentialId = `memory-rebuild-${label}-credential-${suffix}`;
  const credentialVersionId = `memory-rebuild-${label}-version-${suffix}`;
  const modelId = `memory-rebuild-${label}-model-${suffix}`;
  const now = new Date();
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://memory-rebuild-provider.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 30_000
  };
  await prisma.providerConnection.create({
    data: {
      activeConfig: connectionConfiguration,
      activeVersion: 1,
      activatedAt: now,
      displayName: "Memory rebuild embedding provider",
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
      activatedAt: now,
      connectionId,
      draftVersion: 1,
      enabled: true,
      id: credentialId,
      label: "Memory rebuild embedding credential",
      testedAt: now
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId,
      id: credentialVersionId,
      secretEnvelope: "test-only-envelope",
      testedAt: now,
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
      activatedAt: now,
      capabilities: embeddingConfiguration.capabilities,
      connectionId,
      defaultParams: {},
      displayName: "Memory rebuild embedding model",
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
      checkedAt: now,
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
  const policy = await prisma.$transaction(async (tx) => {
    const settings = await tx.userMemorySettings.findUniqueOrThrow({
      where: { userId }
    });
    return resolveCurrentMemoryUtilityPolicy(tx, userId, settings);
  });
  const target = policy.targets.get("MEMORY_DOCUMENT_EMBED");
  if (!target) throw new Error("memory_rebuild_embedding_target_unavailable");
  const vectorSpaceFingerprint = memoryVectorSpaceFingerprint(target);
  if (!vectorSpaceFingerprint) {
    throw new Error("memory_rebuild_vector_space_unavailable");
  }
  const adminDestinations = currentMemoryAdminDestinations([policy]);
  await prisma.memoryEgressAdminPolicy.upsert({
    create: {
      acceptedAt: now,
      acceptedDestinations: adminDestinations,
      acceptedFingerprint: memoryAdminDestinationsFingerprint(adminDestinations),
      acceptedPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
      id: "installation"
    },
    update: {
      acceptedAt: now,
      acceptedByUserId: null,
      acceptedDestinations: adminDestinations,
      acceptedFingerprint: memoryAdminDestinationsFingerprint(adminDestinations),
      acceptedPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
      version: { increment: 1 }
    },
    where: { id: "installation" }
  });
  await prisma.userMemorySettings.update({
    data: {
      acceptedUtilityEgressAt: now,
      acceptedUtilityEgressFingerprint: policy.fingerprint,
      acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
    },
    where: { userId }
  });
  return {
    async cleanup() {
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
    },
    modelId,
    pin: {
      configurationFingerprint: target.compatibilityFingerprints.configFingerprint,
      connectionId,
      dimension: EMBEDDING_DIMENSION,
      providerModelId: modelId,
      vectorSpaceFingerprint
    }
  };
}

function services() {
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const explicit = createExplicitMemoryService({
    authorizationRepository,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository,
    scopeRepository: createPrismaMemoryScopeRepository(prisma),
    statementClassifier
  });
  const lifecycle = createMemoryLifecycleService({
    authorizationRepository,
    mutationRepository: createPrismaMemoryLifecycleRepository(
      keyring,
      deletionRegistry(),
      prisma
    ),
    readRepository
  });
  return { authorizationRepository, explicit, lifecycle };
}

async function saveExplicit(
  explicit: ReturnType<typeof services>["explicit"],
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
  nonce: string
) {
  return createPrismaMemoryFactRepository(keyring, prisma, {
    consumeExplicitAuthorization: async () => undefined
  }).save(userId, {
    authorization: {
      action: "SAVE",
      authorizationId: `legacy-authorization-${nonce}`,
      authorizedPayloadHash: memorySha256({ nonce, statement })
    },
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: new Date("2026-08-21T08:00:00.000Z"),
      safeExcerpt: statement,
      safeSourceHash: memorySha256(statement),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-rebuild-legacy-test-v1"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint: `legacy-save-${nonce}`,
    requestId: `legacy-request-${nonce}`,
    scopeId,
    value: {
      canonicalKey: `legacy.rebuild.${nonce}`,
      category: "preferences",
      confidence: 1,
      directness: "DIRECT",
      displayText: statement,
      importance: 0.8,
      languageCode: "en",
      modality: "PREFERENCE",
      pipelineVersion: "memory-rebuild-legacy-test-v1",
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      structuredValue: { statement }
    }
  });
}


async function claimRebuildJob(jobId: string, now: Date): Promise<MemoryJobClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED",
      updatedAt: now
    },
    where: { id: jobId }
  });
  return {
    activeLeafMessageId: claimed.activeLeafMessageId,
    attemptCount: claimed.attemptCount,
    branchGeneration: claimed.branchGeneration,
    chatId: claimed.chatId,
    claimToken,
    id: claimed.id,
    idempotencyFingerprint: claimed.idempotencyFingerprint,
    kind: claimed.kind,
    leaseExpiresAt,
    memoryGenerationSnapshot: claimed.memoryGenerationSnapshot,
    memoryRevisionSnapshot: claimed.memoryRevisionSnapshot,
    pipelineVersion: claimed.pipelineVersion,
    recoveredLease: false,
    sourceHash: claimed.sourceHash,
    sourceMessageId: claimed.sourceMessageId,
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    targetFactVersionId: claimed.targetFactVersionId,
    userId: claimed.userId
  };
}

async function processRebuildJob(
  jobId: string,
  repository: ReturnType<typeof createPrismaMemoryRebuildRepository>
): Promise<void> {
  const now = new Date();
  const claim = await claimRebuildJob(jobId, now);
  const handler = createMemoryRebuildHandler(repository);
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const result = await handler.execute(claim, {
    now: () => now,
    setStage: async () => undefined,
    signal: new AbortController().signal
  });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  })).resolves.toBe(true);
}

async function waitForDatabaseTimeAfter(boundary: Date): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT CURRENT_TIMESTAMP AS "now"
    `;
    if (row && row.now.getTime() > boundary.getTime()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("database_time_boundary_not_reached");
}

async function claimDeletion(
  userId: string,
  deletionId: string,
  now: Date
): Promise<MemoryDeletionClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const row = await prisma.memoryDeletionOutbox.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "RUNNING",
      updatedAt: now
    },
    where: { id: deletionId }
  });
  return {
    admissionAuthorizationId: row.admissionAuthorizationId,
    admittedActiveLeafMessageId: row.admittedActiveLeafMessageId,
    admittedChatSourceRevision: row.admittedChatSourceRevision,
    alsoForgetOriginMemories: row.alsoForgetOriginMemories,
    attemptCount: row.attemptCount,
    claimToken,
    id: row.id,
    leaseExpiresAt,
    memoryGeneration: row.memoryGeneration,
    operation: row.operation,
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: row.targetId,
    targetType: row.targetType,
    userId
  };
}

async function createLiveRetrievalAttempt(
  userId: string,
  indexGenerationId: string,
  counters: Readonly<{ memoryGeneration: number; memoryRevision: number }>
): Promise<string> {
  const chat = await prisma.chat.create({
    data: { title: "Live rebuild attempt", userId }
  });
  const userMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent("Prepare one response with Memory."),
      role: "user",
      status: "complete"
    }
  });
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(""),
      parentMessageId: userMessage.id,
      role: "assistant",
      status: "queued"
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: assistantMessage.id },
    where: { id: chat.id }
  });
  return prisma.$transaction(async (tx) => {
    const run = await tx.modelRun.create({
      data: {
        assistantMessageId: assistantMessage.id,
        chatId: chat.id,
        modelId: "memory-rebuild-test-model",
        provider: "memory-rebuild-test-provider",
        status: "preparing",
        userId,
        userMessageId: userMessage.id
      }
    });
    const attempt = await tx.memoryRetrievalAttempt.create({
      data: {
        admissionKind: "NORMAL_SEND",
        admittedAssistantLeafMessageId: assistantMessage.id,
        admittedUserMessageId: userMessage.id,
        attemptOrdinal: 0,
        baseRequestHash: memorySha256({ runId: run.id, type: "base" }),
        boundedPrivateBaseRequestSnapshot: {},
        chatId: chat.id,
        chatMemoryModeSnapshot: "NORMAL",
        expiresAt: new Date(Date.now() + 60_000),
        indexGenerationIdSnapshot: indexGenerationId,
        memoryGenerationSnapshot: counters.memoryGeneration,
        modelRunId: run.id,
        queryHash: memorySha256({ runId: run.id, type: "query" }),
        retrievalRevisionSnapshot: counters.memoryRevision,
        settingsSnapshot: {},
        state: "PENDING",
        userId,
        utilityEgressMode: "LOCAL_ONLY"
      }
    });
    return attempt.id;
  });
}

async function createHistoryDerivative(input: Readonly<{
  activeIndexGenerationId: string;
  chatId?: string;
  createdAt: Date;
  label: string;
  parentMessageId?: string | null;
  sourceRevision: number;
  userId: string;
}>) {
  const chat = input.chatId
    ? await prisma.chat.findUniqueOrThrow({ where: { id: input.chatId } })
    : await prisma.chat.create({
        data: { title: `Memory clear ${input.label}`, userId: input.userId }
      });
  const text = `History derivative ${input.label}`;
  const userMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(text),
      createdAt: input.createdAt,
      parentMessageId: input.parentMessageId ?? null,
      role: "user",
      status: "complete",
      updatedAt: input.createdAt
    }
  });
  const assistantAt = new Date(input.createdAt.getTime() + 1);
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(`Acknowledged ${input.label}`),
      createdAt: assistantAt,
      parentMessageId: userMessage.id,
      role: "assistant",
      status: "complete",
      updatedAt: assistantAt
    }
  });
  const sourceHash = memorySha256({
    assistantMessageId: assistantMessage.id,
    sourceRevision: input.sourceRevision,
    userMessageId: userMessage.id
  });
  await prisma.chat.update({
    data: {
      activeLeafMessageId: assistantMessage.id,
      memorySourceRevision: input.sourceRevision
    },
    where: { id: chat.id }
  });
  await prisma.chatMemoryCheckpoint.upsert({
    create: {
      activeLeafMessageId: assistantMessage.id,
      branchGeneration: 0,
      chatId: chat.id,
      lastIndexedMessageId: assistantMessage.id,
      lastSucceededAt: assistantAt,
      sourceContentHash: sourceHash,
      sourceRevision: input.sourceRevision,
      status: "READY",
      userId: input.userId
    },
    update: {
      activeLeafMessageId: assistantMessage.id,
      branchGeneration: 0,
      lastErrorCode: null,
      lastIndexedMessageId: assistantMessage.id,
      lastSucceededAt: assistantAt,
      sourceContentHash: sourceHash,
      sourceRevision: input.sourceRevision,
      status: "READY"
    },
    where: { userId_chatId: { chatId: chat.id, userId: input.userId } }
  });
  const checkpointMessages = await prisma.message.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true, id: true, updatedAt: true },
    where: { chatId: chat.id }
  });
  await prisma.$transaction(async (tx) => {
    await tx.chatMemoryCheckpointMessage.deleteMany({
      where: { chatId: chat.id, userId: input.userId }
    });
    await tx.chatMemoryCheckpointMessage.createMany({
      data: checkpointMessages.map((message, ordinal) => ({
        chatId: chat.id,
        messageId: message.id,
        ordinal,
        sourceMessageCreatedAt: message.createdAt,
        sourceMessageUpdatedAt: message.updatedAt,
        userId: input.userId
      }))
    });
  });

  const chunkId = randomUUID();
  const contentHash = memorySha256(text);
  await prisma.$transaction(async (tx) => {
    await tx.memoryRecallChunk.create({
      data: {
        branchGeneration: 0,
        chatId: chat.id,
        chunkOrdinal: 0,
        chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
        contentHash,
        createdAt: assistantAt,
        id: chunkId,
        languageCode: "en",
        normalizedSafeSearchText: normalizeMemorySearchText(text),
        occurredFrom: input.createdAt,
        occurredTo: assistantAt,
        redactionReasonCodes: [],
        redactionState: "NOT_NEEDED",
        safeProjectedText: text,
        safetyClass: "NORMAL",
        sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
        sourceRevisionAtCreation: input.sourceRevision,
        userId: input.userId
      }
    });
    await tx.memoryRecallChunkMessage.create({
      data: {
        chatId: chat.id,
        chunkId,
        endOffset: text.length,
        messageId: userMessage.id,
        ordinal: 0,
        role: "user",
        safeTextHash: memorySha256(text),
        sourceMessageContentHash: memorySha256(userMessage.content),
        sourceMessageUpdatedAt: userMessage.updatedAt,
        startOffset: 0,
        userId: input.userId
      }
    });
  });
  await prisma.memorySearchEntry.create({
    data: {
      embeddingState: "NOT_APPLICABLE",
      indexGenerationId: input.activeIndexGenerationId,
      itemType: "RECALL_CHUNK",
      languageCode: "en",
      recallChunkId: chunkId,
      safeContentHash: contentHash,
      normalizedSearchText: normalizeMemorySearchText(text),
      safetyIdentitySnapshot: memorySha256({ safety: "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({ chunkId, sourceHash }),
      suppressionIdentitySnapshot: memorySha256({ suppressions: [] }),
      userId: input.userId
    }
  });

  return {
    assistantMessageId: assistantMessage.id,
    chatId: chat.id,
    chunkId,
    userMessageId: userMessage.id
  };
}

type FeedbackFixtureTarget =
  | Readonly<{ factId: string; kind: "FACT_VERSION"; versionId: string }>
  | Readonly<{ chunkId: string; kind: "RECALL_CHUNK" }>;

async function createFeedbackFixture(input: Readonly<{
  comment: string | null;
  createdAt?: Date;
  feedbackType?: "NOT_USEFUL" | "RETRACT";
  retractsFeedbackId?: string;
  sourceBranchGeneration: number;
  sourceChatId: string;
  target: FeedbackFixtureTarget;
  userId: string;
}>): Promise<string> {
  const createdAt = input.createdAt ?? new Date();
  const feedbackType = input.feedbackType ?? "NOT_USEFUL";
  const eventId = randomUUID();
  const feedbackId = randomUUID();
  const requestId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryEvent.create({
      data: {
        actorType: "USER",
        actorUserId: input.userId,
        createdAt,
        factId: input.target.kind === "FACT_VERSION" ? input.target.factId : null,
        factVersionId: input.target.kind === "FACT_VERSION"
          ? input.target.versionId
          : null,
        id: eventId,
        metadata: {
          feedbackId,
          feedbackType,
          schemaVersion: "memory-feedback-event-v1"
        },
        operation: "USER_FEEDBACK",
        sourceChatId: input.sourceChatId,
        userId: input.userId
      }
    });
    await tx.memoryFeedback.create({
      data: {
        comment: input.comment,
        createdAt,
        feedbackType,
        id: feedbackId,
        idempotencyFingerprint: memoryFeedbackIdempotencyFingerprint(
          input.userId,
          requestId
        ),
        memoryEventId: eventId,
        memoryFactId: input.target.kind === "FACT_VERSION" ? input.target.factId : null,
        memoryFactVersionId: input.target.kind === "FACT_VERSION"
          ? input.target.versionId
          : null,
        recallChunkId: input.target.kind === "RECALL_CHUNK"
          ? input.target.chunkId
          : null,
        retractsFeedbackId: input.retractsFeedbackId,
        requestId,
        sourceBranchGenerationSnapshot: input.sourceBranchGeneration,
        sourceChatIdSnapshot: input.sourceChatId,
        targetKind: input.target.kind,
        userId: input.userId
      }
    });
  });
  return feedbackId;
}

async function createHistoryReceiptDerivatives(input: Readonly<{
  activeIndexGenerationId: string;
  assistantMessageId: string;
  chatId: string;
  chunkId: string;
  sourceMessageId: string;
  userId: string;
}>) {
  const marker = "history receipt marker alpha";
  const now = new Date("2026-08-10T08:01:00.000Z");
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId: input.userId }
  });
  const chunk = await prisma.memoryRecallChunk.findUniqueOrThrow({
    where: { id: input.chunkId }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: input.assistantMessageId,
      chatId: input.chatId,
      modelId: "memory-history-receipt-model",
      normalizedRequest: {},
      provider: "memory-history-receipt-provider",
      status: "complete",
      userId: input.userId,
      userMessageId: input.sourceMessageId
    }
  });
  const preparedContext = `Accepted ${marker}`;
  const includedText = `Remembered ${marker}`;
  const { attempt, binding } = await prisma.$transaction(async (tx) => {
    const attempt = await tx.memoryRetrievalAttempt.create({
      data: {
        admissionKind: "NORMAL_SEND",
        admittedAssistantLeafMessageId: input.assistantMessageId,
        admittedUserMessageId: input.sourceMessageId,
        attemptOrdinal: 0,
        baseRequestHash: memorySha256({ marker, type: "base" }),
        boundedPrivateBaseRequestSnapshot: {},
        chatId: input.chatId,
        chatMemoryModeSnapshot: "NORMAL",
        consumedAt: now,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        indexGenerationIdSnapshot: input.activeIndexGenerationId,
        memoryGenerationSnapshot: settings.memoryGeneration,
        modelRunId: run.id,
        outcome: "USED",
        preparedContextHash: memorySha256(preparedContext),
        preparedContextText: preparedContext,
        preparedContextTokenCount: 8,
        queryHash: memorySha256(marker),
        retrievalRevisionSnapshot: settings.memoryRevision,
        settingsSnapshot: {},
        state: "CONSUMED",
        userId: input.userId,
        utilityEgressMode: "LOCAL_ONLY"
      }
    });
    const binding = await tx.modelRunMemoryBinding.create({
      data: {
        boundedSafeQuerySnapshot: marker,
        contextTextHash: memorySha256(preparedContext),
        contextTokenCount: 8,
        finalizedAt: now,
        finalizedRevisionSnapshot: settings.memoryRevision,
        indexGenerationId: input.activeIndexGenerationId,
        memoryGenerationSnapshot: settings.memoryGeneration,
        modelRunId: run.id,
        outcome: "USED",
        queryHash: memorySha256(marker),
        queryPlannerVersion: "history-receipt-fixture-v1",
        retrievalAttemptId: attempt.id,
        retrievalPipelineVersion: "history-receipt-fixture-v1",
        retrievalRevisionSnapshot: settings.memoryRevision,
        settingsSnapshot: {},
        userId: input.userId
      }
    });
    await tx.memoryRetrievalAttemptItem.create({
      data: {
        attemptId: attempt.id,
        exactItemId: input.chunkId,
        exactSafeText: includedText,
        factVersionId: null,
        featureSnapshot: {},
        itemType: "RECALL_CHUNK",
        laneRanks: {},
        ordinal: 0,
        recallChunkId: input.chunkId,
        selectionReason: "history-receipt-fixture",
        sourceBranchGenerationSnapshot: chunk.branchGeneration,
        sourceChatIdSnapshot: input.chatId,
        sourceContentHashSnapshot: chunk.contentHash,
        sourceRevisionSnapshot: chunk.sourceRevisionAtCreation,
        sourceSnapshot: { sourceMessageIds: [input.sourceMessageId] },
        textHash: memorySha256(includedText),
        userId: input.userId,
        versionSnapshot: {}
      }
    });
    return { attempt, binding };
  });
  const memoryItem = await prisma.modelRunMemoryItem.create({
    data: {
      bindingId: binding.id,
      exactItemId: input.chunkId,
      featureSnapshot: {},
      finalScore: 0.9,
      includedText,
      includedTextHash: memorySha256(includedText),
      itemStateAtAdmission: "ACTIVE",
      itemType: "RECALL_CHUNK",
      laneRanks: {},
      ordinal: 0,
      recallChunkId: input.chunkId,
      selectionReason: "history-receipt-fixture",
      sourceBranchGenerationSnapshot: chunk.branchGeneration,
      sourceChatIdSnapshot: input.chatId,
      sourceContentHashSnapshot: chunk.contentHash,
      sourceMessageIdsSnapshot: [input.sourceMessageId],
      sourceRevisionSnapshot: chunk.sourceRevisionAtCreation,
      userId: input.userId
    }
  });
  const destinationSnapshot = {
    displayName: "Fixture MCP",
    fingerprint: "fixture-mcp-fingerprint",
    kind: "mcp" as const,
    serverId: "fixture-mcp-server",
    version: 1 as const
  };
  const egressReceipt = await prisma.memoryToolEgressReceipt.create({
    data: {
      destinationFingerprint: memorySha256(destinationSnapshot),
      destinationKind: "mcp",
      destinationSnapshot,
      dispatchCompletedAt: now,
      dispatchStartedAt: now,
      dispatchState: "COMPLETED",
      mode: "PROVIDER_REQUEST",
      modelRunId: run.id,
      requestOrdinal: 1,
      requestEvidenceHash: memorySha256({ marker, type: "request" }),
      userId: input.userId
    }
  });
  const toolCall = await prisma.modelRunToolCall.create({
    data: {
      arguments: { query: marker },
      completedAt: now,
      modelRunId: run.id,
      ordinal: 0,
      providerCallId: `history-receipt-call-${randomUUID()}`,
      result: {
        callId: "history-receipt-call",
        content: [{ type: "json", value: { marker } }],
        name: "search_my_history",
        status: "complete"
      },
      roundIndex: 0,
      startedAt: now,
      state: "complete",
      toolName: "search_my_history"
    }
  });
  const privateResults = {
    indexing: {
      degradationCode: null,
      lexicalState: "READY",
      vectorState: "NOT_CONFIGURED"
    },
    nextCursor: null,
    results: [{
      indexingState: "LEXICAL_READY",
      itemType: "RECALL_CHUNK",
      occurredAt: now.toISOString(),
      sourceChatId: input.chatId,
      sourceChatTitle: "Receipt source",
      sourceFolderId: null,
      sourceFolderName: null,
      sourceMessageIds: [input.sourceMessageId],
      sourceState: "AVAILABLE",
      snippet: marker
    }]
  };
  const providerResult = {
    callId: toolCall.providerCallId,
    content: [{ type: "json", value: { ...privateResults, untrusted: true } }],
    name: "search_my_history",
    status: "complete"
  };
  const historyRun = await prisma.memoryHistoryRun.create({
    data: {
      completedAt: now,
      durationMs: 1,
      indexingEvidence: privateResults.indexing,
      invocationOrdinal: 1,
      modelRunId: run.id,
      modelRunToolCallId: toolCall.id,
      outcome: "RESULTS",
      privateRequest: { query: marker },
      providerResult,
      query: marker,
      queryHash: memorySha256(marker),
      resultCount: 1,
      resultHash: memorySha256(providerResult),
      results: privateResults,
      state: "COMPLETE",
      userId: input.userId
    }
  });
  return {
    attemptId: attempt.id,
    bindingId: binding.id,
    egressReceiptId: egressReceipt.id,
    destinationSnapshot,
    historyRunId: historyRun.id,
    marker,
    memoryItemId: memoryItem.id,
    toolCallId: toolCall.id
  };
}

async function expectHistoryReceiptScrubbedWithAcceptedEvidenceRetained(
  receipt: Awaited<ReturnType<typeof createHistoryReceiptDerivatives>>
): Promise<void> {
  const scrubbedHistory = await prisma.memoryHistoryRun.findUniqueOrThrow({
    where: { id: receipt.historyRunId }
  });
  expect(scrubbedHistory).toMatchObject({
    plaintextPurgedAt: expect.any(Date),
    privateRequest: {},
    providerResult: null,
    query: null,
    resultHash: null,
    results: null,
    retentionState: "SCRUBBED",
    state: "COMPLETE"
  });
  expect(JSON.stringify(scrubbedHistory)).not.toContain(receipt.marker);
  const scrubbedCall = await prisma.modelRunToolCall.findUniqueOrThrow({
    where: { id: receipt.toolCallId }
  });
  expect(scrubbedCall.arguments).toEqual({});
  expect(scrubbedCall.result).toMatchObject({
    content: [{ value: { error: "memory_history_receipt_scrubbed" } }],
    status: "error"
  });
  expect(JSON.stringify(scrubbedCall)).not.toContain(receipt.marker);
  await expect(prisma.memoryToolEgressReceipt.findUniqueOrThrow({
    where: { id: receipt.egressReceiptId }
  })).resolves.toMatchObject({
    dispatchState: "COMPLETED",
    errorCode: null,
    mode: "PROVIDER_REQUEST"
  });
  await expect(prisma.modelRunMemoryBinding.findUniqueOrThrow({
    where: { id: receipt.bindingId }
  })).resolves.toMatchObject({ outcome: "USED" });
  await expect(prisma.modelRunMemoryItem.findUniqueOrThrow({
    where: { id: receipt.memoryItemId }
  })).resolves.toMatchObject({
    includedText: expect.stringContaining(receipt.marker),
    itemType: "RECALL_CHUNK"
  });
  await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
    where: { id: receipt.attemptId }
  })).resolves.toMatchObject({
    consumedAt: expect.any(Date),
    errorCode: "memory_source_stale",
    outcome: "USED",
    preparedContextHash: memorySha256(""),
    preparedContextText: "",
    preparedContextTokenCount: 0,
    state: "CONSUMED"
  });
  await expect(prisma.memoryRetrievalAttemptItem.count({
    where: { attemptId: receipt.attemptId }
  })).resolves.toBe(0);
}

describe("Prisma Memory shadow rebuild and history clear", () => {
  beforeAll(async () => {
    await createClassifierProvider();
  });

  afterAll(async () => {
    await cleanupClassifierProvider();
    await prisma.$disconnect();
  });

  it("catches up save and Forget races before one fenced lexical activation", async () => {
    const userId = await createOwner("race");
    const { explicit, lifecycle } = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    try {
      const forgotten = await saveExplicit(
        explicit,
        userId,
        "I prefer window seats on daytime trains.",
        "race-save-a"
      );
      const admissionSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rebuildStartedAt = performance.now();
      const admitted = await repository.admit(userId, {
        expectedMemoryRevision: admissionSettings.memoryRevision,
        expectedSettingsRevision: admissionSettings.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "race-rebuild" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const identity = parseMemoryRebuildJobFingerprint((await prisma.memoryJob
        .findUniqueOrThrow({ where: { id: admitted.jobId } })).idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("shadow_missing");

      const retained = await saveExplicit(
        explicit,
        userId,
        "I prefer concise release summaries.",
        "race-save-b"
      );
      const forgetAuthorization = await explicit.mintAuthorization(userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: forgotten.memory.currentVersionId!,
        requestNonce: "race-forget-a",
        targetFactId: forgotten.memory.id
      });
      await lifecycle.forget(userId, forgotten.memory.id, {
        expectedVersionId: forgotten.memory.currentVersionId!,
        mutationAuthorizationId: forgetAuthorization.mutationAuthorizationId
      });
      const beforeActivation = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      if (!beforeActivation.activeIndexGenerationId) {
        throw new Error("active_generation_missing");
      }
      await createLiveRetrievalAttempt(
        userId,
        beforeActivation.activeIndexGenerationId,
        beforeActivation
      );

      await processRebuildJob(admitted.jobId, repository);
      const target = await prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: identity.generationId }
      });
      if (!target.sourceIndexGenerationId) throw new Error("source_missing");
      const [after, source, entries] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryIndexGeneration.findUniqueOrThrow({
          where: { id: target.sourceIndexGenerationId }
        }),
        prisma.memorySearchEntry.findMany({
          where: { indexGenerationId: identity.generationId, userId }
        })
      ]);
      expect(after).toMatchObject({
        activeIndexGenerationId: identity.generationId,
        memoryGeneration: beforeActivation.memoryGeneration + 1,
        memoryRevision: beforeActivation.memoryRevision + 1
      });
      expect(target).toMatchObject({
        indexedThroughMemoryRevision: after.memoryRevision,
        state: "ACTIVE"
      });
      expect(source.state).toBe("SUPERSEDED");
      await expect(prisma.memorySearchEntry.count({
        where: { indexGenerationId: source.id, userId }
      })).resolves.toBe(1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        embeddingState: "NOT_APPLICABLE",
        factVersionId: retained.memory.currentVersionId
      });
      expect(entries.some(({ factVersionId }) =>
        factVersionId === forgotten.memory.currentVersionId)).toBe(false);
      const evidence = Object.freeze({
        activationCount: 1,
        evidenceVersion: "memory-rebuild-latency-v1",
        maximumRebuildLatencyMs: 15 * 60_000,
        rebuildLatencyMs: Number((performance.now() - rebuildStartedAt).toFixed(2)),
        resurrectionCount: 0,
        sanitizedAggregatesOnly: true
      });
      expect(evidence.rebuildLatencyMs).toBeLessThan(evidence.maximumRebuildLatencyMs);
      expect(JSON.stringify(evidence)).not.toContain(userId);
      console.info("memory_rebuild_latency", evidence);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("waits for current-fence source jobs and wakes cutover after terminal settlement", async () => {
    const userId = await createOwner("source-job-cutover");
    const { explicit } = services();
    const rebuild = createPrismaMemoryRebuildRepository(prisma);
    const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
    try {
      await saveExplicit(
        explicit,
        userId,
        "Keep source-job cutover summaries concise.",
        "source-job-cutover-save"
      );
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await rebuild.admit(userId, {
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "source-job-cutover" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const rebuildJob = await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      });
      const identity = parseMemoryRebuildJobFingerprint(
        rebuildJob.idempotencyFingerprint
      );
      if (!identity || identity.type !== "SHADOW") throw new Error("shadow_missing");
      const blocker = await prisma.memoryJob.create({
        data: {
          idempotencyFingerprint: memorySha256({
            nonce: "source-job-cutover-blocker",
            userId
          }),
          kind: "RECLASSIFY_FACTS",
          memoryGenerationSnapshot: before.memoryGeneration,
          memoryRevisionSnapshot: before.memoryRevision,
          pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
          userId
        }
      });

      await processRebuildJob(admitted.jobId, rebuild);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        activeIndexGenerationId: before.activeIndexGenerationId,
        memoryGeneration: before.memoryGeneration,
        memoryRevision: before.memoryRevision
      });
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: identity.generationId }
      })).resolves.toMatchObject({ state: "CATCHING_UP" });
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      })).resolves.toMatchObject({ state: "SUCCEEDED" });

      const blockerClaim = await claimRebuildJob(blocker.id, new Date());
      await expect(coordinator.commitJobSuccess({
        acceptedResultHash: "d".repeat(64),
        claim: blockerClaim,
        now: new Date(),
        stage: "source_settled"
      })).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      })).resolves.toMatchObject({ state: "QUEUED" });

      await processRebuildJob(admitted.jobId, rebuild);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        activeIndexGenerationId: identity.generationId,
        memoryGeneration: before.memoryGeneration + 1,
        memoryRevision: before.memoryRevision + 1
      });
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: blocker.id }
      })).resolves.toMatchObject({ state: "SUCCEEDED" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("cuts over content-free identities idempotently and rolls back an exact generation", async () => {
    const userId = await createOwner("cutover-rollback");
    const { explicit } = services();
    const rebuild = createPrismaMemoryRebuildRepository(prisma);
    const cutover = createPrismaMemoryRetrievalCutoverRepository(prisma);
    const statement = "I prefer immutable, content-free cutover evidence.";
    try {
      const initialSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const now = new Date();
      const legacyGeneration = await prisma.$transaction(async (tx) => {
        const generation = await tx.memoryIndexGeneration.create({
          data: {
            activatedAt: now,
            chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
            generation: 0,
            indexMode: "LEXICAL_ONLY",
            indexedThroughMemoryRevision: initialSettings.memoryRevision,
            languageProfile: "UNICODE_SIMPLE_V3",
            normalizationVersion: "memory-search-normalization-v3",
            readyAt: now,
            retrievalPipelineVersion: "memory-personal-retrieval-v3-lexical",
            state: "ACTIVE",
            targetMemoryRevision: initialSettings.memoryRevision,
            userId
          }
        });
        await tx.userMemorySettings.update({
          data: { activeIndexGenerationId: generation.id },
          where: { userId }
        });
        return generation;
      });
      await saveExplicit(explicit, userId, statement, "cutover-explicit");

      const before = await cutover.inventory(userId);
      expect(before).toMatchObject({
        activeGenerationId: legacyGeneration.id,
        activePipelineVersion: "memory-personal-retrieval-v3-lexical",
        compatibleExplicitFactVersions: 1,
        eligibleItems: 1,
        ready: false
      });
      expect(before.eligibleIdentityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(before)).not.toContain(statement);

      const admitted = await cutover.ensure(userId);
      expect(admitted).toMatchObject({ kind: "queued", jobId: expect.any(String) });
      if (!admitted.jobId) throw new Error("cutover_job_missing");
      await expect(cutover.ensure(userId)).resolves.toMatchObject({
        jobId: admitted.jobId,
        kind: "in_progress"
      });
      await processRebuildJob(admitted.jobId, rebuild);

      const current = await cutover.inventory(userId);
      expect(current).toMatchObject({
        activePipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
        compatibleExplicitFactVersions: 1,
        eligibleItems: 1,
        ready: true
      });
      expect(current.activeGenerationId).not.toBe(legacyGeneration.id);
      await expect(cutover.ensure(userId)).resolves.toMatchObject({
        generationId: current.activeGenerationId,
        jobId: null,
        kind: "already_current"
      });

      const firstCurrentGenerationId = current.activeGenerationId;
      if (!firstCurrentGenerationId) throw new Error("cutover_generation_missing");
      const beforeSecond = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const second = await rebuild.admit(userId, {
        expectedMemoryRevision: beforeSecond.memoryRevision,
        expectedSettingsRevision: beforeSecond.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "cutover-second-generation" }
      });
      if (second.kind !== "ok") throw new Error(second.kind);
      await processRebuildJob(second.jobId, rebuild);

      const beforeRollback = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(beforeRollback.activeIndexGenerationId).not.toBe(firstCurrentGenerationId);
      const secondCurrentGenerationId = beforeRollback.activeIndexGenerationId;
      if (!secondCurrentGenerationId) throw new Error("cutover_generation_missing");
      await expect(cutover.rollback(userId, firstCurrentGenerationId, {
        expectedMemoryRevision: beforeRollback.memoryRevision,
        expectedSettingsRevision: beforeRollback.settingsRevision
      })).resolves.toEqual({
        activeGenerationId: firstCurrentGenerationId,
        kind: "ok"
      });
      const afterRollback = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(afterRollback).toMatchObject({
        activeIndexGenerationId: firstCurrentGenerationId,
        memoryGeneration: beforeRollback.memoryGeneration + 1,
        memoryRevision: beforeRollback.memoryRevision + 1
      });
      await expect(cutover.inventory(userId)).resolves.toMatchObject({
        activeGenerationId: firstCurrentGenerationId,
        eligibleItems: 1,
        ready: true
      });
      await saveExplicit(
        explicit,
        userId,
        "I also prefer exact-set rollback fences.",
        "cutover-rollback-source-set-change"
      );
      const afterSourceSetChange = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(cutover.rollback(userId, secondCurrentGenerationId, {
        expectedMemoryRevision: afterSourceSetChange.memoryRevision,
        expectedSettingsRevision: afterSourceSetChange.settingsRevision
      })).resolves.toEqual({
        activeGenerationId: firstCurrentGenerationId,
        kind: "generation_incompatible"
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({ activeIndexGenerationId: firstCurrentGenerationId });
      expect(JSON.stringify({ admitted, before, current })).not.toContain(statement);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("keeps a legacy-scoped fact out of a rebuilt search generation", async () => {
    const userId = await createOwner("legacy-scope");
    const { explicit } = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    try {
      const retained = await saveExplicit(
        explicit,
        userId,
        "I prefer canonical global rebuild facts.",
        "legacy-rebuild-global"
      );
      const folder = await prisma.folder.create({
        data: { name: "Legacy rebuild scope", userId }
      });
      const legacyStatement = "I prefer a legacy folder scoped rebuild fact.";
      const legacyScope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: folder.id,
        type: "FOLDER"
      });
      const legacy = await saveLegacyExplicit(
        userId,
        legacyScope.id,
        legacyStatement,
        `legacy-rebuild-folder-${randomUUID()}`
      );
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await repository.admit(userId, {
        expectedMemoryRevision: settings.memoryRevision,
        expectedSettingsRevision: settings.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "legacy-scope-rebuild" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const identity = parseMemoryRebuildJobFingerprint((await prisma.memoryJob
        .findUniqueOrThrow({ where: { id: admitted.jobId } })).idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("shadow_missing");

      await processRebuildJob(admitted.jobId, repository);
      const factVersionIds = (await prisma.memorySearchEntry.findMany({
        select: { factVersionId: true },
        where: { indexGenerationId: identity.generationId, userId }
      })).flatMap(({ factVersionId }) => factVersionId ? [factVersionId] : []);

      expect(factVersionIds).toContain(retained.memory.currentVersionId);
      expect(factVersionIds).not.toContain(legacy.versionId);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("does not resurrect an elapsed active fact into a rebuilt generation", async () => {
    const userId = await createOwner("expired-fact");
    const { explicit } = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    try {
      const retained = await saveExplicit(
        explicit,
        userId,
        "I prefer retained rebuild facts.",
        "expired-rebuild-retained"
      );
      const expiring = await saveExplicit(
        explicit,
        userId,
        "I prefer an expiring rebuild fact.",
        "expired-rebuild-target"
      );
      const [databaseClock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT CURRENT_TIMESTAMP AS "now"
      `;
      if (!databaseClock) throw new Error("database_clock_missing");
      const expiresAt = new Date(databaseClock.now.getTime() + 750);
      await prisma.memoryFactVersion.update({
        data: { expiresAt },
        where: { id: expiring.memory.currentVersionId! }
      });
      await waitForDatabaseTimeAfter(expiresAt);

      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await repository.admit(userId, {
        expectedMemoryRevision: settings.memoryRevision,
        expectedSettingsRevision: settings.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "expired-fact-rebuild" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const job = await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      });
      const identity = parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("shadow_missing");
      await processRebuildJob(admitted.jobId, repository);

      const factVersionIds = (await prisma.memorySearchEntry.findMany({
        select: { factVersionId: true },
        where: { indexGenerationId: identity.generationId, userId }
      })).flatMap(({ factVersionId }) => factVersionId ? [factVersionId] : []);
      expect(factVersionIds).toContain(retained.memory.currentVersionId);
      expect(factVersionIds).not.toContain(expiring.memory.currentVersionId);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("activates a HYBRID shadow only after every mandatory vector is ready", async () => {
    const userId = await createOwner("hybrid-success");
    const { explicit } = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    let provider: Awaited<ReturnType<typeof configureEmbeddingProvider>> | null = null;
    try {
      await saveExplicit(
        explicit,
        userId,
        "Prefer SI units in technical explanations.",
        "hybrid-success-a"
      );
      await saveExplicit(
        explicit,
        userId,
        "Keep release summaries concise.",
        "hybrid-success-b"
      );
      provider = await configureEmbeddingProvider(userId, "hybrid-success");
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(repository.admit(userId, {
        embeddingDeploymentId: provider.modelId,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "REEMBED",
        pin: { ...provider.pin, vectorSpaceFingerprint: "f".repeat(64) },
        requestIdentity: { nonce: "hybrid-stale-pin" }
      })).resolves.toEqual({ kind: "embedding_unavailable" });
      const admitted = await repository.admit(userId, {
        embeddingDeploymentId: provider.modelId,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "REEMBED",
        pin: provider.pin,
        requestIdentity: { nonce: "hybrid-success" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const identity = parseMemoryRebuildJobFingerprint((await prisma.memoryJob
        .findUniqueOrThrow({ where: { id: admitted.jobId } })).idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("shadow_missing");

      await processRebuildJob(admitted.jobId, repository);
      const initialPending = await prisma.memorySearchEntry.findMany({
        orderBy: { id: "asc" },
        where: { indexGenerationId: identity.generationId, userId }
      });
      expect(initialPending).toHaveLength(2);
      expect(initialPending.every(({ embeddingState }) =>
        embeddingState === "PENDING"))
        .toBe(true);
      await expect(repository.status(userId, admitted.jobId)).resolves.toMatchObject({
        completedUnits: 0,
        state: "CATCHING_UP",
        totalUnits: 2
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        activeIndexGenerationId: before.activeIndexGenerationId,
        memoryGeneration: before.memoryGeneration,
        memoryRevision: before.memoryRevision
      });

      await saveExplicit(
        explicit,
        userId,
        "Use UTC timestamps in release reports.",
        "hybrid-success-c"
      );
      await processRebuildJob(admitted.jobId, repository);
      const [caughtUp, pending, embeddingJobCount, embeddingChildCount] =
        await Promise.all([
          prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
          prisma.memorySearchEntry.findMany({
            orderBy: { id: "asc" },
            where: { indexGenerationId: identity.generationId, userId }
          }),
          prisma.memoryJob.count({
            where: {
              kind: "EMBED_ITEMS",
              pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
              userId
            }
          }),
          prisma.memoryEmbeddingBatchItem.count({
            where: { indexGenerationId: identity.generationId, userId }
          })
        ]);
      expect(caughtUp).toMatchObject({
        activeIndexGenerationId: before.activeIndexGenerationId,
        memoryGeneration: before.memoryGeneration,
        memoryRevision: before.memoryRevision + 1
      });
      expect(pending).toHaveLength(3);
      expect(pending.every(({ embeddingState }) => embeddingState === "PENDING"))
        .toBe(true);
      expect(embeddingJobCount).toBe(1);
      expect(embeddingChildCount).toBe(3);

      const embeddingRepository = createPrismaMemoryItemEmbeddingRepository(prisma);
      const vector = Array.from(
        { length: EMBEDDING_DIMENSION },
        (_, index) => index === 0 ? 1 : 0
      );
      for (const entry of pending) {
        const target = await embeddingRepository.loadTarget(userId, entry.id);
        if (!target) throw new Error("embedding_target_missing");
        await expect(withLockedMemoryTransaction(
          prisma,
          userId,
          (tx, settings) => embeddingRepository.applyReady(
            tx,
            settings,
            target,
            provider!.pin,
            vector,
            new Date()
          )
        )).resolves.toBe("APPLIED");
      }
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        activeIndexGenerationId: caughtUp.activeIndexGenerationId,
        memoryGeneration: caughtUp.memoryGeneration,
        memoryRevision: caughtUp.memoryRevision
      });

      await processRebuildJob(admitted.jobId, repository);
      const [after, target, source, entries] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryIndexGeneration.findUniqueOrThrow({
          where: { id: identity.generationId }
        }),
        prisma.memoryIndexGeneration.findUniqueOrThrow({
          where: { id: before.activeIndexGenerationId! }
        }),
        prisma.memorySearchEntry.findMany({
          where: { indexGenerationId: identity.generationId, userId }
        })
      ]);
      expect(after).toMatchObject({
        activeIndexGenerationId: identity.generationId,
        memoryGeneration: caughtUp.memoryGeneration + 1,
        memoryRevision: caughtUp.memoryRevision + 1
      });
      expect(target).toMatchObject({ indexMode: "HYBRID", state: "ACTIVE" });
      expect(source.state).toBe("SUPERSEDED");
      expect(entries).toHaveLength(3);
      expect(entries.every(({ embeddingState }) => embeddingState === "READY"))
        .toBe(true);
      await expect(prisma.memorySearchEntry.count({
        where: { indexGenerationId: source.id, userId }
      })).resolves.toBe(3);
      await expect(repository.status(userId, admitted.jobId)).resolves.toMatchObject({
        completedUnits: 3,
        state: "SUCCEEDED",
        totalUnits: 3
      });
      await expect(repository.inventory(userId)).resolves.toMatchObject({
        activeGenerationId: identity.generationId,
        activeIndexMode: "HYBRID",
        eligibleItems: 3,
        ready: true
      });
    } finally {
      await cleanupOwner(userId);
      await provider?.cleanup();
    }
  });

  it("retires an obsolete embedding shadow and admits the newly selected target", async () => {
    const userId = await createOwner("embedding-target-switch");
    const { explicit } = services();
    const rebuildRepository = createPrismaMemoryRebuildRepository(prisma);
    const settingsRepository = createPrismaMemorySettingsRepository(prisma);
    let firstProvider: Awaited<ReturnType<typeof configureEmbeddingProvider>> | null = null;
    let secondProvider: Awaited<ReturnType<typeof configureEmbeddingProvider>> | null = null;
    try {
      await saveExplicit(
        explicit,
        userId,
        "Keep deployment summaries concise.",
        "embedding-target-switch"
      );
      firstProvider = await configureEmbeddingProvider(
        userId,
        "embedding-target-switch-first"
      );
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await rebuildRepository.admit(userId, {
        embeddingDeploymentId: firstProvider.modelId,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "REEMBED",
        pin: firstProvider.pin,
        requestIdentity: { nonce: "embedding-target-switch-first" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const parent = await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      });
      const identity = parseMemoryRebuildJobFingerprint(parent.idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("shadow_missing");

      await processRebuildJob(admitted.jobId, rebuildRepository);
      await expect(rebuildRepository.status(userId, admitted.jobId)).resolves.toMatchObject({
        state: "CATCHING_UP",
        totalUnits: 1
      });
      await prisma.memoryJob.updateMany({
        data: {
          completedAt: new Date(),
          errorCode: "memory_embedding_target_stale",
          state: "STALE",
          updatedAt: new Date()
        },
        where: { kind: "EMBED_ITEMS", userId }
      });

      secondProvider = await configureEmbeddingProvider(
        userId,
        "embedding-target-switch-second"
      );
      await prisma.userMemorySettings.update({
        data: { embeddingProviderModelId: firstProvider.modelId },
        where: { userId }
      });
      const switching = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const changed = await settingsRepository.patch(userId, {
        embeddingDeploymentId: secondProvider.modelId,
        expectedMemoryRevision: switching.memoryRevision,
        expectedSettingsRevision: switching.settingsRevision
      });
      expect(changed).toMatchObject({
        embeddingProviderModelId: secondProvider.modelId,
        memoryRevision: switching.memoryRevision + 1,
        settingsRevision: switching.settingsRevision + 1
      });
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: identity.generationId }
      })).resolves.toMatchObject({ state: "CANCELLED" });
      await expect(prisma.memorySearchEntry.count({
        where: { indexGenerationId: identity.generationId, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      })).resolves.toMatchObject({
        errorCode: "memory_embedding_target_changed",
        state: "CANCELLED"
      });
      await expect(prisma.memoryJob.count({
        where: {
          kind: { in: ["EMBED_ITEMS", "REBUILD_INDEX"] },
          state: {
            in: [
              "CLAIMED",
              "QUEUED",
              "RETRYABLE_FAILED",
              "WAITING_FOR_EGRESS_CONSENT"
            ]
          },
          userId
        }
      })).resolves.toBe(0);

      const replacement = await rebuildRepository.admit(userId, {
        embeddingDeploymentId: secondProvider.modelId,
        expectedMemoryRevision: changed.memoryRevision,
        expectedSettingsRevision: changed.settingsRevision,
        operation: "REEMBED",
        pin: secondProvider.pin,
        requestIdentity: { nonce: "embedding-target-switch-second" }
      });
      if (replacement.kind !== "ok") throw new Error(replacement.kind);
      await expect(rebuildRepository.cancel(userId, replacement.jobId)).resolves.toMatchObject({
        state: "CANCELLED"
      });
    } finally {
      await cleanupOwner(userId);
      await secondProvider?.cleanup();
      await firstProvider?.cleanup();
    }
  });

  it("rejects shadow history embedding after a source suppression race", async () => {
    const userId = await createOwner("hybrid-suppression");
    const deps = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    let provider: Awaited<ReturnType<typeof configureEmbeddingProvider>> | null = null;
    try {
      await saveExplicit(
        deps.explicit,
        userId,
        "I prefer concise release summaries.",
        "hybrid-suppression-fact"
      );
      const initial = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      if (!initial.activeIndexGenerationId) throw new Error("active_generation_missing");
      const history = await createHistoryDerivative({
        activeIndexGenerationId: initial.activeIndexGenerationId,
        createdAt: new Date("2026-08-10T08:45:00.000Z"),
        label: "hybrid-suppression",
        sourceRevision: 1,
        userId
      });
      provider = await configureEmbeddingProvider(userId, "hybrid-suppression");
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await repository.admit(userId, {
        embeddingDeploymentId: provider.modelId,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "REEMBED",
        pin: provider.pin,
        requestIdentity: { nonce: "hybrid-suppression" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      await processRebuildJob(admitted.jobId, repository);
      const chunkEntry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: {
          embeddingState: "PENDING",
          recallChunkId: history.chunkId,
          userId
        }
      });
      const embeddingRepository = createPrismaMemoryItemEmbeddingRepository(prisma);
      const chunkTarget = await embeddingRepository.loadTarget(userId, chunkEntry.id);
      if (!chunkTarget) throw new Error("embedding_target_missing");
      await prisma.memorySuppression.create({
        data: {
          deletionGeneration: before.memoryGeneration,
          explicitOverrideAllowed: true,
          fingerprintKeyVersion: "rebuild-v1",
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          scope: "SOURCE_MESSAGE",
          sourceBranchGeneration: 0,
          sourceChatId: history.chatId,
          sourceMessageId: history.userMessageId,
          userId
        }
      });
      await expect(embeddingRepository.loadTarget(userId, chunkEntry.id))
        .resolves.toBeNull();
      const vector = Array.from(
        { length: EMBEDDING_DIMENSION },
        (_, index) => index === 0 ? 1 : 0
      );
      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => embeddingRepository.applyReady(
          tx,
          settings,
          chunkTarget,
          provider!.pin,
          vector,
          new Date()
        )
      )).resolves.toBe("STALE");
      await expect(repository.cancel(userId, admitted.jobId)).resolves.toMatchObject({
        state: "CANCELLED"
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        activeIndexGenerationId: before.activeIndexGenerationId,
        memoryGeneration: before.memoryGeneration,
        memoryRevision: before.memoryRevision
      });
    } finally {
      await cleanupOwner(userId);
      await provider?.cleanup();
    }
  });

  it("keeps mandatory-vector shadows invisible on failure and cancel", async () => {
    const userId = await createOwner("hybrid-failure");
    const { explicit } = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    let provider: Awaited<ReturnType<typeof configureEmbeddingProvider>> | null = null;
    try {
      await saveExplicit(
        explicit,
        userId,
        "Use metric units in technical answers.",
        "hybrid-save"
      );
      provider = await configureEmbeddingProvider(userId, "hybrid-failure");
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await repository.admit(userId, {
        embeddingDeploymentId: provider.modelId,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "REEMBED",
        pin: provider.pin,
        requestIdentity: { nonce: "hybrid-failure" }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const job = await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      });
      const identity = parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("shadow_missing");

      await processRebuildJob(admitted.jobId, repository);
      const [waitingSettings, waitingGeneration, pendingEntries, settledParent] =
        await Promise.all([
          prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
          prisma.memoryIndexGeneration.findUniqueOrThrow({
            where: { id: identity.generationId }
          }),
          prisma.memorySearchEntry.findMany({
            where: { indexGenerationId: identity.generationId, userId }
          }),
          prisma.memoryJob.findUniqueOrThrow({ where: { id: admitted.jobId } })
        ]);
      expect(waitingSettings).toMatchObject({
        activeIndexGenerationId: before.activeIndexGenerationId,
        memoryGeneration: before.memoryGeneration,
        memoryRevision: before.memoryRevision
      });
      expect(waitingGeneration.state).toBe("CATCHING_UP");
      expect(settledParent.state).toBe("SUCCEEDED");
      expect(pendingEntries).toHaveLength(1);
      expect(pendingEntries[0]!.embeddingState).toBe("PENDING");

      const embeddingRepository = createPrismaMemoryItemEmbeddingRepository(prisma);
      const target = await embeddingRepository.loadTarget(
        userId,
        pendingEntries[0]!.id
      );
      if (!target) throw new Error("embedding_target_missing");
      await expect(embeddingRepository.applyFailed(target, new Date()))
        .resolves.toBe("APPLIED");
      await expect(repository.status(userId, admitted.jobId)).resolves.toMatchObject({
        errorCode: "memory_action_failed",
        state: "FAILED"
      });
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: identity.generationId }
      })).resolves.toMatchObject({ state: "FAILED" });
      await expect(prisma.memorySearchEntry.count({
        where: { indexGenerationId: identity.generationId, userId }
      })).resolves.toBe(0);

      const current = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const cancellable = await repository.admit(userId, {
        embeddingDeploymentId: provider.modelId,
        expectedMemoryRevision: current.memoryRevision,
        expectedSettingsRevision: current.settingsRevision,
        operation: "REEMBED",
        pin: provider.pin,
        requestIdentity: { nonce: "hybrid-cancel" }
      });
      if (cancellable.kind !== "ok") throw new Error(cancellable.kind);
      await processRebuildJob(cancellable.jobId, repository);
      await expect(repository.status(userId, cancellable.jobId)).resolves.toMatchObject({
        state: "CATCHING_UP"
      });
      await expect(repository.cancel(userId, cancellable.jobId)).resolves.toMatchObject({
        state: "CANCELLED"
      });
      const finalSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(finalSettings).toMatchObject({
        activeIndexGenerationId: before.activeIndexGenerationId,
        memoryGeneration: before.memoryGeneration,
        memoryRevision: before.memoryRevision
      });
    } finally {
      await cleanupOwner(userId);
      await provider?.cleanup();
    }
  });

  it("physically purges an excluded source while retaining its accepted execution evidence", async () => {
    const userId = await createOwner("source-purge");
    const deps = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    try {
      const fact = await saveExplicit(
        deps.explicit,
        userId,
        "I prefer concise release summaries.",
        "source-purge-fact"
      );
      const initial = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      if (!initial.activeIndexGenerationId) throw new Error("active_generation_missing");
      const history = await createHistoryDerivative({
        activeIndexGenerationId: initial.activeIndexGenerationId,
        createdAt: new Date("2026-08-10T09:15:00.000Z"),
        label: "source-purge",
        sourceRevision: 1,
        userId
      });
      const receiptDerivatives = await createHistoryReceiptDerivatives({
        activeIndexGenerationId: initial.activeIndexGenerationId,
        assistantMessageId: history.assistantMessageId,
        chatId: history.chatId,
        chunkId: history.chunkId,
        sourceMessageId: history.userMessageId,
        userId
      });
      await prisma.$transaction(async (tx) => {
        const chat = await lockMemorySourceChat(tx, {
          chatId: history.chatId,
          lock: "UPDATE",
          userId
        });
        if (!chat) throw new Error("source_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat,
          hooks: { onRetainedSourceMutated: applyMemoryHistorySourceMutation },
          mutations: ["SOURCE_EXCLUDE"],
          patch: { memoryMode: "EXCLUDED" }
        });
      });
      await expect(prisma.memorySearchEntry.count({
        where: {
          recallChunkId: history.chunkId,
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.findUniqueOrThrow({
        where: { id: history.chunkId }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      const deletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "SOURCE_PURGE", targetId: history.chatId, userId }
      });
      const chunkFeedbackId = await createFeedbackFixture({
        comment: "Purge this excluded-source chunk feedback.",
        sourceBranchGeneration: 0,
        sourceChatId: history.chatId,
        target: { chunkId: history.chunkId, kind: "RECALL_CHUNK" },
        userId
      });
      const factSourceFeedbackId = await createFeedbackFixture({
        comment: "Scrub this invalid source join without deleting the explicit fact.",
        sourceBranchGeneration: 0,
        sourceChatId: history.chatId,
        target: {
          factId: fact.memory.id,
          kind: "FACT_VERSION",
          versionId: fact.memory.currentVersionId!
        },
        userId
      });
      const retainedFeedbackChat = await prisma.chat.create({
        data: { title: "Retained feedback action", userId }
      });
      const factSourceRetractionId = await createFeedbackFixture({
        comment: null,
        feedbackType: "RETRACT",
        retractsFeedbackId: factSourceFeedbackId,
        sourceBranchGeneration: 0,
        sourceChatId: retainedFeedbackChat.id,
        target: {
          factId: fact.memory.id,
          kind: "FACT_VERSION",
          versionId: fact.memory.currentVersionId!
        },
        userId
      });

      for (let replay = 0; replay < 2; replay += 1) {
        if (replay > 0) {
          await prisma.memoryDeletionOutbox.update({
            data: {
              completedAt: null,
              errorCode: null,
              lastAuditAt: null,
              state: "PENDING"
            },
            where: { id: deletion.id }
          });
        }
        const now = new Date(Date.now() + replay * 1_000);
        const claim = await claimDeletion(userId, deletion.id, now);
        const execution = await memoryHistorySourceDeletionHandler.execute(claim, {
          now: () => now,
          signal: new AbortController().signal
        });
        await expect(createPrismaMemoryCoordinatorRepository(prisma)
          .commitDeletionSuccess({ apply: execution.apply, claim, now }))
          .resolves.toBe(true);
        await expect(prisma.memoryRecallChunk.count({
          where: { id: history.chunkId, userId }
        })).resolves.toBe(0);
        await expect(prisma.memoryFeedback.findMany({
          where: {
            id: {
              in: [chunkFeedbackId, factSourceFeedbackId, factSourceRetractionId]
            },
            userId
          }
        })).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({
            comment: null,
            contentPurgedAt: expect.any(Date),
            id: chunkFeedbackId,
            memoryEventId: null,
            purgeReason: "source_invalidated",
            recallChunkId: null,
            sourceChatIdSnapshot: null
          }),
          expect.objectContaining({
            comment: null,
            contentPurgedAt: expect.any(Date),
            id: factSourceFeedbackId,
            memoryEventId: null,
            memoryFactId: null,
            memoryFactVersionId: null,
            purgeReason: "source_invalidated",
            sourceChatIdSnapshot: null
          }),
          expect.objectContaining({
            comment: null,
            contentPurgedAt: expect.any(Date),
            id: factSourceRetractionId,
            memoryFactId: null,
            memoryFactVersionId: null,
            purgeReason: "source_invalidated",
            retractsFeedbackId: null,
            sourceChatIdSnapshot: null
          })
        ]));
        await expectHistoryReceiptScrubbedWithAcceptedEvidenceRetained(receiptDerivatives);
      }
      await expect(prisma.message.count({
        where: { chatId: history.chatId }
      })).resolves.toBe(2);

      const beforeRebuild = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rebuilt = await repository.admit(userId, {
        expectedMemoryRevision: beforeRebuild.memoryRevision,
        expectedSettingsRevision: beforeRebuild.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "source-purge-rebuild" }
      });
      if (rebuilt.kind !== "ok") throw new Error(rebuilt.kind);
      await processRebuildJob(rebuilt.jobId, repository);
      const current = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const entries = await prisma.memorySearchEntry.findMany({
        where: { indexGenerationId: current.activeIndexGenerationId!, userId }
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        factVersionId: fact.memory.currentVersionId,
        itemType: "FACT_VERSION"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("replays suppression purge without rebuild resurrection", async () => {
    const userId = await createOwner("suppression-replay");
    const deps = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    const registry = deletionRegistry();
    try {
      const fact = await saveExplicit(
        deps.explicit,
        userId,
        "Preserve this unrelated explicit fact.",
        "suppression-replay-fact"
      );
      const initial = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      if (!initial.activeIndexGenerationId) throw new Error("active_generation_missing");
      const history = await createHistoryDerivative({
        activeIndexGenerationId: initial.activeIndexGenerationId,
        createdAt: new Date("2026-08-10T09:30:00.000Z"),
        label: "suppression-replay",
        sourceRevision: 1,
        userId
      });
      const receiptDerivatives = await createHistoryReceiptDerivatives({
        activeIndexGenerationId: initial.activeIndexGenerationId,
        assistantMessageId: history.assistantMessageId,
        chatId: history.chatId,
        chunkId: history.chunkId,
        sourceMessageId: history.userMessageId,
        userId
      });
      await prisma.memorySuppression.create({
        data: {
          deletionGeneration: initial.memoryGeneration,
          explicitOverrideAllowed: true,
          fingerprintKeyVersion: "rebuild-v1",
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          scope: "SOURCE_MESSAGE",
          sourceBranchGeneration: 0,
          sourceChatId: history.chatId,
          sourceMessageId: history.userMessageId,
          userId
        }
      });
      const deletion = await prisma.memoryDeletionOutbox.create({
        data: {
          memoryGeneration: initial.memoryGeneration,
          operation: "FORGET_PURGE",
          targetId: `historical-fact-${randomUUID()}`,
          targetType: memoryPurgeTargetType("MEMORY_FACT"),
          userId
        }
      });
      const delayedFeedbackId = await createFeedbackFixture({
        comment: "Late feedback attached to the suppressed chunk.",
        sourceBranchGeneration: 0,
        sourceChatId: history.chatId,
        target: { chunkId: history.chunkId, kind: "RECALL_CHUNK" },
        userId
      });

      for (let replay = 0; replay < 2; replay += 1) {
        if (replay > 0) {
          await prisma.memoryDeletionOutbox.update({
            data: {
              completedAt: null,
              errorCode: null,
              lastAuditAt: null,
              state: "PENDING"
            },
            where: { id: deletion.id }
          });
        }
        const now = new Date(Date.now() + replay * 1_000);
        const claim = await claimDeletion(userId, deletion.id, now);
        const execution = await registry.handler().execute(claim, {
          now: () => now,
          signal: new AbortController().signal
        });
        await expect(createPrismaMemoryCoordinatorRepository(prisma)
          .commitDeletionSuccess({ apply: execution.apply, claim, now }))
          .resolves.toBe(true);
        await expect(prisma.memoryRecallChunk.count({
          where: { id: history.chunkId, userId }
        })).resolves.toBe(0);
        await expect(prisma.memorySuppression.count({
          where: {
            scope: "SOURCE_MESSAGE",
            sourceChatId: history.chatId,
            userId
          }
        })).resolves.toBe(1);
        await expect(prisma.memoryFeedback.findUniqueOrThrow({
          where: { id: delayedFeedbackId }
        })).resolves.toMatchObject({
          comment: null,
          contentPurgedAt: expect.any(Date),
          purgeReason: "suppressed_source",
          recallChunkId: null
        });
        await expectHistoryReceiptScrubbedWithAcceptedEvidenceRetained(receiptDerivatives);
      }

      const beforeRebuild = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rebuilt = await repository.admit(userId, {
        expectedMemoryRevision: beforeRebuild.memoryRevision,
        expectedSettingsRevision: beforeRebuild.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "suppression-rebuild" }
      });
      if (rebuilt.kind !== "ok") throw new Error(rebuilt.kind);
      await processRebuildJob(rebuilt.jobId, repository);
      const active = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rebuiltEntries = await prisma.memorySearchEntry.findMany({
        where: { indexGenerationId: active.activeIndexGenerationId!, userId }
      });
      expect(rebuiltEntries).toHaveLength(1);
      expect(rebuiltEntries[0]).toMatchObject({
        factVersionId: fact.memory.currentVersionId,
        itemType: "FACT_VERSION"
      });
      await expect(prisma.message.count({
        where: { chatId: history.chatId }
      })).resolves.toBe(2);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("fences clear immediately and purges only pre-cutoff history on replay", async () => {
    const userId = await createOwner("clear");
    const { explicit, lifecycle } = services();
    try {
      const fact = await saveExplicit(
        explicit,
        userId,
        "Keep semantic facts while clearing history.",
        "clear-fact"
      );
      const initialSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      if (!initialSettings.activeIndexGenerationId) {
        throw new Error("active_generation_missing");
      }
      const old = await createHistoryDerivative({
        activeIndexGenerationId: initialSettings.activeIndexGenerationId,
        createdAt: new Date("2026-08-10T08:00:00.000Z"),
        label: "old",
        sourceRevision: 1,
        userId
      });
      const receiptDerivatives = await createHistoryReceiptDerivatives({
        activeIndexGenerationId: initialSettings.activeIndexGenerationId,
        assistantMessageId: old.assistantMessageId,
        chatId: old.chatId,
        chunkId: old.chunkId,
        sourceMessageId: old.userMessageId,
        userId
      });
      const beforeClear = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedMemoryRevision: beforeClear.memoryRevision,
        expectedSettingsRevision: beforeClear.settingsRevision,
        operation: "CLEAR_HISTORY_INDEX",
        requestNonce: "clear-history"
      });
      const admitted = await lifecycle.deleteExplicit(userId, {
        expectedMemoryRevision: beforeClear.memoryRevision,
        expectedSettingsRevision: beforeClear.settingsRevision,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        operation: "CLEAR_HISTORY_INDEX"
      });
      expect(admitted).toMatchObject({
        memoryGeneration: beforeClear.memoryGeneration + 1,
        memoryRevision: beforeClear.memoryRevision + 1,
        operation: "CLEAR_HISTORY_INDEX",
        state: "PENDING"
      });
      await expect(prisma.memorySearchEntry.count({
        where: {
          recallChunkId: old.chunkId,
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.findUniqueOrThrow({
        where: { id: old.chunkId }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      const barrier = await prisma.memorySourceBarrier.findFirstOrThrow({
        where: { kind: "HISTORY_INDEX", userId }
      });
      const fresh = await createHistoryDerivative({
        activeIndexGenerationId: initialSettings.activeIndexGenerationId,
        chatId: old.chatId,
        createdAt: new Date(barrier.sourceCreatedAtCutoff.getTime() + 1_000),
        label: "fresh",
        parentMessageId: old.assistantMessageId,
        sourceRevision: 2,
        userId
      });
      const postAdmissionAt = new Date(barrier.createdAt.getTime() + 1_000);
      const oldChunkFeedbackId = await createFeedbackFixture({
        comment: "Created after admission but attached to the pre-cutoff chunk.",
        createdAt: postAdmissionAt,
        sourceBranchGeneration: 0,
        sourceChatId: old.chatId,
        target: { chunkId: old.chunkId, kind: "RECALL_CHUNK" },
        userId
      });
      const freshFeedbackId = await createFeedbackFixture({
        comment: "Post-cutoff feedback remains with the post-cutoff chunk.",
        createdAt: postAdmissionAt,
        sourceBranchGeneration: 0,
        sourceChatId: fresh.chatId,
        target: { chunkId: fresh.chunkId, kind: "RECALL_CHUNK" },
        userId
      });

      for (let replay = 0; replay < 2; replay += 1) {
        if (replay > 0) {
          await prisma.memoryDeletionOutbox.update({
            data: {
              completedAt: null,
              errorCode: null,
              lastAuditAt: null,
              state: "PENDING"
            },
            where: { id: admitted.deletionId }
          });
        }
        const now = new Date(Date.now() + replay * 1_000);
        const claim = await claimDeletion(userId, admitted.deletionId, now);
        const execution = await memoryHistoryClearDeletionHandler.execute(claim, {
          now: () => now,
          signal: new AbortController().signal
        });
        await expect(createPrismaMemoryCoordinatorRepository(prisma)
          .commitDeletionSuccess({
            apply: execution.apply,
            claim,
            now
          })).resolves.toBe(true);
        await expect(prisma.memoryRecallChunk.count({
          where: { id: old.chunkId, userId }
        })).resolves.toBe(0);
        await expect(prisma.memoryRecallChunk.count({
          where: { id: fresh.chunkId, state: "ACTIVE", userId }
        })).resolves.toBe(1);
        await expect(prisma.memorySearchEntry.count({
          where: { recallChunkId: fresh.chunkId, userId }
        })).resolves.toBe(1);
        await expect(prisma.memoryFeedback.findUniqueOrThrow({
          where: { id: oldChunkFeedbackId }
        })).resolves.toMatchObject({
          comment: null,
          contentPurgedAt: expect.any(Date),
          id: oldChunkFeedbackId,
          purgeReason: "history_clear",
          recallChunkId: null
        });
        await expect(prisma.memoryFeedback.findUniqueOrThrow({
          where: { id: freshFeedbackId }
        })).resolves.toMatchObject({
          comment: "Post-cutoff feedback remains with the post-cutoff chunk.",
          contentPurgedAt: null,
          recallChunkId: fresh.chunkId
        });
        await expectHistoryReceiptScrubbedWithAcceptedEvidenceRetained(receiptDerivatives);
      }
      await expect(lifecycle.status(userId, admitted.deletionId)).resolves.toMatchObject({
        completedUnits: 5,
        operation: "CLEAR_HISTORY_INDEX",
        state: "SUCCEEDED",
        totalUnits: 5
      });
      await expect(explicit.get(userId, fact.memory.id)).resolves.toMatchObject({
        memory: { factState: "ACTIVE" }
      });
    } finally {
      await cleanupOwner(userId);
    }
  });
});
