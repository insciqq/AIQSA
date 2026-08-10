import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../../contracts/memory";
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
  decodeMemoryEpisodeExtraction,
  MEMORY_EPISODE_TOOL_NAME,
  createPrismaMemoryEpisodeRepository
} from "./episode";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_TEMPORARY_DELETION_GENERATION,
  MEMORY_TEMPORARY_DELETION_TARGET_TYPE
} from "../temporaryRetention";

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
      await prisma.user.deleteMany({ where: { id: userId } });
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
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
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
      await prisma.user.deleteMany({ where: { id: userId } });
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
      await prisma.user.deleteMany({ where: { id: userId } });
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
      await prisma.user.deleteMany({ where: { id: userId } });
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
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
