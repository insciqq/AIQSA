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
  loadMemorySourceSnapshot,
  lockMemorySourceChat
} from "../sourceState";
import { createPrismaMemoryHistoryIndexHandler } from "./handler";
import type { MemoryHistorySafetyClassifier } from "./classifier";
import { memorySha256 } from "../persistence/lexical";
import { memoryHistoryChunkSourceAuthorityPredicate } from "../persistence/pauseIntervals";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_TEMPORARY_DELETION_GENERATION,
  MEMORY_TEMPORARY_DELETION_TARGET_TYPE
} from "../temporaryRetention";
import { createMemoryToolEgressReceiptService } from "../egress/receipts";
import {
  MEMORY_HISTORY_BACKFILL_WINDOW,
  readMemoryHistoryIndexingProgress,
  seedMemoryHistoryBackfill
} from "./backfill";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "./contract";
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


function executionContext(now: Date) {
  return {
    now: () => now,
    setStage: async (_stage: string) => undefined,
    signal: new AbortController().signal
  };
}

const normalHistoryClassifier: MemoryHistorySafetyClassifier = {
  classify: async (chunks) => ({
    decisions: chunks.map((chunk) => ({
      chunkId: chunk.id,
      sensitivity: "NORMAL" as const
    })),
    policyVersion: "memory-history-safety-policy-test"
  })
};

async function processHistoryJob(userId: string) {
  const claim = await claimHistoryJob(userId);
  const handler = createPrismaMemoryHistoryIndexHandler(prisma, normalHistoryClassifier);
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

async function seedHistoryBackfill(userId: string) {
  return withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    seedMemoryHistoryBackfill(tx, settings));
}

