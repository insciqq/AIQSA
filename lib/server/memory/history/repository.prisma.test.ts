import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import {
  fuseMemoryRetrievalCandidates,
  packMemoryPersonalContext,
  planMemoryRetrieval
} from "../../../domain/memory/retrieval";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../coordinator/types";
import { createPrismaMemoryRetrievalCutoverRepository } from "../cutover/repository";
import { createPrismaMemoryItemEmbeddingRepository } from "../embedding/repository";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";
import {
  applyMemorySourceMutations,
  loadMemorySourceSnapshot,
  lockMemorySourceChat
} from "../sourceState";
import { createPrismaMemoryHistoryIndexHandler } from "./handler";
import type { MemoryHistorySafetyClassifier } from "./classifier";
import {
  decodeMemoryChatDigest,
  materializeMemoryChatDigest,
  type MemoryChatDigestGenerator
} from "./digest";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
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
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION,
  memoryHistoryIndexJobFingerprint
} from "./contract";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { createPrismaMemoryHistoryIndexRepository } from "./repository";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";
import { resolvePreparingMemoryItem } from "../../runs/preparingMemoryItems";
import { memoryRelevanceCandidates } from "../retrieval/runAdmission";
import { memoryDedicatedRerankDocument } from "../retrieval/runUtilities";
import { createPrismaLocalMemoryRetrievalRepository } from
  "../retrieval/localRepository";
import {
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
  createPrismaMemoryVectorRepository
} from "../retrieval/vector";
import { createMemoryRebuildHandler } from "../rebuild/handler";
import { createPrismaMemoryRebuildRepository } from "../rebuild/repository";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from "./segments";
import { MEMORY_TOOL_EVENT_PROJECTION_VERSION } from "./toolEvents";

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
    sourceMessageId: claimed.sourceMessageId,
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    targetFactVersionId: claimed.targetFactVersionId,
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

async function processHistoryJob(
  userId: string,
  options: Readonly<{
    classifier?: MemoryHistorySafetyClassifier;
    digestGenerator?: MemoryChatDigestGenerator;
  }> = {}
) {
  const claim = await claimHistoryJob(userId);
  const handler = createPrismaMemoryHistoryIndexHandler(
    prisma,
    options.classifier ?? normalHistoryClassifier,
    options.digestGenerator ? { digestGenerator: options.digestGenerator } : {}
  );
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

async function processRebuildJob(userId: string, jobId: string): Promise<void> {
  const now = new Date();
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED",
      updatedAt: now
    },
    where: { id: jobId }
  });
  const claim: MemoryJobClaim = {
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
    sourceMessageId: claimed.sourceMessageId,
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    targetFactVersionId: claimed.targetFactVersionId,
    userId
  };
  const handler = createMemoryRebuildHandler(
    createPrismaMemoryRebuildRepository(prisma)
  );
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const result = await handler.execute(claim, executionContext(now));
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  })).resolves.toBe(true);
}

