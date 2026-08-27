import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import {
  fuseMemoryRetrievalCandidates,
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryRankedCandidate
} from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../history/contract";
import { MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION } from "../history/digest";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from
  "../history/sourceProjection";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import { createPrismaLocalMemoryRetrievalRepository } from "./localRepository";

const fixtureNow = new Date("2026-08-10T12:00:00.000Z");
const suffix = randomUUID();
const ownerIds: string[] = [];

type RetrievalFixture = Readonly<{
  assistantId: string;
  automaticSensitiveFactVersionId: string;
  currentChatId: string;
  directUnindexedFactVersionId: string;
  enFactVersionId: string;
  entityFactVersionId: string;
  excludedChunkId: string;
  expiredFactVersionId: string;
  foreignFactVersionId: string;
  generationId: string;
  historicalFactVersionId: string;
  invalidDependencyEntityFactVersionId: string;
  legacyAssistantFactVersionId: string;
  legacyChatFactVersionId: string;
  legacyFolderFactVersionId: string;
  macbookHistoricalFactVersionId: string;
  mergedMacbookFactVersionId: string;
  movedHistoricalMacbookFactVersionId: string;
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

function queryPlanIndexNames(value: unknown): readonly string[] {
  const names = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (key === "Index Name" && typeof nested === "string") names.add(nested);
      visit(nested);
    }
  };
  visit(value);
  return [...names].sort();
}

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
      chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
      generation: 0,
      indexMode: "LEXICAL_ONLY",
      indexedThroughMemoryRevision: 0,
      languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
      normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
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
  createdAt?: Date;
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
      createdAt: input.createdAt ?? new Date("2026-07-15T09:00:00.000Z"),
      role: "user",
      status: "complete",
      updatedAt: input.createdAt ?? new Date("2026-07-15T09:00:00.000Z")
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
  const message = await prisma.message.findUniqueOrThrow({
    select: { createdAt: true, updatedAt: true },
    where: { id: input.messageId }
  });
  await prisma.$transaction(async (tx) => {
    await tx.chatMemoryCheckpoint.create({
      data: {
        activeLeafMessageId: input.messageId,
        branchGeneration: 0,
        chatId: input.chatId,
        lastIndexedMessageId: input.messageId,
        lastSucceededAt: fixtureNow,
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
        sourceContentHash: input.sourceHash,
        sourceRevision: 1,
        status: "READY",
        userId: input.userId
      }
    });
    await tx.chatMemoryCheckpointMessage.create({
      data: {
        chatId: input.chatId,
        messageId: input.messageId,
        ordinal: 0,
        sourceMessageCreatedAt: message.createdAt,
        sourceMessageUpdatedAt: message.updatedAt,
        userId: input.userId
      }
    });
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
  category?: string;
  canonicalKey: string;
  coreEligible?: boolean;
  displayText: string;
  expiresAt?: Date;
  generationId: string;
  holdUntilExpired?: boolean;
  indexed?: boolean;
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
  const structuredValue = { statement: input.displayText };
  const factId = randomUUID();
  const versionId = randomUUID();
  const sourceText = input.source
    ? textFromContentBlocks((await prisma.message.findUniqueOrThrow({
        select: { content: true },
        where: { id: input.source.messageId }
      })).content as { blocks?: unknown[] })
    : null;
  const sourceHash = sourceText === null ? null : memorySha256(sourceText);
  const classifiedSafety = await createClassifiedSafety({
    source: input.source,
    sourceMode,
    userId: input.userId
  });
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({
      data: {
        canonicalKey: input.canonicalKey,
        category: input.category ?? "preferences",
        currentVersionId: versionId,
        id: factId,
        scopeId: scope.id,
        state: "ACTIVE",
        userId: input.userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: input.category ?? "preferences",
        confidence: 1,
        coreEligible: input.coreEligible ?? false,
        createdByEventId: event.id,
        directness: "DIRECT",
        displayText: input.displayText,
        expiresAt: input.expiresAt,
        factId,
        id: versionId,
        importance: 0.9,
        ingestionFingerprint: sourceMode === "AUTOMATIC"
          ? memorySha256({ domain: "memory-retrieval-test", sourceHash, versionId })
          : null,
        languageCode: input.languageCode,
        modality: "PREFERENCE",
        normalizedSearchText: normalized,
        observedAt: sourceMode === "AUTOMATIC" ? fixtureNow : null,
        pipelineVersion: sourceMode === "AUTOMATIC"
          ? MEMORY_FACT_EXTRACTION_PIPELINE_VERSION
          : "memory-retrieval-test-v1",
        ...classifiedSafety,
        sensitivityClass: input.sensitivityClass ?? "NORMAL",
        sourceMode,
        state: "ACTIVE",
        structuredValue,
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
            evidenceFingerprint: memorySha256({
              endOffset: sourceText!.length,
              messageId: input.source!.messageId,
              sourceHash,
              startOffset: 0,
              version: 1
            }),
            factVersionId: versionId,
            messageId: input.source!.messageId,
            observedAt: fixtureNow,
            safeExcerpt: sourceText!,
            safeSourceHash: sourceHash!,
            safetyClass: input.sensitivityClass ?? "NORMAL",
            sourceEndOffset: sourceText!.length,
            sourceMessageContentHash: sourceHash!,
            sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
            sourceRole: "user",
            sourceStartOffset: 0,
            sourceType: "MESSAGE",
            stance: "SUPPORTS",
            userId: input.userId
          }
    });
    if (input.indexed !== false) {
      await tx.memorySearchEntry.create({
        data: {
          embeddingState: "NOT_APPLICABLE",
          factVersionId: versionId,
          indexGenerationId: input.generationId,
          itemType: "FACT_VERSION",
          languageCode: input.languageCode,
          safeContentHash: memorySha256({ displayText: input.displayText, structuredValue }),
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
    }
    if (input.holdUntilExpired && input.expiresAt) {
      const remaining = input.expiresAt.getTime() - Date.now();
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining + 50));
      }
    }
  });
  return versionId;
}

