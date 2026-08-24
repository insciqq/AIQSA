import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import {
  createPrismaMemoryMutationAuthorizationRepository,
  memoryMutationNonceHash,
  memoryTargetAuthorizationPayloadHash
} from "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { createExplicitMemoryService } from "../explicit/service";
import { createPrismaMemoryFeedbackRepository } from "./feedbackRepository";
import { createMemoryReviewService, MemoryReviewServiceError } from "./service";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 81));
const keyring = MemorySuppressionKeyring.parse(
  `current=review-v1,review-v1=${keyBytes.toString("base64")}`
);

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Review ${label}`,
      email: `review-${label}-${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function classifyFactVersion(
  userId: string,
  versionId: string,
  reasonCode = "other_durable"
): Promise<void> {
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
          job: "review-classification",
          versionId
        }),
        kind: "RECLASSIFY_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: "memory-review-classification-fixture-v1",
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memorySha256({ decision: reasonCode, versionId }),
        completedAt,
        createdAt: startedAt,
        destinationFingerprint: memorySha256({
          destination: "review-classifier",
          versionId
        }),
        id: bindingId,
        inputHash: memorySha256({ input: "review-classifier", versionId }),
        logicalRole: "MEMORY_RECLASSIFY",
        memoryJobId: jobId,
        ordinal: 0,
        ownerType: "JOB",
        pipelineVersion: "memory-review-classification-fixture-v1",
        policyVersion: "memory-review-classification-policy-v1",
        promptVersion: "memory-review-classification-prompt-v1",
        providerId: "memory-review-fixture",
        recoverableUntil: completedAt,
        relationsDetachedAt: completedAt,
        schemaVersion: "memory-review-classification-schema-v1",
        secretFreeExecutionSnapshot: {
          providerExecutionSnapshot: {
            providerFamily: "memory-review-fixture",
            providerModelId: "memory-review-classifier-v1"
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
        safetyClassificationReasonCode: reasonCode,
        safetyClassificationState: "CLASSIFIED",
        safetyClassifiedAt: completedAt,
        safetyClassifierExecutionId: bindingId,
        safetyClassifierModelId: "memory-review-classifier-v1",
        safetyClassifierPolicyVersion: "memory-review-classification-policy-v1",
        safetyClassifierProviderId: "memory-review-fixture"
      },
      where: { id: versionId }
    });
  });
}

function explicitService() {
  return createExplicitMemoryService({
    authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository: createPrismaExplicitMemoryRepository(prisma),
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
  });
}

async function createAutomaticMemory(userId: string, statement: string) {
  const chat = await prisma.chat.create({
    data: { title: "Memory review automatic source", userId }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(statement),
      role: "user",
      status: "complete"
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: message.id },
    where: { id: chat.id }
  });
  const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  const created = await createPrismaMemoryFactRepository(keyring, prisma).save(userId, {
    evidence: {
      branchGeneration: 0,
      chatId: chat.id,
      kind: "MESSAGE",
      messageId: message.id,
      observedAt: new Date(),
      safeExcerpt: statement,
      safeSourceHash: memorySha256(statement),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-review-test-v1",
      sourceRole: "user"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint: memorySha256({
      domain: "memory-review-automatic-fixture",
      nonce: randomUUID()
    }),
    requestId: randomUUID(),
    scopeId: scope.id,
    value: {
      canonicalKey: `review.preference.${memorySha256(statement).slice(0, 32)}`,
      category: "preference",
      confidence: 0.9,
      directness: "DIRECT",
      displayText: statement,
      importance: 0.8,
      languageCode: "en",
      modality: "PREFERENCE",
      pipelineVersion: "memory-review-test-v1",
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "AUTOMATIC",
      structuredValue: { statement }
    }
  });
  await classifyFactVersion(userId, created.versionId, "response_preference");
  return created;
}

