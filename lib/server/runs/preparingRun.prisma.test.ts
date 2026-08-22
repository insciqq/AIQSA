import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
} from "../../contracts/memory";
import {
  calculateContextBudgetLimits,
  estimateApproxTokens
} from "../../domain/contextBudget";
import { textMessageContent } from "../../domain/content";
import { planMemoryRetrieval } from "../../domain/memory/retrieval";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import {
  MEMORY_ACTION_NO_COMMIT_RESULT,
  memoryActionAnswerContract
} from "../providers/memoryActionAnswer";
import type { NormalizedRunRequest } from "../providers/types";
import { MemorySuppressionKeyring } from "../memory/suppressionKeyring";
import { createPrismaMemoryFactRepository } from "../memory/persistence/facts";
import { createPrismaMemoryMutationAuthorizationRepository } from "../memory/persistence/authorizations";
import { createPrismaMemoryScopeRepository } from "../memory/persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../memory/persistence/settings";
import {
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../memory/persistence/lexical";
import { createPrismaExplicitMemoryRepository } from "../memory/explicit/repository";
import { createExplicitMemoryService } from "../memory/explicit/service";
import { createMemoryClientRefService } from "../memory/actions/clientRef";
import { MEMORY_CONTROL_VERSIONS } from "../memory/actions/controlRuntime";
import { createPrismaMemoryLifecycleRepository } from "../memory/lifecycle/repository";
import { createMemoryLifecycleService } from "../memory/lifecycle/service";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "../memory/purge/contract";
import { registerMemoryDeletionContributors } from "../memory/purge/leaves";
import { MemoryDeletionContributorRegistry } from "../memory/purge/registry";
import { createPrismaMemoryExecutionService } from "../memory/execution";
import type { MemoryExecutionAuthorityDependencies } from "../memory/execution";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  resolveCurrentMemoryUtilityPolicy
} from "../memory/execution/policy";
import { MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION } from "../memory/retrieval/runUtilities";
import { createPrismaLocalMemoryRetrievalRepository } from "../memory/retrieval/localRepository";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT } from "../memory/retrieval/vector";
import {
  createMemorySourceActionService,
  createPrismaMemoryRecallSourceMutationRepository
} from "../memory/sources/actionService";
import { loadMemoryRunSources } from "../memory/sources/runProjection";
import { applyMemoryScopeTargetDeletion } from "../memory/scopeLifecycle";
import { createPrismaRunRepository } from "./prismaRepository";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import {
  MemoryPreparingRunConflictError,
  dormantMemoryAttemptResult
} from "./preparingRun";

const suppressionKeyring = MemorySuppressionKeyring.parse(
  `current=preparing-test-v1,preparing-test-v1=${Buffer.from(
    Array.from({ length: 32 }, (_, index) => index + 17)
  ).toString("base64")}`
);

function preparingForgetRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return registry;
}

const queryEmbeddingVersions = Object.freeze({
  pipelineVersion: MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION,
  policyVersion: "memory-query-embedding-policy-v1",
  promptVersion: "memory-query-embedding-prompt-v1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  schemaVersion: "memory-query-embedding-result-v1"
});

const preparingEmbeddingConfiguration = Object.freeze({
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
    nativeDimension: 1_024,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_024
  },
  modelClass: "embedding",
  upstreamModelId: "preparing-memory-query-embedding"
} as const);

const preparingSystemConfiguration = Object.freeze({
  adapterKind: "openai_responses_compatible",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: true,
    vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "preparing-memory-system-control"
} as const);

function normalizedRequest(
  chatId: string,
  text = "Remember this preparation boundary."
): NormalizedRunRequest {
  const content = textMessageContent(text);
  return {
    attachmentIds: [],
    chatId,
    content,
    context: {
      messages: [{
        content,
        id: "current-user-message",
        role: "user"
      }],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: false,
      vision: false
    },
    modelId: providerTemplateIds.fakeModel,
    params: {},
    prompt: { developer: null, system: null },
    provider: providerTemplateIds.fakeConnection,
    searchPlan: { mode: "all_selected", options: [] }
  };
}

