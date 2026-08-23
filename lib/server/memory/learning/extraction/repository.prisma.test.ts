import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../../domain/content";
import { providerTemplateIds } from "../../../../domain/providerTemplates";
import { prisma } from "../../../prisma";
import type { MemoryJobClaim } from "../../coordinator/types";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256
} from "../../persistence/lexical";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../../retrieval/vector";
import { defaultMemorySourceMutationHooks } from "../../sourceHooks";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../../sourceState";
import { MemorySuppressionKeyring } from "../../suppressionKeyring";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_POLICY_VERSION,
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "./contract";
import { decodeMemoryFactExtraction } from "./decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import { createPrismaMemoryFactExtractionRepository } from "./repository";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 101));
const keyring = MemorySuppressionKeyring.parse(
  `current=facts-v1,facts-v1=${keyBytes.toString("base64")}`
);

async function createOwner(label: string): Promise<string> {
  const suffix = randomUUID();
  const userId = `memory-vnext-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory vNext extraction test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: { learnAutomatically: true, referenceChatHistory: false },
    where: { userId }
  });
  return userId;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
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
  const assistantAt = new Date(input.createdAt.getTime() + 1_000);
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: input.chatId,
      content: textMessageContent(input.assistantText),
      createdAt: assistantAt,
      modelId: "memory-vnext-test-model",
      parentMessageId: userMessage.id,
      provider: "memory-vnext-test-provider",
      role: "assistant",
      status: "complete",
      updatedAt: assistantAt
    }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: assistantMessage.id,
      chatId: input.chatId,
      modelId: "memory-vnext-test-model",
      normalizedRequest: {
        prompt: {
          baseline: {
            source: "standard_chat",
            timeZone: "Europe/Moscow",
            timeZoneSource: "client"
          }
        }
      },
      provider: "memory-vnext-test-provider",
      status: "complete",
      userId: input.userId,
      userMessageId: userMessage.id
    }
  });
  return { assistantMessage, run, userMessage };
}

async function settleChat(
  userId: string,
  chatId: string,
  turn: Awaited<ReturnType<typeof createTurn>>
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_vnext_test_chat_missing");
    await applyMemorySourceMutations(tx, {
      chat,
      hooks: defaultMemorySourceMutationHooks,
      mutations: ["NORMAL_APPEND"],
      patch: { activeLeafMessageId: turn.assistantMessage.id }
    });
  });
  await prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_vnext_test_chat_missing");
    await applyMemorySourceMutations(tx, {
      chat,
      hooks: defaultMemorySourceMutationHooks,
      mutations: ["TERMINAL_SETTLEMENT"],
      terminalSettlement: {
        assistantMessageId: turn.assistantMessage.id,
        runId: turn.run.id,
        status: "complete"
      }
    });
  });
}

async function claimFactJob(
  userId: string,
  sourceMessageId: string
): Promise<MemoryJobClaim> {
  const job = await prisma.memoryJob.findFirstOrThrow({
    where: {
      kind: "EXTRACT_FACTS",
      sourceMessageId,
      state: "QUEUED",
      userId
    }
  });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 120_000);
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
    userId: claimed.userId
  };
}

function extractionPlan(
  input: MemoryFactExtractionInput,
  quote: string,
  statement = "The user bought a MacBook Air."
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      candidates: [{
        category: "about_you",
        confidence_band: "HIGH",
        correction: false,
        future_useful: true,
        quote,
        reason_code: "durable_direct_fact",
        response_preference: null,
        sensitivity: "NORMAL",
        statement,
        temporary: false
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

async function createSucceededBinding(
  userId: string,
  claim: MemoryJobClaim,
  inputHash: string,
  outputHash: string
): Promise<string> {
  const id = `fact-binding-${randomUUID()}`;
  const completedAt = new Date();
  const createdAt = new Date(completedAt.getTime() - 1_000);
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash: outputHash,
      completedAt,
      createdAt,
      destinationFingerprint: "d".repeat(64),
      id,
      inputHash,
      logicalRole: "MEMORY_FACT_EXTRACT",
      memoryJobId: claim.id,
      ordinal: 0,
      ownerType: "JOB",
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
      promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
      providerId: "openai_compatible",
      recoverableUntil: completedAt,
      relationsDetachedAt: completedAt,
      schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
      secretFreeExecutionSnapshot: {},
      startedAt: createdAt,
      state: "SUCCEEDED",
      usageCompleteness: "UNAVAILABLE",
      userId
    }
  });
  await prisma.usageEvent.create({
    data: {
      memoryExecutionBindingId: id,
      modelId: "memory-vnext-test-model",
      provider: "openai_compatible",
      providerModelId: "memory-vnext-test-model",
      userId
    }
  });
  return id;
}

function repository() {
  return createPrismaMemoryFactExtractionRepository(prisma, {
    keyring: () => keyring
  });
}

async function prepare(claim: MemoryJobClaim): Promise<MemoryFactExtractionInput> {
  const result = await repository().prepare(claim);
  if ("decision" in result) throw new Error(result.decision.errorCode);
  return result.input;
}

async function applyPlan(
  userId: string,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  bindingId: string
) {
  return withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    repository().apply(tx, settings, claim, plan, bindingId, new Date()));
}

async function activateHybridIndex(userId: string): Promise<void> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId }
  });
  const model = await prisma.providerModel.findUniqueOrThrow({
    select: { connectionId: true },
    where: { id: providerTemplateIds.fakeModel }
  });
  const latest = await prisma.memoryIndexGeneration.aggregate({
    _max: { generation: true },
    where: { userId }
  });
  const now = new Date();
  const generation = await prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
      embeddingConfigurationFingerprint: "b".repeat(64),
      embeddingConnectionId: model.connectionId,
      embeddingDimension: 1_024,
      embeddingProviderModelId: providerTemplateIds.fakeModel,
      generation: (latest._max.generation ?? -1) + 1,
      indexMode: "HYBRID",
      indexedThroughMemoryRevision: settings.memoryRevision,
      languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
      normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
      readyAt: now,
      retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
      state: "READY",
      targetMemoryRevision: settings.memoryRevision,
      userId,
      vectorSpaceFingerprint: "c".repeat(64)
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({
      data: {
        activeIndexGenerationId: generation.id,
        embeddingProviderModelId: providerTemplateIds.fakeModel
      },
      where: { userId }
    });
    await tx.memoryIndexGeneration.update({
      data: { activatedAt: now, state: "ACTIVE" },
      where: { id: generation.id }
    });
  });
}

describe("Prisma Memory vNext source-message ingestion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("survives a rapid next turn, commits exact evidence, and deduplicates retry and repeat", async () => {
    const userId = await createOwner("rapid-retry");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Stable per-message ingestion", userId }
      });
      const first = await createTurn({
        assistantText: "Congratulations.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, first);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const firstInput = await prepare(firstClaim);
      expect(firstInput.messages.map(({ evidenceEligible, id, role }) => ({
        evidenceEligible,
        id,
        role
      }))).toEqual([
        { evidenceEligible: true, id: first.userMessage.id, role: "user" },
        { evidenceEligible: false, id: first.assistantMessage.id, role: "assistant" }
      ]);
      expect(firstInput.source.sourceMessageId).toBe(first.userMessage.id);

      const second = await createTurn({
        assistantText: "Still noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T10:01:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, second);

      const preparedAfterNextTurn = await prepare(firstClaim);
      expect(preparedAfterNextTurn.inputHash).toBe(firstInput.inputHash);
      const firstPlan = extractionPlan(firstInput, "I bought a MacBook Air.");
      const firstBinding = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await expect(applyPlan(userId, firstClaim, firstPlan, firstBinding))
        .resolves.toBe("APPLIED");

      const secondClaim = await claimFactJob(userId, second.userMessage.id);
      const secondInput = await prepare(secondClaim);
      const secondPlan = extractionPlan(secondInput, "I bought a MacBook Air.");
      const secondBinding = await createSucceededBinding(
        userId,
        secondClaim,
        secondInput.inputHash,
        secondPlan.outputHash
      );
      await expect(applyPlan(userId, secondClaim, secondPlan, secondBinding))
        .resolves.toBe("APPLIED");
      await expect(applyPlan(userId, firstClaim, firstPlan, firstBinding))
        .resolves.toBe("APPLIED");

      const facts = await prisma.memoryFact.findMany({ where: { userId } });
      const versions = await prisma.memoryFactVersion.findMany({ where: { userId } });
      const evidence = await prisma.memoryEvidence.findMany({
        orderBy: { observedAt: "asc" },
        where: { userId }
      });
      expect(facts).toHaveLength(1);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        observedAt: first.userMessage.createdAt,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        sourceMode: "AUTOMATIC",
        state: "ACTIVE"
      });
      await expect(prisma.memoryFactVersion.update({
        data: { observedAt: second.userMessage.createdAt },
        where: { id: versions[0]!.id }
      })).rejects.toThrow(/observedAt is immutable once assigned/u);
      expect(evidence).toHaveLength(2);
      expect(evidence.map((item) => ({
        excerpt: item.safeExcerpt,
        messageId: item.messageId,
        role: item.sourceRole
      }))).toEqual([
        {
          excerpt: "I bought a MacBook Air.",
          messageId: first.userMessage.id,
          role: "user"
        },
        {
          excerpt: "I bought a MacBook Air.",
          messageId: second.userMessage.id,
          role: "user"
        }
      ]);
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryEvent.count({
        where: { operation: "PROMOTE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEvent.count({
        where: { operation: "REINFORCE", userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("terminalizes a valid empty extraction without writing semantic rows", async () => {
    const userId = await createOwner("empty");
    try {
      const chat = await prisma.chat.create({ data: { title: "No memory", userId } });
      const turn = await createTurn({
        assistantText: "Hello.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Hello!"
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = decodeMemoryFactExtraction([{
        arguments: { candidates: [] },
        id: `fact-call-${randomUUID()}`,
        name: MEMORY_FACT_EXTRACTION_TOOL_NAME
      }], input);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: claim.id } }))
        .resolves.toMatchObject({ stage: "fact_observations_applied" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects a delayed job whose direct source message was deleted", async () => {
    const userId = await createOwner("deleted-source");
    try {
      const chat = await prisma.chat.create({ data: { title: "Deleted source", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      await prisma.memoryJob.delete({ where: { id: claim.id } });
      await prisma.modelRun.delete({ where: { id: turn.run.id } });
      await prisma.message.delete({ where: { id: turn.assistantMessage.id } });
      await prisma.message.delete({ where: { id: turn.userMessage.id } });

      await expect(repository().preflight(claim)).resolves.toEqual({
        errorCode: "memory_fact_source_stale",
        status: "STALE"
      });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects messages created inside a closed automatic-learning pause interval", async () => {
    const userId = await createOwner("pause");
    try {
      const chat = await prisma.chat.create({ data: { title: "Paused source", userId } });
      const createdAt = new Date("2026-08-22T13:00:00.000Z");
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt,
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      await prisma.memoryPauseInterval.create({
        data: {
          memoryGeneration: claim.memoryGenerationSnapshot,
          pausedAt: new Date(createdAt.getTime() - 1_000),
          resumedAt: new Date(createdAt.getTime() + 1_000),
          scope: "AUTOMATIC_LEARNING",
          userId
        }
      });
      await expect(repository().preflight(claim)).resolves.toMatchObject({
        status: "STALE"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects a pre-reset job after the Memory generation advances", async () => {
    const userId = await createOwner("generation");
    try {
      const chat = await prisma.chat.create({ data: { title: "Generation fence", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T14:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      await prisma.userMemorySettings.update({
        data: { memoryGeneration: { increment: 1 } },
        where: { userId }
      });
      await expect(repository().preflight(claim)).resolves.toMatchObject({
        status: "STALE"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("enforces direct-user source identity at the database boundary", async () => {
    const userId = await createOwner("assistant-source");
    try {
      const chat = await prisma.chat.create({ data: { title: "Assistant source", userId } });
      const turn = await createTurn({
        assistantText: "Assistant text is not evidence.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T15:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Hello."
      });
      await expect(prisma.memoryJob.create({
        data: {
          activeLeafMessageId: turn.assistantMessage.id,
          branchGeneration: 0,
          chatId: chat.id,
          idempotencyFingerprint: memorySha256(randomUUID()),
          kind: "EXTRACT_FACTS",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
          sourceHash: "a".repeat(64),
          sourceMessageId: turn.assistantMessage.id,
          sourceRevision: 0,
          userId
        }
      })).rejects.toThrow(/exact settled direct USER message/u);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("commits the fact before embedding work and leaves a retryable pending index job", async () => {
    const userId = await createOwner("embedding-outage");
    try {
      await activateHybridIndex(userId);
      const chat = await prisma.chat.create({ data: { title: "Embedding outage", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T16:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, "I bought a MacBook Air.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");

      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memorySearchEntry.findFirstOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ embeddingState: "PENDING" });
      await expect(prisma.memoryJob.count({
        where: { kind: "EMBED_ITEMS", state: "QUEUED", userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });
});
