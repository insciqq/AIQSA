import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memory";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import type { NormalizedRunRequest } from "../providers/types";
import { MemorySuppressionKeyring } from "../memory/suppressionKeyring";
import { createPrismaMemoryFactRepository } from "../memory/persistence/facts";
import { createPrismaMemoryMutationAuthorizationRepository } from "../memory/persistence/authorizations";
import { createPrismaMemoryScopeRepository } from "../memory/persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../memory/persistence/settings";
import {
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../memory/persistence/lexical";
import { createPrismaExplicitMemoryRepository } from "../memory/explicit/repository";
import { createExplicitMemoryService } from "../memory/explicit/service";
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
import { createMemoryActionExecutor } from "../memory/actions/toolExecutor";
import { MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION } from "../memory/retrieval/runUtilities";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT } from "../memory/retrieval/vector";
import { applyMemoryScopeTargetDeletion } from "../memory/scopeLifecycle";
import { createPrismaRunRepository } from "./prismaRepository";
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
    knowledgePlan: { baseIds: [] },
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
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
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
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
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
      chunkingVersion: "memory-history-chunking-v1",
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
      chunkingVersion: "memory-history-chunking-v1",
      contentHash: chunkHash,
      languageCode: "en",
      normalizedSafeSearchText: normalizeMemorySearchText(chunkText),
      occurredFrom: now,
      occurredTo: now,
      redactionState: "NOT_NEEDED",
      safeProjectedText: chunkText,
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-history-source-projection-v1",
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
      safeSearchText: normalizeMemorySearchText(chunkText),
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(chunkText),
      safetyIdentitySnapshot: memorySha256({ safety: "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({ chunkId: chunk.id, sourceHash }),
      suppressionIdentitySnapshot: memorySha256({ sourceHash }),
      userId
    }]
  });
  return {
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

        const [attempt, executionBinding, usageCount] = await Promise.all([
          prisma.memoryRetrievalAttempt.findUniqueOrThrow({
            where: { id: admitted.attemptId }
          }),
          prisma.memoryExecutionBinding.findUniqueOrThrow({
            where: { id: bound.id }
          }),
          prisma.usageEvent.count({
            where: { memoryExecutionBindingId: bound.id, userId }
          })
        ]);
        expect(attempt).toMatchObject({
          acceptedUtilityEgressFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          externalRolesUsed: ["MEMORY_QUERY_EMBED"],
          state: "CONSUMED",
          utilityEgressMode: "CONSENTED_EXTERNAL"
        });
        expect(executionBinding).toMatchObject({
          logicalRole: "MEMORY_QUERY_EMBED",
          retrievalAttemptId: admitted.attemptId,
          state: "FAILED"
        });
        expect(usageCount).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("retrieves explicit facts locally and finalizes immutable run evidence without utility consent", async () => {
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
        memoryMaterializer(personalContext) {
          const finalRequest: NormalizedRunRequest = {
            ...request,
            personalContext
          };
          return {
            contextTruncation: null,
            normalizedRequest: finalRequest,
            providerRequest: {
              ...finalRequest,
              attachments: []
            },
            providerRequestPreview: { personalContext: personalContext.text }
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

      expect(created.materializedRequest?.normalizedRequest.personalContext).toMatchObject({
        itemCount: 1,
        mode: "prefetched",
        text: expect.stringContaining("My preferred editor is Vim.")
      });
      expect(run).toMatchObject({
        normalizedRequest: expect.objectContaining({
          personalContext: expect.objectContaining({ itemCount: 1, mode: "prefetched" })
        }),
        status: "streaming"
      });
      expect(attempt).toMatchObject({
        acceptedUtilityEgressFingerprint: null,
        boundedSafeQuerySnapshot: "What is my preferred editor?",
        externalRolesUsed: [],
        outcome: "USED",
        state: "CONSUMED",
        utilityEgressMode: "LOCAL_ONLY"
      });
      expect(binding).toMatchObject({
        boundedSafeQuerySnapshot: "What is my preferred editor?",
        outcome: "USED",
        retrievalAttemptId: attempt.id
      });
      expect(items).toEqual([
        expect.objectContaining({
          factVersionId: fact.versionId,
          includedText: "My preferred editor is Vim."
        })
      ]);

      const chatUpdate = await repository.getChatUpdateForRun({
        assistantMessageId: created.assistantMessageId,
        chatId: chat.id,
        userId,
        userMessageId: created.userMessageId
      });
      expect(chatUpdate?.messages.find(({ id }) => id === created.assistantMessageId)
        ?.artifactSummary ?? null).toBeNull();

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
          querySnapshot: "api key: sk-1234567890abcdef"
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

  it("binds a committed save to its model-driven call and exact run authorization", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Run Memory save", userId } });
      const source = "Remember that I like tea";
      const statement = "I like tea";
      const baseRequest = normalizedRequest(chat.id, source);
      const request: NormalizedRunRequest = {
        ...baseRequest,
        memoryActionTools: { version: "model-driven-v2" },
        modelCapabilities: {
          ...baseRequest.modelCapabilities,
          toolCalling: true
        },
        toolMode: "auto"
      };
      const repository = createPrismaRunRepository(prisma);
      const created = await repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: {},
        userId
      });
      const toolCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: {
            scope: { target_id: null, type: "GLOBAL_USER" },
            source_text: source,
            statement
          },
          modelRunId: created.runId,
          ordinal: 0,
          providerCallId: "provider-save-1",
          roundIndex: 0,
          toolName: "save_memory"
        }
      });
      const authorizationRepository = createPrismaMemoryMutationAuthorizationRepository(prisma);
      const explicitService = createExplicitMemoryService({
        authorizationRepository,
        factRepository: createPrismaMemoryFactRepository(suppressionKeyring, prisma),
        readRepository: createPrismaExplicitMemoryRepository(prisma),
        scopeRepository: createPrismaMemoryScopeRepository(prisma)
      });
      const executor = createMemoryActionExecutor({
        authorizationRepository,
        explicitService,
        lifecycleService: {
          deleteExplicit: vi.fn(),
          forget: vi.fn(),
          status: vi.fn()
        },
        reviewService: { feedback: vi.fn() }
      });

      const result = await executor.execute({
        arguments: {
          scope: { target_id: null, type: "GLOBAL_USER" },
          source_text: source,
          statement
        },
        id: "provider-save-1",
        name: "save_memory"
      }, {
        persistedToolCallId: toolCall.id,
        request: { ...request, attachments: [] },
        runId: created.runId,
        userId
      });
      const [authorization, receipt] = await Promise.all([
        prisma.memoryMutationAuthorization.findFirstOrThrow({
          where: { modelRunId: created.runId, userId }
        }),
        prisma.memoryOperationReceipt.findFirstOrThrow({
          where: { modelRunId: created.runId, userId }
        })
      ]);

      expect(result.status).toBe("complete");
      expect(authorization).toMatchObject({
        consumedAt: expect.any(Date),
        persistedToolCallId: toolCall.id,
        sourceChatId: chat.id,
        sourceMessageId: created.userMessageId
      });
      expect(receipt).toMatchObject({
        modelRunId: created.runId,
        operation: "SAVE",
        outcome: "APPLIED",
        persistedToolCallId: toolCall.id
      });
      const chatUpdate = await repository.getChatUpdateForRun({
        assistantMessageId: created.assistantMessageId,
        chatId: chat.id,
        userId,
        userMessageId: created.userMessageId
      });
      expect(chatUpdate?.messages.find(({ id }) => id === created.assistantMessageId)
        ?.artifactSummary?.memoryAction).toMatchObject({
          factId: receipt.targetFactId,
          operation: "SAVE",
          statement,
          status: "COMMITTED",
          versionId: receipt.targetVersionId
        });
    });
  });

  it("freezes exact selected evidence and rejects changed scope or a real Forget before finalization", async () => {
    await withPreparingUser(async ({ userId }) => {
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        useMemoryFacts: true
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const fact = await saveExplicitFact(userId, scope.id);
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

  it("admits only the exact current Folder scope and rejects a target tombstone before finalization", async () => {
    await withPreparingUser(async ({ userId }) => {
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        useMemoryFacts: true
      });
      const [folder, otherFolder] = await Promise.all([
        prisma.folder.create({ data: { name: "Scoped run", userId } }),
        prisma.folder.create({ data: { name: "Other run", userId } })
      ]);
      const scope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: folder.id,
        type: "FOLDER"
      });
      const displayText = "Use the exact Folder-scoped deployment.";
      const fact = await saveExplicitFact(userId, scope.id, displayText);
      const repository = createPrismaRunRepository(prisma);

      const stage = async (
        title: string,
        folderId: string,
        item: Readonly<{ displayText: string; versionId: string }> = {
          displayText,
          versionId: fact.versionId
        }
      ) => {
        const chat = await prisma.chat.create({ data: { folderId, title, userId } });
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
        const result = {
          budgetSnapshot: { hardCapTokens: 2_500, schemaVersion: 1 },
          items: [{
            exactSafeText: item.displayText,
            factVersionId: item.versionId,
            finalScore: 0.9,
            laneRanks: { exact: 1 },
            selectionReason: "exact_folder"
          }],
          outcome: "USED" as const,
          preparedContext: {
            approxTokens: 8,
            text: `User memory: ${item.displayText}`
          }
        };
        return { admitted, request, result };
      };

      const mismatched = await stage("Wrong folder", otherFolder.id);
      await expect(repository.completePreparingRunAttempt({
        attemptId: mismatched.admitted.attemptId,
        result: mismatched.result,
        runId: mismatched.admitted.runId,
        userId
      })).rejects.toMatchObject({ code: "memory_attempt_item_stale" });

      const accepted = await stage("Exact folder", folder.id);
      await expect(repository.completePreparingRunAttempt({
        attemptId: accepted.admitted.attemptId,
        result: accepted.result,
        runId: accepted.admitted.runId,
        userId
      })).resolves.toBe(true);
      const acceptedSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(repository.finalizePreparingRun({
        attemptId: accepted.admitted.attemptId,
        normalizedRequest: {
          ...accepted.request,
          personalContext: {
            approxTokens: 8,
            itemCount: 1,
            memoryGeneration: acceptedSettings.memoryGeneration,
            memoryRevision: acceptedSettings.memoryRevision,
            mode: "prefetched",
            text: accepted.result.preparedContext.text
          }
        },
        providerRequestPreview: {},
        runId: accepted.admitted.runId,
        userId
      })).resolves.toBe(true);

      const concurrentFolder = await prisma.folder.create({
        data: { name: "Concurrent finalization", userId }
      });
      const concurrentScope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: concurrentFolder.id,
        type: "FOLDER"
      });
      const concurrentText = "Serialize scoped finalization against target deletion.";
      const concurrentFact = await saveExplicitFact(
        userId,
        concurrentScope.id,
        concurrentText
      );
      const concurrent = await stage(
        "Concurrent target race",
        concurrentFolder.id,
        { displayText: concurrentText, versionId: concurrentFact.versionId }
      );
      await expect(repository.completePreparingRunAttempt({
        attemptId: concurrent.admitted.attemptId,
        result: concurrent.result,
        runId: concurrent.admitted.runId,
        userId
      })).resolves.toBe(true);
      const concurrentSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const [concurrentFinalization, concurrentDeletion] = await Promise.allSettled([
        repository.finalizePreparingRun({
          attemptId: concurrent.admitted.attemptId,
          normalizedRequest: {
            ...concurrent.request,
            personalContext: {
              approxTokens: 8,
              itemCount: 1,
              memoryGeneration: concurrentSettings.memoryGeneration,
              memoryRevision: concurrentSettings.memoryRevision,
              mode: "prefetched",
              text: concurrent.result.preparedContext.text
            }
          },
          providerRequestPreview: {},
          runId: concurrent.admitted.runId,
          userId
        }),
        createPrismaChatRepository(prisma).deleteFolder({
          folderId: concurrentFolder.id,
          userId
        })
      ]);
      expect(concurrentDeletion).toMatchObject({ status: "fulfilled", value: true });
      if (concurrentFinalization.status === "rejected") {
        expect(["memory_admission_dag_changed", "memory_attempt_item_stale"])
          .toContain(concurrentFinalization.reason?.code);
      } else {
        expect(concurrentFinalization.value).toBe(true);
      }

      const raced = await stage("Deleted target race", folder.id);
      await expect(repository.completePreparingRunAttempt({
        attemptId: raced.admitted.attemptId,
        result: raced.result,
        runId: raced.admitted.runId,
        userId
      })).resolves.toBe(true);
      const racedSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await prisma.$transaction((tx) => applyMemoryScopeTargetDeletion(tx, {
        scopeType: "FOLDER",
        targetId: folder.id,
        userId
      }));
      await expect(repository.finalizePreparingRun({
        attemptId: raced.admitted.attemptId,
        normalizedRequest: {
          ...raced.request,
          personalContext: {
            approxTokens: 8,
            itemCount: 1,
            memoryGeneration: racedSettings.memoryGeneration,
            memoryRevision: racedSettings.memoryRevision,
            mode: "prefetched",
            text: raced.result.preparedContext.text
          }
        },
        providerRequestPreview: {},
        runId: raced.admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_attempt_item_stale",
        retryable: true
      });
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
