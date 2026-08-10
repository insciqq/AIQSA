import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import type { NormalizedRunRequest } from "../providers/types";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { createPrismaShareRepository } from "../shares/prismaRepository";
import { createMemoryStorageAdapter } from "../uploads/storage";
import { MemoryCoordinator } from "./coordinator/coordinator";
import { createPrismaMemoryCoordinatorRepository } from "./coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from "./coordinator/registry";
import { createPrismaTemporaryChatDeletionHandler } from "./temporaryDeletion";

function request(chatId: string, text: string): NormalizedRunRequest {
  const content = textMessageContent(text);
  return {
    attachmentIds: [],
    chatId,
    content,
    context: {
      messages: [{ content, id: `context-${randomUUID()}`, role: "user" }],
      mode: "branch_path"
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: true,
      vision: false
    },
    modelId: providerTemplateIds.fakeModel,
    params: {},
    prompt: { developer: null, system: null },
    provider: providerTemplateIds.fakeConnection,
    searchStrategy: "search-disabled",
    toolMode: "auto"
  };
}

describe("Temporary chat retention", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admits once, bypasses personal Memory, and durably deletes the whole aggregate", async () => {
    const suffix = randomUUID();
    const userId = `temporary-owner-${suffix}`;
    const otherUserId = `temporary-other-${suffix}`;
    const storage = createMemoryStorageAdapter();
    await prisma.user.createMany({
      data: [
        {
          displayName: "Temporary owner",
          email: `temporary-owner-${suffix}@example.test`,
          id: userId,
          status: "active"
        },
        {
          displayName: "Temporary other",
          email: `temporary-other-${suffix}@example.test`,
          id: otherUserId,
          status: "active"
        }
      ]
    });
    const initialMemorySettings = await prisma.userMemorySettings.findUniqueOrThrow({
      select: {
        activeIndexGenerationId: true,
        learnAutomatically: true,
        memoryConsentRevision: true,
        memoryGeneration: true,
        memoryRevision: true,
        referenceChatHistory: true,
        settingsRevision: true,
        useMemoryFacts: true
      },
      where: { userId }
    });

    try {
      const chat = await prisma.chat.create({
        data: { title: "Temporary", userId }
      });
      const runs = createPrismaRunRepository(prisma);
      const firstRequest = request(chat.id, "First temporary question");
      const first = await runs.createRun({
        chatId: chat.id,
        content: firstRequest.content,
        expectedActiveLeafId: null,
        initialChatMode: {
          chatMode: "TEMPORARY",
          temporaryRetentionPolicyVersion: "temporary-24h-v1"
        },
        modelId: firstRequest.modelId,
        normalizedRequest: firstRequest,
        provider: firstRequest.provider,
        providerRequestPreview: {},
        userId
      });
      const admitted = await prisma.chat.findUniqueOrThrow({
        select: {
          createdAt: true,
          memoryBranchGeneration: true,
          memoryMode: true,
          memorySourceRevision: true,
          temporaryRetentionDeadline: true,
          temporaryRetentionPolicyVersion: true
        },
        where: { id: chat.id }
      });
      const firstDeadline = admitted.temporaryRetentionDeadline;
      expect(admitted).toMatchObject({
        memoryBranchGeneration: 0,
        memoryMode: "TEMPORARY",
        memorySourceRevision: 0,
        temporaryRetentionPolicyVersion: "temporary-24h-v1"
      });
      expect(firstDeadline).not.toBeNull();
      await expect(prisma.memoryDeletionOutbox.count({
        where: {
          operation: "TEMPORARY_DELETE",
          targetId: chat.id,
          targetType: "TEMPORARY_CHAT@temporary-24h-v1",
          userId
        }
      })).resolves.toBe(1);
      await expect(prisma.memoryRetrievalAttempt.findFirstOrThrow({
        where: { modelRunId: first.runId, userId }
      })).resolves.toMatchObject({
        chatMemoryModeSnapshot: "TEMPORARY",
        outcome: "DISABLED",
        state: "CONSUMED"
      });
      await expect(prisma.modelRunMemoryBinding.findUniqueOrThrow({
        where: { modelRunId: first.runId }
      })).resolves.toMatchObject({
        contextTokenCount: 0,
        finalizedRevisionSnapshot: 0,
        indexGenerationId: null,
        memoryGenerationSnapshot: 0,
        outcome: "DISABLED",
        retrievalRevisionSnapshot: 0,
        userId
      });
      await expect(prisma.modelRunMemoryItem.count({
        where: { userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: { chatId: chat.id, userId }
      })).resolves.toBe(0);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        select: {
          activeIndexGenerationId: true,
          learnAutomatically: true,
          memoryConsentRevision: true,
          memoryGeneration: true,
          memoryRevision: true,
          referenceChatHistory: true,
          settingsRevision: true,
          useMemoryFacts: true
        },
        where: { userId }
      })).resolves.toEqual(initialMemorySettings);
      const chats = createPrismaChatRepository(prisma);
      await expect(chats.listWorkspace(userId)).resolves.toMatchObject({ chats: [] });
      await expect(chats.searchChatContent({
        limit: 10,
        query: "temporary",
        userId
      })).resolves.toEqual([]);
      await expect(chats.archiveChat({ chatId: chat.id, userId })).resolves.toBe(false);
      const shares = createPrismaShareRepository(prisma);
      await expect(shares.createChatShare({
        activeLeafMessageId: first.assistantMessageId,
        chatId: chat.id,
        shareToken: "temporary-token",
        slugHash: `temporary-rejected-${suffix}`,
        userId
      })).resolves.toBeNull();

      await expect(runs.failRun(
        first.runId,
        first.assistantMessageId,
        { code: "test_terminal", message: "Settled for retention." }
      )).resolves.toBe(true);
      const terminalDeadline = await prisma.chat.findUniqueOrThrow({
        select: { temporaryRetentionDeadline: true },
        where: { id: chat.id }
      });
      expect(terminalDeadline.temporaryRetentionDeadline!.getTime())
        .toBeGreaterThanOrEqual(firstDeadline!.getTime());

      const expiredDeadline = new Date(admitted.createdAt.getTime() + 1);
      await prisma.$transaction(async (tx) => {
        await tx.chat.update({
          data: { temporaryRetentionDeadline: expiredDeadline },
          where: { id: chat.id }
        });
        await tx.memoryDeletionOutbox.updateMany({
          data: { nextAttemptAt: expiredDeadline },
          where: { operation: "TEMPORARY_DELETE", targetId: chat.id, userId }
        });
      });
      const expiredRequest = request(chat.id, "Too late for another run");
      await expect(runs.createRun({
        chatId: chat.id,
        content: expiredRequest.content,
        expectedActiveLeafId: first.assistantMessageId,
        modelId: expiredRequest.modelId,
        normalizedRequest: expiredRequest,
        provider: expiredRequest.provider,
        providerRequestPreview: {},
        userId
      })).rejects.toMatchObject({ code: "memory_temporary_chat_expired" });
      const continuedTestDeadline = new Date(Date.now() + 86_400_000);
      await prisma.$transaction(async (tx) => {
        await tx.chat.update({
          data: { temporaryRetentionDeadline: continuedTestDeadline },
          where: { id: chat.id }
        });
        await tx.memoryDeletionOutbox.updateMany({
          data: { nextAttemptAt: continuedTestDeadline },
          where: { operation: "TEMPORARY_DELETE", targetId: chat.id, userId }
        });
      });

      const secondRequest = request(chat.id, "Stuck temporary question");
      const second = await runs.admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: secondRequest.content,
        expectedActiveLeafId: first.assistantMessageId,
        modelId: secondRequest.modelId,
        normalizedRequest: secondRequest,
        provider: secondRequest.provider,
        providerRequestPreview: {},
        userId
      });
      await expect(prisma.chat.findUniqueOrThrow({
        select: { memoryBranchGeneration: true, memorySourceRevision: true },
        where: { id: chat.id }
      })).resolves.toEqual({
        memoryBranchGeneration: 0,
        memorySourceRevision: 0
      });
      const exclusiveKey = `temporary/${suffix}/exclusive.bin`;
      const sharedKey = `temporary/${suffix}/shared.bin`;
      await storage.putObject({
        body: Buffer.from("exclusive"),
        contentType: "application/octet-stream",
        storageKey: exclusiveKey
      });
      await storage.putObject({
        body: Buffer.from("shared"),
        contentType: "application/octet-stream",
        storageKey: sharedKey
      });
      await prisma.attachment.createMany({
        data: [
          {
            byteSize: 9,
            chatId: chat.id,
            fileName: "exclusive.bin",
            kind: "file",
            metadata: {},
            mimeType: "application/octet-stream",
            status: "ready",
            storageKey: exclusiveKey,
            userId
          },
          {
            byteSize: 6,
            chatId: chat.id,
            fileName: "shared.bin",
            kind: "file",
            metadata: {},
            mimeType: "application/octet-stream",
            status: "ready",
            storageKey: sharedKey,
            userId
          },
          {
            byteSize: 6,
            fileName: "shared-other.bin",
            kind: "file",
            metadata: {},
            mimeType: "application/octet-stream",
            status: "ready",
            storageKey: sharedKey,
            userId: otherUserId
          }
        ]
      });
      await prisma.attachmentDeletionJob.create({
        data: { storageKey: sharedKey }
      });
      await prisma.searchRun.create({
        data: {
          artifacts: {},
          modelRunId: second.runId,
          provider: "fake-search",
          requestPreview: {},
          status: "complete",
          strategyId: "temporary-test"
        }
      });
      await prisma.modelRunToolCall.create({
        data: {
          arguments: {},
          modelRunId: second.runId,
          ordinal: 0,
          providerCallId: `temporary-call-${suffix}`,
          roundIndex: 0,
          startedAt: new Date(),
          state: "running",
          toolName: "temporary_tool"
        }
      });
      await prisma.sharedChatSnapshot.create({
        data: {
          chatId: chat.id,
          ownerUserId: userId,
          slugHash: `temporary-share-${suffix}`,
          snapshot: { messages: [], version: 1 },
          title: "Must disappear"
        }
      });
      await expect(shares.findPublicShare(`temporary-share-${suffix}`, new Date()))
        .resolves.toBeNull();
      await expect(shares.listChatShares({
        chatId: chat.id,
        now: new Date(),
        userId
      })).resolves.toEqual([]);
      await prisma.usageEvent.create({
        data: {
          chatId: chat.id,
          modelId: secondRequest.modelId,
          modelRunId: second.runId,
          provider: secondRequest.provider,
          userId
        }
      });
      const corruptedEvent = await prisma.memoryEvent.create({
        data: {
          actorType: "JOB",
          metadata: {},
          operation: "AUTO_PROPOSE",
          sourceChatId: chat.id,
          userId
        }
      });

      const deletionNow = new Date(Date.now() + 48 * 60 * 60 * 1_000);
      const dueAt = new Date(deletionNow.getTime() - 60_000);
      await prisma.$transaction(async (tx) => {
        await tx.chat.update({
          data: { temporaryRetentionDeadline: dueAt },
          where: { id: chat.id }
        });
        await tx.memoryDeletionOutbox.updateMany({
          data: { nextAttemptAt: dueAt, state: "PENDING" },
          where: {
            operation: "TEMPORARY_DELETE",
            targetId: chat.id,
            userId
          }
        });
      });

      const registry = new MemoryCoordinatorRegistry();
      let failObjectDelete = true;
      registry.registerDeletion(
        createPrismaTemporaryChatDeletionHandler({
          async deleteObject(storageKey) {
            if (failObjectDelete) {
              failObjectDelete = false;
              throw new Error("injected_object_delete_failure");
            }
            await storage.deleteObject(storageKey);
          }
        }, prisma)
      );
      const coordinator = new MemoryCoordinator({
        now: () => deletionNow,
        policy: {
          blockedDeletionRetryMs: 60_000,
          maxDeletionFastAttempts: 1
        },
        registry,
        repository: createPrismaMemoryCoordinatorRepository(prisma)
      });
      await coordinator.reconcileNow();
      await expect(prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "TEMPORARY_DELETE", targetId: chat.id, userId }
      })).resolves.toMatchObject({
        errorCode: "memory_temporary_reusable_source_detected",
        state: "BLOCKED_REQUIRES_ADMIN"
      });
      await expect(prisma.chat.count({ where: { id: chat.id } })).resolves.toBe(1);
      await prisma.$transaction(async (tx) => {
        await tx.memoryEvent.delete({ where: { id: corruptedEvent.id } });
        await tx.memoryDeletionOutbox.updateMany({
          data: { nextAttemptAt: deletionNow },
          where: { operation: "TEMPORARY_DELETE", targetId: chat.id, userId }
        });
      });
      await coordinator.reconcileNow();
      await expect(prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "TEMPORARY_DELETE", targetId: chat.id, userId }
      })).resolves.toMatchObject({
        errorCode: "memory_temporary_object_delete_failed",
        state: "BLOCKED_REQUIRES_ADMIN"
      });
      await expect(prisma.modelRun.findUniqueOrThrow({
        where: { id: second.runId }
      })).resolves.toMatchObject({ status: "error" });
      await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
        where: { id: second.attemptId }
      })).resolves.toMatchObject({
        errorCode: "memory_temporary_retention_expired",
        state: "CANCELLED"
      });
      await expect(prisma.modelRunToolCall.findFirstOrThrow({
        where: { modelRunId: second.runId }
      })).resolves.toMatchObject({ state: "error" });
      expect(storage.objects.has(exclusiveKey)).toBe(true);
      await prisma.memoryDeletionOutbox.updateMany({
        data: { nextAttemptAt: deletionNow },
        where: { operation: "TEMPORARY_DELETE", targetId: chat.id, userId }
      });
      await coordinator.reconcileNow();

      await expect(prisma.chat.count({ where: { id: chat.id } })).resolves.toBe(0);
      await expect(prisma.message.count({ where: { chatId: chat.id } })).resolves.toBe(0);
      await expect(prisma.modelRun.count({ where: { chatId: chat.id } })).resolves.toBe(0);
      await expect(prisma.searchRun.count({ where: { modelRunId: second.runId } }))
        .resolves.toBe(0);
      await expect(prisma.modelRunToolCall.count({ where: { modelRunId: second.runId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryRetrievalAttempt.count({ where: { chatId: chat.id } }))
        .resolves.toBe(0);
      await expect(prisma.attachment.count({ where: { chatId: chat.id } }))
        .resolves.toBe(0);
      await expect(prisma.sharedChatSnapshot.count({ where: { chatId: chat.id } }))
        .resolves.toBe(0);
      await expect(prisma.usageEvent.count({ where: { chatId: chat.id } }))
        .resolves.toBe(0);
      await expect(prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "TEMPORARY_DELETE", targetId: chat.id, userId }
      })).resolves.toMatchObject({ state: "SUCCEEDED" });
      expect(storage.objects.has(exclusiveKey)).toBe(false);
      expect(storage.objects.has(sharedKey)).toBe(true);
      await expect(prisma.attachment.count({
        where: { storageKey: sharedKey, userId: otherUserId }
      })).resolves.toBe(1);
      await expect(prisma.attachmentDeletionJob.findUnique({
        where: { storageKey: sharedKey }
      })).resolves.not.toBeNull();
    } finally {
      await prisma.$transaction(async (tx) => {
        const chatCount = await tx.chat.count({ where: { userId } });
        if (chatCount > 0) {
          await tx.memoryDeletionOutbox.updateMany({
            data: {
              completedAt: null,
              leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
              leaseToken: "temporary-test-cleanup",
              nextAttemptAt: null,
              state: "RUNNING"
            },
            where: { operation: "TEMPORARY_DELETE", userId }
          });
          await tx.chat.deleteMany({ where: { userId } });
        }
        await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
        await tx.attachmentDeletionJob.deleteMany({
          where: { storageKey: { startsWith: `temporary/${suffix}/` } }
        });
        await tx.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      });
    }
  });
});
