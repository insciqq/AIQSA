import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type {
  MemoryDeletionClaim,
  MemoryJobClaim
} from "../coordinator/types";
import { createPrismaMemoryItemEmbeddingRepository } from "../embedding/repository";
import type { MemoryItemEmbeddingPin } from "../embedding/contract";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  memoryVectorSpaceFingerprint,
  resolveCurrentMemoryUtilityPolicy
} from "../execution/policy";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { createExplicitMemoryService } from "../explicit/service";
import {
  memoryHistoryClearDeletionHandler,
  memoryHistorySourceDeletionHandler
} from "../history/purge";
import { applyMemoryHistorySourceMutation } from "../history/sourceLifecycle";
import { createPrismaMemoryLifecycleRepository } from "../lifecycle/repository";
import { createMemoryLifecycleService } from "../lifecycle/service";
import {
  createPrismaMemoryMutationAuthorizationRepository,
  memoryTargetAuthorizationPayloadHash
} from "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS,
  memoryPurgeTargetType
} from "../purge/contract";
import { registerPhase2MemoryDeletionContributors } from "../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
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

function deletionRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerPhase2MemoryDeletionContributors(registry);
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
      contextWindow: 32_768,
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
      configurationFingerprint: target.qualificationFingerprints.configFingerprint,
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
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
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

