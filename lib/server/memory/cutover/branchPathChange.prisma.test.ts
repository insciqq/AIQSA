import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import { createPrismaChatRepository } from "../../chats/prismaRepository";
import { createPrismaMessageBranchRepository } from "../../messages/prismaRepository";
import type { NormalizedRunRequest } from "../../providers/types";
import { createPrismaRunRepository } from "../../runs/prismaRepository";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../coordinator/types";
import { createPrismaMemoryHistoryIndexHandler } from "../history/handler";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../history/rounds";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from "../history/segments";
import {
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_NORMALIZATION_VERSION
} from "../persistence/lexical";
import { memoryHistoryChunkSourceAuthorityPredicate } from "../persistence/pauseIntervals";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../sourceState";
import { createPrismaMemoryRetrievalCutoverRepository } from "./repository";

/**
 * Regenerate, edit-and-resend, branch switches and subtree deletes advance the
 * owner's memoryRevision. When their source hooks leave the search index
 * unchanged, the active generation must stay current, so retrieval cutover
 * never mistakes them for a lagging index and rebuilds (and, for a vector
 * index, re-embeds) the owner's whole Memory.
 */

const EMBEDDING_DIMENSION = 1_024;

type IndexMode = "HYBRID" | "LEXICAL_ONLY";
type Turn = Awaited<ReturnType<typeof createTurn>>;

