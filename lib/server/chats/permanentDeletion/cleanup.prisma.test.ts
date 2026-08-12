import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaShareRepository } from "../../shares/prismaRepository";
import { createMemoryStorageAdapter } from "../../uploads/storage";
import { MemoryCoordinator } from "../../memory/coordinator/coordinator";
import { createPrismaMemoryCoordinatorRepository } from
  "../../memory/coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from "../../memory/coordinator/registry";
import { createPrismaExplicitMemoryRepository } from "../../memory/explicit/repository";
import {
  createPrismaMemoryMutationAuthorizationRepository,
  memoryMutationNonceHash
} from "../../memory/persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../../memory/persistence/facts";
import { memorySha256, normalizeMemorySearchText } from
  "../../memory/persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../../memory/persistence/scopes";
import { loadMemoryRunEvidence } from "../../memory/receipts/projection";
import { MemorySuppressionKeyring } from "../../memory/suppressionKeyring";
import { createPrismaPermanentChatDeletionHandler } from "./cleanup";
import { createPrismaPermanentChatDeletionRepository } from "./repository";
import { createPermanentChatDeletionService } from "./service";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 17));
const keyringText = `current=chat-delete-v1,chat-delete-v1=${keyBytes.toString("base64")}`;
const keyring = MemorySuppressionKeyring.parse(keyringText);

