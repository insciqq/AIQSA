import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  type MemoryHistorySearchInput,
  type MemoryHistorySearchResponse
} from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../coordinator/types";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../sourceState";
import { createPrismaMemoryHistoryIndexHandler } from "./handler";
import {
  createPrismaMemoryHistorySearchRepository,
  MemoryHistorySearchRepositoryError
} from "./search";
import {
  decodeMemoryEpisodeExtraction,
  MEMORY_EPISODE_TOOL_NAME,
  createPrismaMemoryEpisodeRepository,
  memoryEpisodeRedreamJobFingerprint
} from "./episode";
import {
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256
} from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_TEMPORARY_DELETION_GENERATION,
  MEMORY_TEMPORARY_DELETION_TARGET_TYPE
} from "../temporaryRetention";
import { createMemoryHistoryToolExecutor } from "./search/toolExecutor";
import { MEMORY_HISTORY_SEARCH_TOOL_NAME } from "./search/tool";
import type { ProviderRunRequest } from "../../providers/types";
import { createMemoryToolEgressReceiptService } from "../egress/receipts";
import { purgeMemoryHistoryReceiptDerivatives } from "./purge";
import {
  MEMORY_HISTORY_BACKFILL_WINDOW,
  readMemoryHistoryIndexingProgress,
  reconcileMemoryHistoryBackfills
} from "./backfill";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";

async function mutateSource(
  userId: string,
  chatId: string,
  input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">
) {
  return prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, {
      chatId,
      lock: "UPDATE",
      userId
    });
    if (!chat) throw new Error("memory_history_test_chat_missing");
    return applyMemorySourceMutations(tx, {
      ...input,
      chat,
      hooks: defaultMemorySourceMutationHooks
    });
  });
}

async function createTurn(
  input: Readonly<{
    assistantText: string;
    chatId: string;
    createdAt: Date;
    grounded?: boolean;
    parentMessageId: string | null;
    userId: string;
    userText: string;
  }>
) {
  const userMessage = await prisma.message.create({
    data: {
      chatId: input.chatId,
      content: textMessageContent(input.userText),
      createdAt: input.createdAt,
      parentMessageId: input.parentMessageId,
      role: "user",
      status: "complete",
      updatedAt: input.createdAt
    }
  });
  const assistantAt = new Date(input.createdAt.getTime() + 1_000);
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: input.chatId,
      content: textMessageContent(input.assistantText),
      createdAt: assistantAt,
      groundedAt: input.grounded ? assistantAt : null,
      groundingProvider: input.grounded ? "gemini" : null,
      groundingStrategy: input.grounded ? "gemini-google-search" : null,
      modelId: "history-test-model",
      parentMessageId: userMessage.id,
      provider: "history-test-provider",
      role: "assistant",
      status: "complete",
      updatedAt: assistantAt
    }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: assistantMessage.id,
      chatId: input.chatId,
      modelId: "history-test-model",
      normalizedRequest: {
        prompt: {
          baseline: {
            source: "standard_chat",
            timeZone: "Europe/Moscow",
            timeZoneSource: "client"
          }
        }
      },
      provider: "history-test-provider",
      providerRequestPreview: {},
      status: "complete",
      userId: input.userId,
      userMessageId: userMessage.id
    }
  });
  return { assistantMessage, run, userMessage };
}

async function createOwner(prefix: string) {
  const suffix = randomUUID();
  const userId = `${prefix}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory History Test",
      email: `${prefix}-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: {
      learnAutomatically: false,
      referenceChatHistory: true
    },
    where: { userId }
  });
  return userId;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function claimHistoryJob(userId: string): Promise<MemoryJobClaim> {
  const job = await prisma.memoryJob.findFirstOrThrow({
    orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
    where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
  });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED"
    },
    where: { id: job.id }
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

async function claimEpisodeJob(userId: string): Promise<MemoryJobClaim> {
  const job = await prisma.memoryJob.findFirstOrThrow({
    orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
    where: { kind: "EXTRACT_EPISODE", state: "QUEUED", userId }
  });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED"
    },
    where: { id: job.id }
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

function episodeToolCall(
  input: Extract<
    Awaited<ReturnType<ReturnType<typeof createPrismaMemoryEpisodeRepository>["prepare"]>>,
    { input: unknown }
  >["input"],
  summary: string,
  keyword: string
) {
  const chunk = input.chunks[0]!;
  return [{
    arguments: {
      episodes: [{
        keywords: [keyword],
        language: chunk.languageCode,
        occurred_from: chunk.occurredFrom,
        occurred_to: chunk.occurredTo,
        source_chunk_ids: [chunk.id],
        source_message_ids: [...chunk.messageIds],
        summary
      }]
    },
    id: "episode-call-1",
    name: MEMORY_EPISODE_TOOL_NAME
  }];
}

function executionContext(now: Date) {
  return {
    now: () => now,
    setStage: async (_stage: string) => undefined,
    signal: new AbortController().signal
  };
}

function historyToolProviderRequest(chatId: string): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId,
    content: textMessageContent("Search my history"),
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: true,
      vision: false
    },
    modelId: "history-test-model",
    params: {},
    prompt: { developer: null, system: null },
    provider: "history-test-provider",
    searchStrategy: "search-disabled"
  };
}

async function processHistoryJob(userId: string) {
  const claim = await claimHistoryJob(userId);
  const handler = createPrismaMemoryHistoryIndexHandler(prisma);
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const now = new Date();
  const result = await handler.execute(claim, executionContext(now));
  const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
  await expect(coordinator.commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  })).resolves.toBe(true);
  return { claim, result };
}