async function admitRedream(
  userId: string,
  nonce: string,
  input: Readonly<{
    authorizationRepository: ReturnType<typeof services>["authorizationRepository"];
    explicit: ReturnType<typeof services>["explicit"];
    repository: ReturnType<typeof createPrismaMemoryRebuildRepository>;
  }>
) {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId }
  });
  const authorization = await input.explicit.mintAuthorization(userId, {
    action: "BULK_DELETE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    expectedMemoryRevision: settings.memoryRevision,
    expectedSettingsRevision: settings.settingsRevision,
    operation: "REDREAM_EXISTING_CHATS",
    requestNonce: nonce
  });
  const use = {
    action: "BULK_DELETE" as const,
    authorizationId: authorization.mutationAuthorizationId,
    authorizedPayloadHash: memoryTargetAuthorizationPayloadHash({
      action: "BULK_DELETE",
      expectedMemoryRevision: settings.memoryRevision,
      expectedSettingsRevision: settings.settingsRevision,
      operation: "REDREAM_EXISTING_CHATS"
    })
  };
  const resolved = await input.authorizationRepository.resolveForUse(userId, use);
  return input.repository.admit(userId, {
    authorization: { ...use, requestId: resolved.requestId },
    expectedMemoryRevision: settings.memoryRevision,
    expectedSettingsRevision: settings.settingsRevision,
    operation: "REDREAM_EXISTING_CHATS",
    requestIdentity: { nonce }
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
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
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
  includeEpisode: boolean;
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
      lastDreamedMessageId: input.includeEpisode ? assistantMessage.id : null,
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
      lastDreamedMessageId: input.includeEpisode ? assistantMessage.id : null,
      lastErrorCode: null,
      lastIndexedMessageId: assistantMessage.id,
      lastSucceededAt: assistantAt,
      sourceContentHash: sourceHash,
      sourceRevision: input.sourceRevision,
      status: "READY"
    },
    where: { userId_chatId: { chatId: chat.id, userId: input.userId } }
  });

  const chunkId = randomUUID();
  const contentHash = memorySha256(text);
  await prisma.memoryRecallChunk.create({
    data: {
      branchGeneration: 0,
      chatId: chat.id,
      chunkOrdinal: 0,
      chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
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
      sourceProjectionVersion: "memory-clear-fixture-v1",
      sourceRevisionAtCreation: input.sourceRevision,
      userId: input.userId
    }
  });
  await prisma.memoryRecallChunkMessage.create({
    data: {
      chatId: chat.id,
      chunkId,
      endOffset: text.length,
      messageId: userMessage.id,
      ordinal: 0,
      role: "user",
      startOffset: 0,
      userId: input.userId
    }
  });
  await prisma.memorySearchEntry.create({
    data: {
      embeddingState: "NOT_APPLICABLE",
      indexGenerationId: input.activeIndexGenerationId,
      itemType: "RECALL_CHUNK",
      languageCode: "en",
      recallChunkId: chunkId,
      safeContentHash: contentHash,
      safeSearchText: normalizeMemorySearchText(text),
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(text),
      safetyIdentitySnapshot: memorySha256({ safety: "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({ chunkId, sourceHash }),
      suppressionIdentitySnapshot: memorySha256({ suppressions: [] }),
      userId: input.userId
    }
  });

  let episodeId: string | null = null;
  if (input.includeEpisode) {
    const job = await prisma.memoryJob.create({
      data: {
        activeLeafMessageId: assistantMessage.id,
        branchGeneration: 0,
        chatId: chat.id,
        idempotencyFingerprint: `clear-episode:${memorySha256({
          chatId: chat.id,
          sourceRevision: input.sourceRevision
        })}`,
        kind: "EXTRACT_EPISODE",
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        pipelineVersion: "memory-clear-fixture-v1",
        sourceHash,
        sourceRevision: input.sourceRevision,
        userId: input.userId
      }
    });
    const bindingId = randomUUID();
    await prisma.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memorySha256({ output: input.label }),
        completedAt: assistantAt,
        createdAt: input.createdAt,
        destinationFingerprint: memorySha256({ destination: "fixture" }),
        id: bindingId,
        inputHash: memorySha256({ input: input.label }),
        logicalRole: "MEMORY_EPISODE_EXTRACT",
        memoryJobId: job.id,
        ordinal: 0,
        ownerType: "JOB",
        pipelineVersion: "memory-clear-fixture-v1",
        policyVersion: "memory-clear-fixture-v1",
        promptVersion: "memory-clear-fixture-v1",
        providerId: "memory-clear-fixture",
        recoverableUntil: assistantAt,
        relationsDetachedAt: assistantAt,
        schemaVersion: "memory-clear-fixture-v1",
        secretFreeExecutionSnapshot: {},
        state: "SUCCEEDED",
        userId: input.userId
      }
    });
    episodeId = memorySha256({ episode: input.label, sourceHash });
    await prisma.memoryEpisode.create({
      data: {
        branchGeneration: 0,
        chatId: chat.id,
        createdAt: assistantAt,
        createdByExecutionId: bindingId,
        entities: [],
        extractorRole: "MEMORY_EPISODE_EXTRACT",
        id: episodeId,
        keywords: [input.label],
        languageCode: "en",
        normalizedSafeSearchText: normalizeMemorySearchText(text),
        occurredFrom: input.createdAt,
        occurredTo: assistantAt,
        pipelineVersion: "memory-clear-fixture-v1",
        redactionReasonCodes: [],
        redactionState: "NOT_NEEDED",
        safeSummary: text,
        safetyClass: "NORMAL",
        sourceHash,
        sourceProjectionVersion: "memory-clear-fixture-v1",
        sourceRevisionAtCreation: input.sourceRevision,
        userId: input.userId
      }
    });
    await prisma.memoryEpisodeMessage.create({
      data: {
        chatId: chat.id,
        episodeId,
        messageId: userMessage.id,
        ordinal: 0,
        userId: input.userId
      }
    });
    await prisma.memorySearchEntry.create({
      data: {
        embeddingState: "NOT_APPLICABLE",
        episodeId,
        indexGenerationId: input.activeIndexGenerationId,
        itemType: "EPISODE",
        languageCode: "en",
        safeContentHash: memorySha256(text),
        safeSearchText: normalizeMemorySearchText(text),
        safeSearchTextYoNormalized: normalizeMemorySearchTextYo(text),
        safetyIdentitySnapshot: memorySha256({ safety: "NORMAL" }),
        sourceIdentitySnapshot: memorySha256({ episodeId, sourceHash }),
        suppressionIdentitySnapshot: memorySha256({ suppressions: [] }),
        userId: input.userId
      }
    });
  }
  return {
    assistantMessageId: assistantMessage.id,
    chatId: chat.id,
    chunkId,
    episodeId,
    userMessageId: userMessage.id
  };
}

