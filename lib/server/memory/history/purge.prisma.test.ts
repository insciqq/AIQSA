import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "./contract";
import { MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION } from "./digest";
import { purgeMemoryHistorySelection } from "./purge";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";

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
          safeTextHash: memorySha256(safeText),
          sourceMessageContentHash: memorySha256(safeText),
          sourceMessageUpdatedAt: userMessage.updatedAt,
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

  it("purges an invalidated tail and digest without deleting a stable v3 prefix", async () => {
    const suffix = randomUUID();
    const userId = `memory-history-tail-purge-${suffix}`;
    try {
      await prisma.user.create({
        data: {
          displayName: "Memory stable tail purge fixture",
          email: `memory-history-tail-purge-${suffix}@example.test`,
          id: userId,
          status: "active"
        }
      });
      const chat = await prisma.chat.create({
        data: {
          memorySourceRevision: 2,
          title: "Stable prefix purge fixture",
          userId
        }
      });
      const message = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("The stable deployment decision."),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: message.id },
        where: { id: chat.id }
      });
      const sourceHash = memorySha256({ chatId: chat.id, revision: 2 });
      await prisma.$transaction(async (tx) => {
        await tx.chatMemoryCheckpoint.create({
          data: {
            activeLeafMessageId: message.id,
            branchGeneration: 0,
            chatId: chat.id,
            lastIndexedMessageId: message.id,
            lastSucceededAt: new Date(),
            pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
            sourceContentHash: sourceHash,
            sourceRevision: 2,
            status: "READY",
            userId
          }
        });
        await tx.chatMemoryCheckpointMessage.create({
          data: {
            chatId: chat.id,
            messageId: message.id,
            ordinal: 0,
            sourceMessageCreatedAt: message.createdAt,
            sourceMessageUpdatedAt: message.updatedAt,
            userId
          }
        });
      });
      const stableText = "User:\nThe stable deployment decision.";
      const invalidatedText = "Assistant:\nThe changed deployment tail.";
      const stableChunkId = randomUUID();
      const invalidatedChunkId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.memoryRecallChunk.create({
          data: {
            branchGeneration: 0,
            chatId: chat.id,
            chunkOrdinal: 0,
            chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
            contentHash: memorySha256(stableText),
            id: stableChunkId,
            languageCode: "en",
            normalizedSafeSearchText: normalizeMemorySearchText(stableText),
            occurredFrom: message.createdAt,
            occurredTo: message.createdAt,
            redactionState: "NOT_NEEDED",
            safeProjectedText: stableText,
            safetyClass: "NORMAL",
            sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
            sourceRevisionAtCreation: 1,
            state: "ACTIVE",
            userId
          }
        });
        await tx.memoryRecallChunkMessage.create({
          data: {
            chatId: chat.id,
            chunkId: stableChunkId,
            messageId: message.id,
            ordinal: 0,
            role: "user",
            safeTextHash: memorySha256(stableText),
            sourceMessageContentHash: memorySha256("The stable deployment decision."),
            sourceMessageUpdatedAt: message.updatedAt,
            userId
          }
        });
      });
      await prisma.memoryRecallChunk.create({
        data: {
          branchGeneration: 0,
          chatId: chat.id,
          chunkOrdinal: 1,
          chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
          contentHash: memorySha256(invalidatedText),
          id: invalidatedChunkId,
          invalidatedAt: new Date(),
          languageCode: "en",
          normalizedSafeSearchText: normalizeMemorySearchText(invalidatedText),
          occurredFrom: message.createdAt,
          occurredTo: message.createdAt,
          redactionState: "NOT_NEEDED",
          safeProjectedText: invalidatedText,
          safetyClass: "NORMAL",
          sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
          sourceRevisionAtCreation: 1,
          state: "INVALIDATED",
          userId
        }
      });
      const digestId = randomUUID();
      await prisma.chatMemoryDigest.create({
        data: {
          activeLeafMessageId: message.id,
          anchorChunkId: stableChunkId,
          branchGeneration: 0,
          chatId: chat.id,
          contentHash: memorySha256("invalidated digest"),
          id: digestId,
          incrementalDepth: 0,
          inputFingerprint: memorySha256({ digestId, input: "invalidated" }),
          invalidatedAt: new Date(),
          languageCode: "en",
          normalizedSafeSearchText: "invalidated digest",
          occurredFrom: message.createdAt,
          occurredTo: message.createdAt,
          pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
          rebuildPolicyVersion: MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION,
          redactionState: "NOT_NEEDED",
          safeDigestText: "Summary: Invalidated deployment digest.",
          safetyClass: "NORMAL",
          safetyPolicyVersion: "memory-chat-digest-policy-test",
          sourceContentHash: memorySha256({ chatId: chat.id, revision: 1 }),
          sourceFingerprint: memorySha256({ digestId, source: "invalidated" }),
          sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
          sourceRevisionAtCreation: 1,
          state: "INVALIDATED",
          summary: "Invalidated deployment digest.",
          updateMode: "FULL_REBUILD",
          userId
        }
      });

      await prisma.$transaction((tx) => purgeMemoryHistorySelection(
        tx,
        userId,
        { chatId: chat.id, kind: "SOURCE" }
      ));

      await expect(prisma.memoryRecallChunk.findUnique({
        where: { id: stableChunkId }
      })).resolves.toMatchObject({ state: "ACTIVE" });
      await expect(prisma.memoryRecallChunk.findUnique({
        where: { id: invalidatedChunkId }
      })).resolves.toBeNull();
      await expect(prisma.chatMemoryDigest.findUnique({
        where: { id: digestId }
      })).resolves.toBeNull();
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