function normalizedRequest(chatId: string, text: string): NormalizedRunRequest {
  const content = textMessageContent(text);
  return {
    attachmentIds: [],
    chatId,
    content,
    context: {
      messages: [{ content, id: "current-user-message", role: "user" }],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
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
    searchPlan: { mode: "all_selected", options: [] }
  };
}

/** The installation-wide candidate SQL runs unchanged, but the reconciler acts
 * only on this test's owner: the disposable database holds other fixtures. */
function ownerScopedClient(userId: string): typeof prisma {
  return new Proxy(prisma, {
    get(target, property) {
      if (property === "$queryRaw") {
        return async (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
          const rows = await target.$queryRaw<Array<{ userId?: string }>>(
            query as Prisma.Sql, ...values
          );
          const text = Array.isArray(query)
            ? query.join("")
            : (query as Prisma.Sql).strings.join("");
          return text.includes('SELECT settings."userId"')
            ? rows.filter((row) => row.userId === userId)
            : rows;
        };
      }
      return Reflect.get(target, property);
    }
  });
}

async function createOwner(label: string, mode: IndexMode) {
  const suffix = randomUUID();
  const userId = `memory-branch-revision-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory branch revision",
      email: `memory-branch-revision-${label}-${suffix}@example.test`,
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
  await prisma.userMemorySettings.update({
    data: { learnAutomatically: false, referenceChatHistory: true, useMemoryFacts: true },
    where: { userId }
  });
  const connectionId = `memory-branch-revision-connection-${suffix}`;
  const modelId = `memory-branch-revision-embedding-${suffix}`;
  if (mode === "HYBRID") {
    // A vector index on a selected embedding model, as every owner has since
    // the bulk re-embed. Nothing here dispatches: only vector work is counted.
    const now = new Date();
    const connectionConfiguration = {
      allowPrivateNetwork: false,
      apiRoot: "https://memory-branch-revision.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    };
    const modelConfiguration = {
      adapterKind: "openai_embeddings_compatible",
      answerSelectable: false,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      defaultParams: {},
      embedding: {
        nativeDimension: EMBEDDING_DIMENSION,
        providerFamily: "openai_compatible",
        queryInstructionTemplate: null,
        supportsMrl: false,
        targetDimension: EMBEDDING_DIMENSION
      },
      modelClass: "embedding",
      upstreamModelId: "memory-branch-revision-embedding-v1"
    };
    await prisma.providerConnection.create({
      data: {
        activeConfig: connectionConfiguration,
        activeVersion: 1,
        activatedAt: now,
        displayName: "Memory branch revision embeddings",
        draftConfig: connectionConfiguration,
        draftVersion: 1,
        enabled: true,
        family: "openai_compatible",
        id: connectionId,
        unassignedPolicy: "use_default"
      }
    });
    await prisma.providerModel.create({
      data: {
        activeConfig: modelConfiguration,
        activeVersion: 1,
        activatedAt: now,
        capabilities: modelConfiguration.capabilities,
        connectionId,
        defaultParams: {},
        displayName: "Memory branch revision embedding model",
        draftConfig: modelConfiguration,
        draftVersion: 1,
        enabled: true,
        id: modelId,
        modelClass: "embedding",
        modelId: modelConfiguration.upstreamModelId,
        provider: "openai_compatible"
      }
    });
    const settings = await prisma.userMemorySettings.update({
      data: { embeddingProviderModelId: modelId, embeddingSelectionResolved: true },
      where: { userId }
    });
    const generation = await prisma.memoryIndexGeneration.create({
      data: {
        chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
        contextualKeyPolicyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
        embeddingConfigurationFingerprint: "c".repeat(64),
        embeddingConnectionId: connectionId,
        embeddingDimension: EMBEDDING_DIMENSION,
        embeddingProviderModelId: modelId,
        generation: 0,
        indexMode: "HYBRID",
        indexedThroughMemoryRevision: settings.memoryRevision,
        languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
        normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
        readyAt: now,
        retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
        roundProjectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
        roundSegmentProjectionVersion: MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
        state: "READY",
        targetMemoryRevision: settings.memoryRevision,
        userId,
        vectorSpaceFingerprint: "d".repeat(64)
      }
    });
    await prisma.$transaction(async (tx) => {
      await tx.userMemorySettings.update({
        data: { activeIndexGenerationId: generation.id },
        where: { userId }
      });
      await tx.memoryIndexGeneration.update({
        data: { activatedAt: now, state: "ACTIVE" },
        where: { id: generation.id }
      });
    });
  }
  return {
    userId,
    async cleanup() {
      await prisma.$transaction(async (tx) => {
        await tx.memoryRetrievalAttemptItem.deleteMany({
          where: { recallChunkId: { not: null }, userId }
        });
        await tx.memoryRecallChunk.deleteMany({ where: { userId } });
        await tx.usageEvent.deleteMany({ where: { userId } });
        await tx.chatMemoryCheckpointMessage.deleteMany({ where: { userId } });
        await tx.memoryJob.deleteMany({ where: { userId } });
        await tx.chat.deleteMany({ where: { userId } });
        await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
        await tx.user.deleteMany({ where: { id: userId } });
      });
      if (mode === "HYBRID") {
        await prisma.providerModel.deleteMany({ where: { id: modelId } });
        await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
      }
    }
  };
}

async function mutateSource(
  userId: string,
  chatId: string,
  input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">
) {
  return prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_branch_revision_chat_missing");
    return applyMemorySourceMutations(tx, {
      ...input,
      chat,
      hooks: defaultMemorySourceMutationHooks
    });
  });
}

async function createTurn(input: Readonly<{
  assistantText: string;
  chatId: string;
  createdAt: Date;
  parentMessageId: string | null;
  userId: string;
  userText: string;
}>) {
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
  const assistantMessage = await createAnswer({
    chatId: input.chatId,
    createdAt: new Date(input.createdAt.getTime() + 1_000),
    text: input.assistantText,
    userId: input.userId,
    userMessageId: userMessage.id
  });
  return { ...assistantMessage, userMessage };
}

/** A settled answer to an existing user message, as a finished run leaves it. */
async function createAnswer(input: Readonly<{
  chatId: string;
  createdAt: Date;
  text: string;
  userId: string;
  userMessageId: string;
}>) {
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: input.chatId,
      content: textMessageContent(input.text),
      createdAt: input.createdAt,
      modelId: "branch-revision-model",
      parentMessageId: input.userMessageId,
      provider: "branch-revision-provider",
      role: "assistant",
      status: "complete",
      updatedAt: input.createdAt
    }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: assistantMessage.id,
      chatId: input.chatId,
      modelId: "branch-revision-model",
      normalizedRequest: {
        prompt: {
          baseline: { source: "standard_chat", timeZone: "UTC", timeZoneSource: "client" }
        }
      },
      provider: "branch-revision-provider",
      status: "complete",
      userId: input.userId,
      userMessageId: input.userMessageId
    }
  });
  return { assistantMessage, run };
}

/** The run settlement a finished answer applies; it queues history indexing. */
async function settleAnswer(
  userId: string,
  chatId: string,
  answer: Readonly<{ assistantMessage: { id: string }; run: { id: string } }>,
  mutation: "BRANCH_PATH_CHANGE" | "NORMAL_APPEND"
) {
  await mutateSource(userId, chatId, {
    mutations: [mutation],
    patch: { activeLeafMessageId: answer.assistantMessage.id }
  });
  await mutateSource(userId, chatId, {
    mutations: ["TERMINAL_SETTLEMENT"],
    terminalSettlement: {
      assistantMessageId: answer.assistantMessage.id,
      runId: answer.run.id,
      status: "complete"
    }
  });
}

/** Runs the newest queued history job now, as its quiet window would later. */
async function indexHistory(userId: string): Promise<void> {
  const latest = await prisma.memoryJob.findFirstOrThrow({
    orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
    where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
  });
  // The coordinator settles superseded source jobs as STALE at preflight.
  await prisma.memoryJob.updateMany({
    data: { completedAt: new Date(), errorCode: "memory_source_stale", state: "STALE" },
    where: { id: { not: latest.id }, kind: "INDEX_HISTORY", state: "QUEUED", userId }
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
    where: { id: latest.id }
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
  const handler = createPrismaMemoryHistoryIndexHandler(prisma);
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const now = new Date();
  const result = await handler.execute(claim, {
    now: () => now,
    setStage: async () => undefined,
    signal: new AbortController().signal
  });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  })).resolves.toBe(true);
}

/** A chat whose first turn is indexed and whose second answer settled inside
 * the history quiet window, so nothing indexed it yet. */
async function chatWithUnindexedAnswer(userId: string, label: string) {
  const chat = await prisma.chat.create({ data: { title: `Branch revision ${label}`, userId } });
  const startedAt = Date.now() - 10 * 60_000;
  const first = await createTurn({
    assistantText: `Noted: the ${label} harbour ferry leaves at seven.`,
    chatId: chat.id,
    createdAt: new Date(startedAt),
    parentMessageId: null,
    userId,
    userText: `Which ${label} ferry should I take tomorrow?`
  });
  await settleAnswer(userId, chat.id, first, "NORMAL_APPEND");
  await indexHistory(userId);
  const second = await createTurn({
    assistantText: `The ${label} unindexedanswer suggests the evening ferry.`,
    chatId: chat.id,
    createdAt: new Date(startedAt + 60_000),
    parentMessageId: first.assistantMessage.id,
    userId,
    userText: `And the ${label} return trip?`
  });
  await settleAnswer(userId, chat.id, second, "NORMAL_APPEND");
  await expect(prisma.memoryJob.count({
    where: { chatId: chat.id, kind: "INDEX_HISTORY", state: "QUEUED", userId }
  })).resolves.toBe(1);
  return { chat, first, second };
}

async function indexState(userId: string) {
  const [settings, generations, rebuildJobs, embeddingJobs, embeddingChildren] = await Promise.all([
    prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
    prisma.memoryIndexGeneration.findMany({
      orderBy: { generation: "asc" },
      select: { id: true, indexedThroughMemoryRevision: true, indexMode: true, state: true },
      where: { userId }
    }),
    prisma.memoryJob.count({ where: { kind: "REBUILD_INDEX", userId } }),
    prisma.memoryJob.count({ where: { kind: "EMBED_ITEMS", userId } }),
    prisma.memoryEmbeddingBatchItem.count({ where: { userId } })
  ]);
  const active = generations.find(({ id }) => id === settings.activeIndexGenerationId) ?? null;
  return { active, embeddingChildren, embeddingJobs, generations, rebuildJobs, settings };
}

/** The active generation stays current and the periodic cutover reconcile
 * admits no rebuild, generation or vector work for the owner. */
async function expectNoRebuild(
  userId: string,
  baseline: Awaited<ReturnType<typeof indexState>>
): Promise<void> {
  const changed = await indexState(userId);
  expect(changed.active?.id).toBe(baseline.active?.id);
  expect(changed.active?.indexedThroughMemoryRevision)
    .toBe(changed.settings.memoryRevision);
  await expect(createPrismaMemoryRetrievalCutoverRepository(ownerScopedClient(userId))
    .reconcile({ limit: 100 })).resolves.toEqual([]);
  const after = await indexState(userId);
  expect(after.generations).toEqual(changed.generations);
  expect(after.generations).toHaveLength(baseline.generations.length);
  expect(after.rebuildJobs).toBe(baseline.rebuildJobs);
  expect(after.embeddingJobs).toBe(baseline.embeddingJobs);
  expect(after.embeddingChildren).toBe(baseline.embeddingChildren);
}

/** Authorized, lexically matching history entries of the active generation. */
async function recalledChunks(userId: string, word: string) {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  return prisma.$queryRaw<Array<{ text: string }>>(Prisma.sql`
    SELECT chunk."safeProjectedText" AS "text"
    FROM "MemorySearchEntry" AS entry
    INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = entry."userId" AND chunk."id" = entry."recallChunkId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = chunk."userId" AND source_chat."id" = chunk."chatId"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId" AND checkpoint."chatId" = chunk."chatId"
    WHERE entry."userId" = ${userId}
      AND entry."indexGenerationId" = ${settings.activeIndexGenerationId}
      AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND entry."searchVectorSimple" @@ plainto_tsquery('simple', ${word})
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND ${memoryHistoryChunkSourceAuthorityPredicate({
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
  `);
}

describe("Memory branch-path changes that leave the index unchanged", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("regenerates an unindexed answer without a vector rebuild and recalls the new answer incrementally", async () => {
    const owner = await createOwner("regenerate", "HYBRID");
    const { userId } = owner;
    try {
      const { chat, second } = await chatWithUnindexedAnswer(userId, "regenerate");
      const baseline = await indexState(userId);
      expect(baseline.active).toMatchObject({ indexMode: "HYBRID", state: "ACTIVE" });
      expect(baseline.active?.indexedThroughMemoryRevision).toBe(baseline.settings.memoryRevision);
      expect(baseline.generations).toHaveLength(1);
      // Indexing the first turn queued its own vectors; nothing else did.
      expect(baseline.embeddingJobs).toBeGreaterThan(0);
      await expect(createPrismaMemoryRetrievalCutoverRepository(ownerScopedClient(userId))
        .reconcile({ limit: 100 })).resolves.toEqual([]);

      const runs = createPrismaRunRepository(prisma);
      const regenerated = await runs.admitPreparingRun({
        admissionKind: "REGENERATE",
        chatId: chat.id,
        modelId: providerTemplateIds.fakeModel,
        normalizedRequest: normalizedRequest(chat.id, "And the regenerate return trip?"),
        preSendAssistantMessageId: second.assistantMessage.id,
        provider: providerTemplateIds.fakeConnection,
        providerRequestPreview: {},
        userId,
        userMessageId: second.userMessage.id
      });
      const admitted = await indexState(userId);
      expect(admitted.settings.memoryRevision).toBe(baseline.settings.memoryRevision + 1);
      await expectNoRebuild(userId, baseline);

      // A retry after the failed attempt is one more Regenerate.
      await expect(runs.cancelRun({
        payload: { code: "run_cancelled", message: "Cancelled during preparation." },
        runId: regenerated.runId,
        userId
      })).resolves.toMatchObject({ kind: "cancelled" });
      const retried = await createAnswer({
        chatId: chat.id,
        createdAt: new Date(),
        text: "The regenerate freshanswer suggests the morning ferry instead.",
        userId,
        userMessageId: second.userMessage.id
      });
      await settleAnswer(userId, chat.id, retried, "BRANCH_PATH_CHANGE");
      await expectNoRebuild(userId, baseline);

      // Recall follows the incremental path into the same active generation.
      await indexHistory(userId);
      const indexed = await indexState(userId);
      expect(indexed.active?.id).toBe(baseline.active?.id);
      expect(indexed.active?.indexedThroughMemoryRevision).toBe(indexed.settings.memoryRevision);
      expect(indexed.generations).toHaveLength(1);
      expect(indexed.rebuildJobs).toBe(0);
      await expect(recalledChunks(userId, "freshanswer")).resolves.toEqual([
        { text: expect.stringContaining("morning ferry") }
      ]);
      await expect(recalledChunks(userId, "unindexedanswer")).resolves.toEqual([]);
      expect((await recalledChunks(userId, "harbour")).length).toBeGreaterThan(0);
    } finally {
      await owner.cleanup();
    }
  });

  it("keeps edit-and-resend, branch switch and subtree delete off the rebuild path", async () => {
    const owner = await createOwner("branch", "LEXICAL_ONLY");
    const { userId } = owner;
    try {
      const { chat, first, second } = await chatWithUnindexedAnswer(userId, "branch");
      const baseline = await indexState(userId);
      expect(baseline.active).toMatchObject({ indexMode: "LEXICAL_ONLY", state: "ACTIVE" });
      expect(baseline.active?.indexedThroughMemoryRevision).toBe(baseline.settings.memoryRevision);

      const edited = await createPrismaMessageBranchRepository(prisma).createEditedMessageBranch({
        content: textMessageContent("And the branch return trip by train?"),
        originalMessageId: second.userMessage.id,
        userId
      });
      if (!edited) throw new Error("memory_branch_revision_edit_missing");
      await expectNoRebuild(userId, baseline);

      const runs = createPrismaRunRepository(prisma);
      const resent = await runs.admitPreparingRun({
        admissionKind: "REGENERATE",
        chatId: chat.id,
        modelId: providerTemplateIds.fakeModel,
        normalizedRequest: normalizedRequest(chat.id, "And the branch return trip by train?"),
        preSendAssistantMessageId: null,
        provider: providerTemplateIds.fakeConnection,
        providerRequestPreview: {},
        userId,
        userMessageId: edited.id
      });
      await expectNoRebuild(userId, baseline);
      await expect(runs.cancelRun({
        payload: { code: "run_cancelled", message: "Cancelled during preparation." },
        runId: resent.runId,
        userId
      })).resolves.toMatchObject({ kind: "cancelled" });

      await expect(createPrismaChatRepository(prisma).updateChat({
        activeLeafMessageId: second.assistantMessage.id,
        chatId: chat.id,
        userId
      })).resolves.toMatchObject({ activeLeafMessageId: second.assistantMessage.id });
      await expectNoRebuild(userId, baseline);

      await expect(createPrismaMessageBranchRepository(prisma).deleteMessageSubtree({
        messageId: second.userMessage.id,
        userId
      })).resolves.toMatchObject({ activeLeafMessageId: first.assistantMessage.id });
      await expectNoRebuild(userId, baseline);

      const after = await indexState(userId);
      expect(after.settings.memoryRevision).toBe(baseline.settings.memoryRevision + 4);
    } finally {
      await owner.cleanup();
    }
  });

  it("keeps invalidating an already indexed answer on Regenerate", async () => {
    const owner = await createOwner("indexed", "LEXICAL_ONLY");
    const { userId } = owner;
    try {
      const { chat, second } = await chatWithUnindexedAnswer(userId, "indexed");
      await indexHistory(userId);
      await expect(recalledChunks(userId, "unindexedanswer")).resolves.toHaveLength(1);
      const baseline = await indexState(userId);
      const indexedChunks = await prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      });

      const regenerated = await createAnswer({
        chatId: chat.id,
        createdAt: new Date(),
        text: "The indexed replacement suggests the night ferry.",
        userId,
        userMessageId: second.userMessage.id
      });
      await mutateSource(userId, chat.id, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: regenerated.assistantMessage.id }
      });
      // The answer left the active path: its chunk and entry are invalidated
      // in the same transaction that settles the index revision.
      const invalidated = await prisma.memoryRecallChunk.findMany({
        select: { id: true },
        where: { chatId: chat.id, state: "INVALIDATED", userId }
      });
      expect(invalidated.length).toBeGreaterThan(0);
      await expect(prisma.memoryRecallChunk.count({
        where: { chatId: chat.id, state: "ACTIVE", userId }
      })).resolves.toBeLessThan(indexedChunks);
      await expect(prisma.memorySearchEntry.count({
        where: { recallChunkId: { in: invalidated.map(({ id }) => id) }, userId }
      })).resolves.toBe(0);
      await expectNoRebuild(userId, baseline);
    } finally {
      await owner.cleanup();
    }
  });

  it("leaves an index that already lagged to the cutover safety net", async () => {
    const owner = await createOwner("lagging", "LEXICAL_ONLY");
    const { userId } = owner;
    try {
      const { chat, second } = await chatWithUnindexedAnswer(userId, "lagging");
      // A revision some writer advanced without settling the index.
      const lagging = await prisma.userMemorySettings.update({
        data: { memoryRevision: { increment: 1 } },
        where: { userId }
      });
      const before = await indexState(userId);
      expect(before.active?.indexedThroughMemoryRevision).toBe(lagging.memoryRevision - 1);

      const regenerated = await createAnswer({
        chatId: chat.id,
        createdAt: new Date(),
        text: "The lagging replacement suggests the night ferry.",
        userId,
        userMessageId: second.userMessage.id
      });
      await mutateSource(userId, chat.id, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: regenerated.assistantMessage.id }
      });
      const after = await indexState(userId);
      expect(after.settings.memoryRevision).toBe(lagging.memoryRevision + 1);
      expect(after.active?.indexedThroughMemoryRevision).toBe(lagging.memoryRevision - 1);

      const reconciled = await createPrismaMemoryRetrievalCutoverRepository(
        ownerScopedClient(userId)
      ).reconcile({ limit: 100 });
      expect(reconciled).toEqual([
        expect.objectContaining({ kind: "queued", reason: "revision_lag" })
      ]);
      await expect(prisma.memoryJob.count({ where: { kind: "REBUILD_INDEX", userId } }))
        .resolves.toBe(1);
    } finally {
      await owner.cleanup();
    }
  });
});
