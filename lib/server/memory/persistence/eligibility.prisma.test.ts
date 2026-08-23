import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import type { MemorySourceActionInput } from "../../../contracts/memoryClient";
import { textMessageContent } from "../../../domain/content";
import {
  fuseMemoryRetrievalCandidates,
  planMemoryRetrieval
} from "../../../domain/memory/retrieval";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import { createMemoryClientRefService } from "../actions/clientRef";
import { createPrismaMemoryItemEmbeddingRepository } from "../embedding/repository";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import { createPrismaMemoryRebuildRepository } from "../rebuild/repository";
import {
  createPrismaLocalMemoryRetrievalRepository
} from "../retrieval/localRepository";
import {
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
  createPrismaMemoryVectorRepository,
  type MemoryVectorProfile,
  type MemoryVectorSearchInput
} from "../retrieval/vector";
import {
  createMemorySourceActionService
} from "../sources/actionService";
import { loadMemoryRunSources } from "../sources/runProjection";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../sourceState";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  loadPersonalEligibleFactVersionIds
} from "./eligibility";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "./lexical";

const fixtureNow = new Date("2026-08-21T10:00:00.000Z");

function queryVector(): number[] {
  return Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0);
}

async function createClassifierReceipt(userId: string): Promise<string> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    select: { memoryGeneration: true, memoryRevision: true },
    where: { userId }
  });
  const jobId = randomUUID();
  const bindingId = randomUUID();
  const completedAt = new Date(fixtureNow.getTime() - 1);
  const startedAt = new Date(fixtureNow.getTime() - 2);
  await prisma.$transaction(async (tx) => {
    await tx.memoryJob.create({
      data: {
        acceptedResultHash: "7".repeat(64),
        completedAt,
        id: jobId,
        idempotencyFingerprint: `data-002-classifier-${randomUUID()}`,
        kind: "RECLASSIFY_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: "data-002-classifier-v1",
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: "8".repeat(64),
        cachedInputTokens: 0,
        completedAt,
        createdAt: startedAt,
        destinationFingerprint: "9".repeat(64),
        id: bindingId,
        inputHash: "a".repeat(64),
        inputTokens: 5,
        logicalRole: "MEMORY_RECLASSIFY",
        memoryJobId: jobId,
        ordinal: 0,
        outputTokens: 2,
        ownerType: "JOB",
        pipelineVersion: "data-002-classifier-v1",
        policyVersion: "data-002-classifier-policy-v1",
        promptVersion: "data-002-classifier-prompt-v1",
        providerId: "data-002-fixture",
        reasoningTokens: 0,
        recoverableUntil: completedAt,
        relationsDetachedAt: fixtureNow,
        schemaVersion: "data-002-classifier-schema-v1",
        secretFreeExecutionSnapshot: {
          providerExecutionSnapshot: {
            providerFamily: "data-002-fixture",
            providerModelId: "data-002-classifier-v1"
          },
          version: 1
        },
        startedAt,
        state: "SUCCEEDED",
        totalTokens: 7,
        usageCompleteness: "COMPLETE",
        userId
      }
    });
    await tx.usageEvent.create({
      data: {
        cachedInputTokens: 0,
        inputTokens: 5,
        memoryExecutionBindingId: bindingId,
        modelId: "data-002-classifier-v1",
        outputTokens: 2,
        provider: "data-002-fixture",
        providerModelId: "data-002-classifier-v1",
        reasoningTokens: 0,
        totalTokens: 7,
        userId
      }
    });
  });
  return bindingId;
}

