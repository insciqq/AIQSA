import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import type { NormalizedRunRequest } from "../providers/types";
import { MemorySuppressionKeyring } from "../memory/suppressionKeyring";
import { createPrismaMemoryFactRepository } from "../memory/persistence/facts";
import { createPrismaMemoryMutationAuthorizationRepository } from "../memory/persistence/authorizations";
import { createPrismaMemoryScopeRepository } from "../memory/persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../memory/persistence/settings";
import { createPrismaExplicitMemoryRepository } from "../memory/explicit/repository";
import { createExplicitMemoryService } from "../memory/explicit/service";
import { planMemoryActionFromText } from "../memory/actions/intent";
import { createMemoryActionExecutor } from "../memory/actions/toolExecutor";
import { retrieveExplicitRunMemory } from "../memory/retrieval/explicitRun";
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
    searchStrategy: "search-disabled"
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

describe("PREPARING run orchestration", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admits a nullable-predecessor send and atomically consumes one dormant attempt", async () => {
    await withPreparingUser(async ({ userId }) => {
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
        providerRequestPreview: null,
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
        providerRequestPreview: { request: "base" },
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

  it("allows exactly one fresh attempt after consent drift", async () => {
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

      const firstFinalize = repository.finalizePreparingRun({
        attemptId: admitted.attemptId,
        normalizedRequest: request,
        providerRequestPreview: {},
        runId: admitted.runId,
        userId
      });
      await expect(firstFinalize).rejects.toMatchObject({
        code: "memory_admission_settings_changed",
        retryable: true
      });
      const retried = await repository.retryPreparingRunAttempt({
        attemptId: admitted.attemptId,
        now: new Date(),
        runId: admitted.runId,
        userId
      });
      expect(retried).not.toBeNull();
      await repository.beginPreparingRunAttempt({
        attemptId: retried!.attemptId,
        now: new Date(),
        runId: admitted.runId,
        userId
      });
      await repository.completePreparingRunAttempt({
        attemptId: retried!.attemptId,
        result: dormantMemoryAttemptResult(retried!.settingsSnapshot),
        runId: admitted.runId,
        userId
      });
      await expect(repository.finalizePreparingRun({
        attemptId: retried!.attemptId,
        normalizedRequest: request,
        providerRequestPreview: {},
        runId: admitted.runId,
        userId
      })).resolves.toBe(true);
      await expect(repository.retryPreparingRunAttempt({
        attemptId: retried!.attemptId,
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
          { attemptOrdinal: 0, state: "STALE" },
          { attemptOrdinal: 1, state: "CONSUMED" }
        ]);
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
        boundedSafeQuerySnapshot: "what is my preferred editor?",
        externalRolesUsed: [],
        outcome: "USED",
        state: "CONSUMED",
        utilityEgressMode: "LOCAL_ONLY"
      });
      expect(binding).toMatchObject({
        boundedSafeQuerySnapshot: "what is my preferred editor?",
        outcome: "USED",
        retrievalAttemptId: attempt.id
      });
      expect(items).toEqual([
        expect.objectContaining({
          factVersionId: fact.versionId,
          includedText: "My preferred editor is Vim."
        })
      ]);
    });
  });

  it("finalizes an authoritative empty list for a non-tool model", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Empty Memory list", userId } });
      const baseRequest = normalizedRequest(chat.id, "What do you remember about me?");
      const actionPlan = planMemoryActionFromText("What do you remember about me?");
      if (actionPlan.kind !== "LIST") throw new Error("invalid_memory_action_fixture");
      const request: NormalizedRunRequest = {
        ...baseRequest,
        memoryActionPlan: actionPlan,
        toolMode: "auto"
      };
      const repository = createPrismaRunRepository(prisma);
      const created = await repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        memoryMaterializer(personalContext) {
          const finalRequest = { ...request, personalContext };
          return {
            contextTruncation: null,
            normalizedRequest: finalRequest,
            providerRequest: { ...finalRequest, attachments: [] },
            providerRequestPreview: { personalContext: personalContext.text }
          };
        },
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      });

      const [attempt, binding] = await Promise.all([
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
        itemCount: 0,
        text: expect.stringContaining("No active explicit memories are saved.")
      });
      expect(attempt).toMatchObject({
        budgetSnapshot: expect.objectContaining({
          managementResult: "AUTHORITATIVE_EMPTY_LIST"
        }),
        outcome: "EMPTY",
        preparedContextText: expect.stringContaining("No active explicit memories are saved."),
        state: "CONSUMED"
      });
      expect(binding).toMatchObject({
        contextTokenCount: expect.any(Number),
        outcome: "EMPTY"
      });
      expect(binding.contextTokenCount).toBeGreaterThan(0);
      expect(items).toEqual([]);
    });
  });

  it("fails non-tool Memory management when authoritative context cannot be materialized", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: { title: "Unmaterialized Memory list", userId }
      });
      const baseRequest = normalizedRequest(chat.id, "What do you remember about me?");
      const actionPlan = planMemoryActionFromText("What do you remember about me?");
      if (actionPlan.kind !== "LIST") throw new Error("invalid_memory_action_fixture");
      const request: NormalizedRunRequest = {
        ...baseRequest,
        memoryActionPlan: actionPlan,
        toolMode: "auto"
      };
      const repository = createPrismaRunRepository(prisma);

      await expect(repository.createRun({
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        memoryMaterializer() {
          return null;
        },
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      })).rejects.toMatchObject({
        code: "memory_action_failed",
        retryable: false
      });

      const run = await prisma.modelRun.findFirstOrThrow({ where: { chatId: chat.id } });
      const attempt = await prisma.memoryRetrievalAttempt.findFirstOrThrow({
        where: { modelRunId: run.id }
      });
      expect(run).toMatchObject({
        errorPayload: expect.objectContaining({ code: "memory_action_failed" }),
        normalizedRequest: request,
        status: "error"
      });
      expect(attempt).toMatchObject({
        errorCode: "memory_action_failed",
        state: "FAILED"
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

  it("rejects an authoritative empty list when Memory changes before finalization", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Empty list race", userId } });
      const baseRequest = normalizedRequest(chat.id, "What do you remember about me?");
      const actionPlan = planMemoryActionFromText("What do you remember about me?");
      if (actionPlan.kind !== "LIST") throw new Error("invalid_memory_action_fixture");
      const request: NormalizedRunRequest = {
        ...baseRequest,
        memoryActionPlan: actionPlan,
        toolMode: "auto"
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
      const result = await retrieveExplicitRunMemory(prisma, {
        actionPlan,
        normalizedRequest: request,
        settings: admitted.settingsSnapshot,
        userId
      });
      await repository.completePreparingRunAttempt({
        attemptId: admitted.attemptId,
        result,
        runId: admitted.runId,
        userId
      });
      await prisma.userMemorySettings.update({
        data: { memoryRevision: { increment: 1 } },
        where: { userId }
      });
      const personalContext = {
        approxTokens: result.preparedContext!.approxTokens,
        itemCount: 0,
        memoryGeneration: admitted.memoryGeneration,
        memoryRevision: admitted.memoryRevision,
        mode: "prefetched" as const,
        text: result.preparedContext!.text
      };

      await expect(repository.finalizePreparingRun({
        attemptId: admitted.attemptId,
        normalizedRequest: { ...request, personalContext },
        providerRequestPreview: { personalContext: personalContext.text },
        runId: admitted.runId,
        userId
      })).rejects.toMatchObject({
        code: "memory_admission_settings_changed",
        retryable: true
      });
    });
  });

  it("binds a committed save receipt to the run authorization and persisted first-party call", async () => {
    await withPreparingUser(async ({ userId }) => {
      const chat = await prisma.chat.create({ data: { title: "Run Memory save", userId } });
      const source = "Remember that I like tea";
      const actionPlan = planMemoryActionFromText(source);
      if (actionPlan.kind !== "SAVE") throw new Error("invalid_memory_action_fixture");
      const baseRequest = normalizedRequest(chat.id, source);
      const request: NormalizedRunRequest = {
        ...baseRequest,
        memoryActionPlan: actionPlan,
        modelCapabilities: {
          ...baseRequest.modelCapabilities,
          toolCalling: true
        }
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
          arguments: { statement: actionPlan.statement },
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
        }
      });

      const result = await executor.execute(actionPlan, {
        arguments: { statement: actionPlan.statement },
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
    });
  });

  it("freezes exact selected item evidence and rejects changed scope evidence or version authority", async () => {
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
      expect(binding).toMatchObject({ outcome: "USED" });
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
      const forgottenAt = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.memoryFactVersion.update({
          data: { state: "RETRACTED", systemTo: forgottenAt },
          where: { id: fact.versionId }
        });
        await tx.memoryFact.update({
          data: {
            currentVersionId: null,
            forgottenAt,
            state: "FORGOTTEN"
          },
          where: { id: fact.factId }
        });
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
