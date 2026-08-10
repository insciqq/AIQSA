import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import type { NormalizedRunRequest } from "../providers/types";
import { MemorySuppressionKeyring } from "../memory/suppressionKeyring";
import { createPrismaMemoryFactRepository } from "../memory/persistence/facts";
import { createPrismaMemoryScopeRepository } from "../memory/persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../memory/persistence/settings";
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

function normalizedRequest(chatId: string): NormalizedRunRequest {
  const content = textMessageContent("Remember this preparation boundary.");
  return {
    attachmentIds: [],
    chatId,
    content,
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

  it("allows exactly one fresh attempt after settings drift", async () => {
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
        data: { settingsRevision: { increment: 1 } },
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

  it("freezes exact selected item evidence and rejects a stale authoritative version", async () => {
    await withPreparingUser(async ({ userId }) => {
      await createPrismaMemorySettingsRepository(prisma).patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        useMemoryFacts: true
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const fact = await createPrismaMemoryFactRepository(suppressionKeyring, prisma).save(
        userId,
        {
          evidence: {
            kind: "EXPLICIT_ACTION",
            observedAt: new Date("2026-08-10T12:00:00.000Z"),
            safeExcerpt: "My preferred editor is Vim.",
            safeSourceHash: "a".repeat(64),
            safetyClass: "NORMAL",
            sourceProjectionVersion: "preparing-run-test-v1"
          },
          explicitSuppressionOverride: false,
          idempotencyFingerprint: `preparing-fact-${randomUUID()}`,
          requestId: `preparing-fact-request-${randomUUID()}`,
          scopeId: scope.id,
          value: {
            canonicalKey: "profile.preferred_editor",
            category: "profile",
            confidence: 1,
            directness: "DIRECT",
            displayText: "My preferred editor is Vim.",
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

      const stale = await createStagedRun("Stale item");
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