async function createEntityLink(input: Readonly<{
  alias: string;
  displayName: string;
  factVersionId: string;
  userId: string;
}>): Promise<string> {
  const evidence = await prisma.memoryEvidence.findFirstOrThrow({
    select: { id: true },
    where: { factVersionId: input.factVersionId, userId: input.userId }
  });
  const version = await prisma.memoryFactVersion.findUniqueOrThrow({
    select: { sourceMode: true },
    where: { id: input.factVersionId }
  });
  const entityId = randomUUID();
  const aliasId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryEntity.create({
      data: {
        canonicalKey: `entity:v2:device:${memorySha256({
          displayName: input.displayName,
          entityId
        }).slice(0, 48)}`,
        displayName: input.displayName,
        entityType: "DEVICE",
        id: entityId,
        languageCode: "und",
        userId: input.userId
      }
    });
    await tx.memoryEntityAlias.create({
      data: {
        confidence: 1,
        displayAlias: input.alias,
        entityId,
        id: aliasId,
        languageCode: "und",
        normalizedAlias: normalizeMemorySearchText(input.alias),
        sourceKind: "AUTOMATIC_EVIDENCE",
        userId: input.userId
      }
    });
    await tx.memoryEntityAliasSupport.create({
      data: version.sourceMode === "EXPLICIT"
        ? {
            aliasId,
            factVersionId: input.factVersionId,
            id: randomUUID(),
            supportFingerprint: memorySha256({
              aliasId,
              factVersionId: input.factVersionId
            }),
            supportKind: "FACT_VERSION",
            userId: input.userId
          }
        : {
            aliasId,
            evidenceId: evidence.id,
            id: randomUUID(),
            supportFingerprint: memorySha256({ aliasId, evidenceId: evidence.id }),
            supportKind: "EVIDENCE",
            userId: input.userId
          }
    });
    await tx.memoryFactVersionEntity.create({
      data: {
        confidence: 1,
        entityId,
        factVersionId: input.factVersionId,
        role: "SUBJECT",
        userId: input.userId
      }
    });
  });
  return entityId;
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
  const structuredValue = { statement: input.displayText };
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
        structuredValue,
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
        safeContentHash: memorySha256({ displayText: input.displayText, structuredValue }),
        safetyIdentitySnapshot: memorySha256({ sensitivity: "NORMAL" }),
        sourceIdentitySnapshot: memorySha256({ sourceMode: "EXPLICIT", versionId }),
        suppressionIdentitySnapshot: memorySha256({
          normalizedValue: normalizedSearchText,
          state: "SUPERSEDED"
        }),
        userId: input.userId
      }
    });
    await tx.memoryFactVersion.update({
      data: { supersedesVersionId: versionId },
      where: { id: input.currentVersionId }
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
  occurredAt?: Date;
  safetyClass?: "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
  safeText: string;
  sourceRevisionAtCreation?: number;
  state?: "ACTIVE" | "INVALIDATED";
  suppressionSnapshot: string;
  userId: string;
}>): Promise<string> {
  const message = await prisma.message.findUniqueOrThrow({
    select: { content: true, updatedAt: true },
    where: { id: input.messageId }
  });
  const sourceText = textFromContentBlocks(message.content as { blocks?: unknown[] });
  const contentHash = memorySha256({ chatId: input.chatId, safeText: input.safeText });
  const secretTainted = input.safetyClass === "SECRET_TAINTED";
  const state = input.state ?? (secretTainted ? "SUPPRESSED" : "ACTIVE");
  const occurredAt = input.occurredAt ?? new Date("2026-07-15T09:00:00.000Z");
  const chunkId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryRecallChunk.create({
      data: {
        branchGeneration: input.branchGeneration ?? 0,
        chatId: input.chatId,
        chunkOrdinal: input.chunkOrdinal ?? 0,
        chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
        contentHash,
        id: chunkId,
        languageCode: "ru",
        normalizedSafeSearchText: normalizeMemorySearchText(input.safeText),
        occurredFrom: occurredAt,
        occurredTo: new Date(occurredAt.getTime() + 5 * 60_000),
        redactionReasonCodes: secretTainted ? ["secret_tainted"] : [],
        redactionState: secretTainted ? "EXCLUDED" : "NOT_NEEDED",
        safeProjectedText: input.safeText,
        safetyClass: input.safetyClass ?? "NORMAL",
        sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
        sourceRevisionAtCreation: input.sourceRevisionAtCreation ?? 0,
        state,
        invalidatedAt: state === "INVALIDATED" ? fixtureNow : null,
        userId: input.userId
      }
    });
    await tx.memoryRecallChunkMessage.create({
      data: {
        chatId: input.chatId,
        chunkId,
        messageId: input.messageId,
        ordinal: 0,
        role: "user",
        safeTextHash: memorySha256(input.safeText),
        sourceMessageContentHash: memorySha256(sourceText),
        sourceMessageUpdatedAt: message.updatedAt,
        userId: input.userId
      }
    });
  });
  await prisma.memorySearchEntry.create({
    data: {
      embeddingState: "NOT_APPLICABLE",
      indexGenerationId: input.generationId,
      itemType: "RECALL_CHUNK",
      languageCode: "ru",
      recallChunkId: chunkId,
      safeContentHash: contentHash,
      normalizedSearchText: normalizeMemorySearchText(input.safeText),
      safetyIdentitySnapshot: memorySha256({ safety: input.safetyClass ?? "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({
        branch: input.branchGeneration ?? 0,
        chunkId
      }),
      suppressionIdentitySnapshot: input.suppressionSnapshot,
      userId: input.userId
    }
  });
  return chunkId;
}