describe("Prisma Memory shadow rebuild and history clear", () => {
  afterAll(async () => {
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
      const [caughtUp, pending, embeddingJobCount] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memorySearchEntry.findMany({
          orderBy: { id: "asc" },
          where: { indexGenerationId: identity.generationId, userId }
        }),
        prisma.memoryJob.count({
          where: {
            idempotencyFingerprint: { startsWith: "memory-item-embed-v1:" },
            kind: "EMBED_ITEMS",
            userId
          }
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
      expect(embeddingJobCount).toBe(3);

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
      })).resolves.toBe(0);
      await expect(repository.status(userId, admitted.jobId)).resolves.toMatchObject({
        completedUnits: 3,
        state: "SUCCEEDED",
        totalUnits: 3
      });
    } finally {
      await cleanupOwner(userId);
      await provider?.cleanup();
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
        includeEpisode: true,
        label: "hybrid-suppression",
        sourceRevision: 1,
        userId
      });
      if (!history.episodeId) throw new Error("episode_fixture_missing");
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
      const [chunkEntry, episodeEntry] = await Promise.all([
        prisma.memorySearchEntry.findFirstOrThrow({
          where: {
            embeddingState: "PENDING",
            recallChunkId: history.chunkId,
            userId
          }
        }),
        prisma.memorySearchEntry.findFirstOrThrow({
          where: {
            embeddingState: "PENDING",
            episodeId: history.episodeId,
            userId
          }
        })
      ]);
      const embeddingRepository = createPrismaMemoryItemEmbeddingRepository(prisma);
      const [chunkTarget, episodeTarget] = await Promise.all([
        embeddingRepository.loadTarget(userId, chunkEntry.id),
        embeddingRepository.loadTarget(userId, episodeEntry.id)
      ]);
      if (!chunkTarget || !episodeTarget) throw new Error("embedding_target_missing");
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
      await expect(embeddingRepository.loadTarget(userId, episodeEntry.id))
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

  it("creates salted redream children and cancels them after parent settlement", async () => {
    const userId = await createOwner("redream-cancel");
    const deps = services();
    const repository = createPrismaMemoryRebuildRepository(prisma);
    try {
      await saveExplicit(
        deps.explicit,
        userId,
        "Keep one semantic fact while redreaming history.",
        "redream-cancel-fact"
      );
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      if (!before.activeIndexGenerationId) throw new Error("active_generation_missing");
      const history = await createHistoryDerivative({
        activeIndexGenerationId: before.activeIndexGenerationId,
        createdAt: new Date("2026-08-10T09:00:00.000Z"),
        includeEpisode: true,
        label: "redream-cancel",
        sourceRevision: 1,
        userId
      });
      const admitted = await admitRedream(userId, "redream-cancel", {
        authorizationRepository: deps.authorizationRepository,
        explicit: deps.explicit,
        repository
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const [admittedSettings, consumedAuthorization] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryMutationAuthorization.findFirstOrThrow({
          orderBy: { createdAt: "desc" },
          where: { action: "BULK_DELETE", consumedAt: { not: null }, userId }
        })
      ]);
      await expect(repository.admit(userId, {
        authorization: {
          action: "BULK_DELETE",
          authorizationId: consumedAuthorization.id,
          authorizedPayloadHash: consumedAuthorization.authorizedPayloadHash,
          requestId: consumedAuthorization.requestId
        },
        expectedMemoryRevision: admittedSettings.memoryRevision,
        expectedSettingsRevision: admittedSettings.settingsRevision,
        operation: "REDREAM_EXISTING_CHATS",
        requestIdentity: { nonce: "redream-cancel" }
      })).resolves.toEqual(admitted);
      const parent = await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      });
      const identity = parseMemoryRebuildJobFingerprint(parent.idempotencyFingerprint);
      if (!identity || identity.type !== "REDREAM") throw new Error("redream_missing");

      await processRebuildJob(admitted.jobId, repository);
      const child = await prisma.memoryJob.findFirstOrThrow({
        where: {
          idempotencyFingerprint: {
            startsWith: `memory-episode-redream-v1:${identity.batchId}:`
          },
          kind: "EXTRACT_EPISODE",
          userId
        }
      });
      expect(child).toMatchObject({
        activeLeafMessageId: history.assistantMessageId,
        chatId: history.chatId,
        sourceRevision: 1,
        state: "QUEUED"
      });
      expect(child.idempotencyFingerprint.startsWith("extract-episode:"))
        .toBe(false);
      await expect(repository.status(userId, admitted.jobId)).resolves.toMatchObject({
        completedUnits: 0,
        state: "RUNNING",
        totalUnits: 1
      });
      const whileRedreaming = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(repository.admit(userId, {
        expectedMemoryRevision: whileRedreaming.memoryRevision,
        expectedSettingsRevision: whileRedreaming.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "blocked-by-redream" }
      })).resolves.toEqual({ kind: "in_progress" });
      await expect(repository.cancel(userId, admitted.jobId)).resolves.toMatchObject({
        state: "CANCELLED"
      });
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: child.id }
      })).resolves.toMatchObject({ state: "CANCELLED" });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        activeIndexGenerationId: before.activeIndexGenerationId,
        memoryGeneration: before.memoryGeneration,
        memoryRevision: before.memoryRevision
      });
    } finally {
      await cleanupOwner(userId);
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
        includeEpisode: true,
        label: "source-purge",
        sourceRevision: 1,
        userId
      });
      if (!history.episodeId) throw new Error("episode_fixture_missing");
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
          OR: [{ recallChunkId: history.chunkId }, { episodeId: history.episodeId }],
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.findUniqueOrThrow({
        where: { id: history.chunkId }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      await expect(prisma.memoryEpisode.findUniqueOrThrow({
        where: { id: history.episodeId }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      const deletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "SOURCE_PURGE", targetId: history.chatId, userId }
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
        await expect(prisma.memoryEpisode.count({
          where: { id: history.episodeId, userId }
        })).resolves.toBe(0);
      }
      await expect(prisma.memoryExecutionBinding.findFirstOrThrow({
        where: { logicalRole: "MEMORY_EPISODE_EXTRACT", userId }
      })).resolves.toMatchObject({
        acceptedOutputHash: expect.any(String),
        state: "SUCCEEDED"
      });
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

  it("replays old suppression purge leaves without rebuild or redream resurrection", async () => {
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
        includeEpisode: true,
        label: "suppression-replay",
        sourceRevision: 1,
        userId
      });
      if (!history.episodeId) throw new Error("episode_fixture_missing");
      await prisma.memorySuppression.create({
        data: {
          deletionGeneration: initial.memoryGeneration,
          explicitOverrideAllowed: true,
          fingerprintKeyVersion: "rebuild-v1",
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          scope: "SOURCE_EPISODE",
          sourceBranchGeneration: 0,
          sourceChatId: history.chatId,
          sourceEpisodeId: history.episodeId,
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
        await expect(prisma.memoryEpisode.count({
          where: { id: history.episodeId, userId }
        })).resolves.toBe(0);
        await expect(prisma.memoryRecallChunk.count({
          where: { id: history.chunkId, userId }
        })).resolves.toBe(0);
        await expect(prisma.memorySuppression.count({
          where: { scope: "SOURCE_EPISODE", userId }
        })).resolves.toBe(0);
        await expect(prisma.memorySuppression.count({
          where: {
            scope: "SOURCE_MESSAGE",
            sourceChatId: history.chatId,
            userId
          }
        })).resolves.toBe(1);
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

      const redream = await admitRedream(userId, "suppression-redream", {
        authorizationRepository: deps.authorizationRepository,
        explicit: deps.explicit,
        repository
      });
      if (redream.kind !== "ok") throw new Error(redream.kind);
      await processRebuildJob(redream.jobId, repository);
      await expect(repository.status(userId, redream.jobId)).resolves.toMatchObject({
        completedUnits: 0,
        state: "SUCCEEDED",
        totalUnits: 0
      });
      await expect(prisma.memoryJob.count({
        where: {
          idempotencyFingerprint: { startsWith: "memory-episode-redream-v1:" },
          kind: "EXTRACT_EPISODE",
          userId
        }
      })).resolves.toBe(0);
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
        includeEpisode: true,
        label: "old",
        sourceRevision: 1,
        userId
      });
      if (!old.episodeId) throw new Error("episode_fixture_missing");
      const oldEpisodeId = old.episodeId;
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
          OR: [{ recallChunkId: old.chunkId }, { episodeId: oldEpisodeId }],
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.findUniqueOrThrow({
        where: { id: old.chunkId }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      await expect(prisma.memoryEpisode.findUniqueOrThrow({
        where: { id: oldEpisodeId }
      })).resolves.toMatchObject({ state: "INVALIDATED" });

      const barrier = await prisma.memorySourceBarrier.findFirstOrThrow({
        where: { kind: "HISTORY_INDEX", userId }
      });
      const fresh = await createHistoryDerivative({
        activeIndexGenerationId: initialSettings.activeIndexGenerationId,
        chatId: old.chatId,
        createdAt: new Date(barrier.sourceCreatedAtCutoff.getTime() + 1_000),
        includeEpisode: false,
        label: "fresh",
        parentMessageId: old.assistantMessageId,
        sourceRevision: 2,
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
        await expect(prisma.memoryEpisode.count({
          where: { id: oldEpisodeId, userId }
        })).resolves.toBe(0);
        await expect(prisma.memoryRecallChunk.count({
          where: { id: fresh.chunkId, state: "ACTIVE", userId }
        })).resolves.toBe(1);
        await expect(prisma.memorySearchEntry.count({
          where: { recallChunkId: fresh.chunkId, userId }
        })).resolves.toBe(1);
      }
      await expect(lifecycle.status(userId, admitted.deletionId)).resolves.toMatchObject({
        completedUnits: 3,
        operation: "CLEAR_HISTORY_INDEX",
        state: "SUCCEEDED",
        totalUnits: 3
      });
      await expect(explicit.get(userId, fact.memory.id)).resolves.toMatchObject({
        memory: { factState: "ACTIVE" }
      });
    } finally {
      await cleanupOwner(userId);
    }
  });
});