describe("Personal Memory DATA-002 eligibility on PostgreSQL", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps transferred Personal fact/history evidence dormant across every active consumer", async () => {
    const suffix = randomUUID();
    const userId = `memory-data-002-${suffix}`;
    let projectId: string | null = null;

    await prisma.user.create({
      data: {
        displayName: "DATA-002 owner",
        email: `memory-data-002-${suffix}@example.test`,
        id: userId,
        status: "active"
      }
    });

    try {
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const scope = await prisma.memoryScope.findFirst({
        where: { scopeType: "GLOBAL_USER", state: "ACTIVE", userId }
      }) ?? await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId }
      });
      const embeddingModel = await prisma.providerModel.findUniqueOrThrow({
        select: { connectionId: true },
        where: { id: providerTemplateIds.fakeModel }
      });
      const generation = await prisma.memoryIndexGeneration.create({
        data: {
          chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
          embeddingConfigurationFingerprint: "b".repeat(64),
          embeddingConnectionId: embeddingModel.connectionId,
          embeddingDimension: 1_024,
          embeddingProviderModelId: providerTemplateIds.fakeModel,
          generation: 0,
          indexMode: "HYBRID",
          indexedThroughMemoryRevision: settings.memoryRevision,
          languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          readyAt: fixtureNow,
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
            embeddingProviderModelId: providerTemplateIds.fakeModel,
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

      const sourceChat = await prisma.chat.create({
        data: {
          memoryMode: "NORMAL",
          memorySourceRevision: 1,
          title: "Personal source before Project transfer",
          userId
        }
      });
      const sourceMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: textMessageContent("I keep project notes in a cedar notebook."),
          createdAt: fixtureNow,
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: sourceMessage.id },
        where: { id: sourceChat.id }
      });
      const sourceContentHash = memorySha256({
        chatId: sourceChat.id,
        messageId: sourceMessage.id
      });
      await prisma.chatMemoryCheckpoint.create({
        data: {
          activeLeafMessageId: sourceMessage.id,
          branchGeneration: 0,
          chatId: sourceChat.id,
          lastIndexedMessageId: sourceMessage.id,
          lastSucceededAt: fixtureNow,
          pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
          sourceContentHash,
          sourceRevision: 1,
          status: "READY",
          userId
        }
      });

      const classifierExecutionId = await createClassifierReceipt(userId);
      const factId = randomUUID();
      const factVersionId = randomUUID();
      const factStatement = "I prefer cedar-colored notebooks.";
      const factStructuredValue = { statement: factStatement };
      const factNormalized = normalizeMemorySearchText(factStatement);
      const event = await prisma.memoryEvent.create({
        data: {
          actorType: "JOB",
          operation: "PROMOTE",
          sourceChatId: sourceChat.id,
          sourceGeneration: 0,
          userId
        }
      });
      await prisma.$transaction(async (tx) => {
        await tx.memoryFact.create({
          data: {
            canonicalKey: `preferences.cedar-notebook.${suffix}`,
            category: "preferences",
            currentVersionId: factVersionId,
            id: factId,
            scopeId: scope.id,
            state: "ACTIVE",
            userId
          }
        });
        await tx.memoryFactVersion.create({
          data: {
            category: "preferences",
            confidence: 1,
            createdByEventId: event.id,
            directness: "DIRECT",
            displayText: factStatement,
            factId,
            id: factVersionId,
            importance: 0.9,
            languageCode: "en",
            modality: "PREFERENCE",
            normalizedSearchText: factNormalized,
            pipelineVersion: "data-002-learning-v1",
            safetyClassificationReasonCode: "response_preference",
            safetyClassificationState: "CLASSIFIED",
            safetyClassifiedAt: fixtureNow,
            safetyClassifierExecutionId: classifierExecutionId,
            safetyClassifierModelId: "data-002-classifier-v1",
            safetyClassifierPolicyVersion: "data-002-classifier-policy-v1",
            safetyClassifierProviderId: "data-002-fixture",
            sensitivityClass: "NORMAL",
            sourceMode: "AUTOMATIC",
            state: "ACTIVE",
            structuredValue: factStructuredValue,
            userId
          }
        });
        await tx.memoryEvidence.create({
          data: {
            branchGeneration: 0,
            chatId: sourceChat.id,
            factVersionId,
            messageId: sourceMessage.id,
            observedAt: fixtureNow,
            safeExcerpt: factStatement,
            safeSourceHash: memorySha256(factStatement),
            safetyClass: "NORMAL",
            sourceProjectionVersion: "data-002-learning-v1",
            sourceRole: "user",
            sourceType: "MESSAGE",
            stance: "SUPPORTS",
            userId
          }
        });
      });

      const chunkId = randomUUID();
      const chunkText = "User: I keep project notes in a cedar notebook.";
      const chunkHash = memorySha256(chunkText);
      await prisma.memoryRecallChunk.create({
        data: {
          branchGeneration: 0,
          chatId: sourceChat.id,
          chunkOrdinal: 0,
          chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
          contentHash: chunkHash,
          id: chunkId,
          languageCode: "en",
          normalizedSafeSearchText: normalizeMemorySearchText(chunkText),
          occurredFrom: new Date(fixtureNow.getTime() - 60_000),
          occurredTo: fixtureNow,
          redactionState: "NOT_NEEDED",
          safeProjectedText: chunkText,
          safetyClass: "NORMAL",
          sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
          sourceRevisionAtCreation: 1,
          state: "ACTIVE",
          userId
        }
      });
      await prisma.memoryRecallChunkMessage.create({
        data: {
          chatId: sourceChat.id,
          chunkId,
          messageId: sourceMessage.id,
          ordinal: 0,
          role: "user",
          userId
        }
      });

      const factEntryId = randomUUID();
      const chunkEntryId = randomUUID();
      await prisma.memorySearchEntry.createMany({
        data: [
          {
            embeddingState: "PENDING",
            factVersionId,
            id: factEntryId,
            indexGenerationId: generation.id,
            itemType: "FACT_VERSION",
            languageCode: "en",
            normalizedSearchText: factNormalized,
            safeContentHash: memorySha256({
              displayText: factStatement,
              structuredValue: factStructuredValue
            }),
            safetyIdentitySnapshot: memorySha256({ sensitivityClass: "NORMAL" }),
            sourceIdentitySnapshot: memorySha256({ factVersionId, sourceChatId: sourceChat.id }),
            suppressionIdentitySnapshot: memorySha256({ factId, type: "fact" }),
            userId
          },
          {
            embeddingState: "PENDING",
            id: chunkEntryId,
            indexGenerationId: generation.id,
            itemType: "RECALL_CHUNK",
            languageCode: "en",
            normalizedSearchText: normalizeMemorySearchText(chunkText),
            recallChunkId: chunkId,
            safeContentHash: chunkHash,
            safetyIdentitySnapshot: memorySha256({ safetyClass: "NORMAL" }),
            sourceIdentitySnapshot: memorySha256({ chunkId, sourceChatId: sourceChat.id }),
            suppressionIdentitySnapshot: memorySha256({ chunkId, type: "history" }),
            userId
          }
        ]
      });

      const embedding = createPrismaMemoryItemEmbeddingRepository(prisma);
      await expect(embedding.loadTarget(userId, factEntryId)).resolves.toMatchObject({
        itemId: factVersionId,
        itemType: "FACT_VERSION"
      });
      await expect(embedding.loadTarget(userId, chunkEntryId)).resolves.toMatchObject({
        itemId: chunkId,
        itemType: "RECALL_CHUNK"
      });
      const serializedVector = JSON.stringify(queryVector());
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "MemorySearchEntry"
        SET
          "embedding" = ${serializedVector}::vector,
          "embeddingDimension" = 1024,
          "embeddingState" = 'READY'::"MemoryEmbeddingState"
        WHERE "userId" = ${userId}
          AND "id" IN (${Prisma.join([factEntryId, chunkEntryId])})
      `);

      const consumerChat = await prisma.chat.create({
        data: { memoryMode: "NORMAL", title: "Personal consumer", userId }
      });
      const consumerUserMessage = await prisma.message.create({
        data: {
          chatId: consumerChat.id,
          content: textMessageContent("What are my cedar notebook preferences?"),
          role: "user",
          status: "complete"
        }
      });
      const consumerAssistantMessage = await prisma.message.create({
        data: {
          chatId: consumerChat.id,
          content: textMessageContent("You prefer cedar-colored notebooks."),
          parentMessageId: consumerUserMessage.id,
          role: "assistant",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: consumerAssistantMessage.id },
        where: { id: consumerChat.id }
      });

      const retrieval = createPrismaLocalMemoryRetrievalRepository(prisma);
      const plan = planMemoryRetrieval({
        currentUserText: "cedar",
        now: fixtureNow
      });
      const beforeRetrieval = await retrieval.retrieve({
        assistantId: null,
        chatId: consumerChat.id,
        now: fixtureNow,
        plan,
        userId
      });
      expect(beforeRetrieval.lexicalFailures).toEqual([]);
      const beforeRanked = fuseMemoryRetrievalCandidates(
        plan,
        beforeRetrieval.laneResults,
        fixtureNow
      );
      expect(beforeRanked.map(({ itemId }) => itemId)).toEqual(
        expect.arrayContaining([factVersionId, chunkId])
      );
      const acceptedCandidates = beforeRanked.filter(({ itemId }) =>
        itemId === factVersionId || itemId === chunkId);

      const vectorRepository = createPrismaMemoryVectorRepository(prisma);
      const resolvedProfile = await vectorRepository.resolveActiveProfile(userId);
      expect(resolvedProfile.status).toBe("READY");
      if (resolvedProfile.status !== "READY") throw new Error(resolvedProfile.reason);
      const profile: MemoryVectorProfile = resolvedProfile.profile;
      const vectorInput: MemoryVectorSearchInput = {
        eligibility: {
          allowedFactSensitivity: ["NORMAL"],
          allowedHistorySafety: ["NORMAL"],
          assistantId: null,
          chatId: consumerChat.id,
          folderId: null,
          occurredFrom: null,
          occurredTo: null,
          sourceAssistantId: null,
          sourceChatIds: null,
          sourceFolderId: null
        },
        itemTypes: ["FACT_VERSION", "RECALL_CHUNK"],
        limit: 5,
        minimumScore: profile.minimumSimilarity,
        profile,
        userId,
        vector: queryVector()
      };
      const beforeVector = await vectorRepository.search(vectorInput);
      expect(beforeVector.status).toBe("READY");
      expect(beforeVector.hits.map(({ itemId }) => itemId)).toEqual(
        expect.arrayContaining([factVersionId, chunkId])
      );
      await expect(loadPersonalEligibleFactVersionIds(
        prisma,
        userId,
        [factVersionId]
      )).resolves.toEqual(new Set([factVersionId]));

      const management = createPrismaExplicitMemoryRepository(prisma);
      await expect(management.list(userId, { pageSize: 10 })).resolves.toMatchObject({
        memories: [expect.objectContaining({ id: factId, sourceMode: "AUTOMATIC" })]
      });

      const run = await prisma.modelRun.create({
        data: {
          assistantMessageId: consumerAssistantMessage.id,
          chatId: consumerChat.id,
          modelId: "data-002-answer-model",
          normalizedRequest: {},
          provider: "data-002-fixture",
          status: "complete",
          userId,
          userMessageId: consumerUserMessage.id
        }
      });
      const currentSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const preparedContext = `${factStatement}\n${chunkText}`;
      const binding = await prisma.$transaction(async (tx) => {
        const attempt = await tx.memoryRetrievalAttempt.create({
          data: {
            admissionKind: "NORMAL_SEND",
            admittedAssistantLeafMessageId: consumerAssistantMessage.id,
            admittedUserMessageId: consumerUserMessage.id,
            attemptOrdinal: 0,
            baseRequestHash: memorySha256({ type: "data-002-base" }),
            boundedPrivateBaseRequestSnapshot: {},
            chatId: consumerChat.id,
            chatMemoryModeSnapshot: "NORMAL",
            consumedAt: fixtureNow,
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            indexGenerationIdSnapshot: generation.id,
            memoryGenerationSnapshot: currentSettings.memoryGeneration,
            modelRunId: run.id,
            outcome: "USED",
            preparedContextHash: memorySha256(preparedContext),
            preparedContextText: preparedContext,
            preparedContextTokenCount: 16,
            queryHash: memorySha256("cedar notebook preferences"),
            retrievalRevisionSnapshot: currentSettings.memoryRevision,
            settingsSnapshot: {},
            state: "CONSUMED",
            userId,
            utilityEgressMode: "LOCAL_ONLY"
          }
        });
        const created = await tx.modelRunMemoryBinding.create({
          data: {
            boundedSafeQuerySnapshot: "cedar notebook preferences",
            contextTextHash: memorySha256(preparedContext),
            contextTokenCount: 16,
            finalizedAt: fixtureNow,
            finalizedRevisionSnapshot: currentSettings.memoryRevision,
            indexGenerationId: generation.id,
            memoryGenerationSnapshot: currentSettings.memoryGeneration,
            modelRunId: run.id,
            outcome: "USED",
            queryHash: memorySha256("cedar notebook preferences"),
            queryPlannerVersion: "data-002-query-planner-v1",
            retrievalAttemptId: attempt.id,
            retrievalPipelineVersion: "data-002-retrieval-v1",
            retrievalRevisionSnapshot: currentSettings.memoryRevision,
            settingsSnapshot: {},
            userId
          }
        });
        await tx.modelRunMemoryItem.createMany({
          data: [
            {
              bindingId: created.id,
              exactItemId: factVersionId,
              factVersionId,
              featureSnapshot: {},
              finalScore: 0.9,
              includedText: factStatement,
              includedTextHash: memorySha256(factStatement),
              itemStateAtAdmission: "ACTIVE",
              itemType: "FACT_VERSION",
              laneRanks: {},
              ordinal: 0,
              selectionReason: "data-002-fixture",
              sourceBranchGenerationSnapshot: 0,
              sourceChatIdSnapshot: sourceChat.id,
              sourceMessageIdsSnapshot: [sourceMessage.id],
              sourceRevisionSnapshot: 1,
              userId
            },
            {
              bindingId: created.id,
              exactItemId: chunkId,
              featureSnapshot: {},
              finalScore: 0.8,
              includedText: chunkText,
              includedTextHash: memorySha256(chunkText),
              itemStateAtAdmission: "ACTIVE",
              itemType: "RECALL_CHUNK",
              laneRanks: {},
              ordinal: 1,
              recallChunkId: chunkId,
              selectionReason: "data-002-fixture",
              sourceBranchGenerationSnapshot: 0,
              sourceChatIdSnapshot: sourceChat.id,
              sourceContentHashSnapshot: chunkHash,
              sourceMessageIdsSnapshot: [sourceMessage.id],
              sourceRevisionSnapshot: 1,
              userId
            }
          ]
        });
        return created;
      });

      const clientRefs = createMemoryClientRefService({
        encryptionKey: () => randomBytes(32)
      });
      const beforeSources = await loadMemoryRunSources(prisma, {
        clientRefs,
        runIds: [run.id],
        userId
      });
      const factSource = beforeSources.get(run.id)?.find(({ sourceType }) =>
        sourceType === "LEARNED_MEMORY");
      const historySource = beforeSources.get(run.id)?.find(({ sourceType }) =>
        sourceType === "PAST_CHAT");
      expect(factSource).toMatchObject({
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        sourceAvailable: true
      });
      expect(historySource).toMatchObject({
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        sourceAvailable: true
      });
      if (!factSource?.sourceAvailable || !factSource.memoryRef ||
        !historySource?.sourceAvailable || !historySource.memoryRef) {
        throw new Error("data_002_source_fixture_invalid");
      }
      const factMemoryRef = factSource.memoryRef;
      const historyMemoryRef = historySource.memoryRef;

      await prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: sourceChat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("data_002_source_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["SOURCE_EXCLUDE"],
          patch: { memoryMode: "EXCLUDED" }
        });
      });

      projectId = randomUUID();
      const projectChat = await prisma.$transaction(async (tx) => {
        await tx.project.create({
          data: {
            createdByDisplayName: "DATA-002 owner",
            createdByUserId: userId,
            id: projectId!,
            memoryEnabled: false,
            name: `DATA-002 Project ${suffix}`
          }
        });
        await tx.projectGrant.create({
          data: {
            createdByUserId: userId,
            projectId: projectId!,
            role: "OWNER",
            userId
          }
        });
        const chat = await tx.chat.create({
          data: {
            createdByDisplayName: "DATA-002 owner",
            createdByUserId: userId,
            memoryMode: "EXCLUDED",
            projectId: projectId!,
            title: "Transferred Project copy",
            userId: null
          }
        });
        const message = await tx.message.create({
          data: {
            authorDisplayName: "DATA-002 owner",
            authorProjectRole: "OWNER",
            authorUserId: userId,
            chatId: chat.id,
            content: textMessageContent("I keep project notes in a cedar notebook."),
            role: "user",
            status: "complete"
          }
        });
        return tx.chat.update({
          data: { activeLeafMessageId: message.id },
          where: { id: chat.id }
        });
      });

      // Project chats are separately owned and Memory-disabled. Excluding the
      // Personal source first removes its reusable evidence; the copied Project
      // transcript does not become Personal evidence implicitly.
      expect(projectChat).toMatchObject({ memoryMode: "EXCLUDED", projectId, userId: null });
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId, userId }
      })).resolves.toBe(0);

      const afterRetrieval = await retrieval.retrieve({
        assistantId: null,
        chatId: consumerChat.id,
        now: fixtureNow,
        plan,
        userId
      });
      const afterIds = afterRetrieval.laneResults.flatMap(({ candidates }) =>
        candidates.map(({ itemId }) => itemId));
      expect(afterIds).not.toContain(factVersionId);
      expect(afterIds).not.toContain(chunkId);
      await expect(retrieval.expand(
        beforeRetrieval.snapshot,
        plan,
        acceptedCandidates
      )).resolves.toEqual([]);
      await expect(loadPersonalEligibleFactVersionIds(
        prisma,
        userId,
        [factVersionId]
      )).resolves.toEqual(new Set());

      const afterVector = await vectorRepository.search(vectorInput);
      expect(afterVector).toMatchObject({ hits: [], status: "READY" });
      await expect(embedding.loadTarget(userId, factEntryId)).resolves.toBeNull();
      await expect(embedding.loadTarget(userId, chunkEntryId)).resolves.toBeNull();
      await expect(management.get(userId, factId)).resolves.toBeNull();
      await expect(management.list(userId, { pageSize: 10 })).resolves.toEqual({
        memories: [],
        nextCursor: null
      });
      await expect(loadMemoryRunSources(prisma, {
        clientRefs,
        runIds: [run.id],
        userId
      })).resolves.toEqual(new Map());

      const sourceActions = createMemorySourceActionService({
        authorizationRepository: {
          mint: async () => {
            throw new Error("data_002_authorization_must_not_be_minted");
          }
        },
        client: prisma,
        clientRefs,
        explicitService: {} as never,
        lifecycleService: {} as never
      });
      const factActions: MemorySourceActionInput[] = [
        {
          action: "CORRECT",
          memoryRef: factMemoryRef,
          requestNonce: "data-002-correct",
          statement: "I prefer walnut-colored notebooks."
        },
        {
          action: "FORGET",
          memoryRef: factMemoryRef,
          requestNonce: "data-002-forget"
        },
        {
          action: "NOT_RELEVANT",
          memoryRef: factMemoryRef,
          requestNonce: "data-002-fact-feedback"
        },
        {
          action: "OPEN_SOURCE",
          memoryRef: factMemoryRef,
          requestNonce: "data-002-fact-open"
        }
      ];
      for (const action of factActions) {
        await expect(sourceActions.execute(userId, action)).rejects.toMatchObject({
          code: "memory_not_found"
        });
      }
      for (const action of [
        {
          action: "NOT_RELEVANT",
          memoryRef: historyMemoryRef,
          requestNonce: "data-002-history-feedback"
        },
        {
          action: "OPEN_SOURCE",
          memoryRef: historyMemoryRef,
          requestNonce: "data-002-history-open"
        }
      ] satisfies MemorySourceActionInput[]) {
        await expect(sourceActions.execute(userId, action)).rejects.toMatchObject({
          code: "memory_not_found"
        });
      }
      await expect(prisma.memoryFeedback.count({ where: { userId } })).resolves.toBe(0);

      const afterFenceSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const lexicalGeneration = await prisma.memoryIndexGeneration.create({
        data: {
          chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
          generation: 1,
          indexMode: "LEXICAL_ONLY",
          indexedThroughMemoryRevision: afterFenceSettings.memoryRevision,
          languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          readyAt: fixtureNow,
          retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
          state: "READY",
          targetMemoryRevision: afterFenceSettings.memoryRevision,
          userId
        }
      });
      await prisma.$transaction(async (tx) => {
        await tx.memoryIndexGeneration.update({
          data: { state: "SUPERSEDED", supersededAt: fixtureNow },
          where: { id: generation.id }
        });
        await tx.userMemorySettings.update({
          data: { activeIndexGenerationId: lexicalGeneration.id },
          where: { userId }
        });
        await tx.memoryIndexGeneration.update({
          data: { activatedAt: fixtureNow, state: "ACTIVE" },
          where: { id: lexicalGeneration.id }
        });
      });
      const rebuildSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rebuild = createPrismaMemoryRebuildRepository(prisma);
      const admitted = await rebuild.admit(userId, {
        expectedMemoryRevision: rebuildSettings.memoryRevision,
        expectedSettingsRevision: rebuildSettings.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { case: "data-002-project-dormancy" }
      });
      expect(admitted.kind).toBe("ok");
      if (admitted.kind !== "ok") throw new Error(`data_002_rebuild_${admitted.kind}`);
      const job = await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId }
      });
      const targetGeneration = await prisma.memoryIndexGeneration.findFirstOrThrow({
        where: {
          sourceIndexGenerationId: lexicalGeneration.id,
          state: "BUILDING",
          userId
        }
      });
      const claim: MemoryJobClaim = {
        activeLeafMessageId: job.activeLeafMessageId,
        attemptCount: job.attemptCount,
        branchGeneration: job.branchGeneration,
        chatId: job.chatId,
        claimToken: "data-002-claim",
        id: job.id,
        idempotencyFingerprint: job.idempotencyFingerprint,
        kind: job.kind,
        leaseExpiresAt: new Date(fixtureNow.getTime() + 60_000),
        memoryGenerationSnapshot: job.memoryGenerationSnapshot,
        memoryRevisionSnapshot: job.memoryRevisionSnapshot,
        pipelineVersion: job.pipelineVersion,
        recoveredLease: false,
        sourceHash: job.sourceHash,
        sourceMessageId: job.sourceMessageId,
        sourceRevision: job.sourceRevision,
        stage: job.stage,
        userId
      };
      await prisma.$transaction((tx) => rebuild.applyJob(tx, claim, fixtureNow));
      await expect(prisma.memorySearchEntry.count({
        where: { indexGenerationId: targetGeneration.id, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: targetGeneration.id }
      })).resolves.toMatchObject({ state: "ACTIVE" });

      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: factId }
      })).resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: factVersionId }
      })).resolves.toMatchObject({
        displayText: factStatement,
        sourceMode: "AUTOMATIC",
        state: "RETRACTED"
      });
      expect(binding.modelRunId).toBe(run.id);
    } finally {
      if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }, 120_000);
});