async function createOwner(): Promise<string> {
  const id = `permanent-chat-owner-${randomUUID()}`;
  await prisma.user.create({
    data: {
      displayName: "Permanent chat deletion test",
      email: `${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function createTurn(userId: string, title: string) {
  const chat = await prisma.chat.create({ data: { title, userId } });
  const userMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(`${title} user`),
      role: "user",
      status: "complete"
    }
  });
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(`${title} assistant`),
      modelId: "permanent-chat-test-model",
      parentMessageId: userMessage.id,
      provider: "permanent-chat-test-provider",
      role: "assistant",
      status: "complete"
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
      modelId: "permanent-chat-test-model",
      normalizedRequest: { accepted: title },
      provider: "permanent-chat-test-provider",
      providerRequestPreview: { accepted: title },
      status: "complete",
      userId,
      userMessageId: userMessage.id
    }
  });
  return { assistantMessage, chat, run, userMessage };
}

async function createSourceChunk(input: Readonly<{
  assistantCreatedAt: Date;
  chatId: string;
  messageId: string;
  userId: string;
}>) {
  const text = "Frozen previous-chat memory text";
  const chunk = await prisma.memoryRecallChunk.create({
    data: {
      branchGeneration: 0,
      chatId: input.chatId,
      chunkOrdinal: 0,
      chunkingVersion: "permanent-chat-test-v1",
      contentHash: memorySha256(text),
      languageCode: "en",
      normalizedSafeSearchText: normalizeMemorySearchText(text),
      occurredFrom: new Date(input.assistantCreatedAt.getTime() - 1_000),
      occurredTo: input.assistantCreatedAt,
      redactionReasonCodes: [],
      redactionState: "NOT_NEEDED",
      safeProjectedText: text,
      safetyClass: "NORMAL",
      sourceProjectionVersion: "permanent-chat-test-v1",
      sourceRevisionAtCreation: 0,
      userId: input.userId
    }
  });
  await prisma.memoryRecallChunkMessage.create({
    data: {
      chatId: input.chatId,
      chunkId: chunk.id,
      endOffset: text.length,
      messageId: input.messageId,
      ordinal: 0,
      role: "user",
      startOffset: 0,
      userId: input.userId
    }
  });
  return { chunk, text };
}

async function createAcceptedDestinationReceipt(input: Readonly<{
  chunkId: string;
  sourceChatId: string;
  sourceContentHash: string;
  sourceMessageId: string;
  userId: string;
}>) {
  const destination = await createTurn(input.userId, "Destination");
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId: input.userId }
  });
  const includedText = "Frozen accepted destination text";
  const now = new Date();
  const { memoryItem } = await prisma.$transaction(async (tx) => {
    const attempt = await tx.memoryRetrievalAttempt.create({
      data: {
        admissionKind: "NORMAL_SEND",
        admittedAssistantLeafMessageId: destination.assistantMessage.id,
        admittedUserMessageId: destination.userMessage.id,
        attemptOrdinal: 0,
        baseRequestHash: memorySha256({ kind: "destination-base" }),
        boundedPrivateBaseRequestSnapshot: {},
        chatId: destination.chat.id,
        chatMemoryModeSnapshot: "NORMAL",
        consumedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        memoryGenerationSnapshot: settings.memoryGeneration,
        modelRunId: destination.run.id,
        outcome: "USED",
        preparedContextHash: memorySha256(includedText),
        preparedContextText: includedText,
        preparedContextTokenCount: 6,
        queryHash: memorySha256("destination-query"),
        retrievalRevisionSnapshot: settings.memoryRevision,
        settingsSnapshot: {},
        state: "CONSUMED",
        userId: input.userId,
        utilityEgressMode: "LOCAL_ONLY"
      }
    });
    await tx.memoryRetrievalAttemptItem.create({
      data: {
        attemptId: attempt.id,
        exactItemId: input.chunkId,
        exactSafeText: includedText,
        featureSnapshot: {},
        itemType: "RECALL_CHUNK",
        laneRanks: {},
        ordinal: 0,
        recallChunkId: input.chunkId,
        selectionReason: "permanent-chat-test",
        sourceBranchGenerationSnapshot: 0,
        sourceChatIdSnapshot: input.sourceChatId,
        sourceContentHashSnapshot: input.sourceContentHash,
        sourceRevisionSnapshot: 0,
        sourceSnapshot: { sourceMode: "HISTORY" },
        textHash: memorySha256(includedText),
        userId: input.userId,
        versionSnapshot: { scopeType: "GLOBAL_USER" }
      }
    });
    const binding = await tx.modelRunMemoryBinding.create({
      data: {
        boundedSafeQuerySnapshot: "destination-query",
        contextTextHash: memorySha256(includedText),
        contextTokenCount: 6,
        finalizedAt: now,
        finalizedRevisionSnapshot: settings.memoryRevision,
        memoryGenerationSnapshot: settings.memoryGeneration,
        modelRunId: destination.run.id,
        outcome: "USED",
        queryHash: memorySha256("destination-query"),
        queryPlannerVersion: "permanent-chat-test-v1",
        retrievalAttemptId: attempt.id,
        retrievalPipelineVersion: "permanent-chat-test-v1",
        retrievalRevisionSnapshot: settings.memoryRevision,
        settingsSnapshot: {},
        userId: input.userId
      }
    });
    const memoryItem = await tx.modelRunMemoryItem.create({
      data: {
        bindingId: binding.id,
        exactItemId: input.chunkId,
        featureSnapshot: {},
        finalScore: 0.9,
        includedText,
        includedTextHash: memorySha256(includedText),
        itemStateAtAdmission: "ACTIVE",
        itemType: "RECALL_CHUNK",
        laneRanks: {},
        ordinal: 0,
        recallChunkId: input.chunkId,
        selectionReason: "permanent-chat-test",
        sourceBranchGenerationSnapshot: 0,
        sourceChatIdSnapshot: input.sourceChatId,
        sourceContentHashSnapshot: input.sourceContentHash,
        sourceMessageIdsSnapshot: [input.sourceMessageId],
        sourceRevisionSnapshot: 0,
        userId: input.userId
      }
    });
    return { memoryItem };
  });
  return { destination, includedText, memoryItem };
}

async function createOriginExplicitFact(input: Readonly<{
  sourceChatId: string;
  sourceMessageId: string;
  sourceRunId: string;
  statement: string;
  userId: string;
}>) {
  const scope = await createPrismaMemoryScopeRepository(prisma)
    .ensureGlobal(input.userId);
  const now = new Date();
  const requestId = randomUUID();
  const payloadHash = memorySha256({ requestId, statement: input.statement });
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const authorization = await authorizationRepository.mint(input.userId, {
    action: "SAVE",
    authorizedPayloadHash: payloadHash,
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactSourceEnd: input.statement.length,
    exactSourceStart: 0,
    expiresAt: new Date(now.getTime() + 60_000),
    modelRunId: input.sourceRunId,
    nonceHash: memoryMutationNonceHash(input.userId, randomUUID()),
    requestId,
    sourceChatId: input.sourceChatId,
    sourceMessageId: input.sourceMessageId
  }, now);
  return createPrismaMemoryFactRepository(keyring, prisma).save(input.userId, {
    authorization: {
      action: "SAVE",
      authorizationId: authorization.id,
      authorizedPayloadHash: payloadHash
    },
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: now,
      safeExcerpt: input.statement,
      safeSourceHash: memorySha256(input.statement),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "permanent-chat-test-v1"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint: memorySha256({ domain: "origin-fact", requestId }),
    idempotencyPayloadHash: payloadHash,
    modelRunId: input.sourceRunId,
    requestId,
    scopeId: scope.id,
    value: {
      canonicalKey: `preference.origin.${memorySha256(input.statement).slice(0, 32)}`,
      category: "preference",
      confidence: 1,
      directness: "DIRECT",
      displayText: input.statement,
      importance: 0.8,
      languageCode: "en",
      modality: "PREFERENCE",
      pipelineVersion: "permanent-chat-test-v1",
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      structuredValue: { statement: input.statement }
    }
  });
}

async function runScenario(alsoForgetOriginMemories: boolean) {
  const userId = await createOwner();
  const source = await createTurn(userId, "Source");
  const { chunk } = await createSourceChunk({
    assistantCreatedAt: source.assistantMessage.createdAt,
    chatId: source.chat.id,
    messageId: source.userMessage.id,
    userId
  });
  const accepted = await createAcceptedDestinationReceipt({
    chunkId: chunk.id,
    sourceChatId: source.chat.id,
    sourceContentHash: chunk.contentHash,
    sourceMessageId: source.userMessage.id,
    userId
  });
  const originFact = await createOriginExplicitFact({
    sourceChatId: source.chat.id,
    sourceMessageId: source.userMessage.id,
    sourceRunId: source.run.id,
    statement: `Origin preference ${randomUUID()}`,
    userId
  });
  const sourceEvent = await prisma.memoryEvent.create({
    data: {
      actorType: "JOB",
      metadata: {},
      operation: "AUTO_PROPOSE",
      sourceChatId: source.chat.id,
      userId
    }
  });
  const storage = createMemoryStorageAdapter();
  const storageKey = `permanent-chat/${randomUUID()}`;
  await storage.putObject({
    body: Buffer.from("private attachment"),
    contentType: "text/plain",
    storageKey
  });
  await prisma.attachment.create({
    data: {
      byteSize: 18,
      chatId: source.chat.id,
      fileName: "private.txt",
      kind: "file",
      metadata: {},
      mimeType: "text/plain",
      status: "ready",
      storageKey,
      userId
    }
  });
  await prisma.usageEvent.create({
    data: {
      chatId: source.chat.id,
      modelId: source.run.modelId,
      modelRunId: source.run.id,
      provider: source.run.provider,
      userId
    }
  });
  const shareSlugHash = `permanent-share-${randomUUID()}`;
  await createPrismaShareRepository(prisma).createChatShare({
    activeLeafMessageId: source.assistantMessage.id,
    chatId: source.chat.id,
    shareToken: "private-test-token",
    slugHash: shareSlugHash,
    userId
  });

  let kicked = 0;
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const service = createPermanentChatDeletionService({
    authorizationRepository,
    capability: { enabled: true },
    kick: () => { kicked += 1; },
    repository: createPrismaPermanentChatDeletionRepository(prisma)
  });
  const before = await prisma.chat.findUniqueOrThrow({ where: { id: source.chat.id } });
  const authorization = await service.mintAuthorization(userId, source.chat.id, {
    alsoForgetOriginMemories,
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    expectedActiveLeafMessageId: source.assistantMessage.id,
    expectedChatRevision: before.memorySourceRevision,
    requestNonce: randomUUID()
  });
  const admission = await service.admit(userId, source.chat.id, {
    alsoForgetOriginMemories,
    expectedActiveLeafMessageId: source.assistantMessage.id,
    expectedChatRevision: before.memorySourceRevision,
    mutationAuthorizationId: authorization.mutationAuthorizationId
  });
  expect(kicked).toBe(1);
  await expect(createPrismaShareRepository(prisma).findPublicShare(
    shareSlugHash,
    new Date()
  )).resolves.toBeNull();
  await expect(prisma.message.create({
    data: {
      chatId: source.chat.id,
      content: textMessageContent("late write"),
      role: "user"
    }
  })).rejects.toThrow();
  const fencedReceipt = (await loadMemoryRunEvidence(prisma, {
    runIds: [accepted.destination.run.id],
    userId
  })).get(accepted.destination.run.id)?.receipt;
  expect(fencedReceipt?.items[0]).toMatchObject({
    includedText: accepted.includedText,
    lifecycleState: "SOURCE_DELETED",
    sourceChatId: null
  });

  const registry = new MemoryCoordinatorRegistry();
  let injectFailure = true;
  const cleanupHandler = createPrismaPermanentChatDeletionHandler({
    async deleteObject(key) {
      await storage.deleteObject(key);
      if (injectFailure) {
        injectFailure = false;
        throw new Error("injected_after_object_delete_failure");
      }
    }
  }, prisma);
  registry.registerDeletion(cleanupHandler);
  let coordinatorNow = new Date();
  const coordinator = new MemoryCoordinator({
    now: () => coordinatorNow,
    policy: { maxDeletionFastAttempts: 2 },
    registry,
    repository: createPrismaMemoryCoordinatorRepository(prisma)
  });
  await coordinator.reconcileNow();
  await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({
    where: { id: admission.deletionId }
  })).resolves.toMatchObject({
    errorCode: "memory_permanent_chat_object_delete_failed",
    state: "RETRY_WAIT"
  });
  await expect(prisma.chat.count({ where: { id: source.chat.id } })).resolves.toBe(1);
  expect(storage.objects.has(storageKey)).toBe(false);
  coordinatorNow = new Date(coordinatorNow.getTime() + 2_000);
  await coordinator.reconcileNow();

  const completedDeletion = await prisma.memoryDeletionOutbox.findUniqueOrThrow({
    where: { id: admission.deletionId }
  });
  expect(completedDeletion).toMatchObject({ state: "SUCCEEDED" });
  await expect(prisma.chat.count({ where: { id: source.chat.id } })).resolves.toBe(0);
  await expect(prisma.modelRun.findUnique({ where: { id: source.run.id } }))
    .resolves.toBeNull();
  await expect(prisma.attachment.count({ where: { chatId: source.chat.id } }))
    .resolves.toBe(0);
  await expect(prisma.sharedChatSnapshot.count({ where: { chatId: source.chat.id } }))
    .resolves.toBe(0);
  await expect(prisma.memoryRecallChunk.findUnique({ where: { id: chunk.id } }))
    .resolves.toBeNull();
  await expect(prisma.memoryEvent.findUniqueOrThrow({ where: { id: sourceEvent.id } }))
    .resolves.toMatchObject({ sourceChatId: null, sourceDeletedAt: expect.any(Date) });
  await expect(prisma.modelRunMemoryItem.findUniqueOrThrow({
    where: { id: accepted.memoryItem.id }
  })).resolves.toMatchObject({
    includedText: accepted.includedText,
    recallChunkId: null,
    sourceChatIdSnapshot: source.chat.id
  });
  await expect(prisma.modelRun.findUniqueOrThrow({
    where: { id: accepted.destination.run.id }
  })).resolves.toMatchObject({ normalizedRequest: { accepted: "Destination" } });
  const finalReceipt = (await loadMemoryRunEvidence(prisma, {
    runIds: [accepted.destination.run.id],
    userId
  })).get(accepted.destination.run.id)?.receipt;
  expect(finalReceipt?.items[0]).toMatchObject({
    includedText: accepted.includedText,
    lifecycleState: "SOURCE_DELETED",
    sourceChatId: null
  });
  await expect(service.status(userId, source.chat.id, admission.deletionId))
    .resolves.toMatchObject({ cleanupComplete: true, state: "SUCCEEDED" });
  const fact = await prisma.memoryFact.findUniqueOrThrow({
    where: { id: originFact.factId }
  });
  expect(fact.state).toBe(alsoForgetOriginMemories ? "FORGOTTEN" : "ACTIVE");
  if (alsoForgetOriginMemories) {
    await expect(prisma.memorySuppression.count({
      where: { scope: { in: ["FACT", "VALUE"] }, userId }
    })).resolves.toBeGreaterThanOrEqual(2);
  }
  if (!completedDeletion.completedAt) {
    throw new Error("memory_permanent_chat_cleanup_completion_missing");
  }
  const evidence = Object.freeze({
    acceptedDestinationEvidencePreserved: true,
    cleanupLatencyMs: completedDeletion.completedAt.getTime() -
      completedDeletion.createdAt.getTime(),
    evidenceVersion: "memory-phase8-permanent-chat-cleanup-v1",
    maximumCleanupLatencyMs: 15 * 60_000,
    recoveredObjectStageFailureCount: 1,
    sanitizedAggregatesOnly: true
  });
  expect(evidence.cleanupLatencyMs).toBeGreaterThanOrEqual(0);
  expect(evidence.cleanupLatencyMs).toBeLessThan(evidence.maximumCleanupLatencyMs);
  expect(JSON.stringify(evidence)).not.toContain(userId);
  expect(JSON.stringify(evidence)).not.toContain(accepted.includedText);
  console.info("memory_phase8_permanent_chat_cleanup", evidence);
  return { evidence, userId };
}

describe("permanent chat deletion cleanup", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("resumes after object-stage failure and preserves accepted destination evidence", async () => {
    const { userId } = await runScenario(false);
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("uses the normal Forget fence only when the admitted origin-memory option is true", async () => {
    const previous = process.env.AIQSA_MEMORY_FINGERPRINT_KEYRING;
    process.env.AIQSA_MEMORY_FINGERPRINT_KEYRING = keyringText;
    try {
      const { userId } = await runScenario(true);
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    } finally {
      if (previous === undefined) {
        delete process.env.AIQSA_MEMORY_FINGERPRINT_KEYRING;
      } else {
        process.env.AIQSA_MEMORY_FINGERPRINT_KEYRING = previous;
      }
    }
  });
});