async function createDigestHistoryChat(input: Readonly<{
  digestText: string;
  generationId: string;
  occurredAt: Date;
  safeChunkText: string;
  title: string;
  userId: string;
}>): Promise<Readonly<{
  chatId: string;
  chunkId: string;
  digestId: string;
  digestText: string;
  safeChunkText: string;
}>> {
  const source = await createChatWithLeaf({
    createdAt: input.occurredAt,
    title: input.title,
    userId: input.userId,
    userText: `${input.title} source message`
  });
  const sourceHash = memorySha256({
    chatId: source.chatId,
    messageId: source.messageId,
    version: 1
  });
  await createCheckpoint({
    chatId: source.chatId,
    messageId: source.messageId,
    sourceHash,
    userId: input.userId
  });
  const chunkId = await createChunk({
    chatId: source.chatId,
    generationId: input.generationId,
    messageId: source.messageId,
    occurredAt: input.occurredAt,
    safeText: input.safeChunkText,
    sourceRevisionAtCreation: 1,
    suppressionSnapshot: memorySha256({ barriers: [], suppressions: [] }),
    userId: input.userId
  });
  const message = await prisma.message.findUniqueOrThrow({
    select: { content: true, updatedAt: true },
    where: { id: source.messageId }
  });
  const digestId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.chatMemoryDigest.create({
      data: {
        activeLeafMessageId: source.messageId,
        anchorChunkId: chunkId,
        branchGeneration: 0,
        chatId: source.chatId,
        contentHash: memorySha256({ digestText: input.digestText, version: 1 }),
        decisions: [`Decision from ${input.title}`],
        id: digestId,
        languageCode: "en",
        normalizedSafeSearchText: normalizeMemorySearchText(input.digestText),
        occurredFrom: input.occurredAt,
        occurredTo: new Date(input.occurredAt.getTime() + 5 * 60_000),
        openLoops: [`Open loop from ${input.title}`],
        incrementalDepth: 0,
        inputFingerprint: memorySha256({
          digestId,
          mode: "FULL_REBUILD"
        }),
        pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
        rebuildPolicyVersion: MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION,
        redactionState: "NOT_NEEDED",
        safeDigestText: input.digestText,
        safetyClass: "NORMAL",
        safetyPolicyVersion: "memory-chat-digest-policy-test",
        sourceContentHash: sourceHash,
        sourceFingerprint: memorySha256({ chunkId }),
        sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
        sourceRevisionAtCreation: 1,
        state: "ACTIVE",
        summary: input.digestText,
        topics: ["Deployment"],
        updateMode: "FULL_REBUILD",
        userId: input.userId
      }
    });
    await tx.chatMemoryDigestChunk.create({
      data: {
        chatId: source.chatId,
        chunkId,
        digestId,
        ordinal: 0,
        userId: input.userId
      }
    });
    await tx.chatMemoryDigestMessage.create({
      data: {
        chatId: source.chatId,
        digestId,
        messageId: source.messageId,
        ordinal: 0,
        sourceMessageContentHash: memorySha256(
          textFromContentBlocks(message.content as { blocks?: unknown[] })
        ),
        sourceMessageUpdatedAt: message.updatedAt,
        userId: input.userId
      }
    });
  });
  return {
    chatId: source.chatId,
    chunkId,
    digestId,
    digestText: input.digestText,
    safeChunkText: input.safeChunkText
  };
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
      safetyClass: "SECRET_TAINTED",
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
    const directUnindexedFactVersionId = await createFact({
      canonicalKey: "profile.direct_unindexed_sentinel",
      displayText: "Unindexed exact sentinel",
      generationId,
      indexed: false,
      languageCode: "en",
      userId
    });
    const expiredFactVersionId = await createFact({
      canonicalKey: "profile.expired_editor",
      coreEligible: true,
      displayText: "The user reserved an expired MacBook.",
      expiresAt: new Date(Date.now() + 300),
      generationId,
      holdUntilExpired: true,
      languageCode: "en",
      userId
    });
    await createEntityLink({
      alias: "expiredbook",
      displayName: "ExpiredBook",
      factVersionId: expiredFactVersionId,
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
    const entityFactVersionId = await createFact({
      canonicalKey: "device.order_confirmation",
      category: "other",
      displayText: "The user owns a MacBook Air.",
      generationId,
      languageCode: "en",
      userId
    });
    await createEntityLink({
      alias: "макбук",
      displayName: "MacBook Air",
      factVersionId: entityFactVersionId,
      userId
    });
    const macbookHistoricalFactVersionId = await createHistoricalFactVersion({
      currentVersionId: entityFactVersionId,
      displayText: "The user ordered a MacBook Air in July 2025.",
      generationId,
      userId,
      validFrom: new Date("2025-07-01T00:00:00.000Z"),
      validTo: new Date("2025-08-01T00:00:00.000Z")
    });
    const mergedMacbookFactVersionId = await createFact({
      canonicalKey: "device.duplicate_macbook",
      category: "other",
      displayText: "The user owns a duplicate MacBook representation.",
      generationId,
      languageCode: "en",
      userId
    });
    const movedHistoricalMacbookFactVersionId = await createHistoricalFactVersion({
      currentVersionId: mergedMacbookFactVersionId,
      displayText: "The user ordered a MacBook Air in July 2025.",
      generationId,
      userId,
      validFrom: new Date("2025-07-01T00:00:00.000Z"),
      validTo: new Date("2025-08-01T00:00:00.000Z")
    });
    const mergedVersion = await prisma.memoryFactVersion.findUniqueOrThrow({
      select: { factId: true, systemFrom: true },
      where: { id: mergedMacbookFactVersionId }
    });
    const targetFactId = (await prisma.memoryFactVersion.findUniqueOrThrow({
      select: { factId: true },
      where: { id: entityFactVersionId }
    })).factId;
    await prisma.$transaction(async (tx) => {
      await tx.memoryFactVersion.update({
        data: {
          mergedIntoVersionId: entityFactVersionId,
          state: "MERGED",
          systemTo: new Date(mergedVersion.systemFrom.getTime() + 1)
        },
        where: { id: mergedMacbookFactVersionId }
      });
      await tx.memoryFact.update({
        data: {
          currentVersionId: null,
          movedToFactId: targetFactId,
          state: "RETRACTED"
        },
        where: { id: mergedVersion.factId }
      });
    });
    const dependencySource = await createChatWithLeaf({
      title: "Dependency source",
      userId,
      userText: "I am considering a GhostBook."
    });
    const invalidDependencyEntityFactVersionId = await createFact({
      canonicalKey: "device.dependency_invalid",
      category: "other",
      displayText: "The dependent device order is confirmed.",
      generationId,
      languageCode: "en",
      userId
    });
    await createEntityLink({
      alias: "ghostbook",
      displayName: "GhostBook",
      factVersionId: invalidDependencyEntityFactVersionId,
      userId
    });
    await prisma.memoryFactVersionSourceDependency.create({
      data: {
        dependencyKind: "COREFERENCE_ANTECEDENT",
        id: randomUUID(),
        sourceMessageContentHash: memorySha256("I am considering a GhostBook."),
        sourceMessageId: dependencySource.messageId,
        sourceMessageUpdatedAt: new Date("2026-07-15T09:00:00.000Z"),
        sourceProjectionVersion: "memory-fact-source-projection-v4",
        targetFactVersionId: invalidDependencyEntityFactVersionId,
        userId
      }
    });
    const replacement = await prisma.message.create({
      data: {
        chatId: dependencySource.chatId,
        content: textMessageContent("Replacement branch."),
        createdAt: new Date("2026-07-15T09:01:00.000Z"),
        role: "user",
        status: "complete"
      }
    });
    await prisma.chat.update({
      data: { activeLeafMessageId: replacement.id },
      where: { id: dependencySource.chatId }
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
    const staleSourceMessage = await prisma.message.create({
      data: {
        chatId: source.chatId,
        content: textMessageContent("Source removed from the retained branch."),
        createdAt: new Date("2026-07-15T09:00:01.000Z"),
        role: "user",
        status: "complete",
        updatedAt: new Date("2026-07-15T09:00:01.000Z")
      }
    });
    const staleAutomaticFactVersionId = await createFact({
      canonicalKey: "profile.stale_editor",
      displayText: "My preferred editor is stale-branch Emacs.",
      generationId,
      languageCode: "en",
      source: {
        branchGeneration: 0,
        chatId: source.chatId,
        messageId: staleSourceMessage.id
      },
      sourceMode: "AUTOMATIC",
      userId
    });
    await createEntityLink({
      alias: "stalebook",
      displayName: "StaleBook",
      factVersionId: staleAutomaticFactVersionId,
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
      directUnindexedFactVersionId,
      enFactVersionId,
      entityFactVersionId,
      excludedChunkId,
      expiredFactVersionId,
      foreignFactVersionId,
      generationId,
      historicalFactVersionId,
      invalidDependencyEntityFactVersionId,
      legacyAssistantFactVersionId,
      legacyChatFactVersionId,
      legacyFolderFactVersionId,
      macbookHistoricalFactVersionId,
      mergedMacbookFactVersionId,
      movedHistoricalMacbookFactVersionId,
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
    expect(allEnIds).not.toContain(fixture.expiredFactVersionId);

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

  it("retrieves EN/RU morphology and mixed transliterated names from stored projections", async () => {
    const userId = await createOwner("memory-multilingual-lexical");
    const generationId = await activateLexicalGeneration(userId);
    const current = await createChatWithLeaf({
      sourceRevision: 0,
      title: "Multilingual lexical request",
      userId,
      userText: "Recall my editor and model notes."
    });
    const enFactVersionId = await createFact({
      canonicalKey: "lexical.editor.en",
      displayText: "My preferred editor is Neovim.",
      generationId,
      languageCode: "en",
      userId
    });
    const ruFactVersionId = await createFact({
      canonicalKey: "lexical.editor.ru",
      displayText: "Мой предпочтительный редактор — Helix.",
      generationId,
      languageCode: "ru",
      userId
    });
    const mixedDisplayText = "Модель Qwen3 для проекта Москва называется «Зелёный-7».";
    const mixedFactVersionId = await createFact({
      canonicalKey: "lexical.model.mixed",
      displayText: mixedDisplayText,
      generationId,
      languageCode: "und",
      userId
    });
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);

    for (const testCase of [{
      expectedId: enFactVersionId,
      lane: "FACT_FTS_ENGLISH" as const,
      query: "preferring editors"
    }, {
      expectedId: ruFactVersionId,
      lane: "FACT_FTS_RUSSIAN" as const,
      query: "предпочтительные редакторы"
    }]) {
      const result = await repository.retrieve({
        assistantId: null,
        chatId: current.chatId,
        now: fixtureNow,
        plan: planMemoryRetrieval({ currentUserText: testCase.query, now: fixtureNow }),
        userId
      });
      const candidates = result.laneResults.find(({ lane }) =>
        lane === testCase.lane)?.candidates ?? [];
      expect(candidates.map(({ itemId }) => itemId)).toContain(testCase.expectedId);
      expect(candidates.find(({ itemId }) => itemId === testCase.expectedId)?.itemType)
        .toBe("FACT_VERSION");
    }

    for (const query of ["Moskva", "Zeleniy", "Qwen3 Moskva Zeleniy-7"]) {
      const result = await repository.retrieve({
        assistantId: null,
        chatId: current.chatId,
        now: fixtureNow,
        plan: planMemoryRetrieval({ currentUserText: query, now: fixtureNow }),
        userId
      });
      expect(result.laneResults.find(({ lane }) => lane === "FACT_TRIGRAM")
        ?.candidates.map(({ itemId }) => itemId)).toContain(mixedFactVersionId);
    }

    const projections = await prisma.$queryRaw<Array<{
      displayText: string;
      englishVector: string;
      normalizedSearchText: string;
      russianVector: string;
      trigramSearchText: string;
    }>>(Prisma.sql`
      SELECT version."displayText", entry."normalizedSearchText",
        entry."searchVectorEnglish"::text AS "englishVector",
        entry."searchVectorRussian"::text AS "russianVector",
        entry."trigramSearchText" AS "trigramSearchText"
      FROM "MemorySearchEntry" AS entry
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = entry."userId" AND version."id" = entry."factVersionId"
      WHERE entry."userId" = ${userId}
        AND entry."indexGenerationId" = ${generationId}
        AND entry."factVersionId" = ${mixedFactVersionId}
    `);
    expect(projections).toEqual([expect.objectContaining({
      displayText: mixedDisplayText,
      normalizedSearchText: "модель qwen3 для проекта москва называется «зеленый-7»."
    })]);
    expect(projections[0]?.displayText).toContain("Зелёный");
    expect(projections[0]?.normalizedSearchText).not.toContain("ё");
    expect(projections[0]?.englishVector.length).toBeGreaterThan(0);
    expect(projections[0]?.russianVector).toContain("зелен");
    expect(projections[0]?.trigramSearchText).toContain("moskva");
    expect(projections[0]?.trigramSearchText).toContain("zelenyy");
  });

  it("returns a bounded broad profile with explicit facts before learned facts and no history", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const plan = planMemoryRetrieval({
      currentUserText: "What do you know about me?",
      filters: { sourceKinds: ["FACT", "EVENT"] },
      now: fixtureNow,
      profileRequested: true
    });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });

    expect(result.laneResults.map(({ lane }) => lane)).toEqual(["FACT_PROFILE"]);
    const candidates = result.laneResults[0]?.candidates ?? [];
    const ids = candidates.map(({ itemId }) => itemId);
    expect(candidates.length).toBeLessThanOrEqual(20);
    expect(ids).toEqual(expect.arrayContaining([
      fixture.enFactVersionId,
      fixture.ruFactVersionId,
      fixture.sensitiveFactVersionId,
      fixture.automaticSensitiveFactVersionId
    ]));
    for (const excludedId of [
      fixture.foreignFactVersionId,
      fixture.expiredFactVersionId,
      fixture.historicalFactVersionId,
      fixture.legacyAssistantFactVersionId,
      fixture.legacyChatFactVersionId,
      fixture.legacyFolderFactVersionId,
      fixture.otherFolderFactVersionId,
      fixture.staleAutomaticFactVersionId,
      fixture.validChunkId
    ]) expect(ids).not.toContain(excludedId);
    const learnedIndex = ids.indexOf(fixture.automaticSensitiveFactVersionId);
    expect(learnedIndex).toBeGreaterThan(-1);
    for (const explicitId of [
      fixture.enFactVersionId,
      fixture.ruFactVersionId,
      fixture.sensitiveFactVersionId
    ]) {
      expect(ids.indexOf(explicitId)).toBeLessThan(learnedIndex);
    }

    const ranked = fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow);
    expect(ranked.map(({ itemId }) => itemId)).toEqual(ids);
    expect(ranked.every(({ itemType }) => itemType === "FACT_VERSION")).toBe(true);
  });

  it("uses digests for overview while targeted search returns authoritative raw chunks", async () => {
    const userId = await createOwner("memory-history-overview");
    try {
      const generationId = await activateLexicalGeneration(userId);
      const current = await createChatWithLeaf({
        sourceRevision: 0,
        title: "Current overview request",
        userId,
        userText: "Summarize our deployment discussions."
      });
      const histories = [
        await createDigestHistoryChat({
          digestText: "Summary: Sequoiaonly marks the cedar deployment chat, which selected a blue-green rollout.",
          generationId,
          occurredAt: new Date("2026-07-10T09:00:00.000Z"),
          safeChunkText: "User:\nThe cedar deployment needs a blue-green rollout.",
          title: "Cedar deployment",
          userId
        }),
        await createDigestHistoryChat({
          digestText: "Summary: The birch deployment chat left the launch date open.",
          generationId,
          occurredAt: new Date("2026-07-11T09:00:00.000Z"),
          safeChunkText: "User:\nThe birch deployment launch date remains open.",
          title: "Birch deployment",
          userId
        }),
        await createDigestHistoryChat({
          digestText: "Summary: The maple deployment chat assigned the rollback owner.",
          generationId,
          occurredAt: new Date("2026-07-12T09:00:00.000Z"),
          safeChunkText: "User:\nThe maple deployment rollback owner is assigned.",
          title: "Maple deployment",
          userId
        })
      ];
      const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
      const overviewPlan = planMemoryRetrieval({
        currentUserText: "Give me an overview of our deployment chats.",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "HISTORY_OVERVIEW",
        now: fixtureNow,
        temporalIntent: "ANY"
      });
      const overview = await repository.retrieve({
        assistantId: null,
        chatId: current.chatId,
        now: fixtureNow,
        plan: overviewPlan,
        userId
      });
      expect(overview.laneResults.map(({ lane }) => lane)).toEqual([
        "HISTORY_RECALL_FTS_SIMPLE",
        "HISTORY_RECALL_RECENT"
      ]);
      const overviewRanked = fuseMemoryRetrievalCandidates(
        overviewPlan,
        overview.laneResults,
        fixtureNow
      );
      expect(new Set(overviewRanked.map(({ itemId }) => itemId))).toEqual(
        new Set(histories.map(({ chunkId }) => chunkId))
      );
      const overviewExpanded = await repository.expand(
        overview.snapshot,
        overviewPlan,
        overviewRanked
      );
      expect(overviewExpanded).toHaveLength(3);
      expect(overviewExpanded.every(({ projectionKind }) =>
        projectionKind === "CHAT_DIGEST_SAFE_TEXT")).toBe(true);
      expect(new Set(overviewExpanded.map(({ supportingItemId }) => supportingItemId)))
        .toEqual(new Set(histories.map(({ digestId }) => digestId)));
      const overviewPack = packMemoryPersonalContext({
        expanded: overviewExpanded,
        plan: overviewPlan,
        ranked: overviewRanked
      });
      expect(overviewPack.items).toHaveLength(3);
      expect(new Set(overviewPack.items.map(({ sourceChatId }) => sourceChatId)))
        .toEqual(new Set(histories.map(({ chatId }) => chatId)));
      for (const history of histories) {
        expect(overviewPack.text).toContain(history.digestText);
      }

      const targetedPlan = planMemoryRetrieval({
        currentUserText: "deployment",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now: fixtureNow,
        temporalIntent: "ANY"
      });
      const targeted = await repository.retrieve({
        assistantId: null,
        chatId: current.chatId,
        now: fixtureNow,
        plan: targetedPlan,
        userId
      });
      expect(targeted.laneResults.map(({ lane }) => lane)).toEqual([
        "HISTORY_RECALL_EXACT",
        "HISTORY_DIGEST_FTS_SIMPLE",
        "HISTORY_RECALL_FTS_SIMPLE",
        "HISTORY_RECALL_FTS_ENGLISH",
        "HISTORY_RECALL_TRIGRAM"
      ]);
      const targetedRanked = fuseMemoryRetrievalCandidates(
        targetedPlan,
        targeted.laneResults,
        fixtureNow
      );
      const targetedExpanded = await repository.expand(
        targeted.snapshot,
        targetedPlan,
        targetedRanked
      );
      expect(new Set(targetedExpanded.map(({ itemId }) => itemId))).toEqual(
        new Set(histories.map(({ chunkId }) => chunkId))
      );
      expect(targetedExpanded.every(({ projectionKind, supportingItemId }) =>
        projectionKind === "RECALL_CHUNK_SAFE_PROJECTED_TEXT" &&
        supportingItemId === null)).toBe(true);
      for (const history of histories) {
        expect(targetedExpanded.map(({ safeText }) => safeText)).not.toContain(
          history.digestText
        );
      }

      const digestOnlyPlan = planMemoryRetrieval({
        currentUserText: "sequoiaonly",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now: fixtureNow,
        temporalIntent: "ANY"
      });
      const digestOnly = await repository.retrieve({
        assistantId: null,
        chatId: current.chatId,
        now: fixtureNow,
        plan: digestOnlyPlan,
        userId
      });
      expect(digestOnly.laneResults.find(({ lane }) =>
        lane === "HISTORY_DIGEST_FTS_SIMPLE")?.candidates.map(({ itemId }) => itemId))
        .toEqual([histories[0]!.chunkId]);
      const digestOnlyRanked = fuseMemoryRetrievalCandidates(
        digestOnlyPlan,
        digestOnly.laneResults,
        fixtureNow
      );
      expect(digestOnlyRanked).toMatchObject([{
        itemId: histories[0]!.chunkId,
        laneRanks: { HISTORY_DIGEST_FTS_SIMPLE: 1 }
      }]);
      const digestOnlyExpanded = await repository.expand(
        digestOnly.snapshot,
        digestOnlyPlan,
        digestOnlyRanked
      );
      expect(digestOnlyExpanded).toEqual([expect.objectContaining({
        itemId: histories[0]!.chunkId,
        projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
        safeText: histories[0]!.safeChunkText,
        supportingItemId: null
      })]);

      const aggregationPlan = planMemoryRetrieval({
        aggregationRequested: true,
        currentUserText: "Which deployment decisions appeared across chats?",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now: fixtureNow,
        temporalIntent: "ANY"
      });
      const aggregation = await repository.retrieve({
        assistantId: null,
        chatId: current.chatId,
        now: fixtureNow,
        plan: aggregationPlan,
        userId
      });
      expect(aggregation.laneResults.map(({ lane }) => lane)).toEqual([
        "HISTORY_RECALL_EXACT",
        "HISTORY_RECALL_FTS_SIMPLE",
        "HISTORY_RECALL_FTS_ENGLISH",
        "HISTORY_RECALL_TRIGRAM"
      ]);
      const aggregationRanked = fuseMemoryRetrievalCandidates(
        aggregationPlan,
        aggregation.laneResults,
        fixtureNow
      );
      const aggregationSessions = await repository.projectAggregationSessions(
        aggregation.snapshot,
        aggregationPlan,
        aggregationRanked
      );
      const aggregationExpanded = await repository.expand(
        aggregation.snapshot,
        aggregationPlan,
        aggregationSessions
      );
      expect(aggregationExpanded).toHaveLength(3);
      expect(aggregationExpanded.every(({ projectionKind, supportingItemId }) =>
        projectionKind === "CHAT_DIGEST_SAFE_TEXT" &&
        supportingItemId !== null)).toBe(true);
      expect(new Set(aggregationExpanded.map(({ safeText }) => safeText))).toEqual(
        new Set(histories.map(({ digestText }) => digestText))
      );
    } finally {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("merges owner-scoped filtered and unrestricted temporal recall through rejoin", async () => {
    const userId = await createOwner("memory-temporal-owner");
    const foreignUserId = await createOwner("memory-temporal-foreign");
    try {
      const generationId = await activateLexicalGeneration(userId);
      const foreignGenerationId = await activateLexicalGeneration(foreignUserId);
      const current = await createChatWithLeaf({
        sourceRevision: 0,
        title: "Current temporal request",
        userId,
        userText: "What happened yesterday?"
      });
      const inside = await createDigestHistoryChat({
        digestText: "Summary: The cedar rehearsal completed successfully.",
        generationId,
        occurredAt: new Date("2026-08-09T09:00:00.000Z"),
        safeChunkText: "User:\nThe cedar rehearsal completed successfully.",
        title: "Cedar temporal hit",
        userId
      });
      const outside = await createDigestHistoryChat({
        digestText: "Summary: The birch rehearsal established the fallback procedure.",
        generationId,
        occurredAt: new Date("2026-06-01T09:00:00.000Z"),
        safeChunkText: "User:\nThe birch rehearsal established the fallback procedure.",
        title: "Birch temporal fallback",
        userId
      });
      const foreign = await createDigestHistoryChat({
        digestText: "Summary: Foreign temporal evidence must remain isolated.",
        generationId: foreignGenerationId,
        occurredAt: new Date("2026-08-09T10:00:00.000Z"),
        safeChunkText: "User:\nForeign temporal evidence must remain isolated.",
        title: "Foreign temporal hit",
        userId: foreignUserId
      });
      const plan = planMemoryRetrieval({
        currentUserText: "What happened yesterday?",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now: fixtureNow,
        temporalIntent: "ANY",
        timeZone: "UTC"
      });
      const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
      const result = await repository.retrieve({
        assistantId: null,
        chatId: current.chatId,
        now: fixtureNow,
        plan,
        userId
      });
      const filtered = result.laneResults.find(({ lane }) =>
        lane === "HISTORY_RECALL_TEMPORAL_FILTERED");
      const unrestricted = result.laneResults.find(({ lane }) =>
        lane === "HISTORY_RECALL_TEMPORAL_UNRESTRICTED");
      expect(filtered?.candidates.map(({ itemId }) => itemId)).toEqual([inside.chunkId]);
      expect(unrestricted?.candidates.map(({ itemId }) => itemId)).toEqual([
        inside.chunkId,
        outside.chunkId
      ]);
      expect(result.laneResults.flatMap(({ candidates }) =>
        candidates.map(({ itemId }) => itemId))).not.toContain(foreign.chunkId);

      const ranked = fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow);
      expect(ranked.map(({ itemId }) => itemId)).toEqual([
        inside.chunkId,
        outside.chunkId
      ]);
      const expanded = await repository.expand(result.snapshot, plan, ranked);
      expect(expanded.map(({ itemId }) => itemId)).toEqual([
        inside.chunkId,
        outside.chunkId
      ]);

      await prisma.memoryRecallChunk.update({
        data: { invalidatedAt: fixtureNow, state: "INVALIDATED" },
        where: { id: outside.chunkId }
      });
      const rejoined = await repository.expand(result.snapshot, plan, ranked);
      expect(rejoined.map(({ itemId }) => itemId)).toEqual([inside.chunkId]);
    } finally {
      await prisma.memoryDeletionOutbox.deleteMany({
        where: { userId: { in: [userId, foreignUserId] } }
      });
      await prisma.user.deleteMany({ where: { id: { in: [userId, foreignUserId] } } });
    }
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

  it("[E07] retrieves one canonical current pointer or deduplicated genuine history", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const currentPlan = planMemoryRetrieval({
      currentUserText: "MacBook",
      filters: { sourceKinds: ["FACT", "EVENT"] },
      mode: "TARGETED_CURRENT",
      now: fixtureNow,
      temporalIntent: "CURRENT"
    });
    const current = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: currentPlan,
      userId: fixture.userId
    });
    const currentIds = current.laneResults.flatMap(({ candidates }) =>
      candidates.map(({ itemId }) => itemId));
    expect(currentIds).toContain(fixture.entityFactVersionId);
    expect(currentIds).not.toContain(fixture.macbookHistoricalFactVersionId);
    expect(currentIds).not.toContain(fixture.mergedMacbookFactVersionId);
    expect(currentIds).not.toContain(fixture.expiredFactVersionId);

    const historicalPlan = planMemoryRetrieval({
      currentUserText: "MacBook",
      filters: { sourceKinds: ["FACT", "EVENT"] },
      mode: "HISTORICAL_MEMORY",
      now: fixtureNow,
      temporalIntent: "HISTORICAL"
    });
    const historical = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: historicalPlan,
      userId: fixture.userId
    });
    const ranked = fuseMemoryRetrievalCandidates(
      historicalPlan,
      historical.laneResults,
      fixtureNow
    );
    expect(ranked).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: fixture.entityFactVersionId,
        metadata: expect.objectContaining({ current: true, lifecycleState: "ACTIVE" })
      }),
      expect.objectContaining({
        itemId: fixture.macbookHistoricalFactVersionId,
        metadata: expect.objectContaining({
          historical: true,
          lifecycleState: "SUPERSEDED"
        })
      })
    ]));
    const targetFactId = (await prisma.memoryFactVersion.findUniqueOrThrow({
      select: { factId: true },
      where: { id: fixture.entityFactVersionId }
    })).factId;
    const movedFactId = (await prisma.memoryFactVersion.findUniqueOrThrow({
      select: { factId: true },
      where: { id: fixture.movedHistoricalMacbookFactVersionId }
    })).factId;
    const [root] = await prisma.$queryRaw<Array<{ factRootId: string | null }>>(Prisma.sql`
      SELECT aiqsa_memory_fact_root_id(
        ${fixture.userId}, ${movedFactId}
      ) AS "factRootId"
    `);
    expect(root?.factRootId).toBe(targetFactId);
    expect(ranked.filter(({ itemId }) => [
      fixture.macbookHistoricalFactVersionId,
      fixture.movedHistoricalMacbookFactVersionId
    ].includes(itemId))).toHaveLength(1);
    expect(ranked).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: fixture.macbookHistoricalFactVersionId,
        metadata: expect.objectContaining({ factId: targetFactId })
      })
    ]));
    expect(ranked.map(({ itemId }) => itemId)).not.toContain(
      fixture.movedHistoricalMacbookFactVersionId
    );
    expect(ranked.map(({ itemId }) => itemId)).not.toContain(
      fixture.mergedMacbookFactVersionId
    );
    expect(ranked.map(({ itemId }) => itemId)).not.toContain(
      fixture.expiredFactVersionId
    );
    const expanded = await repository.expand(
      historical.snapshot,
      historicalPlan,
      ranked
    );
    const pack = packMemoryPersonalContext({ expanded, plan: historicalPlan, ranked });
    expect(pack.text).toContain('"evidence_type":"current_fact"');
    expect(pack.text).toContain('"evidence_type":"historical_fact"');
    expect(pack.text).toContain('"document_time":"2025-07-01T00:00:00.000Z"');
    expect(pack.text).toContain('"raw_safe_evidence":"The user ordered a MacBook Air');
    expect(pack.text).not.toContain("duplicate MacBook representation");
    expect(pack.text).not.toContain("expired MacBook");
  });

  it("[E07] proves bounded canonical authority, history, entity, FTS, and expiry plans", async () => {
    const entityLink = await prisma.memoryFactVersionEntity.findFirstOrThrow({
      select: { entityId: true },
      where: { factVersionId: fixture.entityFactVersionId, userId: fixture.userId }
    });
    const plans = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL enable_seqscan = off`);
      // Stabilize the qualification around the indexes that satisfy each
      // bounded ORDER BY directly. Otherwise full-suite statistics can make
      // PostgreSQL prefer a different owner index plus an in-memory sort.
      await tx.$executeRaw(Prisma.sql`SET LOCAL enable_sort = off`);
      const pointer = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT fact."currentVersionId"
        FROM "MemoryFact" AS fact
        WHERE fact."userId" = ${fixture.userId}
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" IS NOT NULL
        ORDER BY fact."currentVersionId"
        LIMIT 25
      `);
      const authority = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT version."id"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId"
          AND fact."id" = version."factId"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId"
          AND scope."id" = fact."scopeId"
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = version."userId"
        WHERE ${memoryReusableFactAuthorityPredicate(fixture.userId)}
        ORDER BY version."state", version."systemTo", version."systemFrom", version."id"
        LIMIT 100
      `);
      const fts = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT entry."id"
        FROM "MemorySearchEntry" AS entry
        WHERE entry."searchVectorSimple" @@ plainto_tsquery('simple', 'macbook')
      `);
      const englishFts = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT entry."id"
        FROM "MemorySearchEntry" AS entry
        WHERE entry."searchVectorEnglish" @@ plainto_tsquery('english', 'editors')
      `);
      const russianFts = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT entry."id"
        FROM "MemorySearchEntry" AS entry
        WHERE entry."searchVectorRussian" @@ plainto_tsquery('russian', 'редакторы')
      `);
      const trigram = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT entry."id"
        FROM "MemorySearchEntry" AS entry
        WHERE 'moskva' <% entry."trigramSearchText"
      `);
      const entity = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT link."factVersionId"
        FROM "MemoryFactVersionEntity" AS link
        WHERE link."userId" = ${fixture.userId}
          AND link."entityId" = ${entityLink.entityId}
          AND link."role" = 'SUBJECT'::"MemoryEntityLinkRole"
          AND link."factVersionId" >= ''
        ORDER BY link."userId", link."entityId", link."role", link."factVersionId"
      `);
      const history = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (FORMAT JSON)
        SELECT version."id"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId"
          AND fact."id" = version."factId"
        INNER JOIN "MemoryFact" AS root_fact
          ON root_fact."userId" = fact."userId"
          AND root_fact."id" = aiqsa_memory_fact_root_id(
            ${fixture.userId}, fact."id"
          )
        WHERE version."userId" = ${fixture.userId}
          AND version."contentPurgedAt" IS NULL
          AND version."state" IN (
            'ACTIVE'::"MemoryFactVersionState",
            'SUPERSEDED'::"MemoryFactVersionState"
          )
        ORDER BY version."state", version."systemTo", version."systemFrom", version."id"
        LIMIT 100
      `);
      const expiry = await tx.$queryRaw<unknown[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT version."id"
        FROM "MemoryFactVersion" AS version
        WHERE version."userId" = ${fixture.userId}
          AND version."contentPurgedAt" IS NULL
          AND version."expiresAt" IS NOT NULL
          AND version."expiresAt" <= ${fixtureNow}
        ORDER BY version."expiresAt", version."id"
        LIMIT 100
      `);
      return {
        authority,
        englishFts,
        entity,
        expiry,
        fts,
        history,
        pointer,
        russianFts,
        trigram
      };
    });
    const indexes = Object.fromEntries(Object.entries(plans).map(([kind, plan]) => [
      kind,
      queryPlanIndexNames(plan)
    ]));
    const planEvidence = JSON.stringify(indexes);
    expect(indexes.pointer.some((name) =>
      name === "MemoryFact_active_owner_scope_idx" ||
      name === "MemoryFact_userId_currentVersionId_idx"
    ), planEvidence).toBe(true);
    expect(indexes.authority, planEvidence)
      .toContain("MemoryFactVersion_retrieval_lifecycle_idx");
    expect(indexes.fts, planEvidence).toContain("MemorySearchEntry_simple_gin_idx");
    expect(indexes.englishFts, planEvidence)
      .toContain("MemorySearchEntry_english_gin_idx");
    expect(indexes.russianFts, planEvidence)
      .toContain("MemorySearchEntry_russian_gin_idx");
    expect(indexes.trigram, planEvidence)
      .toContain("MemorySearchEntry_trigram_gin_idx");
    expect(indexes.entity).toContain(
      "MemoryFactVersionEntity_userId_entityId_role_factVersionId_idx"
    );
    expect(indexes.history).toContain("MemoryFactVersion_retrieval_lifecycle_idx");
    expect(indexes.expiry).toContain("MemoryFactVersion_retrieval_expiry_idx");
    const evidence = Object.freeze({
      explainedPlanKinds: Object.keys(plans).sort(),
      indexBackedPlanKinds: Object.values(indexes).filter((names) => names.length > 0).length,
      sanitizedAggregatesOnly: true,
      version: "memory-vnext-retrieval-query-plans-v2"
    });
    expect(evidence).toMatchObject({
      explainedPlanKinds: [
        "authority", "englishFts", "entity", "expiry", "fts", "history", "pointer",
        "russianFts", "trigram"
      ],
      indexBackedPlanKinds: 9,
      sanitizedAggregatesOnly: true
    });
    expect(JSON.stringify(evidence)).not.toContain(fixture.userId);
    expect(JSON.stringify(evidence)).not.toContain(fixture.rawSourceText);
    console.info("memory_vnext_retrieval_query_plans", evidence);
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

  it("uses exact supported entities without a category or embedding gate and reapplies authority fences", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const retrieve = (query: string) => repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: planMemoryRetrieval({ currentUserText: query, now: fixtureNow }),
      userId: fixture.userId
    });
    const valid = await retrieve("макбук");
    const entityLane = valid.laneResults.find(({ lane }) => lane === "FACT_ENTITY");
    expect(entityLane?.candidates.map(({ itemId }) => itemId)).toContain(
      fixture.entityFactVersionId
    );
    expect(entityLane?.candidates.find(({ itemId }) =>
      itemId === fixture.entityFactVersionId)?.metadata.category).toBe("other");

    const hintedPlan = planMemoryRetrieval({
      allowedEntityRefs: ["opaque-macbook-ref"],
      currentUserText: "макбук",
      entityMentions: [{
        occurrenceIndex: 0,
        resolvedRef: "opaque-macbook-ref",
        text: "макбук"
      }],
      now: fixtureNow
    });
    const hinted = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: hintedPlan,
      userId: fixture.userId
    });
    expect(hinted.laneResults.find(({ lane }) => lane === "FACT_ENTITY")
      ?.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          deterministicMatch: "EXACT_ALIAS_SINGLE_ROOT",
          entryId: null,
          itemId: fixture.entityFactVersionId
        })
      ]));
    const ambiguousEntityId = await createEntityLink({
      alias: "макбук",
      displayName: "Another MacBook",
      factVersionId: fixture.directUnindexedFactVersionId,
      userId: fixture.userId
    });
    try {
      const ambiguous = await repository.retrieve({
        assistantId: null,
        chatId: fixture.currentChatId,
        now: fixtureNow,
        plan: hintedPlan,
        userId: fixture.userId
      });
      const ambiguousMatches = ambiguous.laneResults
        .find(({ lane }) => lane === "FACT_ENTITY")?.candidates ?? [];
      expect(ambiguousMatches.map(({ itemId }) => itemId)).toEqual(expect.arrayContaining([
        fixture.entityFactVersionId,
        fixture.directUnindexedFactVersionId
      ]));
      expect(ambiguousMatches.every(({ deterministicMatch }) =>
        deterministicMatch === null)).toBe(true);
    } finally {
      const aliases = await prisma.memoryEntityAlias.findMany({
        select: { id: true },
        where: { entityId: ambiguousEntityId, userId: fixture.userId }
      });
      await prisma.$transaction(async (tx) => {
        await tx.memoryFactVersionEntity.deleteMany({
          where: { entityId: ambiguousEntityId, userId: fixture.userId }
        });
        await tx.memoryEntityAliasSupport.deleteMany({
          where: { aliasId: { in: aliases.map(({ id }) => id) }, userId: fixture.userId }
        });
        await tx.memoryEntityAlias.deleteMany({
          where: { entityId: ambiguousEntityId, userId: fixture.userId }
        });
        await tx.memoryEntity.deleteMany({
          where: { id: ambiguousEntityId, userId: fixture.userId }
        });
      });
    }

    for (const [query, excludedId] of [
      ["ghostbook", fixture.invalidDependencyEntityFactVersionId],
      ["expiredbook", fixture.expiredFactVersionId],
      ["stalebook", fixture.staleAutomaticFactVersionId]
    ] as const) {
      const result = await retrieve(query);
      expect(result.laneResults.flatMap(({ candidates }) => candidates)
        .map(({ itemId }) => itemId)).not.toContain(excludedId);
    }
  });

  it("keeps exact current facts available without a search entry", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const plan = planMemoryRetrieval({
      currentUserText: "Unindexed exact sentinel",
      now: fixtureNow
    });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });

    expect(result.laneResults.find(({ lane }) => lane === "FACT_EXACT")?.candidates)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          deterministicMatch: "EXACT_TEXT",
          entryId: null,
          itemId: fixture.directUnindexedFactVersionId
        })
      ]));
    expect(result.laneResults.find(({ lane }) => lane === "FACT_FTS_SIMPLE")?.candidates
      .map(({ itemId }) => itemId)).not.toContain(fixture.directUnindexedFactVersionId);
  });

  it("surfaces distinctive fact terms from a longer natural-language question", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const plan = planMemoryRetrieval({
      currentUserText: "Which preferred editor do I consistently use for daily coding?",
      now: fixtureNow
    });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });

    expect(result.laneResults.find(({ lane }) => lane === "FACT_FTS_SIMPLE")?.candidates)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: fixture.enFactVersionId })
      ]));
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
    // Qualify steady-state retrieval after every distinct query shape has
    // populated the query-engine statement cache and PostgreSQL page cache.
    for (const testCase of cases) {
      const plan = planMemoryRetrieval({ currentUserText: testCase.query, now: fixtureNow });
      await repository.retrieve({
        assistantId: null,
        chatId: fixture.currentChatId,
        now: fixtureNow,
        plan,
        userId: fixture.userId
      });
    }
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
      candidateHardCap: MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
      crossTenantHits,
      evidenceVersion: "memory-language-agnostic-local-candidates-v4",
      latencyP95Ms: Number(percentile95(latencies).toFixed(2)),
      maximumLatencyP95Ms: 150,
      maximumCandidateCount,
      recallAt5: recalled / sampleCount,
      unrelatedCandidateRate: unrelatedCandidateQueries / recencyQueries.length,
      sanitizedAggregatesOnly: true,
      sampleCount
    });
    expect(evidence).toMatchObject({
      candidateHardCap: MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
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
  }, 30_000);

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
