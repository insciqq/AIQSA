import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { purgeMemoryHistorySelection } from "./purge";

describe("Prisma Memory history purge", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("scrubs selected history while preserving a finalized attempt as CONSUMED", async () => {
    const suffix = randomUUID();
    const userId = `memory-history-purge-${suffix}`;
    try {
      await prisma.user.create({
        data: {
          displayName: "Memory history purge fixture",
          email: `memory-history-purge-${suffix}@example.test`,
          id: userId,
          status: "active"
        }
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const chat = await prisma.chat.create({
        data: {
          title: "Excluded history purge fixture",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("History source fixture."),
          role: "user"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("History answer fixture."),
          parentMessageId: userMessage.id,
          role: "assistant"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: assistantMessage.id },
        where: { id: chat.id }
      });
      const run = await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId: chat.id,
          modelId: "memory-history-purge-model",
          normalizedRequest: {},
          provider: "memory-history-purge-provider",
          status: "complete",
          userId,
          userMessageId: userMessage.id
        }
      });
      const safeText = "[user] History source fixture.";
      const contentHash = memorySha256(safeText);
      const chunk = await prisma.memoryRecallChunk.create({
        data: {
          branchGeneration: 0,
          chatId: chat.id,
          chunkOrdinal: 0,
          chunkingVersion: "memory-history-chunking-v3",
          contentHash,
          languageCode: "en",
          normalizedSafeSearchText: normalizeMemorySearchText(safeText),
          occurredFrom: new Date("2026-08-20T10:00:00.000Z"),
          occurredTo: new Date("2026-08-20T10:01:00.000Z"),
          redactionState: "NOT_NEEDED",
          safeProjectedText: safeText,
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-history-source-projection-v3",
          sourceRevisionAtCreation: 0,
          state: "INVALIDATED",
          invalidatedAt: new Date("2026-08-20T10:01:30.000Z"),
          userId
        }
      });
      await prisma.memoryRecallChunkMessage.create({
        data: {
          chatId: chat.id,
          chunkId: chunk.id,
          messageId: userMessage.id,
          ordinal: 0,
          role: "user",
          userId
        }
      });
      const preparedContext = `Relevant prior conversation:\n${safeText}`;
      const attempt = await prisma.$transaction(async (tx) => {
        const value = await tx.memoryRetrievalAttempt.create({
          data: {
            admissionKind: "NORMAL_SEND",
            admittedAssistantLeafMessageId: assistantMessage.id,
            admittedUserMessageId: userMessage.id,
            attemptOrdinal: 0,
            baseRequestHash: memorySha256("history-purge-base"),
            boundedPrivateBaseRequestSnapshot: {},
            chatId: chat.id,
            chatMemoryModeSnapshot: "NORMAL",
            consumedAt: new Date("2026-08-20T10:02:00.000Z"),
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            memoryGenerationSnapshot: settings.memoryGeneration,
            modelRunId: run.id,
            outcome: "USED",
            preparedContextHash: memorySha256(preparedContext),
            preparedContextText: preparedContext,
            preparedContextTokenCount: 8,
            queryHash: memorySha256("history source"),
            retrievalRevisionSnapshot: settings.memoryRevision,
            settingsSnapshot: {},
            state: "CONSUMED",
            userId,
            utilityEgressMode: "LOCAL_ONLY"
          }
        });
        await tx.modelRunMemoryBinding.create({
          data: {
            contextTextHash: memorySha256(preparedContext),
            contextTokenCount: 8,
            finalizedAt: new Date("2026-08-20T10:02:00.000Z"),
            finalizedRevisionSnapshot: settings.memoryRevision,
            memoryGenerationSnapshot: settings.memoryGeneration,
            modelRunId: run.id,
            outcome: "USED",
            queryHash: memorySha256("history source"),
            queryPlannerVersion: "history-purge-fixture-v1",
            retrievalAttemptId: value.id,
            retrievalPipelineVersion: "history-purge-fixture-v1",
            retrievalRevisionSnapshot: settings.memoryRevision,
            settingsSnapshot: {},
            userId
          }
        });
        return value;
      });
      await prisma.memoryRetrievalAttemptItem.create({
        data: {
          attemptId: attempt.id,
          exactItemId: chunk.id,
          exactSafeText: safeText,
          featureSnapshot: {},
          itemType: "RECALL_CHUNK",
          laneRanks: {},
          ordinal: 0,
          recallChunkId: chunk.id,
          selectionReason: "history-purge-fixture",
          sourceBranchGenerationSnapshot: chunk.branchGeneration,
          sourceChatIdSnapshot: chat.id,
          sourceContentHashSnapshot: chunk.contentHash,
          sourceRevisionSnapshot: chunk.sourceRevisionAtCreation,
          sourceSnapshot: { sourceMessageIds: [userMessage.id] },
          textHash: memorySha256(safeText),
          userId,
          versionSnapshot: {}
        }
      });

      await prisma.$transaction((tx) => purgeMemoryHistorySelection(
        tx,
        userId,
        { chatId: chat.id, kind: "SOURCE" }
      ));

      await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
        where: { id: attempt.id }
      })).resolves.toMatchObject({
        consumedAt: new Date("2026-08-20T10:02:00.000Z"),
        errorCode: "memory_source_stale",
        outcome: "USED",
        preparedContextHash: memorySha256(""),
        preparedContextText: "",
        preparedContextTokenCount: 0,
        state: "CONSUMED"
      });
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: attempt.id }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.count({
        where: { id: chunk.id }
      })).resolves.toBe(0);
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