describe("Memory lexical history index persistence", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("automatically backfills retained chats newest-first through a bounded idempotent window", async () => {
    const userId = await createOwner("memory-history-auto-backfill");
    try {
      await prisma.userMemorySettings.update({
        data: { referenceChatHistory: false },
        where: { userId }
      });
      const eligible: Array<{ chatId: string; updatedAt: Date }> = [];
      let excludedChatId = "";
      for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        const updatedAt = new Date(`2026-08-10T${String(ordinal + 8).padStart(2, "0")}:00:00.000Z`);
        const excluded = ordinal === 5;
        const chat = await prisma.chat.create({
          data: {
            memoryMode: excluded ? "EXCLUDED" : "NORMAL",
            title: `Backfill ${ordinal}`,
            userId
          }
        });
        const turn = await createTurn({
          assistantText: `Backfill assistant ${ordinal}`,
          chatId: chat.id,
          createdAt: updatedAt,
          parentMessageId: null,
          userId,
          userText: `Backfill user ${ordinal}`
        });
        await prisma.chat.update({
          data: {
            activeLeafMessageId: turn.assistantMessage.id,
            updatedAt
          },
          where: { id: chat.id }
        });
        if (excluded) excludedChatId = chat.id;
        else eligible.push({ chatId: chat.id, updatedAt });
      }
      const repository = createPrismaMemorySettingsRepository(prisma);
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await repository.patch(userId, {
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        referenceChatHistory: true
      });

      const initialJobs = await prisma.memoryJob.findMany({
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
      });
      expect(initialJobs).toHaveLength(MEMORY_HISTORY_BACKFILL_WINDOW);
      expect(initialJobs.map((job) => job.chatId)).toEqual(
        [...eligible]
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
          .slice(0, MEMORY_HISTORY_BACKFILL_WINDOW)
          .map((candidate) => candidate.chatId)
      );
      expect(initialJobs.some((job) => job.chatId === excludedChatId)).toBe(false);
      await expect(readMemoryHistoryIndexingProgress(
        prisma,
        userId,
        true
      )).resolves.toEqual({
        completedChats: 0,
        state: "INDEXING",
        totalChats: eligible.length
      });

      for (let attempt = 0; attempt < eligible.length + 2; attempt += 1) {
        const queued = await prisma.memoryJob.count({
          where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
        });
        if (queued === 0) break;
        await processHistoryJob(userId);
        await reconcileMemoryHistoryBackfills(prisma);
      }

      await expect(readMemoryHistoryIndexingProgress(
        prisma,
        userId,
        true
      )).resolves.toEqual({
        completedChats: eligible.length,
        state: "READY",
        totalChats: eligible.length
      });
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(eligible.length);
      await expect(prisma.memoryJob.count({
        where: { kind: { in: ["EXTRACT_FACTS", "GLOBAL_DREAM"] }, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: { kind: "EMBED_ITEMS", userId }
      })).resolves.toBe(0);

      const enabled = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const disabled = await repository.patch(userId, {
        expectedMemoryRevision: enabled.memoryRevision,
        expectedSettingsRevision: enabled.settingsRevision,
        referenceChatHistory: false
      });
      await expect(readMemoryHistoryIndexingProgress(
        prisma,
        userId,
        false
      )).resolves.toMatchObject({ state: "DISABLED" });
      await repository.patch(userId, {
        expectedMemoryRevision: disabled.memoryRevision,
        expectedSettingsRevision: disabled.settingsRevision,
        referenceChatHistory: true
      });
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(eligible.length);

      const catchupChat = await prisma.chat.create({
        data: { title: "Already-enabled catch-up", userId }
      });
      const catchupTurn = await createTurn({
        assistantText: "Catch-up assistant",
        chatId: catchupChat.id,
        createdAt: new Date("2026-08-10T15:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Catch-up user"
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: catchupTurn.assistantMessage.id,
          updatedAt: new Date("2026-08-10T15:01:00.000Z")
        },
        where: { id: catchupChat.id }
      });
      await reconcileMemoryHistoryBackfills(prisma);
      await reconcileMemoryHistoryBackfills(prisma);
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(eligible.length + 1);
      await expect(prisma.memoryJob.findFirstOrThrow({
        where: { chatId: catchupChat.id, kind: "INDEX_HISTORY", userId }
      })).resolves.toMatchObject({ state: "QUEUED" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("replays automatic backfill behind a populated history barrier without resurrection", async () => {
    const userId = await createOwner("memory-history-auto-barrier");
    try {
      await prisma.userMemorySettings.update({
        data: { referenceChatHistory: false },
        where: { userId }
      });
      const chat = await prisma.chat.create({
        data: { title: "Barrier backfill", userId }
      });
      const turn = await createTurn({
        assistantText: "Old assistant text remains forgotten.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Old user text remains forgotten."
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: turn.assistantMessage.id,
          updatedAt: new Date("2026-08-10T10:01:00.000Z")
        },
        where: { id: chat.id }
      });
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await prisma.memorySourceBarrier.create({
        data: {
          kind: "HISTORY_INDEX",
          memoryGeneration: before.memoryGeneration,
          sourceCreatedAtCutoff: new Date("2026-08-10T11:00:00.000Z"),
          userId
        }
      });
      const repository = createPrismaMemorySettingsRepository(prisma);
      await repository.patch(userId, {
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        referenceChatHistory: true
      });
      await processHistoryJob(userId);

      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({
        lastIndexedMessageId: turn.assistantMessage.id,
        status: "READY"
      });

      await prisma.chatMemoryCheckpoint.update({
        data: {
          lastIndexedMessageId: null,
          lastSucceededAt: null,
          status: "STALE"
        },
        where: { userId_chatId: { chatId: chat.id, userId } }
      });
      const enabled = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const disabled = await repository.patch(userId, {
        expectedMemoryRevision: enabled.memoryRevision,
        expectedSettingsRevision: enabled.settingsRevision,
        referenceChatHistory: false
      });
      await repository.patch(userId, {
        expectedMemoryRevision: disabled.memoryRevision,
        expectedSettingsRevision: disabled.settingsRevision,
        referenceChatHistory: true
      });
      await expect(prisma.memoryJob.findFirstOrThrow({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toMatchObject({ state: "QUEUED" });
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(1);

      await processHistoryJob(userId);
      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({ status: "READY" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("continues past terminal failures and retries them only after history is re-enabled", async () => {
    const userId = await createOwner("memory-history-terminal-backfill");
    try {
      for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        const updatedAt = new Date(
          `2026-08-10T${String(ordinal + 8).padStart(2, "0")}:00:00.000Z`
        );
        const chat = await prisma.chat.create({
          data: { title: `Terminal backfill ${ordinal}`, userId }
        });
        const turn = await createTurn({
          assistantText: `Terminal assistant ${ordinal}`,
          chatId: chat.id,
          createdAt: updatedAt,
          parentMessageId: null,
          userId,
          userText: `Terminal user ${ordinal}`
        });
        await prisma.chat.update({
          data: { activeLeafMessageId: turn.assistantMessage.id, updatedAt },
          where: { id: chat.id }
        });
      }

      await reconcileMemoryHistoryBackfills(prisma);
      const initialWindow = await prisma.memoryJob.findMany({
        select: { id: true },
        where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
      });
      expect(initialWindow).toHaveLength(MEMORY_HISTORY_BACKFILL_WINDOW);
      const failedAt = new Date("2026-08-10T16:00:00.000Z");
      await prisma.memoryJob.updateMany({
        data: {
          completedAt: failedAt,
          errorCode: "memory_history_terminal_test",
          nextAttemptAt: null,
          state: "TERMINAL_FAILED"
        },
        where: { id: { in: initialWindow.map(({ id }) => id) } }
      });

      await reconcileMemoryHistoryBackfills(prisma);
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", state: "TERMINAL_FAILED", userId }
      })).resolves.toBe(MEMORY_HISTORY_BACKFILL_WINDOW);

      const repository = createPrismaMemorySettingsRepository(prisma);
      const enabled = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const disabled = await repository.patch(userId, {
        expectedMemoryRevision: enabled.memoryRevision,
        expectedSettingsRevision: enabled.settingsRevision,
        referenceChatHistory: false
      });
      const reenabled = await repository.patch(userId, {
        expectedMemoryRevision: disabled.memoryRevision,
        expectedSettingsRevision: disabled.settingsRevision,
        referenceChatHistory: true
      });
      await expect(prisma.memoryJob.count({
        where: {
          id: { in: initialWindow.map(({ id }) => id) },
          memoryGenerationSnapshot: reenabled.memoryGeneration,
          state: "QUEUED",
          userId
        }
      })).resolves.toBe(2);
      await expect(prisma.memoryJob.count({
        where: {
          id: { in: initialWindow.map(({ id }) => id) },
          state: "STALE",
          userId
        }
      })).resolves.toBe(2);
      await expect(prisma.memoryJob.count({
        where: {
          id: { in: initialWindow.map(({ id }) => id) },
          state: "TERMINAL_FAILED",
          userId
        }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("indexes a settled chat with learning off and replays idempotently", async () => {
    const userId = await createOwner("memory-history-index");
    try {
      const folder = await prisma.folder.create({
        data: { name: "History folder", userId }
      });
      const chat = await prisma.chat.create({
        data: { folderId: folder.id, title: "History indexing", userId }
      });
      const turn = await createTurn({
        assistantText: "Понял: кофе после обеда не предлагать.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T09:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Я не пью кофе после обеда с 10 августа 2026 года."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: turn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: turn.assistantMessage.id,
          runId: `history-run-${randomUUID()}`,
          status: "complete"
        }
      });

      const settingsBefore = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(settingsBefore).toMatchObject({
        learnAutomatically: false,
        referenceChatHistory: true
      });
      const { claim, result } = await processHistoryJob(userId);

      const [checkpoint, chunks, entries, settingsAfter, generation] = await Promise.all([
        prisma.chatMemoryCheckpoint.findUniqueOrThrow({
          where: { userId_chatId: { chatId: chat.id, userId } }
        }),
        prisma.memoryRecallChunk.findMany({
          where: { chatId: chat.id, state: "ACTIVE", userId }
        }),
        prisma.memorySearchEntry.findMany({
          where: { itemType: "RECALL_CHUNK", userId }
        }),
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryIndexGeneration.findFirstOrThrow({
          where: { state: "ACTIVE", userId }
        })
      ]);
      expect(checkpoint).toMatchObject({
        activeLeafMessageId: turn.assistantMessage.id,
        lastIndexedMessageId: turn.assistantMessage.id,
        status: "READY"
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        sourceFolderId: folder.id,
        state: "ACTIVE"
      });
      expect(chunks[0]?.safeProjectedText).toContain("не пью кофе");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        embeddingState: "NOT_APPLICABLE",
        indexGenerationId: generation.id,
        recallChunkId: chunks[0]?.id
      });
      expect(settingsAfter.activeIndexGenerationId).toBe(generation.id);
      expect(settingsAfter.memoryRevision).toBe(settingsBefore.memoryRevision + 1);
      if (!checkpoint.lastSucceededAt) {
        throw new Error("memory_history_qualification_checkpoint_missing");
      }
      const indexedJob = await prisma.memoryJob.findUniqueOrThrow({
        select: { createdAt: true },
        where: { id: claim.id }
      });
      const jobLagMs = checkpoint.lastSucceededAt.getTime() -
        indexedJob.createdAt.getTime();
      const evidence = Object.freeze({
        evidenceVersion: "memory-phase4-history-qualification-v1",
        jobLagMs,
        learningEnabled: settingsAfter.learnAutomatically,
        maximumJobLagMs: 15 * 60 * 1_000,
        sanitizedAggregatesOnly: true,
        searchableChunkCount: chunks.length
      });
      expect(evidence).toMatchObject({
        learningEnabled: false,
        sanitizedAggregatesOnly: true,
        searchableChunkCount: 1
      });
      expect(evidence.jobLagMs).toBeGreaterThanOrEqual(0);
      expect(evidence.jobLagMs).toBeLessThan(evidence.maximumJobLagMs);
      expect(JSON.stringify(evidence)).not.toContain(userId);
      console.info("memory_phase4_history_qualification", evidence);

      const lexical = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT entry."id"
        FROM "MemorySearchEntry" AS entry
        WHERE entry."userId" = ${userId}
          AND entry."indexGenerationId" = ${generation.id}
          AND entry."searchVectorRussian" @@ plainto_tsquery('russian', 'кофе')
      `);
      expect(lexical).toEqual([{ id: entries[0]!.id }]);

      await prisma.$transaction(async (tx) => {
        await result.apply?.(tx, claim);
      });
      const replayedSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(replayedSettings.memoryRevision).toBe(settingsAfter.memoryRevision);
      await expect(prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      })).resolves.toBe(1);

      const nextTurn = await createTurn({
        assistantText: "Understood: tea remains acceptable.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T09:05:00.000Z"),
        parentMessageId: turn.assistantMessage.id,
        userId,
        userText: "Tea is still fine."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: nextTurn.assistantMessage.id }
      });
      await expect(prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      })).resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(0);
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: nextTurn.assistantMessage.id,
          runId: nextTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);
      const reindexed = await prisma.memoryRecallChunk.findMany({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(reindexed).toHaveLength(1);
      expect(reindexed[0]?.safeProjectedText).toContain("Tea is still fine");
      await expect(prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "INVALIDATED", userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("persists an exact episode, message evidence, and lexical row atomically", async () => {
    const userId = await createOwner("memory-episode-apply");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Episode persistence", userId }
      });
      const turn = await createTurn({
        assistantText: "Подтверждаю выбранный сине-зелёный выпуск.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T08:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Для выпуска используем сине-зелёное развёртывание."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: turn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: turn.assistantMessage.id,
          runId: turn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const claim = await claimEpisodeJob(userId);
      const repository = createPrismaMemoryEpisodeRepository(prisma);
      const prepared = await repository.prepare(claim);
      if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
      const summary = "Для выпуска используем сине-зелёное развёртывание.";
      const plan = decodeMemoryEpisodeExtraction(
        episodeToolCall(prepared.input, summary, "сине-зелёное"),
        prepared.input
      );
      const bindingId = `episode-binding-${randomUUID()}`;
      const settledAt = new Date("2026-08-10T08:04:00.000Z");
      await prisma.memoryExecutionBinding.create({
        data: {
          acceptedOutputHash: plan.outputHash,
          completedAt: settledAt,
          createdAt: new Date("2026-08-10T08:03:00.000Z"),
          destinationFingerprint: "d".repeat(64),
          id: bindingId,
          inputHash: prepared.input.inputHash,
          logicalRole: "MEMORY_EPISODE_EXTRACT",
          memoryJobId: claim.id,
          ordinal: 0,
          ownerType: "JOB",
          pipelineVersion: claim.pipelineVersion,
          policyVersion: "memory-episode-extractive-policy-v1",
          promptVersion: "memory-episode-extractive-prompt-v1",
          providerId: "episode-test-provider",
          recoverableUntil: settledAt,
          relationsDetachedAt: settledAt,
          schemaVersion: "memory-episode-extractive-schema-v1",
          secretFreeExecutionSnapshot: {},
          state: "SUCCEEDED",
          userId
        }
      });
      const applied = await withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository.apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date("2026-08-10T08:05:00.000Z")
        )
      );
      expect(applied).toBe("APPLIED");
      const episode = await prisma.memoryEpisode.findFirstOrThrow({
        where: { createdByExecutionId: bindingId, state: "ACTIVE", userId }
      });
      expect(episode).toMatchObject({
        languageCode: "ru",
        safeSummary: summary,
        safetyClass: "NORMAL"
      });
      await expect(prisma.memoryEpisodeMessage.findMany({
        orderBy: { ordinal: "asc" },
        where: { episodeId: episode.id, userId }
      })).resolves.toMatchObject(prepared.input.chunks[0]!.messageIds.map(
        (messageId, ordinal) => ({ messageId, ordinal })
      ));
      await expect(prisma.memorySearchEntry.findFirstOrThrow({
        where: { episodeId: episode.id, itemType: "EPISODE", userId }
      })).resolves.toMatchObject({
        embeddingState: "NOT_APPLICABLE",
        languageCode: "ru"
      });
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({
        lastDreamedMessageId: turn.assistantMessage.id,
        lastErrorCode: null
      });
      const after = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(after.memoryRevision).toBe(before.memoryRevision + 1);

      const historySearch = createPrismaMemoryHistorySearchRepository(prisma);
      const searchInput: MemoryHistorySearchInput = {
        chatIds: [],
        cursor: null,
        folderId: null,
        from: null,
        pageSize: 20,
        query: "сине-зелёное развёртывание",
        to: null
      };
      const preparedSearch = await historySearch.prepare(userId, searchInput);
      const searchResponse = await historySearch.search(preparedSearch, null);
      expect(searchResponse.results.some((result) =>
        result.itemType === "EPISODE" && result.snippet === summary
      )).toBe(true);
      expect(searchResponse.indexing).toEqual({
        degradationCode: null,
        lexicalState: "READY",
        vectorState: "NOT_CONFIGURED"
      });

      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository.apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date("2026-08-10T08:06:00.000Z")
        )
      )).resolves.toBe("APPLIED");
      await expect(prisma.memoryEpisode.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ memoryRevision: after.memoryRevision });

      await prisma.memorySearchEntry.deleteMany({
        where: { episodeId: episode.id, userId }
      });
      await prisma.memoryEpisodeMessage.deleteMany({
        where: { episodeId: episode.id, userId }
      });
      await prisma.memoryEpisode.delete({ where: { id: episode.id } });
      if (
        claim.activeLeafMessageId === null ||
        claim.branchGeneration === null ||
        claim.chatId === null ||
        claim.sourceHash === null ||
        claim.sourceRevision === null
      ) throw new Error("episode_claim_source_missing");
      const redreamClaim = {
        ...claim,
        idempotencyFingerprint: memoryEpisodeRedreamJobFingerprint(randomUUID(), {
          activeLeafMessageId: claim.activeLeafMessageId,
          branchGeneration: claim.branchGeneration,
          chatId: claim.chatId,
          sourceHash: claim.sourceHash,
          sourceRevision: claim.sourceRevision,
          userId
        })
      };
      await expect(repository.alreadyApplied(
        redreamClaim,
        `episode-redream-binding-${randomUUID()}`
      )).resolves.toBe(false);
      await prisma.memorySuppression.create({
        data: {
          deletionGeneration: after.memoryGeneration,
          explicitOverrideAllowed: true,
          fingerprintKeyVersion: "history-test-v1",
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          scope: "SOURCE_MESSAGE",
          sourceBranchGeneration: claim.branchGeneration,
          sourceChatId: claim.chatId,
          sourceMessageId: prepared.input.chunks[0]!.messageIds[0]!,
          userId
        }
      });
      await expect(repository.prepare(redreamClaim)).resolves.toMatchObject({
        decision: { status: "STALE" }
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects an episode apply after the exact source revision changes", async () => {
    const userId = await createOwner("memory-episode-source-race");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Episode source race", userId }
      });
      const first = await createTurn({
        assistantText: "Initial assistant reply.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T08:30:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Initial user decision."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: first.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: first.assistantMessage.id,
          runId: first.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);
      const claim = await claimEpisodeJob(userId);
      const repository = createPrismaMemoryEpisodeRepository(prisma);
      const prepared = await repository.prepare(claim);
      if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
      const plan = decodeMemoryEpisodeExtraction(
        episodeToolCall(prepared.input, "Initial user decision.", "decision"),
        prepared.input
      );

      const second = await createTurn({
        assistantText: "Updated assistant reply.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T08:35:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "Updated user decision."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: second.assistantMessage.id }
      });
      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository.apply(
          tx,
          settings,
          claim,
          plan,
          `episode-binding-${randomUUID()}`,
          new Date("2026-08-10T08:36:00.000Z")
        )
      )).resolves.toBe("STALE");
      await expect(prisma.memoryEpisode.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({
        where: { itemType: "EPISODE", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("settles a raced source as STALE without applying partial rows", async () => {
    const userId = await createOwner("memory-history-stale");
    try {
      const chat = await prisma.chat.create({
        data: { title: "History stale", userId }
      });
      const turn = await createTurn({
        assistantText: "The answer is settled.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Remember this safe preference."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: turn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: turn.assistantMessage.id,
          runId: `history-run-${randomUUID()}`,
          status: "complete"
        }
      });
      const claim = await claimHistoryJob(userId);
      const handler = createPrismaMemoryHistoryIndexHandler(prisma);
      const result = await handler.execute(claim, executionContext(new Date()));

      await mutateSource(userId, chat.id, {
        mutations: ["SOURCE_EXCLUDE"],
        patch: { memoryMode: "EXCLUDED" }
      });
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      await expect(coordinator.commitJobSuccess({
        acceptedResultHash: result.acceptedResultHash,
        apply: result.apply,
        claim,
        now: new Date(),
        stage: result.stage ?? null
      })).resolves.toBe(true);

      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: claim.id }
      })).resolves.toMatchObject({
        acceptedResultHash: null,
        errorCode: "memory_source_stale",
        state: "STALE"
      });
      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({ status: "STALE" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("reindexes on Resume without crossing history cutoffs or message suppressions", async () => {
    const userId = await createOwner("memory-history-resume");
    try {
      const chat = await prisma.chat.create({
        data: { title: "History resume", userId }
      });
      const oldTurn = await createTurn({
        assistantText: "Old assistant text must stay behind the cutoff.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Old user text must stay behind the cutoff."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: oldTurn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["SOURCE_EXCLUDE"],
        patch: { memoryMode: "EXCLUDED" }
      });
      const excludedSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const cutoff = new Date("2026-08-10T11:00:00.000Z");
      await prisma.memorySourceBarrier.create({
        data: {
          kind: "HISTORY_INDEX",
          memoryGeneration: excludedSettings.memoryGeneration,
          sourceCreatedAtCutoff: cutoff,
          userId
        }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["SOURCE_RESUME"],
        patch: { memoryMode: "NORMAL" }
      });
      await processHistoryJob(userId);

      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryIndexGeneration.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({ status: "READY" });

      const newTurn = await createTurn({
        assistantText: "Fresh assistant text is eligible.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T12:00:00.000Z"),
        parentMessageId: oldTurn.assistantMessage.id,
        userId,
        userText: "Fresh user text is eligible."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: newTurn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: newTurn.assistantMessage.id,
          runId: newTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);
      const freshChunk = await prisma.memoryRecallChunk.findFirstOrThrow({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(freshChunk.safeProjectedText).toContain("Fresh user text");
      expect(freshChunk.safeProjectedText).not.toContain("Old user text");

      const suppressedTurn = await createTurn({
        assistantText: "Suppressed assistant text must not be indexed.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T13:00:00.000Z"),
        parentMessageId: newTurn.assistantMessage.id,
        userId,
        userText: "Suppressed user text must not be indexed."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: suppressedTurn.assistantMessage.id }
      });
      await prisma.memorySuppression.create({
        data: {
          deletionGeneration: excludedSettings.memoryGeneration,
          fingerprintKeyVersion: "history-test-v1",
          normalizationVersion: "memory-search-normalization-v1",
          scope: "SOURCE_MESSAGE",
          sourceBranchGeneration: 0,
          sourceChatId: chat.id,
          sourceMessageId: suppressedTurn.userMessage.id,
          userId
        }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: suppressedTurn.assistantMessage.id,
          runId: suppressedTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);
      const currentChunks = await prisma.memoryRecallChunk.findMany({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(currentChunks).toHaveLength(1);
      expect(currentChunks[0]?.safeProjectedText).toContain("Fresh user text");
      expect(currentChunks[0]?.safeProjectedText).not.toContain("Suppressed user text");
      const joins = await prisma.memoryRecallChunkMessage.findMany({
        where: { chunkId: currentChunks[0]!.id, userId }
      });
      expect(joins.map((join) => join.messageId).sort()).toEqual([
        newTurn.assistantMessage.id,
        newTurn.userMessage.id
      ].sort());
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("admits no history work for Excluded or Temporary sources", async () => {
    const userId = await createOwner("memory-history-ineligible");
    try {
      const excludedChat = await prisma.chat.create({
        data: {
          memoryMode: "EXCLUDED",
          title: "Excluded history",
          userId
        }
      });
      const excludedTurn = await createTurn({
        assistantText: "Excluded assistant text.",
        chatId: excludedChat.id,
        createdAt: new Date("2026-08-10T14:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Excluded user text."
      });
      await mutateSource(userId, excludedChat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: excludedTurn.assistantMessage.id }
      });
      await mutateSource(userId, excludedChat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: excludedTurn.assistantMessage.id,
          runId: excludedTurn.run.id,
          status: "complete"
        }
      });

      const deadline = new Date(Date.now() + 86_400_000);
      const temporaryChat = await prisma.$transaction(async (tx) => {
        const chat = await tx.chat.create({
          data: {
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: deadline,
            temporaryRetentionPolicyVersion:
              MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
            title: "Temporary history",
            userId
          }
        });
        await tx.memoryDeletionOutbox.create({
          data: {
            memoryGeneration: MEMORY_TEMPORARY_DELETION_GENERATION,
            nextAttemptAt: deadline,
            operation: "TEMPORARY_DELETE",
            targetId: chat.id,
            targetType: MEMORY_TEMPORARY_DELETION_TARGET_TYPE,
            userId
          }
        });
        return chat;
      });
      const temporaryTurn = await createTurn({
        assistantText: "Temporary assistant text.",
        chatId: temporaryChat.id,
        createdAt: new Date("2026-08-10T15:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Temporary user text."
      });
      await mutateSource(userId, temporaryChat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: temporaryTurn.assistantMessage.id }
      });
      await mutateSource(userId, temporaryChat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: temporaryTurn.assistantMessage.id,
          runId: temporaryTurn.run.id,
          status: "complete"
        }
      });

      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.memoryDeletionOutbox.updateMany({
          data: {
            leaseExpiresAt: new Date(Date.now() + 60_000),
            leaseToken: "history-ineligible-cleanup",
            nextAttemptAt: null,
            state: "RUNNING"
          },
          where: { operation: "TEMPORARY_DELETE", userId }
        });
        await tx.chat.deleteMany({ where: { userId } });
        await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
        await tx.user.deleteMany({ where: { id: userId } });
      });
    }
  });

  it("persists no grounded assistant derivative while keeping later clean turns", async () => {
    const userId = await createOwner("memory-history-taint");
    try {
      const chat = await prisma.chat.create({
        data: { title: "History provenance", userId }
      });
      const groundedTurn = await createTurn({
        assistantText: "Grounded answer must not become reusable history.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T16:00:00.000Z"),
        grounded: true,
        parentMessageId: null,
        userId,
        userText: "Please search for this transient result."
      });
      const cleanTurn = await createTurn({
        assistantText: "Clean visible answer is eligible.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T16:05:00.000Z"),
        parentMessageId: groundedTurn.assistantMessage.id,
        userId,
        userText: "This direct follow-up is safe."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: cleanTurn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: cleanTurn.assistantMessage.id,
          runId: cleanTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);

      const chunks = await prisma.memoryRecallChunk.findMany({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.safeProjectedText).toContain("direct follow-up");
      expect(chunks[0]?.safeProjectedText).not.toContain("Grounded answer");
      expect(JSON.stringify(chunks)).not.toContain("transient result");
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("searches only current safe owned sources with scope-bound cursor pagination", async () => {
    const userId = await createOwner("memory-history-manual-search");
    const foreignUserId = await createOwner("memory-history-manual-search-foreign");
    try {
      const folder = await prisma.folder.create({
        data: { name: "Private infrastructure", userId }
      });
      const firstChat = await prisma.chat.create({
        data: { folderId: folder.id, title: "First private source", userId }
      });
      const firstTurn = await createTurn({
        assistantText: "Manual history marker alpha is confirmed.",
        chatId: firstChat.id,
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Manual history marker alpha belongs to this account."
      });
      await mutateSource(userId, firstChat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: firstTurn.assistantMessage.id }
      });
      await mutateSource(userId, firstChat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: firstTurn.assistantMessage.id,
          runId: firstTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);

      const secondChat = await prisma.chat.create({
        data: { title: "Second private source", userId }
      });
      const secondTurn = await createTurn({
        assistantText: "Manual history marker beta is confirmed.",
        chatId: secondChat.id,
        createdAt: new Date("2026-08-02T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Manual history marker beta belongs to this account."
      });
      await mutateSource(userId, secondChat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: secondTurn.assistantMessage.id }
      });
      await mutateSource(userId, secondChat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: secondTurn.assistantMessage.id,
          runId: secondTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);

      const foreignChat = await prisma.chat.create({
        data: { title: "Foreign private source", userId: foreignUserId }
      });
      const foreignTurn = await createTurn({
        assistantText: "Manual history marker foreign is confirmed.",
        chatId: foreignChat.id,
        createdAt: new Date("2026-08-03T10:00:00.000Z"),
        parentMessageId: null,
        userId: foreignUserId,
        userText: "Manual history marker foreign belongs elsewhere."
      });
      await mutateSource(foreignUserId, foreignChat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: foreignTurn.assistantMessage.id }
      });
      await mutateSource(foreignUserId, foreignChat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: foreignTurn.assistantMessage.id,
          runId: foreignTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(foreignUserId);

      const repository = createPrismaMemoryHistorySearchRepository(prisma);
      const baseInput: MemoryHistorySearchInput = {
        chatIds: [],
        cursor: null,
        folderId: null,
        from: null,
        pageSize: 1,
        query: "manual history marker",
        to: null
      };
      const firstPage = await repository.search(
        await repository.prepare(userId, baseInput),
        null
      );
      expect(firstPage.results).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.results[0]?.sourceChatId).not.toBe(foreignChat.id);

      const secondPageInput = { ...baseInput, cursor: firstPage.nextCursor };
      const secondPage = await repository.search(
        await repository.prepare(userId, secondPageInput),
        null
      );
      expect(secondPage.results).toHaveLength(1);
      expect(new Set([
        firstPage.results[0]?.sourceChatId,
        secondPage.results[0]?.sourceChatId
      ])).toEqual(new Set([firstChat.id, secondChat.id]));
      await expect(repository.prepare(userId, {
        ...secondPageInput,
        chatIds: [foreignChat.id]
      })).rejects.toEqual(new MemoryHistorySearchRepositoryError(
        "memory_contract_invalid"
      ));

      const folderOnly = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          folderId: folder.id,
          pageSize: 20
        }),
        null
      );
      expect(folderOnly.results.map((result) => result.sourceChatId))
        .toEqual([firstChat.id]);
      const foreignFolder = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          folderId: randomUUID(),
          pageSize: 20
        }),
        null
      );
      expect(foreignFolder.results).toEqual([]);
      const boundedTime = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          from: "2026-08-02T00:00:00.000Z",
          pageSize: 20,
          to: "2026-08-03T00:00:00.000Z"
        }),
        null
      );
      expect(boundedTime.results.map((result) => result.sourceChatId))
        .toEqual([secondChat.id]);

      await prisma.chat.update({
        data: { archived: true },
        where: { id: firstChat.id }
      });
      const archived = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          chatIds: [firstChat.id],
          pageSize: 20,
          query: "marker alpha"
        }),
        null
      );
      expect(archived.results).toMatchObject([{ sourceState: "ARCHIVED" }]);

      const firstChunk = await prisma.memoryRecallChunk.findFirstOrThrow({
        where: { chatId: firstChat.id, state: "ACTIVE", userId }
      });
      await prisma.memoryRecallChunk.update({
        data: {
          redactionReasonCodes: ["CONTACT_EMAIL_REDACTED"],
          redactionState: "REDACTED",
          safetyClass: "SENSITIVE"
        },
        where: { id: firstChunk.id }
      });
      const safelyRedacted = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          chatIds: [firstChat.id],
          pageSize: 20,
          query: "marker alpha"
        }),
        null
      );
      expect(safelyRedacted.results.map((result) => result.sourceChatId))
        .toEqual([firstChat.id]);
      await prisma.memoryRecallChunk.update({
        data: {
          redactionReasonCodes: [],
          redactionState: "NOT_NEEDED",
          safetyClass: "NORMAL"
        },
        where: { id: firstChunk.id }
      });

      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await prisma.memorySuppression.create({
        data: {
          deletionGeneration: settings.memoryGeneration,
          fingerprintKeyVersion: "history-search-test-v1",
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          scope: "SOURCE_MESSAGE",
          sourceBranchGeneration: firstChunk.branchGeneration,
          sourceChatId: firstChat.id,
          sourceMessageId: firstTurn.userMessage.id,
          userId
        }
      });
      const suppressed = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          chatIds: [firstChat.id],
          pageSize: 20,
          query: "marker alpha"
        }),
        null
      );
      expect(suppressed.results).toEqual([]);

      await prisma.memorySuppression.deleteMany({ where: { userId } });
      await mutateSource(userId, firstChat.id, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: firstTurn.assistantMessage.id }
      });
      const staleBranch = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          chatIds: [firstChat.id],
          pageSize: 20,
          query: "marker alpha"
        }),
        null
      );
      expect(staleBranch.results).toEqual([]);

      const absentSource = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          chatIds: [randomUUID()],
          pageSize: 20,
          query: "marker alpha"
        }),
        null
      );
      expect(absentSource.results).toEqual([]);

      await mutateSource(userId, secondChat.id, {
        mutations: ["SOURCE_EXCLUDE"],
        patch: { memoryMode: "EXCLUDED" }
      });
      const excluded = await repository.search(
        await repository.prepare(userId, {
          ...baseInput,
          chatIds: [secondChat.id],
          pageSize: 20,
          query: "marker beta"
        }),
        null
      );
      expect(excluded.results).toEqual([]);
      const evidence = Object.freeze({
        crossTenantLeakageCount: firstPage.results.filter((result) =>
          result.sourceChatId === foreignChat.id).length,
        evidenceVersion: "memory-phase4-manual-search-qualification-v1",
        excludedSourceHitCount: excluded.results.length,
        sanitizedAggregatesOnly: true,
        staleBranchHitCount: staleBranch.results.length,
        suppressedSourceHitCount: suppressed.results.length
      });
      expect(evidence).toEqual({
        crossTenantLeakageCount: 0,
        evidenceVersion: "memory-phase4-manual-search-qualification-v1",
        excludedSourceHitCount: 0,
        sanitizedAggregatesOnly: true,
        staleBranchHitCount: 0,
        suppressedSourceHitCount: 0
      });
      expect(JSON.stringify(evidence)).not.toContain(userId);
      expect(JSON.stringify(evidence)).not.toContain(foreignUserId);
      console.info("memory_phase4_manual_search_qualification", evidence);
    } finally {
      await cleanupOwner(foreignUserId);
      await cleanupOwner(userId);
    }
  });

  it("owns bounded history-tool receipts, replays settled calls, and fails safe on ambiguity", async () => {
    const userId = await createOwner("memory-history-tool-receipt");
    try {
      const chat = await prisma.chat.create({
        data: { title: "History tool receipts", userId }
      });
      const firstTurn = await createTurn({
        assistantText: "Receipt fixture answer",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T18:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Receipt fixture question"
      });
      const response: MemoryHistorySearchResponse = {
        indexing: {
          degradationCode: null,
          lexicalState: "READY",
          vectorState: "NOT_CONFIGURED"
        },
        nextCursor: null,
        results: [{
          indexingState: "LEXICAL_READY",
          itemType: "RECALL_CHUNK",
          occurredAt: "2026-08-10T17:00:00.000Z",
          sourceChatId: chat.id,
          sourceChatTitle: "History tool receipts",
          sourceFolderId: null,
          sourceFolderName: null,
          sourceMessageIds: [firstTurn.userMessage.id],
          sourceState: "AVAILABLE",
          snippet: "Receipt fixture question"
        }]
      };
      const search = vi.fn(async () => response);
      const executor = createMemoryHistoryToolExecutor({
        client: prisma,
        service: { search }
      });
      const calls = await Promise.all([0, 1, 2].map((ordinal) =>
        prisma.modelRunToolCall.create({
          data: {
            arguments: { query: `receipt query ${ordinal}` },
            modelRunId: firstTurn.run.id,
            ordinal,
            providerCallId: `history-tool-call-${ordinal}`,
            roundIndex: 0,
            toolName: MEMORY_HISTORY_SEARCH_TOOL_NAME
          }
        })
      ));
      const context = (persistedToolCallId: string) => ({
        persistedToolCallId,
        request: historyToolProviderRequest(chat.id),
        runId: firstTurn.run.id,
        userId
      });
      const call = (ordinal: number) => ({
        arguments: { query: `receipt query ${ordinal}` },
        id: `history-tool-call-${ordinal}`,
        name: MEMORY_HISTORY_SEARCH_TOOL_NAME
      });

      const first = await executor.execute(call(0), context(calls[0]!.id));
      expect(search).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({
        callId: "history-tool-call-0",
        content: [{
          value: expect.objectContaining({ results: response.results, untrusted: true })
        }],
        status: "complete"
      });
      expect(search).toHaveBeenNthCalledWith(1, userId, {
        chatIds: [],
        cursor: null,
        folderId: null,
        from: null,
        pageSize: 20,
        query: "receipt query 0",
        to: null
      });
      await expect(prisma.memoryHistoryRun.findUniqueOrThrow({
        where: { modelRunToolCallId: calls[0]!.id }
      })).resolves.toMatchObject({
        invocationOrdinal: 1,
        modelRunId: firstTurn.run.id,
        outcome: "RESULTS",
        query: "receipt query 0",
        resultCount: 1,
        retentionState: "RETAINED",
        state: "COMPLETE",
        userId
      });

      await expect(executor.execute(call(0), context(calls[0]!.id))).resolves.toEqual(first);
      expect(search).toHaveBeenCalledTimes(1);
      await expect(executor.execute(call(1), context(calls[1]!.id))).resolves.toMatchObject({
        status: "complete"
      });
      expect(search).toHaveBeenCalledTimes(2);
      await expect(executor.execute(call(2), context(calls[2]!.id))).resolves.toMatchObject({
        content: [{ value: { error: "memory_history_call_limit" } }],
        status: "error"
      });
      expect(search).toHaveBeenCalledTimes(2);
      await expect(prisma.memoryHistoryRun.count({
        where: { modelRunId: firstTurn.run.id }
      })).resolves.toBe(2);

      const ambiguousTurn = await createTurn({
        assistantText: "Ambiguous receipt answer",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T18:01:00.000Z"),
        parentMessageId: firstTurn.assistantMessage.id,
        userId,
        userText: "Ambiguous receipt question"
      });
      const ambiguousCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { query: "ambiguous query" },
          modelRunId: ambiguousTurn.run.id,
          ordinal: 0,
          providerCallId: "history-tool-call-ambiguous",
          roundIndex: 0,
          state: "running",
          toolName: MEMORY_HISTORY_SEARCH_TOOL_NAME
        }
      });
      await prisma.memoryHistoryRun.create({
        data: {
          indexingEvidence: {},
          invocationOrdinal: 1,
          modelRunId: ambiguousTurn.run.id,
          modelRunToolCallId: ambiguousCall.id,
          privateRequest: {
            chatIds: [],
            cursor: null,
            folderId: null,
            from: null,
            pageSize: 20,
            query: "ambiguous query",
            to: null
          },
          query: "ambiguous query",
          queryHash: memorySha256("ambiguous query"),
          userId
        }
      });
      await expect(executor.execute({
        arguments: { query: "ambiguous query" },
        id: "history-tool-call-ambiguous",
        name: MEMORY_HISTORY_SEARCH_TOOL_NAME
      }, {
        persistedToolCallId: ambiguousCall.id,
        request: historyToolProviderRequest(chat.id),
        runId: ambiguousTurn.run.id,
        userId
      })).resolves.toMatchObject({
        content: [{ value: { error: "memory_history_outcome_unknown" } }],
        status: "error"
      });
      expect(search).toHaveBeenCalledTimes(2);

      await expect(executor.execute(call(0), {
        ...context(calls[0]!.id),
        userId: "foreign-user"
      })).resolves.toMatchObject({
        content: [{ value: { error: "memory_history_authorization_missing" } }],
        status: "error"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("cancels and scrubs an in-flight history result before a source purge can race it", async () => {
    const userId = await createOwner("memory-history-tool-purge-race");
    try {
      const chat = await prisma.chat.create({
        data: { title: "History purge race", userId }
      });
      const turn = await createTurn({
        assistantText: "Race fixture answer",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T18:30:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Race fixture question"
      });
      const toolCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { query: "private race query" },
          modelRunId: turn.run.id,
          ordinal: 0,
          providerCallId: "history-tool-call-purge-race",
          roundIndex: 0,
          toolName: MEMORY_HISTORY_SEARCH_TOOL_NAME
        }
      });
      let releaseSearch!: (response: MemoryHistorySearchResponse) => void;
      let markSearchStarted!: () => void;
      const searchStarted = new Promise<void>((resolve) => {
        markSearchStarted = resolve;
      });
      const searchResult = new Promise<MemoryHistorySearchResponse>((resolve) => {
        releaseSearch = resolve;
      });
      const executor = createMemoryHistoryToolExecutor({
        client: prisma,
        service: {
          search: vi.fn(() => {
            markSearchStarted();
            return searchResult;
          })
        }
      });
      const execution = executor.execute({
        arguments: { query: "private race query" },
        id: "history-tool-call-purge-race",
        name: MEMORY_HISTORY_SEARCH_TOOL_NAME
      }, {
        persistedToolCallId: toolCall.id,
        request: historyToolProviderRequest(chat.id),
        runId: turn.run.id,
        userId
      });
      await searchStarted;

      await prisma.$transaction((tx) =>
        purgeMemoryHistoryReceiptDerivatives(tx, userId, {
          chatId: chat.id,
          kind: "SOURCE"
        })
      );
      releaseSearch({
        indexing: {
          degradationCode: null,
          lexicalState: "READY",
          vectorState: "NOT_CONFIGURED"
        },
        nextCursor: null,
        results: [{
          indexingState: "LEXICAL_READY",
          itemType: "RECALL_CHUNK",
          occurredAt: "2026-08-10T18:30:00.000Z",
          sourceChatId: chat.id,
          sourceChatTitle: "History purge race",
          sourceFolderId: null,
          sourceFolderName: null,
          sourceMessageIds: [turn.userMessage.id],
          sourceState: "AVAILABLE",
          snippet: "PRIVATE_PURGE_RACE_CANARY"
        }]
      });

      await expect(execution).resolves.toMatchObject({
        content: [{ value: { error: "memory_history_receipt_scrubbed" } }],
        status: "error"
      });
      await expect(prisma.memoryHistoryRun.findUniqueOrThrow({
        where: { modelRunToolCallId: toolCall.id }
      })).resolves.toMatchObject({
        outcome: "FAILED",
        privateRequest: {},
        providerResult: null,
        query: null,
        results: null,
        retentionState: "SCRUBBED",
        state: "CANCELLED"
      });
      await expect(prisma.modelRunToolCall.findUniqueOrThrow({
        where: { id: toolCall.id }
      })).resolves.toMatchObject({
        arguments: {},
        state: "error"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("persists owner-scoped egress dispatch evidence without request plaintext", async () => {
    const userId = await createOwner("memory-egress-receipts");
    const foreignUserId = await createOwner("memory-egress-receipts-foreign");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Egress receipts", userId }
      });
      const turn = await createTurn({
        assistantText: "Receipt answer",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T19:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Receipt request"
      });
      const toolCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { value: "alpha" },
          modelRunId: turn.run.id,
          ordinal: 0,
          providerCallId: "egress-receipt-tool-call",
          roundIndex: 0,
          toolName: "mcp_external_submit"
        }
      });
      const service = createMemoryToolEgressReceiptService(prisma);
      const destinationSnapshot = {
        fingerprint: "egress-fingerprint",
        kind: "mcp",
        serverId: "egress-server",
        toolName: "mcp_external_submit",
        version: 1
      } as const;
      const directCanary = "DIRECT_REQUEST_PLAINTEXT_CANARY";
      const previewCanary = "REQUEST_PREVIEW_PLAINTEXT_CANARY";
      const first = await service.beginDispatch({
        destinationKind: "mcp",
        destinationSnapshot,
        mode: "TOOL_CALL",
        modelRunToolCallId: toolCall.id,
        requestEvidence: { current: directCanary },
        requestPreview: { private: previewCanary },
        runId: turn.run.id,
        userId
      });
      expect(first.requestOrdinal).toBe(1);
      await expect(service.beginDispatch({
        destinationKind: "mcp",
        destinationSnapshot,
        mode: "TOOL_CALL",
        modelRunToolCallId: toolCall.id,
        requestEvidence: { changed: directCanary },
        requestPreview: { changed: previewCanary },
        runId: turn.run.id,
        userId
      })).resolves.toEqual(first);
      await expect(service.completeDispatch(first.id)).resolves.toBe(true);
      await expect(service.completeDispatch(first.id)).resolves.toBe(false);

      const blocked = await service.recordBlockedDispatch({
        destinationKind: "answer_provider",
        destinationSnapshot: { modelId: "unavailable", provider: "test", version: 1 },
        errorCode: "memory_egress_destination_revoked",
        mode: "PROVIDER_REQUEST",
        requestEvidence: { current: directCanary },
        requestPreview: { private: previewCanary },
        runId: turn.run.id,
        userId
      });
      expect(blocked.requestOrdinal).toBe(2);
      const providerDispatch = await service.beginDispatch({
        destinationKind: "answer_provider",
        destinationSnapshot: {
          modelId: "history-test-model",
          provider: "history-test-provider",
          version: 1
        },
        mode: "PROVIDER_REQUEST",
        requestEvidence: { current: directCanary },
        requestPreview: { private: previewCanary },
        runId: turn.run.id,
        userId
      });
      expect(providerDispatch.requestOrdinal).toBe(3);
      await expect(service.settleRecoveredProviderDispatch({
        errorCode: "provider_dispatch_failed",
        outcome: "FAILED",
        runId: turn.run.id,
        userId
      })).resolves.toBe(true);
      await expect(service.settleRecoveredProviderDispatch({
        errorCode: "provider_dispatch_failed",
        outcome: "FAILED",
        runId: turn.run.id,
        userId
      }))
        .resolves.toBe(true);

      await expect(service.beginDispatch({
        destinationKind: "mcp",
        destinationSnapshot,
        mode: "PROVIDER_REQUEST",
        requestEvidence: {},
        runId: turn.run.id,
        userId: foreignUserId
      })).rejects.toThrow("memory_egress_run_not_found");
      await expect(service.beginDispatch({
        destinationKind: "mcp",
        destinationSnapshot: { payload: "x".repeat(33 * 1024) },
        mode: "PROVIDER_REQUEST",
        requestEvidence: {},
        runId: turn.run.id,
        userId
      })).rejects.toThrow("memory_egress_destination_too_large");

      const receipts = await prisma.memoryToolEgressReceipt.findMany({
        orderBy: { requestOrdinal: "asc" },
        where: { modelRunId: turn.run.id }
      });
      expect(receipts).toEqual([
        expect.objectContaining({
          destinationFingerprint: memorySha256(destinationSnapshot),
          dispatchState: "COMPLETED",
          mode: "TOOL_CALL",
          modelRunToolCallId: toolCall.id,
          requestOrdinal: 1,
          requestEvidenceHash: memorySha256({ current: directCanary }),
          userId
        }),
        expect.objectContaining({
          dispatchState: "BLOCKED",
          errorCode: "memory_egress_destination_revoked",
          mode: "PROVIDER_REQUEST",
          requestOrdinal: 2,
          requestEvidenceHash: memorySha256({ current: directCanary })
        }),
        expect.objectContaining({
          dispatchState: "FAILED",
          errorCode: "provider_dispatch_failed",
          mode: "PROVIDER_REQUEST",
          requestOrdinal: 3
        })
      ]);
      expect(JSON.stringify(receipts)).not.toContain(directCanary);
      expect(JSON.stringify(receipts)).not.toContain(previewCanary);
    } finally {
      await cleanupOwner(foreignUserId);
      await cleanupOwner(userId);
    }
  });
});