const deterministicDigestGenerator: MemoryChatDigestGenerator = Object.freeze({
  async generate(source, chunks, options) {
    if (chunks.length === 0) {
      return {
        classificationRequired: false,
        digest: null,
        executions: [],
        policyVersion: "memory-chat-digest-policy-test",
        work: {
          digestSegmentsProcessed: 0,
          digestSourceChunksProcessed: 0
        }
      };
    }
    return {
      classificationRequired: true,
      digest: materializeMemoryChatDigest({
        chunks,
        content: decodeMemoryChatDigest({
          decisions: ["Keep the selected deployment approach."],
          open_loops: ["Confirm the rollout date."],
          summary: "The chat selected a deployment approach.",
          topics: ["Deployment"]
        }),
        source,
        timeZone: options.timeZone
      }),
      executions: [],
      policyVersion: "memory-chat-digest-policy-test",
      work: {
        digestSegmentsProcessed: 1,
        digestSourceChunksProcessed: chunks.length
      }
    };
  }
});

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

  it("reindexes a legacy READY checkpoint locally despite a legacy classifier result", async () => {
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
      })).resolves.toBe(1);
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

      const lexical = await prisma.$queryRaw<Array<{
        id: string;
        itemType: "RECALL_CHUNK" | "RECALL_ROUND";
      }>>(Prisma.sql`
        SELECT entry."id", entry."itemType"::text AS "itemType"
        FROM "MemorySearchEntry" AS entry
        WHERE entry."userId" = ${userId}
          AND entry."indexGenerationId" = ${generation.id}
          AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
          AND entry."searchVectorSimple" @@ plainto_tsquery('simple', 'кофе')
      `);
      expect(lexical).toHaveLength(2);
      expect(lexical).toEqual(expect.arrayContaining([
        { id: entries[0]!.id, itemType: "RECALL_CHUNK" },
        { id: expect.any(String), itemType: "RECALL_ROUND" }
      ]));

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
      })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.findMany({
        orderBy: { itemType: "asc" },
        select: { itemType: true },
        where: { userId }
      })).resolves.toEqual([
        { itemType: "RECALL_CHUNK" },
        { itemType: "RECALL_ROUND_SEGMENT" }
      ]);
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({ status: "PENDING" });
      const hiddenWhilePending = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chunk."id"
        FROM "MemoryRecallChunk" AS chunk
        WHERE chunk."userId" = ${userId}
          AND chunk."chatId" = ${chat.id}
          AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
          AND ${memoryHistoryChunkSourceAuthorityPredicate()}
      `);
      expect(hiddenWhilePending).toEqual([]);
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
      expect(reindexed).toHaveLength(2);
      expect(reindexed.map(({ safeProjectedText }) => safeProjectedText).join("\n"))
        .toContain("Tea is still fine");
      await expect(prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "INVALIDATED", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("preserves stable prefix chunks and projects the overlap tail without a classifier", async () => {
    const userId = await createOwner("memory-history-incremental-append");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Incremental append history", userId }
      });
      let parentMessageId: string | null = null;
      let finalTurn: Awaited<ReturnType<typeof createTurn>> | null = null;
      for (let ordinal = 0; ordinal < 9; ordinal += 1) {
        finalTurn = await createTurn({
          assistantText: `Assistant retained turn ${ordinal}.`,
          chatId: chat.id,
          createdAt: new Date(Date.UTC(2026, 7, 12, 10, ordinal * 2)),
          parentMessageId,
          userId,
          userText: `User retained turn ${ordinal}.`
        });
        parentMessageId = finalTurn.assistantMessage.id;
        await mutateSource(userId, chat.id, {
          mutations: ["NORMAL_APPEND"],
          patch: { activeLeafMessageId: finalTurn.assistantMessage.id }
        });
      }
      if (!finalTurn) throw new Error("missing incremental fixture");
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: finalTurn.assistantMessage.id,
          runId: finalTurn.run.id,
          status: "complete"
        }
      });
      const initialClassify = vi.fn(normalHistoryClassifier.classify);
      await processHistoryJob(userId, {
        classifier: { classify: initialClassify }
      });
      expect(initialClassify).not.toHaveBeenCalled();
      const initialChunks = await prisma.memoryRecallChunk.findMany({
        orderBy: { chunkOrdinal: "asc" },
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(initialChunks).toHaveLength(2);
      const stableChunk = initialChunks[0]!;
      const stableEntry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { recallChunkId: stableChunk.id, userId }
      });

      const appended = await createTurn({
        assistantText: "Assistant retained turn 9.",
        chatId: chat.id,
        createdAt: new Date(Date.UTC(2026, 7, 12, 10, 18)),
        parentMessageId,
        userId,
        userText: "User retained turn 9."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: appended.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: appended.assistantMessage.id,
          runId: appended.run.id,
          status: "complete"
        }
      });
      const appendClassify = vi.fn(normalHistoryClassifier.classify);
      await processHistoryJob(userId, {
        classifier: { classify: appendClassify }
      });

      expect(appendClassify).not.toHaveBeenCalled();
      const currentChunks = await prisma.memoryRecallChunk.findMany({
        orderBy: { chunkOrdinal: "asc" },
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(currentChunks).toHaveLength(3);
      expect(currentChunks[0]).toMatchObject({
        createdAt: stableChunk.createdAt,
        id: stableChunk.id,
        safeProjectedText: stableChunk.safeProjectedText
      });
      await expect(prisma.memorySearchEntry.findFirstOrThrow({
        where: { recallChunkId: stableChunk.id, userId }
      })).resolves.toMatchObject({ id: stableEntry.id });
      const currentCheckpoint = await prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      });
      expect(stableChunk.sourceRevisionAtCreation).not.toBe(
        currentCheckpoint.sourceRevision
      );
      const reusableStablePrefix = await prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT chunk."id"
          FROM "MemoryRecallChunk" AS chunk
          INNER JOIN "Chat" AS source_chat
            ON source_chat."userId" = chunk."userId"
            AND source_chat."id" = chunk."chatId"
          INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
            ON checkpoint."userId" = chunk."userId"
            AND checkpoint."chatId" = chunk."chatId"
          WHERE chunk."userId" = ${userId}
            AND chunk."id" = ${stableChunk.id}
            AND ${memoryHistoryChunkSourceAuthorityPredicate({
              chat: "source_chat",
              checkpoint: "checkpoint"
            })}
        `
      );
      expect(reusableStablePrefix).toEqual([{ id: stableChunk.id }]);
      await expect(prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "INVALIDATED", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("preserves a legacy checkpoint version until prepare forces a full rebuild", async () => {
    const userId = await createOwner("memory-history-pipeline-rebuild");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Pipeline rebuild history", userId }
      });
      const first = await createTurn({
        assistantText: "Initial assistant turn.",
        chatId: chat.id,
        createdAt: new Date("2026-08-12T13:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Initial user turn."
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
      await prisma.chatMemoryCheckpoint.update({
        data: { pipelineVersion: "memory-history-incremental-v1" },
        where: { userId_chatId: { chatId: chat.id, userId } }
      });

      const appended = await createTurn({
        assistantText: "Appended assistant turn.",
        chatId: chat.id,
        createdAt: new Date("2026-08-12T13:02:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "Appended user turn."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: appended.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: appended.assistantMessage.id,
          runId: appended.run.id,
          status: "complete"
        }
      });
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({
        pipelineVersion: "memory-history-incremental-v1",
        status: "PENDING"
      });
      const claim = await claimHistoryJob(userId);
      const prepared = await createPrismaMemoryHistoryIndexRepository(prisma)
        .prepare(claim);
      if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
      expect(prepared.plan.incremental.mode).toBe("FULL_REBUILD");
      expect(prepared.plan.work).toMatchObject({
        chunksReused: 0,
        messageContentRowsLoaded: 4,
        messagesProjected: 4
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("marks destructive source-context drift for a full checkpoint rebuild", async () => {
    const userId = await createOwner("memory-history-context-rebuild");
    try {
      const [folderA, folderB] = await Promise.all([
        prisma.folder.create({ data: { name: "History A", userId } }),
        prisma.folder.create({ data: { name: "History B", userId } })
      ]);
      const chat = await prisma.chat.create({
        data: { folderId: folderA.id, title: "Context rebuild history", userId }
      });
      const turn = await createTurn({
        assistantText: "Context before the folder move.",
        chatId: chat.id,
        createdAt: new Date("2026-08-12T14:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Remember this bounded context."
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

      await mutateSource(userId, chat.id, {
        mutations: ["FOLDER_MOVE"],
        patch: { folderId: folderB.id }
      });
      await expect(prisma.chatMemoryCheckpoint.findUniqueOrThrow({
        where: { userId_chatId: { chatId: chat.id, userId } }
      })).resolves.toMatchObject({
        pipelineVersion: MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION,
        status: "PENDING"
      });
      await expect(seedHistoryBackfill(userId)).resolves.toMatchObject({
        enqueuedJobs: 1
      });
      const claim = await claimHistoryJob(userId);
      const prepared = await createPrismaMemoryHistoryIndexRepository(prisma)
        .prepare(claim);
      if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
      expect(prepared.plan.incremental.mode).toBe("FULL_REBUILD");
      expect(prepared.plan.work).toMatchObject({
        chunksReused: 0,
        messageContentRowsLoaded: 2,
        messagesProjected: 2
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("[E08] bounds a 4,000-message append to the indexed tail plus contextual overlap", async () => {
    const userId = await createOwner("memory-history-4000-message-append");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Four thousand message history", userId }
      });
      const messageIds = Array.from({ length: 4_000 }, () => randomUUID());
      const baseTime = Date.parse("2026-08-14T08:00:00.000Z");
      const messageRows = messageIds.map((id, ordinal) => ({
        chatId: chat.id,
        content: textMessageContent(
          `${ordinal % 2 === 0 ? "User" : "Assistant"} bounded turn ${Math.floor(
            ordinal / 2
          )}.`
        ),
        createdAt: new Date(baseTime + ordinal * 1_000),
        id,
        modelId: ordinal % 2 === 1 ? "history-test-model" : null,
        parentMessageId: ordinal === 0 ? null : messageIds[ordinal - 1]!,
        provider: ordinal % 2 === 1 ? "history-test-provider" : null,
        role: ordinal % 2 === 0 ? "user" : "assistant",
        status: "complete" as const,
        updatedAt: new Date(baseTime + ordinal * 1_000)
      }));
      for (let offset = 0; offset < messageRows.length; offset += 500) {
        await prisma.message.createMany({
          data: messageRows.slice(offset, offset + 500)
        });
      }
      const runRows = Array.from({ length: 2_000 }, (_, turnOrdinal) => ({
        assistantMessageId: messageIds[turnOrdinal * 2 + 1]!,
        chatId: chat.id,
        id: randomUUID(),
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
        status: "complete" as const,
        userId,
        userMessageId: messageIds[turnOrdinal * 2]!
      }));
      for (let offset = 0; offset < runRows.length; offset += 500) {
        await prisma.modelRun.createMany({
          data: runRows.slice(offset, offset + 500)
        });
      }
      await prisma.chat.update({
        data: { activeLeafMessageId: messageIds.at(-1)! },
        where: { id: chat.id }
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const initialSource = await loadMemorySourceSnapshot(prisma, {
        chatId: chat.id,
        personalOnly: true,
        userId
      });
      if (!initialSource?.activeLeafMessageId) {
        throw new Error("memory_history_4000_source_missing");
      }
      const claimFor = (
        source: typeof initialSource
      ): MemoryJobClaim => ({
        activeLeafMessageId: source.activeLeafMessageId!,
        attemptCount: 1,
        branchGeneration: source.memoryBranchGeneration,
        chatId: source.id,
        claimToken: randomUUID(),
        id: randomUUID(),
        idempotencyFingerprint: memoryHistoryIndexJobFingerprint(source),
        kind: "INDEX_HISTORY",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
        recoveredLease: false,
        sourceHash: source.sourceHash,
        sourceMessageId: null,
        sourceRevision: source.memorySourceRevision,
        stage: null,
        targetFactVersionId: null,
        userId
      });
      await prisma.chatMemoryCheckpoint.create({
        data: {
          activeLeafMessageId: initialSource.activeLeafMessageId,
          branchGeneration: initialSource.memoryBranchGeneration,
          chatId: initialSource.id,
          lastIndexedMessageId: initialSource.activeLeafMessageId,
          lastSucceededAt: new Date(),
          pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
          sourceContentHash: initialSource.sourceHash,
          sourceRevision: initialSource.memorySourceRevision,
          status: "READY",
          userId
        }
      });
      for (let offset = 0; offset < messageRows.length; offset += 500) {
        await prisma.chatMemoryCheckpointMessage.createMany({
          data: messageRows.slice(offset, offset + 500)
            .map((message, index) => ({
              chatId: initialSource.id,
              messageId: message.id,
              ordinal: offset + index,
              sourceMessageCreatedAt: message.createdAt,
              sourceMessageUpdatedAt: message.updatedAt,
              userId
            }))
        });
      }
      const tailPlan = await prisma.$transaction(async (tx) => {
        // EXPLAIN must qualify the physical tail index against the rows just
        // bulk-loaded by this fixture, not against stale suite-global stats.
        await tx.$executeRaw(Prisma.sql`ANALYZE "ChatMemoryCheckpointMessage"`);
        await tx.$executeRaw(Prisma.sql`SET LOCAL enable_seqscan = off`);
        return tx.$queryRaw<unknown[]>(Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT checkpoint_message."messageId", checkpoint_message."ordinal"
          FROM "ChatMemoryCheckpointMessage" AS checkpoint_message
          WHERE checkpoint_message."userId" = ${userId}
            AND checkpoint_message."chatId" = ${chat.id}
            AND checkpoint_message."ordinal" >= 3996
          ORDER BY checkpoint_message."userId", checkpoint_message."chatId",
            checkpoint_message."ordinal"
          LIMIT 8
        `);
      });
      const tailPlanEvidence = JSON.stringify(tailPlan);
      expect(tailPlanEvidence)
        .toContain("ChatMemoryCheckpointMessage_user_chat_ordinal_key");
      expect(tailPlanEvidence).not.toContain('"Node Type":"Seq Scan"');
      const lastUserText = "User bounded turn 1999.";
      const lastAssistantText = "Assistant bounded turn 1999.";
      const initialChunkText =
        `User: ${lastUserText}\n\nAssistant: ${lastAssistantText}`;
      const initialChunkId = memorySha256({
        chatId: chat.id,
        fixture: "memory-history-4000-tail"
      });
      await prisma.$transaction(async (tx) => {
        await tx.memoryRecallChunk.create({
          data: {
            branchGeneration: initialSource.memoryBranchGeneration,
            chatId: chat.id,
            chunkOrdinal: 0,
            chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
            contentHash: memorySha256(initialChunkText),
            id: initialChunkId,
            languageCode: "en",
            normalizedSafeSearchText: normalizeMemorySearchText(initialChunkText),
            occurredFrom: messageRows[3_998]!.createdAt,
            occurredTo: messageRows[3_999]!.createdAt,
            redactionReasonCodes: [],
            redactionState: "NOT_NEEDED",
            safeProjectedText: initialChunkText,
            safetyClass: "NORMAL",
            sourceAssistantId: null,
            sourceFolderId: null,
            sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
            sourceRevisionAtCreation: initialSource.memorySourceRevision,
            state: "ACTIVE",
            userId
          }
        });
        await tx.memoryRecallChunkMessage.createMany({
          data: [
            {
              chatId: chat.id,
              chunkId: initialChunkId,
              endOffset: lastUserText.length,
              messageId: messageIds[3_998]!,
              ordinal: 0,
              role: "user",
              safeTextHash: memorySha256(lastUserText),
              sourceMessageContentHash: memorySha256(
                textMessageContent(lastUserText)
              ),
              sourceMessageUpdatedAt: messageRows[3_998]!.updatedAt,
              startOffset: 0,
              userId
            },
            {
              chatId: chat.id,
              chunkId: initialChunkId,
              endOffset: lastAssistantText.length,
              messageId: messageIds[3_999]!,
              ordinal: 1,
              role: "assistant",
              safeTextHash: memorySha256(lastAssistantText),
              sourceMessageContentHash: memorySha256(
                textMessageContent(lastAssistantText)
              ),
              sourceMessageUpdatedAt: messageRows[3_999]!.updatedAt,
              startOffset: 0,
              userId
            }
          ]
        });
      }, {
        timeout: 30_000
      });

      const appended = await createTurn({
        assistantText: "Assistant bounded appended turn.",
        chatId: chat.id,
        createdAt: new Date(baseTime + 4_000 * 1_000),
        parentMessageId: messageIds.at(-1)!,
        userId,
        userText: "User bounded appended turn."
      });
      const updatedChat = await prisma.$transaction(async (tx) => {
        await tx.chatMemoryCheckpoint.update({
          data: { status: "PENDING" },
          where: { userId_chatId: { chatId: chat.id, userId } }
        });
        return tx.chat.update({
          data: {
            activeLeafMessageId: appended.assistantMessage.id,
            memorySourceRevision: { increment: 1 }
          },
          where: { id: chat.id }
        });
      });
      const currentSource = await loadMemorySourceSnapshot(prisma, {
        chatId: updatedChat.id,
        personalOnly: true,
        userId
      });
      if (!currentSource?.activeLeafMessageId) {
        throw new Error("memory_history_4000_append_source_missing");
      }
      const claim = claimFor(currentSource);
      const repository = createPrismaMemoryHistoryIndexRepository(prisma);
      const prepared = await repository.prepare(claim);
      if ("decision" in prepared) {
        throw new Error(prepared.decision.errorCode);
      }
      expect(prepared.plan.incremental).toMatchObject({
        commonPathMessageCount: 4_000,
        mode: "APPEND",
        rebuildFromMessageOrdinal: 3_996
      });
      expect(prepared.plan.timeZone).toBe("Europe/Moscow");
      expect(prepared.plan.work).toEqual({
        chunksBuilt: 1,
        chunksReplaced: 0,
        chunksReused: 1,
        contextualProviderRequests: 0,
        contextualRoundsFallback: 0,
        contextualRoundsGenerated: 0,
        digestSegmentsProcessed: 0,
        digestSourceChunksProcessed: 0,
        messageContentRowsLoaded: 6,
        messagesProjected: 6,
        modelRunRowsLoaded: 3,
        pathMetadataRowsRead: 4_002,
        roundSegmentsBuilt: 3,
        roundSegmentsReplaced: 0,
        roundSegmentsReused: 0,
        roundsBuilt: 3,
        roundsReplaced: 0,
        roundsReused: 0,
        toolEventsBuilt: 0
      });
      expect(prepared.plan.chunks[0]?.id).toBe(initialChunkId);
      expect(prepared.plan.rebuiltChunkIds).toHaveLength(1);
    } finally {
      await cleanupOwner(userId);
    }
  }, 90_000);

  it("persists one retry-idempotent source-bound digest and replaces it after append", async () => {
    const userId = await createOwner("memory-history-digest");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Digest history", userId }
      });
      const first = await createTurn({
        assistantText: "Cedar was selected for deployment.",
        chatId: chat.id,
        createdAt: new Date("2026-08-13T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Compare the cedar and birch deployment options."
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
      const processed = await processHistoryJob(userId, {
        digestGenerator: deterministicDigestGenerator
      });
      const digest = await prisma.chatMemoryDigest.findFirstOrThrow({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(digest).toMatchObject({
        activeLeafMessageId: first.assistantMessage.id,
        pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
        redactionState: "NOT_NEEDED",
        safetyClass: "NORMAL",
        safeDigestText: expect.stringContaining("Summary:"),
        sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        updateMode: "FULL_REBUILD"
      });
      const incompleteDigestId = randomUUID();
      await expect(prisma.chatMemoryDigest.create({
        data: {
          activeLeafMessageId: digest.activeLeafMessageId,
          anchorChunkId: digest.anchorChunkId,
          branchGeneration: digest.branchGeneration,
          chatId: digest.chatId,
          contentHash: digest.contentHash,
          decisions: digest.decisions,
          id: incompleteDigestId,
          languageCode: digest.languageCode,
          normalizedSafeSearchText: digest.normalizedSafeSearchText,
          occurredFrom: digest.occurredFrom,
          occurredTo: digest.occurredTo,
          openLoops: digest.openLoops,
          pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
          redactionState: digest.redactionState,
          safeDigestText: digest.safeDigestText,
          safetyClass: digest.safetyClass,
          safetyPolicyVersion: digest.safetyPolicyVersion,
          sourceAssistantId: digest.sourceAssistantId,
          sourceContentHash: digest.sourceContentHash,
          sourceFolderId: digest.sourceFolderId,
          sourceProjectionVersion: digest.sourceProjectionVersion,
          sourceRevisionAtCreation: digest.sourceRevisionAtCreation,
          state: "INVALIDATED",
          summary: digest.summary,
          topics: digest.topics,
          userId
        }
      })).rejects.toThrow("ChatMemoryDigest_incremental_metadata_check");
      await expect(prisma.chatMemoryDigest.count({
        where: { id: incompleteDigestId }
      })).resolves.toBe(0);
      await expect(prisma.chatMemoryDigestChunk.count({
        where: { digestId: digest.id, userId }
      })).resolves.toBe(1);
      await expect(prisma.chatMemoryDigestMessage.count({
        where: { digestId: digest.id, userId }
      })).resolves.toBe(2);
      const firstDigestMessage = await prisma.chatMemoryDigestMessage.findFirstOrThrow({
        orderBy: { ordinal: "asc" },
        where: { digestId: digest.id, userId }
      });
      await expect(prisma.$transaction((tx) =>
        tx.chatMemoryDigestMessage.delete({
          where: {
            digestId_messageId: {
              digestId: digest.id,
              messageId: firstDigestMessage.messageId
            }
          }
        }))).rejects.toThrow();

      await prisma.$transaction(async (tx) => {
        await processed.result.apply?.(tx, processed.claim);
      });
      await expect(prisma.chatMemoryDigest.count({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      })).resolves.toBe(1);

      const appended = await createTurn({
        assistantText: "The rollout date remains open.",
        chatId: chat.id,
        createdAt: new Date("2026-08-13T10:05:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "We still need to confirm the rollout date."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: appended.assistantMessage.id }
      });
      await expect(prisma.chatMemoryDigest.findUniqueOrThrow({
        where: { id: digest.id }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: appended.assistantMessage.id,
          runId: appended.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId, {
        digestGenerator: deterministicDigestGenerator
      });
      const current = await prisma.chatMemoryDigest.findFirstOrThrow({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(current.id).not.toBe(digest.id);
      expect(current.activeLeafMessageId).toBe(appended.assistantMessage.id);
      await expect(prisma.chatMemoryDigest.count({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      })).resolves.toBe(1);
      await expect(prisma.chatMemoryDigestMessage.count({
        where: { digestId: current.id, userId }
      })).resolves.toBe(4);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("indexes chunks and rounds with exact stateful round rejoin", async () => {
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
      const rounds = await prisma.memoryRecallRound.findMany({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({
        contextualKeyState: "RAW_FALLBACK",
        parentChunkId: chunks[0]?.id,
        rawSafeText:
          "User: Для выпуска используем сине-зелёное развёртывание.\n\n" +
          "Assistant: Подтверждаю выбранный сине-зелёный выпуск."
      });
      const roundMessages = await prisma.memoryRecallRoundMessage.findMany({
        orderBy: { ordinal: "asc" },
        where: { roundId: rounds[0]!.id, userId }
      });
      expect(roundMessages.map(({ messageId, role }) => ({ messageId, role }))).toEqual([
        { messageId: turn.userMessage.id, role: "user" },
        { messageId: turn.assistantMessage.id, role: "assistant" }
      ]);
      await expect(prisma.memorySearchEntry.count({
        where: {
          itemType: "RECALL_ROUND",
          recallRoundId: rounds[0]!.id,
          userId
        }
      })).resolves.toBe(0);
      const segments = await prisma.memoryRecallRoundSegment.findMany({
        orderBy: { segmentOrdinal: "asc" },
        where: { roundId: rounds[0]!.id, state: "ACTIVE", userId }
      });
      expect(segments).toHaveLength(1);
      expect(segments[0]).toMatchObject({
        position: "SINGLE",
        rawEndOffsetUtf16: rounds[0]!.rawSafeText.length,
        rawSafeText: rounds[0]!.rawSafeText,
        rawStartOffsetUtf16: 0
      });
      await expect(prisma.memorySearchEntry.count({
        where: {
          itemType: "RECALL_ROUND_SEGMENT",
          recallRoundId: rounds[0]!.id,
          recallRoundSegmentId: segments[0]!.id,
          userId
        }
      })).resolves.toBe(1);
      await expect(prisma.memoryRecallRoundSegmentMessage.count({
        where: { segmentId: segments[0]!.id, userId }
      })).resolves.toBe(2);
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rejoined = await prisma.$transaction((tx) => resolvePreparingMemoryItem(
        tx,
        {
          assistantId: null,
          chatId: chat.id,
          folderId: null,
          indexGenerationId: settings.activeIndexGenerationId,
          userId
        },
        null,
        {
          exactItemId: rounds[0]!.id,
          exactSafeText: rounds[0]!.rawSafeText,
          finalScore: 0.9,
          itemType: "RECALL_ROUND",
          laneRanks: { HISTORY_RECALL_FTS_SIMPLE: 1 },
          projectionKind: "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT",
          recallRoundId: rounds[0]!.id,
          recallRoundSegmentId: segments[0]!.id,
          selectionReason: "history_recall_exact",
          supportingItemId: chunks[0]!.id
        }
      ));
      expect(rejoined).toMatchObject({
        exactItemId: rounds[0]!.id,
        itemType: "RECALL_ROUND",
        recallRoundId: rounds[0]!.id,
        recallRoundSegmentId: segments[0]!.id,
        sourceMessageIdsSnapshot: [
          turn.userMessage.id,
          turn.assistantMessage.id
        ]
      });
      const corruptText = "x".repeat(segments[0]!.rawSafeText.length);
      await prisma.memoryRecallRoundSegment.update({
        data: {
          rawSafeText: corruptText,
          rawSafeTextHash: memorySha256(corruptText)
        },
        where: { id: segments[0]!.id }
      });
      await expect(prisma.$transaction((tx) => resolvePreparingMemoryItem(
        tx,
        {
          assistantId: null,
          chatId: chat.id,
          folderId: null,
          indexGenerationId: settings.activeIndexGenerationId,
          userId
        },
        null,
        {
          exactItemId: rounds[0]!.id,
          exactSafeText: corruptText,
          finalScore: 0.9,
          itemType: "RECALL_ROUND",
          laneRanks: { HISTORY_RECALL_FTS_SIMPLE: 1 },
          projectionKind: "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT",
          recallRoundId: rounds[0]!.id,
          recallRoundSegmentId: segments[0]!.id,
          selectionReason: "history_recall_exact",
          supportingItemId: chunks[0]!.id
        }
      ))).rejects.toMatchObject({ code: "memory_attempt_item_stale" });
      await expect(prisma.$transaction((tx) =>
        tx.memoryRecallRoundSegmentMessage.deleteMany({
          where: { segmentId: segments[0]!.id, userId }
        }))).rejects.toThrow();
      await expect(prisma.$transaction((tx) =>
        tx.memoryRecallRoundMessage.deleteMany({
          where: { roundId: rounds[0]!.id, userId }
        }))).rejects.toThrow();
      await expect(prisma.memoryRecallRoundMessage.count({
        where: { roundId: rounds[0]!.id, userId }
      })).resolves.toBe(2);
      await expect(prisma.$transaction((tx) =>
        tx.memoryRecallChunkMessage.deleteMany({
          where: { chunkId: chunks[0]!.id, userId }
        }))).rejects.toThrow();
      await expect(prisma.memoryRecallChunkMessage.count({
        where: { chunkId: chunks[0]!.id, userId }
      })).resolves.toBe(2);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("carries cited contextual evidence and falls back to raw when a dependency drifts", async () => {
    const userId = await createOwner("memory-history-contextual-dependencies");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Contextual dependency history", userId }
      });
      const priorTurn = await createTurn({
        assistantText: "Recorded Maria's cedar table reservation.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T08:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Maria reserved the cedar table."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: priorTurn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: priorTurn.assistantMessage.id,
          runId: priorTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);

      const currentTurn = await createTurn({
        assistantText: "Recorded the window seat selection.",
        chatId: chat.id,
        createdAt: new Date("2026-08-10T08:02:00.000Z"),
        parentMessageId: priorTurn.assistantMessage.id,
        userId,
        userText: "She chose the window seat."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: currentTurn.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: currentTurn.assistantMessage.id,
          runId: currentTurn.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);

      const rounds = await prisma.memoryRecallRound.findMany({
        orderBy: { roundOrdinal: "asc" },
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      expect(rounds).toHaveLength(2);
      const prior = rounds[0]!;
      const current = rounds[1]!;
      const currentSegment = await prisma.memoryRecallRoundSegment.findFirstOrThrow({
        where: { roundId: current.id, state: "ACTIVE", userId }
      });
      const retrievalHint = "Maria chose the window seat.";
      await prisma.$transaction([
        prisma.memoryRecallRound.update({
          data: {
            contextualKeyState: "GENERATED",
            contextualNarrativeText: retrievalHint,
            supportingRoundIds: [prior.id]
          },
          where: { id: current.id }
        }),
        prisma.memoryRecallRoundSegment.update({
          data: {
            contextualKeyState: "GENERATED",
            contextualNarrativeText: retrievalHint,
            supportingRoundIds: [prior.id]
          },
          where: { id: currentSegment.id }
        })
      ]);

      const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
      const retrievalNow = new Date("2026-08-10T09:00:00.000Z");
      const plan = planMemoryRetrieval({
        currentUserText: "window seat",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now: retrievalNow,
        temporalIntent: "ANY"
      });
      const retrieved = await repository.retrieve({
        assistantId: null,
        chatId: chat.id,
        now: retrievalNow,
        plan,
        userId
      });
      const ranked = fuseMemoryRetrievalCandidates(plan, retrieved.laneResults, retrievalNow);
      const selected = ranked.find((candidate) => candidate.itemId === current.id);
      expect(selected?.matchedSegmentId).toBe(currentSegment.id);
      const [expanded] = await repository.expand(retrieved.snapshot, plan, [selected!]);
      expect(expanded).toMatchObject({
        itemId: current.id,
        retrievalHint,
        safeText: currentSegment.rawSafeText,
        supportingEvidence: [{
          itemId: prior.id,
          safeText: prior.rawSafeText,
          sourceChatId: chat.id
        }]
      });
      const [rerankCandidate] = memoryRelevanceCandidates(
        [selected!],
        [expanded!],
        { temporalIntent: plan.temporalIntent }
      );
      const rerankDocument = memoryDedicatedRerankDocument(rerankCandidate!);
      expect(rerankDocument).toContain(
        `[retrieval_hint derived=true authority=none]\n${retrievalHint}`
      );
      expect(rerankDocument).toContain(
        `[authoritative_evidence]\n${currentSegment.rawSafeText}`
      );
      expect(rerankDocument).toContain(
        `[supporting_authoritative_evidence]\n` +
          `[support_1 raw_excerpt=true ` +
          `date_from=${prior.occurredFrom.toISOString()} ` +
          `date_to=${prior.occurredTo.toISOString()}]\n${prior.rawSafeText}`
      );
      const pack = packMemoryPersonalContext({
        expanded: [expanded!],
        plan,
        ranked: [selected!]
      });
      expect(pack.text).toContain('"retrieval_hint":{"authority":"none","derived":true');
      expect(pack.text).toContain('"supporting_authoritative_evidence"');
      expect(pack.text).toContain("Maria reserved the cedar table.");

      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const preparingInput = {
        exactItemId: current.id,
        exactSafeText: currentSegment.rawSafeText,
        featureSnapshot: {
          contextualRetrievalHintHash: memorySha256(retrievalHint),
          contextualSupportingEvidenceHashes: [
            memorySha256(expanded!.supportingEvidence![0]!.safeText)
          ],
          contextualSupportingRoundIds: [prior.id]
        },
        finalScore: selected!.finalScore,
        itemType: "RECALL_ROUND" as const,
        laneRanks: selected!.laneRanks,
        projectionKind: "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT" as const,
        recallRoundId: current.id,
        recallRoundSegmentId: currentSegment.id,
        selectionReason: selected!.selectionReason,
        supportingItemId: current.parentChunkId
      };
      await expect(prisma.$transaction((tx) => resolvePreparingMemoryItem(
        tx,
        {
          assistantId: null,
          chatId: chat.id,
          folderId: null,
          indexGenerationId: settings.activeIndexGenerationId,
          userId
        },
        null,
        preparingInput
      ))).resolves.toMatchObject({ recallRoundSegmentId: currentSegment.id });

      const invalidatedAt = new Date("2026-08-10T09:01:00.000Z");
      await prisma.$transaction([
        prisma.memoryRecallRoundSegment.updateMany({
          data: { invalidatedAt, state: "INVALIDATED" },
          where: { roundId: prior.id, userId }
        }),
        prisma.memoryRecallRound.update({
          data: { invalidatedAt, state: "INVALIDATED" },
          where: { id: prior.id }
        })
      ]);
      const [rawOnly] = await repository.expand(retrieved.snapshot, plan, [selected!]);
      expect(rawOnly).toMatchObject({
        itemId: current.id,
        retrievalHint: null,
        safeText: currentSegment.rawSafeText,
        supportingEvidence: []
      });
      await expect(prisma.$transaction((tx) => resolvePreparingMemoryItem(
        tx,
        {
          assistantId: null,
          chatId: chat.id,
          folderId: null,
          indexGenerationId: settings.activeIndexGenerationId,
          userId
        },
        null,
        preparingInput
      ))).rejects.toMatchObject({ code: "memory_attempt_item_stale" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("retrieves and expands prefix, middle, and suffix evidence from a 100k round", async () => {
    const userId = await createOwner("memory-history-long-segments");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Long segmented history", userId }
      });
      const userText = [
        "segmentprefixcedar was recorded.",
        "Alpha rehearsal context. ".repeat(2_000)
      ].join(" ");
      const assistantText = [
        "segmentmiddlebirch was recorded.",
        "Beta rehearsal context. ".repeat(2_700),
        "segmentsuffixmaple was recorded."
      ].join(" ");
      expect(userText.length).toBeLessThan(100_000);
      expect(assistantText.length).toBeLessThan(100_000);
      expect(userText.length + assistantText.length).toBeGreaterThan(100_000);
      const turn = await createTurn({
        assistantText,
        chatId: chat.id,
        createdAt: new Date("2026-08-10T09:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText
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

      const round = await prisma.memoryRecallRound.findFirstOrThrow({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });
      const segments = await prisma.memoryRecallRoundSegment.findMany({
        orderBy: { segmentOrdinal: "asc" },
        where: { roundId: round.id, state: "ACTIVE", userId }
      });
      expect(segments.length).toBeGreaterThan(3);
      expect(segments[0]?.position).toBe("PREFIX");
      expect(segments.at(-1)?.position).toBe("SUFFIX");
      await expect(prisma.memorySearchEntry.count({
        where: {
          itemType: "RECALL_ROUND_SEGMENT",
          recallRoundId: round.id,
          userId
        }
      })).resolves.toBe(segments.length);

      const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
      for (const [query, expectedPosition] of [
        ["segmentprefixcedar", "PREFIX"],
        ["segmentmiddlebirch", "MIDDLE"],
        ["segmentsuffixmaple", "SUFFIX"]
      ] as const) {
        const retrievalNow = new Date("2026-08-10T10:00:00.000Z");
        const plan = planMemoryRetrieval({
          currentUserText: query,
          filters: { sourceKinds: ["HISTORY"] },
          mode: "PAST_CHAT_SEARCH",
          now: retrievalNow,
          temporalIntent: "ANY"
        });
        const retrieved = await repository.retrieve({
          assistantId: null,
          chatId: chat.id,
          now: retrievalNow,
          plan,
          userId
        });
        const ranked = fuseMemoryRetrievalCandidates(
          plan,
          retrieved.laneResults,
          retrievalNow
        );
        const selected = ranked.find((candidate) =>
          candidate.itemId === round.id && candidate.matchedSegmentId !== null);
        expect(selected).toMatchObject({
          itemId: round.id,
          itemType: "RECALL_ROUND",
          matchedSegmentPosition: expectedPosition
        });
        const [expanded] = await repository.expand(
          retrieved.snapshot,
          plan,
          [selected!]
        );
        const stored = segments.find(({ id }) => id === selected!.matchedSegmentId);
        expect(expanded).toMatchObject({
          itemId: round.id,
          itemType: "RECALL_ROUND",
          projectionKind: "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT",
          safeText: stored?.rawSafeText
        });
        expect(expanded?.safeText).toContain(query);
      }

      const rebuild = createPrismaMemoryRebuildRepository(prisma);
      const cutover = createPrismaMemoryRetrievalCutoverRepository(prisma);
      const beforeRebuild = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await prisma.memoryRecallRoundSegment.deleteMany({
        where: { roundId: round.id, userId }
      });
      await expect(prisma.memoryRecallRoundSegment.count({
        where: { roundId: round.id, userId }
      })).resolves.toBe(0);
      const first = await rebuild.admit(userId, {
        expectedMemoryRevision: beforeRebuild.memoryRevision,
        expectedSettingsRevision: beforeRebuild.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: `segment-backfill-${randomUUID()}` }
      });
      if (first.kind !== "ok") throw new Error(`segment_backfill_${first.kind}`);
      await processRebuildJob(userId, first.jobId);
      const afterFirst = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const firstGenerationId = afterFirst.activeIndexGenerationId;
      if (!firstGenerationId) throw new Error("segment_generation_missing");
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: firstGenerationId }
      })).resolves.toMatchObject({
        roundSegmentProjectionVersion:
          MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
        state: "ACTIVE"
      });
      const rebuiltSegments = await prisma.memoryRecallRoundSegment.count({
        where: { roundId: round.id, state: "ACTIVE", userId }
      });
      expect(rebuiltSegments).toBe(segments.length);
      await expect(prisma.memorySearchEntry.count({
        where: {
          indexGenerationId: firstGenerationId,
          itemType: "RECALL_ROUND_SEGMENT",
          recallRoundId: round.id,
          userId
        }
      })).resolves.toBe(rebuiltSegments);

      const second = await rebuild.admit(userId, {
        expectedMemoryRevision: afterFirst.memoryRevision,
        expectedSettingsRevision: afterFirst.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: `segment-second-${randomUUID()}` }
      });
      if (second.kind !== "ok") throw new Error(`segment_second_${second.kind}`);
      await processRebuildJob(userId, second.jobId);
      const beforeRollback = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(beforeRollback.activeIndexGenerationId).not.toBe(firstGenerationId);
      await expect(cutover.rollback(userId, firstGenerationId, {
        expectedMemoryRevision: beforeRollback.memoryRevision,
        expectedSettingsRevision: beforeRollback.settingsRevision
      })).resolves.toEqual({
        activeGenerationId: firstGenerationId,
        kind: "ok"
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({ activeIndexGenerationId: firstGenerationId });

      const activeSegmentGeneration = await prisma.memoryIndexGeneration
        .findUniqueOrThrow({ where: { id: firstGenerationId } });
      const embeddingModel = await prisma.providerModel.findUniqueOrThrow({
        select: { connectionId: true },
        where: { id: providerTemplateIds.fakeModel }
      });
      const nextGeneration = await prisma.memoryIndexGeneration.aggregate({
        _max: { generation: true },
        where: { userId }
      });
      const afterRollback = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const hybridGeneration = await prisma.memoryIndexGeneration.create({
        data: {
          chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
          contextualKeyPolicyVersion:
            activeSegmentGeneration.contextualKeyPolicyVersion,
          embeddingConfigurationFingerprint: "b".repeat(64),
          embeddingConnectionId: embeddingModel.connectionId,
          embeddingDimension: 1_024,
          embeddingProviderModelId: providerTemplateIds.fakeModel,
          generation: (nextGeneration._max.generation ?? -1) + 1,
          indexMode: "HYBRID",
          indexedThroughMemoryRevision: afterRollback.memoryRevision,
          languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
          roundProjectionVersion: activeSegmentGeneration.roundProjectionVersion,
          roundSegmentProjectionVersion:
            MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
          sourceIndexGenerationId: firstGenerationId,
          state: "BUILDING",
          targetMemoryRevision: afterRollback.memoryRevision,
          userId,
          vectorSpaceFingerprint: "c".repeat(64)
        }
      });
      const candidateVectorSegments = await prisma.memoryRecallRoundSegment.findMany({
        orderBy: { segmentOrdinal: "asc" },
        where: {
          position: { in: ["MIDDLE", "SUFFIX"] },
          roundId: round.id,
          state: "ACTIVE",
          userId
        }
      });
      const vectorSegments = [
        candidateVectorSegments.find(({ position }) => position === "MIDDLE"),
        candidateVectorSegments.find(({ position }) => position === "SUFFIX")
      ].filter((segment): segment is (typeof candidateVectorSegments)[number] =>
        segment !== undefined);
      expect(vectorSegments.some(({ position }) => position === "MIDDLE")).toBe(true);
      expect(vectorSegments.some(({ position }) => position === "SUFFIX")).toBe(true);
      const vectorEntryIds = vectorSegments.map(() => randomUUID());
      await prisma.memorySearchEntry.createMany({
        data: vectorSegments.map((segment, index) => ({
          embeddingState: "PENDING" as const,
          id: vectorEntryIds[index]!,
          indexGenerationId: hybridGeneration.id,
          itemType: "RECALL_ROUND_SEGMENT" as const,
          languageCode: segment.languageCode,
          normalizedSearchText: normalizeMemorySearchText(
            segment.contextualSearchText
          ),
          recallRoundId: round.id,
          recallRoundSegmentId: segment.id,
          safeContentHash: segment.contextualSearchHash,
          safetyIdentitySnapshot: memorySha256({
            segmentId: segment.id,
            type: "safety"
          }),
          sourceIdentitySnapshot: memorySha256({
            segmentId: segment.id,
            type: "source"
          }),
          suppressionIdentitySnapshot: memorySha256({
            segmentId: segment.id,
            type: "suppression"
          }),
          userId
        }))
      });
      await prisma.$transaction(async (tx) => {
        const activatedAt = new Date();
        await tx.memoryIndexGeneration.update({
          data: { state: "SUPERSEDED", supersededAt: activatedAt },
          where: { id: firstGenerationId }
        });
        await tx.memoryIndexGeneration.update({
          data: {
            activatedAt,
            readyAt: activatedAt,
            state: "ACTIVE"
          },
          where: { id: hybridGeneration.id }
        });
        await tx.userMemorySettings.update({
          data: {
            activeIndexGenerationId: hybridGeneration.id,
            embeddingProviderModelId: providerTemplateIds.fakeModel
          },
          where: { userId }
        });
      });
      const embedding = createPrismaMemoryItemEmbeddingRepository(prisma);
      for (const [index, segment] of vectorSegments.entries()) {
        await expect(embedding.loadTarget(userId, vectorEntryIds[index]!))
          .resolves.toMatchObject({
            itemId: segment.id,
            itemType: "RECALL_ROUND_SEGMENT",
            recallRoundId: round.id,
            recallRoundSegmentId: segment.id
          });
      }
      const vector = Array.from(
        { length: 1_024 },
        (_, index) => index === 0 ? 1 : 0
      );
      const serializedVector = JSON.stringify(vector);
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "MemorySearchEntry"
        SET
          "embedding" = ${serializedVector}::vector,
          "embeddingDimension" = 1024,
          "embeddingState" = 'READY'::"MemoryEmbeddingState"
        WHERE "userId" = ${userId}
          AND "id" IN (${Prisma.join(vectorEntryIds)})
      `);
      const vectorRepository = createPrismaMemoryVectorRepository(prisma);
      const resolvedProfile = await vectorRepository.resolveActiveProfile(userId);
      expect(resolvedProfile.status).toBe("READY");
      if (resolvedProfile.status !== "READY") {
        throw new Error(resolvedProfile.reason);
      }
      const vectorResult = await vectorRepository.search({
        eligibility: {
          allowedFactSensitivity: ["NORMAL"],
          allowedHistorySafety: ["NORMAL"],
          assistantId: null,
          chatId: chat.id,
          factMode: "CURRENT",
          factTemporalAsOf: null,
          folderId: null,
          includePatterns: false,
          occurredFrom: null,
          occurredTo: null,
          sourceAssistantId: null,
          sourceChatIds: null,
          sourceFolderId: null
        },
        itemTypes: ["RECALL_ROUND_SEGMENT"],
        limit: vectorEntryIds.length,
        minimumScore: 0,
        profile: resolvedProfile.profile,
        userId,
        vector
      });
      expect(vectorResult).toMatchObject({ status: "READY" });
      expect(vectorResult.hits.map(({ entryId }) => entryId).sort())
        .toEqual([...vectorEntryIds].sort());
    } finally {
      await cleanupOwner(userId);
    }
  }, 90_000);

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

  it("indexes, retrieves, rebuilds, corrects, and excludes safe typed tool observations", async () => {
    const userId = await createOwner("memory-tool-observation");
    const foreignUserId = await createOwner("memory-tool-observation-foreign");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Tool observation history", userId }
      });
      const turn = await createTurn({
        assistantText: "The requested file operation completed.",
        chatId: chat.id,
        createdAt: new Date("2026-08-28T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Create the release report."
      });
      const completedAt = new Date("2026-08-28T12:00:02.000Z");
      const privateCanary = "RAW_TOOL_PRIVATE_CANARY";
      const fileCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { api_key: "sk-args-abcdefghijklmnopqrstuvwxyz123456" },
          completedAt,
          modelRunId: turn.run.id,
          ordinal: 0,
          providerCallId: "file-create-call",
          result: {
            body: `<html>${privateCanary.repeat(20_000)}</html>`,
            filename: "release-report.pdf",
            status: "complete"
          },
          roundIndex: 0,
          state: "complete",
          toolName: "filesystem.write"
        }
      });
      await prisma.modelRunToolCall.createMany({
        data: [{
          arguments: {},
          completedAt: new Date("2026-08-28T12:00:03.000Z"),
          modelRunId: turn.run.id,
          ordinal: 1,
          providerCallId: "secret-only-call",
          result: { name: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" },
          roundIndex: 0,
          state: "complete",
          toolName: "vault.lookup"
        }, {
          arguments: {},
          modelRunId: turn.run.id,
          ordinal: 2,
          providerCallId: "in-flight-call",
          result: { filename: "must-not-appear.txt" },
          roundIndex: 0,
          state: "running",
          toolName: "filesystem.write"
        }]
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

      const initialEvent = await prisma.memoryToolEvent.findFirstOrThrow({
        where: { modelRunToolCallId: fileCall.id, state: "ACTIVE", userId }
      });
      expect(initialEvent).toMatchObject({
        assistantMessageId: turn.assistantMessage.id,
        outcome: "SUCCESS",
        projectionVersion: MEMORY_TOOL_EVENT_PROJECTION_VERSION,
        toolName: "filesystem.write"
      });
      expect(initialEvent.safeProjectedText).toContain("filename: release-report.pdf");
      expect(initialEvent.normalizedSafeSearchText).toContain("release report pdf");
      expect(JSON.stringify(initialEvent)).not.toContain(privateCanary);
      await expect(prisma.memoryToolEvent.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.count({
        where: { itemType: "TOOL_EVENT", toolEventId: initialEvent.id, userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memorySynthesisExecution.count({ where: { userId } }))
        .resolves.toBe(0);

      const retrievalNow = new Date("2026-08-28T13:00:00.000Z");
      const retrievalPlan = planMemoryRetrieval({
        currentUserText: "release-report.pdf",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now: retrievalNow,
        temporalIntent: "ANY"
      });
      const retrievalRepository = createPrismaLocalMemoryRetrievalRepository(prisma);
      const retrieved = await retrievalRepository.retrieve({
        assistantId: null,
        chatId: chat.id,
        now: retrievalNow,
        plan: retrievalPlan,
        userId
      });
      const ranked = fuseMemoryRetrievalCandidates(
        retrievalPlan,
        retrieved.laneResults,
        retrievalNow
      );
      const selected = ranked.find((candidate) => candidate.itemId === initialEvent.id);
      expect(selected).toMatchObject({
        itemType: "TOOL_EVENT",
        metadata: { sourceAuthority: "TOOL_OBSERVATION" }
      });
      const [expanded] = await retrievalRepository.expand(
        retrieved.snapshot,
        retrievalPlan,
        [selected!]
      );
      expect(expanded).toMatchObject({
        itemId: initialEvent.id,
        itemType: "TOOL_EVENT",
        projectionKind: "TOOL_EVENT_SAFE_TEXT",
        safeText: initialEvent.safeProjectedText
      });
      const pack = packMemoryPersonalContext({
        expanded: [expanded!],
        plan: retrievalPlan,
        ranked: [selected!]
      });
      expect(pack.text).toContain('"source_authority":"tool_observation"');
      expect(pack.text).toContain('"speaker_scope":"tool"');

      const foreignChat = await prisma.chat.create({
        data: { title: "Foreign tool query", userId: foreignUserId }
      });
      const foreign = await retrievalRepository.retrieve({
        assistantId: null,
        chatId: foreignChat.id,
        now: retrievalNow,
        plan: retrievalPlan,
        userId: foreignUserId
      });
      expect(fuseMemoryRetrievalCandidates(
        retrievalPlan,
        foreign.laneResults,
        retrievalNow
      ).some(({ itemType }) => itemType === "TOOL_EVENT")).toBe(false);

      const beforeRebuild = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rebuild = createPrismaMemoryRebuildRepository(prisma);
      const admitted = await rebuild.admit(userId, {
        expectedMemoryRevision: beforeRebuild.memoryRevision,
        expectedSettingsRevision: beforeRebuild.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: `tool-event-rebuild-${randomUUID()}` }
      });
      if (admitted.kind !== "ok") throw new Error(`tool_event_rebuild_${admitted.kind}`);
      await processRebuildJob(userId, admitted.jobId);
      const afterRebuild = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await expect(prisma.memorySearchEntry.count({
        where: {
          indexGenerationId: afterRebuild.activeIndexGenerationId!,
          itemType: "TOOL_EVENT",
          toolEventId: initialEvent.id,
          userId
        }
      })).resolves.toBe(1);

      await prisma.modelRunToolCall.update({
        data: {
          result: { filename: "release-report-v2.pdf", status: "complete" }
        },
        where: { id: fileCall.id }
      });
      const staleAfterCorrection = await retrievalRepository.retrieve({
        assistantId: null,
        chatId: chat.id,
        now: retrievalNow,
        plan: retrievalPlan,
        userId
      });
      expect(fuseMemoryRetrievalCandidates(
        retrievalPlan,
        staleAfterCorrection.laneResults,
        retrievalNow
      ).some(({ itemType }) => itemType === "TOOL_EVENT")).toBe(false);
      const followUp = await createTurn({
        assistantText: "The corrected file result is recorded.",
        chatId: chat.id,
        createdAt: new Date("2026-08-28T12:05:00.000Z"),
        parentMessageId: turn.assistantMessage.id,
        userId,
        userText: "Record the correction."
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: followUp.assistantMessage.id }
      });
      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: followUp.assistantMessage.id,
          runId: followUp.run.id,
          status: "complete"
        }
      });
      await processHistoryJob(userId);
      await expect(prisma.memoryToolEvent.findUniqueOrThrow({
        where: { id: initialEvent.id }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      const corrected = await prisma.memoryToolEvent.findFirstOrThrow({
        where: { modelRunToolCallId: fileCall.id, state: "ACTIVE", userId }
      });
      expect(corrected.id).not.toBe(initialEvent.id);
      expect(corrected.safeProjectedText).toContain("release-report-v2.pdf");

      await mutateSource(userId, chat.id, {
        mutations: ["SOURCE_EXCLUDE"],
        patch: { memoryMode: "EXCLUDED" }
      });
      await expect(prisma.memoryToolEvent.findUniqueOrThrow({
        where: { id: corrected.id }
      })).resolves.toMatchObject({ state: "INVALIDATED" });
      await expect(prisma.memorySearchEntry.count({
        where: { toolEventId: corrected.id, userId }
      })).resolves.toBe(0);
      await prisma.modelRun.delete({ where: { id: turn.run.id } });
      await expect(prisma.memoryToolEvent.count({
        where: { modelRunId: turn.run.id, userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(foreignUserId);
      await cleanupOwner(userId);
    }
  }, 90_000);

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