async function makeConflict(
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
    const firstEvidence = await tx.memoryEvidence.findFirstOrThrow({
      select: { branchGeneration: true, chatId: true, messageId: true },
      where: {
        factVersionId: firstVersionId,
        sourceType: "MESSAGE",
        userId
      }
    });
    if (
      firstEvidence.branchGeneration === null ||
      !firstEvidence.chatId ||
      !firstEvidence.messageId
    ) {
      throw new Error("memory_review_conflict_source_missing");
    }
    const secondStatement = "I prefer detailed technical explanations.";
    const secondMessage = await tx.message.create({
      data: {
        chatId: firstEvidence.chatId,
        content: textMessageContent(secondStatement),
        parentMessageId: firstEvidence.messageId,
        role: "user",
        status: "complete"
      }
    });
    await tx.chat.update({
      data: { activeLeafMessageId: secondMessage.id },
      where: { id: firstEvidence.chatId }
    });
    await tx.memoryEvent.create({
      data: {
        actorType: "SYSTEM",
        factId,
        factVersionId: secondVersionId,
        id: eventId,
        metadata: { schemaVersion: "memory-review-conflict-test-v1" },
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
        displayText: secondStatement,
        factId,
        id: secondVersionId,
        importance: first.importance,
        languageCode: first.languageCode,
        modality: first.modality,
        normalizedSearchText: "i prefer detailed technical explanations",
        pipelineVersion: "memory-review-conflict-test-v1",
        rawTemporalExpression: first.rawTemporalExpression,
        sensitivityClass: "SENSITIVE",
        sourceMode: "AUTOMATIC",
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
    await tx.memoryEvidence.create({
      data: {
        branchGeneration: firstEvidence.branchGeneration,
        chatId: firstEvidence.chatId,
        factVersionId: secondVersionId,
        messageId: secondMessage.id,
        observedAt: new Date(first.systemFrom.getTime() + 1),
        safeExcerpt: secondStatement,
        safeSourceHash: memorySha256(secondStatement),
        safetyClass: "SENSITIVE",
        sourceProjectionVersion: "memory-review-conflict-test-v1",
        sourceRole: "user",
        sourceType: "MESSAGE",
        stance: "SUPPORTS",
        userId
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
  await classifyFactVersion(userId, secondVersionId, "sensitive_personal");
  return [firstVersionId, secondVersionId];
}

describe("Prisma Memory review feedback", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is owner-scoped, idempotent, append-only, retractable, and cannot change fact truth", async () => {
    const userId = await createActiveUser("owner");
    const foreignUserId = await createActiveUser("foreign");
    const review = createMemoryReviewService(createPrismaMemoryFeedbackRepository(prisma));
    try {
      const created = await createAutomaticMemory(
        userId,
        "I prefer concise technical explanations."
      );
      const factId = created.factId;
      const versionId = created.versionId;
      const source = await prisma.memoryEvidence.findFirstOrThrow({
        select: { chatId: true, messageId: true },
        where: { factVersionId: versionId, userId }
      });
      if (!source.chatId || !source.messageId) {
        throw new Error("memory_review_test_source_missing");
      }
      const run = await prisma.modelRun.create({
        data: {
          chatId: source.chatId,
          modelId: "memory-review-test-model",
          normalizedRequest: {},
          provider: "memory-review-test-provider",
          status: "complete",
          userId,
          userMessageId: source.messageId
        }
      });
      const toolCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { exact_query: "concise technical explanations" },
          modelRunId: run.id,
          ordinal: 0,
          providerCallId: randomUUID(),
          roundIndex: 0,
          toolName: "mark_memory_incorrect"
        }
      });
      await expect(review.feedback(userId, factId, {
        expectedVersionId: versionId,
        feedbackType: "INCORRECT",
        modelRunId: run.id,
        modelRunToolCallId: toolCall.id,
        requestId: randomUUID()
      })).rejects.toEqual(new MemoryReviewServiceError("memory_contract_invalid"));
      const truthBefore = await prisma.memoryFactVersion.findUniqueOrThrow({
        select: { displayText: true, state: true, structuredValue: true },
        where: { id: versionId }
      });
      const input = {
        comment: "This was inferred incorrectly.",
        expectedVersionId: versionId,
        feedbackType: "INCORRECT" as const,
        requestId: randomUUID()
      };

      const first = await review.feedback(userId, factId, input);
      await expect(review.feedback(userId, factId, input)).resolves.toEqual(first);
      await expect(review.feedback(userId, factId, {
        ...input,
        feedbackType: "NOT_USEFUL"
      })).rejects.toEqual(
        new MemoryReviewServiceError("memory_intent_confirmation_required")
      );
      await expect(review.feedback(foreignUserId, factId, {
        ...input,
        requestId: randomUUID()
      })).rejects.toEqual(new MemoryReviewServiceError("memory_not_found"));

      const retraction = await review.feedback(userId, factId, {
        expectedVersionId: versionId,
        feedbackType: "RETRACT",
        requestId: randomUUID(),
        retractsFeedbackId: first.feedbackId
      });
      expect(retraction.retractedFeedbackId).toBe(first.feedbackId);
      await expect(review.feedback(userId, factId, {
        expectedVersionId: versionId,
        feedbackType: "RETRACT",
        requestId: randomUUID(),
        retractsFeedbackId: first.feedbackId
      })).rejects.toEqual(
        new MemoryReviewServiceError("memory_intent_confirmation_required")
      );

      const [truthAfter, factAfter, detail] = await Promise.all([
        prisma.memoryFactVersion.findUniqueOrThrow({
          select: { displayText: true, state: true, structuredValue: true },
          where: { id: versionId }
        }),
        prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }),
        explicitService().get(userId, factId)
      ]);
      expect(truthAfter).toEqual(truthBefore);
      expect(factAfter).toMatchObject({ currentVersionId: versionId, state: "ACTIVE" });
      expect(detail.feedback).toEqual([expect.objectContaining({
        comment: input.comment,
        feedbackType: "INCORRECT",
        id: first.feedbackId,
        retractedAt: retraction.createdAt,
        targetVersionId: versionId
      })]);
      await expect(prisma.memoryFeedback.count({ where: { userId } })).resolves.toBe(2);
      await expect(prisma.memoryEvent.count({
        where: { operation: "USER_FEEDBACK", userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryFeedback.update({
        data: { feedbackType: "CORRECT" },
        where: { id: first.feedbackId }
      })).rejects.toThrow();

      const authorizationRequestId = randomUUID();
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: "EDIT",
        expectedTargetVersionId: versionId,
        targetFactId: factId
      });
      const mutationAuthorization = await createPrismaMemoryMutationAuthorizationRepository(
        prisma
      ).mint(userId, {
        action: "EDIT",
        authorizedPayloadHash,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId,
        expiresAt: new Date(Date.now() + 60_000),
        nonceHash: memoryMutationNonceHash(userId, randomUUID()),
        requestId: authorizationRequestId,
        targetFactId: factId
      });
      await review.feedback(userId, factId, {
        expectedVersionId: versionId,
        feedbackType: "NOT_USEFUL",
        requestId: randomUUID()
      }, {
        authorization: {
          action: "EDIT",
          authorizationId: mutationAuthorization.id,
          authorizedPayloadHash,
          expectedTargetVersionId: versionId,
          requestId: authorizationRequestId,
          targetFactId: factId
        }
      });
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: mutationAuthorization.id }
      })).resolves.toMatchObject({ consumedAt: expect.any(Date) });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ currentVersionId: versionId, state: "ACTIVE" });

      const correctionService = explicitService();
      const correctionAuthorization = await correctionService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId,
        requestNonce: randomUUID(),
        targetFactId: factId
      });
      const corrected = await correctionService.update(userId, factId, {
        expectedVersionId: versionId,
        mutationAuthorizationId: correctionAuthorization.mutationAuthorizationId,
        statement: "I prefer thorough technical explanations."
      });
      expect(corrected.memory).toMatchObject({
        displayText: "I prefer thorough technical explanations.",
        sourceMode: "EXPLICIT"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })).resolves.toMatchObject({ state: "SUPERSEDED", sourceMode: "AUTOMATIC" });
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [userId, foreignUserId] } } });
    }
  });

  it("searches and resolves the exact conflicted snapshot into one explicit version", async () => {
    const userId = await createActiveUser("conflict");
    const memory = explicitService();
    try {
      const created = await createAutomaticMemory(
        userId,
        "I prefer concise technical explanations."
      );
      const factId = created.factId;
      const firstVersionId = created.versionId;
      const conflictIds = [...await makeConflict(userId, factId, firstVersionId)].sort();

      await expect(memory.search(userId, {
        query: "technical explanations",
        state: "CONFLICTED"
      })).resolves.toMatchObject({
        memories: [{ factState: "CONFLICTED", id: factId, sourceMode: "AUTOMATIC" }]
      });
      const detail = await memory.get(userId, factId);
      expect(detail.versions.filter(({ state }) => state === "CONFLICTING"))
        .toHaveLength(2);

      const authorization = await memory.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: conflictIds[0]!,
        requestNonce: randomUUID(),
        targetFactId: factId
      });
      await expect(memory.resolveConflict(userId, factId, {
        expectedVersionIds: conflictIds,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        resolution: {
          kind: "CORRECT",
          statement: "Use a balanced level of technical detail."
        }
      })).resolves.toMatchObject({
        memory: {
          displayText: "Use a balanced level of technical detail.",
          factState: "ACTIVE",
          sourceMode: "EXPLICIT"
        }
      });
      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: { systemFrom: "asc" },
        where: { factId, userId }
      });
      expect(versions.filter(({ state }) => state === "SUPERSEDED")).toHaveLength(2);
      expect(versions.filter(({ state }) => state === "ACTIVE")).toEqual([
        expect.objectContaining({
          displayText: "Use a balanced level of technical detail.",
          sensitivityClass: "NORMAL",
          sourceMode: "EXPLICIT",
          supersedesVersionId: conflictIds[0]
        })
      ]);
      await expect(memory.search(userId, {
        query: "balanced level",
        state: "ACTIVE"
      })).resolves.toMatchObject({ memories: [{ id: factId }] });
      await expect(memory.search(userId, {
        query: "technical explanations",
        state: "CONFLICTED"
      })).resolves.toEqual({ memories: [], nextCursor: null });
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
