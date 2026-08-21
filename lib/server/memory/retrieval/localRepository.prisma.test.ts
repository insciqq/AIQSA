import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import {
  fuseMemoryRetrievalCandidates,
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryRankedCandidate
} from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import {
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { createPrismaLocalMemoryRetrievalRepository } from "./localRepository";

const fixtureNow = new Date("2026-08-10T12:00:00.000Z");
const suffix = randomUUID();
const ownerIds: string[] = [];

type RetrievalFixture = Readonly<{
  assistantId: string;
  automaticSensitiveFactVersionId: string;
  currentChatId: string;
  enFactVersionId: string;
  excludedChunkId: string;
  foreignFactVersionId: string;
  generationId: string;
  historicalFactVersionId: string;
  legacyAssistantFactVersionId: string;
  legacyChatFactVersionId: string;
  legacyFolderFactVersionId: string;
  otherFolderFactVersionId: string;
  rawSourceText: string;
  ruFactVersionId: string;
  safeChunkText: string;
  secretChunkId: string;
  sensitiveChunkId: string;
  sensitiveFactVersionId: string;
  sourceChatId: string;
  staleAutomaticFactVersionId: string;
  staleChunkId: string;
  userId: string;
  validChunkId: string;
}>;

let fixture: RetrievalFixture;

async function createOwner(prefix: string): Promise<string> {
  const userId = `${prefix}-${suffix}`;
  ownerIds.push(userId);
  await prisma.user.create({
    data: {
      displayName: `Memory retrieval ${prefix}`,
      email: `${prefix}-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  return userId;
}

async function activateLexicalGeneration(userId: string): Promise<string> {
  const generation = await prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: "memory-history-chunking-v2",
      generation: 0,
      indexMode: "LEXICAL_ONLY",
      indexedThroughMemoryRevision: 0,
      languageProfile: "RU_EN_MULTILINGUAL_V1",
      normalizationVersion: "memory-search-normalization-v1",
      readyAt: fixtureNow,
      retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
      state: "READY",
      targetMemoryRevision: 0,
      userId
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({
      data: {
        activeIndexGenerationId: generation.id,
        referenceChatHistory: true,
        useMemoryFacts: true
      },
      where: { userId }
    });
    await tx.memoryIndexGeneration.update({
      data: { activatedAt: fixtureNow, state: "ACTIVE" },
      where: { id: generation.id }
    });
  });
  return generation.id;
}

async function createChatWithLeaf(input: Readonly<{
  folderId?: string;
  memoryMode?: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  sourceRevision?: number;
  title: string;
  userId: string;
  userText: string;
}>): Promise<Readonly<{ chatId: string; messageId: string }>> {
  const chat = await prisma.chat.create({
    data: {
      folderId: input.folderId,
      memoryMode: input.memoryMode ?? "NORMAL",
      memorySourceRevision: input.sourceRevision ?? 1,
      title: input.title,
      userId: input.userId
    }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(input.userText),
      createdAt: new Date("2026-07-15T09:00:00.000Z"),
      role: "user",
      status: "complete",
      updatedAt: new Date("2026-07-15T09:00:00.000Z")
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: message.id },
    where: { id: chat.id }
  });
  return { chatId: chat.id, messageId: message.id };
}

async function createCheckpoint(input: Readonly<{
  chatId: string;
  messageId: string;
  sourceHash: string;
  userId: string;
}>): Promise<void> {
  await prisma.chatMemoryCheckpoint.create({
    data: {
      activeLeafMessageId: input.messageId,
      branchGeneration: 0,
      chatId: input.chatId,
      lastIndexedMessageId: input.messageId,
      lastSucceededAt: fixtureNow,
      sourceContentHash: input.sourceHash,
      sourceRevision: 1,
      status: "READY",
      userId: input.userId
    }
  });
}

async function createClassifiedSafety(input: Readonly<{
  source?: Readonly<{ branchGeneration: number; chatId: string; messageId: string }>;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  userId: string;
}>) {
  const executionId = randomUUID();
  const completedAt = new Date(fixtureNow.getTime() - 1);
  const startedAt = new Date(fixtureNow.getTime() - 2);
  const jobId = input.sourceMode === "AUTOMATIC" ? randomUUID() : null;
  const settings = jobId
    ? await prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId: input.userId }
      })
    : null;
  await prisma.$transaction(async (tx) => {
    if (jobId && settings) {
      await tx.memoryJob.create({
        data: {
          acceptedResultHash: memorySha256({ executionId, result: "classified" }),
          activeLeafMessageId: input.source?.messageId,
          branchGeneration: input.source?.branchGeneration,
          chatId: input.source?.chatId,
          completedAt,
          createdAt: startedAt,
          id: jobId,
          idempotencyFingerprint: `memory-retrieval-classifier-${executionId}`,
          kind: "EXTRACT_FACTS",
          memoryGenerationSnapshot: settings.memoryGeneration,
          memoryRevisionSnapshot: settings.memoryRevision,
          pipelineVersion: "memory-retrieval-test-classifier-v1",
          sourceHash: input.source
            ? memorySha256({ chatId: input.source.chatId, messageId: input.source.messageId })
            : undefined,
          sourceRevision: input.source ? 1 : undefined,
          state: "SUCCEEDED",
          userId: input.userId
        }
      });
    }
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memorySha256({ executionId, output: "NORMAL" }),
        cachedInputTokens: 0,
        completedAt,
        createdAt: startedAt,
        destinationFingerprint: memorySha256({ destination: "fixture-classifier" }),
        id: executionId,
        inputHash: memorySha256({ executionId, input: "fixture" }),
        inputTokens: 0,
        logicalRole: input.sourceMode === "AUTOMATIC"
          ? "MEMORY_FACT_EXTRACT"
          : "MEMORY_STATEMENT_CLASSIFY",
        ...(jobId
          ? { memoryJobId: jobId, ownerType: "JOB" as const }
          : {
              mutationAuthorizationId: `memory-retrieval-classifier-${executionId}`,
              ownerType: "MUTATION_AUTHORIZATION" as const
            }),
        ordinal: 0,
        outputTokens: 0,
        pipelineVersion: "memory-retrieval-test-classifier-v1",
        policyVersion: "memory-retrieval-test-classifier-v1",
        promptVersion: "memory-retrieval-test-classifier-v1",
        providerId: "memory-retrieval-fixture",
        reasoningTokens: 0,
        recoverableUntil: completedAt,
        relationsDetachedAt: fixtureNow,
        schemaVersion: "memory-retrieval-test-classifier-v1",
        secretFreeExecutionSnapshot: {
          providerExecutionSnapshot: {
            providerFamily: "memory-retrieval-fixture",
            providerModelId: "memory-retrieval-fixture-model"
          },
          version: 1
        },
        startedAt,
        state: "SUCCEEDED",
        totalTokens: 0,
        usageCompleteness: "COMPLETE",
        userId: input.userId
      }
    });
    await tx.usageEvent.create({
      data: {
        cachedInputTokens: 0,
        inputTokens: 0,
        memoryExecutionBindingId: executionId,
        modelId: "memory-retrieval-fixture-model",
        outputTokens: 0,
        provider: "memory-retrieval-fixture",
        providerModelId: "memory-retrieval-fixture-model",
        reasoningTokens: 0,
        totalTokens: 0,
        userId: input.userId
      }
    });
  });
  return {
    safetyClassificationReasonCode: input.sourceMode === "AUTOMATIC"
      ? "automatic_extraction"
      : "response_preference",
    safetyClassificationState: "CLASSIFIED" as const,
    safetyClassifiedAt: completedAt,
    safetyClassifierExecutionId: executionId,
    safetyClassifierModelId: "memory-retrieval-fixture-model",
    safetyClassifierPolicyVersion: "memory-retrieval-test-classifier-v1",
    safetyClassifierProviderId: "memory-retrieval-fixture"
  };
}

async function createFact(input: Readonly<{
  canonicalKey: string;
  coreEligible?: boolean;
  displayText: string;
  generationId: string;
  languageCode: string;
  scopeAssistantId?: string;
  scopeChatId?: string;
  scopeFolderId?: string;
  sensitivityClass?: "NORMAL" | "SECRET" | "SENSITIVE";
  source?: Readonly<{ branchGeneration: number; chatId: string; messageId: string }>;
  sourceMode?: "AUTOMATIC" | "EXPLICIT";
  userId: string;
}>): Promise<string> {
  const sourceMode = input.sourceMode ?? "EXPLICIT";
  const event = await prisma.memoryEvent.create({
    data: {
      actorType: sourceMode === "EXPLICIT" ? "USER" : "JOB",
      actorUserId: sourceMode === "EXPLICIT" ? input.userId : null,
      operation: sourceMode === "EXPLICIT" ? "EXPLICIT_SAVE" : "PROMOTE",
      sourceChatId: input.source?.chatId ?? null,
      sourceGeneration: input.source?.branchGeneration ?? null,
      userId: input.userId
    }
  });
  const scope = input.scopeFolderId
    ? await prisma.memoryScope.create({
        data: {
          folderId: input.scopeFolderId,
          scopeType: "FOLDER",
          targetDisplaySnapshot: "Other folder",
          targetIdSnapshot: input.scopeFolderId,
          userId: input.userId
        }
      })
    : input.scopeAssistantId
      ? await prisma.memoryScope.create({
          data: {
            assistantId: input.scopeAssistantId,
            scopeType: "ASSISTANT",
            targetDisplaySnapshot: "Current assistant",
            targetIdSnapshot: input.scopeAssistantId,
            userId: input.userId
          }
        })
      : input.scopeChatId
        ? await prisma.memoryScope.create({
            data: {
              chatId: input.scopeChatId,
              scopeType: "CHAT",
              targetDisplaySnapshot: "Current chat",
              targetIdSnapshot: input.scopeChatId,
              userId: input.userId
            }
          })
        : (await prisma.memoryScope.findFirst({
            where: {
              scopeType: "GLOBAL_USER",
              state: "ACTIVE",
              userId: input.userId
            }
          })) ?? await prisma.memoryScope.create({
            data: { scopeType: "GLOBAL_USER", userId: input.userId }
          });
  const normalized = normalizeMemorySearchText(input.displayText);
  const factId = randomUUID();
  const versionId = randomUUID();
  const classifiedSafety = await createClassifiedSafety({
    source: input.source,
    sourceMode,
    userId: input.userId
  });
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({
      data: {
        canonicalKey: input.canonicalKey,
        category: "preferences",
        currentVersionId: versionId,
        id: factId,
        scopeId: scope.id,
        state: "ACTIVE",
        userId: input.userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "preferences",
        confidence: 1,
        coreEligible: input.coreEligible ?? false,
        createdByEventId: event.id,
        directness: "DIRECT",
        displayText: input.displayText,
        factId,
        id: versionId,
        importance: 0.9,
        languageCode: input.languageCode,
        modality: "PREFERENCE",
        normalizedSearchText: normalized,
        pipelineVersion: "memory-retrieval-test-v1",
        ...classifiedSafety,
        sensitivityClass: input.sensitivityClass ?? "NORMAL",
        sourceMode,
        state: "ACTIVE",
        structuredValue: { statement: input.displayText },
        userId: input.userId
      }
    });
    await tx.memoryEvidence.create({
      data: sourceMode === "EXPLICIT"
        ? {
            factVersionId: versionId,
            memoryEventId: event.id,
            observedAt: fixtureNow,
            safeExcerpt: input.displayText,
            safeSourceHash: memorySha256(input.displayText),
            safetyClass: input.sensitivityClass ?? "NORMAL",
            sourceProjectionVersion: "memory-retrieval-test-v1",
            sourceType: "EXPLICIT_ACTION",
            stance: "SUPPORTS",
            userId: input.userId
          }
        : {
            branchGeneration: input.source!.branchGeneration,
            chatId: input.source!.chatId,
            factVersionId: versionId,
            messageId: input.source!.messageId,
            observedAt: fixtureNow,
            safeExcerpt: input.displayText,
            safeSourceHash: memorySha256(input.displayText),
            safetyClass: input.sensitivityClass ?? "NORMAL",
            sourceProjectionVersion: "memory-retrieval-test-v1",
            sourceRole: "user",
            sourceType: "MESSAGE",
            stance: "SUPPORTS",
            userId: input.userId
          }
    });
    await tx.memorySearchEntry.create({
      data: {
        embeddingState: "NOT_APPLICABLE",
        factVersionId: versionId,
        indexGenerationId: input.generationId,
        itemType: "FACT_VERSION",
        languageCode: input.languageCode,
        safeContentHash: memorySha256({ displayText: input.displayText }),
        normalizedSearchText: normalized,
        safetyIdentitySnapshot: memorySha256({ sensitivity: input.sensitivityClass ?? "NORMAL" }),
        sourceIdentitySnapshot: memorySha256({ sourceMode, versionId }),
        suppressionIdentitySnapshot: memorySha256({
          canonicalKey: input.canonicalKey,
          normalizedValue: normalized
        }),
        userId: input.userId
      }
    });
  });
  return versionId;
}

async function createHistoricalFactVersion(input: Readonly<{
  currentVersionId: string;
  displayText: string;
  generationId: string;
  userId: string;
  validFrom: Date;
  validTo: Date;
}>): Promise<string> {
  const current = await prisma.memoryFactVersion.findUniqueOrThrow({
    select: { category: true, factId: true },
    where: { id: input.currentVersionId }
  });
  const event = await prisma.memoryEvent.create({
    data: {
      actorType: "USER",
      actorUserId: input.userId,
      factId: current.factId,
      operation: "EDIT",
      userId: input.userId
    }
  });
  const versionId = randomUUID();
  const normalizedSearchText = normalizeMemorySearchText(input.displayText);
  const classifiedSafety = await createClassifiedSafety({
    sourceMode: "EXPLICIT",
    userId: input.userId
  });
  await prisma.$transaction(async (tx) => {
    await tx.memoryFactVersion.create({
      data: {
        category: current.category,
        confidence: 1,
        createdAt: input.validFrom,
        createdByEventId: event.id,
        directness: "DIRECT",
        displayText: input.displayText,
        factId: current.factId,
        id: versionId,
        importance: 0.9,
        languageCode: "en",
        modality: "PREFERENCE",
        normalizedSearchText,
        pipelineVersion: "memory-retrieval-test-v1",
        ...classifiedSafety,
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        state: "SUPERSEDED",
        structuredValue: { statement: input.displayText },
        systemFrom: input.validFrom,
        systemTo: input.validTo,
        temporalResolverVersion: "memory-temporal-resolver-v1",
        userId: input.userId,
        validFrom: input.validFrom,
        validTo: input.validTo
      }
    });
    await tx.memoryEvidence.create({
      data: {
        factVersionId: versionId,
        memoryEventId: event.id,
        observedAt: input.validFrom,
        safeExcerpt: input.displayText,
        safeSourceHash: memorySha256(input.displayText),
        safetyClass: "NORMAL",
        sourceProjectionVersion: "memory-retrieval-test-v1",
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS",
        userId: input.userId
      }
    });
    await tx.memorySearchEntry.create({
      data: {
        embeddingState: "NOT_APPLICABLE",
        factVersionId: versionId,
        indexGenerationId: input.generationId,
        itemType: "FACT_VERSION",
        languageCode: "en",
        normalizedSearchText,
        safeContentHash: memorySha256({ displayText: input.displayText }),
        safetyIdentitySnapshot: memorySha256({ sensitivity: "NORMAL" }),
        sourceIdentitySnapshot: memorySha256({ sourceMode: "EXPLICIT", versionId }),
        suppressionIdentitySnapshot: memorySha256({
          normalizedValue: normalizedSearchText,
          state: "SUPERSEDED"
        }),
        userId: input.userId
      }
    });
  });
  return versionId;
}

async function createChunk(input: Readonly<{
  branchGeneration?: number;
  chatId: string;
  chunkOrdinal?: number;
  generationId: string;
  messageId: string;
  safetyClass?: "HIGHLY_SENSITIVE" | "NORMAL" | "SENSITIVE";
  safeText: string;
  state?: "ACTIVE" | "INVALIDATED";
  suppressionSnapshot: string;
  userId: string;
}>): Promise<string> {
  const contentHash = memorySha256({ chatId: input.chatId, safeText: input.safeText });
  const chunk = await prisma.memoryRecallChunk.create({
    data: {
      branchGeneration: input.branchGeneration ?? 0,
      chatId: input.chatId,
      chunkOrdinal: input.chunkOrdinal ?? 0,
      chunkingVersion: "memory-history-chunking-v2",
      contentHash,
      languageCode: "ru",
      normalizedSafeSearchText: normalizeMemorySearchText(input.safeText),
      occurredFrom: new Date("2026-07-15T09:00:00.000Z"),
      occurredTo: new Date("2026-07-15T09:05:00.000Z"),
      redactionState: "NOT_NEEDED",
      safeProjectedText: input.safeText,
      safetyClass: input.safetyClass ?? "NORMAL",
      sourceProjectionVersion: "memory-history-source-projection-v2",
      sourceRevisionAtCreation: 1,
      state: input.state ?? "ACTIVE",
      invalidatedAt: input.state === "INVALIDATED" ? fixtureNow : null,
      userId: input.userId
    }
  });
  await prisma.memoryRecallChunkMessage.create({
    data: {
      chatId: input.chatId,
      chunkId: chunk.id,
      messageId: input.messageId,
      ordinal: 0,
      role: "user",
      userId: input.userId
    }
  });
  await prisma.memorySearchEntry.create({
    data: {
      embeddingState: "NOT_APPLICABLE",
      indexGenerationId: input.generationId,
      itemType: "RECALL_CHUNK",
      languageCode: "ru",
      recallChunkId: chunk.id,
      safeContentHash: contentHash,
      normalizedSearchText: normalizeMemorySearchText(input.safeText),
      safetyIdentitySnapshot: memorySha256({ safety: input.safetyClass ?? "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({ branch: input.branchGeneration ?? 0, chunkId: chunk.id }),
      suppressionIdentitySnapshot: input.suppressionSnapshot,
      userId: input.userId
    }
  });
  return chunk.id;
}


function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function topFive(
  result: Awaited<ReturnType<ReturnType<typeof createPrismaLocalMemoryRetrievalRepository>["retrieve"]>>,
  query: string
): readonly MemoryRankedCandidate[] {
  return fuseMemoryRetrievalCandidates(
    planMemoryRetrieval({ currentUserText: query, now: fixtureNow }),
    result.laneResults,
    fixtureNow
  ).slice(0, 5);
}

describe("local Memory retrieval on PostgreSQL", () => {
  beforeAll(async () => {
    const userId = await createOwner("memory-local-owner");
    const foreignUserId = await createOwner("memory-local-foreign");
    const generationId = await activateLexicalGeneration(userId);
    const foreignGenerationId = await activateLexicalGeneration(foreignUserId);
    const currentFolder = await prisma.folder.create({
      data: { name: "Current folder", userId }
    });
    const assistant = await prisma.assistantDefinition.create({
      data: { ownerUserId: userId }
    });
    const current = await createChatWithLeaf({
      folderId: currentFolder.id,
      sourceRevision: 0,
      title: "Current retrieval chat",
      userId,
      userText: "current request"
    });
    const rawSourceText = "RAW_MESSAGE_CONTENT_MUST_NEVER_BE_EXPANDED";
    const source = await createChatWithLeaf({
      title: "Миграция PostgreSQL",
      userId,
      userText: rawSourceText
    });
    const sourceHash = memorySha256({ source: "retrieval-source" });
    await createCheckpoint({
      chatId: source.chatId,
      messageId: source.messageId,
      sourceHash,
      userId
    });
    const suppressionSnapshot = memorySha256({ barriers: [], suppressions: [] });
    const safeChunkText = "Мы обсуждали безопасный план миграции PostgreSQL для MacBook без исходного сообщения.";
    const validChunkId = await createChunk({
      chatId: source.chatId,
      generationId,
      messageId: source.messageId,
      safeText: safeChunkText,
      suppressionSnapshot,
      userId
    });
    const sensitiveChunkId = await createChunk({
      chatId: source.chatId,
      chunkOrdinal: 3,
      generationId,
      messageId: source.messageId,
      safeText: "Legacy sensitive context о миграции PostgreSQL.",
      safetyClass: "SENSITIVE",
      suppressionSnapshot,
      userId
    });
    const staleChunkId = await createChunk({
      chatId: source.chatId,
      chunkOrdinal: 1,
      generationId,
      messageId: source.messageId,
      safeText: "Устаревшая ветка миграции PostgreSQL.",
      state: "INVALIDATED",
      suppressionSnapshot,
      userId
    });
    const excluded = await createChatWithLeaf({
      memoryMode: "EXCLUDED",
      title: "Excluded source",
      userId,
      userText: "excluded source"
    });
    const excludedChunkId = await createChunk({
      chatId: excluded.chatId,
      generationId,
      messageId: excluded.messageId,
      safeText: "Excluded PostgreSQL migration source.",
      state: "INVALIDATED",
      suppressionSnapshot,
      userId
    });
    const secretChunkId = await createChunk({
      chatId: source.chatId,
      chunkOrdinal: 2,
      generationId,
      messageId: source.messageId,
      safeText: "Secret-tainted PostgreSQL migration source.",
      safetyClass: "HIGHLY_SENSITIVE",
      suppressionSnapshot,
      userId
    });
    const otherFolder = await prisma.folder.create({
      data: { name: "Other folder", userId }
    });
    const enFactVersionId = await createFact({
      canonicalKey: "profile.preferred_editor",
      coreEligible: true,
      displayText: "My preferred editor is Neovim.",
      generationId,
      languageCode: "en",
      userId
    });
    const historicalFactVersionId = await createHistoricalFactVersion({
      currentVersionId: enFactVersionId,
      displayText: "My preferred editor was Vim in July 2025.",
      generationId,
      userId,
      validFrom: new Date("2025-07-01T00:00:00.000Z"),
      validTo: new Date("2025-08-01T00:00:00.000Z")
    });
    const ruFactVersionId = await createFact({
      canonicalKey: "preference.editor_ru",
      displayText: "Мой предпочтительный редактор — Helix.",
      generationId,
      languageCode: "ru",
      userId
    });
    const otherFolderFactVersionId = await createFact({
      canonicalKey: "workflow.editor",
      displayText: "My preferred editor is forbidden-folder Vim.",
      generationId,
      languageCode: "en",
      scopeFolderId: otherFolder.id,
      userId
    });
    const legacyFolderFactVersionId = await createFact({
      canonicalKey: "legacy.folder_editor",
      coreEligible: true,
      displayText: "My preferred legacy scoped editor is folder Vim.",
      generationId,
      languageCode: "en",
      scopeFolderId: currentFolder.id,
      userId
    });
    const legacyAssistantFactVersionId = await createFact({
      canonicalKey: "legacy.assistant_editor",
      coreEligible: true,
      displayText: "My preferred legacy scoped editor is assistant Emacs.",
      generationId,
      languageCode: "en",
      scopeAssistantId: assistant.id,
      userId
    });
    const legacyChatFactVersionId = await createFact({
      canonicalKey: "legacy.chat_editor",
      coreEligible: true,
      displayText: "My preferred legacy scoped editor is chat Nano.",
      generationId,
      languageCode: "en",
      scopeChatId: current.chatId,
      userId
    });
    const sensitiveFactVersionId = await createFact({
      canonicalKey: "profile.sensitive_editor",
      coreEligible: true,
      displayText: "My preferred editor reveals a sensitive private detail.",
      generationId,
      languageCode: "en",
      sensitivityClass: "SENSITIVE",
      userId
    });
    const automaticSensitiveFactVersionId = await createFact({
      canonicalKey: "profile.automatic_sensitive_editor",
      displayText: "My learned preferred editor has a sensitive private detail.",
      generationId,
      languageCode: "en",
      sensitivityClass: "SENSITIVE",
      source: { branchGeneration: 0, chatId: source.chatId, messageId: source.messageId },
      sourceMode: "AUTOMATIC",
      userId
    });
    const staleAutomaticFactVersionId = await createFact({
      canonicalKey: "profile.stale_editor",
      displayText: "My preferred editor is stale-branch Emacs.",
      generationId,
      languageCode: "en",
      source: { branchGeneration: 1, chatId: source.chatId, messageId: source.messageId },
      sourceMode: "AUTOMATIC",
      userId
    });
    const foreignFactVersionId = await createFact({
      canonicalKey: "profile.preferred_editor",
      displayText: "My preferred editor is foreign-tenant VS Code.",
      generationId: foreignGenerationId,
      languageCode: "en",
      userId: foreignUserId
    });
    fixture = {
      assistantId: assistant.id,
      automaticSensitiveFactVersionId,
      currentChatId: current.chatId,
      enFactVersionId,
      excludedChunkId,
      foreignFactVersionId,
      generationId,
      historicalFactVersionId,
      legacyAssistantFactVersionId,
      legacyChatFactVersionId,
      legacyFolderFactVersionId,
      otherFolderFactVersionId,
      rawSourceText,
      ruFactVersionId,
      safeChunkText,
      secretChunkId,
      sensitiveChunkId,
      sensitiveFactVersionId,
      sourceChatId: source.chatId,
      staleAutomaticFactVersionId,
      staleChunkId,
      userId,
      validChunkId
    };
  });

  afterAll(async () => {
    for (const userId of ownerIds.reverse()) {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      const assistantScopes = await prisma.memoryScope.findMany({
        select: { id: true },
        where: { assistantId: { not: null }, userId }
      });
      await prisma.$transaction(async (tx) => {
        await tx.memoryFact.deleteMany({
          where: { scopeId: { in: assistantScopes.map(({ id }) => id) }, userId }
        });
        await tx.memoryScope.deleteMany({
          where: { id: { in: assistantScopes.map(({ id }) => id) }, userId }
        });
        await tx.assistantDefinition.deleteMany({ where: { ownerUserId: userId } });
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  it("keeps Unicode lexical candidates bounded and excludes tenant/scope/source/safety violations", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const enQuery = "preferred editor";
    const enResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: planMemoryRetrieval({ currentUserText: enQuery, now: fixtureNow }),
      userId: fixture.userId
    });
    const enTop = topFive(enResult, enQuery);
    expect(enTop.map((item) => item.itemId)).toContain(fixture.enFactVersionId);
    const allEnIds = enResult.laneResults.flatMap((lane) => lane.candidates.map((item) => item.itemId));
    expect(allEnIds).not.toContain(fixture.foreignFactVersionId);
    expect(allEnIds).not.toContain(fixture.otherFolderFactVersionId);
    // Legacy SENSITIVE facts use the same candidate policy as NORMAL facts,
    // regardless of whether they were saved explicitly or learned.
    expect(allEnIds).toContain(fixture.sensitiveFactVersionId);
    expect(allEnIds).toContain(fixture.automaticSensitiveFactVersionId);
    expect(allEnIds).not.toContain(fixture.staleAutomaticFactVersionId);

    const ruQuery = "предпочтительный редактор";
    const ruResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: planMemoryRetrieval({ currentUserText: ruQuery, now: fixtureNow }),
      userId: fixture.userId
    });
    expect(topFive(ruResult, ruQuery).map((item) => item.itemId)).toContain(
      fixture.ruFactVersionId
    );
  });

  it("keeps matching legacy folder, assistant, and chat facts dormant", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const result = await repository.retrieve({
      assistantId: fixture.assistantId,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: planMemoryRetrieval({
        applyResponsePreferences: true,
        currentUserText: "preferred legacy scoped editor",
        now: fixtureNow
      }),
      userId: fixture.userId
    });
    const legacyIds = [
      fixture.legacyFolderFactVersionId,
      fixture.legacyAssistantFactVersionId,
      fixture.legacyChatFactVersionId
    ];
    const candidateIds = result.laneResults.flatMap((lane) =>
      lane.candidates.map((candidate) => candidate.itemId));
    const coreIds = result.core.map(({ candidate }) => candidate.itemId);

    expect(coreIds).toContain(fixture.enFactVersionId);
    expect(coreIds).toContain(fixture.sensitiveFactVersionId);
    expect(candidateIds.filter((id) => legacyIds.includes(id))).toEqual([]);
    expect(coreIds.filter((id) => legacyIds.includes(id))).toEqual([]);
  });

  it("never serves a superseded historical version as current truth", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const query = "preferred editor";
    const plan = planMemoryRetrieval({ currentUserText: query, now: fixtureNow });
    await expect(prisma.memorySearchEntry.count({
      where: {
        factVersionId: fixture.historicalFactVersionId,
        indexGenerationId: fixture.generationId,
        userId: fixture.userId
      }
    })).resolves.toBe(1);
    await expect(prisma.memoryFactVersion.findUniqueOrThrow({
      select: { safetyClassificationState: true, state: true },
      where: { id: fixture.historicalFactVersionId }
    })).resolves.toEqual({
      safetyClassificationState: "CLASSIFIED",
      state: "SUPERSEDED"
    });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });
    const ranked = fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow);
    expect(ranked.map((item) => item.itemId)).not.toContain(
      fixture.historicalFactVersionId
    );
    expect(ranked.map((item) => item.itemId)).toContain(fixture.enFactVersionId);
    const expanded = await repository.expand(result.snapshot, plan, ranked);
    const pack = packMemoryPersonalContext({ expanded, plan, ranked });
    expect(pack.text).not.toContain("Vim in July 2025");
    expect(pack.text).toContain("Neovim");
  });

  it("retrieves only safe chunks", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const query = "миграции PostgreSQL";
    const plan = planMemoryRetrieval({ currentUserText: query, now: fixtureNow });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });
    const candidateIds = result.laneResults.flatMap((lane) =>
      lane.candidates.map((candidate) => candidate.itemId));
    expect(candidateIds).toContain(fixture.validChunkId);
    expect(candidateIds).toContain(fixture.sensitiveChunkId);
    expect(candidateIds).not.toContain(fixture.staleChunkId);
    expect(candidateIds).not.toContain(fixture.excludedChunkId);
    expect(candidateIds).not.toContain(fixture.secretChunkId);

    const ranked = fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow);
    const expanded = await repository.expand(result.snapshot, plan, ranked);
    expect(expanded).toContainEqual(expect.objectContaining({
      itemId: fixture.validChunkId,
      projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
      safeText: fixture.safeChunkText,
      sourceChatId: fixture.sourceChatId
    }));
    expect(expanded.map((item) => item.safeText).join("\n")).not.toContain(fixture.rawSourceText);
    const pack = packMemoryPersonalContext({ expanded, plan, ranked });
    expect(pack.approxTokens).toBeLessThanOrEqual(MEMORY_CONTEXT_HARD_CAP_TOKENS);
    expect(pack.text).not.toContain(fixture.rawSourceText);
    expect(pack.items.length).toBeLessThanOrEqual(12);
  });

  it("does not add an unconditional recency lane for alias or unrelated queries", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const aliasQuery = "Что мы решили по Макбуку в предыдущем чате?";
    const aliasPlan = planMemoryRetrieval({ currentUserText: aliasQuery, now: fixtureNow });
    const aliasResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: aliasPlan,
      userId: fixture.userId
    });
    expect(fuseMemoryRetrievalCandidates(aliasPlan, aliasResult.laneResults, fixtureNow))
      .toEqual([]);

    const irrelevantQuery = "Что мы решили по квантовым бананам в предыдущем чате?";
    const irrelevantPlan = planMemoryRetrieval({
      currentUserText: irrelevantQuery,
      now: fixtureNow
    });
    const irrelevantResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: irrelevantPlan,
      userId: fixture.userId
    });
    const irrelevantCandidates = fuseMemoryRetrievalCandidates(
      irrelevantPlan,
      irrelevantResult.laneResults,
      fixtureNow
    );
    expect(irrelevantCandidates).toEqual([]);
    expect(irrelevantResult.laneResults.filter((lane) =>
      lane.lane === "HISTORY_RECALL_EXACT" || lane.lane === "HISTORY_RECALL_FTS_SIMPLE")
      .flatMap((lane) => lane.candidates)).toEqual([]);
  });

  it("does not generate candidates for an irrelevant non-empty query", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const plan = planMemoryRetrieval({ currentUserText: "What is photosynthesis?", now: fixtureNow });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });
    expect(result.laneResults.length).toBeGreaterThan(0);
    expect(fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow)).toEqual([]);
  });

  it("emits reproducible sanitized candidate coverage, isolation, bounds, and latency evidence", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const cases = [
      { expected: fixture.enFactVersionId, query: "preferred editor" },
      { expected: fixture.ruFactVersionId, query: "предпочтительный редактор" },
      { expected: fixture.validChunkId, query: "миграции PostgreSQL" }
    ];
    const latencies: number[] = [];
    let crossTenantHits = 0;
    let recalled = 0;
    let maximumCandidateCount = 0;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      for (const testCase of cases) {
        const plan = planMemoryRetrieval({ currentUserText: testCase.query, now: fixtureNow });
        const started = performance.now();
        const result = await repository.retrieve({
          assistantId: null,
          chatId: fixture.currentChatId,
          now: fixtureNow,
          plan,
          userId: fixture.userId
        });
        maximumCandidateCount = Math.max(
          maximumCandidateCount,
          result.laneResults.reduce((total, lane) => total + lane.candidates.length, 0)
        );
        crossTenantHits += result.laneResults.flatMap((lane) => lane.candidates)
          .filter((candidate) => candidate.itemId === fixture.foreignFactVersionId).length;
        latencies.push(performance.now() - started);
        if (fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow)
          .slice(0, 5).some((item) => item.itemId === testCase.expected)) recalled += 1;
      }
    }
    const recencyQueries = [
      "What is photosynthesis?",
      "Что мы решили по квантовым бананам в предыдущем чате?"
    ];
    let unrelatedCandidateQueries = 0;
    for (const query of recencyQueries) {
      const plan = planMemoryRetrieval({ currentUserText: query, now: fixtureNow });
      const result = await repository.retrieve({
        assistantId: null,
        chatId: fixture.currentChatId,
        now: fixtureNow,
        plan,
        userId: fixture.userId
      });
      if (fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow).length > 0) {
        unrelatedCandidateQueries += 1;
      }
    }
    const sampleCount = cases.length * 5;
    const evidence = Object.freeze({
      candidateHardCap: 150,
      crossTenantHits,
      evidenceVersion: "memory-language-agnostic-local-candidates-v3",
      latencyP95Ms: Number(percentile95(latencies).toFixed(2)),
      maximumLatencyP95Ms: 150,
      maximumCandidateCount,
      recallAt5: recalled / sampleCount,
      unrelatedCandidateRate: unrelatedCandidateQueries / recencyQueries.length,
      sanitizedAggregatesOnly: true,
      sampleCount
    });
    expect(evidence).toMatchObject({
      candidateHardCap: 150,
      crossTenantHits: 0,
      maximumCandidateCount: expect.any(Number),
      recallAt5: 1,
      unrelatedCandidateRate: 0,
      sanitizedAggregatesOnly: true,
      sampleCount: 15
    });
    expect(evidence.latencyP95Ms).toBeLessThan(evidence.maximumLatencyP95Ms);
    expect(evidence.maximumCandidateCount).toBeLessThanOrEqual(evidence.candidateHardCap);
    expect(JSON.stringify(evidence)).not.toContain(fixture.userId);
    expect(JSON.stringify(evidence)).not.toContain(fixture.safeChunkText);
    console.info("memory_local_retrieval_qualification", evidence);
  });

  it("applies a durable ALL suppression before ranking", async () => {
    const suppression = await prisma.memorySuppression.create({
      data: {
        deletionGeneration: 1,
        fingerprintKeyVersion: "memory-test-v1",
        normalizationVersion: "memory-search-normalization-v1",
        scope: "ALL",
        userId: fixture.userId
      }
    });
    try {
      const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
      const query = "preferred editor";
      const result = await repository.retrieve({
        assistantId: null,
        chatId: fixture.currentChatId,
        now: fixtureNow,
        plan: planMemoryRetrieval({ currentUserText: query, now: fixtureNow }),
        userId: fixture.userId
      });
      expect(result.laneResults.flatMap((lane) => lane.candidates)).toEqual([]);
    } finally {
      await prisma.memorySuppression.delete({ where: { id: suppression.id } });
    }
  });
});
