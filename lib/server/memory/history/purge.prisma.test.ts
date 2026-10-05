import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { RUN_PREPARATION_FAILURE_MESSAGE } from "../../../contracts/runs";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { DEFAULT_MEMORY_COORDINATOR_POLICY } from "../coordinator/policy";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryDeletionClaim } from "../coordinator/types";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "./contract";
import { MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION } from "./digest";
import {
  inspectMemoryHistoryPurge,
  MEMORY_HISTORY_SOURCE_TARGET_TYPE,
  memoryHistorySourceDeletionHandler,
  purgeMemoryHistorySelection
} from "./purge";
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
      const { attempt, binding } = await prisma.$transaction(async (tx) => {
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
        const createdBinding = await tx.modelRunMemoryBinding.create({
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
        return { attempt: value, binding: createdBinding };
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
      const roundText = "User: History source fixture.";
      const round = await prisma.memoryRecallRound.create({
        data: {
          branchGeneration: 0,
          chatId: chat.id,
          contentHash: memorySha256(roundText),
          contextualKeyPolicyVersion: "history-purge-fixture-v1",
          contextualKeyState: "RAW_FALLBACK",
          contextualNarrativeText: roundText,
          contextualSearchHash: memorySha256(roundText),
          contextualSearchText: roundText,
          evidenceRootHash: memorySha256({ messageId: userMessage.id }),
          groupKind: "STANDALONE",
          id: randomUUID(),
          invalidatedAt: new Date("2026-08-20T10:01:30.000Z"),
          languageCode: "en",
          occurredFrom: new Date("2026-08-20T10:00:00.000Z"),
          occurredTo: new Date("2026-08-20T10:00:00.000Z"),
          parentChunkId: chunk.id,
          projectionVersion: "history-purge-fixture-v1",
          rawSafeText: roundText,
          redactionState: "NOT_NEEDED",
          roundOrdinal: 0,
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-history-source-projection-v3",
          sourceRevisionAtCreation: 0,
          state: "INVALIDATED",
          userId
        }
      });
      const segment = await prisma.memoryRecallRoundSegment.create({
        data: {
          approxTokens: 6,
          chatId: chat.id,
          contextualKeyPolicyVersion: "history-purge-fixture-v1",
          contextualKeyState: "RAW_FALLBACK",
          contextualNarrativeText: "",
          contextualSearchHash: memorySha256(roundText),
          contextualSearchText: roundText,
          evidenceRootHash: round.evidenceRootHash,
          id: randomUUID(),
          invalidatedAt: new Date("2026-08-20T10:01:30.000Z"),
          languageCode: "en",
          occurredFrom: round.occurredFrom,
          occurredTo: round.occurredTo,
          position: "SINGLE",
          projectionVersion: "history-purge-segment-fixture-v1",
          rawEndOffsetUtf16: roundText.length,
          rawSafeText: roundText,
          rawSafeTextHash: memorySha256(roundText),
          rawStartOffsetUtf16: 0,
          redactionState: "NOT_NEEDED",
          roundId: round.id,
          safetyClass: "NORMAL",
          segmentOrdinal: 0,
          sourceRevisionAtCreation: 0,
          state: "INVALIDATED",
          userId
        }
      });
      const frozenItem = await prisma.modelRunMemoryItem.create({
        data: {
          bindingId: binding.id,
          exactItemId: round.id,
          featureSnapshot: {},
          finalScore: 0.9,
          includedText: roundText,
          includedTextHash: memorySha256(roundText),
          itemStateAtAdmission: "ACTIVE",
          itemType: "RECALL_ROUND",
          laneRanks: {},
          ordinal: 0,
          recallRoundId: round.id,
          recallRoundSegmentId: segment.id,
          selectionReason: "history-purge-fixture",
          sourceBranchGenerationSnapshot: 0,
          sourceChatIdSnapshot: chat.id,
          sourceContentHashSnapshot: round.contentHash,
          sourceMessageIdsSnapshot: [userMessage.id],
          sourceRevisionSnapshot: 0,
          userId
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
      await expect(prisma.modelRunMemoryItem.findUniqueOrThrow({
        where: { id: frozenItem.id }
      })).resolves.toMatchObject({
        recallRoundId: null,
        recallRoundSegmentId: null
      });
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("ends a preparing run whose live attempt selected cleared history with neutral text", async () => {
    const suffix = randomUUID();
    const userId = `memory-history-purge-preparing-${suffix}`;
    try {
      await prisma.user.create({
        data: {
          displayName: "Memory history purge preparing fixture",
          email: `memory-history-purge-preparing-${suffix}@example.test`,
          id: userId,
          status: "active"
        }
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const chat = await prisma.chat.create({
        data: { title: "Preparing history purge fixture", userId }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Preparing source fixture."),
          role: "user"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent(""),
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "streaming"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: assistantMessage.id },
        where: { id: chat.id }
      });
      const safeText = "[user] Preparing source fixture.";
      const chunk = await prisma.memoryRecallChunk.create({
        data: {
          branchGeneration: 0,
          chatId: chat.id,
          chunkOrdinal: 0,
          chunkingVersion: "memory-history-chunking-v3",
          contentHash: memorySha256(safeText),
          invalidatedAt: new Date("2026-08-20T10:01:30.000Z"),
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
          userId
        }
      });
      const preparedContext = `Relevant prior conversation:\n${safeText}`;
      // A preparing run needs its live attempt in the same transaction.
      const { attempt, run } = await prisma.$transaction(async (tx) => {
        const createdRun = await tx.modelRun.create({
          data: {
            assistantMessageId: assistantMessage.id,
            chatId: chat.id,
            modelId: "memory-history-purge-model",
            provider: "memory-history-purge-provider",
            status: "preparing",
            userId,
            userMessageId: userMessage.id
          }
        });
        const createdAttempt = await tx.memoryRetrievalAttempt.create({
          data: {
            admissionKind: "NORMAL_SEND",
            admittedAssistantLeafMessageId: assistantMessage.id,
            admittedUserMessageId: userMessage.id,
            attemptOrdinal: 0,
            baseRequestHash: memorySha256("history-purge-preparing-base"),
            boundedPrivateBaseRequestSnapshot: { normalizedRequest: { fixture: "preparing" } },
            chatId: chat.id,
            chatMemoryModeSnapshot: "NORMAL",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            memoryGenerationSnapshot: settings.memoryGeneration,
            modelRunId: createdRun.id,
            outcome: "USED",
            preparedContextHash: memorySha256(preparedContext),
            preparedContextText: preparedContext,
            preparedContextTokenCount: 8,
            queryHash: memorySha256("preparing history source"),
            retrievalRevisionSnapshot: settings.memoryRevision,
            settingsSnapshot: {},
            state: "READY",
            userId,
            utilityEgressMode: "LOCAL_ONLY"
          }
        });
        return { attempt: createdAttempt, run: createdRun };
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
          selectionReason: "history-purge-preparing-fixture",
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
        consumedAt: null,
        errorCode: "memory_source_stale",
        preparedContextText: null,
        state: "STALE"
      });
      await expect(prisma.modelRun.findUniqueOrThrow({
        where: { id: run.id }
      })).resolves.toMatchObject({
        errorPayload: {
          code: "memory_source_stale",
          message: RUN_PREPARATION_FAILURE_MESSAGE
        },
        normalizedRequest: { fixture: "preparing" },
        status: "error"
      });
      await expect(prisma.message.findUniqueOrThrow({
        where: { id: assistantMessage.id }
      })).resolves.toMatchObject({
        errorMessage: RUN_PREPARATION_FAILURE_MESSAGE,
        status: "error"
      });
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

  // Content-free regression for the history source purge that ran past
  // Prisma's former 5s default: thousands of retained owner receipts across
  // several sources, a long chat whose stable prefix stays ACTIVE and whose
  // edited tail is purged. It records phase timings and plan summaries
  // (counts, node types, schema names, milliseconds) for the operator.
  it("purges one source of a large owner history inside the bounded deletion commit", async () => {
    const suffix = randomUUID();
    const userId = `memory-history-large-purge-${suffix}`;
    const probe = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    const statements: ProbeStatement[] = [];
    let recording = false;
    probe.$on("query", (event) => {
      if (recording) {
        statements.push({ durationMs: event.duration, params: event.params, query: event.query });
      }
    });
    try {
      const fixtureStarted = performance.now();
      await prisma.user.create({
        data: {
          displayName: "Memory large source purge fixture",
          email: `${userId}@example.test`,
          id: userId,
          status: "active"
        }
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const target = await createHistoryChat(userId, "Large purge target", {
        branchMessages: LARGE_PURGE_SHAPE.targetBranchMessages,
        prefixMessages: LARGE_PURGE_SHAPE.targetPrefixMessages,
        staleTailMessages: LARGE_PURGE_SHAPE.targetStaleTailMessages
      });
      const others: HistoryChatFixture[] = [];
      for (let index = 0; index < LARGE_PURGE_SHAPE.otherSources; index += 1) {
        others.push(await createHistoryChat(userId, `Large purge source ${index}`, {
          branchMessages: 0,
          prefixMessages: LARGE_PURGE_SHAPE.otherSourceMessages,
          staleTailMessages: 0
        }));
      }
      const receipts = await createSearchReceipts({
        citeTargetEvery: LARGE_PURGE_SHAPE.receiptsCitingTargetEvery,
        count: LARGE_PURGE_SHAPE.receipts,
        memoryGeneration: settings.memoryGeneration,
        otherChatIds: others.map(({ chatId }) => chatId),
        targetChatId: target.chatId,
        userId
      });
      const fixtureMs = performance.now() - fixtureStarted;

      const leaseToken = randomUUID();
      const outbox = await prisma.memoryDeletionOutbox.create({
        data: {
          attemptCount: 1,
          leaseExpiresAt: new Date(Date.now() + DEFAULT_MEMORY_COORDINATOR_POLICY.leaseMs),
          leaseToken,
          memoryGeneration: settings.memoryGeneration,
          operation: "SOURCE_PURGE",
          progressAt: new Date(),
          state: "RUNNING",
          targetId: target.chatId,
          targetType: MEMORY_HISTORY_SOURCE_TARGET_TYPE,
          userId
        }
      });
      const claim: MemoryDeletionClaim = {
        admissionAuthorizationId: null,
        admittedActiveLeafMessageId: null,
        admittedChatSourceRevision: null,
        alsoForgetOriginMemories: null,
        attemptCount: 1,
        claimToken: leaseToken,
        id: outbox.id,
        leaseExpiresAt: outbox.leaseExpiresAt!,
        memoryGeneration: settings.memoryGeneration,
        operation: "SOURCE_PURGE",
        recoveredLease: false,
        resumedFromBlocked: true,
        targetId: target.chatId,
        targetType: MEMORY_HISTORY_SOURCE_TARGET_TYPE,
        userId
      };
      const context = { now: () => new Date(), signal: new AbortController().signal };
      const purgeApply = async () => {
        const result = await memoryHistorySourceDeletionHandler.execute(claim, context);
        expect(result.apply).toBeTypeOf("function");
        return result.apply!;
      };

      // Diagnostic probe: the exact handler work plus the deferred source
      // guards (SET CONSTRAINTS ALL IMMEDIATE), rolled back afterwards.
      recording = true;
      const probeStarted = performance.now();
      let deferredConstraintMs = -1;
      await probe.$transaction(async (tx) => {
        await (await purgeApply())(tx, claim);
        const constraintsStarted = performance.now();
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
        deferredConstraintMs = performance.now() - constraintsStarted;
        throw new ProbeRollback();
      }, { maxWait: 10_000, timeout: 300_000 }).catch((error: unknown) => {
        if (!(error instanceof ProbeRollback)) throw error;
      });
      const probeMs = performance.now() - probeStarted;
      recording = false;
      const plans = await explainSlowestStatements(probe, statements, 4);
      await expect(prisma.memoryRecallChunk.count({
        where: { id: { in: [...target.staleChunkIds] } }
      })).resolves.toBe(target.staleChunkIds.length);

      // A competing claim token or an expired lease writes nothing.
      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      await expect(repository.commitDeletionSuccess({
        apply: await purgeApply(),
        claim: { ...claim, claimToken: randomUUID() },
        now: new Date()
      })).resolves.toBe(false);
      await expect(repository.commitDeletionSuccess({
        apply: await purgeApply(),
        claim,
        now: new Date(claim.leaseExpiresAt.getTime() + 1_000)
      })).resolves.toBe(false);
      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: outbox.id } }))
        .resolves.toMatchObject({ leaseToken, state: "RUNNING" });
      await expect(prisma.memoryHistoryRun.count({
        where: { retentionState: "RETAINED", userId }
      })).resolves.toBe(receipts.total);

      // The owner's heartbeat renews the lease, then the production commit
      // runs under its explicit bound.
      await expect(repository.heartbeatDeletion({
        claim,
        leaseExpiresAt: new Date(Date.now() + DEFAULT_MEMORY_COORDINATOR_POLICY.leaseMs),
        now: new Date()
      })).resolves.toBe(true);
      const apply = await purgeApply();
      const commitStarted = performance.now();
      await expect(repository.commitDeletionSuccess({ apply, claim, now: new Date() }))
        .resolves.toBe(true);
      const commitMs = performance.now() - commitStarted;
      expect(commitMs).toBeLessThan(18_000);

      // The settled lease cannot be renewed or committed again.
      await expect(repository.heartbeatDeletion({
        claim,
        leaseExpiresAt: new Date(Date.now() + DEFAULT_MEMORY_COORDINATOR_POLICY.leaseMs),
        now: new Date()
      })).resolves.toBe(false);
      await expect(repository.commitDeletionSuccess({
        apply: await purgeApply(),
        claim,
        now: new Date()
      })).resolves.toBe(false);

      const settled = await prisma.memoryDeletionOutbox.findUniqueOrThrow({
        where: { id: outbox.id }
      });
      expect(settled).toMatchObject({
        errorCode: null,
        leaseExpiresAt: null,
        leaseToken: null,
        state: "SUCCEEDED"
      });
      expect(settled.completedAt).toBeInstanceOf(Date);
      expect(settled.lastAuditAt).toBeInstanceOf(Date);
      await expect(prisma.memoryRecallChunk.count({
        where: { id: { in: [...target.staleChunkIds] } }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.count({
        where: { id: { in: [...target.activeChunkIds] }, state: "ACTIVE" }
      })).resolves.toBe(target.activeChunkIds.length);
      await expect(prisma.memoryRecallChunkMessage.count({
        where: { chunkId: { in: [...target.activeChunkIds] } }
      })).resolves.toBe(target.activeChunkIds.length * CHUNK_MESSAGES);
      const otherChunkIds = others.flatMap(({ activeChunkIds }) => activeChunkIds);
      await expect(prisma.memoryRecallChunk.count({
        where: { id: { in: otherChunkIds }, state: "ACTIVE" }
      })).resolves.toBe(otherChunkIds.length);
      await expect(prisma.memoryHistoryRun.count({
        where: {
          id: { in: [...receipts.citingTargetIds] },
          plaintextPurgedAt: { not: null },
          results: { equals: Prisma.DbNull },
          retentionState: "SCRUBBED"
        }
      })).resolves.toBe(receipts.citingTargetIds.length);
      await expect(prisma.memoryHistoryRun.count({
        where: {
          id: { notIn: [...receipts.citingTargetIds] },
          retentionState: "RETAINED",
          userId
        }
      })).resolves.toBe(receipts.total - receipts.citingTargetIds.length);
      await expect(prisma.modelRunToolCall.count({
        where: {
          arguments: { equals: {} },
          id: { in: [...receipts.citingTargetToolCallIds] },
          state: "complete"
        }
      })).resolves.toBe(receipts.citingTargetToolCallIds.length);
      await expect(prisma.$transaction((tx) => inspectMemoryHistoryPurge(tx, userId, {
        chatId: target.chatId,
        kind: "SOURCE"
      }), { timeout: 60_000 })).resolves.toMatchObject({ complete: true });

      console.log(JSON.stringify({
        event: "memory_history_source_purge_regression",
        commitBoundMs: 18_000,
        commitMs: Math.round(commitMs),
        deferredConstraintMs: Math.round(deferredConstraintMs),
        fixtureMs: Math.round(fixtureMs),
        plans,
        probeMs: Math.round(probeMs),
        shape: {
          ...LARGE_PURGE_SHAPE,
          activeTargetChunks: target.activeChunkIds.length,
          receiptsCitingTarget: receipts.citingTargetIds.length,
          staleTargetChunks: target.staleChunkIds.length
        },
        statements: statementGroups(statements, 12)
      }));
    } finally {
      recording = false;
      await probe.$disconnect();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }, 600_000);
});

const CHUNK_MESSAGES = 4;
const RECEIPT_RESULTS = 8;
const LARGE_PURGE_SHAPE = Object.freeze({
  otherSourceMessages: 80,
  otherSources: 3,
  receipts: 2_400,
  receiptsCitingTargetEvery: 6,
  targetBranchMessages: 8,
  targetPrefixMessages: 400,
  targetStaleTailMessages: 200
});

class ProbeRollback extends Error {
  constructor() {
    super("memory_purge_probe_rollback");
  }
}

type ProbeStatement = Readonly<{ durationMs: number; params: string; query: string }>;

type HistoryChatFixture = Readonly<{
  activeChunkIds: readonly string[];
  chatId: string;
  staleChunkIds: readonly string[];
}>;

type FixtureMessage = Readonly<{ id: string; role: string; updatedAt: Date }>;

function synthetic(seed: string, length: number): string {
  let value = "";
  for (let index = 0; value.length < length; index += 1) {
    value += createHash("sha256").update(`${seed}:${index}`).digest("hex");
  }
  return value.slice(0, length);
}

async function createHistoryChat(
  userId: string,
  title: string,
  shape: Readonly<{ branchMessages: number; prefixMessages: number; staleTailMessages: number }>
): Promise<HistoryChatFixture> {
  const chat = await prisma.chat.create({ data: { title, userId } });
  const baseMs = Date.UTC(2026, 7, 1);
  const rows: Prisma.MessageCreateManyInput[] = [];
  const chain = (count: number, parentId: string | null): string[] => {
    const ids: string[] = [];
    let parent = parentId;
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      const at = new Date(baseMs + rows.length * 1_000);
      rows.push({
        chatId: chat.id,
        content: textMessageContent(`Synthetic turn ${rows.length}.`),
        createdAt: at,
        id,
        parentMessageId: parent,
        role: index % 2 === 0 ? "user" : "assistant",
        status: "complete",
        updatedAt: at
      });
      ids.push(id);
      parent = id;
    }
    return ids;
  };
  const prefix = chain(shape.prefixMessages, null);
  const stale = chain(shape.staleTailMessages, prefix.at(-1) ?? null);
  const branch = chain(shape.branchMessages, prefix.at(-1) ?? null);
  await prisma.message.createMany({ data: rows });
  await prisma.chat.update({
    data: { activeLeafMessageId: branch.at(-1) ?? prefix.at(-1)! },
    where: { id: chat.id }
  });
  const stored = new Map<string, FixtureMessage>((await prisma.message.findMany({
    select: { id: true, role: true, updatedAt: true },
    where: { chatId: chat.id }
  })).map((message) => [message.id, message]));
  const chunks = (messageIds: readonly string[], firstOrdinal: number, active: boolean) => {
    const chunkRows: Prisma.MemoryRecallChunkCreateManyInput[] = [];
    const mapRows: Prisma.MemoryRecallChunkMessageCreateManyInput[] = [];
    for (let start = 0; start < messageIds.length; start += CHUNK_MESSAGES) {
      const members = messageIds.slice(start, start + CHUNK_MESSAGES)
        .map((id) => stored.get(id)!);
      const ordinal = firstOrdinal + chunkRows.length;
      const lines = members.map((message, index) =>
        `${message.role}:\nSynthetic turn ${ordinal}.${index}.`);
      const text = lines.join("\n");
      const id = randomUUID();
      chunkRows.push({
        branchGeneration: 0,
        chatId: chat.id,
        chunkOrdinal: ordinal,
        chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
        contentHash: memorySha256(text),
        id,
        ...(active ? {} : { invalidatedAt: new Date(baseMs) }),
        languageCode: "en",
        normalizedSafeSearchText: normalizeMemorySearchText(text),
        occurredFrom: new Date(baseMs),
        occurredTo: new Date(baseMs),
        redactionState: "NOT_NEEDED",
        safeProjectedText: text,
        safetyClass: "NORMAL",
        sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
        sourceRevisionAtCreation: 0,
        state: active ? "ACTIVE" : "INVALIDATED",
        userId
      });
      members.forEach((message, index) => mapRows.push({
        chatId: chat.id,
        chunkId: id,
        messageId: message.id,
        ordinal: index,
        role: message.role,
        safeTextHash: memorySha256(lines[index]!),
        sourceMessageContentHash: memorySha256(`synthetic-content:${message.id}`),
        sourceMessageUpdatedAt: message.updatedAt,
        userId
      }));
    }
    return { chunkRows, mapRows };
  };
  const active = chunks(prefix, 0, true);
  const staleChunks = chunks(stale, active.chunkRows.length, false);
  // ACTIVE chunks and their source maps satisfy the deferred source guard
  // only together, so they commit in one transaction.
  await prisma.$transaction([
    prisma.memoryRecallChunk.createMany({ data: active.chunkRows }),
    prisma.memoryRecallChunkMessage.createMany({ data: active.mapRows })
  ]);
  if (staleChunks.chunkRows.length > 0) {
    await prisma.$transaction([
      prisma.memoryRecallChunk.createMany({ data: staleChunks.chunkRows }),
      prisma.memoryRecallChunkMessage.createMany({ data: staleChunks.mapRows })
    ]);
  }
  return {
    activeChunkIds: active.chunkRows.map(({ id }) => id!),
    chatId: chat.id,
    staleChunkIds: staleChunks.chunkRows.map(({ id }) => id!)
  };
}

async function createSearchReceipts(input: Readonly<{
  citeTargetEvery: number;
  count: number;
  memoryGeneration: number;
  otherChatIds: readonly string[];
  targetChatId: string;
  userId: string;
}>): Promise<Readonly<{
  citingTargetIds: readonly string[];
  citingTargetToolCallIds: readonly string[];
  total: number;
}>> {
  const chat = await prisma.chat.create({
    data: { title: "Large purge searches", userId: input.userId }
  });
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  await prisma.message.createMany({
    data: [
      {
        chatId: chat.id,
        content: textMessageContent("Synthetic search turn."),
        id: userMessageId,
        role: "user"
      },
      {
        chatId: chat.id,
        content: textMessageContent("Synthetic search answer."),
        id: assistantMessageId,
        parentMessageId: userMessageId,
        role: "assistant"
      }
    ]
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: assistantMessageId },
    where: { id: chat.id }
  });
  // A native search receipt allows at most three invocations per run.
  const runIds = Array.from({ length: Math.ceil(input.count / 3) }, () => randomUUID());
  await prisma.modelRun.createMany({
    data: runIds.map((id) => ({
      assistantMessageId,
      chatId: chat.id,
      id,
      modelId: "memory-history-large-purge-model",
      normalizedRequest: {},
      provider: "memory-history-large-purge-provider",
      status: "complete" as const,
      userId: input.userId,
      userMessageId
    }))
  });
  const citingTargetIds: string[] = [];
  const citingTargetToolCallIds: string[] = [];
  const completedAt = new Date(Date.UTC(2026, 7, 2));
  for (let offset = 0; offset < input.count; offset += 200) {
    const batch = Array.from({ length: Math.min(200, input.count - offset) }, (_, index) => {
      const ordinal = offset + index;
      const citesTarget = ordinal % input.citeTargetEvery === 0;
      const results = Array.from({ length: RECEIPT_RESULTS }, (__, position) => ({
        exactItemId: `synthetic-${ordinal}-${position}`,
        includedText: synthetic(`included:${ordinal}:${position}`, 480),
        itemType: "RECALL_CHUNK",
        sourceChatId: citesTarget && position === 0
          ? input.targetChatId
          : input.otherChatIds[(ordinal + position) % input.otherChatIds.length]!,
        sourceMessageIds: []
      }));
      const receiptId = randomUUID();
      const toolCallId = randomUUID();
      if (citesTarget) {
        citingTargetIds.push(receiptId);
        citingTargetToolCallIds.push(toolCallId);
      }
      const query = `Synthetic history query ${ordinal}`;
      const modelRunId = runIds[Math.floor(ordinal / 3)]!;
      const call: Prisma.ModelRunToolCallCreateManyInput = {
        arguments: { query },
        completedAt,
        id: toolCallId,
        modelRunId,
        ordinal: ordinal % 3,
        providerCallId: `synthetic-call-${ordinal}`,
        result: { status: "complete" },
        roundIndex: 0,
        state: "complete",
        toolName: "memory_search"
      };
      const receipt: Prisma.MemoryHistoryRunCreateManyInput = {
        completedAt,
        durationMs: 10,
        id: receiptId,
        indexingEvidence: { delivered: true },
        invocationOrdinal: (ordinal % 3) + 1,
        modelRunId,
        modelRunToolCallId: toolCallId,
        outcome: "RESULTS",
        privateRequest: {
          accepted: { memoryGeneration: input.memoryGeneration },
          version: "memory-search-v1"
        },
        providerResult: { content: [] },
        query,
        queryHash: memorySha256(query),
        receiptVersion: "memory-search-v1",
        resultCount: RECEIPT_RESULTS,
        resultHash: memorySha256({ ordinal, results: "synthetic" }),
        results: {
          items: results.map(({ exactItemId, itemType }) => ({ exactItemId, itemType })),
          resolved: results.map(({ exactItemId }) => ({
            exactItemId,
            exactSafeText: synthetic(`resolved:${exactItemId}`, 480)
          })),
          results,
          version: "memory-search-v1"
        },
        state: "COMPLETE",
        userId: input.userId
      };
      return { call, receipt };
    });
    await prisma.modelRunToolCall.createMany({ data: batch.map(({ call }) => call) });
    await prisma.memoryHistoryRun.createMany({ data: batch.map(({ receipt }) => receipt) });
  }
  return { citingTargetIds, citingTargetToolCallIds, total: input.count };
}

function statementLabel(query: string): string {
  const keyword = /^\s*(\w+)/u.exec(query)?.[1]?.toUpperCase() ?? "?";
  const table = /(?:FROM|UPDATE|INTO)\s+(?:"public"\.)?"([A-Za-z]+)"/u.exec(query)?.[1] ?? "-";
  return `${keyword} ${table} #${memorySha256(query).slice(0, 8)}`;
}

function statementGroups(statements: readonly ProbeStatement[], limit: number) {
  const groups = new Map<string, { calls: number; maxMs: number; totalMs: number }>();
  for (const statement of statements) {
    const label = statementLabel(statement.query);
    const group = groups.get(label) ?? { calls: 0, maxMs: 0, totalMs: 0 };
    group.calls += 1;
    group.maxMs = Math.max(group.maxMs, statement.durationMs);
    group.totalMs += statement.durationMs;
    groups.set(label, group);
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .slice(0, limit)
    .map(([label, group]) => ({ label, ...group }));
}

type PlanNode = Readonly<{
  "Actual Loops"?: number;
  "Actual Rows"?: number;
  "Actual Total Time"?: number;
  "Index Name"?: string;
  "Node Type"?: string;
  Plans?: readonly PlanNode[];
  "Relation Name"?: string;
}>;

type PlanRoot = Readonly<{
  "Execution Time"?: number;
  Plan?: PlanNode;
  "Planning Time"?: number;
  Triggers?: ReadonlyArray<Readonly<{ Calls?: number; "Trigger Name"?: string; Time?: number }>>;
}>;

function summarizePlan(value: unknown) {
  const root = (Array.isArray(value) ? value[0] : value) as PlanRoot | null | undefined;
  const nodes: Array<Record<string, number | string>> = [];
  const visit = (node: PlanNode | undefined) => {
    if (!node) return;
    const loops = node["Actual Loops"] ?? 0;
    const totalMs = (node["Actual Total Time"] ?? 0) * loops;
    if (node["Relation Name"] || totalMs >= 1) {
      nodes.push({
        loops,
        node: node["Node Type"] ?? "?",
        rows: node["Actual Rows"] ?? 0,
        totalMs: Math.round(totalMs),
        ...(node["Relation Name"] ? { relation: node["Relation Name"] } : {}),
        ...(node["Index Name"] ? { index: node["Index Name"] } : {})
      });
    }
    node.Plans?.forEach(visit);
  };
  visit(root?.Plan);
  return {
    executionMs: Math.round(root?.["Execution Time"] ?? -1),
    nodes: nodes.slice(0, 16),
    planningMs: Math.round(root?.["Planning Time"] ?? -1),
    triggers: (root?.Triggers ?? []).map((trigger) => ({
      calls: trigger.Calls ?? 0,
      ms: Math.round(trigger.Time ?? 0),
      name: trigger["Trigger Name"] ?? "?"
    }))
  };
}

async function explainSlowestStatements(
  client: PrismaClient,
  statements: readonly ProbeStatement[],
  limit: number
) {
  const candidates = [...statements]
    .filter(({ query }) => /^\s*(WITH|SELECT|UPDATE|DELETE)\b/iu.test(query))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, limit);
  const plans: Array<Record<string, unknown>> = [];
  for (const statement of candidates) {
    const label = statementLabel(statement.query);
    try {
      const params = JSON.parse(statement.params) as unknown[];
      let plan: unknown = null;
      // EXPLAIN ANALYZE executes the statement; every replay rolls back.
      await client.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
          ...params
        );
        plan = rows[0]?.["QUERY PLAN"];
        throw new ProbeRollback();
      }, { maxWait: 10_000, timeout: 120_000 }).catch((error: unknown) => {
        if (!(error instanceof ProbeRollback)) throw error;
      });
      plans.push({ label, probeMs: statement.durationMs, ...summarizePlan(plan) });
    } catch (error) {
      plans.push({
        error: error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : "explain_failed",
        label,
        probeMs: statement.durationMs
      });
    }
  }
  return plans;
}