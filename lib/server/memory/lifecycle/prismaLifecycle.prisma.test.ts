import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION
} from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import type { NormalizedRunRequest } from "../../providers/types";
import { createPrismaRunRepository } from "../../runs/prismaRepository";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryDeletionClaim } from "../coordinator/types";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import {
  createExplicitMemoryService,
  ExplicitMemoryServiceError
} from "../explicit/service";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactValueInput
} from "../persistence/facts";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import {
  MEMORY_PURGE_REQUIRED_CONTRIBUTORS
} from "../purge/contract";
import { registerMemoryDeletionContributors } from "../purge/leaves";
import { auditMemoryDeletion } from "../purge/reconciliation";
import {
  type MemoryDeletionContributor,
  MemoryDeletionContributorRegistry
} from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  createPrismaMemoryFeedbackRepository,
  memoryFeedbackIdempotencyFingerprint
} from "../review/feedbackRepository";
import { createMemoryReviewService } from "../review/service";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_POLICY_VERSION,
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { createPrismaMemoryLifecycleRepository } from "./repository";
import {
  createMemoryLifecycleService,
  MemoryLifecycleServiceError
} from "./service";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 81));
const keyring = MemorySuppressionKeyring.parse(
  `current=lifecycle-v1,lifecycle-v1=${keyBytes.toString("base64")}`
);

function purgeRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return registry;
}

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Memory lifecycle ${label}`,
      email: `memory-lifecycle-${label}-${id}@example.test`,
      id,
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
  return id;
}

async function cleanupUsers(userIds: readonly string[]): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({
    where: { userId: { in: [...userIds] } }
  });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
}

async function classifyFactVersion(userId: string, versionId: string): Promise<void> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    select: { memoryGeneration: true, memoryRevision: true },
    where: { userId }
  });
  const jobId = randomUUID();
  const bindingId = randomUUID();
  const startedAt = new Date();
  const completedAt = new Date(startedAt.getTime() + 1);
  await prisma.$transaction(async (tx) => {
    await tx.memoryJob.create({
      data: {
        acceptedResultHash: memorySha256({ result: "classified", versionId }),
        completedAt,
        id: jobId,
        idempotencyFingerprint: memorySha256({
          job: "lifecycle-classification",
          versionId
        }),
        kind: "RECLASSIFY_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: "memory-lifecycle-classification-fixture-v1",
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memorySha256({ decision: "NORMAL", versionId }),
        completedAt,
        createdAt: startedAt,
        destinationFingerprint: memorySha256({
          destination: "lifecycle-classifier",
          versionId
        }),
        id: bindingId,
        inputHash: memorySha256({ input: "lifecycle-classifier", versionId }),
        logicalRole: "MEMORY_RECLASSIFY",
        memoryJobId: jobId,
        ordinal: 0,
        ownerType: "JOB",
        pipelineVersion: "memory-lifecycle-classification-fixture-v1",
        policyVersion: "memory-lifecycle-classification-policy-v1",
        promptVersion: "memory-lifecycle-classification-prompt-v1",
        providerId: "memory-lifecycle-fixture",
        recoverableUntil: completedAt,
        relationsDetachedAt: completedAt,
        schemaVersion: "memory-lifecycle-classification-schema-v1",
        secretFreeExecutionSnapshot: {
          providerExecutionSnapshot: {
            providerFamily: "memory-lifecycle-fixture",
            providerModelId: "memory-lifecycle-classifier-v1"
          },
          version: 1
        },
        startedAt,
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.memoryFactVersion.update({
      data: {
        safetyClassificationReasonCode: "other_durable",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifiedAt: completedAt,
        safetyClassifierExecutionId: bindingId,
        safetyClassifierModelId: "memory-lifecycle-classifier-v1",
        safetyClassifierPolicyVersion: "memory-lifecycle-classification-policy-v1",
        safetyClassifierProviderId: "memory-lifecycle-fixture"
      },
      where: { id: versionId }
    });
  });
}

function services(
  registry: MemoryDeletionContributorRegistry,
  clock?: () => Date
) {
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const explicit = createExplicitMemoryService({
    authorizationRepository,
    ...(clock ? { clock } : {}),
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository,
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
  });
  const lifecycle = createMemoryLifecycleService({
    authorizationRepository,
    ...(clock ? { clock } : {}),
    mutationRepository: createPrismaMemoryLifecycleRepository(
      keyring,
      registry,
      prisma
    ),
    readRepository
  });
  return { explicit, lifecycle };
}

async function saveExplicit(
  explicit: ReturnType<typeof services>["explicit"],
  userId: string,
  statement: string,
  nonce: string
) {
  const authorization = await explicit.mintAuthorization(userId, {
    action: "SAVE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement),
    requestNonce: nonce
  });
  const input = {
    mutationAuthorizationId: authorization.mutationAuthorizationId,
    scope: { type: "GLOBAL_USER" },
    statement
  } as const;
  try {
    return await explicit.create(userId, input);
  } catch (error) {
    if (
      !(error instanceof ExplicitMemoryServiceError) ||
      error.code !== "memory_not_found"
    ) {
      throw error;
    }
  }
  const authorizationRow = await prisma.memoryMutationAuthorization.findUniqueOrThrow({
    select: { requestId: true },
    where: { id: authorization.mutationAuthorizationId }
  });
  const receipt = await prisma.memoryOperationReceipt.findFirstOrThrow({
    select: { targetVersionId: true },
    where: {
      operation: "SAVE",
      requestId: authorizationRow.requestId,
      userId
    }
  });
  if (!receipt.targetVersionId) {
    throw new Error("memory_lifecycle_classification_target_missing");
  }
  await classifyFactVersion(userId, receipt.targetVersionId);
  return explicit.create(userId, input);
}

function normalizedRequest(
  chatId: string,
  content = "Use my saved preference."
): NormalizedRunRequest {
  return {
    attachmentIds: [],
    chatId,
    content: textMessageContent(content),
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

async function createUnacceptedAttemptItem(input: Readonly<{
  factVersionId: string;
  requestContent?: string;
  statement: string;
  userId: string;
}>): Promise<Readonly<{
  attemptId: string;
  assistantMessageId: string;
  chatId: string;
  messageId: string;
  runId: string;
}>> {
  const chat = await prisma.chat.create({
    data: {
      defaultProviderModelId: providerTemplateIds.fakeModel,
      title: "Memory purge fixture",
      userId: input.userId
    }
  });
  const request = normalizedRequest(chat.id, input.requestContent);
  const admitted = await createPrismaRunRepository(prisma).admitPreparingRun({
    admissionKind: "NORMAL_SEND",
    chatId: chat.id,
    content: request.content,
    expectedActiveLeafId: null,
    modelId: request.modelId,
    normalizedRequest: request,
    provider: request.provider,
    providerRequestPreview: { request: "base" },
    userId: input.userId
  });
  await prisma.memoryRetrievalAttempt.update({
    data: {
      preparedContextHash: memorySha256(input.statement),
      preparedContextText: `Remembered context: ${input.statement}`,
      preparedContextTokenCount: 8
    },
    where: { id: admitted.attemptId }
  });
  await prisma.memoryRetrievalAttemptItem.create({
    data: {
      attemptId: admitted.attemptId,
      exactItemId: input.factVersionId,
      exactSafeText: input.statement,
      factVersionId: input.factVersionId,
      featureSnapshot: {},
      itemType: "FACT_VERSION",
      laneRanks: {},
      ordinal: 0,
      selectionReason: "memory-lifecycle-purge-test",
      sourceSnapshot: {},
      textHash: memorySha256(input.statement),
      userId: input.userId,
      versionSnapshot: {}
    }
  });
  return {
    attemptId: admitted.attemptId,
    assistantMessageId: admitted.assistantMessageId,
    chatId: chat.id,
    messageId: admitted.userMessageId,
    runId: admitted.runId
  };
}

async function createFactCandidateFixture(input: Readonly<{
  activeLeafMessageId: string;
  canonicalKey: string;
  chatId: string;
  displayText: string;
  messageId: string;
  userId: string;
}>): Promise<string> {
  const jobId = randomUUID();
  const bindingId = randomUUID();
  const candidateId = memorySha256({
    canonicalKey: input.canonicalKey,
    chatId: input.chatId,
    messageId: input.messageId,
    nonce: randomUUID(),
    userId: input.userId
  });
  const sourceHash = memorySha256({
    activeLeafMessageId: input.activeLeafMessageId,
    chatId: input.chatId,
    userId: input.userId
  });
  const now = new Date();
  const createdAt = new Date(now.getTime() - 1_000);
  const recoverableUntil = now;
  const acceptedOutputHash = memorySha256({ candidateId, output: "accepted" });
  const inputHash = memorySha256({ candidateId, input: "test" });
  const extractionExecutionId = memorySha256({
    bindingId,
    domain: "aiqsa.memory.fact-extraction-execution",
    jobId,
    userId: input.userId,
    version: 1
  });
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId: input.userId }
  });
  const [authority] = await prisma.$queryRaw<Array<{
    connectionId: string;
    credentialId: string;
    credentialVersionId: string;
    providerModelId: string;
  }>>(Prisma.sql`
    SELECT model."id" AS "providerModelId",
      connection."id" AS "connectionId",
      credential."id" AS "credentialId",
      credential."activeVersionId" AS "credentialVersionId"
    FROM "ProviderModel" AS model
    INNER JOIN "ProviderConnection" AS connection
      ON connection."id" = model."connectionId"
    INNER JOIN "ProviderCredential" AS credential
      ON credential."connectionId" = connection."id"
      AND credential."id" = connection."defaultCredentialId"
    WHERE credential."activeVersionId" IS NOT NULL
    ORDER BY model."id"
    LIMIT 1
  `);
  if (!authority) throw new Error("memory_test_execution_authority_missing");
  await prisma.$transaction(async (tx) => {
    await tx.memoryJob.create({
      data: {
        acceptedResultHash: acceptedOutputHash,
        activeLeafMessageId: input.activeLeafMessageId,
        branchGeneration: 0,
        chatId: input.chatId,
        completedAt: now,
        id: jobId,
        idempotencyFingerprint: memorySha256({ candidateId, job: "extract" }),
        kind: "EXTRACT_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        sourceHash,
        sourceMessageId: input.messageId,
        sourceRevision: 0,
        state: "SUCCEEDED",
        userId: input.userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        connectionId: authority.connectionId,
        createdAt,
        credentialId: authority.credentialId,
        credentialVersionId: authority.credentialVersionId,
        destinationFingerprint: memorySha256({ candidateId, destination: "test" }),
        id: bindingId,
        inputHash,
        logicalRole: "MEMORY_FACT_EXTRACT",
        memoryJobId: jobId,
        ordinal: 0,
        ownerType: "JOB",
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
        promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
        providerId: "openai_compatible",
        providerModelId: authority.providerModelId,
        recoverableUntil,
        schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
        secretFreeExecutionSnapshot: {},
        startedAt: createdAt,
        state: "RUNNING",
        userId: input.userId
      }
    });
    await tx.memoryFactExtractionExecution.create({
      data: {
        acceptedOutput: {
          candidateOrdinals: [0],
          candidates: [{ fixture: "lifecycle-candidate" }],
          rejections: []
        },
        acceptedOutputHash,
        contextBindings: [],
        createdAt,
        executionBindingId: bindingId,
        id: extractionExecutionId,
        inputHash,
        memoryJobId: jobId,
        recoverableUntil,
        sourceMessageContentHash: memorySha256(input.displayText),
        sourceMessageId: input.messageId,
        userId: input.userId
      }
    });
    await tx.memoryExecutionBinding.update({
      data: {
        acceptedOutputHash,
        completedAt: now,
        connectionId: null,
        credentialId: null,
        credentialVersionId: null,
        providerModelId: null,
        relationsDetachedAt: now,
        state: "SUCCEEDED"
      },
      where: { id: bindingId }
    });
    await tx.memoryFactExtractionExecution.update({
      data: {
        acceptedOutput: Prisma.DbNull,
        appliedAt: now,
        contextBindings: Prisma.DbNull
      },
      where: { id: extractionExecutionId }
    });
    await tx.memoryCandidate.create({
      data: {
        branchGeneration: 0,
        chatId: input.chatId,
        confidence: 0.9,
        createdByExecutionId: bindingId,
        id: candidateId,
        importance: 0.5,
        jobId,
        languageCode: "en",
        negated: false,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        proposedCanonicalKey: input.canonicalKey,
        proposedCategory: "preference",
        proposedCoreEligible: false,
        proposedCoreSalience: "NONE",
        proposedDirectness: "DIRECT",
        proposedDisplayText: input.displayText,
        proposedModality: "PREFERENCE",
        proposedScope: { target_id: null, type: "GLOBAL_USER" },
        proposedSensitivity: "NORMAL",
        proposedValue: { text: input.displayText },
        sourceHash,
        sourceProjectionHash: memorySha256({ candidateId, projection: "safe" }),
        sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
        sourceRevision: 0,
        sourceTimezone: "UTC",
        state: "PENDING",
        userId: input.userId
      }
    });
    await tx.memoryCandidateMessage.create({
      data: {
        candidateId,
        chatId: input.chatId,
        endOffset: input.displayText.length,
        messageId: input.messageId,
        ordinal: 0,
        sourceTextHash: memorySha256(input.displayText),
        startOffset: 0,
        userId: input.userId
      }
    });
  });
  return candidateId;
}

type AcceptedReceiptDerivatives = Readonly<{
  attemptId: string;
  attemptItemId: string;
  bindingId: string;
  egressReceiptId: string;
  historyRunId: string;
  marker: string;
  memoryItemId: string;
  toolCallId: string;
}>;

async function createAcceptedReceiptDerivatives(input: Readonly<{
  assistantMessageId: string;
  attemptId: string;
  chatId: string;
  factVersionId: string;
  modelRunId: string;
  sourceMessageId: string;
  statement: string;
  userId: string;
}>): Promise<AcceptedReceiptDerivatives> {
  const now = new Date("2026-08-10T14:01:00.000Z");
  const marker = input.statement;
  const preparedContext = `Accepted memory: ${marker}`;
  let attemptItem = await prisma.memoryRetrievalAttemptItem.findFirst({
    where: {
      attemptId: input.attemptId,
      factVersionId: input.factVersionId,
      userId: input.userId
    }
  });
  attemptItem ??= await prisma.memoryRetrievalAttemptItem.create({
    data: {
      attemptId: input.attemptId,
      exactItemId: input.factVersionId,
      exactSafeText: marker,
      factVersionId: input.factVersionId,
      featureSnapshot: {},
      itemType: "FACT_VERSION",
      laneRanks: {},
      ordinal: 0,
      selectionReason: "memory-lifecycle-accepted-receipt-test",
      sourceBranchGenerationSnapshot: 0,
      sourceChatIdSnapshot: input.chatId,
      sourceContentHashSnapshot: memorySha256(marker),
      sourceRevisionSnapshot: 0,
      sourceSnapshot: {},
      textHash: memorySha256(marker),
      userId: input.userId,
      versionSnapshot: {}
    }
  });
  const { attempt, binding } = await prisma.$transaction(async (tx) => {
    const attempt = await tx.memoryRetrievalAttempt.update({
      data: {
        boundedSafeQuerySnapshot: marker,
        consumedAt: now,
        outcome: "USED",
        preparedContextHash: memorySha256(preparedContext),
        preparedContextText: preparedContext,
        preparedContextTokenCount: 8,
        state: "CONSUMED"
      },
      where: { id: input.attemptId }
    });
    await tx.modelRun.update({
      data: {
        normalizedRequest: { request: "accepted" },
        status: "complete"
      },
      where: { id: input.modelRunId }
    });
    const binding = await tx.modelRunMemoryBinding.create({
      data: {
        boundedSafeQuerySnapshot: marker,
        contextTextHash: memorySha256(preparedContext),
        contextTokenCount: 8,
        finalizedAt: now,
        finalizedRevisionSnapshot: attempt.retrievalRevisionSnapshot,
        indexGenerationId: attempt.indexGenerationIdSnapshot,
        memoryGenerationSnapshot: attempt.memoryGenerationSnapshot,
        modelRunId: input.modelRunId,
        outcome: "USED",
        queryHash: memorySha256(marker),
        queryPlannerVersion: "memory-lifecycle-receipt-test-v1",
        retrievalAttemptId: input.attemptId,
        retrievalPipelineVersion: "memory-lifecycle-receipt-test-v1",
        retrievalRevisionSnapshot: attempt.retrievalRevisionSnapshot,
        settingsSnapshot: {},
        userId: input.userId
      }
    });
    return { attempt, binding };
  });
  const memoryItem = await prisma.modelRunMemoryItem.create({
    data: {
      bindingId: binding.id,
      exactItemId: input.factVersionId,
      factVersionId: input.factVersionId,
      featureSnapshot: {},
      finalScore: 0.9,
      includedText: marker,
      includedTextHash: memorySha256(marker),
      itemStateAtAdmission: "ACTIVE",
      itemType: "FACT_VERSION",
      laneRanks: {},
      ordinal: 0,
      selectionReason: "memory-lifecycle-accepted-receipt-test",
      sourceBranchGenerationSnapshot: 0,
      sourceChatIdSnapshot: input.chatId,
      sourceContentHashSnapshot: memorySha256(marker),
      sourceMessageIdsSnapshot: [input.sourceMessageId],
      sourceRevisionSnapshot: 0,
      userId: input.userId
    }
  });
  const toolCall = await prisma.modelRunToolCall.create({
    data: {
      arguments: { query: marker },
      completedAt: now,
      modelRunId: input.modelRunId,
      ordinal: 0,
      providerCallId: `memory-lifecycle-history-${randomUUID()}`,
      result: {
        callId: "memory-lifecycle-history",
        content: [{ type: "json", value: { marker } }],
        name: "search_my_history",
        status: "complete"
      },
      roundIndex: 0,
      startedAt: now,
      state: "complete",
      toolName: "search_my_history"
    }
  });
  const destinationSnapshot = {
    fingerprint: "memory-lifecycle-answer-provider",
    kind: "answer_provider" as const,
    version: 1 as const
  };
  const egressReceipt = await prisma.memoryToolEgressReceipt.create({
    data: {
      destinationFingerprint: memorySha256(destinationSnapshot),
      destinationKind: "answer_provider",
      destinationSnapshot,
      dispatchCompletedAt: now,
      dispatchStartedAt: now,
      dispatchState: "COMPLETED",
      mode: "PROVIDER_REQUEST",
      modelRunId: input.modelRunId,
      requestOrdinal: 1,
      requestEvidenceHash: memorySha256({ marker, type: "provider-request" }),
      userId: input.userId
    }
  });
  const privateResults = {
    indexing: {
      degradationCode: null,
      lexicalState: "READY",
      vectorState: "NOT_CONFIGURED"
    },
    nextCursor: null,
    results: [{
      indexingState: "LEXICAL_READY",
      itemType: "RECALL_CHUNK",
      occurredAt: now.toISOString(),
      sourceChatId: input.chatId,
      sourceChatTitle: "Memory lifecycle receipt source",
      sourceFolderId: null,
      sourceFolderName: null,
      sourceMessageIds: [input.sourceMessageId],
      sourceState: "AVAILABLE",
      snippet: marker
    }]
  };
  const providerResult = {
    callId: toolCall.providerCallId,
    content: [{ type: "json", value: { ...privateResults, untrusted: true } }],
    name: "search_my_history",
    status: "complete"
  };
  const historyRun = await prisma.memoryHistoryRun.create({
    data: {
      completedAt: now,
      durationMs: 1,
      indexingEvidence: privateResults.indexing,
      invocationOrdinal: 1,
      modelRunId: input.modelRunId,
      modelRunToolCallId: toolCall.id,
      outcome: "RESULTS",
      privateRequest: { query: marker },
      providerResult,
      query: marker,
      queryHash: memorySha256(marker),
      resultCount: 1,
      resultHash: memorySha256(providerResult),
      results: privateResults,
      state: "COMPLETE",
      userId: input.userId
    }
  });
  return {
    attemptId: attempt.id,
    attemptItemId: attemptItem.id,
    bindingId: binding.id,
    egressReceiptId: egressReceipt.id,
    historyRunId: historyRun.id,
    marker,
    memoryItemId: memoryItem.id,
    toolCallId: toolCall.id
  };
}

async function expectAcceptedReceiptDerivatives(
  receipt: AcceptedReceiptDerivatives,
  historyState: "RETAINED" | "SCRUBBED",
  attemptItemState: "PRESENT" | "PURGED" = "PRESENT"
): Promise<void> {
  const history = await prisma.memoryHistoryRun.findUniqueOrThrow({
    where: { id: receipt.historyRunId }
  });
  const toolCall = await prisma.modelRunToolCall.findUniqueOrThrow({
    where: { id: receipt.toolCallId }
  });
  if (historyState === "SCRUBBED") {
    expect(history).toMatchObject({
      plaintextPurgedAt: expect.any(Date),
      privateRequest: {},
      providerResult: null,
      query: null,
      resultHash: null,
      results: null,
      retentionState: "SCRUBBED"
    });
    expect(JSON.stringify(history)).not.toContain(receipt.marker);
    expect(toolCall.arguments).toEqual({});
    expect(toolCall.result).toMatchObject({
      content: [{ value: { error: "memory_history_receipt_scrubbed" } }],
      status: "error"
    });
    expect(JSON.stringify(toolCall)).not.toContain(receipt.marker);
  } else {
    expect(history).toMatchObject({
      plaintextPurgedAt: null,
      retentionState: "RETAINED",
      state: "COMPLETE"
    });
    expect(JSON.stringify(history)).toContain(receipt.marker);
    expect(toolCall).toMatchObject({ state: "complete" });
    expect(JSON.stringify(toolCall)).toContain(receipt.marker);
  }
  await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
    where: { id: receipt.attemptId }
  })).resolves.toMatchObject({ outcome: "USED", state: "CONSUMED" });
  if (attemptItemState === "PURGED") {
    await expect(prisma.memoryRetrievalAttemptItem.findUnique({
      where: { id: receipt.attemptItemId }
    })).resolves.toBeNull();
  } else {
    await expect(prisma.memoryRetrievalAttemptItem.findUniqueOrThrow({
      where: { id: receipt.attemptItemId }
    })).resolves.toMatchObject({ exactSafeText: receipt.marker });
  }
  await expect(prisma.modelRunMemoryBinding.findUniqueOrThrow({
    where: { id: receipt.bindingId }
  })).resolves.toMatchObject({ outcome: "USED" });
  await expect(prisma.modelRunMemoryItem.findUniqueOrThrow({
    where: { id: receipt.memoryItemId }
  })).resolves.toMatchObject({ includedText: receipt.marker });
  await expect(prisma.memoryToolEgressReceipt.findUniqueOrThrow({
    where: { id: receipt.egressReceiptId }
  })).resolves.toMatchObject({
    dispatchState: "COMPLETED",
    errorCode: null,
    mode: "PROVIDER_REQUEST"
  });
}

async function claimDeletion(
  userId: string,
  deletionId: string,
  now: Date
): Promise<MemoryDeletionClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const claimed = await prisma.memoryDeletionOutbox.updateMany({
    data: {
      attemptCount: { increment: 1 },
      errorCode: null,
      leaseExpiresAt,
      leaseToken: claimToken,
      nextAttemptAt: null,
      state: "RUNNING",
      updatedAt: now
    },
    where: {
      id: deletionId,
      state: { in: ["BLOCKED_REQUIRES_ADMIN", "PENDING", "RETRY_WAIT"] },
      userId
    }
  });
  expect(claimed.count).toBe(1);
  const row = await prisma.memoryDeletionOutbox.findUniqueOrThrow({
    where: { id: deletionId }
  });
  return {
    admissionAuthorizationId: row.admissionAuthorizationId,
    admittedActiveLeafMessageId: row.admittedActiveLeafMessageId,
    admittedChatSourceRevision: row.admittedChatSourceRevision,
    alsoForgetOriginMemories: row.alsoForgetOriginMemories,
    attemptCount: row.attemptCount,
    claimToken,
    id: deletionId,
    leaseExpiresAt,
    memoryGeneration: row.memoryGeneration,
    operation: row.operation,
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: row.targetId,
    targetType: row.targetType,
    userId
  };
}

async function commitDeletion(
  registry: MemoryDeletionContributorRegistry,
  userId: string,
  deletionId: string,
  now: Date
): Promise<void> {
  const claim = await claimDeletion(userId, deletionId, now);
  const execution = await registry.handler().execute(claim, {
    now: () => now,
    signal: new AbortController().signal
  });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitDeletionSuccess({
    apply: execution.apply,
    claim,
    now
  })).resolves.toBe(true);
}

function automaticValue(
  canonicalKey: string,
  statement: string
): MemoryFactValueInput {
  return {
    canonicalKey,
    category: "preference",
    confidence: 0.9,
    directness: "DIRECT",
    displayText: statement,
    importance: 0.8,
    languageCode: "en",
    modality: "PREFERENCE",
    pipelineVersion: "memory-lifecycle-test-v1",
    secretTaintedSourceWindow: false,
    sensitivityClass: "NORMAL",
    sourceMode: "AUTOMATIC",
    structuredValue: { statement }
  };
}

async function makeConflictedFact(
  userId: string,
  factId: string,
  firstVersionId: string
): Promise<readonly [string, string]> {
  const secondVersionId = randomUUID();
  const eventId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    const first = await tx.memoryFactVersion.findFirstOrThrow({
      where: { factId, id: firstVersionId, userId }
    });
    await tx.memoryEvent.create({
      data: {
        actorType: "SYSTEM",
        factId,
        factVersionId: secondVersionId,
        id: eventId,
        metadata: { schemaVersion: "memory-conflict-forget-test-v1" },
        operation: "CONFLICT",
        userId
      }
    });
    await tx.memoryFactVersion.update({
      data: { state: "CONFLICTING" },
      where: { id: firstVersionId }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: first.category,
        confidence: first.confidence,
        createdByEventId: eventId,
        directness: first.directness,
        displayText: "I prefer long technical explanations.",
        factId,
        id: secondVersionId,
        importance: first.importance,
        languageCode: first.languageCode,
        modality: first.modality,
        normalizedSearchText: "i prefer long technical explanations",
        pipelineVersion: "memory-conflict-forget-test-v1",
        rawTemporalExpression: first.rawTemporalExpression,
        sensitivityClass: first.sensitivityClass,
        sourceMode: "EXPLICIT",
        sourceTimezone: first.sourceTimezone,
        state: "CONFLICTING",
        structuredValue: first.structuredValue as Prisma.InputJsonValue,
        systemFrom: new Date(first.systemFrom.getTime() + 1),
        temporalResolverVersion: first.temporalResolverVersion,
        ...(first.temporalResolutionEvidence === null
          ? {}
          : {
              temporalResolutionEvidence:
                first.temporalResolutionEvidence as Prisma.InputJsonValue
            }),
        userId,
        validFrom: first.validFrom,
        validTo: first.validTo
      }
    });
    await tx.memoryFact.update({
      data: { currentVersionId: null, state: "CONFLICTED" },
      where: { id: factId }
    });
    await tx.memorySearchEntry.deleteMany({
      where: { factVersionId: firstVersionId, userId }
    });
  });
  await classifyFactVersion(userId, secondVersionId);
  return [firstVersionId, secondVersionId];
}

function upgradedRegistry(): MemoryDeletionContributorRegistry {
  const lateContributor: MemoryDeletionContributor = Object.freeze({
    async audit(tx, target) {
      if (target.kind !== "MEMORY_FACT") return 0;
      const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS "count"
        FROM "MemoryEvent"
        WHERE "userId" = ${target.userId}
          AND "factId" = ${target.targetId}
          AND "operation" = 'FORGET'::"MemoryEventOperation"
          AND COALESCE("metadata" ->> 'lateContributorApplied', 'false') <> 'true'
      `);
      return rows[0]?.count ?? 0;
    },
    id: "late-derived",
    async purge(tx, target) {
      if (target.kind !== "MEMORY_FACT") return;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MemoryEvent"
        SET "metadata" = "metadata" || ${JSON.stringify({
          lateContributorApplied: true
        })}::jsonb
        WHERE "userId" = ${target.userId}
          AND "factId" = ${target.targetId}
          AND "operation" = 'FORGET'::"MemoryEventOperation"
      `);
    },
    version: "v2"
  });
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: [
      ...MEMORY_PURGE_REQUIRED_CONTRIBUTORS,
      { id: lateContributor.id, version: lateContributor.version }
    ]
  });
  registerMemoryDeletionContributors(registry);
  registry.register(lateContributor);
  return registry;
}

describe("Prisma Memory Forget and purge lifecycle", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("fences synchronously, purges durably, blocks rebuilding, and replays upgraded obligations", async () => {
    const registry = purgeRegistry();
    const ownerUserId = await createActiveUser("forget-owner");
    const foreignUserId = await createActiveUser("forget-foreign");
    const { explicit, lifecycle } = services(registry);
    const statement = "I prefer quiet hotels near a railway station.";
    try {
      const created = await saveExplicit(
        explicit,
        ownerUserId,
        statement,
        "forget-save"
      );
      const factId = created.memory.id;
      const versionId = created.memory.currentVersionId!;
      const feedback = await createMemoryReviewService(
        createPrismaMemoryFeedbackRepository(prisma)
      ).feedback(ownerUserId, factId, {
        comment: "This fact should be removed with its private feedback.",
        expectedVersionId: versionId,
        feedbackType: "NOT_USEFUL",
        requestId: randomUUID()
      });
      const attempt = await createUnacceptedAttemptItem({
        factVersionId: versionId,
        statement,
        userId: ownerUserId
      });
      const canonicalKey = await prisma.memoryFact.findUniqueOrThrow({
        select: { canonicalKey: true },
        where: { id: factId }
      });
      const candidateId = await createFactCandidateFixture({
        activeLeafMessageId: attempt.assistantMessageId,
        canonicalKey: canonicalKey.canonicalKey,
        chatId: attempt.chatId,
        displayText: statement,
        messageId: attempt.messageId,
        userId: ownerUserId
      });
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: ownerUserId }
      });
      const authorization = await explicit.mintAuthorization(ownerUserId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId,
        requestNonce: "forget-authorize",
        targetFactId: factId
      });
      const forgetInput = {
        expectedVersionId: versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      };

      const forgotten = await lifecycle.forget(ownerUserId, factId, forgetInput);
      expect(forgotten.memory).toMatchObject({
        currentVersionId: null,
        displayText: null,
        factState: "FORGOTTEN",
        id: factId,
        pinned: false,
        versionState: "FORGOTTEN"
      });
      const fencedDetail = await explicit.get(ownerUserId, factId);
      expect(fencedDetail.feedback).toEqual([]);
      expect(fencedDetail.versions.every(({ displayText }) => displayText === null)).toBe(true);
      await expect(explicit.evidence(ownerUserId, factId, null)).resolves.toEqual({
        evidence: [],
        nextCursor: null
      });
      const claimedDeletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "FORGET_PURGE", userId: ownerUserId }
      });
      const failedAt = new Date(Date.parse(forgotten.undo.expiresAt) + 1_000);
      const failedClaim = await claimDeletion(
        ownerUserId,
        claimedDeletion.id,
        failedAt
      );
      await expect(lifecycle.forget(ownerUserId, factId, forgetInput)).resolves
        .toEqual(forgotten);

      const [settings, fact, version, event, deletion, authorizationRow] =
        await Promise.all([
          prisma.userMemorySettings.findUniqueOrThrow({
            where: { userId: ownerUserId }
          }),
          prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }),
          prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: versionId } }),
          prisma.memoryEvent.findFirstOrThrow({
            where: { factId, operation: "FORGET", userId: ownerUserId }
          }),
          prisma.memoryDeletionOutbox.findFirstOrThrow({
            where: { operation: "FORGET_PURGE", userId: ownerUserId }
          }),
          prisma.memoryMutationAuthorization.findUniqueOrThrow({
            where: { id: authorization.mutationAuthorizationId }
          })
        ]);
      expect(settings).toMatchObject({
        memoryGeneration: before.memoryGeneration + 1,
        memoryRevision: before.memoryRevision + 1,
        settingsRevision: before.settingsRevision
      });
      expect(fact).toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
      expect(version).toMatchObject({
        contentPurgedAt: null,
        displayText: statement,
        state: "FORGOTTEN"
      });
      expect(JSON.stringify(event.metadata)).not.toContain(statement);
      expect(event).toMatchObject({ actorType: "USER", actorUserId: ownerUserId });
      expect(authorizationRow.consumedAt).toEqual(expect.any(Date));
      await expect(prisma.memorySearchEntry.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(0);
      await expect(prisma.memorySuppression.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryOperationReceipt.count({
        where: { operation: "FORGET", userId: ownerUserId }
      })).resolves.toBe(1);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: attempt.attemptId, userId: ownerUserId }
      })).resolves.toBe(1);
      await expect(lifecycle.status(foreignUserId, deletion.id)).rejects.toEqual(
        new MemoryLifecycleServiceError("memory_not_found")
      );

      const pending = await auditMemoryDeletion(
        registry,
        deletion.id,
        ownerUserId,
        prisma
      );
      expect(pending).toMatchObject({
        lastAuditAt: expect.any(Date),
        progress: { completedUnits: 5, totalUnits: 10 },
        state: "RUNNING",
      });

      const failureRegistry = new MemoryDeletionContributorRegistry({
        operation: "FORGET_PURGE",
        requirements: [
          ...MEMORY_PURGE_REQUIRED_CONTRIBUTORS,
          { id: "failure-fixture", version: "v1" }
        ]
      });
      registerMemoryDeletionContributors(failureRegistry);
      failureRegistry.register({
        audit: async () => 0,
        id: "failure-fixture",
        purge: async () => {
          throw new Error("memory_purge_failure_fixture");
        },
        version: "v1"
      });
      const failedExecution = await failureRegistry.handler().execute(failedClaim, {
        now: () => failedAt,
        signal: new AbortController().signal
      });
      await expect(createPrismaMemoryCoordinatorRepository(prisma)
        .commitDeletionSuccess({
          apply: failedExecution.apply,
          claim: failedClaim,
          now: failedAt
        })).rejects.toThrow("memory_purge_failure_fixture");
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })).resolves.toMatchObject({ contentPurgedAt: null, displayText: statement });
      await expect(prisma.memoryEvidence.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: attempt.attemptId, userId: ownerUserId }
      })).resolves.toBe(1);
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: candidateId }
      })).resolves.toMatchObject({
        contentPurgedAt: null,
        proposedDisplayText: statement,
        state: "PENDING"
      });
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: feedback.feedbackId }
      })).resolves.toMatchObject({
        comment: "This fact should be removed with its private feedback.",
        contentPurgedAt: null,
        memoryFactId: factId,
        memoryFactVersionId: versionId
      });
      await expect(createPrismaMemoryCoordinatorRepository(prisma).retryDeletion({
        blocked: false,
        claim: failedClaim,
        errorCode: "memory_purge_failure_fixture",
        nextAttemptAt: new Date("2026-08-10T11:59:00.000Z"),
        now: failedAt
      })).resolves.toBe(true);
      await commitDeletion(
        registry,
        ownerUserId,
        deletion.id,
        new Date("2026-08-10T12:00:00.000Z")
      );
      const succeeded = await auditMemoryDeletion(
        registry,
        deletion.id,
        ownerUserId,
        prisma,
        new Date("2026-08-10T12:00:01.000Z")
      );
      expect(succeeded).toMatchObject({
        progress: { completedUnits: 10, totalUnits: 10 },
        state: "SUCCEEDED",
      });

      const [purgedVersion, purgedAttempt, settledRun, settledMessage] = await Promise.all([
        prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: versionId } }),
        prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: attempt.attemptId }
        }),
        prisma.modelRun.findUniqueOrThrow({ where: { id: attempt.runId } }),
        prisma.message.findUniqueOrThrow({
          where: { id: attempt.assistantMessageId }
        })
      ]);
      expect(purgedVersion).toMatchObject({
        contentPurgedAt: expect.any(Date),
        displayText: null,
        normalizedSearchText: null,
        structuredValue: null
      });
      expect(purgedAttempt).toMatchObject({
        errorCode: "memory_item_forgotten",
        preparedContextHash: null,
        preparedContextText: null,
        preparedContextTokenCount: null,
        state: "STALE"
      });
      expect(settledRun).toMatchObject({
        errorPayload: { code: "memory_item_forgotten" },
        status: "error"
      });
      expect(settledMessage).toMatchObject({
        errorMessage:
          "Memory preparation stopped because a selected Memory item was forgotten.",
        status: "error"
      });
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: attempt.attemptId, userId: ownerUserId }
      })).resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: candidateId }
      })).resolves.toMatchObject({
        contentPurgedAt: expect.any(Date),
        proposedCanonicalKey: null,
        proposedDisplayText: null,
        proposedValue: null,
        reasonCode: "forgotten_or_suppressed",
        state: "STALE"
      });
      await expect(prisma.memoryCandidateMessage.count({
        where: { candidateId, userId: ownerUserId }
      })).resolves.toBe(0);
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: feedback.feedbackId }
      })).resolves.toMatchObject({
        comment: null,
        contentPurgedAt: expect.any(Date),
        memoryEventId: null,
        memoryFactId: null,
        memoryFactVersionId: null,
        purgeReason: "fact_forgotten"
      });

      const delayedCandidateId = await createFactCandidateFixture({
        activeLeafMessageId: attempt.assistantMessageId,
        canonicalKey: canonicalKey.canonicalKey,
        chatId: attempt.chatId,
        displayText: statement,
        messageId: attempt.messageId,
        userId: ownerUserId
      });
      const delayedFeedbackId = randomUUID();
      const delayedFeedbackRequestId = randomUUID();
      const delayedFeedbackEventId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.memoryEvent.create({
          data: {
            actorType: "USER",
            actorUserId: ownerUserId,
            factId,
            factVersionId: versionId,
            id: delayedFeedbackEventId,
            metadata: {
              feedbackId: delayedFeedbackId,
              feedbackType: "INCORRECT",
              schemaVersion: "memory-feedback-event-v1"
            },
            operation: "USER_FEEDBACK",
            userId: ownerUserId
          }
        });
        await tx.memoryFeedback.create({
          data: {
            comment: "Late feedback attached after the old obligation completed.",
            feedbackType: "INCORRECT",
            id: delayedFeedbackId,
            idempotencyFingerprint: memoryFeedbackIdempotencyFingerprint(
              ownerUserId,
              delayedFeedbackRequestId
            ),
            memoryEventId: delayedFeedbackEventId,
            memoryFactId: factId,
            memoryFactVersionId: versionId,
            requestId: delayedFeedbackRequestId,
            targetKind: "FACT_VERSION",
            userId: ownerUserId
          }
        });
      });
      const replayed = await auditMemoryDeletion(
        registry,
        deletion.id,
        ownerUserId,
        prisma,
        new Date("2026-08-10T12:00:02.000Z")
      );
      expect(replayed).toMatchObject({
        progress: { completedUnits: 8, complete: false, totalUnits: 10 },
        state: "PENDING"
      });
      await commitDeletion(
        registry,
        ownerUserId,
        deletion.id,
        new Date("2026-08-10T12:00:03.000Z")
      );
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: delayedCandidateId }
      })).resolves.toMatchObject({
        contentPurgedAt: expect.any(Date),
        proposedDisplayText: null,
        state: "STALE"
      });
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: delayedFeedbackId }
      })).resolves.toMatchObject({
        comment: null,
        contentPurgedAt: expect.any(Date),
        memoryFactId: null,
        memoryFactVersionId: null,
        purgeReason: "fact_forgotten"
      });

      const scope = await createPrismaMemoryScopeRepository(prisma)
        .ensureGlobal(ownerUserId);
      await expect(createPrismaMemoryFactRepository(keyring, prisma).save(ownerUserId, {
        evidence: {
          branchGeneration: 0,
          chatId: attempt.chatId,
          kind: "MESSAGE",
          messageId: attempt.messageId,
          observedAt: new Date("2026-08-10T12:01:00.000Z"),
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-lifecycle-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: `automatic-rebuild-${randomUUID()}`,
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue("learned.rebuild", statement)
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });

      const revived = await saveExplicit(
        explicit,
        ownerUserId,
        statement,
        "forget-revive"
      );
      expect(revived.memory).toMatchObject({
        factState: "ACTIVE",
        id: factId,
        sourceMode: "EXPLICIT"
      });
      expect(revived.memory.currentVersionId).not.toBe(versionId);

      const upgraded = upgradedRegistry();
      const reopened = await auditMemoryDeletion(
        upgraded,
        deletion.id,
        ownerUserId,
        prisma,
        new Date("2026-08-10T12:02:00.000Z")
      );
      expect(reopened).toMatchObject({
        progress: { completedUnits: 10, complete: false, totalUnits: 11 },
        state: "PENDING"
      });
      await commitDeletion(
        upgraded,
        ownerUserId,
        deletion.id,
        new Date("2026-08-10T12:03:00.000Z")
      );
      const upgradedStatus = await auditMemoryDeletion(
        upgraded,
        deletion.id,
        ownerUserId,
        prisma,
        new Date("2026-08-10T12:04:00.000Z")
      );
      expect(upgradedStatus).toMatchObject({
        progress: { completedUnits: 11, complete: true, totalUnits: 11 },
        state: "SUCCEEDED"
      });
      await expect(explicit.get(ownerUserId, factId)).resolves.toMatchObject({
        memory: {
          currentVersionId: revived.memory.currentVersionId,
          displayText: statement,
          factState: "ACTIVE"
        }
      });
    } finally {
      await cleanupUsers([ownerUserId, foreignUserId]);
    }
  });

  it("keeps the fence active during the bounded window and atomically cancels purge on Undo", async () => {
    const registry = purgeRegistry();
    const userId = await createActiveUser("forget-undo");
    const now = new Date();
    const { explicit, lifecycle } = services(registry, () => now);
    const statement = "I prefer aisle seats on daytime flights.";
    try {
      const created = await saveExplicit(explicit, userId, statement, "undo-save");
      const factId = created.memory.id;
      const versionId = created.memory.currentVersionId!;
      const authorization = await explicit.mintAuthorization(userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId,
        requestNonce: "undo-forget",
        targetFactId: factId
      });

      const forgotten = await lifecycle.forget(userId, factId, {
        expectedVersionId: versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      });
      const expiresAt = new Date(forgotten.undo.expiresAt);
      expect(expiresAt.getTime() - now.getTime()).toBe(60_000);
      await expect(explicit.search(userId, {
        pageSize: 20,
        query: statement,
        scope: { type: "GLOBAL_USER" },
        state: "ACTIVE"
      })).resolves.toMatchObject({ memories: [] });
      await expect(createPrismaMemoryCoordinatorRepository(prisma).claimDeletion({
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(expiresAt.getTime() + 60_000),
        now: new Date(expiresAt.getTime() - 1),
        operations: ["FORGET_PURGE"]
      })).resolves.toBeNull();

      const undoAuthorization = await explicit.mintAuthorization(userId, {
        action: "SAVE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactStatementHash: memorySha256(statement),
        requestNonce: "undo-restore"
      });
      const restored = await explicit.undoForget(userId, factId, {
        deletionId: forgotten.undo.deletionId,
        mutationAuthorizationId: undoAuthorization.mutationAuthorizationId
      });
      expect(restored.memory).toMatchObject({
        displayText: statement,
        factState: "ACTIVE",
        id: factId,
        sourceMode: "EXPLICIT"
      });
      expect(restored.memory.currentVersionId).not.toBe(versionId);
      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({
        where: { id: forgotten.undo.deletionId }
      })).resolves.toMatchObject({
        completedAt: expect.any(Date),
        errorCode: "memory_purge_cancelled_by_undo",
        nextAttemptAt: null,
        state: "CANCELLED"
      });
      await expect(createPrismaMemoryCoordinatorRepository(prisma).claimDeletion({
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(expiresAt.getTime() + 120_000),
        now: new Date(expiresAt.getTime() + 60_000),
        operations: ["FORGET_PURGE"]
      })).resolves.toBeNull();
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: null,
        displayText: statement,
        state: "FORGOTTEN"
      });
    } finally {
      await cleanupUsers([userId]);
    }
  });

  it("routes conflict Forget through the common fence and purges every claim", async () => {
    const registry = purgeRegistry();
    const userId = await createActiveUser("conflict-forget");
    const { explicit, lifecycle } = services(registry);
    try {
      const created = await saveExplicit(
        explicit,
        userId,
        "I prefer concise technical explanations.",
        "conflict-forget-save"
      );
      const factId = created.memory.id;
      const versionIds = [...await makeConflictedFact(
        userId,
        factId,
        created.memory.currentVersionId!
      )].sort();
      const feedback = await createMemoryReviewService(
        createPrismaMemoryFeedbackRepository(prisma)
      ).feedback(userId, factId, {
        comment: "Forget the unresolved conflict and this note.",
        expectedVersionId: versionIds[1]!,
        feedbackType: "INCORRECT",
        requestId: randomUUID()
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionIds[0]!,
        requestNonce: "conflict-forget-authorize",
        targetFactId: factId
      });

      const forgotten = await lifecycle.forget(userId, factId, {
        expectedVersionId: versionIds[0]!,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      });
      expect(forgotten.memory).toMatchObject({
        currentVersionId: null,
        displayText: null,
        factState: "FORGOTTEN",
        id: factId
      });
      await expect(prisma.memoryFactVersion.findMany({
        select: { id: true, state: true },
        where: { factId, userId }
      })).resolves.toEqual(expect.arrayContaining(versionIds.map((id) => ({
        id,
        state: "FORGOTTEN"
      }))));

      const deletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "FORGET_PURGE", targetId: factId, userId }
      });
      await commitDeletion(
        registry,
        userId,
        deletion.id,
        new Date(Date.now() + 1_000)
      );
      const purgedVersions = await prisma.memoryFactVersion.findMany({
        where: { factId, userId }
      });
      expect(purgedVersions).toHaveLength(2);
      expect(purgedVersions.every((version) =>
        version.contentPurgedAt !== null && version.displayText === null)).toBe(true);
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: feedback.feedbackId }
      })).resolves.toMatchObject({
        comment: null,
        contentPurgedAt: expect.any(Date),
        memoryFactId: null,
        memoryFactVersionId: null,
        purgeReason: "fact_forgotten"
      });
    } finally {
      await cleanupUsers([userId]);
    }
  });

  it("suppresses the exact retained source of a forgotten automatic fact", async () => {
    const registry = purgeRegistry();
    const userId = await createActiveUser("automatic-source");
    const { explicit, lifecycle } = services(registry);
    const statement = "I prefer overnight trains for long trips.";
    try {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Retained automatic source",
          userId
        }
      });
      const request = normalizedRequest(chat.id, statement);
      const admitted = await createPrismaRunRepository(prisma).admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const facts = createPrismaMemoryFactRepository(keyring, prisma);
      const created = await facts.save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: chat.id,
          kind: "MESSAGE",
          messageId: admitted.userMessageId,
          observedAt: new Date("2026-08-10T14:00:00.000Z"),
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-lifecycle-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: `automatic-source-${randomUUID()}`,
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue("learned.travel.mode", statement)
      });
      await classifyFactVersion(userId, created.versionId);
      const receipt = await createAcceptedReceiptDerivatives({
        assistantMessageId: admitted.assistantMessageId,
        attemptId: admitted.attemptId,
        chatId: chat.id,
        factVersionId: created.versionId,
        modelRunId: admitted.runId,
        sourceMessageId: admitted.userMessageId,
        statement,
        userId
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: created.versionId,
        requestNonce: "automatic-source-forget",
        targetFactId: created.factId
      });
      await expect(lifecycle.forget(userId, created.factId, {
        expectedVersionId: created.versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      })).resolves.toMatchObject({
        memory: { displayText: null, factState: "FORGOTTEN" }
      });
      await expect(lifecycle.forget(userId, created.factId, {
        expectedVersionId: created.versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      })).resolves.toMatchObject({
        memory: { displayText: null, factState: "FORGOTTEN" }
      });

      const suppressions = await prisma.memorySuppression.findMany({
        orderBy: { scope: "asc" },
        where: { userId }
      });
      expect(suppressions).toHaveLength(3);
      expect(suppressions).toContainEqual(expect.objectContaining({
        explicitOverrideAllowed: true,
        scope: "SOURCE_MESSAGE",
        sourceBranchGeneration: 0,
        sourceChatId: chat.id,
        sourceMessageId: admitted.userMessageId
      }));
      await expect(facts.save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: chat.id,
          kind: "MESSAGE",
          messageId: admitted.userMessageId,
          observedAt: new Date("2026-08-10T14:01:00.000Z"),
          safeExcerpt: "For long journeys, sleeper rail is my first choice.",
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-lifecycle-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: `automatic-source-rebuild-${randomUUID()}`,
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue(
          "learned.travel.mode.paraphrase",
          "For long journeys, sleeper rail is my first choice."
        )
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });

      const deletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "FORGET_PURGE", userId }
      });
      await commitDeletion(
        registry,
        userId,
        deletion.id,
        new Date("2026-08-10T14:02:00.000Z")
      );
      await expectAcceptedReceiptDerivatives(receipt, "SCRUBBED");
      for (const auditedAt of [
        new Date("2026-08-10T14:03:00.000Z"),
        new Date("2026-08-10T14:04:00.000Z")
      ]) {
        await expect(auditMemoryDeletion(
          registry,
          deletion.id,
          userId,
          prisma,
          auditedAt
        )).resolves.toMatchObject({
          progress: { complete: true },
          state: "SUCCEEDED"
        });
        await expectAcceptedReceiptDerivatives(receipt, "SCRUBBED");
      }
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: created.versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: expect.any(Date),
        displayText: null,
        structuredValue: null
      });
      const retainedSource = await prisma.message.findUniqueOrThrow({
        where: { id: admitted.userMessageId }
      });
      expect(retainedSource.chatId).toBe(chat.id);
      expect(JSON.stringify(retainedSource.content)).toContain(statement);
    } finally {
      await cleanupUsers([userId]);
    }
  });

  it("fences, purges, and prevents resurrection of the admitted learned set", async () => {
    const registry = purgeRegistry();
    const userId = await createActiveUser("delete-learned");
    const cutoff = new Date(Date.now() + 1_000);
    const { explicit, lifecycle } = services(registry, () => cutoff);
    const facts = createPrismaMemoryFactRepository(keyring, prisma);
    const statement = "I prefer window seats on daytime trains.";
    try {
      const retainedExplicit = await saveExplicit(
        explicit,
        userId,
        "My saved home airport is SVO.",
        "delete-learned-explicit"
      );
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Retained learned-delete source",
          userId
        }
      });
      const oldMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent(statement),
          createdAt: new Date(cutoff.getTime() - 60_000),
          role: "user",
          status: "complete"
        }
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const learned = await facts.save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: chat.id,
          kind: "MESSAGE",
          messageId: oldMessage.id,
          observedAt: oldMessage.createdAt,
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-delete-learned-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: memorySha256({ operation: "learned-before-delete" }),
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue("learned.travel.seat", statement)
      });
      await classifyFactVersion(userId, learned.versionId);
      const review = createMemoryReviewService(
        createPrismaMemoryFeedbackRepository(prisma)
      );
      const feedback = await review.feedback(userId, learned.factId, {
        comment: "Remove this learned note with its fact.",
        expectedVersionId: learned.versionId,
        feedbackType: "NOT_USEFUL",
        requestId: randomUUID()
      });
      const candidateId = await createFactCandidateFixture({
        activeLeafMessageId: oldMessage.id,
        canonicalKey: "learned.travel.seat.pending",
        chatId: chat.id,
        displayText: "I may prefer aisle seats on overnight trains.",
        messageId: oldMessage.id,
        userId
      });
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const delayedJob = await prisma.memoryJob.create({
        data: {
          activeLeafMessageId: oldMessage.id,
          branchGeneration: 0,
          chatId: chat.id,
          idempotencyFingerprint: memorySha256({ operation: "delayed-extraction" }),
          kind: "EXTRACT_FACTS",
          memoryGenerationSnapshot: before.memoryGeneration,
          memoryRevisionSnapshot: before.memoryRevision,
          pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
          sourceHash: memorySha256({ chatId: chat.id, messageId: oldMessage.id }),
          sourceMessageId: oldMessage.id,
          sourceRevision: 0,
          state: "QUEUED",
          userId
        }
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "DELETE_LEARNED",
        requestNonce: "delete-learned-current"
      });
      const input = {
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        operation: "DELETE_LEARNED"
      } as const;
      const status = await lifecycle.deleteExplicit(userId, input);
      expect(status).toMatchObject({
        memoryGeneration: before.memoryGeneration + 1,
        memoryRevision: before.memoryRevision + 1,
        operation: "DELETE_LEARNED",
        state: "PENDING"
      });
      await expect(lifecycle.deleteExplicit(userId, input)).resolves.toMatchObject({
        deletionId: status.deletionId,
        operation: "DELETE_LEARNED"
      });
      await expect(prisma.memoryDeletionOutbox.count({
        where: {
          targetType: { startsWith: "AUTOMATIC_SET@" },
          userId
        }
      })).resolves.toBe(1);
      const barrier = await prisma.memorySourceBarrier.findFirstOrThrow({
        where: { kind: "AUTOMATIC_FACTS", userId }
      });
      expect(barrier.sourceCreatedAtCutoff).toEqual(cutoff);
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: learned.factId } }))
        .resolves.toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: learned.versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: null,
        displayText: statement,
        state: "FORGOTTEN"
      });
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: learned.versionId, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: delayedJob.id } }))
        .resolves.toMatchObject({ errorCode: "memory_learned_deleted", state: "CANCELLED" });
      await expect(explicit.get(userId, retainedExplicit.memory.id)).resolves.toMatchObject({
        memory: {
          currentVersionId: retainedExplicit.memory.currentVersionId,
          displayText: "My saved home airport is SVO.",
          factState: "ACTIVE",
          sourceMode: "EXPLICIT"
        }
      });

      await expect(facts.save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: chat.id,
          kind: "MESSAGE",
          messageId: oldMessage.id,
          observedAt: new Date(cutoff.getTime() + 1_000),
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-delete-learned-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: memorySha256({ operation: "old-source-replay" }),
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue("learned.travel.old-replay", statement)
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });

      const futureStatement = "I now prefer aisle seats on daytime trains.";
      const futureMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent(futureStatement),
          createdAt: new Date(cutoff.getTime() + 1_000),
          parentMessageId: oldMessage.id,
          role: "user",
          status: "complete"
        }
      });
      const futureLearned = await facts.save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: chat.id,
          kind: "MESSAGE",
          messageId: futureMessage.id,
          observedAt: futureMessage.createdAt,
          safeExcerpt: futureStatement,
          safeSourceHash: memorySha256(futureStatement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-delete-learned-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: memorySha256({ operation: "new-source-after-delete" }),
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue("learned.travel.seat", futureStatement)
      });
      await classifyFactVersion(userId, futureLearned.versionId);
      expect(futureLearned.factId).toBe(learned.factId);
      expect(futureLearned.versionId).not.toBe(learned.versionId);

      await commitDeletion(
        registry,
        userId,
        status.deletionId,
        new Date(cutoff.getTime() + 2_000)
      );
      await expect(lifecycle.status(userId, status.deletionId)).resolves.toMatchObject({
        completedUnits: 10,
        operation: "DELETE_LEARNED",
        state: "SUCCEEDED",
        totalUnits: 10
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: learned.versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: expect.any(Date),
        displayText: null,
        structuredValue: null
      });
      await expect(prisma.memoryEvent.findUniqueOrThrow({
        where: { id: learned.eventId }
      })).resolves.toMatchObject({
        metadata: { schemaVersion: "memory-event-purged-v1" },
        sourceChatId: null,
        sourceGeneration: null
      });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: candidateId }
      })).resolves.toMatchObject({
        contentPurgedAt: expect.any(Date),
        proposedDisplayText: null,
        reasonCode: "learned_delete",
        state: "STALE"
      });
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: feedback.feedbackId }
      })).resolves.toMatchObject({
        comment: null,
        contentPurgedAt: expect.any(Date),
        memoryFactId: null,
        memoryFactVersionId: null,
        purgeReason: "learned_delete"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: futureLearned.versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: null,
        displayText: futureStatement,
        state: "ACTIVE"
      });
      await expect(prisma.message.findUniqueOrThrow({ where: { id: oldMessage.id } }))
        .resolves.toMatchObject({ content: textMessageContent(statement) });
    } finally {
      await cleanupUsers([userId]);
    }
  });

  it("binds DELETE_EXPLICIT to exact counters and preserves post-admission data", async () => {
    const registry = purgeRegistry();
    const userId = await createActiveUser("bulk");
    const { explicit, lifecycle } = services(registry);
    try {
      const retainedStatement = "My preferred editor is Helix.";
      const retainedFact = await saveExplicit(
        explicit,
        userId,
        retainedStatement,
        "bulk-a"
      );
      const review = createMemoryReviewService(
        createPrismaMemoryFeedbackRepository(prisma)
      );
      const retainedFeedback = await review.feedback(
        userId,
        retainedFact.memory.id,
        {
          comment: "Delete this private note with the admitted explicit set.",
          expectedVersionId: retainedFact.memory.currentVersionId!,
          feedbackType: "NOT_USEFUL",
          requestId: randomUUID()
        }
      );
      await saveExplicit(explicit, userId, "I prefer compact answers.", "bulk-b");
      const staleSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const staleAuthorization = await explicit.mintAuthorization(userId, {
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedMemoryRevision: staleSettings.memoryRevision,
        expectedSettingsRevision: staleSettings.settingsRevision,
        operation: "DELETE_EXPLICIT",
        requestNonce: "bulk-stale"
      });
      await saveExplicit(explicit, userId, "My timezone is Europe/Moscow.", "bulk-c");
      const acceptedAttempt = await createUnacceptedAttemptItem({
        factVersionId: retainedFact.memory.currentVersionId!,
        requestContent: retainedStatement,
        statement: retainedStatement,
        userId
      });
      const retainedCanonicalKey = await prisma.memoryFact.findUniqueOrThrow({
        select: { canonicalKey: true },
        where: { id: retainedFact.memory.id }
      });
      const candidateId = await createFactCandidateFixture({
        activeLeafMessageId: acceptedAttempt.assistantMessageId,
        canonicalKey: retainedCanonicalKey.canonicalKey,
        chatId: acceptedAttempt.chatId,
        displayText: retainedStatement,
        messageId: acceptedAttempt.messageId,
        userId
      });
      const receipt = await createAcceptedReceiptDerivatives({
        assistantMessageId: acceptedAttempt.assistantMessageId,
        attemptId: acceptedAttempt.attemptId,
        chatId: acceptedAttempt.chatId,
        factVersionId: retainedFact.memory.currentVersionId!,
        modelRunId: acceptedAttempt.runId,
        sourceMessageId: acceptedAttempt.messageId,
        statement: retainedStatement,
        userId
      });
      await expect(lifecycle.deleteExplicit(userId, {
        expectedMemoryRevision: staleSettings.memoryRevision,
        expectedSettingsRevision: staleSettings.settingsRevision,
        mutationAuthorizationId: staleAuthorization.mutationAuthorizationId,
        operation: "DELETE_EXPLICIT"
      })).rejects.toEqual(new MemoryLifecycleServiceError("memory_version_stale"));
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: staleAuthorization.mutationAuthorizationId }
      })).resolves.toMatchObject({ consumedAt: null });

      const current = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedMemoryRevision: current.memoryRevision,
        expectedSettingsRevision: current.settingsRevision,
        operation: "DELETE_EXPLICIT",
        requestNonce: "bulk-current"
      });
      const deleteInput = {
        expectedMemoryRevision: current.memoryRevision,
        expectedSettingsRevision: current.settingsRevision,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        operation: "DELETE_EXPLICIT"
      } as const;
      const status = await lifecycle.deleteExplicit(userId, deleteInput);
      expect(status).toMatchObject({
        lastAuditAt: expect.any(String),
        memoryGeneration: current.memoryGeneration + 1,
        memoryRevision: current.memoryRevision + 1,
        operation: "DELETE_EXPLICIT",
        settingsRevision: current.settingsRevision,
        state: "PENDING"
      });
      await expect(prisma.memoryFact.count({
        where: { state: "FORGOTTEN", userId }
      })).resolves.toBe(3);
      await expect(prisma.memorySearchEntry.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId } }))
        .resolves.toBe(1);
      const postAdmission = await saveExplicit(
        explicit,
        userId,
        "I added this explicit memory after bulk admission.",
        "bulk-after-admission"
      );
      const postAdmissionFeedback = await review.feedback(
        userId,
        postAdmission.memory.id,
        {
          comment: "This post-admission feedback must remain.",
          expectedVersionId: postAdmission.memory.currentVersionId!,
          feedbackType: "NOT_USEFUL",
          requestId: randomUUID()
        }
      );
      await expect(lifecycle.status(userId, status.deletionId)).resolves.toMatchObject({
        memoryGeneration: status.memoryGeneration,
        memoryRevision: status.memoryRevision,
        settingsRevision: status.settingsRevision,
        state: "PENDING"
      });
      await expect(lifecycle.deleteExplicit(userId, deleteInput)).resolves.toMatchObject({
        deletionId: status.deletionId,
        memoryGeneration: status.memoryGeneration,
        memoryRevision: status.memoryRevision,
        settingsRevision: status.settingsRevision,
        state: "PENDING"
      });
      await commitDeletion(
        registry,
        userId,
        status.deletionId,
        new Date("2026-08-10T13:00:00.000Z")
      );
      await expect(lifecycle.status(userId, status.deletionId)).resolves.toMatchObject({
        completedUnits: 10,
        memoryRevision: status.memoryRevision,
        state: "SUCCEEDED",
        totalUnits: 10
      });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: candidateId }
      })).resolves.toMatchObject({
        contentPurgedAt: expect.any(Date),
        proposedDisplayText: null,
        state: "STALE"
      });
      await expect(prisma.memoryCandidateMessage.count({
        where: { candidateId, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: retainedFeedback.feedbackId }
      })).resolves.toMatchObject({
        comment: null,
        contentPurgedAt: expect.any(Date),
        memoryFactId: null,
        memoryFactVersionId: null,
        purgeReason: "explicit_delete"
      });
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: postAdmissionFeedback.feedbackId }
      })).resolves.toMatchObject({
        comment: "This post-admission feedback must remain.",
        contentPurgedAt: null,
        memoryFactId: postAdmission.memory.id,
        memoryFactVersionId: postAdmission.memory.currentVersionId
      });
      await expectAcceptedReceiptDerivatives(receipt, "RETAINED");
      await expect(auditMemoryDeletion(
        registry,
        status.deletionId,
        userId,
        prisma,
        new Date("2026-08-10T13:01:00.000Z")
      )).resolves.toMatchObject({
        progress: { complete: true },
        state: "SUCCEEDED"
      });
      await expectAcceptedReceiptDerivatives(receipt, "RETAINED");
      await expect(explicit.get(userId, postAdmission.memory.id)).resolves.toMatchObject({
        memory: {
          currentVersionId: postAdmission.memory.currentVersionId,
          displayText: "I added this explicit memory after bulk admission.",
          factState: "ACTIVE"
        }
      });
    } finally {
      await cleanupUsers([userId]);
    }
  });

  it("fences and purges all reusable owners without rewriting retained chats or accepted runs", async () => {
    const registry = purgeRegistry();
    const userId = await createActiveUser("all-reusable-owner");
    const foreignUserId = await createActiveUser("all-reusable-foreign");
    let serviceNow = new Date();
    const cutoff = new Date(serviceNow.getTime() + 60_000);
    const { explicit, lifecycle } = services(registry, () => serviceNow);
    const statement = "I prefer short Russian summaries for infrastructure incidents.";
    try {
      const saved = await saveExplicit(
        explicit,
        userId,
        statement,
        "all-reusable-save"
      );
      const foreign = await saveExplicit(
        explicit,
        foreignUserId,
        "Foreign memory must remain isolated.",
        "all-reusable-foreign-save"
      );
      const factId = saved.memory.id;
      const versionId = saved.memory.currentVersionId!;
      const feedback = await createMemoryReviewService(
        createPrismaMemoryFeedbackRepository(prisma)
      ).feedback(userId, factId, {
        comment: "This populated feedback must lose every private target and comment.",
        expectedVersionId: versionId,
        feedbackType: "NOT_USEFUL",
        requestId: randomUUID()
      });
      const acceptedAttempt = await createUnacceptedAttemptItem({
        factVersionId: versionId,
        requestContent: statement,
        statement,
        userId
      });
      const acceptedReceipt = await createAcceptedReceiptDerivatives({
        assistantMessageId: acceptedAttempt.assistantMessageId,
        attemptId: acceptedAttempt.attemptId,
        chatId: acceptedAttempt.chatId,
        factVersionId: versionId,
        modelRunId: acceptedAttempt.runId,
        sourceMessageId: acceptedAttempt.messageId,
        statement,
        userId
      });
      const unacceptedAttempt = await createUnacceptedAttemptItem({
        factVersionId: versionId,
        requestContent: statement,
        statement,
        userId
      });
      const fact = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factId }
      });
      const candidateId = await createFactCandidateFixture({
        activeLeafMessageId: unacceptedAttempt.assistantMessageId,
        canonicalKey: fact.canonicalKey,
        chatId: unacceptedAttempt.chatId,
        displayText: statement,
        messageId: unacceptedAttempt.messageId,
        userId
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const activeGeneration = await prisma.memoryIndexGeneration.findFirstOrThrow({
        where: { id: settings.activeIndexGenerationId!, userId }
      });
      const sourceMessage = await prisma.message.findUniqueOrThrow({
        where: { id: unacceptedAttempt.messageId }
      });
      const sourceChat = await prisma.chat.findUniqueOrThrow({
        where: { id: unacceptedAttempt.chatId }
      });
      const fixtureAt = new Date();
      const chunkId = randomUUID();
      const shadowGenerationId = randomUUID();
      const sourceHash = memorySha256({
        chatId: sourceChat.id,
        messageId: sourceMessage.id,
        statement
      });
      await prisma.$transaction(async (tx) => {
        await tx.memoryRecallChunk.create({
          data: {
            branchGeneration: sourceChat.memoryBranchGeneration,
            chatId: sourceChat.id,
            chunkOrdinal: 0,
            chunkingVersion: "memory-all-reusable-chunk-v1",
            contentHash: sourceHash,
            id: chunkId,
            languageCode: "en",
            normalizedSafeSearchText: normalizeMemorySearchText(statement),
            occurredFrom: sourceMessage.createdAt,
            occurredTo: sourceMessage.createdAt,
            redactionReasonCodes: [],
            redactionState: "NOT_NEEDED",
            safeProjectedText: statement,
            safetyClass: "NORMAL",
            sourceProjectionVersion: "memory-all-reusable-source-v1",
            sourceRevisionAtCreation: sourceChat.memorySourceRevision,
            state: "ACTIVE",
            userId
          }
        });
        await tx.memoryRecallChunkMessage.create({
          data: {
            chatId: sourceChat.id,
            chunkId,
            endOffset: statement.length,
            messageId: sourceMessage.id,
            ordinal: 0,
            role: "user",
            safeTextHash: memorySha256(statement),
            sourceMessageContentHash: memorySha256(statement),
            sourceMessageUpdatedAt: sourceMessage.updatedAt,
            startOffset: 0,
            userId
          }
        });
        await tx.memorySearchEntry.createMany({
          data: [
            {
              embeddingState: "NOT_APPLICABLE",
              id: randomUUID(),
              indexGenerationId: activeGeneration.id,
              itemType: "RECALL_CHUNK",
              languageCode: "en",
              recallChunkId: chunkId,
              safeContentHash: memorySha256({ chunkId, statement }),
              normalizedSearchText: normalizeMemorySearchText(statement),
              safetyIdentitySnapshot: memorySha256({ chunkId, safety: true }),
              sourceIdentitySnapshot: memorySha256({ chunkId, source: true }),
              suppressionIdentitySnapshot: memorySha256({ chunkId, suppression: true }),
              userId
            }
          ]
        });
        await tx.memoryRetrievalAttemptItem.create({
          data: {
            attemptId: unacceptedAttempt.attemptId,
            exactItemId: chunkId,
            exactSafeText: statement,
            featureSnapshot: {},
            itemType: "RECALL_CHUNK",
            laneRanks: {},
            ordinal: 1,
            recallChunkId: chunkId,
            selectionReason: "memory-all-reusable-history-fixture",
            sourceBranchGenerationSnapshot: sourceChat.memoryBranchGeneration,
            sourceChatIdSnapshot: sourceChat.id,
            sourceContentHashSnapshot: sourceHash,
            sourceRevisionSnapshot: sourceChat.memorySourceRevision,
            sourceSnapshot: {},
            textHash: memorySha256(statement),
            userId,
            versionSnapshot: {}
          }
        });
        await tx.chatMemoryCheckpoint.create({
          data: {
            activeLeafMessageId: unacceptedAttempt.assistantMessageId,
            branchGeneration: sourceChat.memoryBranchGeneration,
            chatId: sourceChat.id,
            lastIndexedMessageId: sourceMessage.id,
            lastSucceededAt: fixtureAt,
            sourceContentHash: sourceHash,
            sourceRevision: sourceChat.memorySourceRevision,
            status: "READY",
            userId
          }
        });
        await tx.memorySuppression.create({
          data: {
            deletionGeneration: settings.memoryGeneration,
            explicitOverrideAllowed: false,
            fingerprintKeyVersion: "lifecycle-v1",
            normalizationVersion: "memory-normalization-v1",
            scope: "ALL",
            userId
          }
        });
        await tx.memoryIndexGeneration.create({
          data: {
            chunkingVersion: activeGeneration.chunkingVersion,
            createdAt: fixtureAt,
            generation: activeGeneration.generation + 1,
            id: shadowGenerationId,
            indexMode: "LEXICAL_ONLY",
            indexedThroughMemoryRevision: settings.memoryRevision,
            languageProfile: activeGeneration.languageProfile,
            normalizationVersion: activeGeneration.normalizationVersion,
            retrievalPipelineVersion: activeGeneration.retrievalPipelineVersion,
            sourceIndexGenerationId: activeGeneration.id,
            state: "BUILDING",
            targetMemoryRevision: settings.memoryRevision,
            userId
          }
        });
      });

      serviceNow = cutoff;
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "DELETE_ALL_REUSABLE",
        requestNonce: "delete-all-reusable-current"
      });
      const deleteInput = {
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        operation: "DELETE_ALL_REUSABLE"
      } as const;
      const status = await lifecycle.deleteExplicit(userId, deleteInput);
      expect(status).toMatchObject({
        memoryGeneration: before.memoryGeneration + 1,
        memoryRevision: before.memoryRevision + 1,
        operation: "DELETE_ALL_REUSABLE",
        settingsRevision: before.settingsRevision + 1,
        state: "PENDING",
        totalUnits: 10
      });
      await expect(lifecycle.deleteExplicit(userId, deleteInput)).resolves.toMatchObject({
        deletionId: status.deletionId,
        operation: "DELETE_ALL_REUSABLE"
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({
          activeIndexGenerationId: null,
          learnAutomatically: false,
          memoryGeneration: before.memoryGeneration + 1,
          memoryRevision: before.memoryRevision + 1,
          referenceChatHistory: false,
          settingsRevision: before.settingsRevision + 1,
          useMemoryFacts: false
        });
      const barrier = await prisma.memorySourceBarrier.findFirstOrThrow({
        where: { kind: "ALL_REUSABLE", userId }
      });
      expect(barrier.sourceCreatedAtCutoff).toEqual(cutoff);
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
      await expect(prisma.memorySearchEntry.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.chatMemoryCheckpoint.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: activeGeneration.id }
      })).resolves.toMatchObject({ state: "SUPERSEDED" });
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: shadowGenerationId }
      })).resolves.toMatchObject({ state: "CANCELLED" });

      const crashAt = new Date(cutoff.getTime() + 1_000);
      const crashClaim = await claimDeletion(userId, status.deletionId, crashAt);
      const crashExecution = await registry.handler().execute(crashClaim, {
        now: () => crashAt,
        signal: new AbortController().signal
      });
      const crashApply = crashExecution.apply;
      expect(crashApply).toBeDefined();
      if (!crashApply) {
        throw new Error("memory_all_reusable_apply_missing");
      }
      await expect(prisma.$transaction(async (tx) => {
        await crashApply(tx, crashClaim);
        throw new Error("memory_all_reusable_crash_fixture");
      })).rejects.toThrow("memory_all_reusable_crash_fixture");
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ state: "FORGOTTEN" });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({ where: { id: candidateId } }))
        .resolves.toMatchObject({ proposedDisplayText: statement });
      await expect(createPrismaMemoryCoordinatorRepository(prisma).retryDeletion({
        blocked: false,
        claim: crashClaim,
        errorCode: "memory_all_reusable_crash_fixture",
        nextAttemptAt: new Date(cutoff.getTime() + 2_000),
        now: crashAt
      })).resolves.toBe(true);
      await commitDeletion(
        registry,
        userId,
        status.deletionId,
        new Date(cutoff.getTime() + 3_000)
      );

      await expect(lifecycle.status(userId, status.deletionId)).resolves.toMatchObject({
        completedUnits: 10,
        operation: "DELETE_ALL_REUSABLE",
        state: "SUCCEEDED",
        totalUnits: 10
      });
      const zeroCountOwners = await Promise.all([
        prisma.memoryFact.count({ where: { userId } }),
        prisma.memoryFactVersion.count({ where: { userId } }),
        prisma.memoryEvidence.count({ where: { userId } }),
        prisma.memoryCandidate.count({ where: { userId } }),
        prisma.memoryRecallChunk.count({ where: { userId } }),
        prisma.memorySearchEntry.count({ where: { userId } }),
        prisma.memoryJob.count({ where: { userId } }),
        prisma.memorySuppression.count({ where: { userId } }),
        prisma.memoryScope.count({ where: { userId } })
      ]);
      expect(zeroCountOwners).toEqual(Array.from({ length: 9 }, () => 0));
      await expect(prisma.memoryRetrievalAttempt.findUnique({
        where: { id: unacceptedAttempt.attemptId }
      })).resolves.toBeNull();
      await expect(prisma.modelRun.findUniqueOrThrow({
        where: { id: unacceptedAttempt.runId }
      })).resolves.toMatchObject({
        status: "error"
      });
      await expect(prisma.memoryFeedback.findUniqueOrThrow({
        where: { id: feedback.feedbackId }
      })).resolves.toMatchObject({
        comment: null,
        contentPurgedAt: expect.any(Date),
        memoryEventId: null,
        memoryFactId: null,
        memoryFactVersionId: null,
        purgeReason: "all_reusable_delete"
      });
      await expect(prisma.memoryMutationAuthorization.count({
        where: { action: { not: "BULK_DELETE" }, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryOperationReceipt.findMany({
        where: { userId }
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ targetFactId: null, targetVersionId: null })
      ]));

      await expect(prisma.memoryRetrievalAttempt.findUniqueOrThrow({
        where: { id: acceptedReceipt.attemptId }
      })).resolves.toMatchObject({ outcome: "USED", state: "CONSUMED" });
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: acceptedReceipt.attemptId, userId }
      })).resolves.toBe(0);
      await expect(prisma.modelRunMemoryBinding.findUniqueOrThrow({
        where: { id: acceptedReceipt.bindingId }
      })).resolves.toMatchObject({ outcome: "USED" });
      await expect(prisma.modelRunMemoryItem.findUniqueOrThrow({
        where: { id: acceptedReceipt.memoryItemId }
      })).resolves.toMatchObject({
        factVersionId: null,
        includedText: statement
      });
      await expectAcceptedReceiptDerivatives(acceptedReceipt, "SCRUBBED", "PURGED");
      await expect(prisma.message.findUniqueOrThrow({
        where: { id: acceptedAttempt.messageId }
      })).resolves.toMatchObject({ content: textMessageContent(statement) });
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: activeGeneration.id }
      })).resolves.toMatchObject({ state: "SUPERSEDED" });
      await expect(prisma.memoryIndexGeneration.findUnique({
        where: { id: shadowGenerationId }
      })).resolves.toBeNull();
      await expect(explicit.get(foreignUserId, foreign.memory.id)).resolves.toMatchObject({
        memory: {
          currentVersionId: foreign.memory.currentVersionId,
          displayText: "Foreign memory must remain isolated.",
          factState: "ACTIVE"
        }
      });

      const replacementScope = await createPrismaMemoryScopeRepository(prisma)
        .ensureGlobal(userId);
      await expect(createPrismaMemoryFactRepository(keyring, prisma).save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: acceptedAttempt.chatId,
          kind: "MESSAGE",
          messageId: acceptedAttempt.messageId,
          observedAt: new Date(cutoff.getTime() + 4_000),
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-all-reusable-source-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: memorySha256({ operation: "all-reusable-old-source-replay" }),
        requestId: randomUUID(),
        scopeId: replacementScope.id,
        value: automaticValue("learned.all-reusable-replay", statement)
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });
      await expect(auditMemoryDeletion(
        registry,
        status.deletionId,
        userId,
        prisma,
        new Date(cutoff.getTime() + 5_000)
      )).resolves.toMatchObject({
        progress: { complete: true },
        state: "SUCCEEDED"
      });
    } finally {
      await cleanupUsers([userId, foreignUserId]);
    }
  });
});