async function withPreparingUser<T>(
  run: (input: { userId: string }) => Promise<T>
): Promise<T> {
  const suffix = randomUUID();
  const userId = `preparing-run-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "PREPARING run test",
      email: `preparing-run-${suffix}@example.test`,
      id: userId,
      settings: {
        create: {
          defaultControlValues: {},
          defaultProviderModelId: providerTemplateIds.fakeModel,
          defaultSearchStrategyId: "search-disabled"
        }
      },
      status: "active"
    }
  });
  try {
    return await run({ userId });
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.memoryDeletionOutbox.updateMany({
        data: {
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseToken: "preparing-run-test-cleanup",
          nextAttemptAt: null,
          state: "RUNNING"
        },
        where: { operation: "TEMPORARY_DELETE", userId }
      });
      await tx.memoryFeedback.deleteMany({ where: { userId } });
      await tx.memorySuppression.deleteMany({ where: { userId } });
      await tx.memoryRetrievalAttemptItem.deleteMany({
        where: { recallChunkId: { not: null }, userId }
      });
      await tx.memoryRecallChunk.deleteMany({ where: { userId } });
      await tx.usageEvent.deleteMany({ where: { userId } });
      await tx.memoryScope.updateMany({
        data: {
          assistantId: null,
          chatId: null,
          folderId: null,
          orphanedAt: new Date(),
          state: "ORPHANED"
        },
        where: {
          scopeType: { in: ["ASSISTANT", "CHAT", "FOLDER"] },
          userId
        }
      });
      await tx.memoryOperationReceipt.deleteMany({ where: { userId } });
      await tx.memoryMutationAuthorization.deleteMany({ where: { userId } });
      await tx.chat.deleteMany({ where: { userId } });
      await tx.assistantDefinition.updateMany({
        data: { currentRevisionId: null },
        where: { ownerUserId: userId }
      });
      await tx.assistantRevision.deleteMany({
        where: { assistant: { ownerUserId: userId } }
      });
      await tx.assistantDefinition.deleteMany({ where: { ownerUserId: userId } });
      await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await tx.user.deleteMany({ where: { id: userId } });
    });
  }
}

async function createPreparingEmbeddingAuthority(userId: string): Promise<Readonly<{
  authority: MemoryExecutionAuthorityDependencies;
  cleanup(): Promise<void>;
}>> {
  const suffix = randomUUID();
  const connectionId = `preparing-memory-connection-${suffix}`;
  const credentialId = `preparing-memory-credential-${suffix}`;
  const credentialVersionId = `preparing-memory-credential-version-${suffix}`;
  const modelId = `preparing-memory-model-${suffix}`;
  const systemModelId = `preparing-memory-system-model-${suffix}`;
  const now = new Date("2026-08-10T12:00:00.000Z");
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://preparing-memory-provider.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 30_000
  };
  await prisma.providerConnection.create({
    data: {
      activeConfig: connectionConfiguration,
      activeVersion: 1,
      activatedAt: now,
      displayName: "Preparing Memory provider",
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
      label: "Preparing Memory account",
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
      activeConfig: preparingEmbeddingConfiguration,
      activeVersion: 1,
      activatedAt: now,
      capabilities: preparingEmbeddingConfiguration.capabilities,
      connectionId,
      defaultParams: {},
      displayName: "Preparing Memory query embedding",
      draftConfig: preparingEmbeddingConfiguration,
      draftVersion: 1,
      enabled: true,
      id: modelId,
      modelClass: "embedding",
      modelId: preparingEmbeddingConfiguration.upstreamModelId,
      provider: "openai_compatible"
    }
  });
  await prisma.providerModel.create({
    data: {
      activeConfig: preparingSystemConfiguration,
      activeVersion: 1,
      activatedAt: now,
      capabilities: preparingSystemConfiguration.capabilities,
      connectionId,
      defaultParams: {},
      displayName: "Preparing Memory System Model",
      draftConfig: preparingSystemConfiguration,
      draftVersion: 1,
      enabled: true,
      id: systemModelId,
      modelClass: "answer",
      modelId: preparingSystemConfiguration.upstreamModelId,
      provider: "openai_compatible"
    }
  });
  await prisma.providerModelCredentialCheck.createMany({
    data: [{
      checkedAt: now,
      connectionId,
      connectionVersion: 1,
      credentialId,
      credentialVersionId,
      evidence: { detail: "ok" },
      modelVersion: 1,
      providerModelId: modelId,
      status: "available"
    }, {
      checkedAt: now,
      connectionId,
      connectionVersion: 1,
      credentialId,
      credentialVersionId,
      evidence: {
        detail: "ok",
        structuredOutput: {
          adapterKind: preparingSystemConfiguration.adapterKind,
          probeVersion: 2,
          upstreamModelId: preparingSystemConfiguration.upstreamModelId,
          verified: true
        }
      },
      modelVersion: 1,
      providerModelId: systemModelId,
      status: "available"
    }]
  });
  const originalSystemPolicy = await prisma.systemModelPolicy.findUniqueOrThrow({
    select: {
      providerModelId: true,
      reasoningEffort: true,
      updatedByUserId: true
    },
    where: { id: "installation" }
  });
  await prisma.systemModelPolicy.update({
    data: {
      providerModelId: systemModelId,
      reasoningEffort: null,
      updatedByUserId: null,
      version: { increment: 1 }
    },
    where: { id: "installation" }
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
  const target = policy.targets.get("MEMORY_QUERY_EMBED");
  if (!target) throw new Error("preparing_memory_embedding_target_missing");
  await prisma.userMemorySettings.update({
    data: {
      acceptedUtilityEgressAt: now,
      acceptedUtilityEgressFingerprint: policy.fingerprint,
      acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
    },
    where: { userId }
  });
  const authority: MemoryExecutionAuthorityDependencies = {
    egressConsentMode: "PER_USER",
    now: () => new Date(now)
  };
  return {
    authority,
    async cleanup() {
      await prisma.usageEvent.deleteMany({ where: { userId } });
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.systemModelPolicy.update({
        data: {
          providerModelId: originalSystemPolicy.providerModelId,
          reasoningEffort: originalSystemPolicy.reasoningEffort,
          updatedByUserId: originalSystemPolicy.updatedByUserId,
          version: { increment: 1 }
        },
        where: { id: "installation" }
      });
      await prisma.userMemorySettings.updateMany({
        data: { embeddingProviderModelId: null },
        where: { userId }
      });
      await prisma.accessGrant.deleteMany({
        where: { providerModelId: modelId, userId }
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
      await prisma.providerModel.deleteMany({ where: { id: { in: [modelId, systemModelId] } } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
  };
}

async function saveExplicitFact(
  userId: string,
  scopeId: string,
  displayText = "My preferred editor is Vim."
) {
  return createPrismaMemoryFactRepository(
    suppressionKeyring,
    prisma,
    { consumeExplicitAuthorization: async () => undefined }
  ).save(
    userId,
    {
      authorization: {
        action: "SAVE",
        authorizationId: `preparing-fact-authorization-${randomUUID()}`,
        authorizedPayloadHash: "f".repeat(64)
      },
      evidence: {
        kind: "EXPLICIT_ACTION",
        observedAt: new Date("2026-08-10T12:00:00.000Z"),
        safeExcerpt: displayText,
        safeSourceHash: "a".repeat(64),
        safetyClass: "NORMAL",
        sourceProjectionVersion: "preparing-run-test-v1"
      },
      explicitSuppressionOverride: false,
      idempotencyFingerprint: `preparing-fact-${randomUUID()}`,
      requestId: `preparing-fact-request-${randomUUID()}`,
      scopeId,
      value: {
        canonicalKey: `profile.preferred_editor.${randomUUID()}`,
        category: "profile",
        confidence: 1,
        directness: "DIRECT",
        displayText,
        importance: 0.8,
        languageCode: "en",
        modality: "STATE",
        pipelineVersion: "preparing-run-test-v1",
        secretTaintedSourceWindow: false,
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        structuredValue: { value: "Vim" }
      }
    }
  );
}

async function classifyExplicitFact(userId: string, versionId: string) {
  const executionId = randomUUID();
  const completedAt = new Date("2026-08-10T12:00:01.000Z");
  const startedAt = new Date(completedAt.getTime() - 1);
  const classification = {
    safetyClassificationReasonCode: "fixture_normal",
    safetyClassificationState: "CLASSIFIED" as const,
    safetyClassifiedAt: completedAt,
    safetyClassifierExecutionId: executionId,
    safetyClassifierModelId: "preparing-run-fixture-model",
    safetyClassifierPolicyVersion: "memory-statement-safety-policy-v1",
    safetyClassifierProviderId: "preparing-run-fixture"
  };
  await prisma.$transaction(async (tx) => {
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memorySha256({ executionId, output: "NORMAL" }),
        cachedInputTokens: 0,
        completedAt,
        createdAt: startedAt,
        destinationFingerprint: memorySha256({ destination: "preparing-run-fixture" }),
        id: executionId,
        inputHash: memorySha256({ executionId, input: "fixture" }),
        inputTokens: 0,
        logicalRole: "MEMORY_STATEMENT_CLASSIFY",
        mutationAuthorizationId: `preparing-classification-${executionId}`,
        ordinal: 0,
        outputTokens: 0,
        ownerType: "MUTATION_AUTHORIZATION",
        pipelineVersion: "preparing-run-test-v1",
        policyVersion: "memory-statement-safety-policy-v1",
        promptVersion: "preparing-run-test-v1",
        providerId: "preparing-run-fixture",
        reasoningTokens: 0,
        recoverableUntil: completedAt,
        relationsDetachedAt: completedAt,
        schemaVersion: "memory-safety-classification-schema-v1",
        secretFreeExecutionSnapshot: {
          providerExecutionSnapshot: {
            providerFamily: "preparing-run-fixture",
            providerModelId: "preparing-run-fixture-model"
          },
          version: 1
        },
        startedAt,
        state: "SUCCEEDED",
        totalTokens: 0,
        usageCompleteness: "COMPLETE",
        userId
      }
    });
    await tx.usageEvent.create({
      data: {
        cachedInputTokens: 0,
        inputTokens: 0,
        memoryExecutionBindingId: executionId,
        modelId: "preparing-run-fixture-model",
        outputTokens: 0,
        provider: "preparing-run-fixture",
        providerModelId: "preparing-run-fixture-model",
        reasoningTokens: 0,
        totalTokens: 0,
        userId
      }
    });
    await tx.memoryFactVersion.update({
      data: classification,
      where: { id: versionId }
    });
  });
  return classification;
}

async function createPreparingHistoryFixture(userId: string) {
  await prisma.userMemorySettings.update({
    data: { referenceChatHistory: false },
    where: { userId }
  });
  await createPrismaMemorySettingsRepository(prisma).patch(userId, {
    expectedMemoryRevision: 0,
    expectedSettingsRevision: 0,
    referenceChatHistory: true
  });
  const now = new Date("2026-08-10T12:00:00.000Z");
  const currentGeneration = await prisma.memoryIndexGeneration.findFirst({
    orderBy: { generation: "desc" },
    where: { state: "ACTIVE", userId }
  });
  const generation = currentGeneration ?? await prisma.memoryIndexGeneration.create({
    data: {
      activatedAt: now,
      chunkingVersion: "memory-history-chunking-v2",
      generation: ((await prisma.memoryIndexGeneration.aggregate({
        _max: { generation: true },
        where: { userId }
      }))._max.generation ?? -1) + 1,
      indexMode: "LEXICAL_ONLY",
      indexedThroughMemoryRevision: 0,
      languageProfile: "RU_EN_MULTILINGUAL_V1",
      normalizationVersion: "memory-search-normalization-v1",
      readyAt: now,
      retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
      state: "ACTIVE",
      targetMemoryRevision: 0,
      userId
    }
  });
  await prisma.userMemorySettings.update({
    data: { activeIndexGenerationId: generation.id },
    where: { userId }
  });
  const sourceChat = await prisma.chat.create({
    data: {
      archived: true,
      memorySourceRevision: 1,
      title: "Archived deployment history",
      userId
    }
  });
  const sourceMessage = await prisma.message.create({
    data: {
      chatId: sourceChat.id,
      content: textMessageContent(
        "We chose cedar deployment and scheduled the birch release."
      ),
      createdAt: now,
      role: "user",
      status: "complete",
      updatedAt: now
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: sourceMessage.id },
    where: { id: sourceChat.id }
  });
  const sourceHash = memorySha256({
    chatId: sourceChat.id,
    messageId: sourceMessage.id,
    revision: 1
  });
  await prisma.chatMemoryCheckpoint.create({
    data: {
      activeLeafMessageId: sourceMessage.id,
      branchGeneration: 0,
      chatId: sourceChat.id,
      lastIndexedMessageId: sourceMessage.id,
      lastSucceededAt: now,
      sourceContentHash: sourceHash,
      sourceRevision: 1,
      status: "READY",
      userId
    }
  });
  const chunkText = "The previous chat chose cedar deployment.";
  const chunkHash = memorySha256({ sourceHash, text: chunkText });
  const chunk = await prisma.memoryRecallChunk.create({
    data: {
      branchGeneration: 0,
      chatId: sourceChat.id,
      chunkOrdinal: 0,
      chunkingVersion: "memory-history-chunking-v2",
      contentHash: chunkHash,
      languageCode: "en",
      normalizedSafeSearchText: normalizeMemorySearchText(chunkText),
      occurredFrom: now,
      occurredTo: now,
      redactionState: "NOT_NEEDED",
      safeProjectedText: chunkText,
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-history-source-projection-v2",
      sourceRevisionAtCreation: 1,
      userId
    }
  });
  await prisma.memoryRecallChunkMessage.create({
    data: {
      chatId: sourceChat.id,
      chunkId: chunk.id,
      messageId: sourceMessage.id,
      ordinal: 0,
      role: "user",
      userId
    }
  });
  await prisma.memorySearchEntry.createMany({
    data: [{
      embeddingState: "NOT_APPLICABLE",
      indexGenerationId: generation.id,
      itemType: "RECALL_CHUNK",
      languageCode: "en",
      recallChunkId: chunk.id,
      safeContentHash: chunkHash,
      normalizedSearchText: normalizeMemorySearchText(chunkText),
      safetyIdentitySnapshot: memorySha256({ safety: "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({ chunkId: chunk.id, sourceHash }),
      suppressionIdentitySnapshot: memorySha256({ sourceHash }),
      userId
    }]
  });
  return {
    chunkContentHash: chunkHash,
    chunkId: chunk.id,
    chunkText,
    generationId: generation.id,
    sourceChatId: sourceChat.id,
    sourceMessageId: sourceMessage.id
  };
}

describe("PREPARING run orchestration", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admits a nullable-predecessor send and atomically consumes one dormant attempt", async () => {
    await withPreparingUser(async ({ userId }) => {
      await prisma.userMemorySettings.update({
        data: { referenceChatHistory: false, useMemoryFacts: false },
        where: { userId }
      });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "New Chat",
          userId
        }
      });
      const baseRequest = normalizedRequest(chat.id);
      const request: NormalizedRunRequest = {
        ...baseRequest,
        prompt: {
          ...baseRequest.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      const repository = createPrismaRunRepository(prisma);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      });

      const [run, attempt, userMessage, assistantMessage] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({ where: { id: admitted.runId } }),
        prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: admitted.attemptId }
        }),
        prisma.message.findUniqueOrThrow({ where: { id: admitted.userMessageId } }),
        prisma.message.findUniqueOrThrow({ where: { id: admitted.assistantMessageId } })
      ]);
      expect(run).toMatchObject({
        normalizedRequest: null,
        status: "preparing"
      });
      expect(attempt).toMatchObject({
        admissionKind: "NORMAL_SEND",
        attemptOrdinal: 0,
        preSendActiveLeafMessageId: null,
        state: "PENDING",
        utilityEgressMode: "LOCAL_ONLY"
      });
      expect(userMessage.parentMessageId).toBeNull();
      expect(assistantMessage.parentMessageId).toBe(userMessage.id);

      await expect(repository.beginPreparingRunAttempt({
        attemptId: admitted.attemptId,
        now: new Date(),
        runId: admitted.runId,
        userId
      })).resolves.toBe(true);
      await expect(repository.completePreparingRunAttempt({
        attemptId: admitted.attemptId,
        result: dormantMemoryAttemptResult(admitted.settingsSnapshot),
        runId: admitted.runId,
        userId
      })).resolves.toBe(true);
      await prisma.userMemorySettings.update({
        data: { memoryRevision: { increment: 1 } },
        where: { userId }
      });

      const finalization = {
        attemptId: admitted.attemptId,
        normalizedRequest: request,
        providerRequestPreview: { request: "base" },
        runId: admitted.runId,
        userId
      };
      const winners = await Promise.all([
        repository.finalizePreparingRun(finalization),
        repository.finalizePreparingRun(finalization)
      ]);
      expect(winners.sort()).toEqual([false, true]);

      const [finalRun, finalAttempt, binding] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({ where: { id: admitted.runId } }),
        prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: admitted.attemptId }
        }),
        prisma.modelRunMemoryBinding.findUniqueOrThrow({
          where: { modelRunId: admitted.runId }
        })
      ]);
      expect(finalRun).toMatchObject({
        normalizedRequest: request,
        status: "streaming"
      });
      expect(finalAttempt).toMatchObject({
        consumedAt: expect.any(Date),
        state: "CONSUMED"
      });
      expect(binding).toMatchObject({
        contextTokenCount: 0,
        finalizedRevisionSnapshot: 1,
        modelRunId: admitted.runId,
        retrievalAttemptId: admitted.attemptId,
        retrievalRevisionSnapshot: 0
      });
      expect(finalRun.normalizedRequest).toMatchObject({
        prompt: { memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT }
      });
    });
  });

  it("finalizes an action-only SAVE after its own committed revision advance", async () => {
    await withPreparingUser(async ({ userId }) => {
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      await saveExplicitFact(userId, scope.id, "Existing fixture memory.");
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Committed Memory action",
          userId
        }
      });
      const initial = normalizedRequest(chat.id, "Remember that I live in Rostov.");
      const request: NormalizedRunRequest = {
        ...initial,
        prompt: {
          ...initial.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      const committedResult = {
        operation: "SAVE",
        status: "COMMITTED",
        version: 1
      } as const;
      const actionResult = {
        memoryRef: "memory-ref-for-committed-save",
        operation: "SAVE",
        statement: "The user lives in Rostov.",
        status: "COMMITTED"
      } as const;
      const retrieve = vi.fn(async (input: Readonly<{
        expected: Readonly<{ memoryGeneration: number; memoryRevision: number }>;
        modelRunId: string;
        userId: string;
      }>) => {
        const now = new Date();
        const requestId = `committed-save-${randomUUID()}`;
        const authorizedPayloadHash = memorySha256({
          requestId,
          statement: actionResult.statement
        });
        const run = await prisma.modelRun.findUniqueOrThrow({
          select: { chatId: true, userMessageId: true },
          where: { id: input.modelRunId }
        });
        const authorization = await prisma.memoryMutationAuthorization.create({
          data: {
            action: "SAVE",
            authorizedPayloadHash,
            confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
            consumedAt: now,
            createdAt: now,
            exactSourceEnd: "Remember that I live in Rostov.".length,
            exactSourceStart: 0,
            expiresAt: new Date(now.getTime() + 60_000),
            modelRunId: input.modelRunId,
            nonceHash: memorySha256({ nonce: requestId }),
            requestId,
            sourceChatId: run.chatId,
            sourceMessageId: run.userMessageId,
            userId: input.userId
          }
        });
        const saved = await createPrismaMemoryFactRepository(
          suppressionKeyring,
          prisma,
          { consumeExplicitAuthorization: async () => undefined }
        ).save(input.userId, {
          authorization: {
            action: "SAVE",
            authorizationId: authorization.id,
            authorizedPayloadHash
          },
          evidence: {
            kind: "EXPLICIT_ACTION",
            observedAt: now,
            safeExcerpt: actionResult.statement,
            safeSourceHash: memorySha256({ requestId, source: actionResult.statement }),
            safetyClass: "NORMAL",
            sourceProjectionVersion: "preparing-run-test-v1"
          },
          explicitSuppressionOverride: false,
          idempotencyFingerprint: memorySha256({ receipt: requestId }),
          modelRunId: input.modelRunId,
          requestId,
          scopeId: scope.id,
          value: {
            canonicalKey: `profile.location.${randomUUID()}`,
            category: "profile",
            confidence: 1,
            directness: "DIRECT",
            displayText: actionResult.statement,
            importance: 0.8,
            languageCode: "en",
            modality: "STATE",
            pipelineVersion: "preparing-run-test-v1",
            secretTaintedSourceWindow: false,
            sensitivityClass: "NORMAL",
            sourceMode: "EXPLICIT",
            structuredValue: { city: "Rostov" }
          }
        });
        if (!("factId" in saved)) throw new Error("committed_save_fixture_failed");
        const counters = {
          memoryGeneration: saved.memoryGeneration,
          memoryRevision: saved.memoryRevision
        };
        expect(counters).toEqual({
          memoryGeneration: input.expected.memoryGeneration,
          memoryRevision: input.expected.memoryRevision + 1
        });
        return {
          budgetSnapshot: {
            memoryActionAnswerResult: committedResult,
            memoryActionResult: actionResult,
            reason: "memory_not_useful",
            utilityEgressMode: "LOCAL_ONLY" as const
          },
          items: [],
          outcome: "EMPTY" as const,
          preparedContext: null,
          querySnapshot: null
        };
      });
      const repository = createPrismaRunRepository(prisma, {
        memoryRetrieval: { retrieve } as never
      });
      const created = await repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        memoryMaterializer(personalContext, memoryActionAnswerResult) {
          expect(personalContext).toBeNull();
          const finalRequest: NormalizedRunRequest = {
            ...request,
            prompt: {
              ...request.prompt,
              ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
            }
          };
          return {
            contextTruncation: null,
            normalizedRequest: finalRequest,
            providerRequest: { ...finalRequest, attachments: [] },
            providerRequestPreview: {
              memoryActionAnswerResult: memoryActionAnswerResult ?? null
            }
          };
        },
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        },
        userId
      });

      const [attempts, binding, run, counters] = await Promise.all([
        prisma.memoryRetrievalAttempt.findMany({
          orderBy: { attemptOrdinal: "asc" },
          where: { modelRunId: created.runId }
        }),
        prisma.modelRunMemoryBinding.findUniqueOrThrow({
          where: { modelRunId: created.runId }
        }),
        prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } }),
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryRevision: true },
          where: { userId }
        })
      ]);
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attemptOrdinal: 0,
        outcome: "EMPTY",
        state: "CONSUMED"
      });
      expect(binding).toMatchObject({
        finalizedRevisionSnapshot: counters.memoryRevision,
        outcome: "EMPTY",
        retrievalRevisionSnapshot: counters.memoryRevision - 1
      });
      expect(run).toMatchObject({
        normalizedRequest: {
          prompt: { memoryActionAnswerResult: committedResult }
        },
        status: "streaming"
      });
    });
  });

  it("fails a second Memory settings drift safe without failing the ordinary run", async () => {
    await withPreparingUser(async ({ userId }) => {
      const fixture = await createPreparingEmbeddingAuthority(userId);
      try {
        const chat = await prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Repeated Memory settings drift",
            userId
          }
        });
        const initial = normalizedRequest(chat.id, "What do you know about me?");
        const request: NormalizedRunRequest = {
          ...initial,
          prompt: {
            ...initial.prompt,
            memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
          }
        };
        let callCount = 0;
        let executionBindingId: string | null = null;
        const retrieve = vi.fn(async (input: Readonly<{
          attemptId: string;
          controlCache?: {
            settingsDriftFailedSafeAttemptId?: string;
            settingsDriftFailedSafeBudget?: Readonly<Record<string, unknown>>;
          };
          userId: string;
        }>) => {
          callCount += 1;
          if (callCount === 1) {
            await prisma.userMemorySettings.update({
              data: { memoryRevision: { increment: 1 } },
              where: { userId: input.userId }
            });
            if (!input.controlCache) throw new Error("control_cache_missing");
            input.controlCache.settingsDriftFailedSafeAttemptId = input.attemptId;
            input.controlCache.settingsDriftFailedSafeBudget = {
              itemCount: 0,
              memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
              reason: "memory_admission_settings_changed",
              schemaVersion: 2,
              utilityEgressMode: "LOCAL_ONLY"
            };
            throw new MemoryPreparingRunConflictError(
              "memory_admission_settings_changed",
              true
            );
          }

          const execution = createPrismaMemoryExecutionService(
            fixture.authority,
            prisma
          );
          const control = await execution.admission.bind(input.userId, {
            inputHash: "7".repeat(64),
            ordinal: 0,
            owner: {
              retrievalAttemptId: input.attemptId,
              type: "RETRIEVAL_ATTEMPT"
            },
            role: "MEMORY_CONTROL",
            versions: MEMORY_CONTROL_VERSIONS
          });
          executionBindingId = control.id;
          await execution.admission.start(input.userId, control.id);
          await execution.lifecycle.settle(input.userId, control.id, {
            acceptedOutputHash: "8".repeat(64),
            errorCode: null,
            providerResponseId: "repeated-drift-control-response",
            state: "SUCCEEDED",
            usage: {
              cachedInputTokens: 0,
              completeness: "COMPLETE",
              estimatedCostMicros: null,
              inputTokens: 9,
              outputTokens: 4,
              reasoningTokens: 0,
              totalTokens: 13
            }
          });
          await prisma.userMemorySettings.update({
            data: {
              memoryRevision: { increment: 1 },
              referenceChatHistory: true
            },
            where: { userId: input.userId }
          });
          return {
            budgetSnapshot: {
              itemCount: 0,
              memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
              reason: "no_relevant_memory",
              schemaVersion: 2,
              utilityEgressMode: "CONSENTED_EXTERNAL",
              utilityExecutions: [{
                reason: null,
                role: "MEMORY_CONTROL",
                state: "READY"
              }]
            },
            items: [],
            outcome: "EMPTY" as const,
            preparedContext: null,
            querySnapshot: null
          };
        });
        const repository = createPrismaRunRepository(prisma, {
          memoryExecutionAuthority: fixture.authority,
          memoryRetrieval: { retrieve } as never
        });
        const created = await repository.createRun({
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          memoryMaterializer(personalContext, memoryActionAnswerResult) {
            const finalRequest: NormalizedRunRequest = {
              ...request,
              ...(personalContext ? { personalContext } : {}),
              prompt: {
                ...request.prompt,
                ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
              }
            };
            return {
              contextTruncation: null,
              normalizedRequest: finalRequest,
              providerRequest: { ...finalRequest, attachments: [] },
              providerRequestPreview: { request: "materialized" }
            };
          },
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: { request: "base" },
          userId
        });

        const [run, attempts, binding, executionBinding, usageCount] =
          await Promise.all([
            prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } }),
            prisma.memoryRetrievalAttempt.findMany({
              orderBy: { attemptOrdinal: "asc" },
              where: { modelRunId: created.runId }
            }),
            prisma.modelRunMemoryBinding.findUniqueOrThrow({
              where: { modelRunId: created.runId }
            }),
            prisma.memoryExecutionBinding.findUniqueOrThrow({
              where: { id: executionBindingId! }
            }),
            prisma.usageEvent.count({
              where: { memoryExecutionBindingId: executionBindingId! }
            })
          ]);
        const runItems = await prisma.modelRunMemoryItem.findMany({
          where: { bindingId: binding.id }
        });

        expect(retrieve).toHaveBeenCalledTimes(2);
        expect(run).toMatchObject({ normalizedRequest: request, status: "streaming" });
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toMatchObject({
          attemptOrdinal: 0,
          errorCode: "memory_admission_settings_changed",
          state: "STALE"
        });
        expect(attempts[1]).toMatchObject({
          acceptedUtilityEgressFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          attemptOrdinal: 1,
          degradationCode: "memory_admission_settings_changed",
          externalRolesUsed: ["MEMORY_CONTROL"],
          outcome: "FAILED_SAFE",
          state: "CONSUMED",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        });
        expect(attempts[1]?.budgetSnapshot).toMatchObject({
          itemCount: 0,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "memory_admission_settings_changed"
        });
        expect(attempts[1]?.budgetSnapshot).not.toHaveProperty("memoryActionResult");
        expect(binding).toMatchObject({
          contextTokenCount: 0,
          degradationCode: "memory_admission_settings_changed",
          outcome: "FAILED_SAFE",
          retrievalAttemptId: attempts[1]?.id
        });
        expect(runItems).toEqual([]);
        expect(executionBinding).toMatchObject({
          logicalRole: "MEMORY_CONTROL",
          retrievalAttemptId: attempts[1]?.id,
          state: "SUCCEEDED"
        });
        expect(usageCount).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("uses current drift evidence when the retry transaction reaches the deadline", async () => {
    await withPreparingUser(async ({ userId }) => {
      const fixture = await createPreparingEmbeddingAuthority(userId);
      let releaseRunLock!: () => void;
      let blocker: Promise<void> | null = null;
      const release = new Promise<void>((resolve) => {
        releaseRunLock = resolve;
      });
      let releaseTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const chat = await prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Memory drift retry deadline",
            userId
          }
        });
        const initial = normalizedRequest(chat.id, "What did Memory find?");
        const request: NormalizedRunRequest = {
          ...initial,
          prompt: {
            ...initial.prompt,
            memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
          }
        };
        let executionBindingId: string | null = null;
        const retrieve = vi.fn(async (input: Readonly<{
          attemptId: string;
          controlCache?: {
            settingsDriftFailedSafeAttemptId?: string;
            settingsDriftFailedSafeBudget?: Readonly<Record<string, unknown>>;
          };
          modelRunId: string;
          userId: string;
        }>) => {
          const execution = createPrismaMemoryExecutionService(
            fixture.authority,
            prisma
          );
          const control = await execution.admission.bind(input.userId, {
            inputHash: "9".repeat(64),
            ordinal: 0,
            owner: {
              retrievalAttemptId: input.attemptId,
              type: "RETRIEVAL_ATTEMPT"
            },
            role: "MEMORY_CONTROL",
            versions: MEMORY_CONTROL_VERSIONS
          });
          executionBindingId = control.id;
          await execution.admission.start(input.userId, control.id);
          await execution.lifecycle.settle(input.userId, control.id, {
            acceptedOutputHash: "a".repeat(64),
            errorCode: null,
            providerResponseId: "drift-deadline-control-response",
            state: "SUCCEEDED",
            usage: {
              cachedInputTokens: 0,
              completeness: "COMPLETE",
              estimatedCostMicros: null,
              inputTokens: 8,
              outputTokens: 3,
              reasoningTokens: 0,
              totalTokens: 11
            }
          });
          let reportLocked!: () => void;
          const locked = new Promise<void>((resolve) => {
            reportLocked = resolve;
          });
          blocker = prisma.$transaction(async (tx) => {
            await tx.$queryRaw(Prisma.sql`
              SELECT "id"
              FROM "ModelRun"
              WHERE "id" = ${input.modelRunId}
              FOR UPDATE
            `);
            reportLocked();
            await release;
          }, { timeout: 10_000 });
          await locked;
          releaseTimer = setTimeout(releaseRunLock, 2_000);
          if (!input.controlCache) throw new Error("control_cache_missing");
          input.controlCache.settingsDriftFailedSafeAttemptId = input.attemptId;
          input.controlCache.settingsDriftFailedSafeBudget = {
            itemCount: 0,
            memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
            reason: "memory_admission_settings_changed",
            schemaVersion: 2,
            utilityEgressMode: "CONSENTED_EXTERNAL",
            utilityExecutions: [{
              reason: null,
              role: "MEMORY_CONTROL",
              state: "READY"
            }]
          };
          throw new MemoryPreparingRunConflictError(
            "memory_admission_settings_changed",
            true
          );
        });
        const repository = createPrismaRunRepository(prisma, {
          memoryAdmissionDeadlineMs: 3_000,
          memoryExecutionAuthority: fixture.authority,
          memoryRetrieval: { retrieve } as never
        });
        const created = await repository.createRun({
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          memoryMaterializer(personalContext, memoryActionAnswerResult) {
            const finalRequest: NormalizedRunRequest = {
              ...request,
              ...(personalContext ? { personalContext } : {}),
              prompt: {
                ...request.prompt,
                ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
              }
            };
            return {
              contextTruncation: null,
              normalizedRequest: finalRequest,
              providerRequest: { ...finalRequest, attachments: [] },
              providerRequestPreview: { request: "materialized" }
            };
          },
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: { request: "base" },
          userId
        });

        const [run, attempts, binding, executionBinding, usageCount] =
          await Promise.all([
            prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } }),
            prisma.memoryRetrievalAttempt.findMany({
              orderBy: { attemptOrdinal: "asc" },
              where: { modelRunId: created.runId }
            }),
            prisma.modelRunMemoryBinding.findUniqueOrThrow({
              where: { modelRunId: created.runId }
            }),
            prisma.memoryExecutionBinding.findUniqueOrThrow({
              where: { id: executionBindingId! }
            }),
            prisma.usageEvent.count({
              where: { memoryExecutionBindingId: executionBindingId! }
            })
          ]);
        expect(retrieve).toHaveBeenCalledOnce();
        expect(run).toMatchObject({ normalizedRequest: request, status: "streaming" });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          degradationCode: "memory_admission_deadline_exceeded",
          externalRolesUsed: ["MEMORY_CONTROL"],
          outcome: "FAILED_SAFE",
          state: "CONSUMED",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        });
        expect(attempts[0]?.budgetSnapshot).toMatchObject({
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "memory_admission_deadline_exceeded",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        });
        expect(binding).toMatchObject({
          degradationCode: "memory_admission_deadline_exceeded",
          outcome: "FAILED_SAFE",
          retrievalAttemptId: attempts[0]?.id
        });
        expect(executionBinding).toMatchObject({
          logicalRole: "MEMORY_CONTROL",
          retrievalAttemptId: attempts[0]?.id,
          state: "SUCCEEDED"
        });
        expect(usageCount).toBe(1);
      } finally {
        if (releaseTimer) clearTimeout(releaseTimer);
        releaseRunLock();
        if (blocker) await blocker;
        await fixture.cleanup();
      }
    });
  }, 10_000);

  it("settles the preparing run when the settings-drift fallback is rejected", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Rejected Memory drift fallback",
          userId
        }
      });
      const initial = normalizedRequest(chat.id, "Continue without Memory.");
      const request: NormalizedRunRequest = {
        ...initial,
        prompt: {
          ...initial.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      let callCount = 0;
      let runId: string | null = null;
      const retrieve = vi.fn(async (input: Readonly<{
        attemptId: string;
        controlCache?: {
          settingsDriftFailedSafeAttemptId?: string;
          settingsDriftFailedSafeBudget?: Readonly<Record<string, unknown>>;
        };
        modelRunId: string;
      }>) => {
        callCount += 1;
        runId = input.modelRunId;
        if (!input.controlCache) throw new Error("control_cache_missing");
        input.controlCache.settingsDriftFailedSafeAttemptId = input.attemptId;
        input.controlCache.settingsDriftFailedSafeBudget = {
          itemCount: 0,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "memory_admission_settings_changed",
          schemaVersion: 2,
          utilityEgressMode: callCount === 1
            ? "LOCAL_ONLY"
            : "CONSENTED_EXTERNAL"
        };
        throw new MemoryPreparingRunConflictError(
          "memory_admission_settings_changed",
          true
        );
      });
      const repository = createPrismaRunRepository(prisma, {
        memoryRetrieval: { retrieve } as never
      });

      await expect(repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        memoryMaterializer(personalContext, memoryActionAnswerResult) {
          const finalRequest: NormalizedRunRequest = {
            ...request,
            ...(personalContext ? { personalContext } : {}),
            prompt: {
              ...request.prompt,
              ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
            }
          };
          return {
            contextTruncation: null,
            normalizedRequest: finalRequest,
            providerRequest: { ...finalRequest, attachments: [] },
            providerRequestPreview: { request: "materialized" }
          };
        },
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      })).rejects.toMatchObject({ code: "memory_attempt_execution_invalid" });
      expect(runId).not.toBeNull();

      const [run, attempts] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({ where: { id: runId! } }),
        prisma.memoryRetrievalAttempt.findMany({
          orderBy: { attemptOrdinal: "asc" },
          where: { modelRunId: runId! }
        })
      ]);
      expect(retrieve).toHaveBeenCalledTimes(2);
      expect(run).toMatchObject({
        errorPayload: {
          code: "memory_attempt_execution_invalid",
          message: "Memory preparation failed before provider dispatch."
        },
        status: "error"
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        errorCode: "memory_admission_settings_changed",
        state: "STALE"
      });
      expect(attempts[1]).toMatchObject({
        errorCode: "memory_attempt_execution_invalid",
        state: "FAILED"
      });
    });
  });

  it("rejects committed-looking EMPTY revision drift without its applied receipt", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: { title: "Unproved Memory action", userId }
      });
      const initial = normalizedRequest(chat.id, "Remember this unproved action.");
      const request: NormalizedRunRequest = {
        ...initial,
        prompt: {
          ...initial.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      const committedResult = {
        operation: "SAVE",
        status: "COMMITTED",
        version: 1
      } as const;
      const repository = createPrismaRunRepository(prisma);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        },
        userId
      });
      await repository.beginPreparingRunAttempt({
        attemptId: admitted.attemptId,
        now: new Date(),
        runId: admitted.runId,
        userId
      });
      await repository.completePreparingRunAttempt({
        attemptId: admitted.attemptId,
        result: {
          budgetSnapshot: {
            memoryActionAnswerResult: committedResult,
            memoryActionResult: {
              memoryRef: "unproved-memory-ref",
              operation: "SAVE",
              statement: "Unproved memory statement.",
              status: "COMMITTED"
            },
            reason: "memory_not_useful",
            utilityEgressMode: "LOCAL_ONLY"
          },
          items: [],
          outcome: "EMPTY",
          preparedContext: null
        },
        runId: admitted.runId,
        userId
      });
      await prisma.userMemorySettings.update({
        data: { memoryRevision: { increment: 1 } },
        where: { userId }
      });
      const finalRequest: NormalizedRunRequest = {
        ...request,
        prompt: { ...request.prompt, memoryActionAnswerResult: committedResult }
      };

      await expect(repository.finalizePreparingRun({
        attemptId: admitted.attemptId,
        normalizedRequest: finalRequest,
        providerRequestPreview: { memoryActionAnswerResult: committedResult },
        runId: admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_admission_settings_changed",
        retryable: true
      });
      await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
        where: { id: admitted.attemptId }
      })).resolves.toMatchObject({ state: "READY" });
    });
  });

  it("falls back to an ordinary run when initial Memory admission exceeds its deadline", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Memory admission deadline",
          userId
        }
      });
      const initial = normalizedRequest(chat.id, "ordinary deadline answer");
      const request: NormalizedRunRequest = {
        ...initial,
        prompt: {
          ...initial.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      let releaseLock!: () => void;
      let reportLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        reportLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const blocker = prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'LOCK TABLE "UserMemorySettings" IN ACCESS EXCLUSIVE MODE'
        );
        reportLocked();
        await release;
      }, { timeout: 10_000 });
      await locked;
      const releaseTimer = setTimeout(releaseLock, 3_000);
      try {
        const startedAt = Date.now();
        const created = await createPrismaRunRepository(prisma, {
          memoryAdmissionDeadlineMs: 4_000
        }).createRun({
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          memoryMaterializer(personalContext, memoryActionAnswerResult) {
            const finalRequest: NormalizedRunRequest = {
              ...request,
              ...(personalContext ? { personalContext } : {}),
              prompt: {
                ...request.prompt,
                ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
              }
            };
            return {
              contextTruncation: null,
              normalizedRequest: finalRequest,
              providerRequest: { ...finalRequest, attachments: [] },
              providerRequestPreview: { request: "final" }
            };
          },
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: { request: "base" },
          userId
        });
        expect(Date.now() - startedAt).toBeLessThan(4_500);

        const [run, attempt, binding] = await Promise.all([
          prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } }),
          prisma.memoryRetrievalAttempt.findFirstOrThrow({
            where: { modelRunId: created.runId }
          }),
          prisma.modelRunMemoryBinding.findUniqueOrThrow({
            where: { modelRunId: created.runId }
          })
        ]);
        expect(run).toMatchObject({ normalizedRequest: request, status: "streaming" });
        expect(attempt).toMatchObject({
          degradationCode: "memory_admission_deadline_exceeded",
          externalRolesUsed: [],
          outcome: "FAILED_SAFE",
          state: "CONSUMED",
          utilityEgressMode: "LOCAL_ONLY"
        });
        expect(attempt.budgetSnapshot).toMatchObject({
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "memory_admission_deadline_exceeded"
        });
        expect(binding).toMatchObject({
          degradationCode: "memory_admission_deadline_exceeded",
          outcome: "FAILED_SAFE",
          retrievalAttemptId: attempt.id
        });
      } finally {
        clearTimeout(releaseTimer);
        releaseLock();
        await blocker;
      }
    });
  }, 10_000);

  it("abandons a timed-out READY finalization and dispatches the admitted base request", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Memory finalization deadline",
          userId
        }
      });
      const initial = normalizedRequest(chat.id, "ordinary finalization answer");
      const request: NormalizedRunRequest = {
        ...initial,
        prompt: {
          ...initial.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      let releaseLock!: () => void;
      let blocker: Promise<void> | null = null;
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const safetyRelease = setTimeout(releaseLock, 6_000);
      const repository = createPrismaRunRepository(prisma, {
        memoryAdmissionDeadlineMs: 4_000,
        memoryRetrieval: {
          retrieve: vi.fn(async () => {
            let reportLocked!: () => void;
            const locked = new Promise<void>((resolve) => {
              reportLocked = resolve;
            });
            blocker = prisma.$transaction(async (tx) => {
              await tx.$executeRawUnsafe(
                'LOCK TABLE "UserMemorySettings" IN ACCESS EXCLUSIVE MODE'
              );
              reportLocked();
              await release;
            }, { timeout: 10_000 });
            await locked;
            return {
              budgetSnapshot: {
                memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
                utilityEgressMode: "LOCAL_ONLY" as const
              },
              items: [],
              outcome: "EMPTY" as const,
              preparedContext: null,
              querySnapshot: null
            };
          })
        }
      });
      try {
        const startedAt = Date.now();
        const created = await repository.createRun({
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          memoryMaterializer(personalContext, memoryActionAnswerResult) {
            const finalRequest: NormalizedRunRequest = {
              ...request,
              ...(personalContext ? { personalContext } : {}),
              prompt: {
                ...request.prompt,
                ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
              }
            };
            return {
              contextTruncation: null,
              normalizedRequest: finalRequest,
              providerRequest: { ...finalRequest, attachments: [] },
              providerRequestPreview: { request: "final" }
            };
          },
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: { request: "base" },
          userId
        });
        expect(Date.now() - startedAt).toBeLessThan(5_000);

        const [run, attempt, binding] = await Promise.all([
          prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } }),
          prisma.memoryRetrievalAttempt.findFirstOrThrow({
            where: { modelRunId: created.runId }
          }),
          prisma.modelRunMemoryBinding.findUniqueOrThrow({
            where: { modelRunId: created.runId }
          })
        ]);
        expect(run).toMatchObject({ normalizedRequest: request, status: "streaming" });
        expect(attempt).toMatchObject({
          degradationCode: "memory_admission_deadline_exceeded",
          outcome: "FAILED_SAFE",
          state: "CONSUMED"
        });
        expect(attempt.budgetSnapshot).toMatchObject({
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "memory_admission_deadline_exceeded"
        });
        expect(binding).toMatchObject({
          degradationCode: "memory_admission_deadline_exceeded",
          outcome: "FAILED_SAFE"
        });
      } finally {
        clearTimeout(safetyRelease);
        releaseLock();
        if (blocker) await blocker;
      }
    });
  }, 10_000);

  it("falls back to the near-budget no-commit reserve when result materialization declines", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Near-budget Memory bridge",
          userId
        }
      });
      const text = "ordinary-answer-canary";
      const requiredTokens = estimateApproxTokens(memoryActionAnswerContract(
        MEMORY_ACTION_NO_COMMIT_RESULT
      )) + estimateApproxTokens(text) + 2 * estimateApproxTokens([]);
      let contextWindow = 1;
      while (calculateContextBudgetLimits({ contextWindow }).budgetTokens < requiredTokens) {
        contextWindow += 1;
      }
      const initialRequest = normalizedRequest(chat.id, text);
      const reservedRequest: NormalizedRunRequest = {
        ...initialRequest,
        modelCapabilities: {
          ...initialRequest.modelCapabilities,
          contextWindow,
          defaultMaxOutputTokens: 0
        },
        prompt: {
          ...initialRequest.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      const initiallyBudgeted = applyProviderRequestContextBudget({
        request: { ...reservedRequest, attachments: [] }
      });
      expect(initiallyBudgeted.ok).toBe(true);
      if (!initiallyBudgeted.ok || !initiallyBudgeted.request.context) {
        throw new Error("near_budget_base_request_rejected");
      }
      const request: NormalizedRunRequest = {
        ...reservedRequest,
        context: initiallyBudgeted.request.context
      };
      const committedResult = {
        operation: "SAVE",
        status: "COMMITTED",
        version: 1
      } as const;
      const repository = createPrismaRunRepository(prisma, {
        memoryRetrieval: {
          retrieve: vi.fn(async () => ({
            budgetSnapshot: {
              memoryActionAnswerResult: committedResult,
              utilityEgressMode: "LOCAL_ONLY" as const
            },
            items: [],
            outcome: "EMPTY" as const,
            preparedContext: null,
            querySnapshot: null
          }))
        }
      });
      const created = await repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        memoryMaterializer(personalContext, memoryActionAnswerResult) {
          if (memoryActionAnswerResult?.status === "COMMITTED") return null;
          const finalRequest: NormalizedRunRequest = {
            ...request,
            ...(personalContext ? { personalContext } : {}),
            prompt: {
              ...request.prompt,
              ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
            }
          };
          const budgeted = applyProviderRequestContextBudget({
            request: {
              ...finalRequest,
              attachments: []
            }
          });
          if (!budgeted.ok || !budgeted.request.context) return null;
          const normalizedRequest = {
            ...finalRequest,
            context: budgeted.request.context
          };
          return {
            contextTruncation: budgeted.contextTruncation,
            normalizedRequest,
            providerRequest: { ...budgeted.request, ...normalizedRequest },
            providerRequestPreview: {
              memoryActionAnswerResult: normalizedRequest.prompt.memoryActionAnswerResult ?? null
            }
          };
        },
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        },
        userId
      });

      expect(created.materializedRequest?.normalizedRequest.prompt.memoryActionAnswerResult)
        .toEqual(MEMORY_ACTION_NO_COMMIT_RESULT);
      await expect(prisma.modelRun.findUniqueOrThrow({
        select: { normalizedRequest: true, status: true },
        where: { id: created.runId }
      })).resolves.toMatchObject({
        normalizedRequest: {
          prompt: { memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT }
        },
        status: "streaming"
      });
      await expect(prisma.memoryRetrievalAttempt.findFirstOrThrow({
        select: { budgetSnapshot: true, outcome: true, state: true },
        where: { modelRunId: created.runId }
      })).resolves.toMatchObject({
        budgetSnapshot: {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          reason: "final_context_budget_unavailable"
        },
        outcome: "FAILED_SAFE",
        state: "CONSUMED"
      });
    });
  });

  it("keeps Temporary run content out of every Personal Memory receipt and counter", async () => {
    await withPreparingUser(async ({ userId }) => {
      const privateText = "Keep this only in the Temporary chat.";
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Temporary Chat",
          userId
        }
      });
      const settingsBefore = await prisma.userMemorySettings.findUniqueOrThrow({
        select: {
          memoryConsentRevision: true,
          memoryGeneration: true,
          memoryRevision: true,
          settingsRevision: true
        },
        where: { userId }
      });
      const baseRequest = normalizedRequest(chat.id, privateText);
      const request: NormalizedRunRequest = {
        ...baseRequest,
        prompt: {
          ...baseRequest.prompt,
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        }
      };
      const repository = createPrismaRunRepository(prisma);
      const created = await repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        initialChatMode: {
          chatMode: "TEMPORARY",
          temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
        },
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      });

      expect(created.materializedRequest).toBeUndefined();
      await expect(prisma.modelRun.findUniqueOrThrow({
        select: { normalizedRequest: true, status: true },
        where: { id: created.runId }
      })).resolves.toEqual({
        normalizedRequest: request,
        status: "streaming"
      });
      await expect(repository.recoverPreparingRun({
        now: new Date(Date.now() + 60_000),
        runId: created.runId,
        userId
      })).resolves.toBe("not_preparing");
      await expect(repository.getRunControlForUser(created.runId, userId))
        .resolves.toMatchObject({ id: created.runId, status: "streaming" });

      const [
        settingsAfter,
        chatAfter,
        attemptCount,
        attemptItemCount,
        runBinding,
        runItemCount,
        executionCount,
        historyCount,
        egressReceiptCount,
        authorizationCount,
        operationReceiptCount,
        jobCount,
        checkpointCount,
        chunkCount,
        candidateCount,
        eventCount,
        feedbackCount,
        deletionRows
      ] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({
          select: {
            memoryConsentRevision: true,
            memoryGeneration: true,
            memoryRevision: true,
            settingsRevision: true
          },
          where: { userId }
        }),
        prisma.chat.findUniqueOrThrow({
          select: { memoryBranchGeneration: true, memorySourceRevision: true },
          where: { id: chat.id }
        }),
        prisma.memoryRetrievalAttempt.count({ where: { modelRunId: created.runId } }),
        prisma.memoryRetrievalAttemptItem.count({ where: { userId } }),
        prisma.modelRunMemoryBinding.findUnique({ where: { modelRunId: created.runId } }),
        prisma.modelRunMemoryItem.count({ where: { userId } }),
        prisma.memoryExecutionBinding.count({ where: { userId } }),
        prisma.memoryHistoryRun.count({ where: { modelRunId: created.runId } }),
        prisma.memoryToolEgressReceipt.count({ where: { modelRunId: created.runId } }),
        prisma.memoryMutationAuthorization.count({ where: { modelRunId: created.runId } }),
        prisma.memoryOperationReceipt.count({ where: { modelRunId: created.runId } }),
        prisma.memoryJob.count({ where: { chatId: chat.id, userId } }),
        prisma.chatMemoryCheckpoint.count({ where: { chatId: chat.id, userId } }),
        prisma.memoryRecallChunk.count({ where: { chatId: chat.id, userId } }),
        prisma.memoryCandidate.count({ where: { chatId: chat.id, userId } }),
        prisma.memoryEvent.count({ where: { sourceChatId: chat.id, userId } }),
        prisma.memoryFeedback.count({ where: { sourceChatIdSnapshot: chat.id, userId } }),
        prisma.memoryDeletionOutbox.findMany({
          select: {
            admittedActiveLeafMessageId: true,
            admittedChatSourceRevision: true,
            alsoForgetOriginMemories: true,
            errorCode: true,
            memoryGeneration: true,
            operation: true,
            targetId: true,
            targetType: true
          },
          where: { targetId: chat.id, userId }
        })
      ]);

      expect(settingsAfter).toEqual(settingsBefore);
      expect(chatAfter).toEqual({
        memoryBranchGeneration: 0,
        memorySourceRevision: 0
      });
      expect({
        attemptCount,
        attemptItemCount,
        authorizationCount,
        candidateCount,
        checkpointCount,
        chunkCount,
        egressReceiptCount,
        eventCount,
        executionCount,
        feedbackCount,
        historyCount,
        jobCount,
        operationReceiptCount,
        runItemCount
      }).toEqual({
        attemptCount: 0,
        attemptItemCount: 0,
        authorizationCount: 0,
        candidateCount: 0,
        checkpointCount: 0,
        chunkCount: 0,
        egressReceiptCount: 0,
        eventCount: 0,
        executionCount: 0,
        feedbackCount: 0,
        historyCount: 0,
        jobCount: 0,
        operationReceiptCount: 0,
        runItemCount: 0
      });
      expect(runBinding).toBeNull();
      expect(deletionRows).toEqual([{
        admittedActiveLeafMessageId: null,
        admittedChatSourceRevision: null,
        alsoForgetOriginMemories: null,
        errorCode: null,
        memoryGeneration: 0,
        operation: "TEMPORARY_DELETE",
        targetId: chat.id,
        targetType: `TEMPORARY_CHAT@${MEMORY_TEMPORARY_RETENTION_POLICY_VERSION}`
      }]);
      expect(JSON.stringify(deletionRows)).not.toContain(privateText);
    });
  });

  it("keeps a local-only attempt valid across unrelated utility-consent drift", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: { title: "Retry", userId }
      });
      const request = normalizedRequest(chat.id);
      const repository = createPrismaRunRepository(prisma);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {},
        userId
      });
      await repository.beginPreparingRunAttempt({
        attemptId: admitted.attemptId,
        now: new Date(),
        runId: admitted.runId,
        userId
      });
      await repository.completePreparingRunAttempt({
        attemptId: admitted.attemptId,
        result: dormantMemoryAttemptResult(admitted.settingsSnapshot),
        runId: admitted.runId,
        userId
      });
      await prisma.userMemorySettings.update({
        data: { memoryConsentRevision: { increment: 1 } },
        where: { userId }
      });

      await expect(repository.finalizePreparingRun({
        attemptId: admitted.attemptId,
        normalizedRequest: request,
        providerRequestPreview: {},
        runId: admitted.runId,
        userId
      })).resolves.toBe(true);
      await expect(repository.retryPreparingRunAttempt({
        attemptId: admitted.attemptId,
        now: new Date(),
        runId: admitted.runId,
        userId
      })).resolves.toBeNull();

      const attempts = await prisma.memoryRetrievalAttempt.findMany({
        orderBy: { attemptOrdinal: "asc" },
        where: { modelRunId: admitted.runId }
      });
      expect(attempts.map(({ attemptOrdinal, state }) => ({ attemptOrdinal, state })))
        .toEqual([
          { attemptOrdinal: 0, state: "CONSUMED" }
        ]);
    });
  });

  it("admits one compatible retrieval utility execution with durable usage before Phase B", async () => {
    await withPreparingUser(async ({ userId }) => {
      const fixture = await createPreparingEmbeddingAuthority(userId);
      try {
        const chat = await prisma.chat.create({
          data: { title: "Qualified retrieval utility", userId }
        });
        const request = normalizedRequest(chat.id, "What did we discuss before?");
        const repository = createPrismaRunRepository(prisma, {
          memoryExecutionAuthority: fixture.authority
        });
        const admitted = await repository.admitPreparingRun({
          admissionKind: "NORMAL_SEND",
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: {},
          userId
        });
        await expect(repository.beginPreparingRunAttempt({
          attemptId: admitted.attemptId,
          now: new Date(),
          runId: admitted.runId,
          userId
        })).resolves.toBe(true);

        const execution = createPrismaMemoryExecutionService(
          fixture.authority,
          prisma
        );
        const control = await execution.admission.bind(userId, {
          inputHash: "0".repeat(64),
          ordinal: 0,
          owner: {
            retrievalAttemptId: admitted.attemptId,
            type: "RETRIEVAL_ATTEMPT"
          },
          role: "MEMORY_CONTROL",
          versions: MEMORY_CONTROL_VERSIONS
        });
        await expect(execution.admission.start(userId, control.id))
          .resolves.toMatchObject({ bindingId: control.id });
        await expect(execution.lifecycle.settle(userId, control.id, {
          acceptedOutputHash: "0".repeat(64),
          errorCode: null,
          providerResponseId: "preparing-control-response",
          state: "SUCCEEDED",
          usage: {
            cachedInputTokens: 0,
            completeness: "COMPLETE",
            estimatedCostMicros: null,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            totalTokens: 15
          }
        })).resolves.toMatchObject({ state: "SUCCEEDED" });
        const bound = await execution.admission.bind(userId, {
          inputHash: "1".repeat(64),
          ordinal: 1,
          owner: {
            retrievalAttemptId: admitted.attemptId,
            type: "RETRIEVAL_ATTEMPT"
          },
          role: "MEMORY_QUERY_EMBED",
          versions: queryEmbeddingVersions
        });
        await expect(execution.admission.start(userId, bound.id))
          .resolves.toMatchObject({ bindingId: bound.id });
        await expect(execution.lifecycle.settle(userId, bound.id, {
          acceptedOutputHash: null,
          errorCode: "preparing_memory_embedding_unavailable",
          providerResponseId: null,
          state: "FAILED",
          usage: {
            cachedInputTokens: null,
            completeness: "UNAVAILABLE",
            estimatedCostMicros: null,
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null
          }
        })).resolves.toMatchObject({ state: "FAILED" });

        await expect(repository.completePreparingRunAttempt({
          attemptId: admitted.attemptId,
          result: {
            budgetSnapshot: {
              itemCount: 0,
              schemaVersion: 1,
              utilityEgressMode: "CONSENTED_EXTERNAL"
            },
            items: [],
            outcome: "EMPTY",
            preparedContext: null
          },
          runId: admitted.runId,
          userId
        })).resolves.toBe(true);
        await expect(repository.finalizePreparingRun({
          attemptId: admitted.attemptId,
          normalizedRequest: request,
          providerRequestPreview: {},
          runId: admitted.runId,
          userId
        })).resolves.toBe(true);

        const [attempt, executionBindings, usageCount] = await Promise.all([
          prisma.memoryRetrievalAttempt.findUniqueOrThrow({
            where: { id: admitted.attemptId }
          }),
          prisma.memoryExecutionBinding.findMany({
            orderBy: { ordinal: "asc" },
            where: { id: { in: [control.id, bound.id] } }
          }),
          prisma.usageEvent.count({
            where: {
              memoryExecutionBindingId: { in: [control.id, bound.id] },
              userId
            }
          })
        ]);
        expect(attempt).toMatchObject({
          acceptedUtilityEgressFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          externalRolesUsed: ["MEMORY_CONTROL", "MEMORY_QUERY_EMBED"],
          state: "CONSUMED",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        });
        expect(executionBindings).toMatchObject([{
          logicalRole: "MEMORY_CONTROL",
          retrievalAttemptId: admitted.attemptId,
          state: "SUCCEEDED"
        }, {
          logicalRole: "MEMORY_QUERY_EMBED",
          retrievalAttemptId: admitted.attemptId,
          state: "FAILED"
        }]);
        expect(usageCount).toBe(2);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("fails Memory closed without System Model control while the ordinary run finalizes", async () => {
    await withPreparingUser(async ({ userId }) => {
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        useMemoryFacts: true
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const fact = await saveExplicitFact(userId, scope.id, "My preferred editor\nis  Vim.");
      await prisma.memoryFactVersion.update({
        data: { coreEligible: true, coreSalience: "HIGH" },
        where: { id: fact.versionId }
      });
      const chat = await prisma.chat.create({ data: { title: "Explicit recall", userId } });
      const request = normalizedRequest(chat.id, "What is my preferred editor?");
      const repository = createPrismaRunRepository(prisma);
      const created = await repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        memoryMaterializer(personalContext, memoryActionAnswerResult) {
          const finalRequest: NormalizedRunRequest = {
            ...request,
            ...(personalContext ? { personalContext } : {}),
            prompt: {
              ...request.prompt,
              ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
            }
          };
          return {
            contextTruncation: null,
            normalizedRequest: finalRequest,
            providerRequest: {
              ...finalRequest,
              attachments: []
            },
            providerRequestPreview: {
              memoryActionAnswerResult: memoryActionAnswerResult ?? null,
              personalContext: personalContext?.text ?? null
            }
          };
        },
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      });

      const [run, attempt, binding] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } }),
        prisma.memoryRetrievalAttempt.findFirstOrThrow({
          where: { modelRunId: created.runId }
        }),
        prisma.modelRunMemoryBinding.findUniqueOrThrow({
          where: { modelRunId: created.runId }
        })
      ]);
      const items = await prisma.modelRunMemoryItem.findMany({
        where: { bindingId: binding.id }
      });

      expect(created.materializedRequest?.normalizedRequest.prompt).toMatchObject({
        memoryActionAnswerResult: {
          operation: "NONE",
          status: "UNAVAILABLE",
          version: 1
        }
      });
      expect(run).toMatchObject({ status: "streaming" });
      expect(run.normalizedRequest).not.toHaveProperty("personalContext");
      expect(run.normalizedRequest).toMatchObject({
        prompt: {
          memoryActionAnswerResult: {
            operation: "NONE",
            status: "UNAVAILABLE",
            version: 1
          }
        }
      });
      expect(attempt).toMatchObject({
        acceptedUtilityEgressFingerprint: null,
        boundedSafeQuerySnapshot: null,
        externalRolesUsed: [],
        outcome: "FAILED_SAFE",
        state: "CONSUMED",
        utilityEgressMode: "LOCAL_ONLY"
      });
      expect(attempt.budgetSnapshot).toMatchObject({
        reason: "memory_action_intent_unavailable"
      });
      expect(binding).toMatchObject({
        boundedSafeQuerySnapshot: null,
        outcome: "FAILED_SAFE",
        retrievalAttemptId: attempt.id
      });
      expect(items).toEqual([]);

      const chatUpdate = await repository.getChatUpdateForRun({
        assistantMessageId: created.assistantMessageId,
        chatId: chat.id,
        userId,
        userMessageId: created.userMessageId
      });
      expect(chatUpdate?.messages.find(({ id }) => id === created.assistantMessageId)
        ?.artifactSummary).toMatchObject({
        memoryStatus: "UNAVAILABLE"
      });

      const { systemFrom } = await prisma.memoryFactVersion.findUniqueOrThrow({
        select: { systemFrom: true },
        where: { id: fact.versionId }
      });
      const forgottenAt = new Date(Math.max(
        Date.now(),
        systemFrom.getTime() + 1
      ));
      await prisma.$transaction(async (tx) => {
        await tx.memoryFactVersion.update({
          data: { state: "FORGOTTEN", systemTo: forgottenAt },
          where: { id: fact.versionId }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: null, forgottenAt, state: "FORGOTTEN" },
          where: { id: fact.factId }
        });
      });
    });
  });

  it("freezes archived previous-chat chunks and rejects source drift", async () => {
    await withPreparingUser(async ({ userId }) => {
      const history = await createPreparingHistoryFixture(userId);
      const repository = createPrismaRunRepository(prisma);
      const stage = async (title: string) => {
        const chat = await prisma.chat.create({ data: { title, userId } });
        const request = normalizedRequest(
          chat.id,
          "What did we decide about cedar deployment and the birch release?"
        );
        const admitted = await repository.admitPreparingRun({
          admissionKind: "NORMAL_SEND",
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: {},
          userId
        });
        const contextText = `Previous chat: ${history.chunkText}`;
        await repository.completePreparingRunAttempt({
          attemptId: admitted.attemptId,
          result: {
            budgetSnapshot: {
              hardCapTokens: 2_500,
              schemaVersion: 1,
              utilityEgressMode: "LOCAL_ONLY"
            },
            items: [{
              exactItemId: history.chunkId,
              exactSafeText: history.chunkText,
              finalScore: 0.91,
              itemType: "RECALL_CHUNK",
              laneRanks: { HISTORY_RECALL_FTS_ENGLISH: 1 },
              projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
              recallChunkId: history.chunkId,
              selectionReason: "history_recall_fts_english"
            }],
            outcome: "USED",
            preparedContext: { approxTokens: 24, text: contextText },
            querySnapshot: "cedar deployment birch release"
          },
          runId: admitted.runId,
          userId
        });
        const settings = await prisma.userMemorySettings.findUniqueOrThrow({
          where: { userId }
        });
        return {
          admitted,
          finalRequest: {
            ...request,
            personalContext: {
              approxTokens: 24,
              itemCount: 1,
              memoryGeneration: settings.memoryGeneration,
              memoryRevision: settings.memoryRevision,
              mode: "prefetched" as const,
              text: contextText
            }
          }
        };
      };

      const accepted = await stage("Accepted archived history");
      await expect(repository.finalizePreparingRun({
        attemptId: accepted.admitted.attemptId,
        normalizedRequest: accepted.finalRequest,
        providerRequestPreview: {},
        runId: accepted.admitted.runId,
        userId
      })).resolves.toBe(true);
      const stale = await stage("Stale archived history");
      const invalidatedAt = new Date("2026-08-10T13:00:00.000Z");
      await prisma.memoryRecallChunk.update({
        data: { invalidatedAt, state: "INVALIDATED" },
        where: { id: history.chunkId }
      });
      await expect(repository.finalizePreparingRun({
        attemptId: stale.admitted.attemptId,
        normalizedRequest: stale.finalRequest,
        providerRequestPreview: {},
        runId: stale.admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_item_stale",
        retryable: true
      });

    });
  });

  it.each(["FACT_VERSION", "RECALL_CHUNK"] as const)(
    "rejects a READY %s item when same-chat Not relevant commits before final binding",
    async (itemType) => {
      await withPreparingUser(async ({ userId }) => {
        const selected = itemType === "FACT_VERSION"
          ? await (async () => {
              await createPrismaMemorySettingsRepository(prisma).patch(userId, {
                expectedMemoryRevision: 0,
                expectedSettingsRevision: 0,
                useMemoryFacts: true
              });
              const scope = await createPrismaMemoryScopeRepository(prisma)
                .ensureGlobal(userId);
              const fact = await saveExplicitFact(userId, scope.id);
              const classifiedAt = new Date("2026-08-10T12:00:01.000Z");
              const classifierExecutionId = randomUUID();
              await prisma.$transaction(async (tx) => {
                await tx.memoryExecutionBinding.create({
                  data: {
                    acceptedOutputHash: "b".repeat(64),
                    completedAt: classifiedAt,
                    createdAt: new Date(classifiedAt.getTime() - 1),
                    destinationFingerprint: "c".repeat(64),
                    id: classifierExecutionId,
                    inputHash: "d".repeat(64),
                    logicalRole: "MEMORY_STATEMENT_CLASSIFY",
                    mutationAuthorizationId: `preparing-classification-${randomUUID()}`,
                    ordinal: 0,
                    ownerType: "MUTATION_AUTHORIZATION",
                    pipelineVersion: "preparing-run-test-v1",
                    policyVersion: "memory-statement-safety-policy-v1",
                    promptVersion: "preparing-run-test-v1",
                    providerId: "fixture-provider",
                    recoverableUntil: classifiedAt,
                    relationsDetachedAt: classifiedAt,
                    schemaVersion: "memory-safety-classification-schema-v1",
                    secretFreeExecutionSnapshot: {
                      providerExecutionSnapshot: {
                        providerFamily: "fixture-provider",
                        providerModelId: "fixture-model"
                      },
                      version: 1
                    },
                    startedAt: classifiedAt,
                    state: "SUCCEEDED",
                    userId
                  }
                });
                await tx.memoryFactVersion.update({
                  data: {
                    safetyClassificationReasonCode: "fixture_normal",
                    safetyClassificationState: "CLASSIFIED",
                    safetyClassifiedAt: classifiedAt,
                    safetyClassifierExecutionId: classifierExecutionId,
                    safetyClassifierModelId: "fixture-model",
                    safetyClassifierPolicyVersion:
                      "memory-statement-safety-policy-v1",
                    safetyClassifierProviderId: "fixture-provider"
                  },
                  where: { id: fact.versionId }
                });
              });
              const exactSafeText = "My preferred editor is Vim.";
              return {
                clientRefTarget: {
                  exactItemId: fact.versionId,
                  factId: fact.factId,
                  factVersionId: fact.versionId,
                  itemType: "FACT_VERSION" as const,
                  recallChunkId: null,
                  sourceChatId: null,
                  sourceMessageIds: []
                },
                contextText: `User memory: ${exactSafeText}`,
                item: {
                  exactSafeText,
                  factVersionId: fact.versionId,
                  finalScore: 0.9,
                  laneRanks: { exact: 1 },
                  selectionReason: "exact"
                },
                querySnapshot: null
              };
            })()
          : await (async () => {
              const history = await createPreparingHistoryFixture(userId);
              return {
                clientRefTarget: {
                  exactItemId: history.chunkId,
                  factId: null,
                  factVersionId: null,
                  itemType: "RECALL_CHUNK" as const,
                  recallChunkId: history.chunkId,
                  sourceChatId: history.sourceChatId,
                  sourceMessageIds: [history.sourceMessageId]
                },
                contextText: `Previous chat: ${history.chunkText}`,
                item: {
                  exactItemId: history.chunkId,
                  exactSafeText: history.chunkText,
                  finalScore: 0.91,
                  itemType: "RECALL_CHUNK" as const,
                  laneRanks: { HISTORY_RECALL_FTS_ENGLISH: 1 },
                  projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT" as const,
                  recallChunkId: history.chunkId,
                  selectionReason: "history_recall_fts_english"
                },
                querySnapshot: "cedar deployment birch release"
              };
            })();
        const chat = await prisma.chat.create({
          data: { title: `${itemType} feedback race`, userId }
        });
        const repository = createPrismaRunRepository(prisma);
        const stage = async (expectedActiveLeafId: string | null) => {
          const request = normalizedRequest(
            chat.id,
            "Use the selected Memory item for this answer."
          );
          const admitted = await repository.admitPreparingRun({
            admissionKind: "NORMAL_SEND",
            chatId: chat.id,
            content: request.content,
            expectedActiveLeafId,
            modelId: request.modelId,
            normalizedRequest: request,
            provider: request.provider,
            providerRequestPreview: {},
            userId
          });
          await expect(repository.completePreparingRunAttempt({
            attemptId: admitted.attemptId,
            result: {
              budgetSnapshot: {
                hardCapTokens: 2_500,
                schemaVersion: 1,
                utilityEgressMode: "LOCAL_ONLY"
              },
              items: [selected.item],
              outcome: "USED",
              preparedContext: {
                approxTokens: 24,
                text: selected.contextText
              },
              querySnapshot: selected.querySnapshot
            },
            runId: admitted.runId,
            userId
          })).resolves.toBe(true);
          const finalRequest: NormalizedRunRequest = {
            ...request,
            personalContext: {
              approxTokens: 24,
              itemCount: 1,
              memoryGeneration: admitted.memoryGeneration,
              memoryRevision: admitted.memoryRevision,
              mode: "prefetched",
              text: selected.contextText
            }
          };
          return { admitted, finalRequest };
        };

        const origin = await stage(null);
        await expect(repository.finalizePreparingRun({
          attemptId: origin.admitted.attemptId,
          normalizedRequest: origin.finalRequest,
          providerRequestPreview: {},
          runId: origin.admitted.runId,
          userId
        })).resolves.toBe(true);
        await prisma.$transaction([
          prisma.modelRun.update({
            data: { status: "complete" },
            where: { id: origin.admitted.runId }
          }),
          prisma.message.update({
            data: {
              content: textMessageContent("Origin answer."),
              status: "complete"
            },
            where: { id: origin.admitted.assistantMessageId }
          })
        ]);
        const originBinding = await prisma.modelRunMemoryBinding.findUniqueOrThrow({
          where: { modelRunId: origin.admitted.runId }
        });
        const originItem = await prisma.modelRunMemoryItem.findFirstOrThrow({
          where: { bindingId: originBinding.id, itemType, userId }
        });

        const pending = await stage(origin.admitted.assistantMessageId);
        await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: pending.admitted.attemptId }
        })).resolves.toMatchObject({ outcome: "USED", state: "READY" });
        await expect(prisma.memoryRetrievalAttemptItem.count({
          where: { attemptId: pending.admitted.attemptId, userId }
        })).resolves.toBe(1);

        const refs = createMemoryClientRefService({
          encryptionKey: () => Buffer.alloc(32, itemType === "FACT_VERSION" ? 41 : 42)
        });
        const memoryRef = refs.mint(userId, {
          allowedOperations: ["NOT_RELEVANT"],
          originatingRunId: origin.admitted.runId,
          target: selected.clientRefTarget
        });
        const requestNonce = `not-relevant-ready-${itemType.toLowerCase()}`;
        await expect(createMemorySourceActionService({
          authorizationRepository:
            createPrismaMemoryMutationAuthorizationRepository(prisma),
          client: prisma,
          clientRefs: refs,
          explicitService: {} as never,
          lifecycleService: {} as never
        }).execute(userId, {
          action: "NOT_RELEVANT",
          memoryRef,
          requestNonce
        })).resolves.toEqual({ status: "COMMITTED" });
        await expect(prisma.memoryFeedback.findFirstOrThrow({
          where: { requestId: requestNonce, userId }
        })).resolves.toMatchObject({
          feedbackType: "NOT_USEFUL",
          memoryFactId: selected.clientRefTarget.factId,
          memoryFactVersionId: selected.clientRefTarget.factVersionId,
          modelRunId: origin.admitted.runId,
          modelRunMemoryItemId: originItem.id,
          recallChunkId: selected.clientRefTarget.recallChunkId,
          targetKind: itemType
        });

        await expect(repository.finalizePreparingRun({
          attemptId: pending.admitted.attemptId,
          normalizedRequest: pending.finalRequest,
          providerRequestPreview: {},
          runId: pending.admitted.runId,
          userId
        })).rejects.toMatchObject({
          code: "memory_attempt_item_stale",
          retryable: true
        });
        await expect(prisma.modelRunMemoryBinding.findUnique({
          where: { modelRunId: pending.admitted.runId }
        })).resolves.toBeNull();
        await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: pending.admitted.attemptId }
        })).resolves.toMatchObject({ state: "READY" });
        if (itemType === "FACT_VERSION") {
          await expect(prisma.memoryFactVersion.findFirstOrThrow({
            where: {
              id: selected.clientRefTarget.factVersionId!,
              state: "ACTIVE",
              userId
            }
          })).resolves.toBeTruthy();
        } else {
          await expect(prisma.memoryRecallChunk.findFirstOrThrow({
            where: {
              id: selected.clientRefTarget.recallChunkId!,
              state: "ACTIVE",
              userId
            }
          })).resolves.toBeTruthy();
        }
      });
    }
  );

  it("forgets an exact Past Chat source before projection, retrieval, and final rejoin", async () => {
    await withPreparingUser(async ({ userId }) => {
      const history = await createPreparingHistoryFixture(userId);
      const repository = createPrismaRunRepository(prisma);
      const retrieval = createPrismaLocalMemoryRetrievalRepository(prisma);
      const chat = await prisma.chat.create({
        data: { title: "Past Chat source forget", userId }
      });
      const queryText = "What did we decide about cedar deployment?";
      const contextText = `Previous chat: ${history.chunkText}`;
      const stage = async (expectedActiveLeafId: string | null) => {
        const request = normalizedRequest(chat.id, queryText);
        const admitted = await repository.admitPreparingRun({
          admissionKind: "NORMAL_SEND",
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId,
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: {},
          userId
        });
        await expect(repository.completePreparingRunAttempt({
          attemptId: admitted.attemptId,
          result: {
            budgetSnapshot: {
              hardCapTokens: 2_500,
              schemaVersion: 1,
              utilityEgressMode: "LOCAL_ONLY"
            },
            items: [{
              exactItemId: history.chunkId,
              exactSafeText: history.chunkText,
              finalScore: 0.91,
              itemType: "RECALL_CHUNK",
              laneRanks: { HISTORY_RECALL_FTS_ENGLISH: 1 },
              projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
              recallChunkId: history.chunkId,
              selectionReason: "history_recall_fts_english"
            }],
            outcome: "USED",
            preparedContext: { approxTokens: 24, text: contextText },
            querySnapshot: "cedar deployment"
          },
          runId: admitted.runId,
          userId
        })).resolves.toBe(true);
        return {
          admitted,
          finalRequest: {
            ...request,
            personalContext: {
              approxTokens: 24,
              itemCount: 1,
              memoryGeneration: admitted.memoryGeneration,
              memoryRevision: admitted.memoryRevision,
              mode: "prefetched" as const,
              text: contextText
            }
          }
        };
      };

      const origin = await stage(null);
      await expect(repository.finalizePreparingRun({
        attemptId: origin.admitted.attemptId,
        normalizedRequest: origin.finalRequest,
        providerRequestPreview: {},
        runId: origin.admitted.runId,
        userId
      })).resolves.toBe(true);
      await prisma.$transaction([
        prisma.modelRun.update({
          data: { status: "complete" },
          where: { id: origin.admitted.runId }
        }),
        prisma.message.update({
          data: {
            content: textMessageContent("Origin answer."),
            status: "complete"
          },
          where: { id: origin.admitted.assistantMessageId }
        })
      ]);
      const pending = await stage(origin.admitted.assistantMessageId);

      const plan = planMemoryRetrieval({
        currentUserText: "cedar deployment",
        filters: { sourceKinds: ["HISTORY"] },
        now: new Date("2026-08-21T12:00:00.000Z")
      });
      const beforeRetrieval = await retrieval.retrieve({
        assistantId: null,
        chatId: chat.id,
        now: new Date("2026-08-21T12:00:00.000Z"),
        plan,
        userId
      });
      expect(beforeRetrieval.laneResults.flatMap(({ candidates }) =>
        candidates.map(({ itemId }) => itemId))).toContain(history.chunkId);

      const refs = createMemoryClientRefService({
        encryptionKey: () => Buffer.alloc(32, 43)
      });
      const beforeSources = await loadMemoryRunSources(prisma, {
        clientRefs: refs,
        runIds: [origin.admitted.runId],
        userId
      });
      const source = beforeSources.get(origin.admitted.runId)?.find(({ sourceType }) =>
        sourceType === "PAST_CHAT");
      expect(source).toMatchObject({
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        sourceAvailable: true,
        sourceType: "PAST_CHAT",
        text: history.chunkText
      });
      if (!source?.sourceAvailable || !source.memoryRef) {
        throw new Error("past_chat_source_fixture_invalid");
      }

      const mutationRepository = createPrismaMemoryRecallSourceMutationRepository(
        suppressionKeyring,
        prisma
      );
      const service = createMemorySourceActionService({
        authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
        client: prisma,
        clientRefs: refs,
        explicitService: {} as never,
        lifecycleService: {} as never,
        recallMutationRepository: mutationRepository
      });
      const countersBefore = await prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      });
      const requestNonce = "forget-exact-past-chat-source";
      const forget = {
        action: "FORGET" as const,
        memoryRef: source.memoryRef,
        requestNonce
      };
      await expect(service.execute(userId, forget)).resolves.toEqual({ status: "COMMITTED" });
      await expect(service.execute(userId, forget)).resolves.toEqual({ status: "COMMITTED" });

      const suppressions = await prisma.memorySuppression.findMany({
        orderBy: { createdAt: "asc" },
        where: {
          scope: "SOURCE_MESSAGE",
          sourceChatId: history.sourceChatId,
          sourceMessageId: history.sourceMessageId,
          userId
        }
      });
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]).toMatchObject({
        explicitOverrideAllowed: true,
        expiresAt: null,
        fingerprintKeyVersion: suppressionKeyring.currentKeyId,
        scope: "SOURCE_MESSAGE",
        sourceBranchGeneration: 0,
        sourceChatId: history.sourceChatId,
        sourceMessageId: history.sourceMessageId,
        userId
      });
      const countersAfter = await prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      });
      expect(countersAfter).toEqual({
        memoryGeneration: countersBefore.memoryGeneration + 1,
        memoryRevision: countersBefore.memoryRevision + 1
      });

      await expect(loadMemoryRunSources(prisma, {
        clientRefs: refs,
        runIds: [origin.admitted.runId],
        userId
      })).resolves.toEqual(new Map());
      await expect(service.resolveOpenSource(
        userId,
        source.memoryRef
      )).rejects.toMatchObject({ code: "memory_not_found" });

      const afterRetrieval = await retrieval.retrieve({
        assistantId: null,
        chatId: chat.id,
        now: new Date("2026-08-21T12:00:01.000Z"),
        plan,
        userId
      });
      expect(afterRetrieval.laneResults.flatMap(({ candidates }) =>
        candidates.map(({ itemId }) => itemId))).not.toContain(history.chunkId);
      await expect(repository.finalizePreparingRun({
        attemptId: pending.admitted.attemptId,
        normalizedRequest: pending.finalRequest,
        providerRequestPreview: {},
        runId: pending.admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_item_stale",
        retryable: true
      });
      await expect(prisma.modelRunMemoryBinding.findUnique({
        where: { modelRunId: pending.admitted.runId }
      })).resolves.toBeNull();
    });
  });

  it("rejects a secret-tainted query snapshot at the persistence boundary", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Secret query", userId } });
      const request = normalizedRequest(chat.id);
      const repository = createPrismaRunRepository(prisma);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {},
        userId
      });

      await expect(repository.completePreparingRunAttempt({
        attemptId: admitted.attemptId,
        result: {
          ...dormantMemoryAttemptResult(admitted.settingsSnapshot),
          querySnapshot: "postgresql://admin:supersecret@example.test/private"
        },
        runId: admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_result_invalid",
        retryable: false
      });
      await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
        where: { id: admitted.attemptId }
      })).resolves.toMatchObject({
        boundedSafeQuerySnapshot: null,
        state: "PENDING"
      });
    });
  });

  it.each([
    ["action", { memoryActionTools: { version: "model-driven-v2" as const } }],
    ["history", { memoryHistoryTool: { maxCalls: 2 as const, pageSize: 20 as const } }]
  ] as const)("rejects the retired answer-model Memory %s contract at admission", async (
    _kind,
    legacyContract
  ) => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Retired Memory tool", userId } });
      const baseRequest = normalizedRequest(chat.id);
      const request: NormalizedRunRequest = {
        ...baseRequest,
        ...legacyContract,
        modelCapabilities: {
          ...baseRequest.modelCapabilities,
          toolCalling: true
        },
        toolMode: "auto"
      };
      const repository = createPrismaRunRepository(prisma);
      await expect(repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {},
        userId
      })).rejects.toMatchObject({
        code: "memory_base_request_invalid",
        retryable: false
      });
      await expect(prisma.modelRun.count({ where: { chatId: chat.id } })).resolves.toBe(0);
    });
  });

  it("rejects changed scope, safety classification, or Forget before finalization", async () => {
    await withPreparingUser(async ({ userId }) => {
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        useMemoryFacts: true
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const fact = await saveExplicitFact(userId, scope.id);
      const classification = await classifyExplicitFact(userId, fact.versionId);
      const repository = createPrismaRunRepository(prisma);
      const createStagedRun = async (title: string) => {
        const chat = await prisma.chat.create({ data: { title, userId } });
        const request = normalizedRequest(chat.id);
        const admitted = await repository.admitPreparingRun({
          admissionKind: "NORMAL_SEND",
          chatId: chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: {},
          userId
        });
        await repository.completePreparingRunAttempt({
          attemptId: admitted.attemptId,
          result: {
            budgetSnapshot: { hardCapTokens: 2_500, schemaVersion: 1 },
            items: [{
              exactSafeText: "My preferred editor is Vim.",
              factVersionId: fact.versionId,
              finalScore: 0.9,
              laneRanks: { exact: 1 },
              selectionReason: "exact"
            }],
            outcome: "USED",
            preparedContext: {
              approxTokens: 8,
              text: "User memory: My preferred editor is Vim."
            }
          },
          runId: admitted.runId,
          userId
        });
        const settings = await prisma.userMemorySettings.findUniqueOrThrow({
          where: { userId }
        });
        const finalRequest: NormalizedRunRequest = {
          ...request,
          personalContext: {
            approxTokens: 8,
            itemCount: 1,
            memoryGeneration: settings.memoryGeneration,
            memoryRevision: settings.memoryRevision,
            mode: "prefetched",
            text: "User memory: My preferred editor is Vim."
          }
        };
        return { admitted, finalRequest };
      };

      const accepted = await createStagedRun("Exact item");
      const scopeStale = await createStagedRun("Stale scope");
      const classificationStale = await createStagedRun("Stale safety classification");
      const stale = await createStagedRun("Stale item");
      await prisma.userMemorySettings.update({
        data: { memoryRevision: { increment: 1 } },
        where: { userId }
      });
      await expect(repository.finalizePreparingRun({
        attemptId: accepted.admitted.attemptId,
        normalizedRequest: accepted.finalRequest,
        providerRequestPreview: {},
        runId: accepted.admitted.runId,
        userId
      })).resolves.toBe(true);
      const binding = await prisma.modelRunMemoryBinding.findUniqueOrThrow({
        where: { modelRunId: accepted.admitted.runId }
      });
      const bindingItems = await prisma.modelRunMemoryItem.findMany({
        where: { bindingId: binding.id }
      });
      expect(binding).toMatchObject({
        finalizedRevisionSnapshot: accepted.admitted.memoryRevision + 1,
        outcome: "USED",
        retrievalRevisionSnapshot: accepted.admitted.memoryRevision
      });
      expect(bindingItems).toEqual([
        expect.objectContaining({
          factVersionId: fact.versionId,
          finalScore: 0.9,
          includedText: "My preferred editor is Vim."
        })
      ]);

      const scopeItem = await prisma.memoryRetrievalAttemptItem.findFirstOrThrow({
        where: { attemptId: scopeStale.admitted.attemptId }
      });
      await prisma.memoryRetrievalAttemptItem.update({
        data: {
          versionSnapshot: {
            ...(scopeItem.versionSnapshot as Record<string, unknown>),
            scopeId: "changed-scope-id"
          }
        },
        where: { id: scopeItem.id }
      });
      await expect(repository.finalizePreparingRun({
        attemptId: scopeStale.admitted.attemptId,
        normalizedRequest: scopeStale.finalRequest,
        providerRequestPreview: {},
        runId: scopeStale.admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_item_stale",
        retryable: true
      });
      await repository.settlePreparingRunFailure({
        attemptId: scopeStale.admitted.attemptId,
        errorCode: "memory_attempt_item_stale",
        message: "Selected Memory scope changed.",
        runId: scopeStale.admitted.runId,
        state: "STALE",
        userId
      });
      await prisma.memoryFactVersion.update({
        data: {
          safetyClassificationReasonCode: null,
          safetyClassificationState: "PENDING",
          safetyClassifiedAt: null,
          safetyClassifierExecutionId: null,
          safetyClassifierModelId: null,
          safetyClassifierPolicyVersion: null,
          safetyClassifierProviderId: null
        },
        where: { id: fact.versionId }
      });
      await expect(repository.finalizePreparingRun({
        attemptId: classificationStale.admitted.attemptId,
        normalizedRequest: classificationStale.finalRequest,
        providerRequestPreview: {},
        runId: classificationStale.admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_item_stale",
        retryable: true
      });
      await repository.settlePreparingRunFailure({
        attemptId: classificationStale.admitted.attemptId,
        errorCode: "memory_attempt_item_stale",
        message: "Selected Memory item safety classification changed.",
        runId: classificationStale.admitted.runId,
        state: "STALE",
        userId
      });
      await prisma.memoryFactVersion.update({
        data: classification,
        where: { id: fact.versionId }
      });
      const authorizationRepository =
        createPrismaMemoryMutationAuthorizationRepository(prisma);
      const readRepository = createPrismaExplicitMemoryRepository(prisma);
      const explicitService = createExplicitMemoryService({
        authorizationRepository,
        factRepository: createPrismaMemoryFactRepository(suppressionKeyring, prisma),
        readRepository,
        scopeRepository: createPrismaMemoryScopeRepository(prisma)
      });
      const forgetAuthorization = await explicitService.mintAuthorization(userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: fact.versionId,
        requestNonce: "preparing-forget-race",
        targetFactId: fact.factId
      });
      await createMemoryLifecycleService({
        authorizationRepository,
        mutationRepository: createPrismaMemoryLifecycleRepository(
          suppressionKeyring,
          preparingForgetRegistry(),
          prisma
        ),
        readRepository
      }).forget(userId, fact.factId, {
        expectedVersionId: fact.versionId,
        mutationAuthorizationId: forgetAuthorization.mutationAuthorizationId
      });
      await expect(repository.finalizePreparingRun({
        attemptId: stale.admitted.attemptId,
        normalizedRequest: stale.finalRequest,
        providerRequestPreview: {},
        runId: stale.admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_item_stale",
        retryable: true
      });
      await repository.settlePreparingRunFailure({
        attemptId: stale.admitted.attemptId,
        errorCode: "memory_attempt_item_stale",
        message: "Selected Memory item changed.",
        runId: stale.admitted.runId,
        state: "STALE",
        userId
      });
    });
  });

  it("keeps matching legacy scopes dormant and rejects a respecified global scope", async () => {
    await withPreparingUser(async ({ userId }) => {
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        useMemoryFacts: true
      });
      const folder = await prisma.folder.create({ data: { name: "Legacy scoped run", userId } });
      const assistantDefinition = await prisma.assistantDefinition.create({
        data: { ownerUserId: userId }
      });
      const assistantRevision = await prisma.assistantRevision.create({
        data: {
          assistantId: assistantDefinition.id,
          avatar: {
            accents: [0, 4],
            backgroundShape: "circle",
            foregroundShape: "diamond",
            kind: "generated",
            paletteId: "ocean",
            recipeVersion: 1,
            rotations: [0, 2]
          },
          name: "Legacy scope admission Assistant",
          providerModelId: providerTemplateIds.fakeModel,
          revisionNumber: 1,
          runControls: {},
          searchPlan: { mode: "all_selected", optionIds: [] },
          systemPrompt: "Answer directly."
        }
      });
      await prisma.assistantDefinition.update({
        data: { currentRevisionId: assistantRevision.id },
        where: { id: assistantDefinition.id }
      });
      const folderScope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: folder.id,
        type: "FOLDER"
      });
      const assistantScope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: assistantDefinition.id,
        type: "ASSISTANT"
      });
      const repository = createPrismaRunRepository(prisma);
      const chatScopeChat = await prisma.chat.create({
        data: { title: "Matching legacy Chat scope", userId }
      });
      const chatScope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: chatScopeChat.id,
        type: "CHAT"
      });
      const legacyCases = [
        {
          chat: await prisma.chat.create({
            data: { folderId: folder.id, title: "Matching legacy Folder scope", userId }
          }),
          displayText: "Use the matching legacy Folder-scoped deployment.",
          scopeId: folderScope.id
        },
        {
          assistant: {
            assistantId: assistantDefinition.id,
            revisionId: assistantRevision.id
          },
          chat: await prisma.chat.create({
            data: { title: "Matching legacy Assistant scope", userId }
          }),
          displayText: "Use the matching legacy Assistant-scoped deployment.",
          scopeId: assistantScope.id
        },
        {
          chat: chatScopeChat,
          displayText: "Use the matching legacy Chat-scoped deployment.",
          scopeId: chatScope.id
        }
      ];

      for (const legacy of legacyCases) {
        const fact = await saveExplicitFact(userId, legacy.scopeId, legacy.displayText);
        await classifyExplicitFact(userId, fact.versionId);
        const request = normalizedRequest(legacy.chat.id);
        const admitted = await repository.admitPreparingRun({
          admissionKind: "NORMAL_SEND",
          ...(legacy.assistant ? { assistant: legacy.assistant } : {}),
          chatId: legacy.chat.id,
          content: request.content,
          expectedActiveLeafId: null,
          modelId: request.modelId,
          normalizedRequest: request,
          provider: request.provider,
          providerRequestPreview: {},
          userId
        });
        await expect(repository.completePreparingRunAttempt({
          attemptId: admitted.attemptId,
          result: {
            budgetSnapshot: { hardCapTokens: 2_500, schemaVersion: 1 },
            items: [{
              exactSafeText: legacy.displayText,
              factVersionId: fact.versionId,
              finalScore: 0.9,
              laneRanks: { exact: 1 },
              selectionReason: "exact_legacy_scope"
            }],
            outcome: "USED",
            preparedContext: {
              approxTokens: 8,
              text: `User memory: ${legacy.displayText}`
            }
          },
          runId: admitted.runId,
          userId
        })).rejects.toMatchObject({
          code: "memory_attempt_item_stale",
          retryable: true
        });
      }

      const globalScope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const globalText = "Use the canonical global deployment preference.";
      const globalFact = await saveExplicitFact(userId, globalScope.id, globalText);
      await classifyExplicitFact(userId, globalFact.versionId);
      const globalChat = await prisma.chat.create({
        data: { title: "Global scope finalization", userId }
      });
      const request = normalizedRequest(globalChat.id);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: globalChat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {},
        userId
      });
      const result = {
        budgetSnapshot: { hardCapTokens: 2_500, schemaVersion: 1 },
        items: [{
          exactSafeText: globalText,
          factVersionId: globalFact.versionId,
          finalScore: 0.9,
          laneRanks: { exact: 1 },
          selectionReason: "exact_global_scope"
        }],
        outcome: "USED" as const,
        preparedContext: {
          approxTokens: 8,
          text: `User memory: ${globalText}`
        }
      };
      await expect(repository.completePreparingRunAttempt({
        attemptId: admitted.attemptId,
        result,
        runId: admitted.runId,
        userId
      })).resolves.toBe(true);
      const item = await prisma.memoryRetrievalAttemptItem.findFirstOrThrow({
        where: { attemptId: admitted.attemptId }
      });
      await prisma.memoryRetrievalAttemptItem.update({
        data: {
          versionSnapshot: {
            ...(item.versionSnapshot as Record<string, unknown>),
            scopeId: folderScope.id,
            scopeTargetIdSnapshot: folder.id,
            scopeType: "FOLDER"
          }
        },
        where: { id: item.id }
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(repository.finalizePreparingRun({
        attemptId: admitted.attemptId,
        normalizedRequest: {
          ...request,
          personalContext: {
            approxTokens: 8,
            itemCount: 1,
            memoryGeneration: settings.memoryGeneration,
            memoryRevision: settings.memoryRevision,
            mode: "prefetched",
            text: result.preparedContext.text
          }
        },
        providerRequestPreview: {},
        runId: admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_item_stale",
        retryable: true
      });
      for (const target of [
        { scopeType: "CHAT" as const, targetId: chatScopeChat.id },
        { scopeType: "ASSISTANT" as const, targetId: assistantDefinition.id },
        { scopeType: "FOLDER" as const, targetId: folder.id }
      ]) {
        await prisma.$transaction((tx) => applyMemoryScopeTargetDeletion(tx, {
          ...target,
          userId
        }));
      }
    });
  });

  it("rejects changed DAG authority and settles the owned attempt without dispatch", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "DAG race", userId } });
      const request = normalizedRequest(chat.id);
      const repository = createPrismaRunRepository(prisma);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {},
        userId
      });
      await repository.completePreparingRunAttempt({
        attemptId: admitted.attemptId,
        result: dormantMemoryAttemptResult(admitted.settingsSnapshot),
        runId: admitted.runId,
        userId
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: admitted.userMessageId },
        where: { id: chat.id }
      });

      await expect(repository.finalizePreparingRun({
        attemptId: admitted.attemptId,
        normalizedRequest: request,
        providerRequestPreview: {},
        runId: admitted.runId,
        userId
      })).rejects.toBeInstanceOf(MemoryPreparingRunConflictError);
      await expect(repository.settlePreparingRunFailure({
        attemptId: admitted.attemptId,
        errorCode: "memory_admission_dag_changed",
        message: "Memory admission authority changed.",
        runId: admitted.runId,
        state: "FAILED",
        userId
      })).resolves.toBe(true);
      await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: admitted.runId } }))
        .resolves.toMatchObject({
          normalizedRequest: request,
          status: "error"
        });
      await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
        where: { id: admitted.attemptId }
      })).resolves.toMatchObject({ state: "FAILED" });
    });
  });

  it("records regeneration siblings and atomically cancels their preparation", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Regenerate", userId } });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Original question"),
          role: "user",
          status: "complete"
        }
      });
      const existingAssistant = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Original answer"),
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: existingAssistant.id },
        where: { id: chat.id }
      });
      const request = {
        ...normalizedRequest(chat.id),
        content: textMessageContent("Original question")
      };
      const repository = createPrismaRunRepository(prisma);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "REGENERATE",
        chatId: chat.id,
        modelId: request.modelId,
        normalizedRequest: request,
        preSendAssistantMessageId: existingAssistant.id,
        provider: request.provider,
        providerRequestPreview: {},
        userId,
        userMessageId: userMessage.id
      });
      await expect(prisma.message.findUniqueOrThrow({
        where: { id: admitted.assistantMessageId }
      })).resolves.toMatchObject({ parentMessageId: userMessage.id });
      await expect(repository.cancelRun({
        payload: { code: "run_cancelled", message: "Cancelled during preparation." },
        runId: admitted.runId,
        userId
      })).resolves.toMatchObject({ kind: "cancelled" });
      const [run, attempt, message] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({ where: { id: admitted.runId } }),
        prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: admitted.attemptId }
        }),
        prisma.message.findUniqueOrThrow({ where: { id: admitted.assistantMessageId } })
      ]);
      expect(run).toMatchObject({ normalizedRequest: request, status: "cancelled" });
      expect(attempt.state).toBe("CANCELLED");
      expect(message.status).toBe("cancelled");
    });
  });

  it("expires an interrupted preparation during recovery", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Recovery", userId } });
      const request = normalizedRequest(chat.id);
      const repository = createPrismaRunRepository(prisma);
      const admitted = await repository.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {},
        userId
      });
      await expect(repository.recoverPreparingRun({
        now: new Date(Date.now() + 11 * 60_000),
        runId: admitted.runId,
        userId
      })).resolves.toBe("settled");
      const [run, attempt] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({ where: { id: admitted.runId } }),
        prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: admitted.attemptId }
        })
      ]);
      expect(run).toMatchObject({ normalizedRequest: request, status: "error" });
      expect(attempt).toMatchObject({
        errorCode: "memory_preparing_attempt_expired",
        state: "EXPIRED"
      });
    });
  });
});