describe("Memory lexical history index persistence", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("explicitly backfills retained chats newest-first through a bounded idempotent window", async () => {
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
      // Backfill is now an explicit rebuild action; toggling the setting alone
      // must not replay chats written while history was off.
      await seedHistoryBackfill(userId);

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
        await seedHistoryBackfill(userId);
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
        where: { kind: "EXTRACT_FACTS", userId }
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
      const catchupCreatedAt = new Date(Date.now() + 60_000);
      const catchupTurn = await createTurn({
        assistantText: "Catch-up assistant",
        chatId: catchupChat.id,
        createdAt: catchupCreatedAt,
        parentMessageId: null,
        userId,
        userText: "Catch-up user"
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: catchupTurn.assistantMessage.id,
          updatedAt: new Date(catchupCreatedAt.getTime() + 1_000)
        },
        where: { id: catchupChat.id }
      });
      await seedHistoryBackfill(userId);
      await seedHistoryBackfill(userId);
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

  it("reindexes a legacy READY checkpoint once and marks a classified zero-chunk result current", async () => {
    const userId = await createOwner("memory-history-checkpoint-upgrade");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Legacy history checkpoint", userId }
      });
      const turn = await createTurn({
        assistantText: "Legacy private history response.",
        chatId: chat.id,
        createdAt: new Date("2026-08-20T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Legacy private history input."
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: turn.assistantMessage.id },
        where: { id: chat.id }
      });
      const source = await loadMemorySourceSnapshot(prisma, {
        chatId: chat.id,
        lock: "NONE",
        personalOnly: true,
        userId
      });
      if (!source?.activeLeafMessageId) {
        throw new Error("memory_history_upgrade_source_missing");
      }
      await prisma.chatMemoryCheckpoint.create({
        data: {
          activeLeafMessageId: source.activeLeafMessageId,
          branchGeneration: source.memoryBranchGeneration,
          chatId: source.id,
          lastIndexedMessageId: source.activeLeafMessageId,
          lastSucceededAt: new Date("2026-08-20T10:01:00.000Z"),
          pipelineVersion: "memory-history-index-v1",
          sourceContentHash: source.sourceHash,
          sourceRevision: source.memorySourceRevision,
          status: "READY",
          userId
        }
      });

      await expect(readMemoryHistoryIndexingProgress(prisma, userId, true)).resolves.toMatchObject({
        completedChats: 0,
        state: "INDEXING",
        totalChats: 1
      });
      await expect(seedHistoryBackfill(userId)).resolves.toMatchObject({
        activeJobs: 0,
        enqueuedJobs: 1
      });
      const claim = await claimHistoryJob(userId);
      expect(claim.pipelineVersion).toBe(MEMORY_HISTORY_INDEX_PIPELINE_VERSION);
      const secretClassifier: MemoryHistorySafetyClassifier = {
        classify: async (chunks) => ({
          decisions: chunks.map((chunk) => ({
            chunkId: chunk.id,
            sensitivity: "SECRET" as const
          })),
          policyVersion: "memory-history-safety-policy-upgrade-test"
        })
      };
      const handler = createPrismaMemoryHistoryIndexHandler(prisma, secretClassifier);
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

      await expect(prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      })).resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
        status: "READY"
      });
      await expect(seedHistoryBackfill(userId)).resolves.toMatchObject({
        activeJobs: 0,
        enqueuedJobs: 0
      });
      await expect(readMemoryHistoryIndexingProgress(prisma, userId, true)).resolves.toMatchObject({
        completedChats: 1,
        state: "READY",
        totalChats: 1
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each(["HISTORY_INDEX", "ALL_REUSABLE"] as const)(
    "does not backfill retained chats behind a populated %s barrier",
    async (barrierKind) => {
    const userId = await createOwner(`memory-history-${barrierKind.toLowerCase()}-barrier`);
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
          kind: barrierKind,
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
      await seedHistoryBackfill(userId);
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUnique({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toBeNull();
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
      await seedHistoryBackfill(userId);
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUnique({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toBeNull();
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each(["MASTER", "SEARCH_HISTORY"] as const)(
    "retains A, excludes B, admits C, and preserves the split through forced %s reindex",
    async (pauseScope) => {
      const userId = await createOwner(`memory-history-abc-${pauseScope.toLowerCase()}`);
      const pausedAt = new Date("2026-08-21T10:10:00.000Z");
      const resumedAt = new Date("2026-08-21T10:20:00.000Z");
      let settingsNow = pausedAt;
      const settingsRepository = createPrismaMemorySettingsRepository(prisma, {
        now: () => settingsNow
      });
      try {
        const chat = await prisma.chat.create({
          data: { title: `A B C ${pauseScope}`, userId }
        });
        const turnA = await createTurn({
          assistantText: "A-before assistant retained marker.",
          chatId: chat.id,
          createdAt: new Date("2026-08-21T10:00:00.000Z"),
          parentMessageId: null,
          userId,
          userText: "A-before user retained marker."
        });
        await mutateSource(userId, chat.id, {
          mutations: ["NORMAL_APPEND"],
          patch: { activeLeafMessageId: turnA.assistantMessage.id }
        });
        await mutateSource(userId, chat.id, {
          mutations: ["TERMINAL_SETTLEMENT"],
          terminalSettlement: {
            assistantMessageId: turnA.assistantMessage.id,
            runId: turnA.run.id,
            status: "complete"
          }
        });
        await processHistoryJob(userId);
        const retainedA = await prisma.memoryRecallChunk.findFirstOrThrow({
          where: { chatId: chat.id, state: "ACTIVE", userId }
        });
        expect(retainedA.safeProjectedText).toContain("A-before user retained marker");

        const beforePause = await prisma.userMemorySettings.findUniqueOrThrow({
          where: { userId }
        });
        const paused = await settingsRepository.patch(userId, {
          expectedMemoryRevision: beforePause.memoryRevision,
          expectedSettingsRevision: beforePause.settingsRevision,
          ...(pauseScope === "MASTER"
            ? { useMemoryFacts: false }
            : { referenceChatHistory: false })
        });
        const turnB = await createTurn({
          assistantText: "B-during assistant excluded marker.",
          chatId: chat.id,
          createdAt: new Date("2026-08-21T10:12:00.000Z"),
          parentMessageId: turnA.assistantMessage.id,
          userId,
          userText: "B-during user excluded marker."
        });
        await mutateSource(userId, chat.id, {
          mutations: ["NORMAL_APPEND"],
          patch: { activeLeafMessageId: turnB.assistantMessage.id }
        });
        await mutateSource(userId, chat.id, {
          mutations: ["TERMINAL_SETTLEMENT"],
          terminalSettlement: {
            assistantMessageId: turnB.assistantMessage.id,
            runId: turnB.run.id,
            status: "complete"
          }
        });
        await expect(prisma.memoryRecallChunk.findUniqueOrThrow({
          where: { id: retainedA.id }
        })).resolves.toMatchObject({ state: "ACTIVE" });
        await expect(prisma.memoryJob.count({
          where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
        })).resolves.toBe(0);

        settingsNow = resumedAt;
        await settingsRepository.patch(userId, {
          expectedMemoryRevision: paused.memoryRevision,
          expectedSettingsRevision: paused.settingsRevision,
          ...(pauseScope === "MASTER"
            ? { useMemoryFacts: true }
            : { referenceChatHistory: true })
        });
        await expect(prisma.memoryPauseInterval.findFirstOrThrow({
          where: { scope: pauseScope, userId }
        })).resolves.toMatchObject({ pausedAt, resumedAt });
        const visibleAfterResume = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chunk."id"
          FROM "MemoryRecallChunk" AS chunk
          WHERE chunk."userId" = ${userId}
            AND chunk."id" = ${retainedA.id}
            AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
            AND ${memoryHistoryChunkSourceAuthorityPredicate()}
        `);
        expect(visibleAfterResume).toEqual([{ id: retainedA.id }]);

        await expect(seedHistoryBackfill(userId)).resolves.toMatchObject({
          enqueuedJobs: 1
        });
        await processHistoryJob(userId);
        const afterBReindex = await prisma.memoryRecallChunk.findMany({
          where: { chatId: chat.id, state: "ACTIVE", userId }
        });
        expect(afterBReindex).toHaveLength(1);
        expect(afterBReindex[0]?.safeProjectedText).toContain(
          "A-before user retained marker"
        );
        expect(afterBReindex[0]?.safeProjectedText).not.toContain(
          "B-during user excluded marker"
        );

        const turnC = await createTurn({
          assistantText: "C-after assistant admitted marker.",
          chatId: chat.id,
          createdAt: new Date("2026-08-21T10:22:00.000Z"),
          parentMessageId: turnB.assistantMessage.id,
          userId,
          userText: "C-after user admitted marker."
        });
        await mutateSource(userId, chat.id, {
          mutations: ["NORMAL_APPEND"],
          patch: { activeLeafMessageId: turnC.assistantMessage.id }
        });
        await mutateSource(userId, chat.id, {
          mutations: ["TERMINAL_SETTLEMENT"],
          terminalSettlement: {
            assistantMessageId: turnC.assistantMessage.id,
            runId: turnC.run.id,
            status: "complete"
          }
        });
        await processHistoryJob(userId);

        const assertSplitAC = async () => {
          const chunks = await prisma.memoryRecallChunk.findMany({
            orderBy: { chunkOrdinal: "asc" },
            where: { chatId: chat.id, state: "ACTIVE", userId }
          });
          expect(chunks).toHaveLength(2);
          expect(chunks.map(({ safeProjectedText }) => safeProjectedText)).toEqual([
            expect.stringContaining("A-before user retained marker"),
            expect.stringContaining("C-after user admitted marker")
          ]);
          expect(chunks.map(({ safeProjectedText }) => safeProjectedText).join("\n"))
            .not.toContain("B-during user excluded marker");
          return chunks;
        };
        const currentChunks = await assertSplitAC();

        // Force the same full-source projection to run again. This exercises
        // rebuild admission rather than relying on the already-stored A/C rows.
        await prisma.$transaction(async (tx) => {
          await tx.memorySearchEntry.deleteMany({
            where: { recallChunkId: { in: currentChunks.map(({ id }) => id) }, userId }
          });
          await tx.chatMemoryCheckpoint.update({
            data: { status: "STALE" },
            where: { userId_chatId: { chatId: chat.id, userId } }
          });
        });
        await expect(seedHistoryBackfill(userId)).resolves.toMatchObject({
          enqueuedJobs: 1
        });
        await processHistoryJob(userId);
        await assertSplitAC();
        await expect(prisma.memorySearchEntry.count({
          where: { itemType: "RECALL_CHUNK", userId }
        })).resolves.toBe(2);
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it("continues past terminal failures without retrying them after history is re-enabled", async () => {
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

      await seedHistoryBackfill(userId);
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

      await seedHistoryBackfill(userId);
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
      await repository.patch(userId, {
        expectedMemoryRevision: disabled.memoryRevision,
        expectedSettingsRevision: disabled.settingsRevision,
        referenceChatHistory: true
      });
      await seedHistoryBackfill(userId);
      await expect(prisma.memoryJob.count({
        where: {
          id: { in: initialWindow.map(({ id }) => id) },
          state: "QUEUED",
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: {
          id: { in: initialWindow.map(({ id }) => id) },
          state: "TERMINAL_FAILED",
          userId
        }
      })).resolves.toBe(MEMORY_HISTORY_BACKFILL_WINDOW);
      await expect(prisma.memoryJob.count({
        where: {
          kind: "INDEX_HISTORY",
          state: "QUEUED",
          userId
        }
      })).resolves.toBe(2);
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
        evidenceVersion: "memory-history-qualification-v1",
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
      console.info("memory_history_qualification", evidence);

      const lexical = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT entry."id"
        FROM "MemorySearchEntry" AS entry
        WHERE entry."userId" = ${userId}
          AND entry."indexGenerationId" = ${generation.id}
          AND entry."searchVectorSimple" @@ plainto_tsquery('simple', 'кофе')
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

  it("indexes eligible recall chunks", async () => {
    const userId = await createOwner("memory-history-chunks");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Chunk-only episodic history", userId }
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

      const chunks = await prisma.memoryRecallChunk.findMany({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.safeProjectedText).toContain("сине-зелёное развёртывание");
      await expect(prisma.memorySearchEntry.count({
        where: {
          itemType: "RECALL_CHUNK",
          recallChunkId: chunks[0]?.id,
          userId
        }
      })).resolves.toBe(1);
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
      const handler = createPrismaMemoryHistoryIndexHandler(prisma, normalHistoryClassifier);
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

  it("keeps Resume forward-only without crossing history cutoffs or suppressions", async () => {
    const userId = await createOwner("memory-history-resume");
    try {
      const resumeBoundary = Date.now();
      const chat = await prisma.chat.create({
        data: { title: "History resume", userId }
      });
      const oldTurn = await createTurn({
        assistantText: "Old assistant text must stay behind the cutoff.",
        chatId: chat.id,
        createdAt: new Date(resumeBoundary - 120_000),
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
      const cutoff = new Date(resumeBoundary - 60_000);
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

      await expect(prisma.memoryRecallChunk.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryIndexGeneration.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({
        lastErrorCode: null,
        resumeCreatedAtCutoff: expect.any(Date),
        status: "STALE"
      });

      const newTurn = await createTurn({
        assistantText: "Fresh assistant text is eligible.",
        chatId: chat.id,
        createdAt: new Date(resumeBoundary + 60_000),
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
        createdAt: new Date(resumeBoundary + 120_000),
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

  it("retains visible assistant text after normal runtime sources without raw payloads", async () => {
    const userId = await createOwner("memory-history-taint");
    try {
      const chat = await prisma.chat.create({
        data: { title: "History provenance", userId }
      });
      const groundedTurn = await createTurn({
        assistantText: "Grounded answer remains visible past-chat context.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T16:00:00.000Z"),
        grounded: true,
        parentMessageId: null,
        userId,
        userText: "Please search with my attached context."
      });
      const attachmentId = `history-runtime-attachment-${randomUUID()}`;
      await prisma.message.update({
        data: {
          content: {
            blocks: [
              { text: "Please search with my attached context.", type: "text" },
              {
                attachmentId,
                fileName: "context.txt",
                type: "file"
              }
            ]
          }
        },
        where: { id: groundedTurn.userMessage.id }
      });
      await prisma.attachment.create({
        data: {
          byteSize: 32,
          chatId: chat.id,
          extractedText: "RAW_ATTACHMENT_CONTENT_MUST_NOT_BE_INDEXED",
          fileName: "context.txt",
          id: attachmentId,
          kind: "document",
          messageId: groundedTurn.userMessage.id,
          metadata: {},
          mimeType: "text/plain",
          status: "ready",
          storageKey: `${userId}/history-runtime-attachment`,
          userId
        }
      });
      await prisma.searchRun.create({
        data: {
          artifacts: { private: "RAW_SEARCH_RESULT_MUST_NOT_BE_INDEXED" },
          modelRunId: groundedTurn.run.id,
          provider: "history-test-search",
          status: "complete",
          strategyId: "history-test-search"
        }
      });
      const knowledgeToolCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { private: "RAW_KNOWLEDGE_QUERY_MUST_NOT_BE_INDEXED" },
          modelRunId: groundedTurn.run.id,
          ordinal: 0,
          providerCallId: "history-knowledge-call",
          roundIndex: 0,
          state: "complete",
          toolName: "knowledge_search"
        }
      });
      await prisma.knowledgeRun.create({
        data: {
          baseEvidence: [{ baseName: "History runtime Base", ordinal: 0 }],
          candidateCount: 1,
          candidateLimit: 1,
          durationMs: 1,
          embeddingUsage: [],
          fusion: "rrf_k60",
          invocationOrdinal: 1,
          modelRunId: groundedTurn.run.id,
          modelRunToolCallId: knowledgeToolCall.id,
          outcome: "complete",
          providerText: "RAW_KNOWLEDGE_RESULT_MUST_NOT_BE_INDEXED",
          query: "private knowledge query",
          resultLimit: 1,
          results: [{ handle: "K1" }]
        }
      });
      await prisma.modelRunToolCall.create({
        data: {
          arguments: { private: "RAW_TOOL_ARGUMENTS_MUST_NOT_BE_INDEXED" },
          modelRunId: groundedTurn.run.id,
          ordinal: 1,
          providerCallId: "history-tool-call",
          result: { private: "RAW_TOOL_RESULT_MUST_NOT_BE_INDEXED" },
          roundIndex: 0,
          state: "complete",
          toolName: "mcp_history_test"
        }
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const memoryContext = "RAW_RETRIEVED_MEMORY_MUST_NOT_BE_INDEXED";
      await prisma.$transaction(async (tx) => {
        const retrievalAttempt = await tx.memoryRetrievalAttempt.create({
          data: {
            admissionKind: "NORMAL_SEND",
            admittedAssistantLeafMessageId: groundedTurn.assistantMessage.id,
            admittedUserMessageId: groundedTurn.userMessage.id,
            attemptOrdinal: 0,
            baseRequestHash: memorySha256({ type: "history-runtime-base" }),
            boundedPrivateBaseRequestSnapshot: {},
            chatId: chat.id,
            chatMemoryModeSnapshot: "NORMAL",
            consumedAt: new Date("2026-08-10T16:01:00.000Z"),
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            memoryGenerationSnapshot: settings.memoryGeneration,
            modelRunId: groundedTurn.run.id,
            outcome: "USED",
            preparedContextHash: memorySha256(memoryContext),
            preparedContextText: memoryContext,
            preparedContextTokenCount: 8,
            queryHash: memorySha256("history runtime memory"),
            retrievalRevisionSnapshot: settings.memoryRevision,
            settingsSnapshot: {},
            state: "CONSUMED",
            userId,
            utilityEgressMode: "LOCAL_ONLY"
          }
        });
        await tx.modelRunMemoryBinding.create({
          data: {
            boundedSafeQuerySnapshot: "history runtime memory",
            contextTextHash: memorySha256(memoryContext),
            contextTokenCount: 8,
            finalizedAt: new Date("2026-08-10T16:01:00.000Z"),
            finalizedRevisionSnapshot: settings.memoryRevision,
            memoryGenerationSnapshot: settings.memoryGeneration,
            modelRunId: groundedTurn.run.id,
            outcome: "USED",
            queryHash: memorySha256("history runtime memory"),
            queryPlannerVersion: "history-runtime-query-v1",
            retrievalAttemptId: retrievalAttempt.id,
            retrievalPipelineVersion: "history-runtime-retrieval-v1",
            retrievalRevisionSnapshot: settings.memoryRevision,
            settingsSnapshot: {},
            userId
          }
        });
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
      expect(chunks[0]?.safeProjectedText).toContain("attached context");
      expect(chunks[0]?.safeProjectedText).toContain("Grounded answer remains visible");
      expect(chunks[0]?.safeProjectedText).toContain("direct follow-up");
      expect(chunks[0]?.safeProjectedText).toContain("Clean visible answer is eligible");
      expect(JSON.stringify(chunks)).not.toContain("RAW_");
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
